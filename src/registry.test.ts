import { afterAll, expect, test } from "bun:test";
import { Agent } from "./agent";
import { newCompany } from "./research-company";
import { REGISTRY, TIERS, defaultToolMs, describeRegistry, isParallelTool, toolsForTier, type Tier } from "./registry";

const prev = { tavily: process.env.TAVILY_API_KEY, lsi: process.env.LSI_KEY };
process.env.TAVILY_API_KEY = "tvly-test";
process.env.LSI_KEY = "lsi_test";
afterAll(() => {
  if (prev.tavily === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = prev.tavily;
  if (prev.lsi === undefined) delete process.env.LSI_KEY;
  else process.env.LSI_KEY = prev.lsi;
});

const names = (a: Agent) => a.toolDefs().flatMap((t) => (t.type === "function" ? [t.function.name] : []));
const mk = () => new Agent(process.cwd(), async () => false);
const noop = (async () => "") as never;

function offered(tier: Tier): string[] {
  if (tier === "ceo") {
    const a = mk();
    a.onPrepareResearch = noop;
    a.onStartPrepared = noop;
    a.onListResearch = noop;
    a.onDeleteResearch = noop;
    a.inboxState = () => "send";
    a.onInboxDraft = noop;
    a.onInboxSend = noop;
    return names(a);
  }
  if (tier === "director") {
    const a = mk();
    a.research = newCompany("a study objective that is long enough");
    a.onNotifyControl = noop;
    a.onAskControl = noop;
    const before = names(a);
    (a as unknown as { company: unknown }).company = { state: { status: "completed", finalReportPath: "research/x/report.md" } };
    return [...new Set([...before, ...names(a)])];
  }
  const a = mk();
  a.toolScope = "research";
  a.canSpawn = tier === "researcher";
  return names(a);
}

test("every tool a tier is offered is registered for that tier, and every registration is really offered", () => {
  for (const tier of TIERS) {
    const got = [...new Set(offered(tier))].sort();
    expect({ tier, tools: got }).toEqual({ tier, tools: toolsForTier(tier).sort() });
  }
});

test("a subagent never has a tool its researcher lacks, and nothing below the CEO can edit, run shell or manage studies", () => {
  const researcher = new Set(toolsForTier("researcher"));
  for (const tool of toolsForTier("subagent")) expect(researcher.has(tool)).toBe(true);
  for (const tier of ["researcher", "subagent"] as Tier[])
    for (const tool of toolsForTier(tier)) {
      const effect = REGISTRY[tool]!.effect;
      expect(["write", "exec"]).not.toContain(effect);
      expect(REGISTRY[tool]!.family).not.toBe("studies");
    }
  expect(toolsForTier("subagent")).not.toContain("spawn_subagent");
  expect(toolsForTier("subagent")).not.toContain("research_team");
});

test("tools that ask for approval say what for, and parallel tools are read-only", () => {
  for (const [name, s] of Object.entries(REGISTRY)) {
    if (isParallelTool(name)) expect(s.effect).toBe("read");
    if (s.effect === "write" || s.effect === "exec") expect(s.approval).not.toBeNull();
    expect(s.ms).toBeGreaterThan(0);
    expect(s.tiers.length).toBeGreaterThan(0);
  }
  expect(defaultToolMs("shell")).toBe(15_000);
  expect(defaultToolMs("not-a-tool")).toBe(1_000);
  expect(describeRegistry().length).toBe(Object.keys(REGISTRY).length);
});

test("an agent knows its tier from where it sits", () => {
  expect(mk().tier).toBe("ceo");
  const director = mk();
  director.research = newCompany("a study objective that is long enough");
  expect(director.tier).toBe("director");
  const worker = mk();
  worker.useCompany({} as never, 1);
  expect(worker.tier).toBe("researcher");
  worker.canSpawn = false;
  expect(worker.tier).toBe("subagent");
  const atZero = mk();
  atZero.useCompany({} as never, 0);
  expect(atZero.tier).toBe("director");
});

test("stats group calls by tier and keep old untagged calls separate", async () => {
  const { tierStats } = await import("./stats");
  const c = (name: string, tier?: Tier, error = false, durationMs = 1000) => ({ name, tier, error, durationMs });
  const timings = [
    ...Array.from({ length: 5 }, () => c("shell", "ceo")),
    c("read_file", "ceo"),
    ...Array.from({ length: 4 }, () => c("tavily_search", "researcher")),
    c("browser", "researcher", true, 6000),
    c("browser", "researcher", true, 6000),
    c("browser", "subagent", false, 6000),
    c("read_file"),
  ];
  const text = tierStats(timings, { width: 78, summary: { sessions: 3, workspaces: 2 } }).join("\n");
  expect(text).toContain("CEO (you)");
  expect(text).toContain("Researchers");
  expect(text).toContain("Subagents");
  expect(text).toContain("Before tiers");
  expect(text).not.toContain("Directors");
  expect(text).toContain("Slowest         browser");
  expect(text).toContain("Highest errors  browser 67% of 3 calls");
  expect(tierStats([], {}).join("\n")).toContain("No tool calls recorded yet");
  for (const l of tierStats(timings, { width: 44 })) expect(l.length).toBeLessThanOrEqual(44);
});
