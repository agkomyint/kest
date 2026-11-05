import { modelPricing, modelProvider } from "./config";

/** What the team view knows about one worker. Pure data so the layout can be tested. */
export type WorkerStat = {
  workerId: string;
  parentId: string;
  role: string;
  model: string;
  task: string;
  depth: number;
  state: "running" | "done" | "error";
  calls: number;
  usd: number;
  startedAt: number;
  endedAt?: number;
  latest: string;
  output?: string;
};

/** USD for one request; 0 when the model is not in the price table. */
export function requestCost(model: string, input: number, output: number): number {
  const provider = modelProvider(model);
  const p = provider ? modelPricing(provider, model) : null;
  return p ? (input * p.inputUsdPerMillionTokens + output * p.outputUsdPerMillionTokens) / 1_000_000 : 0;
}

/** A short title for the assignment: its first sentence, not a random id. */
export function taskTitle(task: string, max = 44): string {
  const line = task.replace(/\s+/g, " ").trim();
  const sentence = line.match(/^(.+?[.:;?!])(\s|$)/)?.[1] ?? line;
  const text = sentence.length > max + 6 ? line : sentence;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export const money = (v: number) => (v === 0 ? "$0" : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}` : `${s}s`;
};
const symbol = (w: WorkerStat) => (w.state === "done" ? "✓" : w.state === "error" ? "✕" : "→");

/**
 * What a finished worker found, in a few words: the sources it cited and the gaps it admitted,
 * read from its returned text. Empty when there is nothing to say.
 */
export function outcomeLine(output: string | undefined): string {
  if (!output) return "";
  const sources = new Set(output.match(/https?:\/\/[^\s)\]>"']+/g) ?? []).size;
  const gap = output.match(/not found|uncertain|unverified|could not/i) ? " · has gaps" : "";
  return sources ? `${sources} source${sources === 1 ? "" : "s"}${gap}` : gap.slice(3);
}

/** One row per worker: status, role, what it was asked, cost, calls, time, then latest action or outcome. */
export function workerRow(w: WorkerStat, now: number, baseDepth: number): string {
  const indent = w.depth > baseDepth ? `${"  ".repeat(w.depth - baseDepth - 1)}└ ` : "";
  const end = w.endedAt ?? now;
  const tail =
    w.state === "running"
      ? w.latest
      : w.state === "error"
        ? `failed: ${w.output?.replace(/\s+/g, " ").slice(0, 60) ?? "unknown"}`
        : outcomeLine(w.output);
  return [
    `${indent}${symbol(w)} ${w.role} ${taskTitle(w.task)}`,
    money(w.usd),
    `${w.calls} call${w.calls === 1 ? "" : "s"}`,
    clock(end - w.startedAt),
    tail,
    `/agents ${w.workerId.slice(0, 8)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The head of one team: how many workers are in which state, the spend, and the time. */
export function teamHead(workers: WorkerStat[], number: number, now: number): string {
  const running = workers.filter((w) => w.state === "running");
  const done = workers.filter((w) => w.state === "done").length;
  const failed = workers.filter((w) => w.state === "error").length;
  const usd = workers.reduce((s, w) => s + w.usd, 0);
  const calls = workers.reduce((s, w) => s + w.calls, 0);
  const roles = new Map<string, number>();
  for (const w of workers) roles.set(w.role, (roles.get(w.role) ?? 0) + 1);
  const mix = [...roles].map(([role, n]) => `${n} ${role}${n === 1 ? "" : "s"}`).join(", ");
  const start = Math.min(...workers.map((w) => w.startedAt));
  const end = running.length ? now : Math.max(...workers.map((w) => w.endedAt ?? now));
  const state = running.length
    ? `${running.length} running${done ? ` · ${done} done` : ""}${failed ? ` · ${failed} failed` : ""}`
    : `${done}/${workers.length} done${failed ? ` · ${failed} failed` : ""}`;
  const mark = running.length ? "→" : failed ? "✕" : "✓";
  return `${mark} Research team ${number} · ${mix} · ${state} · ${money(usd)} · ${calls} calls · ${clock(end - start)}`;
}

/** The expanded body of a team: every running worker's latest action, then one row per worker. */
export function teamBody(workers: WorkerStat[], now: number): string {
  const base = Math.min(...workers.map((w) => w.depth));
  return workers.map((w) => workerRow(w, now, base)).join("\n");
}

const SINGULAR: Record<string, string> = { searches: "search", pages: "page", commands: "command", delegations: "delegation", files: "file" };

/** A friendly word for a tool, so an activity header says what the work was without tool jargon. */
export function activityKind(tool: string): string {
  if (tool === "tavily_search" || tool === "scholar_search") return "searches";
  if (/^tavily_/.test(tool)) return "pages";
  if (tool === "shell") return "commands";
  if (/^(spawn_|research_team)/.test(tool)) return "delegations";
  if (/^(browser|tab_)/.test(tool)) return "browser";
  if (/(read|write|edit|list|glob|grep|file|dir)/.test(tool)) return "files";
  return "other";
}

/**
 * The header of an activity group once it is done: the count, what kind of work, the time (only
 * when it is worth noting), and failures. Not "total action time", which meant nothing.
 */
export function activityHead(count: number, kinds: Map<string, number>, totalMs: number, failures: number, fmt: (ms: number) => string): string {
  const mix = [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${n} ${n === 1 ? SINGULAR[k] ?? k : k}`).join(", ");
  const parts = [`${count} ${count === 1 ? "action" : "actions"}`, mix, totalMs > 0 ? fmt(totalMs) : "", failures ? `${failures} failed` : ""].filter(Boolean);
  return `${failures ? "✕" : "✓"} Activity · ${parts.join(" · ")}`;
}

/** Fold one worker event into a table of worker stats; the same rules the transcript rows use. */
export function foldWorker(
  stats: Map<string, WorkerStat>,
  event: { workerId: string; parentId?: string; role: string; model?: string; task?: string; depth?: number; state: "running" | "done" | "error"; output?: string; usage?: { model: string; input: number; output: number }; event?: { type: string; state?: string; name?: string } },
  now: number,
  label: (name: string) => string = (n) => n,
): WorkerStat {
  let stat = stats.get(event.workerId);
  if (!stat) {
    stat = { workerId: event.workerId, parentId: event.parentId ?? "", role: event.role, model: event.model ?? "", task: event.task ?? "", depth: event.depth ?? 1, state: "running", calls: 0, usd: 0, startedAt: now, latest: "Starting" };
    stats.set(event.workerId, stat);
  }
  if (event.usage) stat.usd += requestCost(event.usage.model, event.usage.input, event.usage.output);
  stat.state = event.state;
  if (event.state !== "running") {
    stat.endedAt ??= now;
    stat.output = event.output;
    stat.latest = event.state === "done" ? "Completed" : "Failed";
  }
  const activity = event.event;
  if (activity?.type === "tool" && activity.name) {
    if (activity.state !== "running") stat.calls++;
    if (event.state === "running") stat.latest = `${label(activity.name)} · ${activity.state}`;
  }
  return stat;
}
