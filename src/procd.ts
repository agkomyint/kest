import { spawn as nodeSpawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Process supervisor ("kestd"). One per workspace, detached from Kest, so processes outlive
 * the app: Kest reconnects through .kest/procs/daemon.json and finds everything still running.
 * Loopback only, bearer-token protected. Output goes to log files; clients poll with offsets.
 */
export type ProcState = "running" | "exited" | "crashed" | "stopped" | "lost";

export type ProcInfo = {
  id: string;
  name: string;
  owner: string;
  command: string;
  pid: number;
  port: number | null;
  state: ProcState;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  expiresAt: number;
  logSize: number;
  lastLine: string;
  /** Found again after the daemon restarted: still running, but output and input are no longer attached. */
  adopted: boolean;
};

export type StartParams = {
  name?: string;
  owner?: string;
  script?: string;
  argv?: string[];
  port?: number;
  ttlMinutes?: number;
  waitPort?: number;
  waitLog?: string;
  waitMs?: number;
};

export const procDir = (root: string) => join(root, ".kest", "procs");
const MAX_LOG = 8 * 1024 * 1024;
const KEEP_LOG = 2 * 1024 * 1024;
const HIDDEN_ENV = ["MODAL_PROXY_TOKEN_ID", "MODAL_PROXY_TOKEN_SECRET", "TAVILY_API_KEY", "LSI_KEY"];

type Entry = {
  info: ProcInfo;
  child: ReturnType<typeof nodeSpawn> | null;
  log: WriteStream | null;
  logBase: number;
  stopping: boolean;
  tail: string;
};

export function treeKill(pid: number) {
  try {
    if (process.platform === "win32") {
      const killer = nodeSpawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.on("error", () => {});
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {
    /* already gone */
  }
}

export function pidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function portOpen(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(400, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export class ProcDaemon {
  readonly dir: string;
  private entries = new Map<string, Entry>();
  private server: ReturnType<typeof Bun.serve> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private idleSince = Date.now();
  token = randomBytes(24).toString("hex");
  port = 0;
  onShutdown: (() => void) | null = null;

  constructor(
    readonly root: string,
    private opts: { idleMs?: number; defaultTtlMs?: number; tickMs?: number } = {},
  ) {
    this.dir = procDir(root);
  }

  /** Start listening and write daemon.json so clients can find this daemon. */
  async listen() {
    await mkdir(this.dir, { recursive: true });
    await this.restore();
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => this.handle(request),
    });
    this.port = this.server.port!;
    await writeFile(join(this.dir, "daemon.json"), JSON.stringify({ port: this.port, token: this.token, pid: process.pid, startedAt: Date.now() }));
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs ?? 2000);
    this.timer.unref?.();
  }

  private async handle(request: Request): Promise<Response> {
    // A browser page must never be able to drive this: no cross-origin callers, token required.
    if (request.headers.get("origin") || request.headers.get("authorization") !== `Bearer ${this.token}`) return new Response("forbidden", { status: 403 });
    try {
      const { method, params } = (await request.json()) as { method: string; params?: Record<string, any> };
      return Response.json({ ok: true, result: await this.call(method, params ?? {}) });
    } catch (error) {
      return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async call(method: string, p: Record<string, any>): Promise<unknown> {
    switch (method) {
      case "ping":
        return { pid: process.pid, root: this.root };
      case "start":
        return this.start(p as StartParams);
      case "list":
        return this.list(typeof p.owner === "string" ? p.owner : undefined);
      case "logs":
        return this.logs(String(p.id), { lines: p.lines, since: p.since });
      case "send":
        return this.send(String(p.id), String(p.text ?? ""));
      case "stop":
        return this.stop(String(p.id));
      case "stopAll":
        return this.stopAll(typeof p.owner === "string" ? p.owner : undefined);
      case "shutdown":
        setTimeout(() => void this.shutdown(), 20);
        return true;
      default:
        throw new Error(`Unknown method ${method}`);
    }
  }

  private find(ref: string): Entry {
    const all = [...this.entries.values()];
    const hit = all.find((e) => e.info.id === ref) ?? all.filter((e) => e.info.name === ref).at(-1) ?? all.filter((e) => e.info.id.startsWith(ref))[0];
    if (!hit) throw new Error(`No process "${ref}". Use action list to see them.`);
    return hit;
  }

  async start(p: StartParams): Promise<{ info: ProcInfo; ready: boolean | null; reason: string; output: string }> {
    const hasScript = typeof p.script === "string" && p.script.trim();
    const hasArgv = Array.isArray(p.argv) && p.argv.length > 0 && p.argv.every((a) => typeof a === "string");
    if (!hasScript === !hasArgv) throw new Error("Give exactly one of script (Bun source) or argv (an external program and its arguments).");
    const id = randomBytes(3).toString("hex");
    let argv: string[];
    let command: string;
    if (hasScript) {
      const file = join(this.dir, `${id}.ts`);
      await writeFile(file, p.script!);
      argv = [process.execPath, "run", file];
      command = p.script!.trim().split("\n")[0]!.slice(0, 120);
    } else {
      argv = p.argv!;
      command = argv.join(" ").slice(0, 160);
    }
    const name = (p.name?.trim() || `proc-${id}`).slice(0, 40);
    if ([...this.entries.values()].some((e) => e.info.name === name && e.info.state === "running"))
      throw new Error(`A process named "${name}" is already running. Stop it first or pick another name.`);
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of HIDDEN_ENV) delete env[key];
    if (p.port) env.PORT = String(p.port);
    const ttl = Math.max(1, Math.min(p.ttlMinutes ?? 0, 24 * 60)) * 60_000 || this.opts.defaultTtlMs || 6 * 3600_000;
    const log = createWriteStream(join(this.dir, `${id}.log`), { flags: "a" });
    const child = nodeSpawn(argv[0]!, argv.slice(1), {
      cwd: this.root,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const entry: Entry = {
      child,
      log,
      logBase: 0,
      stopping: false,
      tail: "",
      info: {
        id,
        name,
        owner: p.owner || "chat",
        command,
        pid: child.pid ?? 0,
        port: p.port ?? null,
        state: "running",
        exitCode: null,
        startedAt: Date.now(),
        endedAt: null,
        expiresAt: Date.now() + ttl,
        logSize: 0,
        lastLine: "",
        adopted: false,
      },
    };
    this.entries.set(id, entry);
    const sink = (chunk: Buffer, mark = "") => {
      const text = mark ? chunk.toString().replace(/^/gm, mark) : chunk.toString();
      log.write(text);
      entry.info.logSize += Buffer.byteLength(text);
      entry.tail = (entry.tail + text).slice(-4000);
      const line = entry.tail.trimEnd().split("\n").at(-1);
      if (line) entry.info.lastLine = line.slice(0, 200);
      if (entry.info.logSize > MAX_LOG) void this.rotate(entry);
    };
    child.stdout?.on("data", (c: Buffer) => sink(c));
    child.stderr?.on("data", (c: Buffer) => sink(c));
    child.stdin?.on("error", () => {});
    child.on("error", (error) => {
      sink(Buffer.from(`[failed to start: ${error.message}]\n`));
      this.finish(entry, -1);
    });
    child.on("exit", (code) => this.finish(entry, code));
    await this.save();
    if (p.waitPort || p.waitLog) return { ...(await this.waitReady(entry, p)), info: entry.info };
    return { info: entry.info, ready: null, reason: "started", output: "" };
  }

  private finish(entry: Entry, code: number | null) {
    if (entry.info.state !== "running") return;
    entry.info.exitCode = code;
    entry.info.endedAt = Date.now();
    entry.info.state = entry.stopping ? "stopped" : code === 0 ? "exited" : "crashed";
    entry.child = null;
    setTimeout(() => entry.log?.end(), 100);
    this.idleSince = Date.now();
    void this.save();
  }

  /** Wait until a port accepts connections or a log line matches; give up on exit or timeout. */
  private async waitReady(entry: Entry, p: StartParams) {
    const deadline = Date.now() + Math.max(500, Math.min(p.waitMs ?? 15_000, 120_000));
    const pattern = p.waitLog ? new RegExp(p.waitLog, "i") : null;
    for (;;) {
      if (pattern?.test(entry.tail)) return { ready: true, reason: entry.info.state === "running" ? "log line matched" : `log line matched (then it exited with code ${entry.info.exitCode})`, output: entry.tail.slice(-600) };
      if (entry.info.state !== "running") return { ready: false, reason: `exited with code ${entry.info.exitCode} before it was ready`, output: entry.tail.slice(-1500) };
      if (p.waitPort && (await portOpen(p.waitPort))) return { ready: true, reason: `port ${p.waitPort} is accepting connections`, output: entry.tail.slice(-600) };
      if (Date.now() > deadline) return { ready: false, reason: "still running but not ready yet (timed out waiting); check logs", output: entry.tail.slice(-1500) };
      await Bun.sleep(150);
    }
  }

  private async rotate(entry: Entry) {
    const file = join(this.dir, `${entry.info.id}.log`);
    try {
      const size = (await stat(file)).size;
      if (size <= MAX_LOG) return;
      const keep = Buffer.from(await Bun.file(file).slice(size - KEEP_LOG, size).arrayBuffer());
      entry.log?.end();
      await writeFile(file, keep);
      entry.logBase += size - KEEP_LOG;
      entry.info.logSize = KEEP_LOG;
      entry.log = createWriteStream(file, { flags: "a" });
    } catch {
      /* best effort */
    }
  }

  list(owner?: string): ProcInfo[] {
    return [...this.entries.values()].map((e) => e.info).filter((i) => !owner || i.owner === owner);
  }

  /** Read output: the last `lines`, or everything after absolute byte offset `since`. */
  async logs(ref: string, o: { lines?: number; since?: number }) {
    const entry = this.find(ref);
    const file = join(this.dir, `${entry.info.id}.log`);
    await new Promise((r) => setTimeout(r, 30)); // let the stream flush
    let text = "";
    try {
      text = await Bun.file(file).text();
    } catch {
      /* no output yet */
    }
    const end = entry.logBase + Buffer.byteLength(text);
    if (typeof o.since === "number") {
      const rel = Math.max(0, o.since - entry.logBase);
      const buf = Buffer.from(text).subarray(rel);
      return { id: entry.info.id, text: buf.toString().slice(-20_000), next: end, state: entry.info.state };
    }
    const lines = text.split("\n");
    const take = Math.max(1, Math.min(o.lines ?? 40, 400));
    return { id: entry.info.id, text: lines.slice(-take - 1).join("\n").slice(-20_000), next: end, state: entry.info.state };
  }

  send(ref: string, text: string) {
    const entry = this.find(ref);
    if (entry.info.state !== "running") throw new Error(`${entry.info.name} is ${entry.info.state}.`);
    if (!entry.child?.stdin || entry.info.adopted) throw new Error("This process was reattached after a restart; its input is no longer connected. Stop and start it again.");
    entry.child.stdin.write(text);
    return true;
  }

  async stop(ref: string) {
    const entry = this.find(ref);
    if (entry.info.state !== "running") return entry.info;
    entry.stopping = true;
    treeKill(entry.info.pid);
    for (let i = 0; i < 40 && entry.info.state === "running"; i++) {
      if (entry.info.adopted && !pidAlive(entry.info.pid)) this.finish(entry, null);
      await Bun.sleep(75);
    }
    if (entry.info.state === "running") this.finish(entry, null);
    return entry.info;
  }

  async stopAll(owner?: string) {
    const running = this.list(owner).filter((i) => i.state === "running");
    await Promise.all(running.map((i) => this.stop(i.id)));
    return running.length;
  }

  private async tick() {
    const now = Date.now();
    for (const entry of this.entries.values()) {
      if (entry.info.state !== "running") continue;
      if (entry.info.adopted && !pidAlive(entry.info.pid)) this.finish(entry, null);
      else if (now > entry.info.expiresAt) {
        entry.child?.stdout?.emit("data", Buffer.from("[stopped: maximum lifetime reached]\n"));
        void this.stop(entry.info.id);
      }
    }
    if (this.list().some((i) => i.state === "running")) this.idleSince = now;
    else if (now - this.idleSince > (this.opts.idleMs ?? 10 * 60_000)) await this.shutdown();
  }

  private async save() {
    try {
      await writeFile(join(this.dir, "registry.json"), JSON.stringify(this.list()));
    } catch {
      /* best effort */
    }
  }

  /** After a daemon restart: processes still alive are adopted (killable, not attached); others are marked lost. */
  private async restore() {
    let saved: ProcInfo[] = [];
    try {
      saved = JSON.parse(await readFile(join(this.dir, "registry.json"), "utf8"));
    } catch {
      return;
    }
    for (const info of saved.slice(-50)) {
      if (info.state === "running") {
        if (info.pid && pidAlive(info.pid)) info.adopted = true;
        else {
          info.state = "lost";
          info.endedAt = Date.now();
        }
      }
      let logBase = 0;
      this.entries.set(info.id, { info, child: null, log: null, logBase, stopping: false, tail: "" });
    }
  }

  async shutdown() {
    if (this.timer) clearInterval(this.timer);
    this.server?.stop(true);
    await rm(join(this.dir, "daemon.json"), { force: true });
    this.onShutdown?.();
  }
}

/** Entry point for `kest --procd <root>`: run until idle, then exit. */
export async function runDaemon(root: string) {
  const dir = procDir(root);
  const existing = await readFile(join(dir, "daemon.json"), "utf8").then(JSON.parse, () => null);
  if (existing?.port) {
    try {
      const res = await fetch(`http://127.0.0.1:${existing.port}/`, {
        method: "POST",
        headers: { authorization: `Bearer ${existing.token}` },
        body: JSON.stringify({ method: "ping" }),
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) return; // another daemon already serves this workspace
    } catch {
      /* stale file */
    }
  }
  const daemon = new ProcDaemon(root);
  daemon.onShutdown = () => process.exit(0);
  await daemon.listen();
  await new Promise(() => {});
}
