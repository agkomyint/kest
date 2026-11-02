import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { procDir, type ProcInfo, type StartParams } from "./procd";

/** Client for the per-workspace process daemon. Starts it on demand and reconnects after Kest restarts. */
export class ProcClient {
  private conn: { port: number; token: string } | null = null;

  constructor(
    readonly root: string,
    /** How to launch the daemon; defaults to this same program with --procd. */
    private launch: string[] = defaultLaunch(root),
  ) {}

  private async read() {
    try {
      const j = JSON.parse(await readFile(join(procDir(this.root), "daemon.json"), "utf8"));
      return typeof j.port === "number" && typeof j.token === "string" ? { port: j.port, token: j.token } : null;
    } catch {
      return null;
    }
  }

  private async rpc<T>(conn: { port: number; token: string }, method: string, params: object = {}, timeout = 130_000): Promise<T> {
    const res = await fetch(`http://127.0.0.1:${conn.port}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${conn.token}` },
      body: JSON.stringify({ method, params }),
      signal: AbortSignal.timeout(timeout),
    });
    const body = (await res.json()) as { ok: boolean; result?: T; error?: string };
    if (!body.ok) throw new Error(body.error ?? "Process daemon error");
    return body.result as T;
  }

  /** Connect to the running daemon, or start one. Never starts a second for a live one. */
  async ensure() {
    if (this.conn && (await this.alive(this.conn))) return this.conn;
    this.conn = null;
    let found = await this.read();
    if (found && (await this.alive(found))) return (this.conn = found);
    const child = spawn(this.launch[0]!, this.launch.slice(1), {
      cwd: this.root,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
    for (let i = 0; i < 80; i++) {
      await Bun.sleep(100);
      found = await this.read();
      if (found && (await this.alive(found))) return (this.conn = found);
    }
    throw new Error("The process supervisor did not start.");
  }

  private async alive(conn: { port: number; token: string }) {
    try {
      await this.rpc(conn, "ping", {}, 1500);
      return true;
    } catch {
      return false;
    }
  }

  /** Is a daemon running right now? Does not start one (used by the UI to poll cheaply). */
  async peek(): Promise<boolean> {
    if (this.conn && (await this.alive(this.conn))) return true;
    this.conn = null;
    const found = await this.read();
    if (found && (await this.alive(found))) {
      this.conn = found;
      return true;
    }
    return false;
  }

  async call<T>(method: string, params: object = {}): Promise<T> {
    return this.rpc<T>(await this.ensure(), method, params);
  }

  start(params: StartParams) {
    return this.call<{ info: ProcInfo; ready: boolean | null; reason: string; output: string }>("start", params);
  }
  list(owner?: string) {
    return this.call<ProcInfo[]>("list", { owner });
  }
  /** List without starting a daemon: empty when none is running. */
  async listIfRunning(): Promise<ProcInfo[]> {
    return (await this.peek()) ? this.list() : [];
  }
  logs(id: string, o: { lines?: number; since?: number } = {}) {
    return this.call<{ id: string; text: string; next: number; state: string }>("logs", { id, ...o });
  }
  send(id: string, text: string) {
    return this.call<boolean>("send", { id, text });
  }
  stop(id: string) {
    return this.call<ProcInfo>("stop", { id });
  }
  async stopAll(owner?: string) {
    return (await this.peek()) ? this.call<number>("stopAll", { owner }) : 0;
  }
  async shutdown() {
    if (await this.peek()) await this.call("shutdown").catch(() => {});
  }
}

export function defaultLaunch(root: string): string[] {
  const entry = process.argv[1] ?? "";
  // Running from source or the built bundle: re-run the same file. Standalone exe: re-run the exe.
  return /\.(?:ts|js|mjs|cjs)$/.test(entry) && !/[\\/]\$bunfs[\\/]/i.test(entry)
    ? [process.execPath, entry, "--procd", root]
    : [process.execPath, "--procd", root];
}

const age = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
};

export const procSymbol = (state: ProcInfo["state"]) =>
  state === "running" ? "●" : state === "exited" ? "✓" : state === "stopped" ? "■" : "✗";

export function describeProc(p: ProcInfo) {
  const state = p.state === "running" ? `running ${age(p.startedAt)}` : `${p.state}${p.exitCode !== null ? ` (exit ${p.exitCode})` : ""} ${age(p.endedAt ?? p.startedAt)} ago`;
  return `${procSymbol(p.state)} ${p.id} ${p.name} · ${state}${p.port ? ` · port ${p.port}` : ""}${p.adopted ? " · reattached (no input)" : ""} · ${p.owner}${p.lastLine ? `\n    ${p.lastLine}` : ""}`;
}

const one = (v: unknown, what: string) => {
  if (typeof v !== "string" || !v.trim()) throw new Error(`Missing ${what}.`);
  return v.trim();
};

/** The `proc` tool. Approval for starting is handled by the caller (it has the UI). */
export async function procTool(client: ProcClient, args: Record<string, unknown>, owner: string): Promise<string> {
  const action = args.action;
  if (action === "list") {
    const all = await client.listIfRunning();
    return all.length ? all.map(describeProc).join("\n") : "No processes.";
  }
  if (action === "start") {
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const r = await client.start({
      name: typeof args.name === "string" ? args.name : undefined,
      owner,
      script: typeof args.script === "string" ? args.script : undefined,
      argv: Array.isArray(args.argv) ? (args.argv as string[]) : undefined,
      port: num(args.port),
      ttlMinutes: num(args.ttl_minutes),
      waitPort: num(args.wait_port),
      waitLog: typeof args.wait_log === "string" ? args.wait_log : undefined,
      waitMs: num(args.wait_ms),
    });
    const head = `Started ${r.info.name} (id ${r.info.id}, pid ${r.info.pid}). It keeps running after this turn, even if Kest restarts; stop it with action stop.`;
    return r.ready === null ? head : `${head}\n${r.ready ? "READY" : "NOT READY"}: ${r.reason}.${r.output ? `\nOutput:\n${r.output}` : ""}`;
  }
  if (action === "logs") {
    const r = await client.logs(one(args.id, "id or name"), {
      lines: typeof args.lines === "number" ? args.lines : undefined,
      since: typeof args.since === "number" ? args.since : undefined,
    });
    return `[${r.state}] next=${r.next}\n${r.text || "(no output yet)"}`;
  }
  if (action === "send") {
    await client.send(one(args.id, "id or name"), String(args.text ?? ""));
    return "Sent.";
  }
  if (action === "stop") {
    const info = await client.stop(one(args.id, "id or name"));
    return `${info.name} is ${info.state}.`;
  }
  if (action === "stop_all") return `Stopped ${await client.stopAll()} process(es).`;
  throw new Error("proc action must be start, list, logs, send, stop or stop_all.");
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s);

/**
 * The pinned process panel: one row per process (running, plus recently finished), and when one is
 * watched, its live log tail underneath. Returns no lines when there is nothing to show.
 */
export function procPanel(
  list: ProcInfo[],
  width: number,
  o: { watch?: string | null; watchText?: string; maxRows?: number; logLines?: number; now?: number } = {},
): string[] {
  const now = o.now ?? Date.now();
  const shown = list.filter((p) => p.state === "running" || (p.endedAt ?? 0) > now - 120_000 || p.id === o.watch);
  if (!shown.length) return [];
  const running = shown.filter((p) => p.state === "running").length;
  const bad = shown.filter((p) => p.state === "crashed" || p.state === "lost").length;
  const maxRows = o.maxRows ?? 4;
  const lines = [cut(`⚙ ${running} process${running === 1 ? "" : "es"} running${bad ? ` · ✗ ${bad} crashed` : ""} · /procs · Alt+P watch`, width)];
  const rows = shown.slice(0, maxRows);
  const wide = width >= 70;
  for (const p of rows) {
    const mark = p.id === o.watch ? "▸" : " ";
    const port = p.port ? `:${p.port}` : "";
    const left = `${mark} ${procSymbol(p.state)} ${p.name}${port}`;
    const time = p.state === "running" ? age(p.startedAt) : `${p.state}${p.exitCode ? ` ${p.exitCode}` : ""}`;
    const head = `${left.padEnd(Math.min(24, Math.floor(width / 3)))} ${time.padEnd(9)}`;
    lines.push(cut(wide ? `${head} ${p.lastLine}` : head, width));
  }
  if (shown.length > rows.length) lines.push(`  … +${shown.length - rows.length} more · /procs`);
  const watched = o.watch ? list.find((p) => p.id === o.watch) : null;
  if (watched) {
    const title = `─ ${watched.name} · ${watched.state} · live log · Alt+P next · /procs unwatch `;
    lines.push(title.length >= width ? cut(title, width) : title + "─".repeat(width - title.length));
    const tail = (o.watchText ?? "").replace(/\s+$/, "").split("\n").filter((l, i, a) => l.length || i < a.length - 1);
    const want = o.logLines ?? 6;
    const last = tail.slice(-want);
    for (const l of last.length ? last : ["(no output yet)"]) lines.push(cut(`  ${l}`, width));
  }
  return lines;
}
