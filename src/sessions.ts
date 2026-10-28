import { mkdir, readdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { configDir } from "./config";
import type { Message } from "./agent";

export type Entry = { role: "you" | "kest" | "tool" | "info"; text: string };
export type Session = {
  id: string;
  cwd: string;
  title: string;
  updated: string;
  messages: Message[];
  entries: Entry[];
};
const directory = join(configDir, "sessions");
export function newSession(cwd: string, messages: Message[]): Session {
  return {
    id: crypto.randomUUID(),
    cwd: resolve(cwd),
    title: "New session",
    updated: new Date().toISOString(),
    messages,
    entries: [],
  };
}
export async function saveSession(session: Session) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  session.updated = new Date().toISOString();
  const path = join(directory, session.id + ".json");
  const temp = path + ".tmp";
  await Bun.write(temp, JSON.stringify(session), { mode: 0o600 });
  await rename(temp, path);
}
export async function listSessions(cwd: string): Promise<Session[]> {
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
        s.cwd === resolve(cwd) &&
        Array.isArray(s.messages) &&
        Array.isArray(s.entries)
      )
        result.push(s);
    } catch {
      /* Ignore incomplete/corrupt sessions. */
    }
  }
  return result.sort((a, b) => b.updated.localeCompare(a.updated));
}
