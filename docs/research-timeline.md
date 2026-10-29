# Proposed research timeline

Design proposal. This timeline and the proposed `report_finding` tool are not implemented yet.

The main transcript should show research progress and evidence updates. Consecutive low-level tool calls belong inside compact expandable activity groups. Worker activity remains inspectable without creating a new full-height block for every event.

```text
Indexing study                         RUNNING · 18m 42s
Tokens 284k / 1m · 3 researchers active

14:02  ✓ Review prior work                         3m 01s  ▸
14:05  ✓ Inspect existing implementation              2s  ▸
14:06  ● Test buffered-write prototype             1m 12s  ▾
       ├ Correctness checks                       passed  ▸
       ├ Mixed-workload benchmark                running  ▸
       └ Skeptical review                        waiting  ▸

14:07  FINDING · negative result
       Buffered writes improved throughput in the tested
       workload, but p99 exceeded the configured limit.
       Evidence: run-004.json · Next: bound flush size.
       Continuing with the next experiment.
```

All scientific statements above are illustrative interface copy, not Kest benchmark results.

## Activity groups

- A collapsed phase occupies one line: start time, state, meaningful label, elapsed duration, and expansion marker.
- Group consecutive calls under the current plan step. Use an agent's task as the parent of its own calls. Do not infer scientific success from tool exit codes.
- Show the active phase and its latest meaningful action. Collapse completed phases automatically; preserve an explicitly expanded inspector.
- Keep raw tool counts inside details. Display human durations such as `3m 01s`, rather than `180775.97 ms`.
- Expand a group to inspect the exact ordered calls, timestamps, durations, arguments, output, errors, and artifact links. Scroll within a bounded details panel.
- Researcher rows expose model, task, state, and transcript access. Their output must never overwrite another researcher's or the director's trace.
- A token meter should distinguish provider-reported usage from pending/estimated usage. Show remaining time/request/agent safeguards when relevant.

## Findings

Introduce a user-visible `report_finding` tool with a proposed shape:

```json
{
  "kind": "negative_result",
  "title": "Latency constraint exceeded",
  "summary": "A short, evidence-grounded observation.",
  "evidence": ["research/run-id/results/run-004.json"],
  "limitations": "What the experiment does not establish.",
  "next_action": "Test the bounded-flush variant."
}
```

Allowed kinds: observation, negative result, hypothesis, blocker, checkpoint. Keep an explicit distinction between measurements and hypotheses. Evidence references do not themselves certify correctness or novelty.

Reporting records a durable event and returns control to the agent loop. It does not end the research run. Show reports at meaningful milestones, not after every tool call. Merge repetitive updates and collapse older reports. Approval prompts and actionable failures remain immediately visible.

## Run state

A completed phase means that phase finished, not that the research objective was achieved. Findings normally say what happens next. The run remains active while the controller pursues justified hypotheses, replications, and regression checks within the user's objective and budget. Only explicit pause/cancellation, resource exhaustion, an unrecoverable blocker, or a justified final outcome should produce a stopped state. Never label a budget checkpoint as a successful study.

## First implementation

Start with compact consecutive-call groups, human time formatting, the existing bounded inspector, and structured finding events. Add a separate full-screen researcher inspector only after the main timeline stays readable under long runs. Preserve the full trace in storage even when most rows are collapsed.
