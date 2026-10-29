// Explicit live check: automatic context compaction followed by a real reply.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent";
import { loadCredentials } from "../src/config";
import { recordUsage, flushUsage } from "../src/usage";

if (!Bun.argv.includes("--live"))
  throw new Error("Pass --live to use configured provider credits.");
const credentials = await loadCredentials();
if (!credentials) throw new Error("Connect a provider first.");
const cwd = await mkdtemp(join(tmpdir(), "kest-context-live-"));
const agent = new Agent(cwd, async () => false, [
  {
    role: "system",
    content:
      "You are a coding assistant. Preserve user data. This is an orchestration smoke test, not scientific evidence.",
  },
  {
    role: "user",
    content:
      "Inspect a synthetic work log. No files were changed or experiments run.",
  },
  {
    role: "assistant",
    content:
      "Synthetic work log: no experiments executed; no performance findings. ".repeat(
        4000,
      ),
  },
  {
    role: "user",
    content: "Preserve the fact that this is synthetic smoke-test data.",
  },
  {
    role: "assistant",
    content: "Agreed; no research outcome or performance claim is established.",
  },
]);
let usageRequests = 0;
try {
  await agent.run(
    "This is the latest request: do not use tools or run research. Reply in one sentence that context compaction completed and the original task can continue, without claiming any scientific result.",
    credentials,
    AbortSignal.timeout(90000),
    (event) => {
      if (event.type === "status") console.log(event.text);
      if (event.type === "usage") {
        usageRequests++;
        void recordUsage(event.model, event.input, event.output);
      }
      if (event.type === "text") process.stdout.write(event.delta);
    },
    3,
  );
  if (!agent.context.compactions || agent.messages.at(-1)?.role !== "assistant")
    throw new Error(
      "Compaction did not resume into a final assistant response.",
    );
  const report = {
    compactions: agent.context.compactions,
    fallback: agent.context.summary.includes("LOCAL EXTRACTIVE FALLBACK"),
    archivedMessages: agent.context.archive.length,
    usageRequests,
    summary: agent.context.summary,
    final: agent.messages.at(-1)?.content,
  };
  await Bun.write(join(cwd, "report.json"), JSON.stringify(report, null, 2));
  console.log(
    `\nPASS: automatic compaction → resumed provider response. ${cwd}`,
  );
} finally {
  await agent.browser.close();
  await flushUsage();
}
