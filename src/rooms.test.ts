import { expect, test } from "bun:test";
import type { AgentEvent } from "./agent";
import { newCompany } from "./research-company";
import { newSession } from "./sessions";
import { companyBar, EventBuffer, Room, RoomManager } from "./rooms";

const room = (kind: "chat" | "study", objective = "Compare indexing algorithms") => {
  const session = newSession(process.cwd(), []);
  const study = kind === "study" ? newCompany(objective) : null;
  if (study) session.research = study;
  const agent = { research: study } as never;
  return new Room(session.id, kind, session, agent, {} as never);
};

test("event buffer coalesces text, caps events and reports what was dropped", () => {
  const buffer = new EventBuffer(3);
  buffer.push({ type: "text", delta: "a" });
  buffer.push({ type: "text", delta: "b" });
  expect(buffer.length).toBe(1);
  for (let i = 0; i < 5; i++)
    buffer.push({ type: "status", text: String(i) } as AgentEvent);
  const drained = buffer.drain();
  expect(drained.events).toHaveLength(3);
  expect(drained.dropped).toBe(3);
  expect(buffer.length).toBe(0);
  expect(buffer.drain().dropped).toBe(0);
});

test("room status reflects study state, running turn and pending asks", async () => {
  const study = room("study");
  expect(study.status).toBe("ready");
  study.study!.status = "paused";
  expect(study.status).toBe("paused");
  study.controller = new AbortController();
  expect(study.status).toBe("running");
  const controller = study.controller;
  const approval = study.queueApproval({ title: "Edit", preview: "" }, controller.signal);
  expect(study.status).toBe("needs-you");
  study.nextApproval()!.resolve(true);
  expect(await approval).toBe(true);
  expect(study.status).toBe("running");
  const aborted = study.queueApproval({ title: "Edit", preview: "" }, controller.signal);
  controller.abort();
  expect(await aborted).toBe(false);
  expect(study.pending).toHaveLength(0);
  study.study!.status = "completed";
  study.controller = null;
  expect(study.status).toBe("done");
  expect(room("chat").status).toBe("chat");
});

test("manager enforces the running cap and the total allowance", () => {
  const manager = new RoomManager();
  manager.limits = { maxRunning: 2, totalUsd: 10 };
  const chat = manager.add(room("chat"));
  const a = manager.add(room("study", "alpha"));
  const b = manager.add(room("study", "beta"));
  const c = manager.add(room("study", "gamma"));
  expect(manager.focused).toBe(chat);
  expect(manager.startBlocker(a)).toBeNull();
  a.controller = new AbortController();
  b.controller = new AbortController();
  expect(manager.startBlocker(c)).toContain("limit 2");
  expect(manager.startBlocker(a)).toContain("already running");
  b.controller = null;
  a.study!.spentCostMicros = 10_000_000;
  expect(manager.overAllowance()).toEqual([a]);
  expect(manager.startBlocker(c)).toContain("allowance");
  manager.limits.totalUsd = null;
  expect(manager.startBlocker(c)).toBeNull();
});

test("find matches by words in objective, id prefix or title", () => {
  const manager = new RoomManager();
  manager.add(room("chat"));
  const a = manager.add(room("study", "Compare indexing algorithms"));
  const b = manager.add(room("study", "Tokenizer drift"));
  expect(manager.find("index")).toEqual([a]);
  expect(manager.find("tokenizer drift")).toEqual([b]);
  expect(manager.find(a.study!.id.slice(0, 8))).toEqual([a]);
  expect(manager.find("")).toHaveLength(2);
  expect(manager.find("zzz")).toHaveLength(0);
});

test("company bar brackets the focused room and flags rooms that need you", () => {
  const manager = new RoomManager();
  manager.add(room("chat"));
  const a = manager.add(room("study", "Indexing"));
  a.study!.maxCostUsd = 10;
  a.study!.status = "paused";
  a.question = "continue?";
  const bar = companyBar(manager, 200);
  expect(bar).toContain("[▣ chat]");
  expect(bar).toContain("▲ Indexing $0.0/10 needs you");
  manager.focus(a.id);
  expect(companyBar(manager, 200)).toContain("[▲ Indexing");
  expect(companyBar(manager, 20).length).toBeLessThanOrEqual(20);
  expect(() => manager.focus("nope")).toThrow();
});
