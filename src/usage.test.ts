import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatUsage,
  formatModelCosts,
  loadUsage,
  recordUsage,
  usageFile,
  flushUsage,
} from "./usage";
import { BASETEN_MODEL, NEBIUS_MODEL } from "./config";

test("model costs combine input and output tokens across priced models", () => {
  const text = formatModelCosts({
    [BASETEN_MODEL]: {
      input: 1_000_000,
      output: 2_000_000,
      requests: 2,
      updatedAt: "",
    },
    [NEBIUS_MODEL]: {
      input: 500_000,
      output: 250_000,
      requests: 1,
      updatedAt: "",
    },
  });
  expect(text).toContain("Input $0.30 · output $0.90 / 1M tokens (USD)");
  expect(text).toContain("total $9.7500 USD");
  expect(text).toContain("total $0.3750 USD");
  expect(text).toContain(
    "ESTIMATED TOTAL $10.1250 USD · input $1.4000 · output $8.7250",
  );
  expect(text).toContain("hackathon model ID is unverified");
});

test("unknown pricing produces a partial subtotal, never a free cost", () => {
  const text = formatModelCosts({
    [NEBIUS_MODEL]: { input: 1_000_000, output: 0, requests: 1, updatedAt: "" },
    custom: { input: 100, output: 200, requests: 1, updatedAt: "" },
  });
  expect(text).toContain("PRICED SUBTOTAL $0.3000 USD");
  expect(text).toContain("Total cost unknown: 1 model(s), 300 tokens");
  expect(text).not.toContain("ESTIMATED TOTAL");
  expect(formatModelCosts({})).toContain("No token usage recorded");
  expect(
    formatModelCosts({
      [NEBIUS_MODEL]: { input: 1, output: 0, requests: 1, updatedAt: "" },
    }),
  ).toContain("<$0.0001");
});

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

test("usage writes retain concurrent requests and flush before reads", async () => {
  await withTmp(async (file) => {
    const writes = Array.from({ length: 20 }, () =>
      recordUsage("shared", 2, 3, file),
    );
    await flushUsage();
    await Promise.all(writes);
    expect((await loadUsage(file)).shared).toMatchObject({
      input: 40,
      output: 60,
      requests: 20,
    });
  });
});

test("independent processes share the all-time usage ledger", async () => {
  await withTmp(async (file) => {
    const source = `import { recordUsage } from ${JSON.stringify(fileURLToPath(new URL("./usage.ts", import.meta.url)))}; for (let i = 0; i < 5; i++) await recordUsage("shared", 7, 2, process.env.KEST_USAGE_FILE);`;
    const worker = join(file, "..", "worker.ts");
    await Bun.write(worker, source);
    const children = Array.from({ length: 3 }, () => {
      const child = Bun.spawn([process.execPath, "run", worker], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, KEST_USAGE_FILE: file },
      });
      return child;
    });
    for (const child of children) {
      const error = await new Response(child.stderr).text();
      expect(error).toBe("");
      expect(await child.exited).toBe(0);
    }
    expect((await loadUsage(file)).shared).toMatchObject({
      input: 105,
      output: 30,
      requests: 15,
    });
  });
});

test("usage location follows configured storage and reports universal session counts", () => {
  const previousConfig = process.env.KEST_CONFIG_DIR;
  const previousFile = process.env.KEST_USAGE_FILE;
  try {
    process.env.KEST_CONFIG_DIR = join(tmpdir(), "kest-config-location");
    delete process.env.KEST_USAGE_FILE;
    expect(usageFile()).toBe(join(process.env.KEST_CONFIG_DIR, "usage.json"));
    expect(formatUsage({}, { sessions: 3, workspaces: 2 })).toContain(
      "3 sessions · 2 workspaces",
    );
  } finally {
    if (previousConfig === undefined) delete process.env.KEST_CONFIG_DIR;
    else process.env.KEST_CONFIG_DIR = previousConfig;
    if (previousFile === undefined) delete process.env.KEST_USAGE_FILE;
    else process.env.KEST_USAGE_FILE = previousFile;
  }
});
