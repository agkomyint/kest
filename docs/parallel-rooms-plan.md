# Parallel research rooms: plan and progress

Source of truth for this feature. Re-read before every phase; tick boxes as work lands. Do not drift from the goals or non-goals.

## Goal (from the user)
Operate like a company: normal chat, plus several research studies running **truly in parallel**. Each study is a **room**. The user is the CEO: open a study, give direction, step out, and everything keeps running with state preserved.

UI (agreed mockups):
- A **company bar** above the prompt: `▣ chat │ ● Indexing $3.2/10 │ ▲ Tokenizer needs you │ ✓ Eval`.
- A **needs-you line** when a study asks something (question or approval).
- **Picker** (`/research`, `Ctrl+K`): one row per study with status, spend, workers, age. Enter opens the room.
- **Inside a room**: that study's transcript; the prompt target reads `to director ❯`; typed text is feedback for the director.
- **Artifact viewer** per study: Report / Evidence / Reviews / Timeline tabs.
- Leave a room → back to chat. The study keeps running or stays paused. Nothing is lost.
- `/research show|resume|wrapup|budget <query>` targets a study by fuzzy title/ID.

## Architecture decision (revised after reading the code)
**In-process rooms, not separate processes.**
- `Agent` is already per-instance. A study = `Session` + `Agent` (`/resume` already swaps both). LLM/tool work is async I/O, so several `agent.run()` loops are truly concurrent in one process.
- Separate processes would need a new event/approval/input channel and a supervisor. Higher risk, no benefit for v1.
- Trade-off accepted: closing Kest stops running studies. They checkpoint (status `paused`) and are restored as paused rooms next launch (they live in `research/<id>/` + the session file).

### Room model (`src/rooms.ts`, UI-free, unit-tested)
`Room { id, kind: "chat"|"study", session, agent, browser, controller|null, buffer, pendingApprovals, notes }`
- `controller` non-null ⇔ a turn is running in that room.
- While a room is **not focused**, its agent events go to `buffer` (text deltas coalesced, capped, oldest dropped with a note pointing at `research/<id>/events.jsonl`) and a small summary is updated. When **focused**, events go straight to `KestUI.event()`.
- Switching focus: flush pending text of the leaving room into its session entries, rebuild the view from the entering room's entries (reuse `openSession` rendering), then replay its buffer through `event()`.
- Every room gets its **own `BrowserSession`** (lazy launch, so no cost unless used).
- `KestUI.agent / session / active` stay as "the focused room's" (getters/reassignment) so the 75 existing `this.agent` uses keep working. Run drivers (`submit` turn, `wakeFromBackground`) are refactored to capture room-local refs instead of reading `this.agent/session/active` in their `finally`.

### Steering a running director
Typing in a running study room queues a note (`agent.pendingNotes`). The agent loop injects queued notes as a user message at the next model round. No interrupt, no lost context.

### Approvals
Each room's agent gets `ask = (req, sig) => ui.askFor(room, req, sig)`. `autoApprove(mode)` first (so `all` never blocks). Otherwise: focused room → existing approval UI; background room → queue in `room.pendingApprovals`, mark room `needs you`, resolve when the user opens the room and answers. Aborting a room rejects its queued approvals.

### Company guards
- Concurrency cap (default 3 running studies).
- Global spend allowance across all studies (`/research total 30$`), persisted in the config store; reaching it pauses all running studies. Per-study budgets unchanged.
- LSI: unchanged per agent. A claim check prevents two studies claiming the same question in one process.

## Non-goals (do not build now)
Separate processes per study, remote/cloud studies, splitting a study across machines, Ctrl+R history, `@file` mentions, changing the research company internals (director/worker/review logic).

## Phases (tick when done AND tests green)
- [x] **P1** `src/rooms.ts`: Room, RoomManager (create/focus/list/summary), event buffer (coalesce, cap), concurrency + global-spend guards, tests.
- [x] **P2** Agent steering: `agent.pendingNotes` injected per round; test.
- [x] **P3** UI refactor: rooms in `KestUI`; run drivers room-local; focus switch with buffer replay; per-room browser/controller; `/chat`; tests (background room keeps running while chat is used; switch back replays).
- [x] **P4** Study lifecycle: `/research prepare|start` create/focus a study room instead of replacing the chat session; Esc = pause the focused study (existing behaviour); leaving a room never stops it; restore paused rooms on launch (replaces ambiguous `restoreResearch`).
- [x] **P5** Company bar + needs-you line + prompt target label; per-room approvals.
- [x] **P6** Picker (`/research`, `Ctrl+K`) + study detail; `/research show|resume|wrapup|budget <query>` with fuzzy match and menu completion of study titles.
- [x] **P7** Artifact viewer tabs (Report/Evidence/Reviews/Timeline) from `research/<id>/`.
- [x] **P8** Global spend allowance + concurrency cap + LSI duplicate-claim guard.
- [x] **P9** Docs: README, `/help`, tips, /kest page copy; final `bunx tsc --noEmit` + `bun test`.

## Rules for myself
- Bun only. After each phase: `bunx tsc --noEmit` and `bun test` (rerun the known-flaky browser tests alone before assuming a regression).
- Keep the existing single-study flows working (headless `--prompt --research`, `/research prepare|start|resume|wrapup|budget`). Update tests only when behaviour intentionally changes.
- No commits unless asked. Never print secrets.
- If a phase turns out larger than planned, shrink the phase and note it here; do not silently skip.

## Progress log
(append dated notes below)
- P1 rooms.ts + tests green; P2 agent.pendingNotes + test green.
- P3 core landed: rooms in KestUI (accessors, runTurn, observe, focusRoom, drawBar, steering via pendingNotes). All 180 tests green. Still to do in P3: test of background study + focus switch; /chat; Ctrl+K.
- P3 done: background-study test, /chat, Ctrl+K cycling, close/destroy stop all rooms.
- P4 done: /research prepare|start|resume create or focus study rooms (own session/agent/browser); /resume of a study opens its room; /new and /resume of chat go to the chat room first; saved unfinished studies load as paused rooms on launch (cap 8); concurrency cap checked at start; restoreResearch chooses among rooms. Tests green.
- P5 done: prompt placeholder "to director ❯" inside a study room, 1s bar refresh while studies run, needs-you lines, per-room approval queue test (queue, present on open, abort rejects).
- P6-P9 done: room picker (/research, /rooms, Ctrl+K) with fuzzy targeting for show|resume|wrapup|budget and completion of study titles; /research open report|evidence|reviews|timeline (study-view.ts); /research total and parallel persisted (company-settings.ts), allowance pause on the 1s timer; LSI duplicate-claim guard; README, /help and /kest page copy. Tips catalog untouched (situation-keyed in code). Needs a Kest release before downloaders get it.
