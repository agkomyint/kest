/**
 * The control inbox: notices and forms that research studies send to the main chat.
 *
 * Nothing here reaches the chat model by itself. Items are UI state; the model only learns
 * about one when the user reads it, and an answer only goes back to a study when the user
 * sends it (or confirms the send). A form nobody answers expires after `timeoutMs`, and the
 * study's director then decides for itself.
 */
export type FormField = {
  id: string;
  label: string;
  type: "choice" | "yesno" | "number" | "text";
  options?: string[];
  default?: string;
  why?: string;
};

export type InboxKind = "milestone" | "done" | "blocked" | "form";
export type InboxStatus = "new" | "read" | "answered" | "expired" | "dismissed";

export type InboxItem = {
  id: number;
  studyId: string;
  studyTitle: string;
  kind: InboxKind;
  title: string;
  body: string;
  fields: FormField[];
  status: InboxStatus;
  createdAt: number;
  deadline: number | null;
  draft: Record<string, string> | null;
  answers: Record<string, string> | null;
};

export type FormOutcome =
  | { kind: "answered"; text: string }
  | { kind: "expired"; text: string }
  | { kind: "aborted"; text: string };

/** Money and publishing are never delegated to a timeout or to the chat model. */
const reserved = /\b(budget|fund(?:s|ing|ed)?|allowance|spend(?:ing)?|extra money|publish(?:ing)?)\b/i;

const norm = (s: string) => s.trim().toLowerCase();

export class Inbox {
  items: InboxItem[] = [];
  timeoutMs = 180_000;
  onChange: (() => void) | null = null;
  onEvent: ((item: InboxItem, what: "added" | "answered" | "expired") => void) | null = null;
  private seq = 0;
  private waiting = new Map<number, { settle: (o: FormOutcome) => void; timer: ReturnType<typeof setTimeout> }>();

  private add(partial: Omit<InboxItem, "id" | "status" | "createdAt" | "draft" | "answers" | "fields" | "deadline"> & Partial<InboxItem>) {
    const item: InboxItem = {
      id: ++this.seq,
      status: "new",
      createdAt: Date.now(),
      fields: [],
      deadline: null,
      draft: null,
      answers: null,
      ...partial,
    };
    this.items.push(item);
    return item;
  }

  get(id: number) {
    return this.items.find((i) => i.id === id);
  }

  /** Unread notices plus forms still open: what the bar and header count. */
  unread() {
    return this.items.filter((i) => i.status === "new").length;
  }
  openForms() {
    return this.items.filter((i) => i.kind === "form" && (i.status === "new" || i.status === "read"));
  }

  /** A short progress note. Repeats from the same study within 20 s update the last unread one. */
  notify(studyId: string, studyTitle: string, kind: Exclude<InboxKind, "form">, title: string, body = "") {
    const last = [...this.items].reverse().find((i) => i.studyId === studyId);
    if (
      kind === "milestone" &&
      last &&
      last.kind === "milestone" &&
      last.status === "new" &&
      Date.now() - last.createdAt < 20_000
    ) {
      last.title = title;
      last.body = body;
      this.onChange?.();
      return last;
    }
    const item = this.add({ studyId, studyTitle, kind, title, body });
    this.onChange?.();
    this.onEvent?.(item, "added");
    return item;
  }

  /** Post a form and wait. Resolves when the user sends answers, the window closes, or the study stops. */
  ask(studyId: string, studyTitle: string, title: string, fields: FormField[], signal: AbortSignal): Promise<FormOutcome> {
    if (!fields.length || fields.length > 5) throw new Error("A form needs 1 to 5 fields.");
    const ids = new Set<string>();
    for (const f of fields) {
      if (!f.id || ids.has(f.id)) throw new Error("Each field needs a unique id.");
      ids.add(f.id);
      if (f.type === "choice" && !(f.options && f.options.length >= 2)) throw new Error(`Field ${f.id}: a choice needs 2 or more options.`);
    }
    const text = [title, ...fields.map((f) => f.label)].join(" ");
    if (reserved.test(text))
      throw new Error("Budget, funding, spending and publishing decisions are never put to the chat; the user makes them in the study room. Rephrase or decide the research question yourself.");
    const deadline = Date.now() + this.timeoutMs;
    const item = this.add({
      studyId,
      studyTitle,
      kind: "form",
      title,
      body: fields.map((f) => `${f.label}${f.why ? ` (${f.why})` : ""}`).join("\n"),
      fields,
      deadline,
    });
    return new Promise<FormOutcome>((resolve) => {
      let done = false;
      const finish = (outcome: FormOutcome, status: InboxStatus, event?: "answered" | "expired") => {
        if (done) return;
        done = true;
        const entry = this.waiting.get(item.id);
        if (entry) clearTimeout(entry.timer);
        this.waiting.delete(item.id);
        if (item.status === "new" || item.status === "read") item.status = status;
        this.onChange?.();
        if (event) this.onEvent?.(item, event);
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        const defaults = fields.filter((f) => f.default !== undefined).map((f) => `${f.label}: ${f.default}`);
        finish(
          {
            kind: "expired",
            text: `The user did not answer within ${Math.round(this.timeoutMs / 60_000) || 1} minute(s). Decide what is best yourself, say which assumption you made in your next update, and continue.${defaults.length ? ` Your own suggested defaults were: ${defaults.join("; ")}.` : ""} Do not ask this again.`,
          },
          "expired",
          "expired",
        );
      }, this.timeoutMs);
      timer.unref?.();
      this.waiting.set(item.id, {
        timer,
        settle: (outcome) => finish(outcome, "answered", "answered"),
      });
      signal.addEventListener("abort", () => finish({ kind: "aborted", text: "The study was stopped before an answer arrived." }, "dismissed"), { once: true });
      this.onChange?.();
      this.onEvent?.(item, "added");
    });
  }

  markRead(id: number) {
    const item = this.get(id);
    if (!item) throw new Error(`No inbox item #${id}.`);
    if (item.status === "new") item.status = "read";
    this.onChange?.();
    return item;
  }

  dismiss(id: number) {
    const item = this.get(id);
    if (!item) throw new Error(`No inbox item #${id}.`);
    // Dismissing a form does not answer it: the window still runs out and the director decides.
    if (item.kind !== "form") item.status = "dismissed";
    else if (item.status === "new") item.status = "read";
    this.onChange?.();
    return item;
  }

  private normalize(field: FormField, value: string): string {
    const v = value.trim();
    if (field.type === "choice") {
      const hit = field.options!.find((o) => norm(o) === norm(v));
      if (!hit) throw new Error(`${field.id}: "${v}" is not one of ${field.options!.join(", ")}.`);
      return hit;
    }
    if (field.type === "yesno") {
      if (/^(y|yes|true)$/i.test(v)) return "yes";
      if (/^(n|no|false)$/i.test(v)) return "no";
      throw new Error(`${field.id}: answer yes or no.`);
    }
    if (field.type === "number") {
      if (!v || !Number.isFinite(Number(v))) throw new Error(`${field.id}: "${v}" is not a number.`);
      return String(Number(v));
    }
    if (!v) throw new Error(`${field.id}: answer cannot be empty.`);
    return v.slice(0, 1000);
  }

  /** Store a draft (merged with any earlier draft). Nothing is sent. Only open forms the user has read. */
  setDraft(id: number, values: Record<string, unknown>) {
    const item = this.get(id);
    if (!item || item.kind !== "form") throw new Error(`No form #${id}.`);
    if (item.status !== "read") throw new Error(item.status === "new" ? `Form #${id} has not been read yet; the user must read it first.` : `Form #${id} is already ${item.status}.`);
    const next = { ...(item.draft ?? {}) };
    for (const [key, raw] of Object.entries(values)) {
      const field = item.fields.find((f) => f.id === key);
      if (!field) throw new Error(`Unknown field "${key}". Fields: ${item.fields.map((f) => f.id).join(", ")}.`);
      next[key] = this.normalize(field, String(raw));
    }
    item.draft = next;
    this.onChange?.();
    return item;
  }

  /** Fields that still have no answer in the draft and no default. */
  missing(item: InboxItem) {
    return item.fields.filter((f) => item.draft?.[f.id] === undefined && f.default === undefined).map((f) => f.id);
  }

  /** The answers that would be sent: draft values, then each field's default. */
  finalAnswers(item: InboxItem): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of item.fields) {
      const v = item.draft?.[f.id] ?? f.default;
      if (v !== undefined) out[f.id] = v;
    }
    return out;
  }

  describeAnswers(item: InboxItem, answers = this.finalAnswers(item)) {
    return item.fields.map((f) => `- ${f.label}: ${answers[f.id] ?? "(no answer)"}`).join("\n");
  }

  /** Deliver the final answers to the waiting study. Called only from a user-confirmed action. */
  send(id: number) {
    const item = this.get(id);
    if (!item || item.kind !== "form") throw new Error(`No form #${id}.`);
    if (item.status === "expired") throw new Error(`Form #${id} timed out; the director already decided without it.`);
    if (item.status !== "read" && item.status !== "new") throw new Error(`Form #${id} is already ${item.status}.`);
    const missing = this.missing(item);
    if (missing.length) throw new Error(`Still unanswered: ${missing.join(", ")}.`);
    const answers = this.finalAnswers(item);
    const waiter = this.waiting.get(id);
    if (!waiter) throw new Error(`The study is no longer waiting on form #${id}.`);
    item.answers = answers;
    waiter.settle({ kind: "answered", text: `The user answered your form "${item.title}":\n${this.describeAnswers(item, answers)}\nContinue with these decisions.` });
    return item;
  }

  /** Cancel every open wait (used when the app closes). */
  closeAll() {
    for (const [id, entry] of [...this.waiting]) {
      clearTimeout(entry.timer);
      entry.settle({ kind: "aborted", text: "Kest closed before an answer arrived." });
      this.waiting.delete(id);
    }
  }
}
