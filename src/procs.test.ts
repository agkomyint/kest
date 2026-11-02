import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcClient, procPanel, procTool } from "./procs";
import { pidAlive, type ProcInfo } from "./procd";

const root = await mkdtemp(join(tmpdir(), "kest-procs-"));
const launch = () => [process.execPath, join(import.meta.dir, "index.ts"), "--procd", root];
const client = new ProcClient(root, launch());

afterAll(async () => {
  await client.stopAll();
  await client.shutdown();
  await Bun.sleep(300);
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const server = `
const s = Bun.serve({ port: Number(process.env.PORT), fetch: (r) => new Response("pong " + new URL(r.url).pathname) });
console.log("listening on " + s.port);
process.stdin.on("data", (d) => console.log("echo:" + String(d).trim()));
`;

test("a started process outlives the client, is found again, serves requests and stops with its tree", async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const started = await procTool(client, { action: "start", name: "api", script: server, port, wait_port: port, wait_ms: 20000 }, "chat");
  expect(started).toContain("READY");
  const list = await client.list();
  const api = list.find((p) => p.name === "api")!;
  expect(api.state).toBe("running");
  expect(api.owner).toBe("chat");
  expect(pidAlive(api.pid)).toBe(true);
  expect(await (await fetch(`http://127.0.0.1:${port}/x`)).text()).toBe("pong /x");

  // A brand new client (Kest restarted) finds the same daemon and the same process.
  const again = new ProcClient(root, launch());
  const found = (await again.listIfRunning()).find((p) => p.id === api.id);
  expect(found?.state).toBe("running");
  expect(found?.pid).toBe(api.pid);

  // Output and input work through the daemon.
  await again.send("api", "hello\n");
  await Bun.sleep(300);
  const logs = await again.logs("api");
  expect(logs.text).toContain("listening on");
  expect(logs.text).toContain("echo:hello");
  const more = await again.logs("api", { since: logs.next });
  expect(more.text).toBe("");

  // Duplicate names are refused while running.
  await expect(client.start({ name: "api", script: "setInterval(()=>{},1000)" })).rejects.toThrow("already running");

  await again.stop("api");
  expect((await client.list()).find((p) => p.id === api.id)?.state).toBe("stopped");
  await Bun.sleep(200);
  expect(pidAlive(api.pid)).toBe(false);
  expect(await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)).toBe(false);
}, 60000);

test("readiness reports a crash, and exit codes are recorded", async () => {
  const r = await client.start({ name: "bad", script: 'console.log("boom"); process.exit(3);', waitLog: "never-matches", waitMs: 8000 });
  expect(r.ready).toBe(false);
  expect(r.reason).toContain("exited with code 3");
  expect(r.output).toContain("boom");
  expect((await client.list()).find((p) => p.name === "bad")?.state).toBe("crashed");
  const ok = await client.start({ name: "good", script: 'console.log("ready now"); setInterval(()=>{},1000);', waitLog: "ready now" });
  expect(ok.ready).toBe(true);
  expect(await client.stopAll()).toBeGreaterThanOrEqual(1);
}, 60000);

test("external programs run through argv and unknown processes are reported", async () => {
  const r = await client.start({ name: "ext", argv: [process.execPath, "-e", 'console.log("from argv")'], waitLog: "from argv" });
  expect(r.ready).toBe(true);
  await expect(client.logs("nope")).rejects.toThrow("No process");
  await expect(client.start({ name: "none" })).rejects.toThrow("exactly one");
});

test("the process panel shows running and recent processes, crashes, and a live log for the watched one", () => {
  const now = Date.now();
  const mk = (o: Partial<ProcInfo>): ProcInfo => ({ id: "a1", name: "api", owner: "chat", command: "", pid: 1, port: 8123, state: "running", exitCode: null, startedAt: now - 240_000, endedAt: null, expiresAt: now + 1e6, logSize: 0, lastLine: "listening on 8123", adopted: false, ...o });
  expect(procPanel([], 80)).toEqual([]);
  const list = [mk({}), mk({ id: "b2", name: "worker", port: null, state: "crashed", exitCode: 1, endedAt: now - 5000, lastLine: "TypeError: x is undefined" }), mk({ id: "c3", name: "old", state: "exited", exitCode: 0, endedAt: now - 600_000 })];
  const lines = procPanel(list, 90, { now });
  expect(lines[0]).toContain("1 process running");
  expect(lines[0]).toContain("1 crashed");
  const text = lines.join("\n");
  expect(text).toContain("api:8123");
  expect(text).toContain("TypeError");
  expect(text).not.toContain("old"); // finished long ago
  const watched = procPanel(list, 90, { now, watch: "a1", watchText: "one\ntwo\nthree\n", logLines: 2 });
  expect(watched.join("\n")).toContain("▸ ● api");
  expect(watched.slice(-2)).toEqual(["  two", "  three"]);
  expect(procPanel(list, 40, { now }).every((l) => l.length <= 40)).toBe(true);
});
