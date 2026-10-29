import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allSessions, listSessions, newSession, saveSession } from "./sessions";
import { formatToolStats } from "./stats";

test("global stats survive reloads and merge a resumed session once across workspaces", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kest-global-stats-"));
  const previous = process.env.KEST_CONFIG_DIR;
  process.env.KEST_CONFIG_DIR = directory;
  try {
    const a = newSession(join(directory, "a"), []);
    a.toolStats = [{ name: "read_file", durationMs: 12, error: false }];
    const b = newSession(join(directory, "b"), []);
    b.toolStats = [{ name: "read_file", durationMs: 28, error: true }];
    await saveSession(a);
    await saveSession(b);
    expect(await listSessions(a.cwd)).toHaveLength(1);
    expect(await listSessions()).toHaveLength(2);
    a.toolStats.push({ name: "shell", durationMs: 4, error: false });
    const sessions = await allSessions(a);
    expect(sessions).toHaveLength(2);
    const text = formatToolStats(
      [],
      sessions.flatMap((s) => s.toolStats ?? []),
      { sessions: sessions.length, workspaces: 2 },
    );
    expect(text).toContain("3 calls across saved sessions");
    expect(text).toContain("2 sessions · 2 workspaces");
    expect(text).toContain("total 40.00 ms");
    await saveSession(a);
    expect(
      (await allSessions()).flatMap((s) => s.toolStats ?? []),
    ).toHaveLength(3);
  } finally {
    if (previous === undefined) delete process.env.KEST_CONFIG_DIR;
    else process.env.KEST_CONFIG_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
