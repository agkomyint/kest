# Kest tips

The short tip catalog below supplies the application's idle tip row. The reference sections document commands and flags; they are not displayed in the row.

Checked against the current CLI parser, slash-command handlers, keyboard bindings, permissions, and local Tavily/LSI integrations. Some integrations are still local changes and may not exist in an older release binary.

## Placement and navigation

Show one muted line just above the input when Kest is idle:

```text
‹  Tip: /permission all automatically approves edits, scripts and web actions.  ›  3/12

> Ask Kest to investigate something…
```

- Keep one tip visible; do not print a new transcript entry for every tip.
- Pick a relevant tip once per session or after a meaningful state change. Keep it still while the user types or reads. There is no automatic rotation.
- Click ‹ / › or use Alt+Left / Alt+Right to browse tips. Navigation wraps around and preserves the input draft. Plain Left/Right still edits the prompt. The counter reflects the currently available tips; 3/12 above is illustrative.
- Hide the tip during approvals, credential entry, errors, and active work so it does not compete with important messages.
- Let narrow terminals wrap to at most two lines.
- Do not change settings or run a command when displaying a tip.
- Make the full explanation available through a future help view. A `/tips` command and a hide-tips preference are proposals, not existing features.

For permissions, show the `/permission all` suggestion only when automatic approval is not already enabled. Its fuller explanation should say that scripts run with the user's permissions, the choice is saved, and automatic approval also covers LSI account writes.

## Short tip catalog

Each line below is ready-to-use copy for a future tip row.

| Situation | Short tip |
| --- | --- |
| First launch | Tip: /connect sets up your model provider; /model chooses a model. |
| Reviewing permissions | Tip: /permission shows your current approval mode. |
| Wants fewer interruptions | Tip: /permission all automatically approves edits, scripts and web actions. |
| Wants edits approved automatically | Tip: /permission minimal approves file edits and asks before scripts and web actions. |
| Wants to review every change | Tip: /permission strict asks before edits, scripts and web actions. |
| Learning commands | Tip: Press Tab to complete commands and subcommands. |
| Writing a longer request | Tip: Shift+Enter or Ctrl+Enter adds a new line; Enter sends. |
| Inspecting activity | Tip: Expand an activity group, then an action, to inspect its input, output and timing. |
| Understanding timing | Tip: Total action time adds up individual durations; parallel actions can overlap. |
| Inspecting long output | Tip: Scroll inside an expanded action's input or output panel to read more. |
| Copying output | Tip: Drag to select text, then Ctrl+C or Ctrl+Y to copy it. |
| Reading older output | Tip: Ctrl+End jumps to the latest activity. |
| Beginning research | Tip: Prepare an objective, set a dollar budget, then run /research start. |
| Prepared without funding | Tip: /research budget 5$ sets a total model allowance of $5. |
| Prepared and funded | Tip: /research start launches your prepared study. |
| Checking saved work | Tip: /research show lists saved studies and their next actions. |
| Continuing after a pause | Tip: /research resume continues your study with its existing spending preserved. |
| Choosing between saved studies | Tip: Use /research show, then /resume <session-id> to open the study you want. |
| Changing funding | Tip: /research budget 10$ sets the total allowance to $10, including existing spending. |
| Pausing research | Tip: Esc or Ctrl+C pauses active research and keeps its checkpoint. |
| Inspecting researchers | Tip: /agents lists workers; /agents <id-prefix> opens a worker's transcript. |
| Switching to ordinary chat | Tip: /research off disables continuation and keeps the saved study. |
| Starting another study | Tip: /research prepare <objective> creates a separate study and keeps the previous one. |
| Checking an existing report | Tip: /research show includes the report path for a completed study. |
| Connection interrupted | Tip: Open the error details, then use /research resume to continue paused work. |
| Large conversation | Tip: /context shows context size; /context archive lists archived messages. |
| Summarizing context | Tip: /context compact creates working memory using your connected model. |
| Reviewing token usage | Tip: /usage shows recorded model tokens and estimated costs. |
| Reviewing tool performance | Tip: /stats shows tool counts, errors and timings across saved sessions. |
| Finding available capabilities | Tip: /tools lists the tools available to your current agent. |
| Working toward an objective | Tip: /goal <objective> sets a goal and starts work; /tasks shows its plan. |
| Reopening a conversation | Tip: /sessions lists workspace conversations; /resume <id-prefix> reopens one. |
| Starting a fresh conversation | Tip: /new starts fresh; previous saved sessions remain available through /sessions. |
| Using a visible browser | Tip: /browser <url> opens Kest's browser; /browser close closes it. |
| Adding web research | Tip: /connect tavily adds web search, page extraction, mapping, crawling and research tasks. |
| Using Tavily | Tip: Tavily uses separate credits; /research budget covers model calls. |
| Reading source material | Tip: Ask for a focused web search, then extraction of the most relevant source pages. |
| Checking remote research | Tip: Keep the Tavily request ID and retrieve its status instead of creating another task. |
| Adding LSI | Tip: /connect lsi adds research discovery, novelty checks and publishing tools. |
| LSI account actions | Tip: /permission all also approves LSI account actions such as publishing. |
| Inspecting the connection | Tip: /provider shows the active provider and model; /status shows connection details. |
| Finding help | Tip: /help lists commands and keyboard shortcuts. |

## Every application CLI flag

These are application flags parsed by `src/index.ts`. Bun install/build switches are separate developer commands.

| Flag or argument | Behavior | Example |
| --- | --- | --- |
| `[directory]` | Positional workspace directory for the interactive UI. Defaults to the current directory. | `kest D:\kest-demo` |
| `--permission all` | Automatically approve file edits, writes, scripts, browser actions and Tavily requests. Saves the permission choice; also approves LSI account writes. | `kest D:\kest-demo --permission all` |
| `--permission minimal` | Automatically approve file edits/writes; ask before scripts, browser actions and new Tavily requests. Saves the choice. | `kest --permission minimal` |
| `--permission strict` | Ask before edits/writes, scripts, browser actions and new Tavily requests. Initial default; saves the choice. | `kest --permission strict` |
| `--prompt <message>` | Run a headless task using the current working directory. Requires configured model credentials. | `kest --prompt "Read package.json and explain this project"` |
| `--research` | Enable the research workflow for a headless `--prompt` task. Requires an explicit USD budget. | `kest --prompt "Compare two algorithms" --research --budget '5$'` |
| `--budget <USD>` | Set the total model allowance for headless research. Include the dollar sign, for example `5$` or `$5`. Used with `--prompt` and `--research`. | `kest --prompt "Compare two algorithms" --research --budget '5$' --permission minimal` |
| `--help`, `-h` | Print CLI usage. | `kest --help` |

Headless mode cannot show an approval prompt: operations requiring approval are denied. Choose a permission mode that fits the intended task. LSI account writes follow the same approval mode.

For headless work in a particular project, change into that directory first. The current implementation uses the process working directory in `--prompt` mode:

```powershell
Set-Location D:\kest-demo
kest --prompt "Compare two algorithms using reproducible benchmarks" --research --budget '5$' --permission minimal
```

## In-app command guide

Type these inside Kest rather than in PowerShell or Bash.

| Command | Tip or important behavior |
| --- | --- |
| `/connect` | Choose a model provider or connected service. Key entry is masked. |
| `/connect modal`, `/connect baseten`, `/connect nebius` | Set up model credentials; existing providers can keep multiple named keys. |
| `/connect tavily` | Save a separate Tavily key and show its newly available tools. Keeps the current model provider. |
| `/connect lsi` | Save a separate LSI key and show its available tools. Keeps the current model provider. |
| `/provider` | Inspect the active provider and model. |
| `/model [model-id]` | Open the model picker, or select a supported model directly. |
| `/permission [all|minimal|strict]` | Show or change the saved approval mode. |
| `/research prepare <objective>` | Prepare a separate saved study without model calls. |
| `/research <objective>` or `/research start <objective>` | Prepare an objective through the shorthand launch path; it asks for funding before model calls. This path currently requires a model connection. |
| `/research budget 5$` | Set the total model allowance. Spent and reserved amounts remain counted. |
| `/research start` | Start the prepared study. |
| `/research resume` | Continue a paused study. |
| `/research wrapup` | Request review and a final report from existing evidence instead of starting more experiments. |
| `/research`, `/research show` | Inspect current research, or list saved research in this workspace. |
| `/research off` | Disable continuation while retaining the saved study. |
| `/research models` | Inspect configured worker model profiles, availability and pricing information. |
| `/research model <alias> <provider> <model-id>` | Configure a worker model profile using an existing provider connection. |
| `/research endpoint <alias> <https-base-url> <model-id> <API_KEY_ENV_NAME>` | Configure an OpenAI-compatible endpoint using an environment variable name. Never paste the actual secret here. Unknown model pricing blocks budgeted calls. |
| `/agents [id-prefix]` | List workers or inspect one worker's retained transcript. |
| `/goal <objective>`, `/goal clear` | Set a goal and begin work, or clear it. Beginning work can use model credits. |
| `/tasks` | Inspect the current plan. |
| `/browser [url]`, `/browser tabs`, `/browser close` | Open Kest's separate browser, list its tabs, or close it. Chrome or Edge must be installed. |
| `/context` | Inspect the estimated local context budget and message/archive counts. |
| `/context summary`, `/context messages`, `/context archive` | Inspect working memory, active messages or archived originals. |
| `/context show <number>`, `/context archived <number>` | Read a numbered active or archived message. |
| `/context compact` | Request a model-generated summary. Uses model credits; original messages are archived when compaction succeeds. |
| `/usage` or `/tokens` | Inspect recorded model token usage, pricing and estimated costs. |
| `/stats` | Inspect tool call counts, failures and timings across saved sessions. |
| `/sessions`, `/resume <id-prefix>` | List or reopen a workspace session. Session prefixes must identify exactly one session. |
| `/new` | Start a fresh conversation. |
| `/system <instructions>` | Start a new session with custom instructions. |
| `/tools` | Inspect available tools, including configured web services. |
| `/status` | Inspect connection, model, workspace and session information. |
| `/help` | Display commands and shortcuts. |
| `/exit` or `/quit` | Quit Kest. |

## Keyboard tips

| Key or gesture | Behavior |
| --- | --- |
| Enter | Send the prompt or confirm a picker selection. |
| Shift+Enter / Ctrl+Enter | Insert a newline. |
| Tab | Complete commands and cycle matching completions. |
| Up / Down | Browse prompt history when the input is a single line; navigate an open picker. |
| Esc | Cancel active work, dismiss a picker, cancel credential entry or deny an approval, depending on the current state. |
| Ctrl+C | Copy a selection if present; otherwise cancel active work or quit when idle. |
| Ctrl+Y | Copy selected text. |
| PgUp / PgDn | Scroll the conversation; scroll a focused action panel when applicable. |
| End with empty input / Ctrl+End | Jump to the newest conversation activity. |
| Click an activity group | Expand or collapse its individual actions. |
| Click an action | Expand or collapse its input/output panels. |
| Ctrl+O | Toggle the most recently selected or tracked expandable row. |
| Ctrl+Shift+I / Ctrl+Shift+O | Expand an action and focus its input/output panel. |
| Arrow keys / PgUp / PgDn / Home / End in a focused panel | Inspect that panel's content. Esc returns to the composer. |
| Ctrl+U during credential entry | Clear the masked value. |

## Environment settings worth documenting

These are environment variables, not CLI flags. Set them before launching Kest.

| Setting | Purpose |
| --- | --- |
| `KEST_CONFIG_DIR` | Relocate local config, saved sessions and related Kest storage. |
| `KEST_USAGE_FILE` | Override the usage ledger location separately. |
| `KEST_CONTEXT_BUDGET` | Set the estimated local context budget: 12,000–200,000 tokens; current default is 20,000. |
| `KEST_SUMMARY_TIMEOUT_MS` | Set summary request timeout: 50–120,000 ms; current default is 30,000 ms per attempt. |
| `BASETEN_API_KEY`, `NEBIUS_API_KEY` | Model provider credentials. |
| `MODAL_PROXY_TOKEN_ID`, `MODAL_PROXY_TOKEN_SECRET` | Modal proxy credentials. |
| `TAVILY_API_KEY` | Tavily credentials when a saved key is not available. |
| `LSI_KEY`, `LSI_BASE_URL` | LSI credentials and optional service URL. |

## Copy rules for future tips

- Keep the visible tip short and actionable. Prefer one command or shortcut per tip.
- Describe the actual scope: “automatically approves edits, scripts and web actions” rather than “approves everything.”
- Explain saved settings, model spending, separate Tavily credits and the effect of approval modes on external publishing in expanded help.
- Match the current state: prepared studies need start; paused studies need resume; multiple studies need selection.
- Never display keys, private prompts, raw API responses or user-specific filesystem paths in generic tips.
- Showing a tip must not make a model call, connect a service, increase a budget, or enable automatic approval.

## Source checklist

- `src/index.ts`: application flags, positional workspace, headless behavior.
- `src/permissions.ts`: approval modes, including LSI account writes.
- `src/complete.ts`: discoverable slash commands and subcommands.
- `src/ui.ts`: command behavior, masked connection setup, shortcuts and activity inspection.
- `src/context.ts` and `src/agent.ts`: local context budget and summary timeout.
- `src/tavily.ts` and `src/lsi.ts`: service capabilities and separate connection behavior.

The tip row, contextual selection, previous/next arrows and keyboard navigation are implemented. A full `/tips` command and a hide-tips preference remain future proposals.
