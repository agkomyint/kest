<div align="center">

# Kest

**A coding agent. A research team. One terminal.**

Read code, run experiments, and coordinate research with a shared dollar budget.

[![CI](https://github.com/agkomyint/kest/actions/workflows/ci.yml/badge.svg)](https://github.com/agkomyint/kest/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/agkomyint/kest?color=50dca0)](https://github.com/agkomyint/kest/releases)
[![Bun](https://img.shields.io/badge/Bun-1.4.4-f5c26b)](https://bun.sh)

[Download](https://github.com/agkomyint/kest/releases/latest) · [Research](#research-with-a-budget) · [Commands](#commands) · [Reference](docs/reference.md)

</div>

![Kest terminal with a project prompt ready to send](docs/images/terminal.png)

<p align="center"><sub>Real Kest UI output captured with OpenTUI’s native renderer. Example workspace; no model calls. Renderer captures, not desktop screenshots.</sub></p>

## Work that stays in your workspace

| Code | Research | Keep your place |
| --- | --- | --- |
| Read and search files, review edits, and run Bun scripts. | Delegate to leads, workers, and reviewers under one USD allowance. | Save conversations, progress, spending, and worker transcripts. |
| Inspect tool inputs, outputs, and timings. | Run experiments and preserve evidence and negative results. | Inspect saved studies after restarting. |
| Navigate a separate Chrome or Edge browser. | Configure models per research role. | Inspect usage, context memory, and tool statistics. |

Built with Bun and OpenTUI Core. Connect Modal, Baseten, or Nebius. Small tasks run directly; research mode is explicit.

## Get started

Download a [release archive](https://github.com/agkomyint/kest/releases/latest) for **Windows x64** or **Linux x64 (glibc)**. Extract the entire archive and keep its `node_modules` beside the executable. Bun is included in the binary.

```powershell
# Windows: from the extracted folder
.\kest.exe
```

```sh
# Linux: from the extracted folder
./kest
```

Chrome or Edge is needed only for browser tools. Releases include SHA-256 checksums.

### Run from source

Requires Bun 1.4.4 or newer.

```sh
git clone https://github.com/agkomyint/kest.git
cd kest
bun install --frozen-lockfile
bun start
```

Pass a workspace with `bun start /path/to/project`, or `kest /path/to/project` if you have installed a launcher.

### Connect a model

Inside Kest, run `/connect` and select a provider, or go directly:

```text
/connect nebius
/connect baseten
/connect modal
/connect tavily
/connect lsi
```

Enter credentials in the masked connection prompt. Choose a model with `/model`, then type a request:

```text
Read this project and explain how its pieces fit together.
```

Credentials are stored in plaintext in your local Kest config, outside the repository. Environment variables are supported; see [.env.example](.env.example). Never enter keys into ordinary chat.

### Publish to LSI

Create an API key on the LSI account page, run `/connect lsi`, and paste it. Search, novelty checks and question listing are automatic. Claiming and posting questions are available only inside a `/research` run, and publishing unlocks only after the director completes the study (independent review done, final report saved); plain chat and workers can only read. Claiming, posting questions and publishing research follow `--permission`: `strict` and `minimal` ask first, `all` approves them automatically, so a full-auto run can publish under your account. LSI stores light text and links only: host heavy data yourself and link it as evidence. `LSI_KEY` and `LSI_BASE_URL` (https only) also work.

### Add Tavily web research

Run `/connect tavily`, paste your Tavily API key into the masked prompt, and press Enter. Kest saves it separately from your model connection and immediately shows the new tools. `/tools` lists them again. You can also set `TAVILY_API_KEY` before launching Kest; a saved key takes precedence.

| Tool | What it adds |
| --- | --- |
| `tavily_search` | Web search with source URLs and snippets. |
| `tavily_extract` | Readable content from selected URLs. |
| `tavily_map` | Discover relevant pages within a website. |
| `tavily_crawl` | Bounded exploration with page extraction. |
| `tavily_research` | Start an asynchronous Tavily research task. |
| `tavily_research_status` | Retrieve its status, report, and sources using the returned request ID. |

Try: “Find primary sources comparing B-trees and learned indexes, then read the two most relevant papers.” Activity rows use readable labels; expand them for technical names, requests, outputs, and timing.

These tools become available to the director and research-scoped workers when a key is configured. Local-only workers remain offline. `strict` and `minimal` permissions ask before new Tavily requests; `all` approves them automatically. Reading an existing research task does not start another job. Requests have timeouts, bounded result counts, and no automatic retries. Map/crawl stay on-site by default; use focused searches and selected URL extraction before broad crawling.

**Tavily uses separate credits, outside `/research budget`.** Returned usage is shown when supplied by Tavily. Remote research tasks can continue after local cancellation; keep their request IDs and retrieve them rather than creating duplicates. Tavily reports are external generated analysis and do not replace independent review of local experiments. Keys live in `~/.kest/tavily.json` (or `KEST_CONFIG_DIR`); they are excluded from chat/tool definitions and inherited script environment variables.

Implementation references: [Search](https://docs.tavily.com/documentation/api-reference/endpoint/search), [Extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract), [Map](https://docs.tavily.com/documentation/api-reference/endpoint/map), [Crawl](https://docs.tavily.com/documentation/api-reference/endpoint/crawl), [Research](https://docs.tavily.com/documentation/api-reference/endpoint/research), [task retrieval](https://docs.tavily.com/documentation/api-reference/endpoint/research-get), and [credit pricing](https://docs.tavily.com/documentation/api-credits). Checked 2026-10-30.

## Research with a budget

Prepare an objective, choose a total allowance, and start:

```text
/research prepare Compare indexing algorithms using reproducible benchmarks.
/research budget 10$
/research start
```

Preparation and budget configuration make no model calls. Starting research uses connected providers and can spend credits.

Each new objective gets a separate saved session. The status line shows its state and money left; `/research show` gives the next action. `/research off` disables continuation while preserving the saved study.

![A prepared study showing its objective, ten-dollar budget, zero spending, and start command](docs/images/research.png)

**Close Kest and come back later.** `/research show` lists saved studies for the current workspace, including prepared studies. With one unfinished study, `/research budget`, bare `/research start`, and `/research resume` restore it automatically. With several, use `/resume <session-id>` to select one from `/research show`.

```text
/research show
/research budget 15$
/research resume
```

`15$` sets the **total** allowance to $15; it does not add $15. Spending and reservations are preserved. Use `/research start` for a prepared study and `/research resume` after pausing. Esc or Ctrl+C pauses active work.

The director coordinates leads, workers, and independent reviewers, with up to three simultaneous model calls and three delegation levels. The final 20% is reserved from ordinary worker spending for director work and review. Inspect workers with `/agents` or `/agents <id-prefix>`.

Artifacts live in `research/<run-id>/`: checkpoints, events, worker transcripts, experiment evidence, and reports. At low funding, Kest saves a proposal with progress and next steps. Increasing the allowance is your decision.

Budget enforcement uses configured token rates and conservative reservations, not the provider’s invoice. It is not an account-level billing cap. Findings still need evidence and review; funding does not guarantee a correct result or discovery.

<details>
<summary><strong>Worker models and custom endpoints</strong></summary>

```text
/research models
/research model critic modal YOUR_SUPPORTED_MODEL_ID
/research endpoint external https://YOUR_PROVIDER/v1 YOUR_MODEL_ID YOUR_API_KEY_ENV_NAME
```

Custom endpoints store an environment variable name, never its secret value. Profiles live in `~/.kest/research-models.json`. A configured key does not guarantee support for a model.

</details>

## Several studies at once

Each study is a room with its own director, workers, browser and approvals. Studies run truly in parallel: start one, press `/chat` or Ctrl+K, start another, and keep chatting. A bar above the prompt shows every room (`● running`, `▲ needs you`, `⏸ paused`, `✓ done`); open a room to read its transcript, answer its approvals, or type direction to the director while it works. `/research resume|wrapup|budget <title words>` targets a study by fuzzy title or id. `/research total` caps combined spend (running studies pause when it is reached); `/research parallel` caps concurrency (default 3). Two studies in one Kest never claim the same LSI question. Closing Kest pauses running studies; they return as paused rooms next launch.

## Commands

| Command | What it does |
| --- | --- |
| `/connect`, `/model`, `/provider` | Configure connections and select a model. |
| `/research prepare <objective>` | Save an objective without model calls. |
| `/research budget 10$` | Set the total USD allowance. |
| `/research start` | Launch the prepared study. |
| `/research` or `/rooms` (Ctrl+K) | Pick a study room; the picker shows status and spend. |
| `/research show [study]` | List saved studies, or inspect one by fuzzy title or id. |
| `/research open [report\|evidence\|reviews\|timeline] [study]` | Read a study's report, evidence files, independent reviews or event timeline. |
| `/research total 30$`, `/research parallel 3` | One allowance across all studies (`off` removes it), and how many may run at once (1–10). Both persist. |
| `/chat` | Leave a study room for chat. The study keeps running. |
| `/research resume` | Continue without resetting consumption. |
| `/research wrapup` | Stop new experiments, run independent review, write the final report, and publish to LSI if connected. |
| `/agents [id-prefix]` | Inspect workers and transcripts. |
| `/goal <text>`, `/tasks` | Set the objective and inspect its plan. |
| `/browser [url]`, `/browser close` | Open or close Kest’s browser. |
| `/sessions`, `/resume <id>` | List or reopen workspace conversations. |
| `/context` | Inspect context size, memory, and archives. |
| `/usage`, `/stats` | Inspect model usage and tool timings. |
| `/permission all|minimal|strict` | Choose how edits and scripts are approved. |
| `/new`, `/help`, `/exit` | Start fresh, view help, or quit. |

## At the keyboard

An idle tip row sits between the model tag and prompt. Click **‹ / ›** or press **Alt+Left / Alt+Right** to browse without changing your draft. Tips wrap around, stay still while you type, and hide during work, approvals, credential entry, and errors. The editable catalog is [tips.md](tips.md).

**Enter** sends; **Shift+Enter / Ctrl+Enter** inserts a newline. **Tab** completes commands. **Up / Down** browses prompt history. **Esc / Ctrl+C** cancels active work and pauses research. Scroll with the wheel or **PgUp / PgDn**; click tool rows to expand. Drag to select, then **Ctrl+C / Ctrl+Y** to copy.

Activity groups show readable action labels and total action time. Expand a group to see every action and its duration, then expand an action for its technical tool name, input, and retained output. Concurrent action times overlap; the total is their sum, not elapsed wall time. Groups remain expandable after completion and session reopening. Research setup, generated instructions, and connection errors also keep their details behind expandable rows.

![An expanded activity group and a file-reading action with timing, technical input, and scrollable output](docs/images/activity.png)

If a model connection is interrupted, Kest preserves completed actions and the research checkpoint. Inspect the error row for technical details, then use `/research resume`. Kest does not automatically replay a failed streaming request.

## Permissions and local data

Kest defaults to `strict`: edits, writes, and scripts require approval. `minimal` approves edits and writes automatically but asks before scripts. `all` approves these actions automatically. Scripts run with your permissions; this is not a sandbox. Headless mode denies operations needing interactive approval.

Sessions, credentials, profiles, and usage are stored under `~/.kest/`. `KEST_CONFIG_DIR` relocates that directory. Research evidence stays in the workspace. Conversations and tool data are stored in plaintext.

Browser tools use a separate temporary Chrome or Edge context rather than personal tabs. Research workers own their tabs but share the Kest browser context.

## Build and contribute

```sh
bun install --frozen-lockfile --libc "*"
bun run check
bun test
bun run build          # JavaScript bundle
bun run build:exe      # Native executable
bun run release:pack   # Archive + checksum in release/
```

CI pins Bun 1.4.4, caches dependencies, and cancels superseded branch runs. Pushes and pull requests run type checks, tests, and a bundle build. Native Windows and Linux builds run in parallel for tags and manual runs. Tag releases publish archives after checks pass.

Regenerate the UI images with `bun run scripts/readme-screenshots.ts`. This uses installed Chrome, an isolated temporary config, and no provider requests.

See the [research workflow review](docs/research-review.md) for lifecycle fixes, context optimizations, validation, and remaining limits.

For headless usage, context compaction, pricing, browser tools, storage, and live smoke tests, see the [technical reference](docs/reference.md). Live smoke scripts use provider credits; normal tests do not need provider credentials.
