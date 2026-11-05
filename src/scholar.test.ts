import { expect, test } from "bun:test";
import { ScholarTools, compactScholar, openAlexAbstract, scholarArgs, scholarUrl } from "./scholar";

test("rebuilds an OpenAlex abstract in order", () => {
  expect(openAlexAbstract({ world: [1], hello: [0], again: [2] })).toBe("hello world again");
});

test("validates arguments", () => {
  expect(() => scholarArgs({ query: "" })).toThrow();
  expect(() => scholarArgs({ query: "x", extra: 1 })).toThrow();
  expect(scholarArgs({ query: " x " }).max_results).toBe(5);
});

test("builds urls and adds optional keys only from env", () => {
  const a = scholarArgs({ query: "graphene", from_year: 2020 });
  expect(scholarUrl(a, {}).searchParams.get("api_key")).toBeNull();
  expect(scholarUrl(a, { OPENALEX_API_KEY: "k" }).searchParams.get("api_key")).toBe("k");
  const c = scholarArgs({ query: "graphene", source: "crossref" });
  expect(scholarUrl(c, { CROSSREF_MAILTO: "a@b.c" }).searchParams.get("mailto")).toBe("a@b.c");
  expect(scholarUrl(c, {}).searchParams.get("mailto")).toBeNull();
});

test("compacts crossref and strips jats", () => {
  const out = JSON.parse(compactScholar("crossref", { message: { items: [{ title: ["T"], DOI: "10/x", abstract: "<jats:p>Hi  there</jats:p>", author: [{ given: "A", family: "B" }] }] } }));
  expect(out.results[0]).toMatchObject({ title: "T", doi: "https://doi.org/10/x", abstract: "Hi there", authors: "A B" });
});

test("retries once on 429 then returns results, and flags duplicates", async () => {
  let n = 0;
  const fetch = async () =>
    n++ === 0
      ? new Response("", { status: 429, headers: { "retry-after": "0" } })
      : new Response(JSON.stringify({ meta: { count: 1 }, results: [{ title: "P", publication_year: 2020 }] }));
  const t = new ScholarTools(async () => true, { fetch, gapMs: 0 });
  const r = await t.execute("scholar_search", { query: "dup" }, new AbortController().signal);
  expect(r).toContain('"title":"P"');
  expect(await t.execute("scholar_search", { query: "dup" }, new AbortController().signal)).toContain("Duplicate");
});

import { forbidsWeb } from "./scholar";
test("detects objectives that forbid web research", () => {
  expect(forbidsWeb("Do the work with real code. No web research is needed.")).toBe(true);
  expect(forbidsWeb("Work offline, without internet access")).toBe(true);
  expect(forbidsWeb("Do not use the web")).toBe(true);
  expect(forbidsWeb("Research the literature on web accessibility")).toBe(false);
  expect(forbidsWeb(undefined)).toBe(false);
});
