import {
  mkdir,
  appendFile,
  writeFile,
  rename,
  readFile,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import type { Approve, Approval } from "./tools";

import companyInstructions from "../prompts/research-company.md" with { type: "text" };
export const researchCompanyPrompt = `<kest-research-company>\n${companyInstructions}\n</kest-research-company>`;

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
  status: "ready" | "running" | "paused" | "budget_exhausted";
  cycles: number;
  reviews: number;
  maxTokens: number | null;
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
    // Only token (maxTokens) and time (maxMs) budgets bind.
    maxRequests: Number.MAX_SAFE_INTEGER,
    maxAgents: 12,
    maxDepth: 3,
    parallel: 3,
    maxMs: 30 * 60_000,
    elapsedMs: 0,
    status: "ready",
    cycles: 0,
    reviews: 0,
    maxTokens: null,
    inputTokens: 0,
    outputTokens: 0,
    estimatedTokens: 0,
    untrackedRequests: 0,
  };
}
export class ResearchBudgetError extends Error {}

export function parseTokenBudget(value: string): number {
  const match = value
    .trim()
    .replace(/[,_]/g, "")
    .match(/^(\d+(?:\.\d+)?)\s*([kmbt]?)$/i);
  const amount = match
    ? Number(match[1]) *
      ({ "": 1, k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[match[2]!.toLowerCase()] ?? 1)
    : NaN;
  if (!Number.isSafeInteger(amount) || amount < 1)
    throw new Error("Use a positive token total such as 500k, 10m or 500b.");
  return amount;
}
export function tokenReservation(data: unknown, output: number) {
  // Conservative preflight headroom, not a model-specific tokenizer. Provider
  // usage replaces this reservation after the request completes.
  return {
    input: Buffer.byteLength(JSON.stringify(data), "utf8") + 1024,
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
    !integer(state.requests, 0, 10000) ||
    !integer(state.maxAgents, 1, 64) ||
    !integer(state.agents, 0, 64) ||
    !integer(state.maxDepth, 1, 3) ||
    !integer(state.parallel, 1, 3) ||
    !integer(state.maxMs, 1000, 86400000) ||
    !Number.isFinite(state.elapsedMs) ||
    state.elapsedMs < 0 ||
    !integer(state.cycles, 0, 10000) ||
    !integer(state.reviews, 0, 64) ||
    (state.maxTokens !== null &&
      !integer(state.maxTokens, 1, Number.MAX_SAFE_INTEGER)) ||
    !integer(state.inputTokens, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(state.outputTokens, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(state.estimatedTokens, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(state.untrackedRequests, 0, 10000) ||
    !["ready", "running", "paused", "budget_exhausted"].includes(state.status)
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
    ] as const)
      state[key] = Math.max(state[key], saved[key]);
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
  get remainingMs() {
    return Math.max(
      0,
      this.state.maxMs -
        this.state.elapsedMs -
        (performance.now() - this.started),
    );
  }
  get remainingRequests() {
    return Infinity; // requests are metered, not limited
  }
  // Low when <10% of time or token budget remains (drives final-review).
  get budgetLow() {
    const timeLow = this.remainingMs <= Math.max(60_000, this.state.maxMs * 0.1);
    const tokenLow =
      this.state.maxTokens !== null &&
      this.remainingTokens <= this.state.maxTokens * 0.1;
    return timeLow || tokenLow;
  }
  get usedTokens() {
    return (
      this.state.inputTokens +
      this.state.outputTokens +
      this.state.estimatedTokens
    );
  }
  get remainingTokens() {
    return this.state.maxTokens === null
      ? Infinity
      : Math.max(0, this.state.maxTokens - this.usedTokens);
  }
  get directorReserve() {
    // Research workers must leave real room for implementation and experiments,
    // in addition to the final review. Ordinary transient delegates retain the
    // smaller reconciliation reserve.
    return this.directory
      ? Math.max(2, Math.min(30, Math.floor(this.state.maxRequests * 0.3)))
      : 2;
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
  async record(kind: string, data: unknown) {
    if (!this.directory) return;
    const directory = this.directory;
    const entry =
      JSON.stringify({ at: new Date().toISOString(), kind, data }) + "\n";
    const snapshot =
      JSON.stringify(
        {
          ...this.state,
          elapsedMs: this.state.elapsedMs + performance.now() - this.started,
        },
        null,
        2,
      ) + "\n";
    const write = this.tail.then(async () => {
      await mkdir(directory, { recursive: true });
      await appendFile(join(directory, "events.jsonl"), entry);
      const temporary = join(directory, `state.${crypto.randomUUID()}.tmp`);
      try {
        await writeFile(temporary, snapshot);
        await replaceCheckpoint(temporary, join(directory, "state.json"));
      } finally {
        await rm(temporary, { force: true });
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
    if (this.state.agents >= this.state.maxAgents - (reviewer ? 0 : 1))
      throw new ResearchBudgetError("Research agent budget reached.");
    this.state.agents++;
  }
  async acquire(
    provider: string,
    model: string,
    signal: AbortSignal,
    agent?: { id: string; depth: number; role?: string },
    reservation = { input: 0, output: 0 },
  ): Promise<(usage?: { input: number; output: number }) => void> {
    const reserved = reservation.input + reservation.output;
    if (
      !Number.isSafeInteger(reserved) ||
      reserved < 0 ||
      reservation.input < 0 ||
      reservation.output < 0
    )
      throw new Error("Invalid token reservation.");
    if (this.state.maxTokens !== null && !reserved)
      throw new ResearchBudgetError(
        "A token budget requires preflight input/output headroom.",
      );
    while (
      this.inFlight >= this.state.parallel ||
      (this.inFlight > 0 && reserved > this.remainingTokens)
    ) {
      signal.throwIfAborted();
      if (!this.remainingMs)
        throw new ResearchBudgetError("Research time budget reached.");
      await Bun.sleep(10);
    }
    signal.throwIfAborted();
    if (!this.remainingMs)
      throw new ResearchBudgetError(
        "Research time budget reached. Checkpoint the findings; no further model requests were started.",
      );
    if (reserved > this.remainingTokens)
      throw new ResearchBudgetError(
        `Research token budget cannot fit the next request (${reserved.toLocaleString("en-US")} tokens of conservative headroom required; ${this.remainingTokens.toLocaleString("en-US")} available). Existing artifacts are preserved.`,
      );
    // Reserve synchronously before any await so parallel workers cannot overspend.
    this.state.requests++;
    this.inFlight++;
    // Persist unresolved reservations before dispatch so a crash cannot reset
    // the token allowance of requests whose final usage was never observed.
    this.state.estimatedTokens += reserved;
    try {
      await this.record("model_request", {
        provider,
        model,
        request: this.state.requests,
        agent,
        reservation,
      });
    } catch (error) {
      this.inFlight--;
      this.state.estimatedTokens -= reserved;
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
          this.state.inputTokens += usage.input;
          this.state.outputTokens += usage.output;
        } // Otherwise retain the persisted estimate; missing usage is not free.
      }
    };
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
  const used = state.inputTokens + state.outputTokens + state.estimatedTokens;
  let tokens = `Tokens: ${used.toLocaleString("en-US")}/${state.maxTokens === null ? "no token cap" : state.maxTokens.toLocaleString("en-US")} · input ${state.inputTokens.toLocaleString("en-US")} + output ${state.outputTokens.toLocaleString("en-US")} + estimated ${state.estimatedTokens.toLocaleString("en-US")} (pending/missing provider usage)`;
  if (state.untrackedRequests)
    tokens += `\n${state.untrackedRequests} earlier requests predate token accounting; their token usage is unknown and excluded.`;
  return `Kest Research · ${state.status}\nObjective: ${state.objective}\n${tokens}\n${state.maxTokens === null ? "" : "Additional safeguards remain active:\n"}Requests: ${state.requests} (metered only — no request limit; token + time budgets bind)\nAgents: ${state.agents}/${state.maxAgents} · max depth ${state.maxDepth} · max parallel model calls ${state.parallel}\nIndependent reviews returned: ${state.reviews} (model reviews, not empirical certification)\nActive time: ${(state.elapsedMs / 60_000).toFixed(1)}/${(state.maxMs / 60_000).toFixed(1)} minutes · cycles ${state.cycles}\nArtifacts: research/${state.id}/\n/research resume · /research tokens <total|off> · /research budget <minutes> [total-agents] · /research models`;
}
