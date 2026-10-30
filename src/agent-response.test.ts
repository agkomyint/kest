import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, estimateToolMs, systemPrompt, type AgentEvent } from "./agent";
import { CompanyRuntime, newCompany } from "./research-company";

test("plain chat does not load research mode; research opt-in does", () => {
  expect(systemPrompt("/tmp")).not.toContain("kest-research-company");
  expect(systemPrompt("/tmp", true)).toContain("kest-research-company");
  const agent = new Agent("/tmp", async () => false);
  expect(String(agent.messages[0]!.content)).not.toContain(
    "kest-research-company",
  );
  const names = agent
    .toolDefs()
    .map((t) => (t.type === "function" ? t.function.name : ""));
  expect(names).not.toContain("research_team");
  expect(names).not.toContain("research_status");
  agent.research = newCompany("opted in");
  agent.refreshResearchPrompt();
  expect(String(agent.messages[0]!.content)).toContain("kest-research-company");
  const researchNames = agent
    .toolDefs()
    .map((t) => (t.type === "function" ? t.function.name : ""));
  expect(researchNames).toContain("research_team");
});

async function fixture(
  responses: { delta: unknown; finish: string }[],
  run: (
    agent: Agent,
    events: AgentEvent[],
    runtime: CompanyRuntime,
  ) => Promise<void>,
) {
  const cwd = await mkdtemp(join(tmpdir(), "kest-empty-response-"));
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      await request.json();
      const response = responses[Math.min(calls++, responses.length - 1)]!;
      const chunk = {
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        usage: { prompt_tokens: 10, completion_tokens: 1 },
        choices: [
          { index: 0, delta: response.delta, finish_reason: response.finish },
        ],
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
        {
          headers: { "Content-Type": "text/event-stream", Connection: "close" },
        },
      );
    },
  });
  const agent = new Agent(cwd, async () => true);
  agent.connectionOverride = {
    provider: "fixture",
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    apiKey: "fixture-only",
    model: "fixture",
  };
  const runtime = new CompanyRuntime(newCompany("Recover provider responses"));
  agent.useCompany(runtime, 0);
  const events: AgentEvent[] = [];
  try {
    await run(agent, events, runtime);
  } finally {
    server.stop(true);
    await agent.browser.close();
    await rm(cwd, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 25,
    });
  }
}

test("a plain turn emits no budget event and does not become research", async () => {
  await fixture(
    [{ delta: { content: "Hello!" }, finish: "stop" }],
    async (agent, events) => {
      await agent.run("hi", credentials, AbortSignal.timeout(5000), (event) =>
        events.push(event),
      );
      expect(events.some((e) => e.type === "budget")).toBe(false);
      expect(agent.research).toBeNull();
    },
  );
});

const credentials = { provider: "baseten" as const, apiKey: "unused" };
const empty = { delta: {}, finish: "stop" };

test("empty responses retry the same model step, account usage, and never replay completed tools", async () => {
  await fixture(
    [
      empty,
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "write",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: "result.txt",
                  content: "written once",
                }),
              },
            },
          ],
        },
        finish: "tool_calls",
      },
      { delta: { content: "   " }, finish: "length" },
      { delta: { content: "Recovered final answer" }, finish: "stop" },
    ],
    async (agent, events, runtime) => {
      await agent.run(
        "Perform the fixture task",
        credentials,
        AbortSignal.timeout(5000),
        (event) => events.push(event),
        2,
      );
      expect(runtime.state.requests).toBe(4);
      expect(events.filter((e) => e.type === "usage")).toHaveLength(4);
      expect(
        events.filter((e) => e.type === "tool" && e.state === "running"),
      ).toHaveLength(1);
      expect(await readFile(join(agent.cwd, "result.txt"), "utf8")).toBe(
        "written once",
      );
      expect(agent.messages.filter((m) => m.role === "assistant")).toHaveLength(
        2,
      );
      expect(agent.messages.at(-1)?.content).toBe("Recovered final answer");
    },
  );
});

test("time estimates prefer observed timings over tool defaults", () => {
  expect(estimateToolMs("read_file", [])).toBeLessThan(
    estimateToolMs("spawn_subagent", []),
  );
  expect(estimateToolMs("read_file", [100, 300, 200])).toBe(200);
  expect(estimateToolMs("shell", [10])).toBe(10);
});

test("independent read-only calls in one reply run concurrently and hook results back in call order", async () => {
  const call = (index: number, id: string, path: string) => ({
    index,
    id,
    type: "function",
    function: {
      name: "read_file",
      arguments: JSON.stringify({ path }),
    },
  });
  await fixture(
    [
      {
        delta: {
          tool_calls: [
            call(0, "read-a", "a.txt"),
            call(1, "read-b", "b.txt"),
            call(2, "read-c", "c.txt"),
          ],
        },
        finish: "tool_calls",
      },
      { delta: { content: "All three files read" }, finish: "stop" },
    ],
    async (agent, events) => {
      await writeFile(join(agent.cwd, "a.txt"), "alpha");
      await writeFile(join(agent.cwd, "b.txt"), "beta");
      await writeFile(join(agent.cwd, "c.txt"), "gamma");
      await agent.run(
        "Read the three fixture files",
        credentials,
        AbortSignal.timeout(5000),
        (event) => events.push(event),
        2,
      );
      const toolEvents = events.filter((e) => e.type === "tool");
      // Every call starts before any finishes: one long read cannot block the others.
      expect(toolEvents.slice(0, 3).every((e) => e.state === "running")).toBe(
        true,
      );
      expect(
        toolEvents
          .slice(0, 3)
          .every((e) => e.type === "tool" && e.estimatedMs !== undefined),
      ).toBe(true);
      const results = agent.messages.filter((m) => m.role === "tool");
      expect(results.map((m) => m.tool_call_id)).toEqual([
        "read-a",
        "read-b",
        "read-c",
      ]);
      expect(results.map((m) => String(m.content))).toEqual([
        expect.stringContaining("alpha"),
        expect.stringContaining("beta"),
        expect.stringContaining("gamma"),
      ]);
      expect(agent.messages.at(-1)?.content).toBe("All three files read");
    },
  );
});

test("persistent empty responses stop after three counted attempts without adding invalid assistant messages", async () => {
  await fixture([empty], async (agent, events, runtime) => {
    await expect(
      agent.run(
        "Fixture task",
        credentials,
        AbortSignal.timeout(5000),
        (event) => events.push(event),
      ),
    ).rejects.toThrow("after 3 attempts");
    expect(runtime.state.requests).toBe(3);
    expect(events.filter((e) => e.type === "usage")).toHaveLength(3);
    expect(agent.messages.filter((m) => m.role === "assistant")).toHaveLength(
      0,
    );
  });
});

test("provider filtering is reported without automatic retries", async () => {
  await fixture(
    [{ delta: {}, finish: "content_filter" }],
    async (agent, events, runtime) => {
      await expect(
        agent.run(
          "Fixture task",
          credentials,
          AbortSignal.timeout(5000),
          (event) => events.push(event),
        ),
      ).rejects.toThrow("filtered");
      expect(runtime.state.requests).toBe(1);
    },
  );
});

test("empty-response retries cannot overrun a shared research cost budget", async () => {
  await fixture([empty], async (agent, events, runtime) => {
    runtime.state.maxCostUsd = 1;
    runtime.state.spentCostMicros = 1_000_000;
    runtime.state.costRates[JSON.stringify(["fixture", "fixture"])] = {
      input: 1,
      output: 1,
    };
    agent.research = runtime.state;
    await agent.run(
      "Fixture task",
      credentials,
      AbortSignal.timeout(5000),
      (event) => events.push(event),
    );
    expect(runtime.state.requests).toBe(0);
    expect(agent.messages.at(-1)?.content).toContain(
      "Research cost budget reached",
    );
  });
});

test("direction queued while a run is busy is delivered before the next model round", async () => {
  await fixture(
    [{ delta: { content: "Understood." }, finish: "stop" }],
    async (agent, events) => {
      agent.pendingNotes.push("drop approach B", "focus on recall");
      await agent.run("go", credentials, AbortSignal.timeout(5000), (event) =>
        events.push(event),
      );
      const note = agent.messages.find(
        (m) =>
          m.role === "user" &&
          String(m.content).includes("User direction received"),
      );
      expect(String(note?.content)).toContain("drop approach B");
      expect(String(note?.content)).toContain("focus on recall");
      expect(agent.pendingNotes).toHaveLength(0);
    },
  );
});
