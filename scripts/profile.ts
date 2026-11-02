// Local profile of Kest's hot paths. Fixtures only; no provider calls.
// Usage: bun run scripts/profile.ts [label]   -> prints a table, writes work/profile-<label>.json
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const label = process.argv[2] ?? "run";
const root = await mkdtemp(join(tmpdir(), "kest-profile-"));
process.env.KEST_CONFIG_DIR = join(root, "config");
const cwd = join(root, "ws");
await mkdir(cwd, { recursive: true });

const results: Record<string, number> = {};
async function time(name: string, fn: () => Promise<unknown> | unknown, runs = 7) {
  await fn(); // warmup
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  results[name] = Math.round(samples[Math.floor(samples.length / 2)]! * 100) / 100;
}

// 1. Cold start: importing the UI module graph in a fresh process.
{
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    const proc = Bun.spawn([process.execPath, "-e", "await import('./src/ui.ts')"], {
      cwd: join(import.meta.dir, ".."),
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  results["startup: import UI (cold process)"] = Math.round(samples[2]!);
}

const sessions = await import("../src/sessions");
const context = await import("../src/context");
const company = await import("../src/research-company");
const view = await import("../src/study-view");

// 2. Sessions: many saved conversations in one config dir.
const big = (n: number, size = 800) =>
  Array.from({ length: n }, (_, i) => ({
    role: i % 2 ? ("assistant" as const) : ("user" as const),
    content: `message ${i} ` + "lorem ipsum dolor ".repeat(size / 18),
  }));
for (let i = 0; i < 120; i++) {
  const s = sessions.newSession(cwd, big(60) as never);
  s.entries = big(60).map((m) => ({ role: "kest" as const, text: m.content }));
  await sessions.saveSession(s);
}
await time("sessions: list 120 saved sessions", () => sessions.listSessions(cwd), 5);
const heavy = sessions.newSession(cwd, big(400, 4000) as never);
heavy.entries = big(400, 4000).map((m) => ({ role: "kest" as const, text: m.content }));
await time("sessions: save one 3 MB session", () => sessions.saveSession(heavy));
const startup = performance.now();
await sessions.listSessions(cwd);
results["sessions: startup scan (first call)"] = Math.round(performance.now() - startup);

// 3. Context accounting on a long conversation.
const history = [
  { role: "system" as const, content: "S".repeat(6000) },
  ...big(300, 1500),
] as never[];
const toolsJson = JSON.parse(JSON.stringify([{ type: "function", function: { name: "x", description: "d".repeat(8000), parameters: { type: "object", properties: {} } } }]));
const state = context.newContext();
await time("context: estimateTokens (300 messages)", () => context.estimateTokens(history));
await time("context: report + plan compaction", () => {
  context.contextReport(history, toolsJson, state);
  context.planCompaction(history, toolsJson, state, true);
});

// 4. Research journal: one event record per model/tool step.
{
  const study = company.newCompany("profile objective");
  study.maxCostUsd = 10;
  const runtime = new company.CompanyRuntime(study, cwd);
  let n = 0;
  const events = 200;
  const start = performance.now();
  await Promise.all(
    Array.from({ length: events }, () =>
      runtime.record("tool_result", { name: "read_file", state: "done", n: n++, output: "x".repeat(200) }),
    ),
  );
  results[`research: journal ${events} concurrent events`] = Math.round(performance.now() - start);
  const sequential = performance.now();
  for (let i = 0; i < 100; i++) await runtime.record("tool_result", { name: "search", state: "done", n: i });
  results["research: journal 100 sequential events"] = Math.round(performance.now() - sequential);

  // 5. Study viewer on a big log + many workers.
  const dir = join(cwd, "research", study.id);
  await mkdir(join(dir, "agents"), { recursive: true });
  await writeFile(
    join(dir, "events.jsonl"),
    Array.from({ length: 20_000 }, (_, i) =>
      JSON.stringify({ at: "2026-01-01T00:00:00Z", kind: i % 50 ? "model_request" : "delegate_started", data: { role: "worker", task: "t" + i } }),
    ).join("\n"),
  );
  for (let i = 0; i < 40; i++)
    await writeFile(
      join(dir, "agents", `a${i}.json`),
      JSON.stringify({ id: `agent-${i}`, role: i % 8 ? "worker" : "reviewer", messages: big(30, 2000) }),
    );
  await time("research: open study (20k events, 40 workers)", () => view.loadStudyArtifacts(cwd, study), 5);
  await time("research: recover checkpoint", () => company.recoverCompany(cwd, structuredClone(study)));
}

// 6. Prompt weight sent on every request.
{
  const agent = await import("../src/agent");
  const a = new agent.Agent(cwd, async () => true);
  results["prompt: chat system+tools (tokens est.)"] = context.estimateTokens([
    { role: "system", content: agent.systemPrompt(cwd) },
  ]) + context.estimateTokens(a.toolDefs());
  for (const role of ["lead", "researcher", "reviewer"] as const) {
    const roleAgent = new agent.Agent(cwd, async () => true);
    (roleAgent as any).companyWorker = true;
    (roleAgent as any).researchRole = role;
    (roleAgent as any).canSpawn = role === "lead";
    (roleAgent as any).refreshResearchPrompt?.();
    const first = (roleAgent as any).messages?.[0]?.content;
    if (typeof first === "string")
      results[`prompt: ${role} system (tokens est.)`] = context.estimateTokens([{ role: "system", content: first }]);
  }
  results["prompt: research system (tokens est.)"] = context.estimateTokens([
    { role: "system", content: agent.systemPrompt(cwd, true) },
  ]);
}

// 7. UI: transcript render, room list, typing.
{
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { KestUI } = await import("../src/ui");
  const r = await createTestRenderer({ width: 120, height: 40 });
  const ui = new KestUI(r.renderer, cwd, { provider: "baseten", apiKey: "x" } as never);
  try {
    for (let i = 0; i < 12; i++) await (ui as any).command(`/research prepare Study number ${i}`);
    await time("ui: draw room list (12 rooms)", () => (ui as any).drawBar(), 15);
    const session = (ui as any).session;
    session.entries = big(400, 600).map((m, i) => ({ role: i % 2 ? "kest" : "you", text: m.content }));
    await time("ui: render 400-entry transcript", () => (ui as any).renderEntries(session), 5);
    await time("ui: one frame with long transcript", () => r.renderOnce(), 9);
    await time("ui: keystroke (input change)", () => {
      r.mockInput.typeText("a");
      return r.flush();
    }, 15);
  } finally {
    ui.close();
    await r.dispose();
  }
}

await rm(root, { recursive: true, force: true });
await Bun.write(join(import.meta.dir, "..", "work", `profile-${label}.json`), JSON.stringify(results, null, 2));
const width = Math.max(...Object.keys(results).map((k) => k.length));
for (const [name, value] of Object.entries(results)) console.log(`${name.padEnd(width)}  ${value}`);
process.exit(0);
