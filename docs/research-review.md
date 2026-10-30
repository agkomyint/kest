# Research workflow review

Reviewed preparation, funding, start/resume, model routing, delegation, tool execution, context compaction, evidence persistence, independent review, completion, cancellation, and restart recovery.

## Changes

| Finding | Change |
| --- | --- |
| Preparing a new objective reused the previous session and could lose the old study’s discoverable reference. | Give every new study a separate saved session and fresh working context. Preserve the previous session. |
| `/research off` removed the session’s research reference. | Persist a separate continuation flag. Keep the objective, budget, evidence reference, and disabled state through ordinary chat and session reopening. Explicit start/resume enables continuation again. |
| Budget updates could change a completed study to paused. | Keep completed studies closed; new work requires a new objective. Recover completion and the report path from the research checkpoint if the session save lagged behind. |
| Resume repeated the entire launch instruction block. | Send a short checkpoint-first continuation request. Keep stable company instructions in the system prompt. |
| Large parallel observations repeatedly filled the context window. | Send labeled excerpts of large research tool observations: at most 8 KB per result and about 16 KB per batch, shared between results. The journal retains each full returned tool output with its tool-call ID; experiment files remain authoritative. Ordinary chat is unchanged. |
| Status emphasized a bar and long IDs without an obvious next action. | Show a readable state, spent/total, money left, a short session prefix, report path when complete, and a state-specific next command. Shorten activity text to leave room for the budget. |
| A fresh launch did not indicate saved research existed. | Show a local saved-study hint at startup, without restoring or spending automatically. |

## Validation

- Deterministic end-to-end tests cover concurrent workers, nested routing, real local experiments, independent review, report completion, budget rejection, cancellation, persisted recovery, and continuation.
- A new local-provider fixture returns two large observations, verifies the model receives labeled excerpts totaling no more than 16 KB, checks that the original returned outputs remain in the journal, and completes a previously reviewed study in two requests.
- Lifecycle regressions verify separate study sessions, disabled continuation through ordinary chat, budget preservation on completed studies, and recovery of the final report pointer.
- Context tests verify UTF-8 excerpts stay within their byte limit without splitting characters.
- Existing spend accounting, concurrency/depth limits, review reserve, scope restrictions, and unknown-price rejection remain enforced.
- Native UI captures are regenerated locally and inspected. No paid provider calls or changes to existing user research are needed for these checks.

The observation reduction is measured on deterministic fixtures. It reduces retained model input; it is not a measured percentage improvement in research quality, provider latency, or total real-world spend.

## Remaining boundaries

- Shared budget/concurrency enforcement coordinates agents within one Kest runtime. Separate processes running the same study do not have a cross-process study lock. Run a study in one Kest process at a time.
- The USD allowance uses configured model rates and conservative reservations. It cannot guarantee the provider’s invoice or account-level billing limit.
- Completion verifies an independent review returned and a nonempty report exists. It cannot certify the methodology, factual claims, novelty, or correctness of the report.
- Journaled tool output can itself be bounded by the tool. Experiment scripts must save full raw results separately; a UI preview or observation excerpt is not a substitute for those files.
