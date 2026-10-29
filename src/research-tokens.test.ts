import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CompanyRuntime,
  newCompany,
  parseTokenBudget,
  recoverCompany,
  validateCompany,
} from "./research-company";
import { Agent } from "./agent";

test("token totals accept large human-readable values and migrate old checkpoints", () => {
  expect(parseTokenBudget("500b")).toBe(500_000_000_000);
  expect(parseTokenBudget("1.5m")).toBe(1_500_000);
  expect(parseTokenBudget("500,000")).toBe(500_000);
  for (const value of ["-1", "0", "infinite", "999999999999999999999b"])
    expect(() => parseTokenBudget(value)).toThrow();
  const legacy = { ...newCompany("Legacy") } as any;
  legacy.requests = 7;
  delete legacy.untrackedRequests;
  delete legacy.maxTokens;
  delete legacy.inputTokens;
  delete legacy.outputTokens;
  delete legacy.estimatedTokens;
  expect(validateCompany(legacy).maxTokens).toBeNull();
  expect(legacy.inputTokens).toBe(0);
  expect(legacy.untrackedRequests).toBe(7);
});

test("parallel reservations cannot spend the same token headroom and missing usage is estimated", async () => {
  const state = newCompany("Concurrent tokens");
  state.maxTokens = 1000;
  const runtime = new CompanyRuntime(state);
  const first = await runtime.acquire(
    "fixture",
    "a",
    AbortSignal.timeout(5000),
    undefined,
    { input: 400, output: 200 },
  );
  let dispatched = false;
  const second = runtime
    .acquire("fixture", "b", AbortSignal.timeout(5000), undefined, {
      input: 400,
      output: 200,
    })
    .then((release) => {
      dispatched = true;
      return release;
    });
  await Bun.sleep(30);
  expect(dispatched).toBe(false);
  expect(state.requests).toBe(1);
  first({ input: 100, output: 50 });
  const release = await second;
  expect(state.requests).toBe(2);
  release(); // Provider omitted usage: charge the entire reservation.
  expect(state.inputTokens).toBe(100);
  expect(state.outputTokens).toBe(50);
  expect(state.estimatedTokens).toBe(600);
  expect(runtime.remainingTokens).toBe(250);
  await expect(
    runtime.acquire("fixture", "c", AbortSignal.timeout(1000), undefined, {
      input: 200,
      output: 100,
    }),
  ).rejects.toThrow("token budget");
  expect(state.requests).toBe(2);
  release({ input: 100, output: 100 }); // Idempotent release, no double count.
  expect(runtime.usedTokens).toBe(750);
});

test("token counters persist, and a larger total extends rather than resets consumption", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kest-token-recovery-"));
  const state = newCompany("Persist tokens");
  state.maxTokens = 1000;
  const stale = structuredClone(state);
  try {
    const runtime = new CompanyRuntime(state, cwd);
    const release = await runtime.acquire(
      "fixture",
      "a",
      AbortSignal.timeout(5000),
      undefined,
      { input: 100, output: 100 },
    );
    release({ input: 90, output: 80 });
    await runtime.finish("paused");
    stale.maxTokens = 2000;
    await recoverCompany(cwd, stale);
    expect(stale.maxTokens).toBe(2000);
    expect(stale.inputTokens + stale.outputTokens).toBe(170);
  } finally {
    await rm(cwd, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 25,
    });
  }
});

test("in-flight token reservations survive a crash before provider usage arrives", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kest-token-crash-"));
  const state = newCompany("Crash accounting");
  state.maxTokens = 1000;
  const stale = structuredClone(state);
  try {
    await new CompanyRuntime(state, cwd).acquire(
      "fixture",
      "worker",
      AbortSignal.timeout(5000),
      undefined,
      { input: 400, output: 200 },
    );
    await recoverCompany(cwd, stale);
    expect(stale.estimatedTokens).toBe(600);
    expect(new CompanyRuntime(stale).remainingTokens).toBe(400);
    expect(stale.requests).toBe(1);
  } finally {
    await rm(cwd, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 25,
    });
  }
});

test("research workers preserve director experiment budget while reviewers can use the review reserve", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kest-director-reserve-"));
  const state = newCompany("Implementation reserve");
  state.requests = 70;
  const runtime = new CompanyRuntime(state, cwd);
  try {
    await expect(
      runtime.acquire("fixture", "worker", AbortSignal.timeout(5000), {
        id: "worker",
        depth: 1,
      }),
    ).rejects.toThrow("director implementation");
    const release = await runtime.acquire(
      "fixture",
      "reviewer",
      AbortSignal.timeout(5000),
      { id: "reviewer", depth: 1, role: "reviewer" },
    );
    release();
    expect(state.requests).toBe(71);
  } finally {
    await rm(cwd, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 25,
    });
  }
});

test("context summary requests contribute actual input/output to the research token budget", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kest-token-summary-"));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return Response.json({
        id: "fixture",
        object: "chat.completion",
        created: 1,
        model: "fixture",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Observed facts only." },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 },
      });
    },
  });
  const agent = new Agent(cwd, async () => false);
  agent.research = newCompany("Count summaries");
  agent.research.maxTokens = 100000;
  agent.connectionOverride = {
    provider: "fixture",
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    apiKey: "fixture",
    model: "fixture",
  };
  try {
    await agent.summarizeContext(
      "Observed conversation",
      { provider: "baseten", apiKey: "unused" },
      AbortSignal.timeout(5000),
      () => {},
    );
    expect(agent.research.inputTokens).toBe(123);
    expect(agent.research.outputTokens).toBe(45);
    expect(agent.research.estimatedTokens).toBe(0);
  } finally {
    server.stop(true);
    await rm(cwd, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 25,
    });
  }
});
