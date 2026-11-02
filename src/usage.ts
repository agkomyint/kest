import { dirname, join } from "node:path";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import {
  configDir,
  modelProvider,
  modelPricing,
  formatModelPricing,
} from "./config";

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
    await bumpDay(file, model, input, output).catch(() => {});
    return log;
  } finally {
    await unlink(temporary).catch(() => {});
    await lock.close();
    await unlink(lockFile);
  }
}

const fmt = (n: number) => n.toLocaleString("en-US");

const money = (value: number) =>
  value > 0 && value < 0.0001 ? "<$0.0001" : `$${value.toFixed(4)}`;

export function formatModelCosts(log: UsageLog): string {
  const models = Object.keys(log).sort();
  if (!models.length)
    return "Estimated model cost · all time · this machine\nNo token usage recorded yet; estimated total $0.0000 USD.";
  const lines = ["Estimated model cost · all time · this machine"];
  let inputCost = 0;
  let outputCost = 0;
  let unknownTokens = 0;
  let unknownModels = 0;
  for (const model of models) {
    const usage = log[model]!;
    const provider = modelProvider(model);
    const pricing = provider ? modelPricing(provider, model) : null;
    lines.push(`\n${provider ? `${provider} · ` : ""}${model}`);
    lines.push(`  ${formatModelPricing(pricing)}`);
    lines.push(`  Tokens: in ${fmt(usage.input)} · out ${fmt(usage.output)}`);
    if (!pricing) {
      unknownModels++;
      unknownTokens += usage.input + usage.output;
      lines.push("  Cost unknown · excluded from priced subtotal");
      continue;
    }
    const input = (usage.input * pricing.inputUsdPerMillionTokens) / 1_000_000;
    const output =
      (usage.output * pricing.outputUsdPerMillionTokens) / 1_000_000;
    inputCost += input;
    outputCost += output;
    lines.push(
      `  Estimated: input ${money(input)} · output ${money(output)} · total ${money(input + output)} USD`,
    );
    lines.push(`  ${pricing.note}`);
  }
  lines.push(
    "",
    `${unknownModels ? "PRICED SUBTOTAL" : "ESTIMATED TOTAL"} ${money(inputCost + outputCost)} USD · input ${money(inputCost)} · output ${money(outputCost)}`,
  );
  if (unknownModels)
    lines.push(
      `Total cost unknown: ${unknownModels} model(s), ${fmt(unknownTokens)} tokens have no verified catalog rate.`,
    );
  lines.push(
    "Uses current catalog rates for historical recorded tokens. Cache discounts, historical rate changes, account credits and unreported tokens are not included. Usage is stored by model ID; provider attribution is inferred from the catalog. This is an estimate, not an invoice.",
  );
  return lines.join("\n");
}

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

// ---- per-day history (powers the /usage panel) --------------------------------------------

/** date (YYYY-MM-DD, local) -> model -> tokens. Stored beside the totals; older totals have no history. */
export type DailyUsage = Record<
  string,
  Record<string, { input: number; output: number }>
>;

export const dailyFile = (file = usageFile()) =>
  file.replace(/\.json$/, "") + ".days.json";
export const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export async function loadDaily(file = usageFile()): Promise<DailyUsage> {
  try {
    const f = Bun.file(dailyFile(file));
    if (!(await f.exists())) return {};
    const raw: unknown = await f.json();
    return raw && typeof raw === "object" ? (raw as DailyUsage) : {};
  } catch {
    return {};
  }
}

// Runs inside the usage lock, so it needs no lock of its own.
async function bumpDay(
  file: string,
  model: string,
  input: number,
  output: number,
) {
  const days = await loadDaily(file);
  const clean = (n: number) =>
    Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  const day = (days[dayKey()] ??= {});
  const m = (day[model] ??= { input: 0, output: 0 });
  m.input += clean(input);
  m.output += clean(output);
  for (const k of Object.keys(days).sort().slice(0, -90)) delete days[k];
  const target = dailyFile(file);
  const tmp = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(tmp, JSON.stringify(days) + "\n", { mode: 0o600 });
    await rename(tmp, target);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

// ---- the /usage panel ---------------------------------------------------------------------

export type StudySpend = {
  id: string;
  title: string;
  spent: number;
  budget: number | null;
};

/** Cost of one model's tokens, or null when the catalog has no verified rate. */
export function costOf(
  model: string,
  t: { input: number; output: number },
): number | null {
  const provider = modelProvider(model);
  const pricing = provider ? modelPricing(provider, model) : null;
  if (!pricing) return null;
  return (
    (t.input * pricing.inputUsdPerMillionTokens +
      t.output * pricing.outputUsdPerMillionTokens) /
    1_000_000
  );
}

const compact = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)}B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)}M`
      : n >= 1e3
        ? `${Math.round(n / 1e3)}K`
        : String(n);
const usd = (v: number) =>
  v === 0 ? "$0" : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
const cut = (s: string, n: number) =>
  s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s;
const bar = (frac: number, w: number) => {
  const n = Math.max(0, Math.min(w, Math.round(frac * w)));
  return "█".repeat(n) + "░".repeat(w - n);
};
const SPARK = "▁▂▃▄▅▆▇█";

/**
 * The /usage view: totals on top, models ranked by cost with bars, a 7-day sparkline and study
 * budgets. Pure: pass in what to show, get lines back.
 */
export function usagePanel(
  log: UsageLog,
  o: {
    width?: number;
    daily?: DailyUsage;
    studies?: StudySpend[];
    summary?: { sessions: number; workspaces: number };
    now?: Date;
  } = {},
): string[] {
  const width = Math.max(40, o.width ?? 80);
  const wide = width >= 70;
  const rule = "─".repeat(Math.min(width, 78));
  const head = `USAGE · this machine${o.summary ? ` · ${o.summary.sessions} sessions · ${o.summary.workspaces} workspaces` : ""}`;
  const models = Object.keys(log);
  if (!models.length)
    return [
      cut(head, width),
      rule,
      "No token usage yet. Send a message; usage is logged per model on this machine.",
    ];

  const rows = models.map((m) => ({
    model: m,
    t: log[m]!,
    cost: costOf(m, log[m]!),
  }));
  rows.sort(
    (a, b) =>
      (b.cost ?? -1) - (a.cost ?? -1) ||
      b.t.input + b.t.output - (a.t.input + a.t.output),
  );
  const priced = rows.filter((r) => r.cost !== null);
  const total = priced.reduce((s, r) => s + r.cost!, 0);
  const inTok = rows.reduce((s, r) => s + r.t.input, 0);
  const outTok = rows.reduce((s, r) => s + r.t.output, 0);
  const req = rows.reduce((s, r) => s + r.t.requests, 0);
  const inCost = priced.reduce((s, r) => {
    const p = modelPricing(modelProvider(r.model)!, r.model)!;
    return s + (r.t.input * p.inputUsdPerMillionTokens) / 1e6;
  }, 0);

  const lines = [cut(head, width), rule];
  const unknown = rows.length - priced.length;
  lines.push(
    cut(
      `Spend (est.) ${usd(total)}${unknown ? "+" : ""}   Tokens ${compact(inTok + outTok)}   Requests ${req.toLocaleString("en-US")}`,
      width,
    ),
    cut(
      `  in ${usd(inCost)} · out ${usd(total - inCost)}   ·   in ${compact(inTok)} · out ${compact(outTok)}`,
      width,
    ),
    "",
    "By model",
  );
  const barW = wide ? 16 : 8;
  const nameW = Math.max(10, width - (2 + 1 + barW + 1 + 6 + 1 + 8 + (wide ? 5 : 0)));
  const top = Math.max(...rows.map((r) => r.cost ?? 0), 1e-9);
  for (const r of rows) {
    const provider = modelProvider(r.model);
    const name = cut(
      provider ? `${provider} · ${r.model.split("/").pop()}` : r.model.split("/").pop()!,
      nameW,
    ).padEnd(nameW);
    const tok = compact(r.t.input + r.t.output).padStart(6);
    const cost =
      r.cost === null ? "unpriced" : r.cost === 0 ? "free" : usd(r.cost);
    const share =
      r.cost !== null && total > 0
        ? `${Math.round((r.cost / total) * 100)}%`.padStart(4)
        : "";
    lines.push(
      cut(
        `  ${name} ${bar((r.cost ?? 0) / top, barW)} ${tok} ${cost.padStart(8)}${wide ? " " + share : ""}`,
        width,
      ),
    );
  }
  if (unknown) {
    const toks = rows
      .filter((r) => r.cost === null)
      .reduce((s, r) => s + r.t.input + r.t.output, 0);
    lines.push(
      cut(
        `  ⚠ ${unknown} model${unknown === 1 ? "" : "s"} (${compact(toks)} tokens) lack a verified rate, not in the total`,
        width,
      ),
    );
  }

  const days = o.daily ?? {};
  if (Object.keys(days).length) {
    const now = o.now ?? new Date();
    const series: number[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const day = days[dayKey(d)] ?? {};
      series.push(
        Object.entries(day).reduce((s, [m, t]) => s + (costOf(m, t) ?? 0), 0),
      );
    }
    const max = Math.max(...series, 1e-9);
    const spark = series
      .map((v) =>
        v <= 0 ? "▁" : SPARK[Math.min(7, Math.floor((v / max) * 7.999))]!,
      )
      .join("");
    const avg = series.reduce((a, b) => a + b, 0) / 7;
    lines.push(
      "",
      cut(
        `Last 7 days  ${spark}   today ${usd(series[6]!)} · avg ${usd(avg)}/day`,
        width,
      ),
    );
  }

  const studies = (o.studies ?? []).filter(
    (s) => s.spent > 0 || s.budget !== null,
  );
  if (studies.length) {
    lines.push("", "Research studies (open in this session)");
    for (const s of studies.slice(0, 6)) {
      const money =
        s.budget !== null
          ? `${usd(s.spent)} / ${usd(s.budget)}`
          : usd(s.spent);
      const frac = s.budget ? Math.min(1, s.spent / s.budget) : 0;
      const tail = s.budget
        ? ` ${bar(frac, 10)} ${Math.round(frac * 100)}%`
        : "";
      const right = `${money}${wide ? tail : ""}`;
      const w = Math.max(10, width - right.length - 4);
      lines.push(cut(`  ${cut(s.title, w).padEnd(w)} ${right}`, width));
    }
  }
  lines.push(
    "",
    cut("/usage models for per-model detail", width),
    cut("Estimates use current catalog rates. Not an invoice.", width),
  );
  return lines;
}
