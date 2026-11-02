import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "./config";

const file = () =>
  join(process.env.KEST_CONFIG_DIR?.trim() || configDir, "ui.json");

/** Small display preferences, kept apart from credentials. */
export function loadTipsEnabled(): boolean {
  try {
    const raw = JSON.parse(readFileSync(file(), "utf8")) as { tips?: unknown };
    return raw.tips !== false;
  } catch {
    return true;
  }
}

export async function saveTipsEnabled(enabled: boolean): Promise<void> {
  const path = file();
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify({ tips: enabled }, null, 2));
}
