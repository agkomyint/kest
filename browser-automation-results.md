# Bun + Playwright browser automation profile

Windows; Bun 1.4.4; Playwright 1.64.1; headless browsers; 1280×720 viewport.

Ten timed trials per task per browser, after one warmup: **200 validated successful workflows**. Browser startup was measured separately over five fresh process/context/tab launches. These measure the prospective browser engine, not a completed Kest browser-tool integration or model response time.

| Task | Chrome median | Edge median | Source |
|---|---:|---:|---|
| Open Wikipedia | 159.41 ms | 157.90 ms | Live Wikipedia |
| Search Wikipedia for Black hole | 918.37 ms | 948.96 ms | Live Wikipedia |
| Follow article link | 897.15 ms | 1010.62 ms | Live Wikipedia |
| Extract article text and links | 148.75 ms | 168.15 ms | Live Wikipedia |
| Fill three fields and submit | 81.89 ms | 64.09 ms | Local fixture |
| Select dropdown and checkbox | 42.16 ms | 48.16 ms | Local fixture |
| Filter 200 table rows | 37.38 ms | 39.04 ms | Local fixture |
| Upload and verify a small file | 63.27 ms | 58.74 ms | Local fixture |
| Download and verify 512 KiB | 124.82 ms | 166.15 ms | Local fixture |
| Capture viewport screenshot | 41.14 ms | 52.83 ms | Local fixture |

Startup including context and blank tab: **Chrome 412.13 ms** (392.76–489.77 ms), **Edge 522.46 ms** (506.11–592.47 ms). Chrome version 155.0.8059.85; Edge version 156.0.4314.42.

Open Wikipedia includes navigation and validation. Other tasks start from an already-loaded prerequisite page; setup navigation is excluded. Search and link-click cases include navigation and destination-heading validation. Upload sends fixture data to a loopback server and validates its response. Download saves and reads the resulting file. Screenshot creates a PNG in memory and validates it.

No fixed sleeps were inserted. The browsers were reused, in isolated contexts without the user's normal browser profile. Network/filesystem caches were warmed. Browser order was sequential. These are local results, not a universal browser ranking. Local-fixture times exclude public-site latency; headless results exclude visible rendering cost. Model latency, approvals, login, website challenges, and screenshot interpretation are excluded. First-use requests also need startup.

The initial article-link test failed because a relative href selector did not match Wikipedia's absolute hrefs. After inspecting the actual links, the selector was corrected and ten trials per browser succeeded. The initial failures remain in the raw JSON.

The benchmark browser instances were closed and the local server stopped. Temporary scripts, dependency installation, downloads, and fixtures were removed. Project dependencies and application code were not changed. Raw results: `browser-automation-results.json`.

API references: [browser launch](https://playwright.dev/docs/api/class-browsertype), [automatic waiting](https://playwright.dev/docs/actionability).
