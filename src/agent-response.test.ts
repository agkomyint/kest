import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentEvent } from "./agent";
import { CompanyRuntime, newCompany } from "./research-company";

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

test("empty-response retries cannot overrun a research request budget", async () => {
  await fixture([empty], async (agent, events, runtime) => {
    runtime.state.maxRequests = 1;
    agent.research = runtime.state;
    await agent.run(
      "Fixture task",
      credentials,
      AbortSignal.timeout(5000),
      (event) => events.push(event),
    );
    expect(runtime.state.requests).toBe(1);
    expect(agent.messages.at(-1)?.content).toContain("Research budget reached");
  });
});
