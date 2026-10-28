export {};
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    "kest [directory]\nkest --prompt <message>\n\nBun coding agent · /connect · /help inside the TUI\nHeadless mode uses your real endpoint; edits and shell commands are denied.",
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
    const agent = new Agent(process.cwd(), async () => false);
    try {
      await agent.run(prompt, credentials, controller.signal, (event) => {
        if (event.type === "text")
          process.stdout.write(
            event.delta.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""),
          );
        if (event.type === "tool")
          console.error(`[${event.state}] ${event.name}`);
      });
      console.log();
    } catch {
      console.error(
        "Request failed or cancelled. Open kest to check /status and /connect.",
      );
      process.exitCode = 1;
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
    await start(cwd);
  }
}
