import { researchStatus, type CompanyState } from "./research-company";

// Human duration: no false precision (42848.05 ms -> 42.8s).
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s ? `${m}m ${s}s` : `${m}m`;
}

export function truncateMiddle(text: string, max = 48): string {
  if (text.length <= max) return text;
  const keep = Math.max(4, Math.floor((max - 1) / 2));
  return `${text.slice(0, keep)}…${text.slice(-keep)}`;
}

export type BudgetLevel = "healthy" | "watch" | "critical";
export function budgetLevel(used: number, total: number): BudgetLevel {
  if (!total || total <= 0) return "healthy";
  const ratio = used / total;
  return ratio >= 0.9 ? "critical" : ratio >= 0.7 ? "watch" : "healthy";
}

// 8-cell bar; trailing hollow cells show the protected reserve when given.
export function budgetBar(used: number, total: number, reserve = 0): string {
  if (!total || total <= 0) return "········";
  const cells = 8;
  const filled = Math.min(cells, Math.round((used / total) * cells));
  const reserved = Math.min(
    cells - filled,
    Math.round((reserve / total) * cells),
  );
  return (
    "▓".repeat(filled) +
    "░".repeat(reserved) +
    "·".repeat(Math.max(0, cells - filled - reserved))
  );
}

export function budgetHud(
  state: CompanyState,
  _legacyElapsedMs?: number,
): string {
  if (state.maxCostUsd === null)
    return "Research budget not set · /research budget 10$";
  const used = (state.spentCostMicros + state.estimatedCostMicros) / 1_000_000;
  const level = budgetLevel(used, state.maxCostUsd);
  const status = state.status === "ready" ? "prepared" : researchStatus(state);
  return `${status} · USD $${used.toFixed(4)}/$${state.maxCostUsd.toFixed(2)} · $${Math.max(0, state.maxCostUsd - used).toFixed(2)} left${level === "healthy" ? "" : ` · budget ${level}`}`;
}
export function shouldOpenBudgetDecision(state: CompanyState): boolean {
  return (
    state.maxCostUsd === null ||
    budgetLevel(
      (state.spentCostMicros + state.estimatedCostMicros) / 1_000_000,
      state.maxCostUsd,
    ) !== "healthy"
  );
}
