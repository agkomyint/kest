## overview
Kest is a terminal coding and research agent built on Bun. It runs in your workspace, connects to your own model providers (Nebius, Baseten, Modal; choose with /connect and /model), and keeps sessions, credentials and usage under ~/.kest (KEST_CONFIG_DIR relocates it).
Plain chat can read and search files, edit and write files, run Bun scripts, browse with a separate Chrome/Edge context, plan with set_plan/update_task, and delegate to read-only subagents (optionally in the background).
Bigger capabilities: /research (budgeted multi-agent studies), several studies in parallel "rooms", Tavily web research (/connect tavily), and publishing finished studies to LSI (/connect lsi).
Useful commands: /help, /connect, /model, /permission, /goal, /tasks, /sessions, /resume, /context, /usage, /stats, /tools, /agents, /browser, /tips, /new, /exit.
Ask for a topic with kest_guide: research, rooms, lsi, permissions, budgets, tools, commands.

## research
/research runs a "research company": a director coordinates leads, workers and independent reviewers on one objective under a money budget.
Counting and cleanup: ask "how many studies, what is running, what is done" (research_list) or "delete that study" (research_delete, never while running; LSI findings are untouched). Batch: prepare several studies (each with a budget, none started), then say "start them all" or run /research startall: they start together in the background, up to the concurrent-run limit (/research parallel <n>). Flow: /research prepare <objective> (no model calls; or just describe an idea in chat and Kest checks LSI novelty, posts the question, and prepares the study room for you with research_prepare; if you also give the budget, e.g. "run it with 10$", it sets the allowance, starts the study and switches to its room) -> /research budget 10$ (the TOTAL allowance, not an addition) -> /research start (spends credits).
Up to three simultaneous model calls and three delegation levels. The last 20% of the budget is reserved for the director and review. At low funding Kest saves a proposal with progress and next steps instead of overspending.
Evidence lives in research/<run-id>/ in the workspace: checkpoints, events, worker transcripts, experiment evidence, reports.
The study is only completed after an independent review and a saved final report. Findings still need evidence; funding does not guarantee a correct result.
Pausing: Esc or Ctrl+C pauses; /research resume continues without resetting spend. Closing Kest pauses studies; saved studies are listed by /research show.
Inspect: /research show [study], /research open [report|evidence|reviews|timeline] [study], /agents [id-prefix], /research models (worker model profiles).
/research wrapup stops new experiments, runs review, writes the final report and publishes to LSI when connected. /research off disables continuation.
Budgets use configured token rates and conservative reservations, not the provider invoice; Tavily credits are separate.

## rooms
Each study is a "room": its own session, agent and browser tab, so several studies can run at once in one Kest process.
/research or /rooms (Ctrl+K) opens a picker showing status and spend. /chat leaves a room for normal chat while the study keeps running; a study that needs input must be focused to answer it.
/research parallel <1-10> sets how many may run at once (default 3). /research total 30$ sets one allowance across all studies (/research total off removes it). Both persist.
Most study commands accept a fuzzy title or id, e.g. /research show tokenizer, /research budget indexing 7$.

## lsi
LSI (LLM Scholar Institute, https://lsi-flax.vercel.app) is a light text repository of structured research plus a JSON API for agents. It stores text and links only; host heavy data yourself and link it as evidence. Evidence may also be inline text (up to 6000 chars). It does not depend on any code host.
Connect with /connect lsi using an API key from the LSI account page (LSI_KEY and LSI_BASE_URL, https only, also work).
Reading (search, novelty check, listing open questions, lsi_suggest for proposed follow-up questions drawn from published research) works automatically in chat, and chat can post a new question with lsi_post_question (asks approval unless /permission all). Just describe a question in plain words: Kest classifies it into an LSI domain and topic, checks novelty, and posts it (lsi_add_topic creates a topic tag if none fits). Claiming questions only exists inside a /research run. Publishing unlocks only after the study is completed with an independent review and a final report.
/research publish [domain=<id>] [study] publishes a finished study in one step. Claim/post/publish follow /permission: strict and minimal ask first, all approves automatically.

## permissions
/permission strict (default): edits, writes and scripts need approval. minimal: edits and writes auto-approved, scripts ask. all: everything approved automatically, including Tavily and LSI actions.
Scripts run with the user's permissions; this is not a sandbox. File tools stay inside the workspace and refuse credential files. Headless mode denies anything needing approval.

## budgets
Budget is set per study with /research budget <n>$ (total). /research total caps all studies together. Spend is tracked from configured token rates and reservations, so it approximates, not replaces, the provider's billing. /usage and /stats show usage and tool timings. Esc pauses without losing spend.

## tools
Local: list_files, read_file, search, edit_file, write_file, shell (Bun TypeScript), set_plan, update_task, spawn_subagent, background_status/background_cancel, browser.
Web (after /connect tavily): tavily_search, tavily_extract, tavily_map, tavily_crawl, tavily_research, tavily_research_status.
LSI (after /connect lsi): search, novelty check, list questions, suggest questions, post a question; claim and publish only inside research as described under lsi.
Research-only: research_team, research_review, research_status, list_models, research_complete.

## commands
/help /connect [nebius|baseten|modal|tavily|lsi] /model /permission all|minimal|strict /goal <text> /tasks /new /exit
/research prepare|budget|start|show|open|resume|wrapup|publish|total|parallel|models|off /rooms /chat /agents /browser [url] /sessions /resume <id> /context /usage /stats /tools /tips on|off
Enter sends, Shift+Enter newline, Tab completes commands, Up/Down history, Esc/Ctrl+C cancels, Ctrl+K opens the room picker.

## inbox

Running studies post short notices (milestone, finished, blocked) and sometimes a form to the user's inbox. You do not see any of it until the user reads an item (`/inbox read N`); then it is in your context and the user gives direction in their own words. Draft the form answers with `inbox_draft` and show them. Never send on your own: `inbox_send` only when the user says to send, and the user must confirm. If a form is not answered in 3 minutes (`/inbox timeout M` changes it), the study's director decides for itself. A form about budget, funding or publishing is the user's decision alone: no defaults, every field needs their own explicit answer, no answer means NOT approved, and it never changes the allowance (the user sets that with /research budget). Never fill those fields on your own judgment.

## machine

Kest knows this computer (CPU, RAM, GPU, free disk) and `machine_check` says whether a model size, training run, download or dataset fits: OK, TIGHT or IMPOSSIBLE. Directors and the chat check before planning heavy work and never attempt what is impossible. They tell the user why and offer a smaller scope, a hosted API within the budget, or rented cloud compute, including what the user must set up (account, payment, spend cap, /connect modal). On a weak ("potato") computer, big ideas are scaled down or the user is persuaded to a version it can really run. `/machine` shows the specs.

## procs

Long-running work (dev servers, watchers, local APIs, scrapers, notebooks) goes through the `proc` tool, not `shell`. A small supervisor keeps each process running after the turn and after Kest restarts, and Kest reattaches to it next time. Start with a Bun script or an external program, optionally waiting until a port opens or a log line appears, then use list, logs, send and stop. Every agent in the workspace can use the same process, for example a study worker calling a server another worker started. Starting needs approval; processes stop on their own after 6 hours unless a longer ttl is given. You see them under the input box, `/procs` lists them, `/procs watch NAME` or Alt+P shows a live log, and `/procs stop NAME|all` closes them.
