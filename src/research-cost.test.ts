import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "./agent";
import {
  CompanyRuntime,
  costKey,
  newCompany,
  parseCostBudget,
  recoverCompany,
  validateCompany,
} from "./research-company";
import { NEBIUS_MODEL } from "./config";

function funded(usd = 0.01) {
  const state = newCompany("Cost accounting fixture");
  state.maxCostUsd = usd;
  for (const model of ["a", "b", "c", "worker", "reviewer", "fixture"])
    state.costRates[costKey("fixture", model)] = { input: 10, output: 20 };
  return state;
}

test("dollar totals parse explicitly and legacy sessions require a new allowance", () => {
  expect(parseCostBudget("10$")).toBe(10);
  expect(parseCostBudget("$10.50")).toBe(10.5);
  for (const value of [
    "10",
    "0$",
    "-1$",
    "$NaN",
    "10m",
    "10$ 32",
    "$0.001",
    "$1000001",
  ])
    expect(() => parseCostBudget(value)).toThrow();
  const state = newCompany("Legacy") as any;
  state.requests = 7;
  for (const key of [
    "maxCostUsd",
    "spentCostMicros",
    "estimatedCostMicros",
    "untrackedCostRequests",
    "costRates",
  ])
    delete state[key];
  expect(validateCompany(state).maxCostUsd).toBeNull();
  expect(state.untrackedCostRequests).toBe(7);
  expect(() => validateCompany({ ...state, spentCostMicros: NaN })).toThrow();
  expect(() =>
    validateCompany({
      ...state,
      costRates: { bad: { input: "1", output: 1 } },
    }),
  ).toThrow();
});

test("parallel calls reserve shared dollars and missing usage is charged conservatively", async () => {
  const state = funded();
  const runtime = new CompanyRuntime(state);
  const first = await runtime.acquire(
    "fixture",
    "a",
    AbortSignal.timeout(2000),
    undefined,
    { input: 400, output: 200 },
  );
  let dispatched = false;
  const second = runtime
    .acquire("fixture", "b", AbortSignal.timeout(2000), undefined, {
      input: 400,
      output: 200,
    })
    .then((release) => {
      dispatched = true;
      return release;
    });
  await Bun.sleep(20);
  expect(dispatched).toBe(false);
  expect(state.estimatedCostMicros).toBe(8000);
  first({ input: 100, output: 50 });
  const release = await second;
  release();
  expect(state.spentCostMicros).toBe(2000);
  expect(state.estimatedCostMicros).toBe(8000);
  expect(runtime.remainingCostMicros).toBe(0);
  await expect(
    runtime.acquire("fixture", "c", AbortSignal.timeout(500), undefined, {
      input: 1,
      output: 1,
    }),
  ).rejects.toThrow("cost budget");
  release({ input: 0, output: 0 });
  expect(state.spentCostMicros + state.estimatedCostMicros).toBe(10000);
  expect(state.requests).toBe(2);
});

test("persisted reservations survive crashes and extensions retain consumption and frozen rates", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kest-cost-recovery-"));
  const state = funded();
  const stale = structuredClone(state);
  try {
    const runtime = new CompanyRuntime(state, cwd);
    const release = await runtime.acquire(
      "fixture",
      "a",
      AbortSignal.timeout(2000),
      undefined,
      { input: 100, output: 100 },
    );
    await recoverCompany(cwd, stale);
    expect(stale.estimatedCostMicros).toBe(3000);
    release({ input: 90, output: 80 });
    await runtime.finish("paused");
    // The stale copy still holds the old in-flight charge. Reconciliation must
    // replace it, not add that reservation again to the settled amount.
    await recoverCompany(cwd, stale);
    expect(stale.estimatedCostMicros).toBe(0);
    expect(stale.spentCostMicros).toBe(2500);
    const resumed = structuredClone(state);
    resumed.maxCostUsd = 0.02;
    resumed.spentCostMicros = 0;
    await recoverCompany(cwd, resumed);
    expect(resumed.maxCostUsd).toBe(0.02);
    expect(resumed.spentCostMicros).toBe(2500);
    expect(new CompanyRuntime(resumed).remainingCostMicros).toBe(17500);
    expect(resumed.costRates[costKey("fixture", "a")]).toEqual({
      input: 10,
      output: 20,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("unknown pricing and missing dollar allowance block dispatch", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kest-cost-unknown-"));
  try {
    const state = newCompany("No allowance");
    const runtime = new CompanyRuntime(state, cwd);
    await expect(
      runtime.acquire(
        "nebius",
        NEBIUS_MODEL,
        AbortSignal.timeout(500),
        undefined,
        { input: 10, output: 10 },
      ),
    ).rejects.toThrow("Set a research budget");
    state.maxCostUsd = 1;
    await expect(
      runtime.acquire("custom", "m", AbortSignal.timeout(500), undefined, {
        input: 10,
        output: 10,
      }),
    ).rejects.toThrow("pricing is unknown");
    expect(state.requests).toBe(0);
    const release = await runtime.acquire(
      "nebius",
      NEBIUS_MODEL,
      AbortSignal.timeout(500),
      undefined,
      { input: 100, output: 100 },
    );
    release({ input: 100, output: 100 });
    expect(state.spentCostMicros).toBe(120);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workers preserve director and review funding; time and token caps no longer bind", async () => {
  const state = funded();
  state.spentCostMicros = 8000;
  state.elapsedMs = state.maxMs * 2;
  state.maxTokens = 1;
  state.inputTokens = 100000;
  const runtime = new CompanyRuntime(state);
  await expect(
    runtime.acquire(
      "fixture",
      "worker",
      AbortSignal.timeout(500),
      { id: "w", depth: 1 },
      { input: 10, output: 10 },
    ),
  ).rejects.toThrow("reserve protected");
  const release = await runtime.acquire(
    "fixture",
    "reviewer",
    AbortSignal.timeout(500),
    { id: "r", depth: 1, role: "reviewer" },
    { input: 10, output: 10 },
  );
  release({ input: 10, output: 10 });
  expect(state.spentCostMicros).toBe(8300);
});

test("budget exhaustion saves a funding proposal without granting more money", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kest-cost-proposal-"));
  const state = funded(10);
  const runtime = new CompanyRuntime(state, cwd);
  try {
    const proposal = await runtime.saveFundingProposal(
      "The next experiment does not fit.",
    );
    expect(proposal).toContain("/research budget 15.00$");
    expect(proposal).toContain("Would you like to increase");
    expect(
      await readFile(join(runtime.directory!, "funding-proposal.md"), "utf8"),
    ).toContain("Status: incomplete");
    expect(state.maxCostUsd).toBe(10);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("context summary calls charge actual input/output dollars", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kest-cost-summary-"));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json({
        id: "f",
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
      }),
  });
  const agent = new Agent(cwd, async () => false);
  agent.research = funded(1);
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
      AbortSignal.timeout(2000),
      () => {},
    );
    expect(agent.research.spentCostMicros).toBe(2130);
    expect(agent.research.estimatedCostMicros).toBe(0);
    expect(agent.research.inputTokens).toBe(123);
  } finally {
    server.stop(true);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a reviewed report completes early and stops spending without a funding proposal", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kest-cost-complete-"));
  const state = funded(1);
  const reportPath = `research/${state.id}/paper.md`;
  await mkdir(join(cwd, "research", state.id), { recursive: true });
  await writeFile(
    join(cwd, reportPath),
    "# Findings\nA local fixture report with explicit limitations.",
  );
  let directorCalls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as any;
      const reviewer = body.messages.some(
        (m: any) =>
          typeof m.content === "string" &&
          m.content.startsWith("You are a delegated reviewer"),
      );
      let delta: any = {
        content: "Reviewed fixture evidence; limitations are explicit.",
      };
      if (!reviewer) {
        const step = directorCalls++;
        if (step < 2)
          delta = {
            tool_calls: [
              {
                index: 0,
                id: `tool-${step}`,
                type: "function",
                function: {
                  name: step ? "research_complete" : "research_review",
                  arguments: JSON.stringify(
                    step
                      ? { reportPath }
                      : { task: "Review the saved report and limitations." },
                  ),
                },
              },
            ],
          };
        else delta = { content: "Study complete. See paper.md." };
      }
      return new Response(
        `data: ${JSON.stringify({ id: "f", object: "chat.completion.chunk", created: 1, model: "fixture", usage: { prompt_tokens: 100, completion_tokens: 50 }, choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  const agent = new Agent(cwd, async () => false);
  agent.research = state;
  agent.connectionOverride = {
    provider: "fixture",
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    apiKey: "fixture",
    model: "fixture",
  };
  try {
    await agent.run(
      "Complete the reviewed fixture",
      { provider: "baseten", apiKey: "unused" },
      AbortSignal.timeout(3000),
      () => {},
    );
    expect(directorCalls).toBe(2);
    expect(state.status).toBe("completed");
    expect(state.reviews).toBe(1);
    expect(state.spentCostMicros).toBe(6000);
    expect(state.fundingProposal).toBeUndefined();
    expect(
      await Bun.file(
        join(cwd, "research", state.id, "funding-proposal.md"),
      ).exists(),
    ).toBe(false);
    expect(agent.research?.status).toBe("completed");
  } finally {
    server.stop(true);
    await agent.browser.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
