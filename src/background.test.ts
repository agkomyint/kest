import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentEvent } from "./agent";
import { newCompany, recoverCompany } from "./research-company";

const credentials = { provider: "baseten" as const, apiKey: "unused" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("background spawn returns immediately, then wakes the agent with the result", async () => {
  const agent = new Agent(process.cwd(), async () => true);
  const gate = deferred<string>();
  agent.runChild = () => gate.promise;
  const wakes: string[] = [];
  agent.onBackground = () => wakes.push(...agent.takeBackgroundWakeups());

  const started = performance.now();
  const out = await agent.executeSpawn(
    JSON.stringify({ task: "Survey prior work", background: true }),
    credentials,
    new AbortController().signal,
    () => {},
  );
  expect(performance.now() - started).toBeLessThan(500);
  expect(out).toContain("Background task");
  expect(out).toContain("started");
  expect(agent.backgroundStatus()).toContain("running");

  gate.resolve("survey findings");
  await agent.waitForBackground();
  expect(wakes).toHaveLength(1);
  expect(wakes[0]).toContain("Background wake-up");
  expect(wakes[0]).toContain("survey findings");
  // A wake-up is delivered once; it is not replayed on every later turn.
  expect(agent.takeBackgroundWakeups()).toEqual([]);
  expect(agent.backgroundStatus()).toContain("done");
});

test("background failures wake the agent instead of vanishing", async () => {
  const agent = new Agent(process.cwd(), async () => true);
  agent.runChild = async () => {
    throw new Error("worker exploded");
  };
  await agent.executeSpawn(
    JSON.stringify({ task: "Fragile survey", background: true }),
    credentials,
    new AbortController().signal,
    () => {},
  );
  await agent.waitForBackground();
  const wakes = agent.takeBackgroundWakeups();
  expect(wakes).toHaveLength(1);
  expect(wakes[0]).toContain("failed");
  expect(wakes[0]).toContain("worker exploded");
});

test("background work is capped, cancellable, and unavailable to child agents", async () => {
  const agent = new Agent(process.cwd(), async () => true);
  // Like a real worker, this stub stops when its signal aborts.
  agent.runChild = (_task, _expected, _credentials, signal) =>
    new Promise<string>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error("Worker cancelled")),
        { once: true },
      );
    });
  for (let i = 0; i < 3; i++)
    await agent.executeSpawn(
      JSON.stringify({ task: `Survey ${i}`, background: true }),
      credentials,
      new AbortController().signal,
      () => {},
    );
  await expect(
    agent.executeSpawn(
      JSON.stringify({ task: "One too many", background: true }),
      credentials,
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow("already running");
  agent.cancelBackground();
  await agent.waitForBackground();
  expect(agent.backgroundStatus()).not.toContain("running");

  const child = new Agent(process.cwd(), async () => true);
  child.allowBackground = false;
  child.runChild = async () => "never";
  await expect(
    child.executeSpawn(
      JSON.stringify({ task: "Nested background", background: true }),
      credentials,
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow("only available to the director");
});

test("a cancelled background task does not wake the agent afterwards", async () => {
  const agent = new Agent(process.cwd(), async () => true);
  agent.runChild = (_task, _expected, _credentials, signal) =>
    new Promise<string>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error("Worker cancelled")),
        { once: true },
      );
    });
  await agent.executeSpawn(
    JSON.stringify({ task: "Long survey", background: true }),
    credentials,
    new AbortController().signal,
    () => {},
  );
  agent.cancelBackground();
  await agent.waitForBackground();
  expect(agent.hasRunningBackground()).toBe(false);
  // The user stopped it on purpose: no wake-up turn may follow.
  expect(agent.takeBackgroundWakeups()).toEqual([]);
  expect(agent.backgroundStatus()).toContain("error");
});

test("aborting a research run stops its background work and leaves a resumable paused checkpoint", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kest-research-stop-"));
  const state = newCompany("Stop and resume this study");
  state.maxCostUsd = 10;
  state.costRates[JSON.stringify(["fixture", "fixture"])] = {
    input: 1,
    output: 1,
  };
  const controller = new AbortController();
  let directorCalls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      await request.json();
      directorCalls++;
      const delta =
        directorCalls === 1
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "spawn-bg",
                  type: "function",
                  function: {
                    name: "spawn_subagent",
                    arguments: JSON.stringify({
                      task: "Survey prior work",
                      background: true,
                    }),
                  },
                },
              ],
            }
          : { content: "Director reply" };
      if (directorCalls === 2) await Bun.sleep(400);
      return new Response(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", usage: { prompt_tokens: 10, completion_tokens: 1 }, choices: [{ index: 0, delta, finish_reason: directorCalls === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
        {
          headers: { "Content-Type": "text/event-stream", Connection: "close" },
        },
      );
    },
  });
  const connection = {
    provider: "fixture",
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    apiKey: "fixture-only",
    model: "fixture",
  };
  const agent = new Agent(cwd, async () => true);
  agent.research = state;
  agent.connectionOverride = connection;
  agent.runChild = (_task, _expected, _credentials, signal) =>
    new Promise<string>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error("Worker cancelled")),
        { once: true },
      );
    });
  try {
    await expect(
      agent.run(state.objective, credentials, controller.signal, (event) => {
        if (event.type === "background" && event.state === "running")
          setTimeout(() => controller.abort(), 30);
      }),
    ).rejects.toThrow();
    await agent.waitForBackground();
    expect(agent.hasRunningBackground()).toBe(false);
    expect(agent.takeBackgroundWakeups()).toEqual([]);
    const saved = JSON.parse(
      await readFile(join(cwd, "research", state.id, "state.json"), "utf8"),
    );
    expect(saved.status).toBe("paused");
    expect(saved.requests).toBeGreaterThan(0);

    // Resume: consumed budget is recovered from the journal, never reset.
    const resumedState = { ...saved };
    await recoverCompany(cwd, resumedState);
    expect(resumedState.requests).toBe(saved.requests);
    const resumed = new Agent(cwd, async () => true);
    resumed.research = resumedState;
    resumed.connectionOverride = connection;
    try {
      // Requests are no longer capped; bound this fixture to one round.
      await resumed.run(
        "Resume the study",
        credentials,
        AbortSignal.timeout(5000),
        () => {},
        1,
      );
      expect(resumedState.requests).toBe(saved.requests + 1);
      expect(resumed.messages.some((m) => m.content === "Director reply")).toBe(
        true,
      );
    } finally {
      await resumed.browser.close();
    }
  } finally {
    controller.abort();
    server.stop(true);
    await agent.browser.close();
    await rm(cwd, { recursive: true, force: true, maxRetries: 10 });
  }
});

test("a finished background task is injected as a reminder into the next turn", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kest-background-wake-"));
  const responses: { delta: unknown; finish: string }[] = [
    {
      delta: {
        tool_calls: [
          {
            index: 0,
            id: "spawn-1",
            type: "function",
            function: {
              name: "spawn_subagent",
              arguments: JSON.stringify({
                task: "Survey prior work",
                background: true,
              }),
            },
          },
        ],
      },
      finish: "tool_calls",
    },
    { delta: { content: "Started it; doing other work." }, finish: "stop" },
    { delta: { content: "Integrated the survey." }, finish: "stop" },
  ];
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
  const gate = deferred<string>();
  agent.runChild = () => gate.promise;
  const events: AgentEvent[] = [];
  try {
    await agent.run(
      "Research this topic",
      credentials,
      AbortSignal.timeout(5000),
      (event) => events.push(event),
    );
    // The turn ended without waiting for the background worker.
    expect(agent.messages.at(-1)?.content).toBe(
      "Started it; doing other work.",
    );
    expect(
      events.some((e) => e.type === "background" && e.state === "running"),
    ).toBe(true);

    gate.resolve("survey findings");
    await agent.waitForBackground();
    await Bun.sleep(10);
    expect(
      events.some((e) => e.type === "background" && e.state === "done"),
    ).toBe(true);

    await agent.run(
      "Continue",
      credentials,
      AbortSignal.timeout(5000),
      (event) => events.push(event),
    );
    const userTurns = agent.messages
      .filter((m) => m.role === "user")
      .map((m) => String(m.content));
    const wakeTurn = userTurns.find((text) =>
      text.includes("Background wake-up"),
    );
    expect(wakeTurn).toContain("survey findings");
    expect(wakeTurn).toContain("Continue");
    expect(agent.messages.at(-1)?.content).toBe("Integrated the survey.");
  } finally {
    server.stop(true);
    await agent.browser.close();
    await rm(cwd, { recursive: true, force: true, maxRetries: 10 });
  }
});
