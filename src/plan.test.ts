import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, formatTasks, goalPrompt } from "./agent";
import { listSessions, newSession, saveSession } from "./sessions";

async function withIsolatedConfig(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "kest-plan-"));
  const prev = process.env.KEST_CONFIG_DIR;
  process.env.KEST_CONFIG_DIR = dir;
  try {
    await run(dir);
  } finally {
    if (prev === undefined) delete process.env.KEST_CONFIG_DIR;
    else process.env.KEST_CONFIG_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

function testAgent() {
  return new Agent(process.cwd(), async () => true);
}

test("goal prompt orders planning before doing", () => {
  const prompt = goalPrompt("Write a short story");
  expect(prompt).toContain("Write a short story");
  expect(prompt).toContain("set_plan");
  expect(prompt).toContain("update_task");
  expect(prompt).toContain("Do not start editing");
});

test("formatTasks renders an empty plan and a marked checklist", () => {
  expect(formatTasks([])).toContain("No plan yet");
  const text = formatTasks([
    { id: "t1", title: "Read the code", status: "done" },
    { id: "t2", title: "Write the fix", status: "doing", note: "halfway" },
    { id: "t3", title: "Run tests", status: "pending" },
  ]);
  expect(text).toContain("Tasks 1/3");
  expect(text).toContain("[x] 1. Read the code");
  expect(text).toContain("[>] 2. Write the fix — halfway");
  expect(text).toContain("[ ] 3. Run tests");
});

test("set_plan replaces tasks and update_task moves them", () => {
  const agent = testAgent();
  const out = agent.executePlanTool(
    "set_plan",
    JSON.stringify({ tasks: [{ title: "First" }, { title: "Second" }] }),
  );
  expect(agent.tasks.map((t) => t.title)).toEqual(["First", "Second"]);
  expect(agent.tasks.map((t) => t.status)).toEqual(["pending", "pending"]);
  expect(out).toContain("Tasks 0/2");
  const moved = agent.executePlanTool(
    "update_task",
    JSON.stringify({ task: 1, status: "doing" }),
  );
  expect(agent.tasks[0]!.status).toBe("doing");
  expect(moved).toContain("Tasks 0/2");
  agent.executePlanTool(
    "update_task",
    JSON.stringify({ task: "t2", status: "done", note: "verified" }),
  );
  expect(agent.tasks[1]).toMatchObject({ status: "done", note: "verified" });
});

test("plan tools reject bad input", () => {
  const agent = testAgent();
  expect(() => agent.executePlanTool("set_plan", "{}")).toThrow();
  expect(() =>
    agent.executePlanTool("set_plan", JSON.stringify({ tasks: [] })),
  ).toThrow();
  expect(() =>
    agent.executePlanTool(
      "set_plan",
      JSON.stringify({ tasks: [{ title: " " }] }),
    ),
  ).toThrow();
  expect(() =>
    agent.executePlanTool(
      "update_task",
      JSON.stringify({ task: 1, status: "done" }),
    ),
  ).toThrow();
  agent.executePlanTool(
    "set_plan",
    JSON.stringify({ tasks: [{ title: "Only" }] }),
  );
  expect(() =>
    agent.executePlanTool(
      "update_task",
      JSON.stringify({ task: 1, status: "finished" }),
    ),
  ).toThrow();
  expect(() =>
    agent.executePlanTool(
      "update_task",
      JSON.stringify({ task: 9, status: "done" }),
    ),
  ).toThrow();
});

test("tool definitions expose planning and spawning only to the parent", () => {
  const parent = testAgent();
  const names = parent
    .toolDefs()
    .map((t) => (t.type === "function" ? t.function.name : t.type));
  expect(names).toContain("set_plan");
  expect(names).toContain("update_task");
  expect(names).toContain("spawn_subagent");
  expect(names).toContain("read_file");
  parent.canSpawn = false;
  const childNames = parent
    .toolDefs()
    .map((t) => (t.type === "function" ? t.function.name : t.type));
  expect(childNames).toEqual(["list_files", "read_file", "search"]);
});

test("executeSpawn delegates to runChild and clips long findings", async () => {
  const agent = testAgent();
  agent.runChild = async () => "canned findings";
  const out = await agent.executeSpawn(
    JSON.stringify({ task: "Explore X", expected: "A list" }),
    { provider: "baseten", apiKey: "k" },
    new AbortController().signal,
    () => {},
  );
  expect(out).toBe("canned findings");
  agent.runChild = async () => "z".repeat(7000);
  const clipped = await agent.executeSpawn(
    JSON.stringify({ task: "Explore X" }),
    { provider: "baseten", apiKey: "k" },
    new AbortController().signal,
    () => {},
  );
  expect(clipped).toContain("[truncated]");
  expect(clipped.length).toBeLessThan(7000);
  await expect(
    agent.executeSpawn(
      JSON.stringify({}),
      { provider: "baseten", apiKey: "k" },
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow();
});

test("session tasks and goals persist and reload", async () => {
  await withIsolatedConfig(async () => {
    const session = newSession(process.cwd(), []);
    session.goal = "Ship it";
    session.tasks = [{ id: "t1", title: "Build", status: "doing" }];
    await saveSession(session);
    const loaded = await listSessions(process.cwd());
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.goal).toBe("Ship it");
    expect(loaded[0]?.tasks).toEqual([
      { id: "t1", title: "Build", status: "doing" },
    ]);
  });
});

test("Bun automation guidance refreshes resumed contexts without duplication", () => {
  const old = [
    {
      role: "system" as const,
      content: "Legacy agent. Shell runs in Windows PowerShell.",
    },
  ];
  const agent = new Agent(process.cwd(), async () => false, old);
  const prompt = String(agent.messages[0]!.content);
  expect(prompt).toContain("Do not launch PowerShell");
  expect(prompt).toContain("ONE shell call");
  expect(prompt).toContain("node:os");
  const resumed = new Agent(
    process.cwd(),
    async () => false,
    agent.messages,
    "Inspect machine",
  );
  expect(
    String(resumed.messages[0]!.content).split("<kest-bun-automation>"),
  ).toHaveLength(2);
  expect(String(resumed.messages[0]!.content)).toContain("User goal:");
});
