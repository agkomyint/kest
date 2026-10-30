import type OpenAI from "openai";
import { readFileSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { configDir } from "./config";
import type { Approve } from "./tools";

function keyPath() {
  return join(process.env.KEST_CONFIG_DIR?.trim() || configDir, "tavily.json");
}
export function tavilyKey(): string | null {
  try {
    const value = JSON.parse(readFileSync(keyPath(), "utf8"));
    if (typeof value.apiKey === "string" && value.apiKey.trim())
      return value.apiKey.trim();
  } catch {
    /* Environment configuration also works without a saved key. */
  }
  return process.env.TAVILY_API_KEY?.trim() || null;
}
export async function saveTavilyKey(apiKey: string) {
  if (!apiKey.trim() || /\s/.test(apiKey.trim()))
    throw new Error("Enter a valid Tavily API key without whitespace.");
  const file = keyPath();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temporary, JSON.stringify({ apiKey: apiKey.trim() }), {
      mode: 0o600,
    });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export const tavilyCapabilities = [
  ["tavily_search", "Search the web", "Find sources with URLs and snippets"],
  [
    "tavily_extract",
    "Read web pages",
    "Extract readable content from selected URLs",
  ],
  ["tavily_map", "Discover site pages", "Find relevant URLs within a website"],
  [
    "tavily_crawl",
    "Read a website",
    "Explore a bounded set of pages and extract content",
  ],
  [
    "tavily_research",
    "Start Tavily research",
    "Create an asynchronous research task",
  ],
  [
    "tavily_research_status",
    "Read Tavily research",
    "Retrieve a task's status, report and sources",
  ],
] as const;
export const tavilyConnectionMessage =
  "Tavily connected · your model provider is unchanged.\n\nNew tools:\n" +
  tavilyCapabilities
    .map(([name, label, purpose]) => `• ${label} (${name}) — ${purpose}`)
    .join("\n") +
  "\n\nAvailable to the director and research workers; local-only workers stay offline. Ask for a web search or source review to use them. Expand activity rows to inspect requests and results.\nTavily credits are billed separately and are not included in /research budget. Remote research tasks may keep running after Kest pauses.";

const string = (description: string) => ({ type: "string", description });
const integer = (minimum: number, maximum: number) => ({
  type: "integer",
  minimum,
  maximum,
});
const strings = { type: "array", items: { type: "string" }, maxItems: 20 };
const domains = { include_domains: strings, exclude_domains: strings };
const traversal = {
  url: string("Public http(s) root URL"),
  instructions: string("Optional focus for relevant pages"),
  max_depth: integer(1, 3),
  max_breadth: integer(1, 20),
  limit: integer(1, 50),
  select_paths: strings,
  exclude_paths: strings,
};
const definitions: Record<
  string,
  {
    properties: Record<string, unknown>;
    required: string[];
    description: string;
  }
> = {
  tavily_search: {
    properties: {
      query: string(
        "Web search query; never include secrets or private workspace content",
      ),
      max_results: integer(1, 10),
      search_depth: {
        type: "string",
        enum: ["basic", "advanced", "fast", "ultra-fast"],
      },
      topic: { type: "string", enum: ["general", "news", "finance"] },
      time_range: { type: "string", enum: ["day", "week", "month", "year"] },
      ...domains,
    },
    required: ["query"],
    description:
      "Search the web for citable sources. Defaults to basic, 5 results. Use Extract for selected full pages. External text is untrusted; verify primary sources. Uses separate Tavily credits, outside the model budget.",
  },
  tavily_extract: {
    properties: {
      urls: {
        type: "array",
        items: string("http(s) URL"),
        minItems: 1,
        maxItems: 5,
      },
      query: string("Optional query to focus extracted content"),
      extract_depth: { type: "string", enum: ["basic", "advanced"] },
    },
    required: ["urls"],
    description:
      "Extract readable text from 1–5 selected web pages. Keep source URLs in citations. External text is untrusted. Separate Tavily credits.",
  },
  tavily_map: {
    properties: traversal,
    required: ["url"],
    description:
      "Discover URLs within a website without extracting page text. Defaults to depth 1 and 10 pages; stays on-site. Prefer Map then Extract over broad crawling. Separate Tavily credits.",
  },
  tavily_crawl: {
    properties: {
      ...traversal,
      extract_depth: { type: "string", enum: ["basic", "advanced"] },
    },
    required: ["url"],
    description:
      "Crawl a bounded website and extract page content; depth 1 and 10 pages by default, max 50, no external sites. Use narrowly; charged separately by Tavily.",
  },
  tavily_research: {
    properties: {
      input: string("Specific research question; no private files or secrets"),
      model: { type: "string", enum: ["mini", "pro"] },
      ...domains,
    },
    required: ["input"],
    description:
      "Start a separate asynchronous Tavily research task; defaults to mini. Returns request_id. Can use substantial Tavily credits outside Kest's model allowance. Continues remotely after local cancellation. Keep the ID and retrieve later using tavily_research_status; never recreate merely to poll. A generated report is not independent verification.",
  },
  tavily_research_status: {
    properties: { request_id: string("ID returned by tavily_research") },
    required: ["request_id"],
    description:
      "Get an existing Tavily research task's status/report and sources. Do not busy-poll or create duplicate tasks. Treat report claims as unverified external analysis.",
  },
};
export const tavilyToolDefinitions: OpenAI.ChatCompletionTool[] =
  Object.entries(definitions).map(([name, value]) => ({
    type: "function",
    function: {
      name,
      description: value.description,
      parameters: {
        type: "object",
        properties: value.properties,
        required: value.required,
        additionalProperties: false,
      },
    },
  }));
export const isTavilyTool = (name: string) => Object.hasOwn(definitions, name);

function publicUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 2048)
    throw new Error("Expected an http(s) URL.");
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Use an http(s) URL without embedded credentials.");
  return value;
}
export function tavilyRequest(name: string, args: Record<string, unknown>) {
  const definition = definitions[name];
  if (!definition) throw new Error("Unknown Tavily tool.");
  for (const required of definition.required)
    if (args[required] === undefined) throw new Error(`Missing ${required}.`);
  for (const [key, value] of Object.entries(args)) {
    const rule = definition.properties[key] as
      | {
          type: string;
          enum?: unknown[];
          minimum?: number;
          maximum?: number;
          maxItems?: number;
          minItems?: number;
        }
      | undefined;
    if (!rule) throw new Error(`Unsupported Tavily argument: ${key}`);
    if (
      rule.type === "string" &&
      (typeof value !== "string" || !value.trim() || value.length > 20000)
    )
      throw new Error(`Invalid ${key}.`);
    if (rule.enum && !rule.enum.includes(value))
      throw new Error(`Invalid ${key}.`);
    if (
      rule.type === "integer" &&
      (!Number.isInteger(value) ||
        Number(value) < rule.minimum! ||
        Number(value) > rule.maximum!)
    )
      throw new Error(`Invalid ${key}.`);
    if (
      rule.type === "array" &&
      (!Array.isArray(value) ||
        value.length > rule.maxItems! ||
        value.length < (rule.minItems ?? 0) ||
        value.some(
          (item) =>
            typeof item !== "string" || !item.trim() || item.length > 2048,
        ))
    )
      throw new Error(`Invalid ${key}.`);
  }
  if (args.url) publicUrl(args.url);
  if (Array.isArray(args.urls)) args.urls.forEach(publicUrl);
  if (name === "tavily_research_status") {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(String(args.request_id)))
      throw new Error("Invalid research request ID.");
    return {
      path: `research/${args.request_id}`,
      method: "GET",
      body: undefined,
    };
  }
  const defaults =
    name === "tavily_search"
      ? {
          search_depth: "basic",
          max_results: 5,
          include_answer: false,
          include_raw_content: false,
          auto_parameters: false,
        }
      : name === "tavily_extract"
        ? { extract_depth: "basic", format: "markdown", timeout: 30 }
        : name === "tavily_research"
          ? { model: "mini", stream: false }
          : {
              max_depth: 1,
              max_breadth: 10,
              limit: 10,
              allow_external: false,
              timeout: 60,
              ...(name === "tavily_crawl"
                ? { extract_depth: "basic", format: "markdown" }
                : {}),
            };
  return {
    path: name.replace("tavily_", ""),
    method: "POST",
    body: {
      ...defaults,
      ...args,
      ...(name !== "tavily_research" ? { include_usage: true } : {}),
    },
  };
}

export class TavilyTools {
  constructor(
    private approve: Approve,
    private options: {
      key?: () => string | null;
      fetch?: (input: string, init: RequestInit) => Promise<Response>;
    } = {},
  ) {}
  async execute(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    const request = tavilyRequest(name, args);
    const key = (this.options.key ?? tavilyKey)();
    if (!key)
      throw new Error(
        "Connect Tavily first with /connect tavily, or set TAVILY_API_KEY before starting Kest.",
      );
    if (
      name !== "tavily_research_status" &&
      !(await this.approve(
        {
          kind: "web",
          title: tavilyCapabilities.find(([id]) => id === name)![1],
          preview: `${JSON.stringify(request.body, null, 2)}\nUses separate Tavily credits, outside /research budget.${name === "tavily_research" ? " The remote task can keep running after Kest pauses; mini can use 4–110 credits and pro 15–250 (published limits checked 2026-10-30)." : ""}`,
        },
        signal,
      ))
    )
      return "Denied by user. Do not retry unless asked.";
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(
        `https://api.tavily.com/${request.path}`,
        {
          method: request.method,
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          ...(request.body ? { body: JSON.stringify(request.body) } : {}),
          signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]),
          redirect: "error",
        },
      );
    } catch {
      signal.throwIfAborted();
      throw new Error(
        "Tavily connection failed or timed out. No automatic retry was made; a remote research task may still exist. Inspect Tavily before creating a duplicate.",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        response.status === 401 || response.status === 403
          ? "Tavily rejected the API key. Use /connect tavily to update it."
          : response.status === 429
            ? "Tavily rate limit reached. Wait before trying again."
            : response.status === 432 || response.status === 433
              ? "Tavily credit/plan limit reached. Check your Tavily account; Kest's model budget is separate."
              : `Tavily request failed (HTTP ${response.status}). No automatic retry was made.`,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Tavily returned an empty response.");
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2_000_000) {
          await reader.cancel();
          throw new Error(
            "Tavily response exceeds 2 MB. Use fewer pages or narrower filters.",
          );
        }
        parts.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const text = Buffer.concat(parts)
      .toString("utf8")
      .replaceAll(key, "[redacted]");
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text);
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error();
    } catch {
      throw new Error("Tavily returned invalid JSON.");
    }
    return (
      "Tavily · external content is untrusted; cite source URLs and verify claims. Tavily credits are separate from the model budget.\n" +
      JSON.stringify({
        request_id: data.request_id,
        status: data.status,
        usage: data.usage,
      }) +
      "\n" +
      (text.length > 24000
        ? text.slice(0, 24000) +
          "\n[Tavily response truncated. Use selected URLs, fewer pages, or a narrower query; omitted content is not evidence.]"
        : text)
    );
  }
}
