/**
 * The tool registry: one entry per tool, the single place that says what a tool is, who may use it,
 * what it needs approval for, whether it can run alongside others, and how long it usually takes.
 *
 * It is pure data on purpose (no imports), so any module can read it without cycles. The model-facing
 * definitions (name, description, schema) and the implementations still live next to their code; the
 * registry test checks that every tool Kest can offer is registered, every registered tool really is
 * offered to the tiers it lists, and nothing is left undocumented.
 */

/** Who is calling. CEO is the person's main chat; a director runs one study; researchers and subagents work for it. */
export type Tier = "ceo" | "director" | "researcher" | "subagent";
export const TIERS: readonly Tier[] = ["ceo", "director", "researcher", "subagent"];

/** What a tool does to the world, from harmless to outward-facing. Used for audit and (later) policy. */
export type Effect = "read" | "write" | "exec" | "net" | "publish" | "control";

/** What the person is asked to approve before the tool runs, or null when nothing is asked. */
export type Approval = "file" | "script" | "browser" | "web" | "lsi" | "study" | null;

export type ToolSpec = {
  family: string;
  effect: Effect;
  tiers: readonly Tier[];
  approval: Approval;
  /** Safe to overlap with other parallel tools in one reply (read-only, no shared state). */
  parallel?: true;
  /** Typical duration in ms before this machine has observed the tool. */
  ms: number;
};

const ALL: readonly Tier[] = TIERS;
const WORK: readonly Tier[] = ["ceo", "director"]; // may act on the machine
const LEADS: readonly Tier[] = ["ceo", "director", "researcher"]; // may delegate
const STUDY: readonly Tier[] = ["director", "researcher", "subagent"];

const spec = (
  family: string,
  effect: Effect,
  tiers: readonly Tier[],
  approval: Approval = null,
  ms = 1_000,
  parallel = false,
): ToolSpec => ({ family, effect, tiers, approval, ms, ...(parallel ? { parallel: true as const } : {}) });

export const REGISTRY: Readonly<Record<string, ToolSpec>> = {
  // files
  list_files: spec("files", "read", ALL, null, 500, true),
  read_file: spec("files", "read", ALL, null, 500, true),
  search: spec("files", "read", ALL, null, 1_000, true),
  edit_file: spec("files", "write", WORK, "file", 2_000),
  write_file: spec("files", "write", WORK, "file", 2_000),

  // machine
  shell: spec("shell", "exec", WORK, "script", 15_000),
  proc: spec("process", "exec", WORK, "script", 1_000),
  machine_check: spec("machine", "read", ["ceo"], null, 300),

  // web
  browser: spec("browser", "net", ALL, "browser", 5_000),
  scholar_search: spec("web", "net", ALL, "web", 1_000, true),
  tavily_search: spec("web", "net", ALL, "web", 1_000, true),
  tavily_extract: spec("web", "net", ALL, "web", 1_000, true),
  tavily_map: spec("web", "net", ALL, "web", 1_000, true),
  tavily_crawl: spec("web", "net", ALL, "web", 1_000, true),
  tavily_research: spec("web", "net", ALL, "web"),
  tavily_research_status: spec("web", "net", ALL, "web"),

  // LSI (the shared repository)
  lsi_search: spec("lsi", "net", ALL, null, 1_000, true),
  lsi_get_research: spec("lsi", "net", ALL, null, 1_000, true),
  lsi_domains: spec("lsi", "net", ALL, null, 1_000, true),
  lsi_novelty: spec("lsi", "net", ALL, null, 1_000, true),
  lsi_questions: spec("lsi", "net", ALL, null, 1_000, true),
  lsi_stats: spec("lsi", "net", ALL, null, 1_000, true),
  lsi_suggest: spec("lsi", "net", ALL, null, 1_000, true),
  lsi_post_question: spec("lsi", "publish", WORK, "lsi"),
  lsi_post_questions: spec("lsi", "publish", WORK, "lsi"),
  lsi_add_topic: spec("lsi", "publish", WORK, "lsi"),
  lsi_set_published: spec("lsi", "publish", WORK, "lsi"),
  lsi_claim: spec("lsi", "publish", ["director"], "lsi"),
  lsi_release: spec("lsi", "publish", ["director"]),
  lsi_publish: spec("lsi", "publish", ["director"], "lsi"),

  // guidance
  kest_guide: spec("guide", "read", ALL, null, 100, true),

  // planning and delegation
  set_plan: spec("plan", "control", WORK),
  update_task: spec("plan", "control", WORK),
  spawn_subagent: spec("delegate", "control", LEADS, null, 60_000),
  background_status: spec("delegate", "control", LEADS),
  background_cancel: spec("delegate", "control", LEADS),
  list_models: spec("delegate", "read", STUDY, null, 500, true),
  research_status: spec("delegate", "read", STUDY, null, 500, true),
  research_team: spec("delegate", "control", ["director", "researcher"], null, 60_000),
  research_review: spec("delegate", "control", ["director", "researcher"], null, 60_000),

  // the study itself
  research_complete: spec("study", "control", ["director"]),
  notify_control: spec("study", "control", ["director"], null, 200),
  ask_control: spec("study", "control", ["director"], null, 180_000),

  // CEO: running studies and the inbox
  research_prepare: spec("studies", "control", ["ceo"], null, 2_000),
  research_start_all: spec("studies", "control", ["ceo"], null, 2_000),
  research_resume_all: spec("studies", "control", ["ceo"], null, 2_000),
  research_list: spec("studies", "read", ["ceo"], null, 1_000),
  research_delete: spec("studies", "control", ["ceo"], null, 2_000),
  inbox_draft: spec("inbox", "control", ["ceo"], null, 300),
  inbox_send: spec("inbox", "control", ["ceo"], "study", 2_000),
};

export const toolSpec = (name: string): ToolSpec | undefined => REGISTRY[name];
export const toolNames = () => Object.keys(REGISTRY);
export const toolsForTier = (tier: Tier) => toolNames().filter((n) => REGISTRY[n]!.tiers.includes(tier));
export const isParallelTool = (name: string) => REGISTRY[name]?.parallel === true;
export const defaultToolMs = (name: string) => REGISTRY[name]?.ms ?? 1_000;

/** One line per tool, for audit and the /stats legend: who, effect, approval. */
export function describeRegistry(): string[] {
  return toolNames().map((n) => {
    const s = REGISTRY[n]!;
    return `${n.padEnd(24)} ${s.family.padEnd(9)} ${s.effect.padEnd(8)} ${(s.approval ?? "-").padEnd(8)} ${s.tiers.join(",")}`;
  });
}
