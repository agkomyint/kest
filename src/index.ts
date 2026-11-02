#!/usr/bin/env bun
import { loadStore, savePermission } from "./config";
export {};
import { autoApprove, parsePermission } from "./permissions";
const procdAt = process.argv.indexOf("--procd");
if (procdAt !== -1) {
  // Background process supervisor: detached from the app, serves .kest/procs.
  const { runDaemon } = await import("./procd");
  await runDaemon(process.argv[procdAt + 1] ?? process.cwd());
  process.exit(0);
}
const args = process.argv.slice(2);
const permissionIndex = args.indexOf("--permission");
let permission: import("./permissions").Permission = "strict";
if (permissionIndex !== -1) {
  try {
    permission = parsePermission(args[permissionIndex + 1] ?? "");
  } catch {
    console.error("Use --permission all|minimal|strict");
    process.exit(1);
  }
  args.splice(permissionIndex, 2);
}
if (!args.includes("--help") && !args.includes("-h")) {
  if (permissionIndex !== -1) await savePermission(permission);
  else permission = (await loadStore()).permission;
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    "kest [directory] [--permission all|minimal|strict]\nkest --prompt <message> [--research --budget 10$ [--auto-publish]] [--permission all|minimal|strict]\n\nBun coding agent · /connect · /help inside the TUI\nStrict is the default. Headless mode denies actions that require approval.",
  );
} else if (args.includes("--prompt")) {
  const { Agent } = await import("./agent");
  const { loadCredentials } = await import("./config");
  const credentials = await loadCredentials();
  const prompt = args[args.indexOf("--prompt") + 1];
  if (!credentials || !prompt) {
    console.error("Run kest and /connect first, then use --prompt <message>.");
    process.exitCode = 1;
  } else {
    const controller = new AbortController();
    process.on("SIGINT", () => controller.abort());
    const denied: string[] = [];
    const agent = new Agent(
      process.cwd(),
      async (request, signal) => {
        const ok = !signal.aborted && autoApprove(permission, request);
        if (!ok) {
          denied.push(request.kind ?? "action");
          console.error(`[denied ${request.kind ?? "action"}] ${request.title}`);
        }
        return ok;
      },
    );
    const published: string[] = [];
    if (args.includes("--research")) {
      const { newCompany, parseCostBudget } =
        await import("./research-company");
      const budget = args[args.indexOf("--budget") + 1];
      if (!args.includes("--budget") || !budget) {
        console.error(
          "Headless research requires --budget 10$ (a total USD allowance).",
        );
        process.exit(1);
      }
      agent.research = newCompany(prompt);
      agent.research.maxCostUsd = parseCostBudget(budget);
      // Headless has no one to ask: --auto-publish lets the study claim, post and publish to LSI.
      if (args.includes("--auto-publish")) agent.research.autoPublish = true;
    }
    const { publishedIds, runReport } = await import("./headless");
    const { newSession, saveSession } = await import("./sessions");
    const { recordUsage, flushUsage } = await import("./usage");
    const session = newSession(process.cwd(), agent.messages);
    session.title = prompt.slice(0, 80);
    session.entries.push({ role: "you", text: prompt });
    if (agent.research) {
      session.research = agent.research;
      await saveSession(session);
    }
    const emit = (event: import("./agent").AgentEvent) => {
      if (event.type === "usage") {
        void recordUsage(event.model, event.input, event.output).catch(() =>
          console.error("Could not save token usage to disk."),
        );
      }
      if (
        event.type === "tool" &&
        event.state !== "running" &&
        event.durationMs !== undefined
      ) {
        (session.toolStats ??= []).push({
          name: event.name,
          durationMs: event.durationMs,
          error: event.state === "error",
          tier: event.tier,
          chars: event.chars,
          estUsd: event.estUsd,
        });
      }
      if (
        event.type === "tool" &&
        event.name === "lsi_publish" &&
        event.state === "done" &&
        event.output
      )
        published.push(...publishedIds(event.output));
      if (event.type === "text")
        process.stdout.write(
          event.delta.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""),
        );
      if (event.type === "tool")
        console.error(`[${event.state}] ${event.name}`);
      if (event.type === "checkpoint")
        console.error(`\n[Research checkpoint ${event.cycle} · continuing]`);
      if (event.type === "background")
        console.error(
          `[background ${event.state}] ${event.taskId.slice(0, 8)} ${event.task}`,
        );
      if (
        event.type === "worker" &&
        event.event?.type === "tool" &&
        event.event.state !== "running" &&
        event.event.durationMs !== undefined
      )
        (session.toolStats ??= []).push({
          name: event.event.name,
          durationMs: event.event.durationMs,
          error: event.event.state === "error",
          tier: event.event.tier,
          chars: event.event.chars,
          estUsd: event.event.estUsd,
        });
      if (event.type === "worker" && event.event?.type !== "text")
        console.error(
          `[${event.workerId.slice(0, 8)} ${event.role} ${event.model}] ${event.event?.type === "tool" ? `${event.event.name}: ${event.event.state}` : event.event?.type === "status" ? event.event.text : event.state}`,
        );
    };
    try {
      await agent.run(prompt, credentials, controller.signal, emit);
      // Background wake-up: let finished background work start a new turn
      // instead of stranding its result until the user happens to return.
      while (!controller.signal.aborted && agent.hasRunningBackground()) {
        await agent.waitForBackground();
        const wakes = agent.takeBackgroundWakeups();
        if (!wakes.length) break;
        await agent.run(
          wakes.join("\n\n"),
          credentials,
          controller.signal,
          emit,
        );
      }
      console.log();
    } catch {
      console.error(
        "Request failed or cancelled. Open kest to check /status and /connect.",
      );
      process.exitCode = 1;
    } finally {
      await flushUsage();
      session.messages = agent.messages;
      session.context = agent.context;
      session.research = agent.research ?? undefined;
      session.tasks = agent.tasks;
      await saveSession(session).catch(() =>
        console.error("Could not save session to disk."),
      );
      await agent.browser.close();
      if (agent.research || published.length) {
        const { lsiBaseUrl } = await import("./lsi");
        const report = runReport({
          study: agent.research ?? null,
          autoPublish: agent.research?.autoPublish === true,
          published: [...new Set(published)],
          denied,
          toolStats: session.toolStats ?? [],
          baseUrl: lsiBaseUrl(),
        });
        console.error(report.lines.join("\n"));
        if (report.exitCode && !process.exitCode) process.exitCode = report.exitCode;
      }
    }
  }
} else {
  const { resolve } = await import("node:path");
  const { stat } = await import("node:fs/promises");
  const cwd = resolve(args[0] ?? process.cwd());
  if (!(await stat(cwd)).isDirectory())
    throw new Error("Workspace must be a directory.");
  if (!process.stdin.isTTY) {
    console.error("Use an interactive terminal, or kest --prompt <message>.");
    process.exitCode = 1;
  } else {
    const { start } = await import("./ui");
    await start(cwd, permission);
  }
}
