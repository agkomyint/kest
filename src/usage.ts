import { dirname, join } from "node:path";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { configDir, modelProvider } from "./config";

export type UsageTotals = {
  input: number;
  output: number;
  requests: number;
  updatedAt: string;
};
export type UsageLog = Record<string, UsageTotals>;

export function usageFile() {
  const override = process.env.KEST_USAGE_FILE?.trim();
  return override
    ? override
    : join(process.env.KEST_CONFIG_DIR?.trim() || configDir, "usage.json");
}

function cleanTotals(value: unknown): UsageTotals {
  const v = (value && typeof value === "object" ? value : {}) as Record<
    string,
    unknown
  >;
  const num = (n: unknown) =>
    typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  return {
    input: num(v.input),
    output: num(v.output),
    requests: num(v.requests),
    updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : "",
  };
}

export async function loadUsage(file = usageFile()): Promise<UsageLog> {
  try {
    const f = Bun.file(file);
    if (!(await f.exists())) return {};
    const raw: unknown = await f.json();
    if (!raw || typeof raw !== "object") return {};
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).map(([model, totals]) => [
        model,
        cleanTotals(totals),
      ]),
    );
  } catch {
    return {};
  }
}

const pending = new Set<Promise<UsageLog>>();
export async function flushUsage() {
  await Promise.allSettled([...pending]);
}

export function recordUsage(
  model: string,
  input: number,
  output: number,
  file = usageFile(),
): Promise<UsageLog> {
  const write = updateUsage(model, input, output, file);
  pending.add(write);
  void write.then(
    () => pending.delete(write),
    () => pending.delete(write),
  );
  return write;
}

async function updateUsage(
  model: string,
  input: number,
  output: number,
  file: string,
): Promise<UsageLog> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  // Cross-process lock protects read/modify/write across terminal instances.
  // A crash can leave this lock behind; report it rather than overwrite totals.
  const lockFile = file + ".lock";
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  const deadline = Date.now() + 5000;
  while (!lock) {
    try {
      lock = await open(lockFile, "wx", 0o600);
    } catch (error: any) {
      // Windows can report a briefly delete-pending lock as EPERM/EACCES.
      if (!["EEXIST", "EPERM", "EACCES"].includes(error.code)) throw error;
      if (Date.now() >= deadline)
        throw new Error(`Usage storage is locked: ${lockFile}`);
      await Bun.sleep(20);
    }
  }
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const log = await loadUsage(file);
    const prev = log[model] ?? {
      input: 0,
      output: 0,
      requests: 0,
      updatedAt: "",
    };
    log[model] = {
      input:
        prev.input +
        (Number.isFinite(input) ? Math.max(0, Math.floor(input)) : 0),
      output:
        prev.output +
        (Number.isFinite(output) ? Math.max(0, Math.floor(output)) : 0),
      requests: prev.requests + 1,
      updatedAt: new Date().toISOString(),
    };
    await Bun.write(temporary, JSON.stringify(log, null, 2) + "\n", {
      mode: 0o600,
    });
    await rename(temporary, file);
    return log;
  } finally {
    await unlink(temporary).catch(() => {});
    await lock.close();
    await unlink(lockFile);
  }
}

const fmt = (n: number) => n.toLocaleString("en-US");

export function formatUsage(
  log: UsageLog,
  summary?: { sessions: number; workspaces: number },
): string {
  const scope = summary
    ? `All time · this machine · ${summary.sessions} sessions · ${summary.workspaces} workspaces\n`
    : "";
  const models = Object.keys(log).sort();
  if (!models.length) {
    return (
      scope +
      "No token usage recorded yet. Send a message first — usage is logged per model on this machine."
    );
  }
  const lines = ["The larder (token usage) · all time · this machine", ""];
  let totalIn = 0;
  let totalOut = 0;
  let totalReq = 0;
  for (const model of models) {
    const t = log[model]!;
    totalIn += t.input;
    totalOut += t.output;
    totalReq += t.requests;
    const provider = modelProvider(model);
    lines.push(
      `${provider ? `${provider} · ` : ""}${model}\n  in ${fmt(t.input)} · out ${fmt(t.output)} · total ${fmt(t.input + t.output)} · ${t.requests} request${t.requests === 1 ? "" : "s"}`,
    );
  }
  lines.push(
    "",
    `TOTAL  in ${fmt(totalIn)} · out ${fmt(totalOut)} · total ${fmt(totalIn + totalOut)} · ${totalReq} requests`,
  );
  return scope + lines.join("\n");
}
