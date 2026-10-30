import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveCredentials,
  saveKeyCredential,
  saveActiveKey,
  BASETEN_BASE_URL,
  BASETEN_MODEL,
  MODAL_BASE_URL,
  MODAL_MODEL,
  NEBIUS_MODEL,
  NEBIUS_BASE_URL,
  modelPricing,
} from "./config";
import {
  listResearchModels,
  resolveResearchModel,
  saveResearchModel,
  saveResearchEndpoint,
} from "./research-models";

async function isolated(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "kest-research-models-"));
  const variables = [
    "KEST_CONFIG_DIR",
    "BASETEN_API_KEY",
    "NEBIUS_API_KEY",
    "MODAL_PROXY_TOKEN_ID",
    "MODAL_PROXY_TOKEN_SECRET",
    "RESEARCH_TEST_KEY",
  ];
  const saved = new Map(variables.map((name) => [name, process.env[name]]));
  for (const name of variables) delete process.env[name];
  process.env.KEST_CONFIG_DIR = directory;
  try {
    await run(directory);
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

test("default research aliases list availability without requiring credentials or writing config", async () => {
  await isolated(async () => {
    expect(await listResearchModels()).toEqual([
      {
        name: "nebius",
        provider: "nebius",
        model: NEBIUS_MODEL,
        pricing: modelPricing("nebius", NEBIUS_MODEL),
        available: false,
      },
      {
        name: "modal",
        provider: "modal",
        model: MODAL_MODEL,
        pricing: modelPricing("modal", MODAL_MODEL),
        available: false,
      },
      {
        name: "baseten",
        provider: "baseten",
        model: BASETEN_MODEL,
        pricing: modelPricing("baseten", BASETEN_MODEL),
        available: false,
      },
    ]);
    await expect(resolveResearchModel("modal")).rejects.toThrow(
      "/connect modal",
    );
    process.env.BASETEN_API_KEY = "test-environment-key";
    expect(
      (await listResearchModels()).find((p) => p.name === "baseten")?.available,
    ).toBe(true);
    expect(await resolveResearchModel("baseten")).toEqual({
      provider: "baseten",
      model: BASETEN_MODEL,
      baseURL: BASETEN_BASE_URL,
      apiKey: "test-environment-key",
    });
    expect(JSON.stringify(await listResearchModels())).not.toContain(
      "test-environment-key",
    );
    await expect(resolveResearchModel("missing")).rejects.toThrow(
      "Unknown research model",
    );
  });
});

test("saved built-in profiles resolve the selected model with current provider keys, without copying credentials", async () => {
  await isolated(async (directory) => {
    await saveCredentials({
      provider: "modal",
      tokenId: "test-id",
      tokenSecret: "test-secret",
    });
    await saveCredentials({ provider: "baseten", apiKey: "test-baseten" });
    await saveResearchModel("critic", "modal", "different-modal-model");
    await saveResearchModel("builder", "baseten", "different-baseten-model");
    expect(await resolveResearchModel("critic")).toEqual({
      provider: "modal",
      baseURL: MODAL_BASE_URL,
      apiKey: "test-id.test-secret",
      model: "different-modal-model",
    });
    expect(await resolveResearchModel("builder")).toEqual({
      provider: "baseten",
      baseURL: BASETEN_BASE_URL,
      apiKey: "test-baseten",
      model: "different-baseten-model",
    });
    await saveKeyCredential("modal", "b", {
      provider: "modal",
      tokenId: "second-id",
      tokenSecret: "second-secret",
    });
    expect((await resolveResearchModel("critic")).apiKey).toBe(
      "second-id.second-secret",
    );
    await saveActiveKey("modal", "a");
    expect((await resolveResearchModel("critic")).apiKey).toBe(
      "test-id.test-secret",
    );
    const stored = await readFile(
      join(directory, "research-models.json"),
      "utf8",
    );
    expect(stored).not.toContain("test-secret");
    expect(stored).not.toContain("test-baseten");
    expect(stored).not.toContain("second-secret");
  });
});

test("custom endpoint profiles persist only environment variable names and resolve runtime keys", async () => {
  await isolated(async (directory) => {
    await saveResearchEndpoint(
      "local",
      "http://localhost:11434/v1/",
      "local/model",
      "RESEARCH_TEST_KEY",
    );
    expect(
      (await listResearchModels()).find((p) => p.name === "local")?.available,
    ).toBe(false);
    await expect(resolveResearchModel("local")).rejects.toThrow(
      "RESEARCH_TEST_KEY",
    );
    process.env.RESEARCH_TEST_KEY = "test-custom-secret";
    expect(await resolveResearchModel("local")).toEqual({
      provider: "custom",
      baseURL: "http://localhost:11434/v1",
      model: "local/model",
      apiKey: "test-custom-secret",
    });
    const raw = await readFile(join(directory, "research-models.json"), "utf8");
    expect(raw).toContain("RESEARCH_TEST_KEY");
    expect(raw).not.toContain("test-custom-secret");
    expect(JSON.stringify(await listResearchModels())).not.toContain(
      "test-custom-secret",
    );
    process.env.RESEARCH_TEST_KEY = "rotated-test-secret";
    expect((await resolveResearchModel("local")).apiKey).toBe(
      "rotated-test-secret",
    );
  });
});

test("explicit saves replace duplicate profiles, preserve others, and permit default model overrides", async () => {
  await isolated(async (directory) => {
    await Promise.all([
      saveResearchModel("reviewer", "modal", "m1"),
      saveResearchModel("builder", "baseten", "b1"),
    ]);
    await saveResearchModel("reviewer", "modal", "m2");
    await saveResearchModel("modal", "modal", "chosen-default");
    const profiles = await listResearchModels();
    expect(profiles.find((p) => p.name === "modal")?.model).toBe(
      "chosen-default",
    );
    expect(profiles.find((p) => p.name === "reviewer")?.model).toBe("m2");
    expect(profiles.find((p) => p.name === "builder")?.model).toBe("b1");
    expect(profiles.filter((p) => p.name === "reviewer")).toHaveLength(1);
    expect(
      JSON.parse(
        await readFile(join(directory, "research-models.json"), "utf8"),
      ).profiles,
    ).toHaveLength(3);
  });
});

test("profile validation rejects unsafe names, model identifiers, endpoint URLs and secret-like env arguments", async () => {
  await isolated(async () => {
    await expect(
      saveResearchModel("../bad", "modal", "model"),
    ).rejects.toThrow();
    await expect(
      saveResearchModel("okay", "unsupported", "model"),
    ).rejects.toThrow();
    await expect(
      saveResearchModel("okay", "modal", "model\ncommand"),
    ).rejects.toThrow();
    await expect(saveResearchModel("okay", "modal", "")).rejects.toThrow();
    await expect(
      saveResearchModel("baseten", "modal", "model"),
    ).rejects.toThrow();
    for (const endpoint of [
      "http://example.com/v1",
      "file:///tmp/key",
      "https://user:secret@example.com/v1",
      "https://example.com/v1?key=secret",
      "https://example.com/v1?",
      "https://example.com/v1#fragment",
      "https://@example.com/v1",
    ]) {
      await expect(
        saveResearchEndpoint("custom", endpoint, "model", "RESEARCH_TEST_KEY"),
      ).rejects.toThrow();
    }
    await expect(
      saveResearchEndpoint(
        "modal",
        "https://example.com/v1",
        "model",
        "RESEARCH_TEST_KEY",
      ),
    ).rejects.toThrow();
    await expect(
      saveResearchEndpoint(
        "custom",
        "https://example.com/v1",
        "model",
        "sk-test-secret-value",
      ),
    ).rejects.toThrow();
    await saveResearchEndpoint(
      "ipv6",
      "http://[::1]:11434/v1",
      "model",
      "RESEARCH_TEST_KEY",
    );
    await saveResearchEndpoint(
      "remote",
      "https://example.com/v1",
      "model",
      "RESEARCH_TEST_KEY",
    );
  });
});

test("corrupt or secret-bearing configuration fails closed and is never overwritten", async () => {
  await isolated(async (directory) => {
    const path = join(directory, "research-models.json");
    const invalid =
      '{"version":1,"profiles":[{"name":"bad","provider":"custom","model":"m","baseURL":"https://example.com/v1","apiKeyEnv":"RESEARCH_TEST_KEY","apiKey":"do-not-expose"}]}';
    for (const raw of [
      "{broken json",
      invalid,
      '{"version":99,"profiles":[]}',
      '{"version":1,"profiles":[{"name":"x","provider":"modal","model":"m"},{"name":"x","provider":"modal","model":"n"}]}',
    ]) {
      await writeFile(path, raw);
      await expect(listResearchModels()).rejects.toThrow(
        "Invalid research-models.json",
      );
      await expect(resolveResearchModel("modal")).rejects.toThrow(
        "Invalid research-models.json",
      );
      await expect(saveResearchModel("safe", "modal", "m")).rejects.toThrow(
        "Invalid research-models.json",
      );
      expect(await readFile(path, "utf8")).toBe(raw);
    }
  });
});

test("nebius research profiles use current provider credentials", async () => {
  await isolated(async () => {
    await saveCredentials({ provider: "nebius", apiKey: "research-nebius" });
    expect(await resolveResearchModel("nebius")).toEqual({
      provider: "nebius",
      baseURL: NEBIUS_BASE_URL,
      model: NEBIUS_MODEL,
      apiKey: "research-nebius",
    });
    await saveResearchModel("critic", "nebius", "another-model");
    expect((await resolveResearchModel("critic")).model).toBe("another-model");
    await expect(
      saveResearchEndpoint("nebius", "https://example.com/v1", "m", "KEY"),
    ).rejects.toThrow();
  });
});
