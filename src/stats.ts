import type OpenAI from "openai";

import type { Tier } from "./registry";

/** One finished tool call. Calls saved before tiers existed have no tier. */
export type ToolTiming = { name: string; durationMs: number; error: boolean; tier?: Tier; chars?: number; estUsd?: number };

export function formatToolStats(
  definitions: OpenAI.ChatCompletionTool[],
  timings: ToolTiming[],
  summary?: { sessions: number; workspaces: number },
): string {
  const names = new Set(
    definitions.flatMap((t) =>
      t.type === "function" ? [t.function.name] : [],
    ),
  );
  for (const timing of timings) names.add(timing.name);
  const rows = [...names].map((name) => {
    const calls = timings.filter((t) => t.name === name);
    const total = calls.reduce((sum, t) => sum + t.durationMs, 0);
    const max = calls.reduce((max, t) => Math.max(max, t.durationMs), 0);
    return `${name}  ${calls.length} calls · ${calls.filter((t) => t.error).length} errors · total ${total.toFixed(2)} ms · avg ${(calls.length ? total / calls.length : 0).toFixed(2)} ms · max ${max.toFixed(2)} ms`;
  });
  const scope = summary
    ? `All time · this machine · ${summary.sessions} sessions · ${summary.workspaces} workspaces\n`
    : "";
  return `${scope}${definitions.length} tools available · ${timings.length} calls ${summary ? "across saved sessions" : "this session"}\n${rows.join("\n")}\n\nElapsed wall time includes approval waits. Subagent time is included in spawn_subagent. Older calls without timing are excluded.`;
}

const TIER_LABEL: Record<Tier, string> = {
  ceo: "CEO (you)",
  director: "Directors",
  researcher: "Researchers",
  subagent: "Subagents",
};
const secs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
const cutText = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s);
const miniBar = (frac: number, w: number) => {
  const n = Math.max(1, Math.min(w, Math.round(frac * w)));
  return "█".repeat(n) + "░".repeat(w - n);
};

/**
 * Tool usage by tier: for the CEO chat, the directors, the researchers and the subagents, how many
 * calls, how often they fail, how slow they are, and which tools each leans on. Pure formatter.
 */
const compactNum = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));

export function tierStats(
  timings: ToolTiming[],
  o: { width?: number; top?: number; summary?: { sessions: number; workspaces: number } } = {},
): string[] {
  const width = Math.max(40, o.width ?? 78);
  const top = o.top ?? 4;
  const head = `STATS · tool usage by tier · all time${o.summary ? ` · ${o.summary.sessions} sessions · ${o.summary.workspaces} workspaces` : ""}`;
  const lines = [cutText(head, width), "─".repeat(Math.min(width, 78))];
  if (!timings.length) return [...lines, "No tool calls recorded yet."];
  const order: (Tier | "none")[] = ["ceo", "director", "researcher", "subagent", "none"];
  const rate = (calls: ToolTiming[]) => (calls.length ? Math.round((calls.filter((c) => c.error).length / calls.length) * 100) : 0);
  const avg = (calls: ToolTiming[]) => (calls.length ? calls.reduce((s, c) => s + c.durationMs, 0) / calls.length : 0);
  for (const tier of order) {
    const calls = timings.filter((t) => (t.tier ?? "none") === tier);
    if (!calls.length) continue;
    const label = tier === "none" ? "Before tiers" : TIER_LABEL[tier];
    lines.push(cutText(`${label.padEnd(13)} ${calls.length.toLocaleString("en-US")} call${calls.length === 1 ? "" : "s"} · ${rate(calls)}% errors · avg ${secs(avg(calls))}`, width));
    if (tier === "none") continue;
    const chars = calls.reduce((s, c) => s + (c.chars ?? 0), 0);
    const est = calls.reduce((s, c) => s + (c.estUsd ?? 0), 0);
    if (chars) lines.push(cutText(`  context added ~${compactNum(Math.ceil(chars / 4))} tokens · est ${est < 0.01 ? "$" + est.toFixed(4) : "$" + est.toFixed(2)}`, width));
    const byTool = new Map<string, number>();
    for (const c of calls) byTool.set(c.name, (byTool.get(c.name) ?? 0) + 1);
    const ranked = [...byTool].sort((a, b) => b[1] - a[1]).slice(0, top);
    const max = ranked[0]![1];
    const nameW = Math.min(18, Math.max(...ranked.map(([n]) => n.length)));
    const barW = width >= 70 ? 14 : 8;
    for (const [name, n] of ranked)
      lines.push(cutText(`  ${name.padEnd(nameW)} ${miniBar(n / max, barW)} ${n.toLocaleString("en-US")}`, width));
    lines.push("");
  }
  const byTool = new Map<string, ToolTiming[]>();
  for (const t of timings) byTool.set(t.name, [...(byTool.get(t.name) ?? []), t]);
  const real = [...byTool].filter(([, c]) => c.length >= 3);
  const slow = real.sort((a, b) => avg(b[1]) - avg(a[1]))[0];
  const flaky = [...byTool].filter(([, c]) => c.length >= 3 && rate(c) > 0).sort((a, b) => rate(b[1]) - rate(a[1]))[0];
  if (slow) lines.push(cutText(`Slowest         ${slow[0]} avg ${secs(avg(slow[1]))}`, width));
  if (flaky) lines.push(cutText(`Highest errors  ${flaky[0]} ${rate(flaky[1])}% of ${flaky[1].length} calls`, width));
  lines.push("", cutText("/stats tools for the full per-tool table.", width));
  return lines;
}
