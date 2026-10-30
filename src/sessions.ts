import { mkdir, readdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { configDir } from "./config";
import type { Message, PlanTask } from "./agent";

export type Entry = {
  role: "you" | "kest" | "tool" | "info";
  text: string;
  detail?: {
    input: string;
    output: string;
    language: "TypeScript" | "JSON" | "text";
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
  for (const name of files.filter((f) => /^[\da-f-]{36}\.json$/.test(f))) {
    try {
      const s = (await Bun.file(join(directory, name)).json()) as Session;
      if (
        typeof s.cwd === "string" &&
        (cwd === undefined || s.cwd === resolve(cwd)) &&
        Array.isArray(s.messages) &&
        Array.isArray(s.entries)
      )
        result.push(normalizeSession(s));
    } catch {
      /* Ignore incomplete/corrupt sessions. */
    }
  }
  return result.sort((a, b) => b.updated.localeCompare(a.updated));
}

// Replace the saved version of the active session rather than counting it twice.
export async function allSessions(active?: Session): Promise<Session[]> {
  const sessions = new Map((await listSessions()).map((s) => [s.id, s]));
  if (active) sessions.set(active.id, active);
  return [...sessions.values()];
}
