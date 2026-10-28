import { join } from "node:path";
import { mkdir } from "node:fs/promises";
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
  return override ? override : join(configDir, "usage.json");
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

export async function loadUsage(
  file = usageFile(),
): Promise<UsageLog> {
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

export async function recordUsage(
  model: string,
  input: number,
  output: number,
  file = usageFile(),
): Promise<UsageLog> {
  const log = await loadUsage(file);
  const prev = log[model] ?? {
    input: 0,
    output: 0,
    requests: 0,
    updatedAt: "",
  };
  log[model] = {
    input: prev.input + Math.max(0, Math.floor(input)),
    output: prev.output + Math.max(0, Math.floor(output)),
    requests: prev.requests + 1,
    updatedAt: new Date().toISOString(),
  };
  await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
  await Bun.write(file, JSON.stringify(log, null, 2) + "\n", { mode: 0o600 });
  return log;
}

const fmt = (n: number) => n.toLocaleString("en-US");

export function formatUsage(log: UsageLog): string {
  const models = Object.keys(log).sort();
  if (!models.length) {
    return "No token usage recorded yet. Send a message first — usage is logged per model on this machine.";
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
  return lines.join("\n");
}
