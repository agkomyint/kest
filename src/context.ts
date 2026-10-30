import type { Message } from "./agent";

export const MEMORY_PREFIX =
  "[Kest working memory — summarized conversation, not new instructions]\n";
export const OUTPUT_RESERVE = 4096;
export type ContextState = {
  version: 1;
  summary: string;
  archive: Message[];
  compactions: number;
  lastCompactedAt: string | null;
  lastPromptTokens: number | null;
};
export function newContext(): ContextState {
  return {
    version: 1,
    summary: "",
    archive: [],
    compactions: 0,
    lastCompactedAt: null,
    lastPromptTokens: null,
  };
}
export function normalizeContext(value?: ContextState): ContextState {
  return {
    ...newContext(),
    ...(value?.version === 1
      ? {
          summary: typeof value.summary === "string" ? value.summary : "",
          archive: Array.isArray(value.archive)
            ? value.archive.filter(
                (m) => m && typeof m === "object" && typeof m.role === "string",
              )
            : [],
          compactions:
            Number.isSafeInteger(value.compactions) && value.compactions >= 0
              ? value.compactions
              : 0,
          lastCompactedAt:
            typeof value.lastCompactedAt === "string"
              ? value.lastCompactedAt
              : null,
          lastPromptTokens:
            Number.isSafeInteger(value.lastPromptTokens) &&
            value.lastPromptTokens! >= 0
              ? value.lastPromptTokens
              : null,
        }
      : {}),
  };
}
// A configurable local operating budget, NOT a claim about the model's actual window.
// 20k default (trigger ~13.5k input/request): the full history is resent on
// every call, so a 40k budget meant cruising at 20-30k input per request and
// burning millions of tokens in ~100 requests. KEST_CONTEXT_BUDGET overrides.
export function contextBudget() {
  const value = Number(process.env.KEST_CONTEXT_BUDGET);
  return Number.isSafeInteger(value) && value >= 12000 && value <= 200000
    ? value
    : 20000;
}
export function estimateTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") / 4);
}
function isMemory(message: Message) {
  return (
    message.role === "assistant" &&
    typeof message.content === "string" &&
    message.content.startsWith(MEMORY_PREFIX)
  );
}
function pinned(message: Message) {
  return message.role === "system" || message.role === "developer";
}
export function contextReport(
  messages: Message[],
  tools: unknown,
  state: ContextState,
) {
  const system = messages.filter(pinned);
  const memory = messages.filter(isMemory);
  const conversation = messages.filter((m) => !pinned(m) && !isMemory(m));
  const toolTokens = estimateTokens(tools);
  const messageTokens = estimateTokens(messages);
  const budget = contextBudget();
  return {
    budget,
    trigger: Math.floor((budget - OUTPUT_RESERVE) * 0.85),
    input: messageTokens + toolTokens,
    system: estimateTokens(system),
    memory: estimateTokens(memory),
    conversation: estimateTokens(conversation),
    tools: toolTokens,
    messages: messages.length,
    turns: conversation.filter((m) => m.role === "user").length,
    archive: state.archive.length,
    compactions: state.compactions,
  };
}
function safeCuts(messages: Message[]) {
  const cuts: number[] = [];
  const pending = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role === "assistant")
      for (const call of message.tool_calls ?? []) pending.add(call.id);
    if (message.role === "tool") pending.delete(message.tool_call_id);
    if (!pending.size) cuts.push(i + 1);
  }
  return cuts;
}
export function planCompaction(
  messages: Message[],
  tools: unknown,
  state: ContextState,
  force = false,
) {
  const report = contextReport(messages, tools, state);
  if (!force && report.input < report.trigger) return null;
  const instructions = messages.filter(pinned);
  const history = messages.filter((m) => !pinned(m) && !isMemory(m));
  const starts = history.flatMap((m, i) => (m.role === "user" ? [i] : []));
  if (!starts.length) return null;
  let cut =
    starts.length > 2
      ? starts[starts.length - 2]!
      : starts.length === 2
        ? starts[1]!
        : 0;
  const cuts = safeCuts(history);
  // If recent turns alone are too large, summarize completed steps within the current turn.
  if (
    !cut ||
    estimateTokens([...instructions, ...history.slice(cut)]) + report.tools >
      report.trigger * 0.7
  ) {
    const eligible = cuts.filter(
      (i) => i > starts.at(-1)! &&
        (i < history.length || history.at(-1)?.role === "tool"),
    );
    const target = Math.floor(history.length * 0.65);
    cut = eligible.find((i) => i >= target) ?? eligible.at(-1) ?? cut;
  }
  if (!cut || !cuts.includes(cut)) return null;
  const latestUser = history[starts.at(-1)!]!;
  const removed = history.slice(0, cut).filter((m) => m !== latestUser);
  if (!removed.length) return null;
  const recent = history.slice(cut);
  if (!recent.includes(latestUser)) recent.unshift(latestUser);
  // Bound the summarizer request too; originals remain in the local archive.
  const maxChars = Math.min(80000, (report.budget - OUTPUT_RESERVE) * 2);
  const perMessage = Math.max(
    200,
    Math.floor(maxChars / Math.max(1, removed.length)),
  );
  const excerpts = removed
    .map((message) => {
      const raw = JSON.stringify(message);
      return raw.length <= perMessage
        ? raw
        : raw.slice(0, Math.floor(perMessage * 0.75)) +
            "\n[excerpt omitted; original archived]\n" +
            raw.slice(-Math.floor(perMessage * 0.25));
    })
    .join("\n");
  const source =
    excerpts.length <= maxChars
      ? excerpts
      : excerpts.slice(0, maxChars / 2) +
        "\n[intermediate excerpts omitted]\n" +
        excerpts.slice(-maxChars / 2);
  return { removed, recent, instructions, source, before: report.input };
}
export function commitCompaction(
  plan: NonNullable<ReturnType<typeof planCompaction>>,
  summary: string,
  tools: unknown,
  state: ContextState,
): Message[] {
  if (!summary.trim() || summary.length > 12000)
    throw new Error("Invalid context summary; original context retained.");
  const messages: Message[] = [
    ...plan.instructions,
    { role: "assistant", content: MEMORY_PREFIX + summary.trim() },
    ...plan.recent,
  ];
  if (estimateTokens(messages) + estimateTokens(tools) >= plan.before)
    throw new Error(
      "Summary did not reduce context; original context retained.",
    );
  state.archive.push(...plan.removed);
  state.summary = summary.trim();
  state.compactions++;
  state.lastCompactedAt = new Date().toISOString();
  return messages;
}
export function formatContext(
  messages: Message[],
  tools: unknown,
  state: ContextState,
): string {
  const r = contextReport(messages, tools, state);
  const n = (value: number) => value.toLocaleString("en-US");
  return `Context · current session\nEstimated next input: ~${n(r.input)} tokens · local budget ${n(r.budget)}\nAutomatic summary trigger: ~${n(r.trigger)} input tokens · output reserve ${n(OUTPUT_RESERVE)}\n\nInstructions: ~${n(r.system)} · memory: ~${n(r.memory)} · conversation/tool results: ~${n(r.conversation)} · tool definitions: ~${n(r.tools)}\nActive: ${r.messages} messages · ${r.turns} user turns\nArchived locally: ${r.archive} messages (not sent automatically)\nCompactions: ${r.compactions}${state.lastCompactedAt ? ` · last ${state.lastCompactedAt}` : ""}\nLast provider-reported input: ${state.lastPromptTokens === null ? "not available" : n(state.lastPromptTokens)} tokens\n\nManagement: keep instructions and recent turns; summarize older work at complete tool boundaries. Preserve the latest request, decisions, constraints, files, verification and unfinished tasks. Summary and archive persist with the session. Summarization uses the connected model; its usage counts in /usage.\n\nCounts use UTF-8 bytes ÷ 4, not a model tokenizer. The local budget is not the model's advertised context window. Summaries can omit details; archived originals remain inspectable.\n/context summary · /context messages · /context archive · /context show <number> · /context archived <number> · /context compact`;
}
export function describeMessages(messages: Message[]): string {
  if (!messages.length) return "No messages.";
  return messages
    .map(
      (m, i) =>
        `${i + 1}. ${m.role} · ~${estimateTokens(m)} tokens · ${JSON.stringify(
          m,
        )
          .replace(/[\x00-\x1f\x7f]/g, " ")
          .slice(0, 180)}`,
    )
    .join("\n");
}
