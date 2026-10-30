import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatStudyTab, loadStudyArtifacts, studyTabs } from "./study-view";

test("an empty study shows friendly placeholders on every tab", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kest-view-"));
  try {
    const a = await loadStudyArtifacts(cwd, { id: "r1" });
    for (const tab of studyTabs) expect(formatStudyTab(tab, a, "r1")).toContain("research/r1/");
    expect(formatStudyTab("report", a, "r1")).toContain("No report yet");
    expect(formatStudyTab("evidence", a, "r1")).toContain("No evidence");
    expect(formatStudyTab("reviews", a, "r1")).toContain("No independent review");
    expect(formatStudyTab("timeline", a, "r1")).toContain("No events");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("reads report, evidence, reviewer verdicts and timeline from research/<id>/", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kest-view-"));
  try {
    const dir = join(cwd, "research", "r2");
    await mkdir(join(dir, "agents"), { recursive: true });
    await writeFile(join(dir, "report.md"), "# Findings\nBun is fast.");
    await writeFile(join(dir, "bench.csv"), "a,b\n1,2\n");
    await writeFile(join(dir, "state.json"), "{}");
    await writeFile(
      join(dir, "agents", "rev12345678.json"),
      JSON.stringify({
        id: "rev12345678",
        role: "reviewer",
        model: "m1",
        task: "check claims",
        messages: [{ role: "assistant", content: "Verdict: speedup overstated." }],
      }),
    );
    await writeFile(join(dir, "agents", "wrk.json"), JSON.stringify({ id: "wrk", role: "worker", messages: [] }));
    await writeFile(
      join(dir, "events.jsonl"),
      [
        JSON.stringify({ at: "2026-01-01T10:00:00Z", kind: "run_started", data: { objective: "Bench Bun" } }),
        "not json",
        JSON.stringify({ at: "2026-01-01T10:00:05Z", kind: "model_request", data: {} }),
        JSON.stringify({ at: "2026-01-01T10:01:00Z", kind: "research_completed", data: { reportPath: "research/r2/report.md" } }),
      ].join("\n"),
    );
    const a = await loadStudyArtifacts(cwd, { id: "r2" });
    expect(a.report?.text).toContain("Bun is fast");
    expect(a.evidence.map((f) => f.path).sort()).toEqual(["bench.csv", "report.md"]);
    expect(a.reviews).toHaveLength(1);
    expect(formatStudyTab("reviews", a, "r2")).toContain("speedup overstated");
    const timeline = formatStudyTab("timeline", a, "r2");
    expect(timeline).toContain("run started · Bench Bun");
    expect(timeline).toContain("1 model requests");
    expect(timeline).toContain("completed");
    expect(formatStudyTab("report", a, "r2")).toContain("[report]");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
