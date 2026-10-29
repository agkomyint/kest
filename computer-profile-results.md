# Local computer automation profile

Run: 2026-10-29T05:29:34.808Z

10 tasks, 7 timed trials for each runtime after one warmup per task: 140 measured executions and 20 warmups. Runtime order alternated. Each execution checked its result. Timings include startup, work, validation, and process exit. PowerShell used -NoProfile -NonInteractive. Bun used direct TypeScript/JavaScript execution.

| Task | Bun median (ms) | PowerShell median (ms) | Ratio |
|---|---:|---:|---:|
| System information | 41.06 | 305.87 | 7.45x |
| List 200 files | 39.44 | 268.31 | 6.80x |
| Read 1 MiB file | 47.57 | 304.79 | 6.41x |
| Search 200 files | 45.25 | 318.90 | 7.05x |
| Write and verify 1 MiB | 41.14 | 262.22 | 6.37x |
| Copy and verify file | 37.33 | 259.74 | 6.96x |
| Create, rename, delete | 38.67 | 256.89 | 6.64x |
| Filter 1000 JSON records | 39.29 | 336.08 | 8.55x |
| Local HTTP request | 39.47 | 301.56 | 7.64x |
| Launch isolated GUI app and wait | 147.67 | 1318.16 | 8.93x |

Sum of task medians: Bun 516.89 ms; PowerShell 3932.52 ms (7.61x). This is not a measured single batch.

These are local end-to-end small-task measurements, dominated by startup. They do not establish that every Bun program or full application is faster. System-info implementations use platform-appropriate APIs (Bun node:os versus PowerShell/.NET/CIM), rather than identical underlying calls. File search uses bounded parallelism in Bun versus a PowerShell pipeline. The GUI case launches a dedicated hidden WinForms helper, waits for successful exit, and checks its output marker. It does not test Chrome, mouse control, screenshots, or GUI interaction. No model latency or human approval time is included.

Cleanup: the local HTTP server was stopped, the helper app exited, and temporary fixtures, compiled app, and benchmark script were removed. Only this report and its raw timing results were retained.
