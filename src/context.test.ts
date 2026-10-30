import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type Message } from "./agent";
import {
  newContext,
  planCompaction,
  commitCompaction,
  contextReport,
  formatContext,
  MEMORY_PREFIX,
  observationExcerpt,
} from "./context";
import { newSession, saveSession, listSessions } from "./sessions";

const credentials = {
  provider: "baseten" as const,
  apiKey: "test-only-no-network",
};

test("observation excerpts respect byte limits without splitting Unicode evidence", () => {
  const output = "測定値🙂".repeat(1000);
  const excerpt = observationExcerpt(
    output,
    1000,
    "events.jsonl, toolCallId example",
  );
  expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(1000);
  expect(excerpt).not.toContain("\uFFFD");
  expect(excerpt).toContain("Observation excerpt");
  expect(observationExcerpt("Small complete result", 1000, "journal")).toBe(
    "Small complete result",
  );
});
const summary =
  "Objective: improve context management. Keep TypeScript. Completed src/example.ts; tests passed. Next: verify session persistence. Do not delete user changes.";
function history(): Message[] {
  return [
    {
      role: "system",
      content: "Original instructions: preserve user changes.",
    },
    { role: "user", content: "Use TypeScript and preserve my work." },
    { role: "assistant", content: "Prior investigation. ".repeat(2200) },
    { role: "user", content: "Keep the useful decisions." },
    { role: "assistant", content: "Further findings. ".repeat(200) },
    { role: "user", content: "Latest exact request." },
  ];
}
function assertCompleteGroups(messages: Message[]) {
  for (const m of messages)
    if (m.role === "assistant")
      for (const c of m.tool_calls ?? [])
        expect(
          messages.some((r) => r.role === "tool" && r.tool_call_id === c.id),
        ).toBe(true);
}
test("compaction keeps instructions/recent turns, creates memory and archives originals", () => {
  const messages = history();
  const state = newContext();
  const plan = planCompaction(messages, [], state, true)!;
  const compacted = commitCompaction(plan, summary, [], state);
  expect(compacted[0]).toEqual(messages[0]);
  expect(compacted.at(-1)).toEqual(messages.at(-1));
  expect(
    compacted.some(
      (m) =>
        typeof m.content === "string" && m.content.startsWith(MEMORY_PREFIX),
    ),
  ).toBe(true);
  expect(state.archive).toEqual(plan.removed);
  expect(state.compactions).toBe(1);
  expect(contextReport(compacted, [], state).input).toBeLessThan(plan.before);
  expect(formatContext(compacted, [], state)).toContain(
    "not a model tokenizer",
  );
});
test("long single-turn work compacts only complete tool batches and preserves its user request", () => {
  const messages: Message[] = [
    { role: "system", content: "Instructions" },
    { role: "user", content: "Finish this exact task." },
  ];
  for (let i = 0; i < 8; i++) {
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: ["a", "b"].map((s) => ({
        id: `${s}${i}`,
        type: "function" as const,
        function: { name: "read_file", arguments: "{}" },
      })),
    });
    for (const s of ["a", "b"])
      messages.push({
        role: "tool",
        tool_call_id: `${s}${i}`,
        content: "file content ".repeat(1000),
      });
  }
  const state = newContext();
  const plan = planCompaction(messages, [], state, true)!;
  const result = commitCompaction(plan, summary, [], state);
  expect(
    result.some(
      (m) => m.role === "user" && m.content === "Finish this exact task.",
    ),
  ).toBe(true);
  assertCompleteGroups(result);
  assertCompleteGroups(state.archive);
});
test("oversized final completed tool batch can be archived without an extra model reply", () => {
  const messages: Message[] = [
    { role: "system", content: "Keep evidence." },
    { role: "user", content: "Continue this research." },
    {
      role: "assistant",
      content: null,
      tool_calls: ["read", "search"].map((id) => ({
        id,
        type: "function" as const,
        function: { name: "read_file", arguments: "{}" },
      })),
    },
    { role: "tool", tool_call_id: "read", content: "log entry ".repeat(4000) },
    {
      role: "tool",
      tool_call_id: "search",
      content: "search result ".repeat(3000),
    },
  ];
  const state = newContext();
  const plan = planCompaction(messages, [], state)!;
  expect(plan).not.toBeNull();
  const compacted = commitCompaction(
    plan,
    "Logs inspected; original evidence is archived. Continue reviewing the study.",
    [],
    state,
  );
  expect(compacted.at(-1)).toEqual(messages[1]);
  expect(compacted.some((m) => m.role === "tool")).toBe(false);
  expect(contextReport(compacted, [], state).input + 4096).toBeLessThan(
    contextReport(compacted, [], state).budget,
  );
  assertCompleteGroups(state.archive);
  expect(state.archive).toHaveLength(3);
});

test("short history stays untouched; invalid summaries cannot discard history", () => {
  const short: Message[] = [{ role: "user", content: "Hello" }];
  expect(planCompaction(short, [], newContext(), true)).toBeNull();
  const state = newContext();
  const plan = planCompaction(history(), [], state, true)!;
  expect(() => commitCompaction(plan, "", [], state)).toThrow();
  expect(state.archive).toHaveLength(0);
  expect(state.compactions).toBe(0);
});
test("agent summary receives plan and memory; API failures and cancellation preserve history", async () => {
  const agent = new Agent(process.cwd(), async () => false, history());
  const before = JSON.stringify(agent.messages);
  agent.summarizeContext = async () => {
    throw new Error("Provider unavailable");
  };
  await expect(
    agent.compactContext(
      credentials,
      new AbortController().signal,
      () => {},
      true,
    ),
  ).rejects.toThrow("unavailable");
  expect(JSON.stringify(agent.messages)).toBe(before);
  expect(agent.context.archive).toHaveLength(0);
  const controller = new AbortController();
  agent.summarizeContext = async () => {
    controller.abort();
    return summary;
  };
  await expect(
    agent.compactContext(credentials, controller.signal, () => {}, true),
  ).rejects.toThrow();
  expect(JSON.stringify(agent.messages)).toBe(before);
  agent.tasks = [{ id: "1", title: "Verify persistence", status: "doing" }];
  agent.summarizeContext = async (source) => {
    expect(source).toContain("Verify persistence");
    expect(source).toContain("Latest exact request");
    return summary;
  };
  expect(
    await agent.compactContext(
      credentials,
      new AbortController().signal,
      () => {},
      true,
    ),
  ).toBe(true);
  expect(agent.context.summary).toBe(summary);
});

test("automatic compaction triggers from the configured budget, including tool definitions", () => {
  const previous = process.env.KEST_CONTEXT_BUDGET;
  try {
    process.env.KEST_CONTEXT_BUDGET = "12000";
    const state = newContext();
    const messages = history();
    expect(planCompaction(messages, [], state)).not.toBeNull();
    const report = contextReport(
      messages,
      [{ description: "tool description".repeat(100) }],
      state,
    );
    expect(report.tools).toBeGreaterThan(100);
    expect(report.budget).toBe(12000);
    process.env.KEST_CONTEXT_BUDGET = "invalid";
    expect(contextReport(messages, [], state).budget).toBe(20000);
  } finally {
    if (previous === undefined) delete process.env.KEST_CONTEXT_BUDGET;
    else process.env.KEST_CONTEXT_BUDGET = previous;
  }
});
test("truncated summaries retry with bounded extra output and preserve every original before committing", async () => {
  const outputs: number[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as any;
      outputs.push(body.max_tokens);
      expect(body.reasoning_effort).toBe("low");
      return Response.json({
        id: "fixture",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: outputs.length === 1 ? "Partial, incomplete" : summary,
            },
            finish_reason: outputs.length === 1 ? "length" : "stop",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      });
    },
  });
  const agent = new Agent(process.cwd(), async () => false, history());
  agent.connectionOverride = {
    provider: "fixture",
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    apiKey: "fixture",
    model: "fixture",
  };
  try {
    expect(
      await agent.compactContext(
        credentials,
        AbortSignal.timeout(5000),
        () => {},
        true,
      ),
    ).toBe(true);
    expect(outputs).toEqual([4096, 8192]);
    expect(agent.context.summary).toBe(summary);
    expect(agent.context.archive.length).toBeGreaterThan(0);
  } finally {
    server.stop(true);
  }
});

test("failed automatic summaries use labeled excerpts and the agent continues its original run", async () => {
  const messages = history();
  messages[2] = {
    role: "assistant",
    content: "Observed prior investigation. ".repeat(10000),
  };
  let summaryCalls = 0,
    continued = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as any;
      if (!body.stream) {
        summaryCalls++;
        return Response.json({
          id: "fixture",
          object: "chat.completion",
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Truncated partial summary",
              },
              finish_reason: "length",
            },
          ],
        });
      }
      continued = true;
      const chunk = {
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            delta: { content: "Continued the original task after compaction." },
            finish_reason: "stop",
          },
        ],
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  const agent = new Agent(process.cwd(), async () => false, messages);
  agent.connectionOverride = {
    provider: "fixture",
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    apiKey: "fixture",
    model: "fixture",
  };
  try {
    await agent.run(
      "Keep investigating the original task.",
      credentials,
      AbortSignal.timeout(5000),
      () => {},
    );
    expect(summaryCalls).toBe(2);
    expect(continued).toBe(true);
    expect(agent.context.summary).toContain("LOCAL EXTRACTIVE FALLBACK");
    expect(
      agent.context.archive.some(
        (m) => typeof m.content === "string" && m.content.length > 100000,
      ),
    ).toBe(true);
    expect(agent.messages.at(-1)?.content).toContain(
      "Continued the original task",
    );
  } finally {
    server.stop(true);
  }
});

test("a hung summary has a bounded timeout, preserves originals, and cleans its status heartbeat", async () => {
  const previous = process.env.KEST_SUMMARY_TIMEOUT_MS;
  process.env.KEST_SUMMARY_TIMEOUT_MS = "50";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      await Bun.sleep(500);
      return Response.json({ choices: [] });
    },
  });
  const agent = new Agent(process.cwd(), async () => false, history());
  agent.connectionOverride = {
    provider: "fixture",
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    apiKey: "fixture",
    model: "fixture",
  };
  const before = JSON.stringify(agent.messages);
  const started = performance.now();
  const events: unknown[] = [];
  try {
    await expect(
      agent.compactContext(
        credentials,
        AbortSignal.timeout(5000),
        (event) => events.push(event),
        true,
      ),
    ).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(1500);
    expect(JSON.stringify(agent.messages)).toBe(before);
    expect(agent.context.compactions).toBe(0);
    const count = events.length;
    await Bun.sleep(1100);
    expect(events).toHaveLength(count);
  } finally {
    if (previous === undefined) delete process.env.KEST_SUMMARY_TIMEOUT_MS;
    else process.env.KEST_SUMMARY_TIMEOUT_MS = previous;
    server.stop(true);
  }
});

test("summary and archive persist through saving/resuming sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kest-context-"));
  const previous = process.env.KEST_CONFIG_DIR;
  process.env.KEST_CONFIG_DIR = directory;
  try {
    const agent = new Agent(process.cwd(), async () => false, history());
    agent.summarizeContext = async () => summary;
    await agent.compactContext(
      credentials,
      new AbortController().signal,
      () => {},
      true,
    );
    const session = newSession(process.cwd(), agent.messages);
    session.context = agent.context;
    await saveSession(session);
    const saved = (await listSessions(process.cwd()))[0]!;
    const resumed = new Agent(
      process.cwd(),
      async () => false,
      saved.messages,
      null,
      undefined,
      saved.context,
    );
    expect(resumed.context.summary).toBe(summary);
    expect(resumed.context.archive).toEqual(agent.context.archive);
    expect(resumed.context.compactions).toBe(1);
    expect(resumed.messages).toEqual(agent.messages);
  } finally {
    if (previous === undefined) delete process.env.KEST_CONFIG_DIR;
    else process.env.KEST_CONFIG_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
