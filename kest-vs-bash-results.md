# Kest vs Git Bash: local Windows benchmark

Run: 2026-10-29T05:37:09.127Z
Bun 1.4.4; GNU bash, version 5.2.37(1)-release (x86_64-pc-msys)

Five tasks, 20 measured trials per task per mode after one warmup: 400 measured executions. Order rotated. Every result validated. Native Bun APIs versus Bash builtins and Git coreutils. No model or approval latency. Prepared modes both received 100 ms startup lead time, excluded from dispatch latency. Fresh one-use processes in all modes.

| Task | Kest cold | Bash cold | Kest prepared | Bash prepared |
|---|---:|---:|---:|---:|
| Print a short result | 37.64 ms | 31.70 ms | 9.80 ms | 9.65 ms |
| List 200 files | 40.58 ms | 33.54 ms | 14.01 ms | 10.91 ms |
| Read 1 MiB | 49.15 ms | 105.43 ms | 16.30 ms | 71.48 ms |
| Search 200 files | 52.85 ms | 104.48 ms | 22.95 ms | 80.33 ms |
| Copy 1 MiB | 46.32 ms | 103.84 ms | 16.07 ms | 77.07 ms |

These numbers apply to this Windows machine and Git Bash, not Linux/macOS Bash or every workload. Reading uses Bun.file text versus cat piped to wc, search uses bounded Bun concurrency versus grep piped to wc, and copying uses node copyFile versus cp and size verification. Small script benchmarks reflect process and utility startup overhead as well as work. Warmed filesystem caches are expected.

Temporary fixture files and benchmark script were removed; test processes exited. Raw results are retained in kest-vs-bash-results.json.
