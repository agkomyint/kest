# Browser runner optimization profile

Local Windows, headless Chrome reused between calls, Bun + Playwright. Each median uses eight timed executions after one warmup. Local fixture has 1,000 links/paragraphs. No model or approval latency included.

| Action | Before | After |
|---|---:|---:|
| Fill on large local page | 50.25 ms | 16.51 ms |
| Click on large local page | 61.66 ms | 25.37 ms |
| Open live Wikipedia, reused browser | 142.22 ms | 95.51 ms |

The navigation timing includes website/network/cache variation; it does not establish a guaranteed navigation speedup. A separate Wikipedia fill series encountered a missing-selector timeout and was excluded from the comparison; only the successful complete action series above are reported.

A two-step fill + click batch took a median 33.78 ms (range 32.16–40.84 ms). This performs one final compact observation; it does not measure model latency. Batching also avoids a separate model response between known steps.

Changes: one compact DOM observation instead of a full accessibility traversal after each normal action; no repeated tab-title RPCs in compact responses; up to 12 ordered browser steps per batch, with no intermediate observations; action and observation timing metadata. Explicit `snapshot` retains the full accessibility view. Actionability checks and navigation error handling remain enabled. No fixed 100–300 ms completion promise is made for remote sites or the model provider.

Temporary script removed; fixture server stopped and test browsers closed.
