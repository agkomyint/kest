import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { KestUI } from "./ui";
import { Agent } from "./agent";

test("/research publish needs LSI, then a completed study", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kest-publish-"));
  const r = await createTestRenderer({ width: 110, height: 30 });
  const ui = new KestUI(r.renderer, directory, { provider: "baseten", apiKey: "not-used" });
  const last = () => ui["session"].entries.at(-1)!.text;
  try {
    await ui["command"]("/research prepare Publish me");
    delete process.env.LSI_KEY;
    await ui["command"]("/research publish");
    expect(last()).toContain("/connect lsi");
    process.env.LSI_KEY = "lsi_" + "b".repeat(32);
    await ui["command"]("/research publish");
    expect(last()).toContain("Not ready");
  } finally {
    delete process.env.LSI_KEY;
    ui.close();
    await r.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a completed study with a report offers lsi_publish, a running one does not", async () => {
  process.env.LSI_KEY = "lsi_" + "c".repeat(32);
  try {
    const agent = new Agent(process.cwd(), async () => true);
    const names = () => agent.toolDefs().map((t) => (t.type === "function" ? t.function.name : ""));
    agent.research = { id: "r", objective: "o", status: "paused" } as never;
    expect(names()).not.toContain("lsi_publish");
    agent.research = { id: "r", objective: "o", status: "completed", finalReportPath: "research/r/report.md" } as never;
    expect(names()).toContain("lsi_publish");
  } finally {
    delete process.env.LSI_KEY;
  }
});
