import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  activeKey,
  configDir,
  endpointFor,
  loadStore,
  BASETEN_MODEL,
  MODAL_MODEL,
  type Provider,
} from "./config";

export type ModelConnection = {
  provider: string;
  baseURL: string;
  apiKey: string;
  model: string;
};
type BuiltinProfile = { name: string; provider: Provider; model: string };
type EndpointProfile = {
  name: string;
  provider: "custom";
  model: string;
  baseURL: string;
  apiKeyEnv: string;
};
type Profile = BuiltinProfile | EndpointProfile;

const defaults: BuiltinProfile[] = [
  { name: "modal", provider: "modal", model: MODAL_MODEL },
  { name: "baseten", provider: "baseten", model: BASETEN_MODEL },
];
function storage() {
  const directory = process.env.KEST_CONFIG_DIR?.trim() || configDir;
  return { directory, file: join(directory, "research-models.json") };
}
function checkedName(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,47}$/.test(value))
    throw new Error(
      "Research model names need 1–48 lowercase letters, numbers, underscores or hyphens, starting with a letter.",
    );
  return value;
}
function checkedModel(value: unknown): string {
  if (typeof value !== "string" || !/^[^\s\x00-\x1f\x7f]{1,200}$/u.test(value))
    throw new Error(
      "Research model must be a nonempty model identifier of at most 200 characters without whitespace.",
    );
  return value;
}
function checkedURL(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\x00-\x20\x7f]/.test(value)
  )
    throw new Error(
      "Research endpoint must be an HTTPS URL (HTTP is allowed only on localhost).",
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Research endpoint must be a valid URL.");
  }
  if (
    url.username ||
    url.password ||
    value.includes("?") ||
    value.includes("#") ||
    /^[a-z]+:\/\/[^/]*@/i.test(value) ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error(
      "Research endpoint requires HTTPS, or localhost HTTP, without credentials, query parameters or fragments.",
    );
  return url.href.replace(/\/+$/, "");
}
function checkedEnv(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(value))
    throw new Error(
      "API key environment variable must be a name such as RESEARCH_API_KEY, not the key itself.",
    );
  return value;
}
function checkedProfile(value: unknown): Profile {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid research model profile.");
  const entry = value as Record<string, unknown>;
  const name = checkedName(entry.name);
  const model = checkedModel(entry.model);
  if (entry.provider === "modal" || entry.provider === "baseten") {
    if (
      Object.keys(entry).some((k) => !["name", "provider", "model"].includes(k))
    )
      throw new Error("Unexpected fields in built-in research model profile.");
    if ((name === "modal" || name === "baseten") && name !== entry.provider)
      throw new Error(
        "Default research model aliases must use their matching provider.",
      );
    return { name, model, provider: entry.provider };
  }
  if (entry.provider !== "custom")
    throw new Error("Unknown research model provider.");
  if (name === "modal" || name === "baseten")
    throw new Error(
      "Default provider names cannot be used for custom endpoints.",
    );
  if (
    Object.keys(entry).some(
      (k) => !["name", "provider", "model", "baseURL", "apiKeyEnv"].includes(k),
    )
  )
    throw new Error("Unexpected fields in custom research model profile.");
  return {
    name,
    model,
    provider: "custom",
    baseURL: checkedURL(entry.baseURL),
    apiKeyEnv: checkedEnv(entry.apiKeyEnv),
  };
}
async function readProfiles(file: string): Promise<Profile[]> {
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (error: any) {
    if (error.code === "ENOENT") return [];
    throw new Error("Could not read research model configuration.");
  }
  try {
    if (content.length > 256_000) throw new Error("Configuration is too large");
    const raw: unknown = JSON.parse(content);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("Invalid configuration");
    const object = raw as Record<string, unknown>;
    if (
      object.version !== 1 ||
      !Array.isArray(object.profiles) ||
      object.profiles.length > 64 ||
      Object.keys(object).some((k) => !["version", "profiles"].includes(k))
    )
      throw new Error("Unsupported configuration");
    const profiles = object.profiles.map(checkedProfile);
    if (new Set(profiles.map((p) => p.name)).size !== profiles.length)
      throw new Error("Duplicate profile names");
    return profiles;
  } catch {
    // Fail closed: never silently overwrite a damaged configuration or reveal its contents.
    throw new Error(
      "Invalid research-models.json. Restore or repair that configuration before changing research models.",
    );
  }
}
async function effectiveProfiles() {
  const saved = await readProfiles(storage().file);
  const profiles = new Map<string, Profile>(defaults.map((p) => [p.name, p]));
  for (const profile of saved) profiles.set(profile.name, profile);
  return [...profiles.values()];
}
export async function listResearchModels(): Promise<
  Array<{ name: string; provider: string; model: string; available: boolean }>
> {
  const [profiles, store] = await Promise.all([
    effectiveProfiles(),
    loadStore(),
  ]);
  return profiles.map((profile) => ({
    name: profile.name,
    provider: profile.provider,
    model: profile.model,
    available:
      profile.provider === "custom"
        ? Boolean(process.env[profile.apiKeyEnv]?.trim())
        : activeKey(store, profile.provider)?.credential.provider ===
          profile.provider,
  }));
}
export async function resolveResearchModel(
  name: string,
): Promise<ModelConnection> {
  checkedName(name);
  const profile = (await effectiveProfiles()).find((p) => p.name === name);
  if (!profile) throw new Error(`Unknown research model profile: ${name}`);
  if (profile.provider === "custom") {
    const apiKey = process.env[profile.apiKeyEnv]?.trim();
    if (!apiKey)
      throw new Error(
        `Research model ${name} is unavailable. Set ${profile.apiKeyEnv} before starting Kest.`,
      );
    return {
      provider: "custom",
      model: profile.model,
      baseURL: profile.baseURL,
      apiKey,
    };
  }
  const key = activeKey(await loadStore(), profile.provider);
  if (!key || key.credential.provider !== profile.provider)
    throw new Error(
      `Research model ${name} is unavailable. Configure /connect ${profile.provider} first.`,
    );
  return {
    provider: profile.provider,
    ...endpointFor(key.credential),
    model: profile.model,
  };
}
async function saveProfile(profile: Profile): Promise<void> {
  const { directory, file } = storage();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockFile = file + ".lock";
  const deadline = Date.now() + 5000;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  while (!lock) {
    try {
      lock = await open(lockFile, "wx", 0o600);
    } catch (error: any) {
      if (!["EEXIST", "EPERM", "EACCES"].includes(error.code)) throw error;
      if (Date.now() >= deadline)
        throw new Error(
          "Research model storage is busy. Retry after the other configuration write finishes.",
        );
      await Bun.sleep(20);
    }
  }
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const profiles = await readProfiles(file);
    const next = profiles.filter((p) => p.name !== profile.name);
    if (next.length >= 64)
      throw new Error(
        "At most 64 saved research model profiles are supported.",
      );
    next.push(profile);
    await writeFile(
      temporary,
      JSON.stringify({ version: 1, profiles: next }, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
    await lock.close();
    await unlink(lockFile);
  }
}
export async function saveResearchModel(
  name: string,
  provider: string,
  model: string,
): Promise<void> {
  if (provider !== "modal" && provider !== "baseten")
    throw new Error(
      "Built-in research providers are modal and baseten. Configure a custom endpoint separately.",
    );
  await saveProfile(checkedProfile({ name, provider, model }));
}
export async function saveResearchEndpoint(
  name: string,
  baseURL: string,
  model: string,
  apiKeyEnv: string,
): Promise<void> {
  await saveProfile(
    checkedProfile({ name, provider: "custom", model, baseURL, apiKeyEnv }),
  );
}
