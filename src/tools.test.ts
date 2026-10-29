import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceTools, type Approval } from "./tools";

let root: string;
let tools: WorkspaceTools;
let requests: Approval[];
const signal = () => new AbortController().signal;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kest-tools-"));
  requests = [];
  tools = new WorkspaceTools(root, async (request) => {
    requests.push(request);
    return true;
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const call = (name: string, args: object) =>
  tools.execute(name, JSON.stringify(args), signal());

test("experiment timeouts are validated and visible in the approval preview", async () => {
  await expect(
    call("shell", { command: "console.log('must not run')", timeout_ms: 1 }),
  ).rejects.toThrow("timeout_ms");
  expect(requests).toHaveLength(0);
  const output = await call("shell", {
    command: "console.log('experiment fixture')",
    timeout_ms: 120000,
  });
  expect(output).toContain("experiment fixture");
  expect(requests[0]?.preview).toContain("Timeout: 120000 ms");
});

test("read/list/search return real workspace contents and exclude secrets", async () => {
  await Bun.write(join(root, "hello.ts"), "const answer = 42;\nhello world\n");
  await Bun.write(join(root, ".env"), "SECRET=hidden");
  expect(await call("list_files", { path: "." })).toContain("hello.ts");
  expect(await call("list_files", { path: "." })).not.toContain(".env");
  expect(await call("search", { path: ".", query: "ANSWER" })).toContain(
    "hello.ts:1:",
  );
  expect(
    await call("read_file", { path: "hello.ts", offset: 2, limit: 1 }),
  ).toContain("2  hello world");
  await expect(call("read_file", { path: ".env" })).rejects.toThrow(
    "Credential",
  );
});

test("blocks path traversal and symlink escapes", async () => {
  await expect(call("read_file", { path: "../outside.txt" })).rejects.toThrow();
  await expect(
    call("write_file", { path: "../outside.txt", content: "bad" }),
  ).rejects.toThrow("outside");
  const outside = await mkdtemp(join(tmpdir(), "kest-outside-"));
  try {
    await symlink(
      outside,
      join(root, "link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      call("write_file", { path: "link/escape.txt", content: "bad" }),
    ).rejects.toThrow("outside");
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
  expect(requests).toHaveLength(0);
});

test("edits require a current read, exact unique match, and diff approval", async () => {
  await Bun.write(join(root, "a.ts"), "const value = 1;\n");
  await expect(
    call("edit_file", { path: "a.ts", old_string: "1", new_string: "2" }),
  ).rejects.toThrow("Read");
  await call("read_file", { path: "a.ts" });
  expect(
    await call("edit_file", { path: "a.ts", old_string: "1", new_string: "2" }),
  ).toContain("Saved");
  expect(requests[0]?.preview).toContain("-const value = 1;");
  expect(requests[0]?.preview).toContain("+const value = 2;");
  expect(await Bun.file(join(root, "a.ts")).text()).toBe("const value = 2;\n");
  await expect(
    call("edit_file", { path: "a.ts", old_string: "missing", new_string: "3" }),
  ).rejects.toThrow("exactly once");
});

test("denying an edit or shell prevents execution", async () => {
  tools = new WorkspaceTools(root, async () => false);
  expect(await call("write_file", { path: "no.txt", content: "no" })).toContain(
    "Denied",
  );
  expect(await Bun.file(join(root, "no.txt")).exists()).toBe(false);
  expect(await call("shell", { command: "echo should-not-run" })).toContain(
    "Denied",
  );
});

test("does not overwrite a file changed during approval", async () => {
  const path = join(root, "a.txt");
  await Bun.write(path, "original");
  tools = new WorkspaceTools(root, async () => {
    await Bun.write(path, "external edit");
    return true;
  });
  await call("read_file", { path: "a.txt" });
  await expect(
    call("write_file", { path: "a.txt", content: "replacement" }),
  ).rejects.toThrow("changed");
  expect(await Bun.file(path).text()).toBe("external edit");
});

test("approved shell executes in workspace and returns stdout, stderr, and exit code", async () => {
  const command =
    "console.log('kest-shell-ok'); console.error('error-line'); process.exitCode = 3";
  const result = await call("shell", { command });
  expect(result).toContain("Exit 3");
  expect(result).toContain("kest-shell-ok");
  expect(result).toContain("error-line");
});

test("cancelled tools cannot write", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    tools.execute(
      "write_file",
      JSON.stringify({ path: "no.txt", content: "no" }),
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(await Bun.file(join(root, "no.txt")).exists()).toBe(false);
});

test("cancelling a running shell terminates it promptly", async () => {
  const controller = new AbortController();
  const command = "await Bun.sleep(30000)";
  const running = tools.execute(
    "shell",
    JSON.stringify({ command }),
    controller.signal,
  );
  const timer = setTimeout(() => controller.abort(), 300);
  try {
    expect(await running).toContain("cancelled");
  } finally {
    clearTimeout(timer);
  }
}, 5000);

test("batched search preserves results across batches and caps matching lines", async () => {
  await Promise.all(
    Array.from({ length: 35 }, (_, i) =>
      Bun.write(
        join(root, `${String(i).padStart(2, "0")}.txt`),
        "first\nneedle\n",
      ),
    ),
  );
  const result = await call("search", { path: ".", query: "NEEDLE" });
  expect(result.split("\n")).toHaveLength(35);
  for (let i = 0; i < 35; i++)
    expect(result).toContain(`${String(i).padStart(2, "0")}.txt:2: needle`);
  await Bun.write(join(root, "many.txt"), "needle\n".repeat(150));
  const capped = await call("search", { path: ".", query: "needle" });
  expect(
    capped.split("\n").filter((line) => line.includes(": needle")),
  ).toHaveLength(100);
  expect(capped).toContain("[result limit reached]");
});

test("search skips excluded folders and binary files while traversing nested files", async () => {
  await Bun.write(join(root, "nested", "a.txt"), "needle");
  await Bun.write(join(root, "node_modules", "hidden.txt"), "needle");
  await Bun.write(join(root, "binary.dat"), "needle\0");
  const result = await call("search", { path: ".", query: "needle" });
  expect(result).toContain("a.txt:1: needle");
  expect(result).not.toContain("hidden.txt");
  expect(result).not.toContain("binary.dat");
  const controller = new AbortController();
  controller.abort();
  await expect(
    tools.execute("search", '{"path":".","query":"needle"}', controller.signal),
  ).rejects.toThrow();
});

test("direct Bun scripts run in workspace with approval and preserve exit status", async () => {
  const result = await call("shell", {
    command:
      "console.log(process.cwd()); console.error('script-error'); process.exitCode = 3",
  });
  expect(result).toContain(root);
  expect(result).toContain("script-error");
  expect(result).toContain("Exit 3");
  expect(requests[0]?.preview).toContain("Runtime: Bun");
  tools = new WorkspaceTools(root, async () => false);
  expect(
    await call("shell", {
      command: "throw new Error('must not run')",
    }),
  ).toContain("Denied");
});

test("prestarted Bun runs TypeScript once without leaking state to the next call", async () => {
  tools.prepareShell();
  await Bun.sleep(80);
  const first = await call("shell", {
    command:
      "import os from 'node:os'; const n: number = 42; globalThis.kestMarker = n; console.log(os.hostname(), n)",
  });
  expect(first).toContain("Exit 0");
  expect(first).toContain("42");
  tools.prepareShell();
  await Bun.sleep(80);
  const second = await call("shell", {
    command:
      "console.log(globalThis.kestMarker === undefined ? 'isolated' : 'leaked')",
  });
  expect(second).toContain("isolated");
  tools.disposeShell();
});

test("unused prestarted Bun is stopped and denied scripts never execute", async () => {
  tools = new WorkspaceTools(root, async () => false);
  tools.prepareShell();
  const proc = tools["preparedShell"]!;
  const result = await call("shell", {
    command: "await Bun.write('must-not-exist.txt', 'bad')",
  });
  expect(result).toContain("Denied");
  expect(await Bun.file(join(root, "must-not-exist.txt")).exists()).toBe(false);
  tools.disposeShell();
  await proc.exited;
  expect(tools["preparedShell"]).toBeNull();
});
