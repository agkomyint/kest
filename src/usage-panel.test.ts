import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dayKey, loadDaily, recordUsage, usagePanel, flushUsage } from "./usage";
import { MODELS } from "./config";

const m = MODELS.find((x) => x.pricing)!;

test("the panel ranks models, flags unpriced ones, shows days and studies, and fits the width", () => {
  const now = new Date();
  const log = {
    [m.id]: { input: 2_000_000, output: 500_000, requests: 40, updatedAt: "" },
    "mystery-model": { input: 120_000, output: 0, requests: 3, updatedAt: "" },
  };
  const daily = { [dayKey(now)]: { [m.id]: { input: 1_000_000, output: 100_000 } } };
  const studies = [{ id: "a", title: "Retrieval study", spent: 0.41, budget: 0.5 }];
  for (const width of [40, 60, 80, 120]) {
    const lines = usagePanel(log, { width, daily, studies, now });
    const max = Math.min(width < 40 ? 40 : width, 78 > width ? width : 78);
    expect(lines.every((l) => l.length <= Math.max(40, width))).toBe(true);
    void max;
  }
  const text = usagePanel(log, { width: 80, daily, studies, now }).join("\n");
  expect(text).toContain("Spend (est.)");
  expect(text.indexOf(m.id)).toBeLessThan(text.indexOf("mystery-model"));
  expect(text).toContain("lack a verified rate");
  expect(text).toContain("Last 7 days");
  expect(text).toContain("Retrieval study");
  expect(text).toContain("82%");
  expect(usagePanel({}, {}).join("\n")).toContain("No token usage yet");
});

test("recording usage also keeps a per-day history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kest-usage-"));
  const file = join(dir, "usage.json");
  try {
    await recordUsage("x-model", 10, 5, file);
    await recordUsage("x-model", 1, 1, file);
    await flushUsage();
    const days = await loadDaily(file);
    expect(days[dayKey()]?.["x-model"]).toEqual({ input: 11, output: 6 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
