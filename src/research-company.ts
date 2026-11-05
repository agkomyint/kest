import {
  mkdir,
  appendFile,
  writeFile,
  rename,
  readFile,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { modelPricing } from "./config";
import type { Approve, Approval } from "./tools";

import companyInstructions from "../prompts/research-company.md" with { type: "text" };
export const researchCompanyPrompt = `<kest-research-company>\n${companyInstructions}\n</kest-research-company>`;

const promptSections = new Map<string, string>();
for (const part of companyInstructions.split(/^## /m).slice(1)) {
  const [title = "", ...body] = part.split("\n");
  promptSections.set(title.trim(), `## ${title.trim()}\n${body.join("\n").trim()}`);
}
const childSections: Record<string, string[]> = {
  lead: ["WORKERS", "RESEARCH LEADS", "SPEED (wall-clock time)", "EVIDENCE"],
  researcher: ["WORKERS", "SPEED (wall-clock time)", "EVIDENCE"],
  reviewer: ["WORKERS", "SPEED (wall-clock time)", "EVIDENCE", "REVIEW BOARD"],
};
/**
 * Instructions for one research role. The director gets everything; delegates
 * get only what they can act on (no budget, completion or delegation rules
 * they have no tools for), which is shorter on every request they make.
 */
export function researchPromptFor(role: string, canSpawn = false): string {
  const sections = childSections[role];
  if (role === "director" || !sections) return researchCompanyPrompt;
  const parts = sections
    .filter((name) => canSpawn || name !== "RESEARCH LEADS")
    .map((name) => promptSections.get(name))
    .filter(Boolean);
  const intro = `You are a ${role} in Kest Research, working for the director. The director owns the shared USD allowance, experiments, file edits and the final report; you investigate and return evidence. Never fabricate numbers, sources or citations. research_status shows remaining money; spend sparingly.`;
  return `<kest-research-company>\n${intro}\n\n${parts.join("\n\n")}\n</kest-research-company>`;
}

export type CompanyState = {
  version: 1;
  id: string;
  objective: string;
  requests: number;
  agents: number;
  maxRequests: number;
  maxAgents: number;
  maxDepth: number;
  parallel: number;
  maxMs: number;
  elapsedMs: number;
  status: "ready" | "running" | "paused" | "budget_exhausted" | "completed";
  cycles: number;
  reviews: number;
  /** Legacy fields retained only for loading older sessions; never enforced. */
  maxTokens: number | null;
  maxCostUsd: number | null;
  spentCostMicros: number;
  estimatedCostMicros: number;
  costRevision: number;
  untrackedCostRequests: number;
  costRates: Record<string, { input: number; output: number; cached?: number }>;
  fundingProposal?: string;
  /** Strict budget: the director never proposes extra funding and must conclude with the allowance it has. */
  strictBudget?: boolean;
  /** The user said "research this and publish it": LSI claim/post/publish actions need no per-call approval for this study. */
  autoPublish?: boolean;
  /** Strict studies get one automatic conclude-and-publish turn when the allowance runs out. */
  strictWrapUp?: boolean;
  finalReportPath?: string;
  inputTokens: number;
  outputTokens: number;
  estimatedTokens: number;
  untrackedRequests: number;
};
export function newCompany(objective: string): CompanyState {
  return {
    version: 1,
    id: crypto.randomUUID(),
    objective,
    requests: 0,
    agents: 0,
    // Deprecated: requests are counted for stats, never limited.
    // Legacy request/time/token totals are retained only for old checkpoints.
    maxRequests: Number.MAX_SAFE_INTEGER,
    maxAgents: Number.MAX_SAFE_INTEGER,
    maxDepth: 3,
    parallel: 5,
    maxMs: 30 * 60_000,
    elapsedMs: 0,
    status: "ready",
    cycles: 0,
    reviews: 0,
    maxTokens: null,
    maxCostUsd: null,
    spentCostMicros: 0,
    estimatedCostMicros: 0,
    costRevision: 0,
    untrackedCostRequests: 0,
    costRates: {},
    inputTokens: 0,
    outputTokens: 0,
    estimatedTokens: 0,
    untrackedRequests: 0,
  };
}
export class ResearchBudgetError extends Error {}
export class ResearchPricingError extends Error {}

export function parseCostBudget(value: string): number {
  const match = value
    .trim()
    .match(/^(?:\$(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\$)$/);
  const amount = match ? Number(match[1] ?? match[2]) : NaN;
  if (!Number.isFinite(amount) || amount < 0.01 || amount > 1_000_000)
    throw new Error(
      "Use a USD total such as /research budget 10$ (minimum $0.01).",
    );
  return amount;
}
export const costKey = (provider: string, model: string) =>
  JSON.stringify([provider, model]);
export function proposedFunding(current: number) {
  const additional = Math.max(1, Math.round(current * 0.5 * 100) / 100);
  return { additional, total: Math.round((current + additional) * 100) / 100 };
}
export const formatUsd = (micros: number) =>
  `$${(micros / 1_000_000).toFixed(4)}`;

export function tokenReservation(data: unknown, output: number) {
  // Conservative preflight headroom, not a model-specific tokenizer. Provider
  // usage replaces this reservation after the request completes. One token is
  // at least ~3 UTF-8 bytes of English or JSON, so bytes/3 still over-estimates;
  // reserving one token per byte priced requests at ~4.5x their real cost and
  // stopped studies with "cannot fit the next request" while money remained.
  return {
    input: Math.ceil(Buffer.byteLength(JSON.stringify(data), "utf8") / 3) + 512,
    output,
  };
}

// Windows can briefly deny replacement while a reader, indexer, or antivirus
// holds the destination. Keep the previous checkpoint intact and retry rename.
export async function replaceCheckpoint(
  temporary: string,
  destination: string,
  move: typeof rename = rename,
) {
  for (let attempt = 0; ; attempt++) {
    try {
      await move(temporary, destination);
      return;
    } catch (error: any) {
      if (attempt >= 8 || !["EPERM", "EACCES", "EBUSY"].includes(error.code))
        throw error;
      await Bun.sleep(Math.min(250, 10 * 2 ** attempt));
    }
  }
}
export function validateCompany(state: CompanyState): CompanyState {
  // Migrate checkpoints created before token budgets existed.
  if (state && typeof state === "object") {
    const legacyTokens =
      state.inputTokens === undefined ||
      state.outputTokens === undefined ||
      state.estimatedTokens === undefined;
    state.untrackedRequests ??= legacyTokens ? state.requests : 0;
    state.untrackedCostRequests ??=
      state.spentCostMicros === undefined ? state.requests : 0;
    state.maxCostUsd ??= null;
    state.spentCostMicros ??= 0;
    state.estimatedCostMicros ??= 0;
    state.costRevision ??= 0;
    state.costRates ??= {};
    state.maxTokens ??= null;
    state.inputTokens ??= 0;
    state.outputTokens ??= 0;
    state.estimatedTokens ??= 0;
  }
  const integer = (n: number, low: number, high: number) =>
    Number.isSafeInteger(n) && n >= low && n <= high;
  if (
    !state ||
    state.version !== 1 ||
    !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(state.id) ||
    typeof state.objective !== "string" ||
    state.objective.length > 100000 ||
    !integer(state.maxRequests, 1, Number.MAX_SAFE_INTEGER) ||
    !integer(state.requests, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(state.maxAgents, 1, Number.MAX_SAFE_INTEGER) ||
    !integer(state.agents, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(state.maxDepth, 1, 3) ||
    !integer(state.parallel, 1, 6) ||
    !integer(state.maxMs, 1000, 86400000) ||
    !Number.isFinite(state.elapsedMs) ||
    state.elapsedMs < 0 ||
    !integer(state.cycles, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(state.reviews, 0, Number.MAX_SAFE_INTEGER) ||
    (state.maxTokens !== null &&
      !integer(state.maxTokens, 1, Number.MAX_SAFE_INTEGER)) ||
    !integer(state.inputTokens, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(state.outputTokens, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(state.estimatedTokens, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(state.untrackedRequests, 0, Number.MAX_SAFE_INTEGER) ||
    (state.maxCostUsd !== null &&
      (!Number.isFinite(state.maxCostUsd) ||
        state.maxCostUsd < 0.01 ||
        state.maxCostUsd > 1_000_000)) ||
    !integer(state.spentCostMicros, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(state.estimatedCostMicros, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(state.costRevision, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(state.untrackedCostRequests, 0, Number.MAX_SAFE_INTEGER) ||
    !state.costRates ||
    typeof state.costRates !== "object" ||
    Array.isArray(state.costRates) ||
    Object.values(state.costRates).some(
      (rate) =>
        !rate ||
        typeof rate.input !== "number" ||
        typeof rate.output !== "number" ||
        !Number.isFinite(rate.input) ||
        !Number.isFinite(rate.output) ||
        rate.input < 0 ||
        rate.output < 0,
    ) ||
    !["ready", "running", "paused", "budget_exhausted", "completed"].includes(
      state.status,
    )
  )
    throw new Error(
      "Invalid saved research state. Start a new research run instead of resuming it.",
    );
  return state;
}
export async function recoverCompany(cwd: string, state: CompanyState) {
  validateCompany(state);
  try {
    const saved = validateCompany(
      JSON.parse(
        await readFile(join(cwd, "research", state.id, "state.json"), "utf8"),
      ),
    );
    if (saved.id !== state.id)
      throw new Error("Research checkpoint identity mismatch");
    for (const key of [
      "requests",
      "agents",
      "elapsedMs",
      "cycles",
      "reviews",
      "inputTokens",
      "outputTokens",
      "estimatedTokens",
      "untrackedRequests",
      "untrackedCostRequests",
    ] as const)
      state[key] = Math.max(state[key], saved[key]);
    // Reconciliation can reduce a reservation. Recover the ledger as one
    // revision, rather than adding stale reservations to already settled costs.
    if (saved.costRevision >= state.costRevision) {
      state.spentCostMicros = saved.spentCostMicros;
      state.estimatedCostMicros = saved.estimatedCostMicros;
      state.costRevision = saved.costRevision;
      state.costRates = { ...state.costRates, ...saved.costRates };
    }
    // A completion checkpoint may reach disk before the session is saved.
    // Recover terminal state too, so restarting never repeats a finished study.
    if (saved.status === "completed" && saved.finalReportPath) {
      state.status = "completed";
      state.finalReportPath = saved.finalReportPath;
    }
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
}
export class CompanyRuntime {
  private started = performance.now();
  private inFlight = 0;
  private tail: Promise<void> = Promise.resolve();
  private approvalTail: Promise<void> = Promise.resolve();
  readonly directory: string | null;
  constructor(
    readonly state: CompanyState,
    cwd?: string,
  ) {
    validateCompany(state);
    this.directory = cwd ? join(cwd, "research", state.id) : null;
  }
  liveElapsedMs() {
    return this.state.elapsedMs + performance.now() - this.started;
  }
  snapshot(): CompanyState {
    return { ...this.state, elapsedMs: this.liveElapsedMs() };
  }
  get costLimited() {
    return this.directory !== null || this.state.maxCostUsd !== null;
  }
  get usedCostMicros() {
    return this.state.spentCostMicros + this.state.estimatedCostMicros;
  }
  get remainingCostMicros() {
    if (!this.costLimited) return Infinity;
    return Math.max(
      0,
      Math.round((this.state.maxCostUsd ?? 0) * 1_000_000) -
        this.usedCostMicros,
    );
  }
  get budgetLow() {
    return (
      this.costLimited &&
      this.remainingCostMicros <=
        Math.round((this.state.maxCostUsd ?? 0) * 1_000_000 * 0.2)
    );
  }
  get usedTokens() {
    return (
      this.state.inputTokens +
      this.state.outputTokens +
      this.state.estimatedTokens
    );
  }
  // Compatibility accessors for old integrations. Time/tokens/requests no longer bind.
  get remainingMs() {
    return Infinity;
  }
  get remainingTokens() {
    return Infinity;
  }
  get remainingRequests() {
    return Infinity;
  }
  get directorReserve() {
    return 0;
  }
  async approve(approve: Approve, request: Approval, signal: AbortSignal) {
    const previous = this.approvalTail;
    let release!: () => void;
    this.approvalTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      return !signal.aborted && (await approve(request, signal));
    } finally {
      release();
    }
  }
  // Group commit: concurrent records share one append and one checkpoint
  // write. Every caller still resolves only after a write that contains its
  // event and a state snapshot taken at or after its call.
  private pending: string[] = [];
  async record(kind: string, data: unknown) {
    if (!this.directory) return;
    const directory = this.directory;
    this.pending.push(
      JSON.stringify({ at: new Date().toISOString(), kind, data }) + "\n",
    );
    const write = this.tail.then(async () => {
      const entries = this.pending.splice(0);
      if (!entries.length) return;
      try {
        const snapshot =
          JSON.stringify(
            {
              ...this.state,
              elapsedMs: this.state.elapsedMs + performance.now() - this.started,
            },
            null,
            2,
          ) + "\n";
        await mkdir(directory, { recursive: true });
        await appendFile(join(directory, "events.jsonl"), entries.join(""));
        const temporary = join(directory, `state.${crypto.randomUUID()}.tmp`);
        try {
          await writeFile(temporary, snapshot);
          await replaceCheckpoint(temporary, join(directory, "state.json"));
        } finally {
          await rm(temporary, { force: true });
        }
      } catch (error) {
        // Keep the events for the next write instead of losing them.
        this.pending.unshift(...entries);
        throw error;
      }
    });
    // Report this failure to its caller, but allow later writes/checkpoints to
    // recover. A single failed write must not poison every sibling worker.
    this.tail = write.catch(() => {});
    await write;
  }
  addAgent(depth: number, reviewer = false) {
    if (depth > this.state.maxDepth)
      throw new ResearchBudgetError("Research delegation depth reached.");
    // The director allocates paid work; depth and simultaneous calls remain bounded.
    this.state.agents++;
  }
  async acquire(
    provider: string,
    model: string,
    signal: AbortSignal,
    agent?: { id: string; depth: number; role?: string },
    reservation = { input: 0, output: 0 },
  ): Promise<(usage?: { input: number; output: number; cached?: number }) => void> {
    const reserved = reservation.input + reservation.output;
    if (
      !Number.isSafeInteger(reserved) ||
      !Number.isSafeInteger(reservation.input) ||
      !Number.isSafeInteger(reservation.output) ||
      reserved < 0 ||
      reservation.input < 0 ||
      reservation.output < 0
    )
      throw new Error("Invalid token reservation.");
    if (this.costLimited && this.state.maxCostUsd === null)
      throw new ResearchPricingError(
        "Set a research budget first: /research budget 10$",
      );
    const key = costKey(provider, model);
    let rate = this.state.costRates[key];
    if (this.costLimited && !rate) {
      const published =
        provider === "custom" ? null : modelPricing(provider, model);
      if (!published)
        throw new ResearchPricingError(
          `Input/output pricing is unknown for ${provider}/${model}; no paid request was dispatched. Select a model with configured pricing.`,
        );
      rate = {
        input: published.inputUsdPerMillionTokens,
        output: published.outputUsdPerMillionTokens,
        ...(published.cachedInputUsdPerMillionTokens !== undefined
          ? { cached: published.cachedInputUsdPerMillionTokens }
          : {}),
      };
      this.state.costRates[key] = rate;
    }
    if (this.costLimited && !reserved)
      throw new ResearchBudgetError(
        "A cost budget requires preflight input/output headroom.",
      );
    const reserveCost = rate
      ? Math.ceil(
          reservation.input * rate.input + reservation.output * rate.output,
        )
      : 0;
    // Workers leave 20% for director experiments and independent review.
    const protectedCost =
      this.costLimited && (agent?.depth ?? 0) > 0 && agent?.role !== "reviewer"
        ? Math.round((this.state.maxCostUsd ?? 0) * 1_000_000 * 0.2)
        : 0;
    while (
      this.inFlight >= this.state.parallel ||
      (this.inFlight > 0 &&
        reserveCost > this.remainingCostMicros - protectedCost)
    ) {
      signal.throwIfAborted();
      await Bun.sleep(10);
    }
    signal.throwIfAborted();
    if (reserveCost > this.remainingCostMicros - protectedCost)
      throw new ResearchBudgetError(
        `Research cost budget cannot fit the next request (${formatUsd(reserveCost)} reserved; ${formatUsd(this.remainingCostMicros)} available${protectedCost ? "; director/review reserve protected" : ""}). Existing artifacts are preserved.`,
      );
    // Reserve synchronously before any await so parallel workers cannot overspend.
    this.state.requests++;
    this.inFlight++;
    // Persist unresolved reservations before dispatch so a crash cannot reset
    // the token allowance of requests whose final usage was never observed.
    this.state.estimatedTokens += reserved;
    this.state.estimatedCostMicros += reserveCost;
    this.state.costRevision++;
    try {
      await this.record("model_request", {
        provider,
        model,
        request: this.state.requests,
        agent,
        reservation,
        reservedCostMicros: reserveCost,
        rate,
      });
    } catch (error) {
      this.inFlight--;
      this.state.estimatedTokens -= reserved;
      this.state.estimatedCostMicros -= reserveCost;
      this.state.costRevision++;
      throw error;
    }
    let released = false;
    return (usage) => {
      if (!released) {
        released = true;
        this.inFlight--;
        if (
          usage &&
          Number.isSafeInteger(usage.input) &&
          Number.isSafeInteger(usage.output) &&
          usage.input >= 0 &&
          usage.output >= 0
        ) {
          this.state.estimatedTokens -= reserved;
          this.state.estimatedCostMicros -= reserveCost;
          this.state.costRevision++;
          // Cache hits are a subset of the input; they bill at the cached rate only when one is published.
          const cached =
            rate?.cached !== undefined &&
            Number.isSafeInteger(usage.cached) &&
            usage.cached! > 0
              ? Math.min(usage.cached!, usage.input)
              : 0;
          this.state.spentCostMicros += rate
            ? Math.ceil(
                (usage.input - cached) * rate.input +
                  cached * (rate.cached ?? rate.input) +
                  usage.output * rate.output,
              )
            : 0;
          this.state.inputTokens += usage.input;
          this.state.outputTokens += usage.output;
        } // Otherwise retain the persisted estimate; missing usage is not free.
      }
    };
  }
  /** Same formula everywhere so the UI can offer exactly what the proposal says. */
  proposedFunding() {
    return proposedFunding(this.state.maxCostUsd ?? 0);
  }
  async saveFundingProposal(reason: string): Promise<string> {
    this.state.status = "budget_exhausted";
    if (this.state.strictBudget) {
      const spentStrict = formatUsd(this.state.spentCostMicros + this.state.estimatedCostMicros);
      const note = `Strict budget: ${spentStrict} of $${(this.state.maxCostUsd ?? 0).toFixed(2)} used. No extra funding is requested; the study concludes with what it has.`;
      this.state.fundingProposal = undefined;
      await this.record("strict_budget_reached", { reason });
      return note;
    }
    const { additional, total: proposed } = this.proposedFunding();
    const spent = formatUsd(this.state.spentCostMicros + this.state.estimatedCostMicros);
    const text = `Budget reached: ${spent} of $${(this.state.maxCostUsd ?? 0).toFixed(2)} used. Study incomplete (${reason.replace(/\s+/g, " ").slice(0, 120)}).
Add $${additional.toFixed(2)} (new total $${proposed.toFixed(2)}) and continue?  yes / no
No = wrap up and publish what exists to LSI.
`;
    // Keep a detailed director-authored proposal if it already exists.
    if (this.directory) {
      await mkdir(this.directory, { recursive: true });
      const file = join(this.directory, "funding-proposal.md");
      try {
        await writeFile(file, text, { flag: "wx" });
      } catch (error: any) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    this.state.fundingProposal = text;
    await this.record("funding_proposal", {
      reason,
      proposedTotalUsd: proposed,
    });
    return `Further funding requested. Inspect research/${this.state.id}/funding-proposal.md.\n${text}`;
  }
  async finish(status: CompanyState["status"]) {
    this.state.elapsedMs += performance.now() - this.started;
    this.started = performance.now();
    this.state.status = status;
    await this.record("checkpoint", { status });
  }
}
export function formatCompany(state?: CompanyState | null) {
  if (!state)
    return "No research run yet. /research start <objective> (or /research <objective>) starts a budgeted company workflow.";
  validateCompany(state);
  const used = state.spentCostMicros + state.estimatedCostMicros;
  const remaining =
    state.maxCostUsd === null
      ? null
      : Math.max(0, Math.round(state.maxCostUsd * 1_000_000) - used);
  return `Kest Research · ${researchStatus(state)}\nObjective: ${state.objective}\nCost budget: ${state.maxCostUsd === null ? "not set — /research budget 10$" : `$${state.maxCostUsd.toFixed(2)} USD`}\nUsed: ${formatUsd(used)}${remaining === null ? "" : ` · Remaining: ${formatUsd(remaining)}`}\nReported: ${formatUsd(state.spentCostMicros)} · reserved/unreported: ${formatUsd(state.estimatedCostMicros)}\nRequests: ${state.requests} · delegates: ${state.agents} · reviews returned: ${state.reviews}\nArtifacts: research/${state.id}/${state.finalReportPath ? `\nReport: ${state.finalReportPath}` : ""}\nNext: ${researchNextAction(state)}\nCosts use estimated model rates.${state.untrackedCostRequests ? ` ${state.untrackedCostRequests} earlier requests have unknown costs, excluded from this allowance.` : ""}`;
}

export function researchStatus(state: CompanyState): string {
  return state.status === "ready"
    ? "prepared (not started)"
    : state.status === "budget_exhausted"
      ? "needs funding"
      : state.status;
}

export function researchNextAction(state: CompanyState): string {
  if (state.status === "completed")
    return state.finalReportPath
      ? `read ${state.finalReportPath}`
      : "read the saved report";
  if (state.maxCostUsd === null) return "/research budget 10$";
  if (
    state.status === "budget_exhausted" ||
    state.spentCostMicros + state.estimatedCostMicros >=
      Math.round(state.maxCostUsd * 1_000_000)
  )
    return "answer yes (add funds, continue) or no (wrap up and publish to LSI)";
  if (state.status === "running")
    return "Esc to pause · /agents to inspect workers";
  return state.status === "ready" ? "/research start" : "/research resume";
}
