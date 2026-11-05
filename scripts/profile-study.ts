// Budget-allocation profile of finished Kest studies: who spent the money, on what, and how well
// the budget reservation matched reality.
//   bun scripts/profile-study.ts <study-dir-or-events.jsonl>... [--json]
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

type Row = { at: string; kind: string; data: any };
type Bucket = { reqs: number; inTok: number; outTok: number; usd: number; reservedUsd: number; tools: number; toolChars: number };
const empty = (): Bucket => ({ reqs: 0, inTok: 0, outTok: 0, usd: 0, reservedUsd: 0, tools: 0, toolChars: 0 });

export function findEvents(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name === "events.jsonl") out.push(p);
      else if (depth < 4 && statSync(p).isDirectory() && name !== "node_modules") walk(p, depth + 1);
    }
  };
  walk(path, 0);
  return out;
}

export function profile(file: string) {
  const rows: Row[] = readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const pending = new Map<string, { rate: { input: number; output: number }; reservedMicros: number; role: string; depth: number }[]>();
  const byTier = new Map<string, Bucket>();
  const byModel = new Map<string, Bucket>();
  const get = <K>(m: Map<K, Bucket>, k: K) => { let b = m.get(k); if (!b) m.set(k, (b = empty())); return b; };
  const tierOf = (depth: number, role: string) => (role === "reviewer" ? "reviewer" : depth === 0 ? "director" : depth === 1 ? "researcher" : "subagent");
  let delegates = 0, failed = 0, firstAt = "", lastAt = "", toolCalls = 0;
  const toolNames = new Map<string, { n: number; chars: number }>();
  for (const r of rows) {
    firstAt ||= r.at; lastAt = r.at;
    const d = r.data ?? {};
    if (r.kind === "model_request") {
      const q = pending.get(d.agent.id) ?? [];
      q.push({ rate: d.rate ?? { input: 0, output: 0 }, reservedMicros: d.reservedCostMicros ?? 0, role: d.agent.role ?? "", depth: d.agent.depth ?? 0 });
      pending.set(d.agent.id, q);
    } else if (r.kind === "model_usage") {
      const p = pending.get(d.agentId)?.shift();
      if (!p) continue;
      const inTok = d.usage?.prompt_tokens ?? 0, outTok = d.usage?.completion_tokens ?? 0;
      const usd = (inTok * p.rate.input + outTok * p.rate.output) / 1e6;
      for (const b of [get(byTier, tierOf(p.depth, p.role)), get(byModel, String(d.model ?? ""))]) {
        b.reqs++; b.inTok += inTok; b.outTok += outTok; b.usd += usd; b.reservedUsd += p.reservedMicros / 1e6;
      }
    } else if (r.kind === "tool_result") {
      toolCalls++;
      const b = get(byTier, d.tier ?? tierOf(d.depth ?? 0, ""));
      b.tools++; b.toolChars += String(d.output ?? "").length;
      const t = toolNames.get(d.name) ?? { n: 0, chars: 0 }; t.n++; t.chars += String(d.output ?? "").length; toolNames.set(d.name, t);
    } else if (r.kind === "delegate_started") delegates++;
    else if (r.kind === "delegate_failed") failed++;
  }
  const total = [...byTier.values()].reduce((s, b) => s + b.usd, 0);
  const reserved = [...byTier.values()].reduce((s, b) => s + b.reservedUsd, 0);
  return { file, total, reserved, delegates, failed, toolCalls, seconds: Math.round((Date.parse(lastAt) - Date.parse(firstAt)) / 1000) || 0, byTier: Object.fromEntries(byTier), tools: Object.fromEntries(toolNames) };
}

export function render(p: ReturnType<typeof profile>): string {
  const L: string[] = [`${p.file}`, `  spent $${p.total.toFixed(4)} · reserved-sum $${p.reserved.toFixed(2)} (${p.total ? (p.reserved / p.total).toFixed(1) : "-"}x actual) · ${p.seconds}s · delegates ${p.delegates} (failed ${p.failed}) · tool calls ${p.toolCalls}`];
  for (const [tier, b] of Object.entries(p.byTier) as [string, Bucket][]) {
    L.push(`  ${tier.padEnd(10)} ${String(b.reqs).padStart(4)} req  in ${(b.inTok / 1000).toFixed(0).padStart(5)}K  out ${(b.outTok / 1000).toFixed(1).padStart(5)}K  $${b.usd.toFixed(4).padStart(7)} ${p.total ? `${Math.round((b.usd / p.total) * 100)}%`.padStart(4) : ""}  tools ${b.tools} (${(b.toolChars / 4000).toFixed(0)}K tok)`);
  }
  const top = Object.entries(p.tools).sort((a, b) => b[1].chars - a[1].chars).slice(0, 5).map(([n, t]) => `${n}×${t.n}/${(t.chars / 4000).toFixed(0)}Ktok`);
  if (top.length) L.push(`  top tools: ${top.join("  ")}`);
  return L.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const files = args.filter((a) => !a.startsWith("--")).flatMap(findEvents);
  const all = files.map(profile);
  if (args.includes("--json")) console.log(JSON.stringify(all, null, 2));
  else for (const p of all) console.log(render(p) + "\n");
}
