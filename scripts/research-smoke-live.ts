// Explicit opt-in: real provider requests within a USD allowance and a smoke-test timeout.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent";
import { loadCredentials } from "../src/config";
import {
  CompanyRuntime,
  newCompany,
  parseCostBudget,
} from "../src/research-company";
import { recordUsage, flushUsage } from "../src/usage";

if (!Bun.argv.includes("--live"))
  throw new Error("Pass --live to use configured API credits.");
const credentials = await loadCredentials();
if (!credentials) throw new Error("Connect a provider in Kest first.");
const cwd = await mkdtemp(join(tmpdir(), "kest-research-live-"));
const state = newCompany(
  "Verify arithmetic evidence, collect three independent inspections, and write a reviewed workflow smoke report. No performance or novelty claims.",
);
const budgetIndex = Bun.argv.indexOf("--budget");
if (budgetIndex < 0)
  throw new Error("Pass --budget 1$ to authorize a total USD allowance.");
state.maxCostUsd = parseCostBudget(Bun.argv[budgetIndex + 1] ?? "");
const runtime = new CompanyRuntime(state, cwd);
const agent = new Agent(cwd, async (request) => request.kind === "file");
agent.research = state;
agent.useCompany(runtime, 0);
const signal = AbortSignal.timeout(180000);
const events: unknown[] = [];
const observe = (event: Parameters<Parameters<Agent["run"]>[3]>[0]) => {
  events.push(event);
  if (event.type === "usage")
    recordUsage(event.model, event.input, event.output);
};
const evidence = {
  sum: Array.from({ length: 10 }, (_, i) => i).reduce((a, b) => a + b, 0),
  expected: 45,
};
await Bun.write(join(cwd, "evidence.json"), JSON.stringify(evidence));
console.log(`Provider: ${credentials.provider}; artifacts: ${cwd}`);
try {
  state.status = "running";
  await runtime.record("run_started", { objective: state.objective });
  const findings = JSON.parse(
    await agent.executeCompanyTool(
      "research_team",
      JSON.stringify({
        tasks: ["arithmetic correctness", "limitations", "reproducibility"].map(
          (focus) => ({
            task: `Read evidence.json using read_file. Review ${focus}. Return at most 80 words. Do not delegate or browse. This is a smoke test, not an indexing benchmark.`,
            toolset: "read-only",
          }),
        ),
      }),
      credentials,
      signal,
      observe,
    ),
  );
  if (findings.some((f: any) => f.status !== "returned"))
    throw new Error(`Team failure: ${JSON.stringify(findings)}`);
  await Bun.write(join(cwd, "team.json"), JSON.stringify(findings, null, 2));
  console.log(
    `Three researchers returned; ${state.requests} requests consumed.`,
  );
  // Request explicit review and completion within the same dollar allowance.

  await agent.run(
    `Read evidence.json and team.json. Have the review board inspect these artifacts, then write research/${state.id}/paper.md using write_file. Keep it under 200 words: methods, actual arithmetic result, limitations, review reconciliation. No shell, browser, or additional teams. Call research_complete with the reportPath and finish.`,
    credentials,
    signal,
    (event) => {
      observe(event);
      if (event.type === "tool") console.log(`${event.state}: ${event.name}`);
    },
  );
  const paper = await readFile(
    join(cwd, "research", state.id, "paper.md"),
    "utf8",
  );
  if (!paper.trim() || state.reviews < 1)
    throw new Error("Missing paper or independent review.");
  await runtime.finish("paused");
  console.log(
    `PASS: parallel team → evidence → independent review → paper; ${state.requests} requests, ${state.reviews} reviews.`,
  );
} catch (error) {
  await runtime.finish(
    !runtime.remainingCostMicros ? "budget_exhausted" : "paused",
  );
  throw error;
} finally {
  await Bun.write(
    join(cwd, "smoke-events.json"),
    JSON.stringify(events, null, 2),
  );
  await agent.browser.close();
  await flushUsage();
}
