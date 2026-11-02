import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { configDir } from "./config";
import type { Message, PlanTask } from "./agent";

export type Entry = {
  role: "you" | "kest" | "tool" | "info";
  text: string;
  activityGroup?: string;
  parentActivityGroup?: string;
  detail?: {
    input: string;
    output: string;
    language: "TypeScript" | "JSON" | "text";
    toolName?: string;
  };
};
export type Session = {
  id: string;
  cwd: string;
  title: string;
  updated: string;
  messages: Message[];
  entries: Entry[];
  goal: string | null;
  tasks: PlanTask[];
  toolStats?: import("./stats").ToolTiming[];
  context?: import("./context").ContextState;
  research?: import("./research-company").CompanyState;
  researchEnabled?: boolean;
};
export function sessionsDir() {
  return join(process.env.KEST_CONFIG_DIR?.trim() || configDir, "sessions");
}
export function newSession(cwd: string, messages: Message[]): Session {
  return {
    id: crypto.randomUUID(),
    cwd: resolve(cwd),
    title: "New session",
    updated: new Date().toISOString(),
    messages,
    entries: [],
    goal: null,
    tasks: [],
  };
}
export function normalizeSession(session: Session): Session {
  if (typeof session.goal !== "string" || !session.goal.trim()) {
    session.goal = null;
  }
  if (!Array.isArray(session.tasks)) {
    session.tasks = [];
  } else {
    session.tasks = session.tasks.filter(
      (t) =>
        t &&
        typeof t === "object" &&
        typeof t.title === "string" &&
        (t.status === "pending" || t.status === "doing" || t.status === "done"),
    );
  }
  return session;
}
export async function saveSession(session: Session) {
  const directory = sessionsDir();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  session.updated = new Date().toISOString();
  const path = join(directory, session.id + ".json");
  const temp = path + ".tmp";
  await Bun.write(temp, JSON.stringify(session), { mode: 0o600 });
  await rename(temp, path);
  await saveLocalChat(session);
}

/** The main chat also lives in the working folder, so reopening Kest there continues it. */
export const localChatPath = (cwd: string) => join(resolve(cwd), ".kest", "chat.json");
const hasUserMessage = (s: Session) => s.messages.some((m) => m.role === "user");

/** Best effort: never fails a save. Skips studies and empty chats. Set KEST_LOCAL_CHAT=0 to turn off. */
export async function saveLocalChat(session: Session) {
  if (process.env.KEST_LOCAL_CHAT === "0" || session.research || !hasUserMessage(session)) return;
  try {
    const dir = join(resolve(session.cwd), ".kest");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Chats can hold pasted secrets: keep the folder out of git by default.
    const ignore = join(dir, ".gitignore");
    if (!(await Bun.file(ignore).exists())) await Bun.write(ignore, "*\n");
    const path = localChatPath(session.cwd);
    const temp = path + ".tmp";
    await Bun.write(temp, JSON.stringify(session), { mode: 0o600 });
    await rename(temp, path);
  } catch {
    /* read-only or shared folder: the global copy is still saved */
  }
}

/** The chat last saved in this folder, or null. Works even if the folder was moved or renamed. */
export async function loadLocalChat(cwd: string): Promise<Session | null> {
  try {
    const s = (await Bun.file(localChatPath(cwd)).json()) as Session;
    if (!s || typeof s.id !== "string" || s.research || !Array.isArray(s.messages) || !Array.isArray(s.entries)) return null;
    s.cwd = resolve(cwd);
    return hasUserMessage(s) ? normalizeSession(s) : null;
  } catch {
    return null;
  }
}
export async function deleteSession(id: string) {
  if (!/^[\da-f-]{36}$/.test(id)) throw new Error("Invalid session id.");
  await rm(join(sessionsDir(), id + ".json"), { force: true });
}
export async function listSessions(cwd?: string): Promise<Session[]> {
  const directory = sessionsDir();
  let files: string[];
  try {
    files = await readdir(directory);
  } catch {
    return [];
  }
  const result: Session[] = [];
  const loaded = await Promise.all(
    files
      .filter((f) => /^[\da-f-]{36}\.json$/.test(f))
      .map(async (name) => {
        try {
          return (await Bun.file(join(directory, name)).json()) as Session;
        } catch {
          return null; // Ignore incomplete/corrupt sessions.
        }
      }),
  );
  for (const s of loaded) {
    if (
      s &&
      typeof s.cwd === "string" &&
      (cwd === undefined || s.cwd === resolve(cwd)) &&
      Array.isArray(s.messages) &&
      Array.isArray(s.entries)
    )
      result.push(normalizeSession(s));
  }
  return result.sort((a, b) => b.updated.localeCompare(a.updated));
}

// Replace the saved version of the active session rather than counting it twice.
export async function allSessions(active?: Session): Promise<Session[]> {
  const sessions = new Map((await listSessions()).map((s) => [s.id, s]));
  if (active) sessions.set(active.id, active);
  return [...sessions.values()];
}
