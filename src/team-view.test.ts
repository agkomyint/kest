import { expect, test } from "bun:test";

import { outcomeLine, requestCost, taskTitle, teamBody, teamHead, workerRow, type WorkerStat } from "./team-view";

const w = (over: Partial<WorkerStat>): WorkerStat => ({
  workerId: "w1",
  parentId: "p",
  role: "researcher",
  model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
  task: "Find the AFP rating labels. Cite the stylebook.",
  depth: 1,
  state: "running",
  calls: 0,
  usd: 0,
  startedAt: 0,
  latest: "tavily_search",
  ...over,
});

test("a row says what the worker was asked, not who it is", () => {
  expect(taskTitle("Find the AFP rating labels. Cite the stylebook.")).toBe("Find the AFP rating labels.");
  expect(taskTitle("x".repeat(200)).length).toBeLessThanOrEqual(44);
  const row = workerRow(w({ calls: 9, usd: 0.0312 }), 31_000, 1);
  expect(row).toContain("Find the AFP rating labels.");
  expect(row).toContain("$0.03 · 9 calls · 31s");
  expect(row).toContain("/agents w1");
});

test("finished rows show an outcome, failed ones the reason", () => {
  const done = w({ state: "done", endedAt: 5000, output: "AFP uses X https://a.com/x and https://b.com/y. Not found: Snopes." });
  expect(workerRow(done, 9000, 1)).toContain("2 sources · has gaps");
  expect(outcomeLine("")).toBe("");
  const failed = w({ state: "error", endedAt: 1000, output: "step limit" });
  expect(workerRow(failed, 9000, 1)).toContain("failed: step limit");
});

test("subagents are indented under their parent and the head totals the team", () => {
  const rows = [w({ workerId: "a", usd: 0.02, calls: 3 }), w({ workerId: "b", depth: 2, usd: 0.01, calls: 2, state: "done", endedAt: 4000 })];
  const body = teamBody(rows, 10_000).split("\n");
  expect(body[0]!.startsWith("→ researcher")).toBe(true);
  expect(body[1]!.startsWith("└ ✓ researcher")).toBe(true);
  const head = teamHead(rows, 2, 10_000);
  expect(head).toContain("Research team 2");
  expect(head).toContain("2 researchers");
  expect(head).toContain("1 running · 1 done");
  expect(head).toContain("$0.03 · 5 calls");
});

test("requests are priced from the model table and unknown models cost nothing", () => {
  expect(requestCost("deepseek-ai/DeepSeek-V4.1-Flash-1017", 1_000_000, 0)).toBeCloseTo(0.3, 6);
  expect(requestCost("no-such-model", 1_000_000, 1_000_000)).toBe(0);
});
