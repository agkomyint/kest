import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCredentials,
  endpointFor,
  loadCredentials,
  loadSelectedModel,
  loadStore,
  modelProvider,
  saveActiveKey,
  saveActiveProvider,
  saveCredentials,
  saveKeyCredential,
  saveSelectedModel,
  MODELS,
  BASETEN_BASE_URL,
  BASETEN_MODEL,
  MODAL_BASE_URL,
  MODAL_MODEL,
} from "./config";

async function withIsolatedConfig(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "kest-config-"));
  const prevDir = process.env.KEST_CONFIG_DIR;
  const prevKey = process.env.BASETEN_API_KEY;
  process.env.KEST_CONFIG_DIR = dir;
  delete process.env.BASETEN_API_KEY;
  try {
    await run(dir);
  } finally {
    if (prevDir === undefined) delete process.env.KEST_CONFIG_DIR;
    else process.env.KEST_CONFIG_DIR = prevDir;
    if (prevKey === undefined) delete process.env.BASETEN_API_KEY;
    else process.env.BASETEN_API_KEY = prevKey;
    await rm(dir, { recursive: true, force: true });
  }
}

test("credentials require both values and trim whitespace", () => {
  expect(() => parseCredentials({ tokenId: "id", tokenSecret: " " })).toThrow();
  expect(
    parseCredentials({ tokenId: " id ", tokenSecret: " secret " }),
  ).toEqual({ provider: "modal", tokenId: "id", tokenSecret: "secret" });
});

test("legacy modal credentials default to the modal provider", () => {
  const endpoint = endpointFor(
    parseCredentials({ tokenId: "id", tokenSecret: "secret" }),
  );
  expect(endpoint).toEqual({
    baseURL: MODAL_BASE_URL,
    apiKey: "id.secret",
    model: MODAL_MODEL,
  });
});

test("baseten credentials use the baseten endpoint and model", () => {
  expect(() => parseCredentials({ provider: "baseten", apiKey: " " })).toThrow();
  const credentials = parseCredentials({
    provider: "baseten",
    apiKey: " key ",
  });
  expect(credentials).toEqual({ provider: "baseten", apiKey: "key" });
  expect(endpointFor(credentials)).toEqual({
    baseURL: BASETEN_BASE_URL,
    apiKey: "key",
    model: BASETEN_MODEL,
  });
});

test("per-provider store migrates legacy configs and keeps both keys", async () => {
  await withIsolatedConfig(async (dir) => {
    await Bun.write(
      join(dir, "config.json"),
      JSON.stringify({
        provider: "baseten",
        apiKey: "k1",
        model: MODAL_MODEL,
      }),
    );
    let store = await loadStore();
    expect(store.providers.baseten).toEqual({
      keys: [{ name: "a", credential: { provider: "baseten", apiKey: "k1" } }],
      active: "a",
    });
    expect(store.model).toBe(MODAL_MODEL);
    expect(store.activeProvider).toBe("baseten");
    await saveCredentials({
      provider: "modal",
      tokenId: "id",
      tokenSecret: "s",
    });
    store = await loadStore();
    expect(store.providers.baseten).toEqual({
      keys: [{ name: "a", credential: { provider: "baseten", apiKey: "k1" } }],
      active: "a",
    });
    expect(store.providers.modal).toEqual({
      keys: [
        {
          name: "a",
          credential: { provider: "modal", tokenId: "id", tokenSecret: "s" },
        },
      ],
      active: "a",
    });
    expect(store.activeProvider).toBe("modal");
    await saveActiveProvider("baseten");
    expect((await loadStore()).activeProvider).toBe("baseten");
  });
});

test("env credentials seed providers without touching disk", async () => {
  await withIsolatedConfig(async (dir) => {
    process.env.BASETEN_API_KEY = "envkey";
    const store = await loadStore();
    expect(store.providers.baseten).toEqual({
      keys: [
        {
          name: "env",
          credential: { provider: "baseten", apiKey: "envkey" },
        },
      ],
      active: "env",
    });
    expect(await Bun.file(join(dir, "config.json")).exists()).toBe(false);
  });
});

test("a provider holds several named keys with an active one", async () => {
  await withIsolatedConfig(async () => {
    await saveCredentials({ provider: "baseten", apiKey: "first" });
    await saveCredentials({ provider: "baseten", apiKey: "second" });
    let store = await loadStore();
    expect(store.providers.baseten?.keys.map((k) => k.name)).toEqual([
      "a",
      "b",
    ]);
    expect(store.providers.baseten?.active).toBe("b");
    await saveActiveKey("baseten", "a");
    store = await loadStore();
    expect(store.providers.baseten?.active).toBe("a");
    expect(await loadCredentials("baseten")).toEqual({
      provider: "baseten",
      apiKey: "first",
    });
    await saveKeyCredential(
      "baseten",
      "b",
      parseCredentials({ provider: "baseten", apiKey: "replaced" }),
    );
    expect(await loadCredentials("baseten")).toEqual({
      provider: "baseten",
      apiKey: "first",
    });
    expect(
      (await loadStore()).providers.baseten?.keys.map((k) => k.name),
    ).toEqual(["a", "b"]);
  });
});

test("selected model persists and reloads", async () => {
  await withIsolatedConfig(async () => {
    expect(await loadSelectedModel()).toBeNull();
    await saveSelectedModel(BASETEN_MODEL);
    expect(await loadSelectedModel()).toBe(BASETEN_MODEL);
    await saveSelectedModel(null);
    expect(await loadSelectedModel()).toBeNull();
  });
});

test("model catalog covers both providers and resolves owners", () => {
  expect(MODELS.length).toBeGreaterThanOrEqual(2);
  expect(new Set(MODELS.map((m) => m.provider))).toEqual(
    new Set(["baseten", "modal"]),
  );
  expect(modelProvider(BASETEN_MODEL)).toBe("baseten");
  expect(modelProvider(MODAL_MODEL)).toBe("modal");
  expect(modelProvider("no-such-model")).toBeNull();
});
