import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCompanyLimits, saveCompanyLimits } from "./company-settings";

test("limits persist and invalid files are ignored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kest-co-"));
  const prev = process.env.KEST_CONFIG_DIR;
  process.env.KEST_CONFIG_DIR = dir;
  try {
    expect(await loadCompanyLimits()).toEqual({});
    await saveCompanyLimits({ maxRunning: 5, totalUsd: 30 });
    expect(await loadCompanyLimits()).toEqual({ maxRunning: 5, totalUsd: 30 });
    await saveCompanyLimits({ maxRunning: 2, totalUsd: null });
    expect(await loadCompanyLimits()).toEqual({ maxRunning: 2, totalUsd: null });
    await writeFile(join(dir, "company.json"), JSON.stringify({ maxRunning: 99, totalUsd: -4 }));
    expect(await loadCompanyLimits()).toEqual({});
    await writeFile(join(dir, "company.json"), "garbage");
    expect(await loadCompanyLimits()).toEqual({});
  } finally {
    if (prev === undefined) delete process.env.KEST_CONFIG_DIR;
    else process.env.KEST_CONFIG_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
