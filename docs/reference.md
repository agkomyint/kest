# Kest technical reference

A lean coding agent for Bun. OpenTUI Core renders the terminal; the OpenAI SDK connects to your exact Modal Muse endpoint. No React, Solid, or agent framework.

## Run

Download a platform archive from [GitHub Releases](https://github.com/agkomyint/kest/releases), extract it, and run `kest.exe` (Windows) or `./kest` (Linux). Keep the included `node_modules` folder beside the executable. These binaries do not require Bun; browser tools require installed Chrome or Edge.

CI pins Bun 1.4.4, caches package downloads, and runs type checks, all tests, and a bundle build. Superseded branch runs are cancelled. Native Windows and Linux binary builds run in parallel only for version tags or manual runs. A `v*` tag publishes archives and SHA-256 checksums after tests and builds pass. To package locally, run `bun run build:exe` then `bun run release:pack`; outputs go into `release/`.

```sh
bun install
bun start
# Or use your installed launcher:
kest
kest D:\path\to\project
```

The current directory is the workspace unless you pass a directory. Type `/connect` and pick a provider with Up/Down + Enter, or go direct with `/connect baseten` for your Baseten API key `/connect modal` for your Modal proxy token ID and secret, or `/connect nebius` for your Nebius Token Factory API key. Nebius uses `https://api.tokenfactory.us-north1.nebius.com/v1/` with `nvidia/Nemotron-3.5-Super-VL`; you can also set `NEBIUS_API_KEY` in `.env`. Input is masked with dots and a character count. Existing saved credentials still work. `/provider` shows the active provider and model; `/connect` with the other provider switches.

Credentials live in `~/.kest/config.json`, as plaintext outside the project — each provider holds named keys (`a`, `b`, `c`…), so connecting to Baseten never wipes your Modal credentials and you can keep several keys per provider. `/connect` lists a provider's keys with the active one marked: Enter switches, Enter on the active key replaces its value, and `+ Add new key` stores another. Old single-key configs migrate automatically. Unix permissions are restricted; Windows uses your profile's permissions. Alternatively use `BASETEN_API_KEY` or `MODAL_PROXY_TOKEN_ID` and `MODAL_PROXY_TOKEN_SECRET` in your environment or the current directory's `.env`. Saved credentials take precedence. Credentials are read at runtime, not embedded in builds. `/model` switches between providers instantly when both are connected.

## Interaction

- **Enter** sends; **Shift+Enter** or **Ctrl+Enter** adds a newline.
- Paste multiline code directly. Large input shows character and line counts.
- **Tab** completes slash commands; **Up/Down** recalls single-line prompts.
- **Mouse wheel / PgUp / PgDn** scroll history.
- Your reading position stays put when activity arrives below. Click **↓ New activity** or press **End** with an empty input (**Ctrl+End** anytime) to jump to the bottom and follow new activity.
- **Click a tool row** to expand/collapse its details. **Ctrl+O** remains an optional shortcut for the latest selected tool. Drag over detail text to select and copy it.
- **Drag over text**, then **Ctrl+C** or **Ctrl+Y** copies the selection. Ctrl+C copies before cancelling/quitting when text is selected. If your terminal intercepts mouse input, use **Shift+drag** and its Copy command.
- **Esc** cancels a reply, cancels connection setup, or denies an approval.
- **Ctrl+C** cancels active work; press again when idle to quit.

A small loading indicator appears while the agent works; only the completed final reply is shown. Intermediate model text stays hidden. Tool output stays collapsed by default, and edit/shell approvals remain visible. All prompts are borderless. Markdown is rendered; code blocks are plain text to avoid language grammar downloads. The renderer is capped at 30 FPS, and the visible scene is bounded to 180 blocks. Older transcript entries remain in saved sessions.

## Tools

| Tool         | Behavior                                                          |
| ------------ | ----------------------------------------------------------------- |
| `list_files` | Lists workspace files, skipping dependencies/build output         |
| `read_file`  | Reads UTF-8 files with line numbers and pagination                |
| `search`     | Searches literal text, case insensitive                           |
| `edit_file`  | Replaces one unique exact match; shows diff and requires approval |
| `write_file` | Creates/replaces files; shows diff and requires approval          |
| `shell`      | Runs TypeScript directly in Bun; follows permission setting       |
| `set_plan`   | Replaces the agent's task plan; tracked step by step              |
| `update_task`| Marks a plan task pending, doing, or done                         |
| `spawn_subagent` | Delegates exploration to a read-only subagent; returns findings as text. With `background: true`, returns at once and wakes the agent with the findings in a later turn |
| `background_status` / `background_cancel` | Lists background tasks and results, or cancels one by ID |

Press **y** to approve or **n** to deny. File tools stay inside the workspace, check symlinks, exclude credential files, and detect changes made while awaiting approval. Existing files must be read before editing. Large diffs require smaller edits. Shell commands run with your permissions and are not sandboxed; inspect the displayed command before approving. Shell output is bounded and commands have a 60-second timeout. Cancellation terminates their process tree. Modal environment credentials are omitted from shell subprocesses.

The agent can run up to 20 model/tool rounds per message. It keeps completed tool actions when cancelled. Older complete turns are removed when context grows large; `/new` starts fresh.

## Goals, plans, and subagents

Set an objective with `/goal <text>` — it is stored in the session, survives `/resume`, and steers every reply. For multi-step work the agent breaks the goal into tasks with `set_plan` and tracks them with `update_task`; `/tasks` shows the checklist and progress. Research delegation supports leads, workers, reviewers, configured model profiles and bounded teams; see the research-company workflow below. Usage from all workers counts in `/usage`, and cancelling the director cancels its descendants.

The agent estimates each call's cost from its own observed tool timings. Independent read-only calls in one reply run in parallel; long independent research can be delegated with `spawn_subagent` `background: true` (at most three at once), which returns immediately while the agent keeps working. When a background task finishes or fails, its result wakes the agent in a new turn — or, if a turn is already active, it is injected as a reminder at the head of the next turn, exactly once. Dependent, stateful, or approval-gated work stays sequential, and background findings still require the director's evidence check and independent review before they support a conclusion.

## Research company

After restarting in the same workspace, budget/start/resume commands restore the single unfinished saved study. If multiple unfinished studies exist, choose with `/research show` and `/resume <session-id>` first. Spending and progress are preserved.

Kest's system instructions now use a director → research lead → worker → review-board workflow for substantial research. The canonical editable prompt is [prompts/research-company.md](../prompts/research-company.md), bundled into builds. Small coding and lookup tasks remain direct. This is a research workflow, not a guarantee of scientific discovery or correct claims.

Prepare a run without spending model credits, set its total budget, then launch it:

```text
/research prepare Discover a dynamic indexing algorithm; compare verified baselines and preserve negative results.
/research budget 10$
/research start
```

`/research <objective>` prepares a study and asks for a USD allowance before making model calls. `/research show` lists saved research in the current workspace, including prepared studies, their status, budget, spending, and session IDs after restarting Kest. Use `/resume <session-id>` to open a saved study. `/research start` launches the prepared study with its configured budget. `/research` shows saved status and spending; `/research resume` continues without resetting consumption. `/research off` disables continuation while preserving artifacts. Ctrl+C or Esc pauses active work. `/research budget 15$` sets a new **total** allowance, not an additional $15. Time and token totals no longer limit research; token counts remain visible under `/usage`. The director controls model choices and delegation, with at most three simultaneous model calls and three delegation levels. Headless research requires an explicit `--budget 10$`.


`spawn_subagent` accepts `profile`, `provider`, `model`, `role` and `toolset`. `research_team` launches up to three assignments concurrently; `research_review` requests a skeptical fresh-context review; `list_models` and `research_status` expose profiles and remaining budget. Leads can delegate within limits. Local read-only scope cannot expand into browser scope. `research` toolsets use agent-owned tabs in the shared Kest browser with the existing approval policy; children never get shell/edit tools. Each worker has its own tab registry and active tab. Browser/context cookies and storage are shared within this Kest instance. Worker completion closes its tabs, including popups, while the director browser stays available. Nested workers reuse the same browser. The director runs experiments through approved Bun scripts, which can directly invoke Rust/C++ compilers and executables. `shell.timeout_ms` can extend an explicitly approved script up to 30 minutes; research deadlines still cancel it.

Every director, worker, reviewer, retry and summary request reserves estimated USD cost before dispatch. Provider-reported input/output usage settles that reservation; missing or interrupted usage retains its conservative estimate. Rates are frozen per provider/model when first used in a study. Models without configured pricing are blocked before dispatch. Workers preserve the final 20% for director experiments and independent review. The director sees the remaining allowance and allocates useful work; unused funding is not a reason to repeat work.

At low funding, the director should save `research/<run-id>/funding-proposal.md` with verified progress, unresolved evidence, concrete follow-up experiments, requested additional USD and a reasoned estimate. If funding runs out unexpectedly, Kest saves a provisional proposal and partial checkpoint automatically. It asks the user whether to increase the total and never grants more money automatically. A completed study requires an independent review, a nonempty saved final report, and the director's `research_complete` action. Funding does not guarantee research success.

Dollar enforcement uses configured token rates and conservative input/output reservations; it is not the provider's invoice or an account-level billing cap. Account terms, discounts and tokenization may differ. Older studies require a new explicit dollar allowance; earlier calls without cost records are labeled unknown and excluded from that new allowance.


Worker rows show their ID, role/model, current tool or status, and completion/failure. Click a worker row to inspect its live activity without mixing concurrent output into the director's tool. `/agents` lists workers and `/agents <id-prefix>` inspects their transcript without replacing the director context. Research workers persist messages and archived context under `research/<run-id>/agents/<worker-id>.json` when they finish or fail. Live previews are bounded; the saved transcript holds the complete retained/archive messages. Non-research delegates have live previews but no research-directory transcript. Interim research checkpoints are displayed while work continues. Persistent studies protect 20% of the dollar allowance from ordinary workers for director implementation, independent review and final reconciliation.

Configure worker models without changing the director's selected model:

```text
/research models
/research model critic modal YOUR_SUPPORTED_MODEL_ID
/research model designer baseten YOUR_SUPPORTED_MODEL_ID
/research endpoint external https://YOUR_PROVIDER/v1 YOUR_MODEL_ID YOUR_API_KEY_ENV_NAME
```

Built-in profiles resolve the provider keys configured through `/connect`. Custom OpenAI-compatible endpoints store only a reference to an environment variable; set that variable before starting Kest. Never enter its actual secret in a command or chat. Available credentials do not prove a provider supports a particular model. Profiles live in `~/.kest/research-models.json` (honoring `KEST_CONFIG_DIR`). Profiles are user-configured; model tools cannot register new endpoints.

`/model` shows input and output prices; `/research models` and the agent's `list_models` tool include pricing metadata, source links and the date checked. `/usage` also shows rates and estimated input, output and total model costs across recorded usage on this machine. `/stats` shows only tool counts and timings. Costs use current catalog rates for historical tokens; cache discounts, rate changes, credits and unreported tokens are not included. Unknown model rates are excluded from a clearly labeled priced subtotal, leaving the overall cost unknown. Usage is keyed by model ID, so provider attribution is inferred from the catalog. Prices below are USD per one million tokens, checked on 2026-10-30. The all-time `/usage` estimate does not enforce spending limits; research runs use a separate persisted cost ledger.

| Provider / configured model | Input / 1M | Output / 1M | Source and scope |
| --- | --- | --- | --- |
| Nebius / Nemotron 3.5 Super VL | $0.30 | $0.90 | [Published Token Factory rates](https://nebius.com/blog/posts/three-new-open-weight-models-from-us-companies-give-builders-more-choice) |
| Baseten / Muse Spark Open (hackathon) | $1.25 | $4.25 | [Public model reference](https://www.baseten.co/pricing/); hackathon model ID billing unverified |
| Modal / Muse Spark Open (proxy) | $1.25 | $4.25 | [Public Shared Endpoint reference](https://modal.com/library/meta/muse-spark-open); custom proxy billing unverified |

Account-specific terms may differ. Custom models and endpoints show unknown pricing; changing a research profile's model ID does not copy its provider's default model price.

Research mode continues after interim answers and negative findings while budget remains. Near the end it attempts an independent model review and asks the director to reconcile the review into a final checkpoint/paper. If resources fail or expire, it stops rather than inventing completion; a review can itself fail, and is not empirical certification. Live research quality has not been benchmarked by the local fixture tests.

Each run journals request reservations, delegation identities/results/failures, tool observations and checkpoints under `research/<run-id>/events.jsonl` with `state.json`. Session persistence includes the research counters; restart recovery uses the latest journal checkpoint so consumed cost allowance is not silently renewed. In-flight dollar reservations survive crashes. These local records are not tamper-proof; tool output is still bounded. The research prompt requires scripts to write full raw experiment results, source/dataset checksums, seeds, environment details and paper drafts into the run directory. The logger does not independently validate performance metrics, correctness claims or novelty. Do not confuse synthetic fixture tests with SOSD/YCSB experiments.

Checkpoint replacement retries transient Windows sharing/permission errors while preserving the previous checkpoint. A failed journal operation is reported to its caller without blocking all subsequent writes. Cost exhaustion ends with an explicit partial checkpoint; user cancellation leaves the study paused. Permanent filesystem failures still require fixing the path or access permissions.

Run `bun test src/research-e2e.test.ts` for the deterministic workflow integration tests: overlapping teams, actual Bun experiment execution, repeated research cycles, artifact reads, review, paper, cancellation, and recovery/resume. `bun run scripts/research-smoke-live.ts --live --budget 1$` explicitly spends configured provider credits (within the explicit USD allowance, with a separate three-minute smoke-test timeout), exercises a three-person team and reviewed smoke report, and prints its retained temporary artifact directory. This validates orchestration, not research quality or indexing performance.

Headless research mode is also available with `kest --research --budget 10$ --prompt "OBJECTIVE"`. Existing permission settings still apply; headless mode denies actions that would require interactive approval. No actual indexing study, dataset download, or paid model request is launched by installing these changes.

## Commands and sessions

| Command                  | Action                                            |
| ------------------------ | ------------------------------------------------- |
| `/connect [modal\|baseten\|nebius]` | Save or switch keys; picker shows what's connected |
| `/provider`              | Show active provider and model                    |
| `/model`                 | List models from all providers and select one     |
| `/context`               | Inspect active context, estimates, summaries, and local archives |
| `/usage`                 | All-time token usage, input/output rates and estimated model costs |
| `/stats`       | All-time tool counts and timings across saved sessions |
| `/goal [<text>\|clear]`  | Set, show, or clear the session objective          |
| `/tasks`                 | Show the plan checklist and progress               |
| `/new`                   | Start a new session                               |
| `/sessions`              | List saved sessions for this workspace            |
| `/resume <id>`           | Restore a session; an unambiguous ID prefix works |
| `/tools`                 | Show available tools                              |
| `/status`                | Show endpoint, model, workspace, and config path  |
| `/system <instructions>` | Customize the agent in a fresh session            |
| `/help`                  | Show shortcuts and commands                       |
| `/exit`                  | Quit                                              |

Sessions save automatically after each task in `~/.kest/sessions/`. They contain prompts, replies, and tool results in plaintext. Credentials entered through `/connect` are not added to sessions.

## Context management

`/context` shows the estimated next input size, instructions, tool definitions, conversation and summary sizes, local budget, archived message count, compaction count and last provider-reported input tokens. This is current model input, not the all-time usage shown by `/usage`. Running an inspection command does not call the model or add its output to the model's conversation.

Before model requests, Kest summarizes older conversation when estimated input approaches its local operating budget. Instructions remain pinned; recent user turns and complete tool-call/result groups are retained. For long single-turn tasks, completed older tool groups can also be summarized while retaining the latest user request. The summary asks the connected model to preserve decisions, constraints, corrections, important files, completed checks and unfinished work. Summary requests use that provider and count in `/usage` and research cost budgets. Summaries request low reasoning effort and concise output, with at most two attempts (4,096 then 8,192 output tokens) and a 30-second timeout per attempt. `KEST_SUMMARY_TIMEOUT_MS` can configure 50–120,000 ms. Progress shows elapsed time; Esc cancels. A cancelled or failed manual summary preserves active history. If automatic summarization fails, Kest uses explicitly labeled local excerpts, archives the full originals, and continues when the resulting context fits. These excerpts are partial, not a verified synthesis; inspect `/context archive` for omitted detail. If safe reduction is impossible, Kest stops with an explicit error. `bun run scripts/context-smoke-live.ts --live` explicitly spends provider credits to test automatic compaction followed by a real reply.

Summarized originals are stored locally in the session's `context.archive`; the summary and counters are stored alongside active `messages`. They survive `/resume` and goal changes; `/new` starts a fresh context. Archives are not sent automatically. Summaries are fallible and source excerpts are bounded, so inspect the original history when details matter. Previously discarded history from older Kest versions cannot be recovered.

Commands: `/context summary` reads the memory; `/context messages` lists active messages; `/context archive` lists archived originals; `/context show 3` and `/context archived 3` inspect numbered messages (large display output is truncated); `/context compact` requests an immediate summary when completed history is eligible. Local archive/session files contain conversation and tool data in plaintext, just like existing session storage.

The default local budget is 40,000 estimated tokens, with 4,096 reserved for output and automatic compaction triggered at 85% of the remaining input budget. Set `KEST_CONTEXT_BUDGET` before starting Kest to choose a value between 12,000 and 200,000. Counts use UTF-8 bytes divided by four; they are estimates, not a model tokenizer or a guarantee about the provider's actual context limit. Configure conservatively for the chosen model. If input cannot fit after safe compaction, Kest asks for a smaller request or a fresh session rather than silently discarding it.

## Build

```sh
bun run build       # JS bundle; requires Bun and installed @opentui/core
bun run build:exe   # ~127 MB standalone Windows executable, includes Bun/native assets
```

The JS bundle is not a standalone distribution: keep installed dependencies available. `kest` currently runs the source through Bun, so local edits take effect on restart. The standalone executable is `dist/kest.exe` on Windows. Sizes are measured with Bun 1.4.4 and vary by version/platform; the embedded runtime dominates the standalone size. Runtime dependencies are pinned in package.json and bun.lock.

## Check

```sh
bun check
bun fmt --check
bun test
bun run test:live
```

Use `bun fmt` to format the repo. `bun check` uses Bun's built-in type checker; no separate TypeScript compiler is installed. Runtime, dependency installation, formatting, checking, tests, and builds all use Bun. Native `bun lint` is not available in the installed Bun 1.4.4 binary, so linting is not currently configured.

`test:live` uses saved credentials and the real Modal endpoint. It creates a temporary fixture, asks the agent to read and fix it, verifies the edit, and removes the fixture. It makes paid/provider API requests if your endpoint bills usage. Unit tests exercise real files, real shell processes, and OpenTUI's native test renderer; no fake model endpoint is used.

For a read-only headless task:

```sh
kest --prompt "Read package.json and summarize this project"
```

Headless mode denies edits and shell commands, and does not save a session.

Tool rows show elapsed milliseconds. Use `/stats` for all-time call counts, errors, and total/average/maximum time per tool across saved sessions in every workspace on this machine. Both `/stats` and `/usage` show session and workspace counts, including the current session without counting a resumed session twice. Timings include approval waits; older calls without saved timings cannot be reconstructed. `/sessions` continues to list the current workspace's conversations.

Sessions are JSON files in `~/.kest/sessions/`; all-time model token usage is in `~/.kest/usage.json`. `KEST_CONFIG_DIR` relocates both, and `KEST_USAGE_FILE` can override the usage file separately. Usage writes are atomic and coordinated across terminals. Headless `kest --prompt` runs also save sessions, tool timings, and reported token usage. These totals are local to this Kest storage directory, not synchronized between computers. Token counts depend on the provider returning usage data.

Run `bun run scripts/bench-tools.ts` for a local 800-file tool benchmark (seven samples per tool; reports median milliseconds). Search uses bounded concurrency of 16 files and preserves result order.

The `shell` tool runs JavaScript/TypeScript directly in Bun. Use Bun APIs or `Bun.spawn` with argument arrays for external programs. Approval, timeout, output limits, and cancellation apply. PowerShell and Bash command syntax is not accepted. Run `bun run scripts/bench-shell.ts` on Windows to compare runtime startup overhead.

Use `/permission all|minimal|strict` in the UI, or `kest [directory] --permission all|minimal|strict`. The choice is saved in your Kest config and restored on restart, including headless runs. `all` auto-approves file edits, writes, and Bun scripts. `minimal` auto-approves file edits/writes and asks before scripts. `strict` asks before each edit, write, or script and is the initial default. Headless mode denies actions requiring a prompt. `/permission` shows the current level. Saved sessions do not override this setting.

Built-in Bun automation guidance applies to new and resumed sessions: batch related work in one script, use native APIs, and avoid launching PowerShell or other interpreters. This is agent guidance, not a subprocess security sandbox.

The agent prestarts one idle Bun interpreter while waiting for a model response. Approved scripts are then sent through stdin to that fresh, one-use process; unused interpreters are stopped at the end of the turn. This overlaps startup with model latency without sharing script globals between calls. A local 15-trial system-info comparison measured a 40.54 ms cold median versus 20.13 ms prepared median (100 ms preparation lead time, excluded from dispatch timing). It reduces dispatch latency rather than eliminating startup work.

Expanded tool calls show independent input/output scroll panels, each capped at six content rows (smaller in short terminals). Use the mouse wheel over a panel or drag its scrollbar. Ctrl+Shift+I focuses input; Ctrl+Shift+O focuses output. Arrow keys, PgUp/PgDn, Home/End scroll the focused panel; Escape returns to the composer. Ctrl+O toggles the whole tool. Code highlighting and distinct background colors remain.

Application-launch guidance avoids fixed sleeps and duplicate attempts: submit one direct native launch request, and distinguish request submission from a verified visible application window.


## Browser control

Run `/browser` to open a visible Kest-owned Chrome window (Edge is the fallback), or `/browser https://en.wikipedia.org`. Then ask, for example, "Search Wikipedia for black holes". The `browser` tool can navigate, inspect accessible page snapshots, click, type, press keys, select options, go back/forward, and open/switch/close tabs. It returns a snapshot after each action and reuses the browser across messages, goals, and new conversation sessions. `/browser tabs` lists tabs; `/browser close` closes the Kest browser. Quitting Kest closes it too.

This window uses a separate, temporary browser context; it does not attach to your existing personal browser tabs. Install Chrome or Edge first; no bundled-browser download is required. Browser action approvals follow `/permission`: `all` auto-approves; `minimal` and `strict` ask before browser actions. Reading snapshots and listing tabs are automatic. Direct `/browser` commands are explicit user actions. Page contents are treated as untrusted data, and research output must cite sources.

`playwright-core` is loaded only when browser automation is used, preserving fast CLI startup. Both JS and compiled builds resolve it as an external dependency: keep `node_modules/playwright-core` installed alongside the distribution when using browser control. The compiled executable's browser feature therefore requires this installed package.

Browser actions use compact DOM observations by default; explicit `snapshot` retains the full accessibility view. The `detail` option accepts `compact`, `full`, or `none` (acknowledgment only). Responses include action/observation timing metadata. Use `action: "batch"` with 1–12 known `steps` (`fill`, `click`, `press`, `select`, `navigate`) to run an observed workflow with one final observation and a single tool approval. Steps stay sequential and stop on failure. This avoids model round trips between predictable actions; it does not guarantee a network or model response within 100–300 ms. See `browser-speed-results.md` for the local profile.

For a same-tab link click, provide its observed href as `url`. Kest then waits for navigation and destination DOM readiness rather than all page assets, including when the link redirects. It still checks element visibility and stability.

Final replies render Markdown locally with mint headings/emphasis, blue links, amber inline-code highlights, clearer paragraph/list spacing, and syntax-colored JavaScript/TypeScript/JSON code blocks on tinted backgrounds. Formatting markers are concealed; text remains selectable. This rendering does not download grammars.
