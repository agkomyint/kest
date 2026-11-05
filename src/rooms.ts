import { foldWorker, teamHead, workerRow, type WorkerStat } from "./team-view";
import type { Agent, AgentEvent } from "./agent";
import type { Approval } from "./tools";
import type { Session } from "./sessions";
import type { BrowserSession } from "./browser";
import type { CompanyState } from "./research-company";
import { money } from "./research-hud";

export type RoomKind = "chat" | "study";
export type RoomStatus =
  | "chat"
  | "ready"
  | "running"
  | "needs-you"
  | "paused"
  | "budget"
  | "done";

type PendingApproval = {
  request: Approval;
  resolve: (approved: boolean) => void;
};

/** A message for the transcript that is not an agent event (errors, stop notices). */
export type RoomNote = { type: "note"; text: string };
export type BufferItem = AgentEvent | RoomNote;

/** Events produced while a room is not on screen, replayed when it is opened. */
export class EventBuffer {
  private events: BufferItem[] = [];
  dropped = 0;
  constructor(private readonly cap = 4000) {}
  get length() {
    return this.events.length;
  }
  push(event: BufferItem) {
    const last = this.events.at(-1);
    // Streaming text arrives as many tiny deltas; keep one event per run of text.
    if (event.type === "text" && last?.type === "text") {
      last.delta += event.delta;
      return;
    }
    this.events.push(event);
    if (this.events.length > this.cap) {
      // Drop the oldest events; the durable log is research/<id>/events.jsonl.
      const drop = this.events.length - this.cap;
      this.events.splice(0, drop);
      this.dropped += drop;
    }
  }
  drain(): { events: BufferItem[]; dropped: number } {
    const result = { events: this.events, dropped: this.dropped };
    this.events = [];
    this.dropped = 0;
    return result;
  }
}

export class Room {
  /** Non-null exactly while a turn is running in this room. */
  controller: AbortController | null = null;
  readonly buffer = new EventBuffer();
  readonly pending: PendingApproval[] = [];
  /** Direction typed by the user while the director is running. */
  readonly notes: string[] = [];
  /** Set when a turn ends and the director is waiting for the user. */
  question: string | null = null;
  /** Text of the director's latest reply, for the needs-you line. */
  lastText = "";
  startedAt = 0;
  /** Workers this study has started, by state, for the "3 of 5 workers" part of its row. */
  readonly workers = new Map<string, WorkerStat>();
  /** Whether the pinned card lists the team's workers (^T toggles). */
  teamOpen = true;
  track(event: AgentEvent) {
    if (event.type === "worker") foldWorker(this.workers, event as never, performance.now());
  }
  /** Where the study is: planning, researching, in review, or reported. Read from the workers started. */
  get phase(): 0 | 1 | 2 | 3 {
    if (this.research?.status === "completed") return 3;
    const roles = [...this.workers.values()].map((w) => w.role.toLowerCase());
    if (roles.some((r) => r.includes("review"))) return 2;
    return roles.length ? 1 : 0;
  }
  /** Workers working now and workers started this run. Stale "running" marks do not count once the turn ended. */
  get workerCounts() {
    const states = [...this.workers.values()].map((w) => w.state);
    return { running: this.running ? states.filter((v) => v === "running").length : 0, total: states.length };
  }
  constructor(
    readonly id: string,
    readonly kind: RoomKind,
    public session: Session,
    public agent: Agent,
    readonly browser: BrowserSession,
  ) {}

  /** The research state of this room, including a chat that has research switched on. */
  get research(): CompanyState | null {
    return this.study ?? this.agent.research ?? this.session.research ?? null;
  }

  get study(): CompanyState | null {
    return this.kind === "study"
      ? (this.agent.research ?? this.session.research ?? null)
      : null;
  }
  get running() {
    return this.controller !== null;
  }
  get title() {
    if (this.kind === "chat") return "chat";
    const text = (this.study?.objective ?? this.session.title).replace(
      /\s+/g,
      " ",
    );
    return text.length > 28 ? `${text.slice(0, 27)}…` : text;
  }
  get needsYou() {
    return this.pending.length > 0 || this.question !== null;
  }
  get status(): RoomStatus {
    if (this.kind === "chat") return "chat";
    if (this.needsYou) return "needs-you";
    const study = this.study;
    if (!study) return "ready";
    if (study.status === "completed") return "done";
    if (study.status === "budget_exhausted") return "budget";
    if (this.running) return "running";
    if (study.status === "ready") return "ready";
    return "paused";
  }
  /** Ask the user for approval. Resolves when they answer, or false if aborted. */
  queueApproval(request: Approval, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve(false);
      const entry: PendingApproval = { request, resolve };
      this.pending.push(entry);
      signal.addEventListener(
        "abort",
        () => {
          const index = this.pending.indexOf(entry);
          if (index >= 0) this.pending.splice(index, 1);
          resolve(false);
        },
        { once: true },
      );
    });
  }
  nextApproval(): PendingApproval | undefined {
    return this.pending.shift();
  }
}

export type RoomLimits = {
  /** Maximum studies running at once. */
  maxRunning: number;
  /** Total USD allowance across all studies; null means unlimited. */
  totalUsd: number | null;
};

export const defaultLimits: RoomLimits = { maxRunning: 3, totalUsd: null };

export function studySpentUsd(study: CompanyState | null): number {
  return study
    ? (study.spentCostMicros + study.estimatedCostMicros) / 1_000_000
    : 0;
}

const PHASES = ["plan", "research", "review", "report"];
const BAR = 20;

/**
 * The pinned card above a study's transcript: objective, status and time; money as a bar;
 * the phase strip; and what the study needs from the user. Empty for the chat room.
 * Two rows on narrow terminals, four on wide ones.
 */
export function studyCard(room: Room, width: number, now: number): string[] {
  const study = room.research;
  if (!study) return [];
  const spent = studySpentUsd(study);
  const cap = study.maxCostUsd;
  const status: RoomStatus = room.kind === "study" ? room.status : room.needsYou ? "needs-you" : study.status === "completed" ? "done" : study.status === "budget_exhausted" ? "budget" : room.running ? "running" : study.status === "ready" ? "ready" : "paused";
  const age = room.startedAt && room.running ? ` ${clockText(now - room.startedAt)}` : "";
  const { running, total } = room.workerCounts;
  const crew = room.running && total ? ` · ${running} of ${total} workers` : "";
  const objective = (study.objective ?? room.session.title).replace(/\s+/g, " ");
  const money = cap === null ? `$${spent.toFixed(2)}` : `$${spent.toFixed(2)} of $${cap.toFixed(2)}`;
  const state = `${statusSymbol(status)} ${statusWord(status)}${age}`;
  const needs = room.pending.length
    ? `needs you: approve ${room.pending[0]!.request}${room.pending.length > 1 ? ` (+${room.pending.length - 1})` : ""}`
    : room.question
      ? `needs you: ${room.question.replace(/\s+/g, " ")}`
      : "";
  const needsRow = needs ? [clip(`▲ ${needs}`, width).trimEnd()] : [];
  if (width < 80) {
    const short = cap === null ? `$${spent.toFixed(2)}` : `$${spent.toFixed(2)}/$${cap.toFixed(2)}`;
    const line = `${statusSymbol(status)}${age} ${short}${room.running && total ? ` ${running}/${total}w` : ""} ${objective}`;
    return [clip(line, width).trimEnd(), ...needsRow];
  }
  const filled = cap ? Math.min(BAR, Math.round((spent / cap) * BAR)) : 0;
  const pct = cap ? ` ${Math.min(999, Math.round((spent / cap) * 100))}%` : "";
  const bar = cap ? `${"█".repeat(filled)}${"░".repeat(BAR - filled)}${pct}` : "";
  const phase = room.phase;
  const strip = PHASES.map((name, i) => `${i < phase || status === "done" ? "✓" : i === phase ? (room.running ? "●" : "◐") : "○"} ${name}`).join(" → ");
  return [
    clip(`${state}  ${objective}`, width).trimEnd(),
    clip(`${money}  ${bar}${crew}`, width).trimEnd(),
    clip(`phase  ${strip}`, width).trimEnd(),
    ...teamRows(room, width, now),
    ...needsRow,
  ];
}

/** Pinned team block: its head, then up to four live workers; finished ones are summarised. */
function teamRows(room: Room, width: number, now: number): string[] {
  const all = [...room.workers.values()];
  if (!all.length || !room.teamOpen || (!room.running && !all.some((w) => w.state === "error"))) return [];
  const live = all.filter((w) => w.state === "running" || w.state === "error");
  const shown = live.slice(0, 4);
  const base = Math.min(...all.map((w) => w.depth));
  const rows = [teamHead(all, 1, now), ...shown.map((w) => `  ${workerRow(w, now, base)}`)];
  if (live.length > shown.length) rows.push(`  … ${live.length - shown.length} more running`);
  return rows.map((r) => clip(r, width).trimEnd());
}

const statusWord = (status: RoomStatus) =>
  ({ chat: "chat", "needs-you": "needs you", budget: "out of budget", running: "running", paused: "paused", ready: "ready", done: "done" })[status];
const clockText = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}` : `${s}s`;
};

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private focusedId: string | null = null;
  limits: RoomLimits = { ...defaultLimits };

  add(room: Room) {
    this.rooms.set(room.id, room);
    this.focusedId ??= room.id;
    return room;
  }
  remove(id: string) {
    this.rooms.delete(id);
    if (this.focusedId === id)
      this.focusedId = this.rooms.keys().next().value ?? null;
  }
  get(id: string) {
    return this.rooms.get(id);
  }
  get focused(): Room | null {
    return this.focusedId ? (this.rooms.get(this.focusedId) ?? null) : null;
  }
  focus(id: string): Room {
    const room = this.rooms.get(id);
    if (!room) throw new Error("No such room.");
    this.focusedId = id;
    return room;
  }
  list(): Room[] {
    return [...this.rooms.values()];
  }
  studies(): Room[] {
    return this.list().filter((room) => room.kind === "study");
  }
  running(): Room[] {
    return this.studies().filter((room) => room.running);
  }
  /** Rooms that want the user, most recently asked first is not needed: order is stable. */
  needingYou(): Room[] {
    return this.list().filter((room) => room.needsYou);
  }
  totalSpentUsd(): number {
    return this.studies().reduce(
      (sum, room) => sum + studySpentUsd(room.study),
      0,
    );
  }
  /** Why a study may not start now, or null if it may. */
  startBlocker(room: Room): string | null {
    if (room.running) return "This study is already running.";
    const others = this.running().filter((r) => r.id !== room.id).length;
    if (others >= this.limits.maxRunning)
      return `${others} studies are already running (limit ${this.limits.maxRunning}). Pause one first, or raise the limit with /research parallel <n>.`;
    const cap = this.limits.totalUsd;
    if (cap !== null && this.totalSpentUsd() >= cap)
      return `Total research allowance $${cap.toFixed(2)} is used up. Raise it with /research total <amount>$.`;
    return null;
  }
  /** Rooms to pause because the combined spend has reached the allowance. */
  overAllowance(): Room[] {
    const cap = this.limits.totalUsd;
    if (cap === null || this.totalSpentUsd() < cap) return [];
    return this.running();
  }
  /** Lowest-case fuzzy match on study title, objective or id prefix. */
  find(query: string): Room[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.studies();
    const words = q.split(/\s+/);
    return this.studies().filter((room) => {
      const hay = `${room.study?.id ?? ""} ${room.session.id} ${room.study?.objective ?? ""} ${room.session.title}`.toLowerCase();
      return words.every((word) => hay.includes(word));
    });
  }
}

const symbols: Record<RoomStatus, string> = {
  chat: "▣",
  ready: "○",
  running: "●",
  "needs-you": "▲",
  paused: "⏸",
  budget: "⊘",
  done: "✓",
};
export const statusSymbol = (status: RoomStatus) => symbols[status];

/** One-line tab strip. The focused room is bracketed. */
export function companyBar(manager: RoomManager, width: number): string {
  const rooms = manager.list();
  const focused = manager.focused;
  const parts = rooms.map((room) => {
    const study = room.study;
    const spend =
      study && study.maxCostUsd !== null
        ? ` ${money(studySpentUsd(study))}/${study.maxCostUsd}`
        : "";
    const flag = room.status === "needs-you" ? " needs you" : "";
    const label = `${statusSymbol(room.status)} ${room.title}${spend}${flag}`;
    return room === focused ? `[${label}]` : ` ${label} `;
  });
  const line = parts.join("│");
  return line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line;
}

const rank: Record<RoomStatus, number> = {
  chat: 0,
  "needs-you": 1,
  budget: 2,
  running: 3,
  paused: 4,
  ready: 5,
  done: 6,
};
/** Rooms in display order: chat first, then what needs you most, down to finished studies. */
export function roomOrder(manager: RoomManager): Room[] {
  return manager
    .list()
    .map((room, index) => ({ room, index }))
    .sort((a, b) => rank[a.room.status] - rank[b.room.status] || a.index - b.index)
    .map((entry) => entry.room);
}

const clip = (text: string, width: number) =>
  text.length <= width ? text.padEnd(width) : `${text.slice(0, Math.max(0, width - 1))}…`;

const stateSymbols: [RoomStatus, string][] = [
  ["needs-you", "▲"],
  ["budget", "⊘"],
  ["running", "●"],
  ["paused", "⏸"],
  ["ready", "○"],
  ["done", "✓"],
];
const clock = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds >= 3600
    ? `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}`
    : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}`;
};
const meter = (spent: number, budget: number, cells = 5) => {
  const filled = Math.min(cells, Math.max(0, Math.round((spent / budget) * cells)));
  return "█".repeat(filled) + "░".repeat(cells - filled);
};
const fullTitle = (room: Room) =>
  room.kind === "chat" ? "chat" : (room.study?.objective ?? room.session.title).replace(/\s+/g, " ");

/**
 * The room list drawn under the prompt: a header with live counts and total spend, then one
 * row per room, most urgent first (needs you, out of budget, running, paused, ready, done).
 * Finished and idle rows fold into one summary line when space is short; a window around the
 * focused room is the last resort. `targets[i]` is the room a click on line i opens.
 */
export function roomList(
  manager: RoomManager,
  width: number,
  maxRows = 5,
  now = performance.now(),
  note = "",
): { lines: string[]; targets: (Room | null)[] } {
  const ordered = roomOrder(manager);
  if (ordered.length < 2) return { lines: [], targets: [] };
  const studies = ordered.filter((room) => room.kind === "study");
  const count = (status: RoomStatus) => studies.filter((room) => room.status === status).length;
  const words: Record<string, string> = { "needs-you": "need you", budget: "out of budget", running: "running", paused: "paused", ready: "ready", done: "done" };
  const present = stateSymbols.filter(([status]) => count(status));
  const spent = manager.totalSpentUsd();
  const cap = manager.limits.totalUsd;
  const summary = `${note ? ` · ${note}` : ""} · ${studies.length} stud${studies.length === 1 ? "y" : "ies"} · ${money(spent)}${cap !== null ? ` of ${money(cap)}` : ""} spent`;
  const wordy = present.map(([status, symbol]) => `${symbol}${count(status)} ${words[status]}`).join(" · ");
  const compact = present.map(([status, symbol]) => `${symbol}${count(status)}`).join(" ");
  // Words when they fit next to the hint, bare symbols otherwise.
  const hintWidth = 24;
  const active = present.filter(([status]) => status !== "ready" && status !== "done");
  const idle = studies.length - active.reduce((n, [status]) => n + count(status), 0);
  const medium = `${active.map(([status, symbol]) => `${symbol}${count(status)} ${words[status]}`).join(" · ")}${idle ? `${active.length ? " · " : ""}${idle} idle` : ""}`;
  const fits = (head: string) => width >= head.length + summary.length + hintWidth + 4;
  const header = `${fits(wordy) ? wordy : fits(medium) ? medium : compact}${summary}`;
  const hint = "Alt+↑↓ rooms · ^K list";
  const headerLine = width >= header.length + hint.length + 6 ? `  ${header}${" ".repeat(width - header.length - hint.length - 2)}${hint}` : `  ${header}`;
  const lines: string[] = [clip(headerLine, width).trimEnd()];
  const targets: (Room | null)[] = [null];
  if (studies.every((room) => room.status === "done")) return { lines, targets };

  const rows = Math.max(1, maxRows - 1);
  let shown = ordered;
  let tail: Room[] = [];
  if (shown.length > rows) {
    // Fold idle and finished studies (never the focused room) into one summary line.
    const foldable = (room: Room) => (room.status === "ready" || room.status === "done") && room !== manager.focused;
    tail = shown.filter(foldable);
    if (tail.length) shown = shown.filter((room) => !foldable(room));
  }
  let summaryRows = tail.length ? 1 : 0;
  let more = 0;
  if (shown.length > rows - summaryRows) {
    // Still too many: drop the summary and window over everything instead.
    if (tail.length) {
      shown = ordered;
      tail = [];
      summaryRows = 0;
    }
  }
  if (shown.length > rows - summaryRows) {
    const size = Math.max(1, rows - summaryRows - 1);
    const focusedAt = Math.max(0, shown.indexOf(manager.focused as Room));
    const start = Math.min(Math.max(0, focusedAt - Math.floor(size / 2)), shown.length - size);
    more = shown.length - size;
    shown = shown.slice(start, start + size);
  }
  for (const room of shown) {
    const study = room.study;
    const spentUsd = studySpentUsd(study);
    const budget = study && study.maxCostUsd !== null ? study.maxCostUsd : null;
    const money_ = budget !== null ? `${money(spentUsd)} of ${money(budget)}` : "";
    const crew = room.workerCounts;
    const crewText = room.kind === "study" && crew.total ? ` · ${crew.running ? `${crew.running} of ${crew.total} workers` : `${crew.total} workers`}` : "";
    const status = room.status === "needs-you" ? "needs you" : room.status === "budget" ? "out of budget" : room.status;
    const marker = room === manager.focused ? "▸" : " ";
    const live = room.status === "running" && room.startedAt ? ` ${clock(now - room.startedAt)}` : "";
    const bar = budget !== null && width >= 70 && room.kind === "study" ? `${meter(spentUsd, budget)} ` : "";
    const tailText =
      room.kind === "chat"
        ? ""
        : width >= 52
          ? `  ${status}${live}${width >= 70 ? crewText : ""}  ${bar}${money_}`.trimEnd()
          : money_
            ? ` ${money_}`
            : "";
    const titleWidth = Math.max(8, width - 6 - tailText.length);
    const ask =
      room.status === "needs-you" && room !== manager.focused
        ? room.pending[0]?.request.title
          ? ` · wants approval: ${room.pending[0].request.title}`
          : room.question
            ? ` · says: ${room.question.replace(/\s+/g, " ")}`
            : ""
        : "";
    lines.push(`${marker} ${statusSymbol(room.status)} ${clip(`${fullTitle(room)}${ask}`, titleWidth)}${tailText}`.trimEnd());
    targets.push(room);
  }
  if (tail.length) {
    const ready = tail.filter((room) => room.status === "ready").length;
    const done = tail.length - ready;
    const bits = [ready ? `○ ${ready} ready` : "", done ? `✓ ${done} done` : ""].filter(Boolean).join("  ·  ");
    lines.push(clip(`  ${bits}  ·  ^K all`, width).trimEnd());
    targets.push(null);
  }
  if (more) {
    lines.push(`  … +${more} more · ^K`);
    targets.push(null);
  }
  return { lines, targets };
}

/**
 * One line per room for the ^K picker: the same urgency order and wording as the list under the
 * prompt, the whole objective (the list clips it), and money that does not round away cents.
 */
export function roomLabel(room: Room, here: Room | null, now = performance.now()): string {
  const study = room.study;
  const budget = study && study.maxCostUsd !== null ? study.maxCostUsd : null;
  const spend = study ? `  ${money(studySpentUsd(study))}${budget !== null ? ` of ${money(budget)}` : ""}` : "";
  const status = room.status === "needs-you" ? "needs you" : room.status === "budget" ? "out of budget" : room.status;
  const live = room.status === "running" && room.startedAt ? ` ${clock(now - room.startedAt)}` : "";
  const crew = room.workerCounts;
  const workers = room.kind === "study" && crew.total ? ` · ${crew.running} of ${crew.total} workers` : "";
  return `${statusSymbol(room.status)} ${fullTitle(room)}${room.kind === "chat" ? "" : `  ${status}${live}${workers}${spend}`}${room === here ? "  (here)" : ""}`;
}
