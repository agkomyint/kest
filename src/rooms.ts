import type { Agent, AgentEvent } from "./agent";
import type { Approval } from "./tools";
import type { Session } from "./sessions";
import type { BrowserSession } from "./browser";
import type { CompanyState } from "./research-company";

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
  constructor(
    readonly id: string,
    readonly kind: RoomKind,
    public session: Session,
    public agent: Agent,
    readonly browser: BrowserSession,
  ) {}

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
  budget: "$",
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
        ? ` $${studySpentUsd(study).toFixed(1)}/${study.maxCostUsd}`
        : "";
    const flag = room.status === "needs-you" ? " needs you" : "";
    const label = `${statusSymbol(room.status)} ${room.title}${spend}${flag}`;
    return room === focused ? `[${label}]` : ` ${label} `;
  });
  const line = parts.join("│");
  return line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line;
}
