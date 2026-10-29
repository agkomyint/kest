import { parsePermission, type Permission } from "./permissions";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, chmod } from "node:fs/promises";

export const MODAL_BASE_URL =
  "https://myintkoaung4--ep-muse-spark-open-816b-a42b-server.us-west.modal.direct/v1";
export const MODAL_MODEL = "meta-models/Muse-Spark-Open-816B-A42B";
export const BASETEN_BASE_URL = "https://inference.baseten.co/v1";
export const BASETEN_MODEL = "meta-models/muse-spark-open-1026";
// Kept for backwards compatibility with older imports; prefer the per-provider constants.
export const BASE_URL = MODAL_BASE_URL;
export const MODEL = MODAL_MODEL;
const defaultConfigDir = join(homedir(), ".kest");
export const configDir = defaultConfigDir;
export const configPath = join(defaultConfigDir, "config.json");
// Overridable so tests can isolate config from the real home directory.
function activeConfigDir() {
  return process.env.KEST_CONFIG_DIR?.trim() || defaultConfigDir;
}
function activeConfigPath() {
  return join(activeConfigDir(), "config.json");
}
export type Provider = "modal" | "baseten";
export type Credentials =
  | { provider: "modal"; tokenId: string; tokenSecret: string }
  | { provider: "baseten"; apiKey: string };
export type ModelOption = { provider: Provider; id: string; label: string };
export const MODELS: ModelOption[] = [
  {
    provider: "baseten",
    id: BASETEN_MODEL,
    label: "Muse Spark Open (hackathon)",
  },
  {
    provider: "modal",
    id: MODAL_MODEL,
    label: "Muse Spark Open (proxy)",
  },
];

export function modelProvider(id: string): Provider | null {
  return MODELS.find((m) => m.id === id)?.provider ?? null;
}

export function parseCredentials(value: unknown): Credentials {
  if (!value || typeof value !== "object")
    throw new Error("Invalid saved connection. Run /connect again.");
  const c = value as Record<string, unknown>;
  const provider =
    c.provider ?? (typeof c.apiKey === "string" ? "baseten" : "modal");
  if (provider === "baseten") {
    if (typeof c.apiKey !== "string" || !c.apiKey.trim()) {
      throw new Error("A Baseten API key is required.");
    }
    return { provider: "baseten", apiKey: c.apiKey.trim() };
  }
  if (
    typeof c.tokenId !== "string" ||
    typeof c.tokenSecret !== "string" ||
    !c.tokenId.trim() ||
    !c.tokenSecret.trim()
  ) {
    throw new Error("Both the Modal token ID and secret are required.");
  }
  return {
    provider: "modal",
    tokenId: c.tokenId.trim(),
    tokenSecret: c.tokenSecret.trim(),
  };
}

export function endpointFor(credentials: Credentials): {
  baseURL: string;
  apiKey: string;
  model: string;
} {
  if (credentials.provider === "baseten") {
    return {
      baseURL: BASETEN_BASE_URL,
      apiKey: credentials.apiKey,
      model: BASETEN_MODEL,
    };
  }
  return {
    baseURL: MODAL_BASE_URL,
    apiKey: `${credentials.tokenId}.${credentials.tokenSecret}`,
    model: MODAL_MODEL,
  };
}

export type NamedKey = { name: string; credential: Credentials };
export type ProviderKeys = { keys: NamedKey[]; active: string | null };
export type ConnectionStore = {
  permission: Permission;
  version: 1;
  activeProvider: Provider | null;
  providers: Partial<Record<Provider, ProviderKeys>>;
  model: string | null;
};

function emptyStore(): ConnectionStore {
  return {
    version: 1,
    activeProvider: null,
    providers: {},
    model: null,
    permission: "strict",
  };
}

function tryCredentials(value: unknown): Credentials | null {
  try {
    return parseCredentials(value);
  } catch {
    return null;
  }
}

// Reads legacy single-credential files (flat tokenId/apiKey keys, or one
// credential per provider) as well as the current multi-key shape, so old
// configs keep working.
function normalizeStore(raw: unknown): ConnectionStore {
  const store = emptyStore();
  if (!raw || typeof raw !== "object") return store;
  const config = raw as Record<string, unknown>;
  try {
    store.permission = parsePermission(String(config.permission));
  } catch {
    /* Default to strict for legacy/invalid settings. */
  }
  if (config.providers && typeof config.providers === "object") {
    const providers = config.providers as Record<string, unknown>;
    for (const provider of ["modal", "baseten"] as Provider[]) {
      const entry = providers[provider];
      if (
        entry &&
        typeof entry === "object" &&
        Array.isArray((entry as { keys?: unknown }).keys)
      ) {
        const slot = entry as { keys: unknown[]; active?: unknown };
        const keys: NamedKey[] = [];
        for (const key of slot.keys) {
          if (key && typeof key === "object") {
            const named = key as { name?: unknown; credential?: unknown };
            const parsed = tryCredentials(named.credential);
            if (parsed && typeof named.name === "string" && named.name.trim()) {
              keys.push({ name: named.name.trim(), credential: parsed });
            }
          }
        }
        if (keys.length) {
          const active = typeof slot.active === "string" ? slot.active : null;
          store.providers[provider] = {
            keys,
            active: keys.some((k) => k.name === active)
              ? active
              : keys[0]!.name,
          };
        }
        continue;
      }
      const parsed = tryCredentials(entry);
      if (parsed) {
        store.providers[provider] = {
          keys: [{ name: "a", credential: parsed }],
          active: "a",
        };
      }
    }
  }
  const legacy = tryCredentials(config);
  if (legacy) {
    store.providers[legacy.provider] = {
      keys: [{ name: "a", credential: legacy }],
      active: "a",
    };
  }
  const model = config.model;
  if (
    typeof model === "string" &&
    model.trim() &&
    modelProvider(model.trim())
  ) {
    store.model = model.trim();
  }
  const active = config.activeProvider;
  if ((active === "modal" || active === "baseten") && store.providers[active]) {
    store.activeProvider = active;
  }
  return store;
}

function serializeStore(store: ConnectionStore): Record<string, unknown> {
  const value: Record<string, unknown> = {
    version: 1,
    providers: store.providers,
    permission: store.permission,
  };
  if (store.activeProvider) value.activeProvider = store.activeProvider;
  if (store.model) value.model = store.model;
  return value;
}

function credentialsFromEnv(): Partial<Record<Provider, Credentials>> {
  const seeds: Partial<Record<Provider, Credentials>> = {};
  if (
    process.env.MODAL_PROXY_TOKEN_ID &&
    process.env.MODAL_PROXY_TOKEN_SECRET
  ) {
    const modal = tryCredentials({
      provider: "modal",
      tokenId: process.env.MODAL_PROXY_TOKEN_ID,
      tokenSecret: process.env.MODAL_PROXY_TOKEN_SECRET,
    });
    if (modal) seeds.modal = modal;
  }
  if (process.env.BASETEN_API_KEY) {
    const baseten = tryCredentials({
      provider: "baseten",
      apiKey: process.env.BASETEN_API_KEY,
    });
    if (baseten) seeds.baseten = baseten;
  }
  return seeds;
}

function resolveActive(store: ConnectionStore): Provider | null {
  if (store.activeProvider && store.providers[store.activeProvider]) {
    return store.activeProvider;
  }
  const preferred = store.model ? modelProvider(store.model) : null;
  if (preferred && store.providers[preferred]) return preferred;
  if (store.providers.baseten) return "baseten";
  if (store.providers.modal) return "modal";
  return null;
}

export function activeKey(
  store: ConnectionStore,
  provider: Provider,
): NamedKey | null {
  const slot = store.providers[provider];
  if (!slot || !slot.keys.length) return null;
  return slot.keys.find((k) => k.name === slot.active) ?? slot.keys[0]!;
}

export function keyNames(store: ConnectionStore, provider: Provider): string[] {
  return store.providers[provider]?.keys.map((k) => k.name) ?? [];
}

export function nextKeyName(
  store: ConnectionStore,
  provider: Provider,
): string {
  const used = new Set(keyNames(store, provider));
  for (let i = 0; i < 26; i++) {
    const name = String.fromCharCode(97 + i);
    if (!used.has(name)) return name;
  }
  let n = used.size + 1;
  while (used.has(`k${n}`)) n++;
  return `k${n}`;
}

function seedKey(name: string, credential: Credentials): ProviderKeys {
  return { keys: [{ name, credential }], active: name };
}

export async function loadStore(): Promise<ConnectionStore> {
  const store = normalizeStore(await readConfigFile());
  // Saved credentials win per provider; env fills in the rest in memory only.
  const seeds = credentialsFromEnv();
  if (!store.providers.modal && seeds.modal) {
    store.providers.modal = seedKey("env", seeds.modal);
  }
  if (!store.providers.baseten && seeds.baseten) {
    store.providers.baseten = seedKey("env", seeds.baseten);
  }
  store.activeProvider = resolveActive(store);
  return store;
}

export async function loadCredentials(
  provider?: Provider,
): Promise<Credentials | null> {
  const store = await loadStore();
  if (provider) return activeKey(store, provider)?.credential ?? null;
  if (!store.activeProvider) return null;
  return activeKey(store, store.activeProvider)?.credential ?? null;
}

async function readConfigFile(): Promise<Record<string, unknown>> {
  try {
    const file = Bun.file(activeConfigPath());
    if (await file.exists()) {
      const value: unknown = await file.json();
      if (value && typeof value === "object")
        return value as Record<string, unknown>;
    }
  } catch {
    /* Missing or corrupt config starts fresh. */
  }
  return {};
}

async function writeConfigFile(value: Record<string, unknown>) {
  await mkdir(activeConfigDir(), { recursive: true, mode: 0o700 });
  await Bun.write(activeConfigPath(), JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  if (process.platform !== "win32") await chmod(activeConfigPath(), 0o600);
}

export async function saveCredentials(credentials: Credentials) {
  return saveKeyCredential(
    credentials.provider,
    null,
    parseCredentials(credentials),
  );
}

export async function saveKeyCredential(
  provider: Provider,
  name: string | null,
  credential: Credentials,
) {
  const checked = parseCredentials(credential);
  if (checked.provider !== provider) {
    throw new Error("Credential does not match provider.");
  }
  const store = normalizeStore(await readConfigFile());
  const slot = store.providers[provider] ?? { keys: [], active: null };
  const keyName = name ?? nextKeyName(store, provider);
  const existing = slot.keys.findIndex((k) => k.name === keyName);
  if (existing >= 0)
    slot.keys[existing] = { name: keyName, credential: checked };
  else {
    slot.keys.push({ name: keyName, credential: checked });
    // A brand-new key becomes the active one.
    slot.active = keyName;
  }
  store.providers[provider] = slot;
  store.activeProvider = provider;
  await writeConfigFile(serializeStore(store));
  return keyName;
}

export async function saveActiveProvider(provider: Provider) {
  const store = normalizeStore(await readConfigFile());
  if (!activeKey(store, provider)) {
    throw new Error(
      `No saved ${provider} credentials. Run /connect ${provider} first.`,
    );
  }
  store.activeProvider = provider;
  await writeConfigFile(serializeStore(store));
}

export async function saveActiveKey(provider: Provider, name: string) {
  const store = normalizeStore(await readConfigFile());
  const slot = store.providers[provider];
  if (!slot || !slot.keys.some((k) => k.name === name)) {
    throw new Error(`No ${provider} key named "${name}".`);
  }
  slot.active = name;
  store.activeProvider = provider;
  await writeConfigFile(serializeStore(store));
}

export async function loadSelectedModel(): Promise<string | null> {
  return normalizeStore(await readConfigFile()).model;
}

export async function saveSelectedModel(model: string | null) {
  if (model !== null && !modelProvider(model)) {
    throw new Error("Unknown model. Pick one from /model.");
  }
  const store = normalizeStore(await readConfigFile());
  store.model = model;
  await writeConfigFile(serializeStore(store));
}

export async function savePermission(permission: Permission) {
  const store = normalizeStore(await readConfigFile());
  store.permission = parsePermission(permission);
  await writeConfigFile(serializeStore(store));
}
