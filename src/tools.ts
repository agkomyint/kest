import type OpenAI from "openai";
import { readdir, realpath, stat, mkdir } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname, join } from "node:path";
import { createPatch } from "diff";

export type Approval = { title: string; preview: string };
export type Approve = (
  request: Approval,
  signal: AbortSignal,
) => Promise<boolean>;
const LIMIT = 24_000;
const clip = (s: string, n = LIMIT) =>
  s.length > n ? s.slice(0, n) + "\n[truncated]" : s;
const ignored = new Set([
  ".git",
  "node_modules",
  "dist",
  ".next",
  ".kest",
  "vendor",
]);
const sensitive = (p: string) =>
  /(^|[\\/])(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.kest)([\\/]|$)|\.(?:pem|key|p12|pfx)$/i.test(
    p,
  );
function stringArg(args: Record<string, unknown>, name: string) {
  if (typeof args[name] !== "string")
    throw new Error(`Missing string argument: ${name}`);
  return args[name] as string;
}
const schema = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required = Object.keys(properties),
): OpenAI.ChatCompletionTool => ({
  type: "function",
  function: {
    name,
    description,
    parameters: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  },
});
const str = (description: string) => ({ type: "string", description });
export const toolDefinitions: OpenAI.ChatCompletionTool[] = [
  schema(
    "list_files",
    "List workspace files, ignoring dependency/build folders and credentials. Paths are relative to the workspace.",
    { path: str("Directory, usually .") },
  ),
  schema(
    "read_file",
    "Read a UTF-8 workspace file with line numbers. Read before editing. Use offset for large files.",
    {
      path: str("Relative file path"),
      offset: { type: "integer", description: "1-based starting line" },
      limit: { type: "integer", description: "Number of lines, at most 300" },
    },
    ["path"],
  ),
  schema(
    "search",
    "Search file contents for a literal string. Returns matching paths and line numbers. Case insensitive.",
    { query: str("Literal text to find"), path: str("Directory, usually .") },
  ),
  schema(
    "edit_file",
    "Replace exactly one occurrence of old_string in a file. Requires user approval and shows a diff. Read the file first.",
    {
      path: str("Relative file path"),
      old_string: str("Exact existing text, unique and nonempty"),
      new_string: str("Replacement text"),
    },
  ),
  schema(
    "write_file",
    "Create or replace a UTF-8 file. Existing files must have been read first. Requires user approval and shows a diff.",
    {
      path: str("Relative file path"),
      content: str("Complete new file content"),
    },
  ),
  schema(
    "shell",
    "Run a shell command in the workspace after user approval. Windows uses PowerShell; Unix uses sh. Noninteractive only, timeout 60s. Shell commands are not confined to the workspace.",
    { command: str("Command to execute") },
  ),
];

export class WorkspaceTools {
  readonly root: string;
  private reads = new Map<string, string>();
  constructor(
    root: string,
    private approve: Approve,
  ) {
    this.root = resolve(root);
  }

  private async path(input: string, allowNew = false): Promise<string> {
    if (sensitive(input))
      throw new Error("Credential files and private metadata are excluded.");
    const target = resolve(this.root, input);
    const root = await realpath(this.root);
    // Resolve every existing parent, including symlinks/junctions, before accepting a new path.
    let parent = target;
    let resolved: string;
    for (;;) {
      try {
        resolved = await realpath(parent);
        break;
      } catch (e) {
        if (
          !allowNew ||
          (e as NodeJS.ErrnoException).code !== "ENOENT" ||
          dirname(parent) === parent
        )
          throw e;
        parent = dirname(parent);
      }
    }
    const rel = relative(root, resolved!);
    if (
      rel === ".." ||
      rel.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) ||
      isAbsolute(rel)
    )
      throw new Error("Path is outside the workspace.");
    if (sensitive(relative(root, resolved!)))
      throw new Error("Credential files and private metadata are excluded.");
    return target;
  }

  private async *files(
    directory: string,
    signal: AbortSignal,
  ): AsyncGenerator<string> {
    let visited = 0;
    const queue = [directory];
    while (queue.length && visited++ < 4000) {
      signal.throwIfAborted();
      const dir = queue.shift()!;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (
          ignored.has(entry.name) ||
          sensitive(entry.name) ||
          entry.isSymbolicLink()
        )
          continue;
        const p = join(dir, entry.name);
        if (entry.isDirectory()) queue.push(p);
        else if (entry.isFile()) yield p;
      }
    }
  }

  private async read(path: string) {
    const file = Bun.file(path);
    if (file.size > 1_000_000)
      throw new Error(
        "File exceeds 1 MB. Use a narrower file or shell command.",
      );
    const text = await file.text();
    if (text.includes("\0")) throw new Error("Binary files are not supported.");
    return text;
  }

  async execute(
    name: string,
    raw: string,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    const args = JSON.parse(raw) as Record<string, unknown>;
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw new Error("Tool arguments must be an object.");
    if (name === "shell") return this.shell(stringArg(args, "command"), signal);
    if (
      ![
        "list_files",
        "read_file",
        "search",
        "edit_file",
        "write_file",
      ].includes(name)
    )
      throw new Error(`Unknown tool: ${name}`);
    const file = await this.path(
      stringArg(args, "path"),
      name === "write_file",
    );
    if (name === "list_files" || name === "search") {
      if (!(await stat(file)).isDirectory())
        throw new Error("path must be a directory.");
      const result: string[] = [];
      const query =
        name === "search" ? stringArg(args, "query").toLowerCase() : "";
      if (name === "search" && !query)
        throw new Error("Search query cannot be empty.");
      let examined = 0;
      for await (const path of this.files(file, signal)) {
        if (++examined > 3000) {
          result.push("[file scan limit reached]");
          break;
        }
        const rel = relative(this.root, path);
        if (name === "list_files") result.push(rel);
        else {
          try {
            const text = await this.read(await this.path(rel));
            const lines = text.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (lines[i]!.toLowerCase().includes(query))
                result.push(`${rel}:${i + 1}: ${clip(lines[i]!, 400)}`);
              if (result.length >= 100) break;
            }
          } catch {
            /* Skip unreadable, binary, and large files. */
          }
        }
        if (result.length >= (name === "search" ? 100 : 500)) {
          result.push("[result limit reached]");
          break;
        }
      }
      return clip(result.join("\n") || "No results.");
    }
    if (name === "read_file") {
      const text = await this.read(file);
      this.reads.set(file, text);
      const offset = args.offset ?? 1;
      const limit = args.limit ?? 200;
      if (
        !Number.isInteger(offset) ||
        Number(offset) < 1 ||
        !Number.isInteger(limit) ||
        Number(limit) < 1
      )
        throw new Error("offset and limit must be positive integers.");
      const lines = text.split("\n");
      const start = Number(offset) - 1;
      return (
        clip(
          lines
            .slice(start, start + Math.min(300, Number(limit)))
            .map((line, i) => `${start + i + 1}  ${line}`)
            .join("\n"),
        ) + `\n[${lines.length} lines total]`
      );
    }
    const exists = await Bun.file(file).exists();
    const before = exists ? await this.read(file) : "";
    if (exists && this.reads.get(file) !== before)
      throw new Error(
        "Read the current file before editing; it may have changed.",
      );
    let after: string;
    if (name === "edit_file") {
      if (!exists) throw new Error("File does not exist.");
      const old = stringArg(args, "old_string");
      if (!old || before.split(old).length !== 2)
        throw new Error("old_string must match exactly once.");
      after = before.replace(old, () => stringArg(args, "new_string"));
    } else after = stringArg(args, "content");
    if (after.length > 1_000_000) throw new Error("New content exceeds 1 MB.");
    if (before === after && exists) return "No changes needed.";
    const preview = createPatch(
      relative(this.root, file),
      before,
      after,
      "before",
      "after",
      { context: 3 },
    );
    if (preview.length > 32_000)
      throw new Error(
        "Diff is too large for approval. Make smaller, focused edits.",
      );
    if (
      !(await this.approve(
        {
          title: `${exists ? "Edit" : "Create"} ${relative(this.root, file)}`,
          preview,
        },
        signal,
      ))
    )
      return "Denied by user. Do not retry this action unless the user asks.";
    signal.throwIfAborted();
    await this.path(stringArg(args, "path"), true);
    if (
      exists
        ? !(await Bun.file(file).exists()) || (await this.read(file)) !== before
        : await Bun.file(file).exists()
    )
      throw new Error("File changed while waiting for approval. Read again.");
    await mkdir(dirname(file), { recursive: true });
    await Bun.write(file, after);
    this.reads.set(file, after);
    return `Saved ${relative(this.root, file)}\n${clip(preview, 6000)}`;
  }

  private async shell(command: string, signal: AbortSignal): Promise<string> {
    if (!command.trim()) throw new Error("Command is empty.");
    if (
      !(await this.approve(
        {
          title: "Run shell command",
          preview: `Working directory: ${this.root}\n\n${command}`,
        },
        signal,
      ))
    )
      return "Denied by user. Do not retry this command unless asked.";
    signal.throwIfAborted();
    const env = { ...process.env };
    delete env.MODAL_PROXY_TOKEN_ID;
    delete env.MODAL_PROXY_TOKEN_SECRET;
    const proc = Bun.spawn(
      process.platform === "win32"
        ? [
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            command,
          ]
        : ["sh", "-lc", command],
      {
        cwd: this.root,
        env,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        windowsHide: true,
        detached: process.platform !== "win32",
      },
    );
    let timedOut = false;
    let killed = false;
    const kill = () => {
      if (killed) return;
      killed = true;
      if (process.platform === "win32") {
        // Let taskkill terminate the process tree before the parent disappears.
        Bun.spawn(["taskkill", "/pid", String(proc.pid), "/T", "/F"], {
          stdout: "ignore",
          stderr: "ignore",
          windowsHide: true,
        });
      } else {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          proc.kill();
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, 60_000);
    signal.addEventListener("abort", kill, { once: true });
    let retained = 0;
    let truncated = false;
    async function consume(stream: ReadableStream<Uint8Array>) {
      let result = "";
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        const text = decoder.decode(chunk, { stream: true });
        const remaining = Math.max(0, LIMIT - retained);
        result += text.slice(0, remaining);
        retained += Math.min(text.length, remaining);
        if (text.length > remaining) truncated = true;
      }
      return result;
    }
    try {
      const [stdout, stderr, exit] = await Promise.all([
        consume(proc.stdout),
        consume(proc.stderr),
        proc.exited,
      ]);
      return `Exit ${exit}${timedOut ? " (60s timeout)" : ""}${signal.aborted ? " (cancelled)" : ""}\n${stdout}${stderr ? "\n[stderr]\n" + stderr : ""}${truncated ? "\n[output truncated]" : ""}`;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
    }
  }
}
