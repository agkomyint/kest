import { afterAll, expect, test } from "bun:test";

import { Agent } from "./agent";

const prev = process.env.TAVILY_API_KEY;
process.env.TAVILY_API_KEY = "tvly-test";
afterAll(() => {
  if (prev === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = prev;
});

const names = (scope: "read-only" | "web" | "research") => {
  const a = new Agent(process.cwd(), async () => false);
  a.toolScope = scope;
  return a.toolDefs().map((t) => (t.type === "function" ? t.function.name : ""));
};

test("web workers get Tavily but no browser; only research workers get the browser", () => {
  expect(names("read-only")).not.toContain("tavily_search");
  expect(names("web")).toContain("tavily_search");
  expect(names("web")).not.toContain("browser");
  expect(names("research")).toContain("browser");
  expect(names("research")).toContain("tavily_search");
});
