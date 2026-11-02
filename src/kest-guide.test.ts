import { expect, test } from "bun:test";
import { Agent, systemPrompt } from "./agent";
import { KEST_GUIDE_TOPICS, kestGuide } from "./kest-guide";

test("kest_guide answers every topic and the chat agent can call it", () => {
  expect(KEST_GUIDE_TOPICS).toEqual(
    expect.arrayContaining(["overview", "research", "rooms", "lsi", "permissions", "budgets", "tools", "commands"]),
  );
  for (const topic of KEST_GUIDE_TOPICS) expect(kestGuide(topic).length).toBeGreaterThan(50);
  expect(kestGuide(undefined)).toContain("Kest");
  expect(kestGuide("research")).toContain("/research prepare");
  expect(() => kestGuide("nope")).toThrow("Unknown topic");
  expect(systemPrompt("/w")).toContain("kest_guide");
  const agent = new Agent(process.cwd(), async () => true);
  const names = agent.toolDefs().map((t) => (t.type === "function" ? t.function.name : ""));
  expect(names).toContain("kest_guide");
});

test("research_prepare is offered to chat only and hands the objective to the UI", async () => {
  const { newCompany } = await import("./research-company");
  const agent = new Agent(process.cwd(), async () => true);
  const names = () => agent.toolDefs().map((t) => (t.type === "function" ? t.function.name : ""));
  expect(names()).not.toContain("research_prepare");
  const seen: string[] = [];
  agent.onPrepareResearch = async (objective) => (seen.push(objective), "ok");
  expect(names()).toContain("research_prepare");
  const call = (agent as unknown as { prepareResearchTool(raw: string): Promise<string> }).prepareResearchTool.bind(agent);
  await expect(call(JSON.stringify({ objective: "too short" }))).rejects.toThrow("20-1500");
  expect(await call(JSON.stringify({ objective: "Measure whether A/B live runs confirm LSI-R-000002 token savings" }))).toBe("ok");
  expect(seen).toHaveLength(1);
  agent.research = newCompany("x objective for the study");
  expect(names()).not.toContain("research_prepare");
});

test("research_prepare passes an approved budget and start, and rejects start without one", async () => {
  const agent = new Agent(process.cwd(), async () => true);
  const seen: unknown[] = [];
  agent.onPrepareResearch = async (_o, opts) => (seen.push(opts), "ok");
  const call = (agent as unknown as { prepareResearchTool(raw: string): Promise<string> }).prepareResearchTool.bind(agent);
  const objective = "Measure whether A/B live runs confirm LSI-R-000002 token savings";
  await call(JSON.stringify({ objective, budget_usd: 10, start: true }));
  expect(seen[0]).toEqual({ budgetUsd: 10, start: true, autoPublish: false, studyId: undefined });
  await call(JSON.stringify({ study_id: "abc123", budget_usd: 4 }));
  expect(seen[1]).toMatchObject({ budgetUsd: 4, studyId: "abc123" });
  await expect(call(JSON.stringify({ objective, start: true }))).rejects.toThrow("budget_usd");
  await expect(call(JSON.stringify({ objective, budget_usd: 5000 }))).rejects.toThrow("budget_usd");
});

test("strict budget never writes a funding proposal", async () => {
  const { newCompany, CompanyRuntime } = await import("./research-company");
  const state = newCompany("Measure something specific enough to count here");
  state.maxCostUsd = 5;
  state.strictBudget = true;
  const rt = new CompanyRuntime(state);
  const text: string = await rt.saveFundingProposal("budget reached");
  expect(text).toContain("No extra funding is requested");
  expect(state.fundingProposal).toBeUndefined();
  expect(state.status).toBe("budget_exhausted");
});

test("the main chat is saved in the working folder and loads back; studies and empty chats are skipped", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { newSession, saveLocalChat, loadLocalChat } = await import("./sessions");
  const { newCompany } = await import("./research-company");
  const dir = await mkdtemp(join(tmpdir(), "kest-local-chat-"));
  const previous = process.env.KEST_LOCAL_CHAT;
  process.env.KEST_LOCAL_CHAT = "1";
  try {
    const empty = newSession(dir, [{ role: "system", content: "s" }]);
    await saveLocalChat(empty);
    expect(await loadLocalChat(dir)).toBeNull();
    const chat = newSession(dir, [{ role: "system", content: "s" }, { role: "user", content: "hello there" }]);
    chat.title = "hello";
    await saveLocalChat(chat);
    expect((await loadLocalChat(dir))?.id).toBe(chat.id);
    expect(await readFile(join(dir, ".kest", ".gitignore"), "utf8")).toBe("*\n");
    const study = newSession(dir, [{ role: "user", content: "x" }]);
    study.research = newCompany("A study objective long enough to count");
    study.id = crypto.randomUUID();
    await saveLocalChat(study);
    expect((await loadLocalChat(dir))?.id).toBe(chat.id);
  } finally {
    if (previous === undefined) delete process.env.KEST_LOCAL_CHAT; else process.env.KEST_LOCAL_CHAT = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
