import { beforeEach, afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LsiTools, lsiKey, lsiBaseUrl, saveLsiKey, lsiRequest, lsiToolDefinitions, lsiReadToolDefinitions } from "./lsi";
import { autoApprove } from "./permissions";

const KEY = "lsi_" + "a".repeat(32);
let directory: string;
const saved: Record<string, string | undefined> = {};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "kest-lsi-"));
  for (const k of ["KEST_CONFIG_DIR", "LSI_KEY", "LSI_BASE_URL"]) saved[k] = process.env[k];
  process.env.KEST_CONFIG_DIR = directory;
  delete process.env.LSI_KEY;
  delete process.env.LSI_BASE_URL;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(directory, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

test("key storage: saved file beats env, rejects malformed keys, file is private", async () => {
  expect(lsiKey()).toBeNull();
  process.env.LSI_KEY = "lsi_environment_fixture_1234";
  expect(lsiKey()).toBe("lsi_environment_fixture_1234");
  await expect(saveLsiKey("not-a-key")).rejects.toThrow("valid LSI");
  await saveLsiKey(KEY);
  expect(lsiKey()).toBe(KEY);
  expect(JSON.parse(await readFile(join(directory, "lsi.json"), "utf8")).apiKey).toBe(KEY);
  if (process.platform !== "win32") expect((await stat(join(directory, "lsi.json"))).mode & 0o077).toBe(0);
});

test("base URL must be https (http only for localhost) and credential-free", () => {
  expect(lsiBaseUrl()).toBe("https://lsi-flax.vercel.app");
  process.env.LSI_BASE_URL = "http://localhost:3000/";
  expect(lsiBaseUrl()).toBe("http://localhost:3000");
  process.env.LSI_BASE_URL = "http://evil.example";
  expect(() => lsiBaseUrl()).toThrow("https");
  process.env.LSI_BASE_URL = "https://user:pw@evil.example";
  expect(() => lsiBaseUrl()).toThrow("https");
});

test("requests are validated and mapped to API paths", () => {
  expect(lsiRequest("lsi_questions", {}).path).toBe("/api/questions?claimable=true");
  expect(lsiRequest("lsi_search", { q: "a b", limit: 5 }).path).toBe("/api/search?q=a+b&limit=5");
  expect(lsiRequest("lsi_claim", { question_id: "LSI-Q-000001" })).toMatchObject({ method: "POST", path: "/api/questions/LSI-Q-000001/claim" });
  expect(() => lsiRequest("lsi_claim", { question_id: "../../admin" })).toThrow("Invalid question_id");
  expect(() => lsiRequest("lsi_search", { q: "x", extra: 1 })).toThrow("Unsupported");
  expect(() => lsiRequest("lsi_publish", {})).toThrow("Missing research");
  expect(() => lsiRequest("lsi_publish", { research: { blob: "x".repeat(100_001) } })).toThrow("100 KB");
});

test("read tools exclude writers; publish needs approval and is idempotent", async () => {
  const readNames = lsiReadToolDefinitions.map(t => (t.type === "function" ? t.function.name : ""));
  expect(readNames).not.toContain("lsi_publish");
  expect(readNames).not.toContain("lsi_claim");
  expect(lsiToolDefinitions.length).toBe(9);

  const seen: { url: string; init: RequestInit }[] = [];
  const approvals: string[] = [];
  const tools = (allow: boolean) =>
    new LsiTools(async r => { approvals.push(r.kind + ":" + r.title); return allow; }, {
      key: () => KEY,
      baseUrl: () => "https://lsi.test",
      fetch: async (url, init) => { seen.push({ url, init }); return reply({ id: "LSI-R-000001" }, 201); },
    });

  expect(await tools(false).execute("lsi_publish", { research: { title: "t" } }, signal())).toContain("Denied");
  expect(seen).toHaveLength(0);

  const out = await tools(true).execute("lsi_publish", { research: { title: "t" } }, signal());
  await tools(true).execute("lsi_publish", { research: { title: "t" } }, signal());
  expect(out).toContain("untrusted");
  expect(approvals[1]).toBe("lsi:Publish research to LSI");
  const headers = seen[0]!.init.headers as Record<string, string>;
  expect(headers.Authorization).toBe(`Bearer ${KEY}`);
  expect(headers["Idempotency-Key"]).toStartWith("kest-");
  expect((seen[1]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBe(headers["Idempotency-Key"]);
  expect(seen[0]!.init.redirect).toBe("error");

  approvals.length = 0;
  await tools(true).execute("lsi_search", { q: "x" }, signal());
  expect(approvals).toHaveLength(0); // reads never prompt
});

test("errors are actionable and the key never leaks", async () => {
  const run = (status: number, body: unknown, headers = {}) =>
    new LsiTools(async () => true, { key: () => KEY, baseUrl: () => "https://lsi.test", fetch: async () => reply(body, status, headers) })
      .execute("lsi_search", { q: "x" }, signal());
  await expect(run(401, {})).rejects.toThrow("/connect lsi");
  await expect(run(429, { error: "slow" }, { "retry-after": "12" })).rejects.toThrow("Wait 12s");
  await expect(run(422, { error: "Invalid", details: [{ path: "evidence.0.commit", message: "required" }] })).rejects.toThrow("evidence.0.commit");
  expect(await run(200, { echo: KEY })).not.toContain(KEY);
  await expect(new LsiTools(async () => true, { key: () => null }).execute("lsi_search", { q: "x" }, signal())).rejects.toThrow("/connect lsi");
});

test("permission modes: all approves every kind including LSI; strict and minimal ask for LSI", () => {
  for (const kind of ["file", "script", "browser", "web", "lsi"] as const)
    expect(autoApprove("all", { kind, title: "", preview: "" })).toBe(true);
  const lsi = { kind: "lsi" as const, title: "Publish", preview: "" };
  expect(autoApprove("minimal", lsi)).toBe(false);
  expect(autoApprove("strict", lsi)).toBe(false);
});

test("LSI write tools exist only inside a /research run; chat and workers only read", async () => {
  const { Agent } = await import("./agent");
  const { newCompany } = await import("./research-company");
  await saveLsiKey(KEY);
  const agent = new Agent(directory, async () => false);
  const names = () => agent.toolDefs().flatMap(t => (t.type === "function" ? [t.function.name] : []));
  expect(names()).toContain("lsi_search");
  expect(names()).not.toContain("lsi_publish");
  expect(names()).not.toContain("lsi_claim");
  agent.research = newCompany("test objective");
  expect(names()).toContain("lsi_claim");
  expect(names()).not.toContain("lsi_publish"); // not until the study is completed
  const company = (agent as unknown as { company?: { state: { status: string; finalReportPath?: string } } });
  company.company = { state: { status: "completed", finalReportPath: "research/x/report.md" } };
  expect(names()).toContain("lsi_publish");
  agent.toolScope = "research";
  expect(names()).toContain("lsi_search");
  expect(names()).not.toContain("lsi_publish");
});

test("stops retrying a tool after three consecutive failures", async () => {
  let calls = 0;
  const tools = new LsiTools(async () => true, {
    key: () => KEY,
    baseUrl: () => "https://lsi.example",
    fetch: async () => { calls++; return new Response(JSON.stringify({ error: "Invalid question", details: [{ message: "unknown domain" }] }), { status: 422 }); },
  });
  const args = { text: "Does X beat Y for Z workloads?", domain: "guess" };
  for (let i = 0; i < 3; i++) await expect(tools.execute("lsi_post_question", args, new AbortController().signal)).rejects.toThrow("lsi_domains");
  await expect(tools.execute("lsi_post_question", args, new AbortController().signal)).rejects.toThrow("Stop retrying");
  expect(calls).toBe(3);
});
