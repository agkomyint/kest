import { expect, test } from "bun:test";

import { charsToTokens, describeEstimate, estimateCall, inputRate } from "./cost";
import { toolNames } from "./registry";
import { tierStats } from "./stats";

test("a call is estimated from its prior, then from what was observed", () => {
  const prior = estimateCall("read_file");
  expect(prior.tokens).toBe(1200);
  // Three observed results of 4000 chars each replace the prior.
  expect(estimateCall("read_file", { observedChars: [4000, 4000, 4000] }).tokens).toBe(1000);
  // Fewer than three samples are not trusted yet.
  expect(estimateCall("read_file", { observedChars: [40] }).tokens).toBe(1200);
  // Garbage samples are ignored.
  expect(estimateCall("read_file", { observedChars: [Number.NaN, -5] }).tokens).toBe(1200);
});

test("context carry is paid again on every later turn, at the model's input rate", () => {
  const e = estimateCall("read_file", { rate: 1 }); // $1 per 1M input tokens
  expect(e.carryUsd).toBeCloseTo((1200 * 5) / 1_000_000, 8);
  expect(e.directUsd).toBe(0);
  // Unknown rate: no invented money.
  expect(estimateCall("read_file", { rate: null }).carryUsd).toBe(0);
});

test("tools that bill by themselves carry a direct cost", () => {
  expect(estimateCall("tavily_search").directUsd).toBeGreaterThan(0);
  expect(estimateCall("tavily_research").directUsd).toBeGreaterThan(estimateCall("tavily_search").directUsd);
  expect(estimateCall("read_file").directUsd).toBe(0);
  expect(inputRate("not-a-real-model")).toBeNull();
  expect(inputRate(undefined)).toBeNull();
});

test("every registered tool gets a finite estimate", () => {
  for (const name of toolNames()) {
    const e = estimateCall(name, { rate: 0.5 });
    expect(Number.isFinite(e.tokens) && e.tokens > 0).toBe(true);
    expect(Number.isFinite(e.totalUsd) && e.totalUsd >= 0).toBe(true);
  }
  expect(charsToTokens(401)).toBe(101);
});

test("small calls stay quiet and big ones say what they cost", () => {
  expect(describeEstimate(estimateCall("edit_file"))).toBe("");
  expect(describeEstimate(estimateCall("tavily_extract", { rate: 1 }))).toContain("tokens");
  expect(describeEstimate(estimateCall("tavily_research", { rate: 1 }))).toMatch(/~\$0\.1/);
});

test("/stats shows the context each tier added and its estimated cost", () => {
  const lines = tierStats([
    { name: "read_file", durationMs: 10, error: false, tier: "director", chars: 8000, estUsd: 0.004 },
    { name: "read_file", durationMs: 10, error: false, tier: "director", chars: 4000, estUsd: 0.002 },
  ]).join("\n");
  expect(lines).toContain("context added ~3K tokens");
  expect(lines).toContain("est $0.0060");
});
