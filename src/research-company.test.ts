import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, systemPrompt } from "./agent";
import {
  newCompany,
  CompanyRuntime,
  recoverCompany,
  validateCompany,
} from "./research-company";

test("manual summaries reserve persisted project budget and cannot bypass its limit", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kest-company-summary-"));
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++;
      return Response.json({
        id: "fixture",
        object: "chat.completion",
        created: 1,
        model: "summary",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                "Only observed evidence is retained. No benchmark has been executed.",
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      });
    },
  });
  const agent = new Agent(cwd, async () => false);
  agent.research = newCompany("Summary accounting");
  agent.research.maxRequests = 1;
  agent.connectionOverride = {
    provider: "fixture",
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    apiKey: "fixture-only",
    model: "summary",
  };
  try {
    await agent.summarizeContext(
      "History",
      { provider: "baseten", apiKey: "unused" },
      new AbortController().signal,
      () => {},
    );
    expect(agent.research.requests).toBe(1);
    await expect(
      agent.summarizeContext(
        "History",
        { provider: "baseten", apiKey: "unused" },
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow("budget");
    expect(calls).toBe(1);
  } finally {
    server.stop(true);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a 13-to-12 request transition enters final review, even for long objectives", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kest-company-final-review-"));
  let reviewerCalls = 0,
    reconciled = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as any;
      const isReviewer = body.messages.some(
        (m: any) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.startsWith("You are a delegated reviewer"),
      );
      if (isReviewer) reviewerCalls++;
      else if (
        body.messages.some(
          (m: any) =>
            typeof m.content === "string" &&
            m.content.startsWith("Review-board findings"),
        )
      )
        reconciled = true;
      const content = isReviewer
        ? "Independent review: there is no benchmark evidence; no target or novelty claim is justified."
        : "No successful experiment is evidenced. Preserve this negative/inconclusive checkpoint.";
      const chunk = {
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta: { content }, finish_reason: "stop" }],
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  const agent = new Agent(cwd, async () => false);
  agent.research = newCompany("Long research objective. ".repeat(150));
  agent.research.maxRequests = 14;
  agent.connectionOverride = {
    provider: "fixture",
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    apiKey: "fixture-only",
    model: "fixture",
  };
  try {
    await agent.run(
      "Start the research fixture",
      { provider: "baseten", apiKey: "unused" },
      new AbortController().signal,
      () => {},
    );
    expect(reviewerCalls).toBe(1);
    expect(reconciled).toBe(true);
    expect(agent.research.reviews).toBe(1);
    expect(agent.research.requests).toBe(4);
  } finally {
    server.stop(true);
    await agent.browser.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("company request reservations enforce shared concurrency and hard request limits", async () => {
  const state = newCompany("Test budget");
  state.maxRequests = 5;
  state.parallel = 2;
  const runtime = new CompanyRuntime(state);
  let active = 0,
    peak = 0;
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, async () => {
      const release = await runtime.acquire(
        "fixture",
        "test",
        new AbortController().signal,
      );
      active++;
      peak = Math.max(peak, active);
      try {
        await Bun.sleep(8);
      } finally {
        active--;
        release();
      }
    }),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
  expect(state.requests).toBe(5);
  expect(peak).toBe(2);
  expect(() => runtime.addAgent(4)).toThrow("depth");
  state.agents = 11;
  expect(() => runtime.addAgent(1)).toThrow("agent budget");
  runtime.addAgent(1, true);
  expect(state.agents).toBe(12);
});

test("research checkpoints recover consumed budget without renewal, and reject unsafe state", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kest-company-state-"));
  try {
    const state = newCompany("Preserve evidence");
    const stale = structuredClone(state);
    const runtime = new CompanyRuntime(state, cwd);
    const release = await runtime.acquire(
      "fixture",
      "model-a",
      new AbortController().signal,
      { id: "worker-a", depth: 1 },
    );
    release();
    await runtime.finish("paused");
    await recoverCompany(cwd, stale);
    expect(stale.requests).toBe(1);
    const events = await readFile(
      join(cwd, "research", state.id, "events.jsonl"),
      "utf8",
    );
    expect(events).toContain("worker-a");
    expect(events).toContain("model_request");
    expect(() => validateCompany({ ...state, id: "../../escape" })).toThrow();
    expect(() => validateCompany({ ...state, parallel: 0 })).toThrow();
    expect(() => validateCompany({ ...state, maxRequests: NaN })).toThrow();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("company approvals serialize and expired or cancelled requests cannot dispatch", async () => {
  const runtime = new CompanyRuntime(newCompany("Approval queue"));
  let active = 0,
    peak = 0;
  const approve = async () => {
    active++;
    peak = Math.max(active, peak);
    await Bun.sleep(5);
    active--;
    return true;
  };
  await Promise.all(
    Array.from({ length: 3 }, () =>
      runtime.approve(
        approve,
        { title: "Browser", preview: "Navigate" },
        new AbortController().signal,
      ),
    ),
  );
  expect(peak).toBe(1);
  const expired = newCompany("Expired");
  expired.elapsedMs = expired.maxMs;
  await expect(
    new CompanyRuntime(expired).acquire(
      "fixture",
      "model",
      new AbortController().signal,
    ),
  ).rejects.toThrow("budget");
  const controller = new AbortController();
  controller.abort();
  await expect(
    runtime.acquire("fixture", "model", controller.signal),
  ).rejects.toThrow();
  expect(runtime.state.requests).toBe(0);
});

test("company prompt is refreshed once and research teams cannot expand read-only access", async () => {
  const agent = new Agent(process.cwd(), async () => false);
  agent.connectionOverride = {
    provider: "fixture",
    baseURL: "http://localhost:12345/v1",
    apiKey: "not-used",
    model: "parent-model",
  };
  const seen: string[] = [];
  agent.runChild = async (
    _task,
    _expected,
    _credentials,
    _signal,
    _emit,
    model,
    connection,
  ) => {
    seen.push(model);
    expect(connection?.model).toBe(model);
    return "No benchmark was executed.";
  };
  const result = JSON.parse(
    await agent.executeCompanyTool(
      "research_team",
      JSON.stringify({
        tasks: [
          { task: "Hypothesis", model: "model-a" },
          { task: "Critique", model: "model-b" },
        ],
      }),
      { provider: "baseten", apiKey: "unused" },
      new AbortController().signal,
      () => {},
    ),
  );
  expect(seen.sort()).toEqual(["model-a", "model-b"]);
  expect(agent.connectionOverride.model).toBe("parent-model");
  expect(result.every((r: any) => r.status === "returned")).toBe(true);
  agent.toolScope = "read-only";
  await expect(
    agent.executeSpawn(
      JSON.stringify({ task: "Escalate", toolset: "research" }),
      { provider: "baseten", apiKey: "unused" },
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow("cannot grant");
  expect(
    agent
      .toolDefs()
      .some(
        (t) =>
          t.type === "function" &&
          ["shell", "write_file", "edit_file", "browser"].includes(
            t.function.name,
          ),
      ),
  ).toBe(false);
  const resumed = new Agent(process.cwd(), async () => false, [
    { role: "system", content: systemPrompt(process.cwd()) },
  ]);
  const prompt = String(resumed.messages[0]!.content);
  expect(prompt.match(/<kest-research-company>/g)).toHaveLength(1);
  expect(prompt).toContain("REVIEW BOARD");
  expect(prompt).toContain("Never fabricate numbers");
});

test("actual nested model routing and shared request accounting work against a local API fixture", async () => {
  const state = newCompany("Fixture hierarchy");
  const runtime = new CompanyRuntime(state);
  const counts = new Map<string, number>();
  const observed: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as any;
      const model = body.model;
      observed.push(model);
      const count = counts.get(model) ?? 0;
      counts.set(model, count + 1);
      let delta: any = {
        content:
          "Evidence is incomplete; no performance or novelty claim is justified.",
      };
      let finish = "stop";
      if (model === "director" && !count) {
        delta = {
          tool_calls: [
            {
              index: 0,
              id: "lead",
              type: "function",
              function: {
                name: "spawn_subagent",
                arguments: JSON.stringify({
                  task: "Lead a local investigation",
                  role: "lead",
                  model: "lead-model",
                }),
              },
            },
            {
              index: 1,
              id: "review",
              type: "function",
              function: {
                name: "research_review",
                arguments: JSON.stringify({
                  task: "Independently review the evidence",
                  model: "review-model",
                }),
              },
            },
          ],
        };
        finish = "tool_calls";
      } else if (model === "lead-model" && !count) {
        delta = {
          tool_calls: [
            {
              index: 0,
              id: "team",
              type: "function",
              function: {
                name: "research_team",
                arguments: JSON.stringify({
                  tasks: [
                    { task: "Inspect local evidence", model: "worker-model" },
                  ],
                }),
              },
            },
          ],
        };
        finish = "tool_calls";
      }
      const chunk = {
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  const agent = new Agent(process.cwd(), async () => false);
  agent.connectionOverride = {
    provider: "fixture",
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    apiKey: "local-fixture-only",
    model: "director",
  };
  agent.useCompany(runtime, 0);
  try {
    await agent.run(
      "Research the supplied fixture without inventing results",
      { provider: "baseten", apiKey: "unused" },
      new AbortController().signal,
      () => {},
    );
    expect(observed).toContain("lead-model");
    expect(observed).toContain("worker-model");
    expect(observed).toContain("review-model");
    expect(state.requests).toBe(6);
    expect(state.agents).toBe(3);
    expect(state.reviews).toBe(1);
    expect(agent.connectionOverride.model).toBe("director");
  } finally {
    server.stop(true);
    await agent.browser.close();
  }
});
