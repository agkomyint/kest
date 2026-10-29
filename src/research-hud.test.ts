import { expect, test } from "bun:test";
import {
  budgetBar,
  budgetHud,
  budgetLevel,
  formatDuration,
  shouldOpenBudgetDecision,
  truncateMiddle,
} from "./research-hud";
import { newCompany } from "./research-company";

test("formatDuration has no false precision", () => {
  expect(formatDuration(342.11)).toBe("342ms");
  expect(formatDuration(42848.05)).toBe("42.8s");
  expect(formatDuration(108000)).toBe("1m 48s");
  expect(formatDuration(3600000)).toBe("60m");
});

test("truncateMiddle keeps head and tail", () => {
  const out = truncateMiddle("research/7d45d58b-4939-48c6-9591-fffd/file", 21);
  expect(out).toContain("…");
  expect(out.length).toBeLessThanOrEqual(21);
});

test("budgetLevel thresholds", () => {
  expect(budgetLevel(69, 100)).toBe("healthy");
  expect(budgetLevel(70, 100)).toBe("watch");
  expect(budgetLevel(90, 100)).toBe("critical");
  expect(budgetLevel(5, 0)).toBe("healthy");
});

test("budgetBar shows fill and reserve", () => {
  expect(budgetBar(50, 100)).toBe("▓▓▓▓····");
  expect(budgetBar(50, 100, 25)).toBe("▓▓▓▓░░··");
});

test("budgetHud is one line with time, tokens, requests", () => {
  const s = newCompany("obj");
  s.elapsedMs = 41 * 60000;
  s.maxMs = 120 * 60000;
  s.inputTokens = 100000;
  s.outputTokens = 18000;
  s.maxTokens = 400000;
  s.requests = 63;
  s.maxRequests = 300;
  const hud = budgetHud(s);
  expect(hud).not.toContain("\n");
  expect(hud).toContain("41m/120m");
  expect(hud).toContain("tok 118k/400k");
  expect(hud).not.toContain("req");
  expect(shouldOpenBudgetDecision(s)).toBe(false);
  s.elapsedMs = 100 * 60000;
  expect(shouldOpenBudgetDecision(s)).toBe(true);
  expect(budgetHud(s)).toContain("budget watch");
});

test("budgetHud ticks with live elapsed override", () => {
  const s = newCompany("obj");
  s.maxMs = 120 * 60000;
  expect(budgetHud(s, 65 * 60000)).toContain("65m/120m");
  s.inputTokens = 5000;
  expect(budgetHud(s, 0)).toContain("tok 5.0k/∞");
});
