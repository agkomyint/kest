import { expect, test } from "bun:test";
import type { AgentEvent } from "./agent";
import { newCompany } from "./research-company";
import { newSession } from "./sessions";
import { companyBar, EventBuffer, Room, RoomManager, roomLabel, studyCard, roomList, roomOrder } from "./rooms";

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
  expect(bar).toContain("▲ Indexing $0.00/10 needs you");
  manager.focus(a.id);
  expect(companyBar(manager, 200)).toContain("[▲ Indexing");
  expect(companyBar(manager, 20).length).toBeLessThanOrEqual(20);
  expect(() => manager.focus("nope")).toThrow();
});

test("room list is quiet when idle, windows around the focused room when crowded", () => {
  const manager = new RoomManager();
  manager.add(room("chat"));
  expect(roomList(manager, 80).lines).toEqual([]);
  const studies = Array.from({ length: 12 }, (_, i) => {
    const r = manager.add(room("study", `Study ${i}`));
    r.study!.maxCostUsd = 10;
    return r;
  });
  const idle = roomList(manager, 80);
  expect(idle.lines[0]).toContain("12 studies");
  expect(idle.lines.at(-1)).toContain("12 ready");
  expect(idle.lines.length).toBeLessThanOrEqual(5);
  studies[8]!.controller = new AbortController();
  studies[3]!.study!.status = "completed";
  manager.focus(studies[8]!.id);
  const busy = roomList(manager, 80, 5);
  expect(busy.lines).toHaveLength(4);
  expect(busy.lines[0]).toContain("●1");
  expect(busy.lines.at(-1)).toContain("^K all");
  expect(busy.lines.some((l) => l.startsWith("▸") && l.includes("Study 8"))).toBe(true);
  expect(busy.targets.at(-1)).toBeNull();
  expect(busy.lines.every((l) => l.length <= 80)).toBe(true);
  expect(roomList(manager, 30, 5).lines.every((l) => l.length <= 30)).toBe(true);
  const crowded = roomList(manager, 80, 3);
  expect(crowded.lines).toHaveLength(3);
  expect(crowded.lines.some((l) => l.includes("Study 8"))).toBe(true);
  const order = roomOrder(manager);
  expect(order[0]!.kind).toBe("chat");
  expect(order.at(-1)).toBe(studies[3]!);
});

test("the studies list says what each count means and how many workers are busy", () => {
  const manager = new RoomManager();
  manager.add(room("chat"));
  const busy = manager.add(room("study", "Compare fact-checker rating scales"));
  busy.study!.maxCostUsd = 1;
  busy.study!.spentCostMicros = 210_000;
  busy.controller = new AbortController();
  for (const [id, state] of [["a", "done"], ["b", "running"], ["c", "running"]] as const)
    busy.track({ type: "worker", workerId: id, parentId: "p", task: "t", role: "researcher", model: "m", depth: 1, state } as never);
  const broke = manager.add(room("study", "Corrections policies"));
  broke.study!.status = "budget_exhausted";
  const list = roomList(manager, 140, 6).lines;
  expect(list[0]).toContain("1 running");
  expect(list[0]).toContain("1 out of budget");
  expect(list[0]).not.toContain("$1 ");
  expect(list.join("\n")).toContain("2 of 3 workers");
  expect(list.join("\n")).toContain("$0.21 of $1.00");
  // Stale "running" marks do not count once the turn is over.
  busy.controller = null;
  expect(busy.workerCounts.running).toBe(0);
  // The picker uses the same order and the whole objective, with cents kept.
  busy.controller = new AbortController();
  const label = roomLabel(busy, manager.focused ?? null);
  expect(label).toContain("Compare fact-checker rating scales");
  expect(label).toContain("2 of 3 workers");
  expect(label).toContain("$0.21 of $1.00");
});

test("the study card pins status, budget, phase and what needs the user", () => {
  const manager = new RoomManager();
  manager.add(room("chat"));
  const r = manager.add(room("study", "Compare fact-checker rating scales"));
  r.study!.maxCostUsd = 1;
  r.study!.spentCostMicros = 420_000;
  r.controller = new AbortController();
  r.startedAt = 1000;
  expect(studyCard(manager.list()[0]!, 120, 0)).toEqual([]); // a plain chat has no study
  const chatWith = manager.list()[0]!;
  chatWith.session.research = r.study!;
  expect(studyCard(chatWith, 120, 0)[0]).toContain("Compare fact-checker rating scales"); // chat with research on
  chatWith.session.research = undefined;
  expect(r.phase).toBe(0);
  r.track({ type: "worker", workerId: "a", parentId: "p", task: "t", role: "researcher", model: "m", depth: 1, state: "running" } as never);
  expect(r.phase).toBe(1);
  const wide = studyCard(r, 120, 103_000);
  expect(wide.length).toBe(5);
  expect(wide[3]).toContain("Research team 1 · 1 researcher · 1 running");
  expect(wide[0]).toContain("running 1m42");
  expect(wide[0]).toContain("Compare fact-checker rating scales");
  expect(wide[1]).toContain("$0.42 of $1.00");
  expect(wide[1]).toContain("42%");
  expect(wide[2]).toContain("✓ plan → ● research → ○ review → ○ report");
  r.track({ type: "worker", workerId: "b", parentId: "p", task: "t", role: "reviewer", model: "m", depth: 1, state: "running" } as never);
  expect(r.phase).toBe(2);
  r.question = "Extend the budget by $0.50?";
  const asked = studyCard(r, 120, 0);
  expect(asked[asked.length - 1]).toContain("needs you: Extend the budget");
  // Narrow terminals: no bar or phase strip.
  const narrow = studyCard(r, 60, 0);
  expect(narrow.join("\n")).not.toContain("█");
  expect(narrow.join("\n")).not.toContain("phase");
  r.study!.status = "completed";
  expect(r.phase).toBe(3);
});
