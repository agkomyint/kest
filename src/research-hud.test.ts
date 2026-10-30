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

test("budgetHud shows only the dollar allowance and cost pressure", () => {
  const state = newCompany("obj");
  state.maxCostUsd = 10;
  state.spentCostMicros = 3_000_000;
  state.estimatedCostMicros = 500_000;
  expect(budgetHud(state)).toContain("$3.5000/$10.00");
  expect(budgetHud(state)).not.toContain("tok");
  expect(budgetHud(state)).not.toContain("⏱");
  expect(shouldOpenBudgetDecision(state)).toBe(false);
  state.spentCostMicros = 8_000_000;
  expect(shouldOpenBudgetDecision(state)).toBe(true);
  expect(budgetHud(state)).toContain("budget watch");
});

test("unconfigured studies show a dollar budget setup hint", () => {
  expect(budgetHud(newCompany("obj"))).toContain("/research budget 10$");
});
