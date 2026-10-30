import { expect, test } from "bun:test";
import { BrowserSession, browserRequest } from "./browser";
import { WorkspaceTools } from "./tools";
import { Agent } from "./agent";
import { CompanyRuntime, newCompany } from "./research-company";

const signal = () => new AbortController().signal;
test("browser requests reject invalid actions, URLs, and target indices", () => {
  for (const url of [
    "javascript:alert(1)",
    "file:///private.txt",
    "data:text/html,hello",
  ])
    expect(() => browserRequest({ action: "navigate", url })).toThrow();
  expect(() => browserRequest({ action: "unknown" })).toThrow();
  expect(() => browserRequest({ action: "click", index: -1 })).toThrow();
  expect(() => browserRequest({ action: "batch", steps: [] })).toThrow();
  expect(() =>
    browserRequest({
      action: "batch",
      steps: [{ action: "batch", steps: [] }],
    }),
  ).toThrow();
  expect(() =>
    browserRequest({
      action: "batch",
      steps: [{ action: "navigate", url: "file:///secret" }],
    }),
  ).toThrow();
  expect(() => browserRequest({ action: "open", detail: "unknown" })).toThrow();
});

test("browser permission denial prevents launch; read-only tabs do not launch", async () => {
  const browser = new BrowserSession({ headless: true });
  const tools = new WorkspaceTools(process.cwd(), async () => false, browser);
  expect(
    await tools.execute("browser", '{"action":"open"}', signal()),
  ).toContain("Denied");
  expect(await tools.execute("browser", '{"action":"tabs"}', signal())).toBe(
    "[]",
  );
  await expect(
    tools.execute("browser", '{"action":"snapshot"}', signal()),
  ).rejects.toThrow("not open");
  const controller = new AbortController();
  controller.abort();
  await expect(
    tools.execute("browser", '{"action":"open"}', controller.signal),
  ).rejects.toThrow();
  await browser.close();
});

// Native integration test uses the installed Chrome, without touching the normal user profile.
const hasChrome =
  process.platform === "win32" &&
  (await Bun.file(
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  ).exists());

test.skipIf(!hasChrome)(
  "parallel researchers share one browser, navigate their own tabs and close only their tabs",
  async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        return new Response(`<title>${path}</title><h1>Evidence ${path}</h1>`, {
          headers: { "Content-Type": "text/html" },
        });
      },
    });
    const root = new BrowserSession({ headless: true, channel: "chrome" });
    const workers = [root.fork(), root.fork(), root.fork()];
    const nested = workers[0]!.fork();
    const url = `http://127.0.0.1:${server.port}`;
    try {
      const observations = await Promise.all(
        workers.map((worker, i) =>
          worker
            .execute({ action: "open", url: `${url}/worker-${i}` }, signal())
            .then(JSON.parse),
        ),
      );
      const context = root["context"]!;
      expect(root["browser"]!.contexts()).toHaveLength(1);
      expect(context.pages()).toHaveLength(4); // Root tab plus three workers.
      workers.forEach((worker, i) => {
        expect(worker["context"]).toBe(context);
        expect(observations[i].url).toBe(`${url}/worker-${i}`);
      });
      await workers[1]!.execute(
        { action: "navigate", url: `${url}/changed` },
        signal(),
      );
      const first = JSON.parse(
        await workers[0]!.execute({ action: "tabs" }, signal()),
      );
      expect(first).toHaveLength(1);
      expect(first[0].url).toBe(`${url}/worker-0`);
      await workers[0]!.close();
      expect(context.pages()).toHaveLength(3);
      expect(
        JSON.parse(await workers[1]!.execute({ action: "snapshot" }, signal()))
          .url,
      ).toBe(`${url}/changed`);
      await nested.execute({ action: "open", url: `${url}/nested` }, signal());
      expect(nested["context"]).toBe(context);
      await nested.close();
      await Promise.all(workers.map((worker) => worker.close()));
      expect(context.pages()).toHaveLength(1);
      const launched = root["browser"]!;
      await root.close();
      expect(launched.isConnected()).toBe(false);
      expect(await nested.execute({ action: "tabs" }, signal())).toBe("[]");
    } finally {
      await root.close();
      server.stop(true);
    }
  },
  30000,
);

test.skipIf(!hasChrome)(
  "actual research_team browser workers reuse the director browser and release their tabs",
  async () => {
    let directorCalls = 0;
    const inspected = new Set<string>();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (request.method !== "POST")
          return new Response(
            "<title>Evidence</title><h1>Local research evidence</h1>",
            { headers: { "Content-Type": "text/html" } },
          );
        const body = (await request.json()) as any;
        const delegated = body.messages.some(
          (m: any) =>
            typeof m.content === "string" &&
            m.content.startsWith("You are a delegated"),
        );
        let delta: any;
        const call = (name: string, args: unknown) => ({
          tool_calls: [
            {
              index: 0,
              id: crypto.randomUUID(),
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        });
        if (delegated) {
          const result = body.messages.findLast((m: any) => m.role === "tool");
          if (!result)
            delta = call("browser", {
              action: "open",
              url: `http://127.0.0.1:${server.port}/${body.model}`,
            });
          else {
            if (result.content.includes("Local research evidence"))
              inspected.add(body.model);
            delta = { content: "Inspected local research evidence." };
          }
        } else if (!directorCalls++)
          delta = call("research_team", {
            tasks: ["one", "two", "three"].map((model) => ({
              task: "Inspect local evidence",
              model,
              toolset: "research",
            })),
          });
        else delta = { content: "Team evidence collected." };
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
    const browser = new BrowserSession({ headless: true, channel: "chrome" });
    const agent = new Agent(
      process.cwd(),
      async () => true,
      undefined,
      null,
      browser,
    );
    agent.connectionOverride = {
      provider: "fixture",
      baseURL: `http://127.0.0.1:${server.port}/v1`,
      apiKey: "fixture",
      model: "director",
    };
    // Research tools require an explicit company assignment; a plain chat turn
    // deliberately does not expose research_team.
    agent.useCompany(
      new CompanyRuntime(newCompany("Browser research fixture")),
      0,
    );
    try {
      await agent.run(
        "Inspect evidence in parallel",
        { provider: "baseten", apiKey: "unused" },
        AbortSignal.timeout(20000),
        () => {},
      );
      expect(inspected.size).toBe(3);
      expect(browser["browser"]!.contexts()).toHaveLength(1);
      expect(browser["context"]!.pages()).toHaveLength(1);
    } finally {
      await browser.close();
      server.stop(true);
    }
  },
  30000,
);

test.skipIf(!hasChrome)(
  "expected-destination clicks return on DOM readiness while slow images are still pending",
  async () => {
    let release!: () => void;
    const imageGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/next")
          return Response.redirect(new URL("/destination", request.url).href);
        if (path === "/image") {
          await imageGate;
          return new Response("image");
        }
        return new Response(
          path === "/destination"
            ? '<title>Next page</title><h1>Destination ready</h1><img src="/image">'
            : '<a href="/next">Next</a>',
          { headers: { "Content-Type": "text/html" } },
        );
      },
    });
    const browser = new BrowserSession({ headless: true, channel: "chrome" });
    const url = `http://127.0.0.1:${server.port}`;
    try {
      await browser.execute({ action: "open", url }, signal());
      const result = JSON.parse(
        await browser.execute(
          { action: "click", role: "link", name: "Next", url: url + "/next" },
          signal(),
        ),
      );
      expect(result.title).toBe("Next page");
      expect(result.url).toContain("/destination");
      expect(result.snapshot).toContain("Destination ready");
      expect(result.readyState).toBe("interactive");
    } finally {
      release();
      await browser.close();
      server.stop(true);
    }
  },
  15_000,
);
test.skipIf(!hasChrome)(
  "one browser retains tabs and supports typing, clicking, switching, closing, and reopening",
  async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          `<!doctype html><title>Kest browser fixture</title><h1>Browser test</h1><label>Name<input id="name"></label><button onclick="document.querySelector('output').textContent=document.querySelector('input').value">Save</button><output></output><form action="/result"><label>Search<input name="q"></label></form>`,
          { headers: { "Content-Type": "text/html" } },
        ),
    });
    const browser = new BrowserSession({ headless: true, channel: "chrome" });
    const run = async (args: Record<string, unknown>) =>
      browser.execute(browserRequest(args), signal());
    const url = `http://127.0.0.1:${server.port}/`;
    try {
      const opened = JSON.parse(await run({ action: "open", url }));
      expect(opened.title).toBe("Kest browser fixture");
      expect(opened.snapshot).toContain("Name");
      const first = opened.tab;
      const second = JSON.parse(await run({ action: "new_tab", url })).tab;
      expect(JSON.parse(await run({ action: "tabs" }))).toHaveLength(2);
      expect(first).not.toBe(second);
      await run({ action: "switch", tab: first });
      await run({
        action: "fill",
        role: "textbox",
        name: "Name",
        value: "Kest",
      });
      expect(
        await run({ action: "click", role: "button", name: "Save" }),
      ).toContain("Kest");
      expect(
        JSON.parse(await run({ action: "snapshot", tab: second })).snapshot,
      ).not.toContain('"Kest"');

      const batch = JSON.parse(
        await run({
          action: "batch",
          steps: [
            { action: "fill", selector: "#name", value: "Batched result" },
            { action: "click", role: "button", name: "Save" },
          ],
        }),
      );
      expect(batch.completed).toHaveLength(2);
      expect(batch.snapshot).toContain("Batched result");
      expect(
        batch.completed.every(
          (step: { timing: { observeMs: number } }) =>
            step.timing.observeMs === 0,
        ),
      ).toBe(true);
      const ack = JSON.parse(
        await run({
          action: "fill",
          selector: "#name",
          value: "Quick acknowledgment",
          detail: "none",
        }),
      );
      expect(ack.completed).toBe(true);
      expect(ack.snapshot).toBeUndefined();
      expect(ack.timing.observeMs).toBe(0);
      const parent = new Agent(
        process.cwd(),
        async () => true,
        undefined,
        null,
        browser,
      );
      const replacement = new Agent(
        process.cwd(),
        async () => true,
        parent.messages,
        null,
        browser,
      );
      expect(
        JSON.parse(
          await replacement.browser.execute({ action: "tabs" }, signal()),
        ),
      ).toHaveLength(2);
      await run({ action: "close_tab", tab: first });
      expect(JSON.parse(await run({ action: "tabs" }))).toHaveLength(1);
      await browser.close();
      expect(JSON.parse(await run({ action: "tabs" }))).toHaveLength(0);
      expect(JSON.parse(await run({ action: "open", url })).title).toBe(
        "Kest browser fixture",
      );
    } finally {
      await browser.close();
      server.stop(true);
    }
  },
  30_000,
);
