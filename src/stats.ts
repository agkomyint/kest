import type OpenAI from "openai";

export type ToolTiming = { name: string; durationMs: number; error: boolean };

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
