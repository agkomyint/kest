import { loadStore, savePermission } from "./config";
export {};
import { autoApprove, parsePermission } from "./permissions";
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
    "kest [directory] [--permission all|minimal|strict]\nkest --prompt <message> [--permission all|minimal|strict]\n\nBun coding agent · /connect · /help inside the TUI\nStrict is the default. Headless mode denies actions that require approval.",
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
    const agent = new Agent(
      process.cwd(),
      async (request, signal) =>
        !signal.aborted && autoApprove(permission, request),
    );
    if (args.includes("--research")) {
      const { newCompany } = await import("./research-company");
      agent.research = newCompany(prompt);
    }
    const { newSession, saveSession } = await import("./sessions");
    const { recordUsage, flushUsage } = await import("./usage");
    const session = newSession(process.cwd(), agent.messages);
    session.title = prompt.slice(0, 80);
    session.entries.push({ role: "you", text: prompt });
    if (agent.research) {
      session.research = agent.research;
      await saveSession(session);
    }
    try {
      await agent.run(prompt, credentials, controller.signal, (event) => {
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
          });
        }
        if (event.type === "text")
          process.stdout.write(
            event.delta.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""),
          );
        if (event.type === "tool")
          console.error(`[${event.state}] ${event.name}`);
        if (event.type === "checkpoint")
          console.error(`\n[Research checkpoint ${event.cycle} · continuing]`);
        if (event.type === "worker" && event.event?.type !== "text")
          console.error(
            `[${event.workerId.slice(0, 8)} ${event.role} ${event.model}] ${event.event?.type === "tool" ? `${event.event.name}: ${event.event.state}` : event.event?.type === "status" ? event.event.text : event.state}`,
          );
      });
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
