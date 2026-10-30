import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "./config";
import type { RoomLimits } from "./rooms";

const file = () => join(process.env.KEST_CONFIG_DIR?.trim() || configDir, "company.json");

/** Company-wide limits shared by every study room, persisted between launches. */
export async function loadCompanyLimits(): Promise<Partial<RoomLimits>> {
  try {
    const raw = JSON.parse(await readFile(file(), "utf8")) as Record<string, unknown>;
    const out: Partial<RoomLimits> = {};
    if (Number.isInteger(raw.maxRunning) && (raw.maxRunning as number) >= 1 && (raw.maxRunning as number) <= 10)
      out.maxRunning = raw.maxRunning as number;
    if (raw.totalUsd === null || (typeof raw.totalUsd === "number" && raw.totalUsd > 0 && raw.totalUsd <= 100_000))
      out.totalUsd = raw.totalUsd as number | null;
    return out;
  } catch {
    return {};
  }
}

export async function saveCompanyLimits(limits: RoomLimits): Promise<void> {
  const path = file();
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify({ maxRunning: limits.maxRunning, totalUsd: limits.totalUsd }, null, 2), { mode: 0o600 });
}
