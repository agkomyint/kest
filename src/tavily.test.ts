import { beforeEach, afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TavilyTools,
  tavilyKey,
  saveTavilyKey,
  tavilyRequest,
  tavilyCapabilities,
} from "./tavily";
import { Agent } from "./agent";
import { WorkspaceTools } from "./tools";

let directory: string;
let previousDir: string | undefined;
let previousKey: string | undefined;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "kest-tavily-"));
  previousDir = process.env.KEST_CONFIG_DIR;
  previousKey = process.env.TAVILY_API_KEY;
  process.env.KEST_CONFIG_DIR = directory;
  delete process.env.TAVILY_API_KEY;
});
afterEach(async () => {
  if (previousDir === undefined) delete process.env.KEST_CONFIG_DIR;
  else process.env.KEST_CONFIG_DIR = previousDir;
  if (previousKey === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = previousKey;
  await rm(directory, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;

test("saved Tavily keys are separate from model credentials; tools follow worker scopes", async () => {
  expect(tavilyKey()).toBeNull();
  process.env.TAVILY_API_KEY = "tvly-environment-fixture";
  expect(tavilyKey()).toBe("tvly-environment-fixture");
  await saveTavilyKey("tvly-saved-fixture");
  expect(tavilyKey()).toBe("tvly-saved-fixture");
  expect(
    JSON.parse(await readFile(join(directory, "tavily.json"), "utf8")).apiKey,
  ).toBe("tvly-saved-fixture");
  const agent = new Agent(directory, async () => false);
  const names = () =>
    agent
      .toolDefs()
      .flatMap((tool) =>
        tool.type === "function" ? [tool.function.name] : [],
      );
  for (const [name] of tavilyCapabilities) expect(names()).toContain(name);
  agent.toolScope = "read-only";
  expect(names().some((name) => name.startsWith("tavily_"))).toBe(false);
  agent.toolScope = "research";
  for (const [name] of tavilyCapabilities) expect(names()).toContain(name);
  expect(names()).not.toContain("shell");
  expect(JSON.stringify(agent.toolDefs())).not.toContain("tvly-saved-fixture");
});

test("all endpoint requests use bounded defaults and reject unsafe or unsupported input", () => {
  expect(
    tavilyRequest("tavily_search", { query: "indexing algorithms" }).body,
  ).toMatchObject({
    max_results: 5,
    search_depth: "basic",
    include_usage: true,
    auto_parameters: false,
  });
  expect(
    tavilyRequest("tavily_crawl", { url: "https://example.com" }).body,
  ).toMatchObject({ limit: 10, max_depth: 1, allow_external: false });
  expect(
    tavilyRequest("tavily_research", { input: "Compare two papers" }).body,
  ).toMatchObject({ model: "mini", stream: false });
  expect(
    tavilyRequest("tavily_research_status", { request_id: "task-123" }),
  ).toMatchObject({ method: "GET", path: "research/task-123" });
  for (const args of [
    { url: "file:///secret" },
    { url: "https://user:secret@example.com" },
    { url: "https://example.com", limit: 1000 },
    { url: "https://example.com", allow_external: true },
  ])
    expect(() => tavilyRequest("tavily_map", args)).toThrow();
  expect(() =>
    tavilyRequest("tavily_search", { query: "sources", api_key: "forbidden" }),
  ).toThrow();
  expect(() =>
    tavilyRequest("tavily_research_status", { request_id: "../usage" }),
  ).toThrow();
  expect(() => tavilyRequest("tavily_extract", { urls: [] })).toThrow();
});

test("approved requests preserve source URLs and usage while keys stay out of previews and results", async () => {
  const requests: {
    url: string;
    method?: string;
    body?: string;
    authorization: string | null;
  }[] = [];
  const previews: string[] = [];
  const tools = new TavilyTools(
    async (request) => {
      previews.push(request.preview);
      expect(request.kind).toBe("web");
      return true;
    },
    {
      key: () => "tvly-private-fixture",
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method,
          body: init?.body as string,
          authorization: new Headers(init?.headers).get("Authorization"),
        });
        return Response.json({
          request_id: "task-123",
          results: [
            {
              url: "https://example.com/paper",
              content: "Measured source text",
              reflected: "tvly-private-fixture",
            },
          ],
          usage: { credits: 1 },
        });
      },
    },
  );
  const output = await tools.execute(
    "tavily_search",
    { query: "verified baselines" },
    signal(),
  );
  expect(requests[0]?.authorization).toBe("Bearer tvly-private-fixture");
  expect(requests[0]?.url).toBe("https://api.tavily.com/search");
  expect(requests[0]?.body).not.toContain("tvly-private-fixture");
  expect(previews.join("")).not.toContain("tvly-private-fixture");
  expect(output).toContain("https://example.com/paper");
  expect(output).toContain('"credits":1');
  expect(output).not.toContain("tvly-private-fixture");
  expect(output).toContain("[redacted]");
  await tools.execute(
    "tavily_research_status",
    { request_id: "task-123" },
    signal(),
  );
  expect(previews).toHaveLength(1);
  expect(requests[1]?.method).toBe("GET");
  expect(requests[1]?.body).toBeUndefined();
  for (const [name, args, path] of [
    ["tavily_extract", { urls: ["https://example.com/paper"] }, "extract"],
    ["tavily_map", { url: "https://example.com" }, "map"],
    ["tavily_crawl", { url: "https://example.com" }, "crawl"],
    ["tavily_research", { input: "Compare published evidence" }, "research"],
  ] as const) {
    await tools.execute(name, args, signal());
    expect(requests.at(-1)?.url).toBe(`https://api.tavily.com/${path}`);
    expect(requests.at(-1)?.method).toBe("POST");
  }
  expect(previews).toHaveLength(5);
});

test("missing keys, rejected approvals, and cancellation never dispatch a request", async () => {
  let dispatched = 0;
  const transport = async () => {
    dispatched++;
    return Response.json({});
  };
  const missing = new TavilyTools(async () => true, {
    key: () => null,
    fetch: transport,
  });
  await expect(
    missing.execute("tavily_search", { query: "sources" }, signal()),
  ).rejects.toThrow("/connect tavily");
  const denied = new TavilyTools(async () => false, {
    key: () => "fixture",
    fetch: transport,
  });
  expect(
    await denied.execute("tavily_search", { query: "sources" }, signal()),
  ).toContain("Denied");
  const controller = new AbortController();
  controller.abort();
  await expect(
    denied.execute("tavily_search", { query: "sources" }, controller.signal),
  ).rejects.toThrow();
  expect(dispatched).toBe(0);
});

test("credit failures and transport failures do not retry paid tasks or expose provider error bodies", async () => {
  for (const status of [401, 429, 432, 500]) {
    let calls = 0;
    const tools = new TavilyTools(async () => true, {
      key: () => "fixture",
      fetch: async () => {
        calls++;
        return new Response("private-provider-body", { status });
      },
    });
    let failure: unknown;
    try {
      await tools.execute(
        "tavily_research",
        { input: "A bounded question" },
        signal(),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain("private-provider-body");
    expect(calls).toBe(1);
  }
  let calls = 0;
  const tools = new TavilyTools(async () => true, {
    key: () => "fixture",
    fetch: async () => {
      calls++;
      throw new Error("fixture socket reset");
    },
  });
  await expect(
    tools.execute("tavily_research", { input: "A bounded question" }, signal()),
  ).rejects.toThrow("remote research task may still exist");
  expect(calls).toBe(1);
});

test("Tavily environment credentials are excluded from the script subprocess", async () => {
  process.env.TAVILY_API_KEY = "tvly-subprocess-fixture";
  const tools = new WorkspaceTools(directory, async () => true);
  try {
    expect(
      await tools.execute(
        "shell",
        JSON.stringify({
          command: "console.log(process.env.TAVILY_API_KEY ?? 'not-inherited')",
        }),
        signal(),
      ),
    ).toContain("not-inherited");
  } finally {
    await tools.disposeShell();
  }
});
