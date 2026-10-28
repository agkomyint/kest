import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatUsage, loadUsage, recordUsage } from "./usage";
import { BASETEN_MODEL } from "./config";

async function withTmp(run: (file: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "kest-usage-"));
  try {
    await run(join(dir, "usage.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("usage ledger accumulates per model and reloads", async () => {
  await withTmp(async (file) => {
    await recordUsage("model-a", 100, 20, file);
    await recordUsage("model-a", 50, 30, file);
    await recordUsage("model-b", 10, 5, file);
    const log = await loadUsage(file);
    expect(log["model-a"]).toMatchObject({
      input: 150,
      output: 50,
      requests: 2,
    });
    expect(log["model-b"]).toMatchObject({
      input: 10,
      output: 5,
      requests: 1,
    });
  });
});

test("usage ledger ignores corrupt files", async () => {
  await withTmp(async (file) => {
    await Bun.write(file, "not json{{{");
    expect(await loadUsage(file)).toEqual({});
  });
});

test("formatUsage totals and formats numbers", () => {
  const text = formatUsage({
    m: { input: 1200, output: 340, requests: 2, updatedAt: "" },
  });
  expect(text).toContain("m");
  expect(text).toContain("1,200");
  expect(text).toContain("TOTAL");
  expect(formatUsage({})).toContain("No token usage");
});

test("formatUsage prefixes known models with their provider", () => {
  const text = formatUsage({
    [BASETEN_MODEL]: { input: 10, output: 5, requests: 1, updatedAt: "" },
  });
  expect(text).toContain(`baseten · ${BASETEN_MODEL}`);
});
