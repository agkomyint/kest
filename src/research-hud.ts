import type { CompanyState } from "./research-company";

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

const compact = (n: number) =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `${n}`;

// One-line HUD: only the two binding budgets — time and tokens.
// Requests are metered (shown in /research), never limited.
// liveElapsedMs lets the UI tick the clock between budget syncs.
export function budgetHud(state: CompanyState, liveElapsedMs?: number): string {
  const elapsed = liveElapsedMs ?? state.elapsedMs;
  const usedTokens =
    state.inputTokens + state.outputTokens + state.estimatedTokens;
  const time = `⏱ ${formatDuration(elapsed)}/${formatDuration(state.maxMs)} ${budgetBar(elapsed, state.maxMs)}`;
  const tokens =
    state.maxTokens === null
      ? `tok ${compact(usedTokens)}/∞`
      : `tok ${compact(usedTokens)}/${compact(state.maxTokens)} ${budgetBar(usedTokens, state.maxTokens)}`;
  const levels = [
    budgetLevel(elapsed, state.maxMs),
    ...(state.maxTokens === null
      ? []
      : [budgetLevel(usedTokens, state.maxTokens)]),
  ];
  const worst = levels.includes("critical")
    ? "critical"
    : levels.includes("watch")
      ? "watch"
      : "healthy";
  return `${time} · ${tokens}${worst !== "healthy" ? ` · budget ${worst}` : ""}`;
}

export function shouldOpenBudgetDecision(state: CompanyState): boolean {
  const usedTokens =
    state.inputTokens + state.outputTokens + state.estimatedTokens;
  return (
    budgetLevel(state.elapsedMs, state.maxMs) !== "healthy" ||
    (state.maxTokens !== null &&
      budgetLevel(usedTokens, state.maxTokens) !== "healthy")
  );
}
