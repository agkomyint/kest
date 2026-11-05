import { modelPricing, modelProvider } from "./config";

/**
 * Cost estimates for tool calls. Every call costs something, in three currencies:
 *  - context: its result is added to the conversation and re-read on every later turn;
 *  - direct money: a few tools bill by themselves (Tavily credits);
 *  - time: tracked separately (see estimateToolMs).
 * The estimate starts from a prior per tool and sharpens with what this machine has observed.
 */

/** Typical result size in tokens, and direct USD per call, before anything has been observed. */
const PRIORS: Record<string, { tok: number; usd?: number }> = {
  list_files: { tok: 250 },
  read_file: { tok: 1200 },
  search: { tok: 500 },
  edit_file: { tok: 60 },
  write_file: { tok: 60 },
  shell: { tok: 500 },
  proc: { tok: 200 },
  machine_check: { tok: 300 },
  browser: { tok: 1500 },
  scholar_search: { tok: 1500 },
  tavily_search: { tok: 1200, usd: 0.008 },
  tavily_extract: { tok: 2500, usd: 0.008 },
  tavily_map: { tok: 800, usd: 0.008 },
  tavily_crawl: { tok: 4000, usd: 0.016 },
  tavily_research: { tok: 3000, usd: 0.12 },
  tavily_research_status: { tok: 300 },
  lsi_search: { tok: 600 },
  lsi_get_research: { tok: 2500 },
  kest_guide: { tok: 400 },
  spawn_subagent: { tok: 800 },
  research_team: { tok: 800 },
  research_review: { tok: 800 },
};
const DEFAULT_TOK = 150;

/** How many later turns an average result stays in context. */
export const CARRY_TURNS = 4;

export type CallEstimate = {
  /** Result size added to the conversation, in tokens. */
  tokens: number;
  /** Money the tool bills by itself. */
  directUsd: number;
  /** Money to re-read the result on later turns, at the model's input rate. 0 when the rate is unknown. */
  carryUsd: number;
  totalUsd: number;
};

/** USD per million input tokens for a model, or null when unpriced. */
export function inputRate(model: string | undefined): number | null {
  if (!model) return null;
  const provider = modelProvider(model);
  return (provider ? modelPricing(provider, model) : null)?.inputUsdPerMillionTokens ?? null;
}

/**
 * Estimate one call. `observedChars` are the result sizes seen before for this tool; their median
 * replaces the prior once there are three. `rate` is the caller's model input rate (USD per 1M).
 */
export function estimateCall(name: string, o: { observedChars?: number[]; rate?: number | null } = {}): CallEstimate {
  const prior = PRIORS[name];
  const seen = (o.observedChars ?? []).filter((n) => Number.isFinite(n) && n >= 0);
  let tokens = prior?.tok ?? DEFAULT_TOK;
  if (seen.length >= 3) {
    const sorted = [...seen].sort((a, b) => a - b);
    tokens = Math.ceil(sorted[Math.floor(sorted.length / 2)]! / 4);
  }
  const directUsd = prior?.usd ?? 0;
  const carryUsd = o.rate ? (tokens * (1 + CARRY_TURNS) * o.rate) / 1_000_000 : 0;
  return { tokens, directUsd, carryUsd, totalUsd: directUsd + carryUsd };
}

/** Tokens a result of this many characters adds (about four characters per token). */
export const charsToTokens = (chars: number) => Math.ceil(chars / 4);

const usd = (v: number) => (v === 0 ? "$0" : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));

/** A short line for the call log: "~1.2K tokens · ~$0.01". Empty for trivial calls. */
export function describeEstimate(e: CallEstimate): string {
  if (e.tokens < 400 && e.directUsd === 0) return "";
  return `~${compact(e.tokens)} tokens${e.totalUsd >= 0.0005 ? ` · ~${usd(e.totalUsd)}` : ""}`;
}
