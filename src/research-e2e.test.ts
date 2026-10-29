import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "./agent";
import { listWorkerRecords, workerTranscript } from "./research-workers";
import {
  CompanyRuntime,
  newCompany,
  recoverCompany,
  replaceCheckpoint,
} from "./research-company";

test("checkpoint replacement retries transient Windows denials without deleting the old state", async () => {
  let attempts = 0;
  await replaceCheckpoint("new", "old", async () => {
    if (++attempts < 4)
      throw Object.assign(new Error("operation not permitted"), {
        code: "EPERM",
      });
  });
  expect(attempts).toBe(4);
  await expect(
    replaceCheckpoint("new", "old", async () => {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    }),
  ).rejects.toThrow("disk full");
});

test("a failed journal write does not poison later checkpoints", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kest-journal-recover-"));
  const runtime = new CompanyRuntime(newCompany("Recover logging"), cwd);
  try {
    await writeFile(join(cwd, "research"), "temporarily obstructed");
    await expect(runtime.record("failed", {})).rejects.toThrow();
    await rm(join(cwd, "research"));
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        runtime.record("recovered", { index }),
      ),
    );
    const lines = (
      await readFile(join(runtime.directory!, "events.jsonl"), "utf8")
    )
      .trim()
      .split("\n");
    expect(lines).toHaveLength(100);
    expect(
      JSON.parse(await readFile(join(runtime.directory!, "state.json"), "utf8"))
        .id,
    ).toBe(runtime.state.id);
    expect(
      (await readdir(runtime.directory!)).some((name) => name.endsWith(".tmp")),
    ).toBe(false);
  } finally {
    await rm(cwd, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 25,
    });
  }
});

test("cancelling a parallel research team stops requests and leaves a resumable checkpoint", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kest-research-cancel-"));
  const state = newCompany("Cancel a live team");
  const controller = new AbortController();
  let workers = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as any;
      const delegated = body.messages.some(
        (m: any) =>
          typeof m.content === "string" &&
          m.content.startsWith("You are a delegated"),
      );
      if (delegated) {
        workers++;
        if (workers === 3) setTimeout(() => controller.abort(), 20);
        await Bun.sleep(300);
      }
      const delta = delegated
        ? { content: "Late worker result" }
        : {
            tool_calls: [
              {
                index: 0,
                id: "team",
                type: "function",
                function: {
                  name: "research_team",
                  arguments: JSON.stringify({
                    tasks: [1, 2, 3].map((n) => ({
                      task: `Inspect evidence ${n}`,
                    })),
                  }),
                },
              },
            ],
          };
      return new Response(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: delegated ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
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
    await expect(
      agent.run(
        state.objective,
        { provider: "baseten", apiKey: "unused" },
        AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        () => {},
      ),
    ).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true);
    expect(workers).toBe(3);
    expect(state.requests).toBe(4);
    const saved = JSON.parse(
      await readFile(join(cwd, "research", state.id, "state.json"), "utf8"),
    );
    expect(saved.status).toBe("paused");
    expect(saved.requests).toBe(4);
  } finally {
    controller.abort();
    server.stop(true);
    await agent.browser.close();
    await rm(cwd, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 25,
    });
  }
});

test("the research deadline interrupts a pending provider request and saves its budget", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kest-research-deadline-"));
  const state = newCompany("Stop when time expires");
  state.maxMs = 1000;
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      calls++;
      await Bun.sleep(1500);
      return new Response("data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
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
      state.objective,
      { provider: "baseten", apiKey: "unused" },
      AbortSignal.timeout(5000),
      () => {},
    );
    expect(calls).toBe(1);
    expect(state.status).toBe("budget_exhausted");
    expect(String(agent.messages.at(-1)?.content)).toContain(
      "Research budget reached",
    );
    expect(
      JSON.parse(
        await readFile(join(cwd, "research", state.id, "state.json"), "utf8"),
      ).requests,
    ).toBe(1);
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
}, 10000);

test("time exhaustion checkpoints gracefully after the last tool without claiming completion", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kest-research-budget-"));
  const state = newCompany("Preserve partial findings");
  // 300ms of time left: first call + its tool run, next call is blocked.
  state.elapsedMs = state.maxMs - 300;
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++;
      const chunk = {
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "write",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({
                      path: "partial.md",
                      content: "Partial finding only.",
                    }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  const agent = new Agent(cwd, async () => true);
  agent.research = state;
  agent.connectionOverride = {
    provider: "fixture",
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    apiKey: "fixture",
    model: "fixture",
  };
  try {
    await agent.run(
      state.objective,
      { provider: "baseten", apiKey: "unused" },
      AbortSignal.timeout(5000),
      () => {},
    );
    expect(calls).toBeGreaterThan(0);
    expect(state.status).toBe("budget_exhausted");
    expect(await readFile(join(cwd, "partial.md"), "utf8")).toBe(
      "Partial finding only.",
    );
    expect(String(agent.messages.at(-1)?.content)).toContain("not a claim");
    expect(
      JSON.parse(
        await readFile(join(cwd, "research", state.id, "state.json"), "utf8"),
      ).requests,
    ).toBe(calls);
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
});

test("persistent research executes parallel teams, real experiments, review, paper and resume end to end", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kest-research-e2e-"));
  const state = newCompany(
    "Test the research workflow using a deterministic arithmetic experiment; make no indexing claims.",
  );
  state.maxRequests = 50;
  const directory = `research/${state.id}`;
  const raw = `${directory}/raw.json`;
  const paper = `${directory}/paper.md`;
  let directorCalls = 0,
    activeWorkers = 0,
    peakWorkers = 0,
    experimentRuns = 0;
  const errors: string[] = [];
  const tool = (name: string, args: unknown) => ({
    tool_calls: [
      {
        index: 0,
        id: crypto.randomUUID(),
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as any;
      const last = body.messages.at(-1);
      const delegated = body.messages.find(
        (m: any) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.startsWith("You are a delegated"),
      );
      let delta: any;
      if (delegated) {
        const isReviewer = delegated.content.startsWith(
          "You are a delegated reviewer",
        );
        const alreadyRead = body.messages.some((m: any) => m.role === "tool");
        if (!alreadyRead) {
          if (!isReviewer) {
            activeWorkers++;
            peakWorkers = Math.max(peakWorkers, activeWorkers);
            // Keep requests overlapping so this catches serialized delegation.
            await Bun.sleep(100);
            activeWorkers--;
          }
          delta = tool("read_file", { path: raw });
        } else {
          const evidence = body.messages.findLast(
            (m: any) => m.role === "tool",
          ).content;
          if (!String(evidence).includes('"sum":45'))
            errors.push("Worker did not receive real experiment evidence");
          delta = {
            content: isReviewer
              ? "Reviewed raw.json: sum=45 is correct for integers 0..9. This is a workflow smoke experiment, not database performance evidence. No novelty or throughput claim is supported."
              : "Inspected raw.json: arithmetic correctness is supported; database performance remains untested.",
          };
        }
      } else {
        const call = directorCalls++;
        const reviewed = body.messages.some(
          (m: any) =>
            typeof m.content === "string" &&
            m.content.startsWith("Review-board findings"),
        );
        const paperWritten = body.messages.some(
          (m: any) =>
            m.role === "assistant" &&
            m.tool_calls?.some(
              (t: any) =>
                t.function.name === "write_file" &&
                JSON.parse(t.function.arguments).path === paper,
            ),
        );
        if (reviewed && !paperWritten) {
          delta = tool("write_file", {
            path: paper,
            content:
              "# Research workflow smoke study\n\nMethods: Bun computes sum of integers 0..9 and writes raw.json.\n\nObserved result: sum=45; correctness checked by three parallel researchers. Independent review inspected the raw file.\n\nLimitations: this is an orchestration test. No indexing algorithm, novelty, or performance improvement is established.\n\nReproduce: bun run experiment.ts\n",
          });
        } else if (reviewed) {
          delta = {
            content:
              "Research checkpoint: paper.md and raw.json preserved. Review reconciled. No database performance claim.",
          };
        } else if (call === 0) {
          delta = tool("set_plan", {
            tasks: [
              "Run deterministic experiment",
              "Parallel evidence inspection",
              "Independent review and paper",
            ].map((title) => ({ title })),
          });
        } else if (call === 1) {
          delta = tool("write_file", {
            path: "experiment.ts",
            content: `await Bun.write(${JSON.stringify(raw)}, JSON.stringify({sum: Array.from({length:10}, (_,i)=>i).reduce((a,b)=>a+b,0)})); console.log("experiment passed");`,
          });
        } else if (call === 2 || (call > 3 && last?.role !== "tool")) {
          experimentRuns++;
          delta = tool("shell", {
            command:
              'const p = Bun.spawn([process.execPath, "run", "experiment.ts"], {stdout:"pipe", stderr:"pipe"}); console.log(await new Response(p.stdout).text()); if (await p.exited) throw new Error("Experiment failed");',
            timeout_ms: 10000,
          });
        } else if (call === 3) {
          delta = tool("research_team", {
            tasks: ["a", "b", "c"].map((model) => ({
              task: "Inspect the arithmetic evidence",
              model,
              toolset: "read-only",
            })),
          });
        } else {
          delta = {
            content:
              "Interim negative finding: arithmetic smoke test is correct, but no indexing benchmark was run. Continue justified workflow testing.",
          };
        }
      }
      const chunk = {
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            delta,
            finish_reason: delta.tool_calls ? "tool_calls" : "stop",
          },
        ],
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  const connection = {
    provider: "fixture",
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    apiKey: "fixture-only",
    model: "director",
  };
  const createAgent = () => {
    const agent = new Agent(cwd, async () => true);
    agent.research = state;
    agent.connectionOverride = connection;
    return agent;
  };
  const agent = createAgent();
  try {
    const events: any[] = [];
    await agent.run(
      state.objective,
      { provider: "baseten", apiKey: "unused" },
      AbortSignal.timeout(30000),
      (event) => events.push(event),
    );
    expect(peakWorkers).toBe(3);
    expect(errors).toEqual([]);
    expect(experimentRuns).toBeGreaterThan(5);
    expect(state.cycles).toBeGreaterThan(5);
    expect(state.requests).toBeGreaterThan(35);
    expect(state.requests).toBeLessThanOrEqual(50);
    expect(state.reviews).toBe(1);
    expect(
      events.filter((e) => e.type === "tool" && e.state === "error"),
    ).toEqual([]);
    expect(JSON.parse(await readFile(join(cwd, raw), "utf8"))).toEqual({
      sum: 45,
    });
    expect(await readFile(join(cwd, paper), "utf8")).toContain(
      "No indexing algorithm",
    );
    const entries = (
      await readFile(join(cwd, directory, "events.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries.filter((e) => e.kind === "model_request")).toHaveLength(
      state.requests,
    );
    expect(entries.filter((e) => e.kind === "delegate_result")).toHaveLength(4);
    const records = await listWorkerRecords(cwd, state.id);
    expect(records).toHaveLength(4);
    expect(records.every((record) => record.state === "done")).toBe(true);
    expect(records.filter((record) => record.role === "reviewer")).toHaveLength(
      1,
    );
    expect(workerTranscript(records[0]!)).toContain("read_file");
    expect(workerTranscript(records[0]!)).toContain('"sum":45');
    expect(
      events.filter((event) => event.type === "checkpoint").length,
    ).toBeGreaterThan(5);
    expect(
      events.some(
        (event) =>
          event.type === "worker" &&
          event.event?.type === "tool" &&
          event.event.name === "read_file",
      ),
    ).toBe(true);
    expect(entries.at(-1).kind).toBe("checkpoint");
    const consumed = state.requests;
    const stale = { ...state, requests: 0, agents: 0, cycles: 0, reviews: 0 };
    await recoverCompany(cwd, stale);
    expect(stale.requests).toBe(consumed);
    const resumed = new Agent(
      cwd,
      async () => true,
      structuredClone(agent.messages),
      null,
      undefined,
      structuredClone(agent.context),
    );
    stale.maxRequests += 16;
    resumed.research = stale;
    resumed.connectionOverride = connection;
    try {
      await resumed.run(
        "Resume the same workflow study",
        { provider: "baseten", apiKey: "unused" },
        AbortSignal.timeout(30000),
        () => {},
      );
      expect(stale.requests).toBeGreaterThan(consumed);
      expect(stale.requests).toBeLessThanOrEqual(stale.maxRequests);
      expect(stale.reviews).toBe(2);
    } finally {
      await resumed.browser.close();
    }
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
}, 60000);
