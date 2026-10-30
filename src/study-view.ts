import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export const studyTabs = ["report", "evidence", "reviews", "timeline"] as const;
export type StudyTab = (typeof studyTabs)[number];

export type StudyArtifacts = {
  report: { path: string; text: string } | null;
  evidence: { path: string; bytes: number }[];
  reviews: { id: string; model: string; task: string; verdict: string }[];
  timeline: { at: string; text: string }[];
};

const hidden = new Set(["events.jsonl", "state.json", "agents"]);
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
const oneLine = (text: unknown) => String(text ?? "").replace(/\s+/g, " ").trim();

async function listFiles(dir: string, base = ""): Promise<{ path: string; bytes: number }[]> {
  const out: { path: string; bytes: number }[] = [];
  let names: string[] = [];
  try {
    names = await readdir(join(dir, base));
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    const rel = base ? `${base}/${name}` : name;
    if (!base && hidden.has(name)) continue;
    const info = await stat(join(dir, rel)).catch(() => null);
    if (!info) continue;
    if (info.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else out.push({ path: rel, bytes: info.size });
  }
  return out;
}

/** Read what a study left on disk. Everything is optional: a new study has nothing yet. */
export async function loadStudyArtifacts(
  cwd: string,
  study: { id: string; finalReportPath?: string },
): Promise<StudyArtifacts> {
  const dir = join(cwd, "research", study.id);
  const evidence = await listFiles(dir);
  let report: StudyArtifacts["report"] = null;
  const candidates = [
    study.finalReportPath,
    ...evidence.filter((f) => /report|results|paper/i.test(f.path) && f.path.endsWith(".md")).map((f) => join("research", study.id, f.path)),
  ].filter((p): p is string => Boolean(p));
  for (const candidate of candidates) {
    const text = await readFile(join(cwd, candidate), "utf8").catch(() => null);
    if (text) {
      report = { path: candidate.replaceAll("\\", "/"), text };
      break;
    }
  }
  const reviews: StudyArtifacts["reviews"] = [];
  for (const name of await readdir(join(dir, "agents")).catch(() => [] as string[])) {
    const agent = await readFile(join(dir, "agents", name), "utf8")
      .then((text) => JSON.parse(text) as { id: string; role?: string; model?: string; task?: string; messages?: { role: string; content?: unknown }[] })
      .catch(() => null);
    if (!agent || agent.role !== "reviewer") continue;
    const last = [...(agent.messages ?? [])].reverse().find((m) => m.role === "assistant" && typeof m.content === "string" && m.content);
    reviews.push({
      id: agent.id.slice(0, 8),
      model: agent.model ?? "",
      task: oneLine(agent.task),
      verdict: String(last?.content ?? "(no verdict recorded)").trim(),
    });
  }
  const timeline: StudyArtifacts["timeline"] = [];
  const log = await readFile(join(dir, "events.jsonl"), "utf8").catch(() => "");
  let requests = 0;
  for (const line of log.split("\n")) {
    if (!line) continue;
    let event: { at?: string; kind?: string; data?: Record<string, unknown> };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const d = event.data ?? {};
    const at = event.at ?? "";
    if (event.kind === "model_request") requests++;
    else if (event.kind === "run_started") timeline.push({ at, text: `run started · ${clip(oneLine(d.objective), 100)}` });
    else if (event.kind === "delegate_started") timeline.push({ at, text: `${d.role ?? "worker"} started · ${d.model ?? ""} · ${clip(oneLine(d.task), 80)}` });
    else if (event.kind === "delegate_result") timeline.push({ at, text: `worker returned · ${clip(oneLine(d.task), 80)}` });
    else if (event.kind === "tool_result" && d.state === "error") timeline.push({ at, text: `tool error · ${d.name} · ${clip(oneLine(d.output), 80)}` });
    else if (event.kind === "tool_result" && /^(research_complete|research_review|lsi_publish|lsi_claim)$/.test(String(d.name))) timeline.push({ at, text: `${d.name} ${d.state}` });
    else if (event.kind === "research_completed") timeline.push({ at, text: `completed · ${d.reportPath ?? ""}` });
  }
  if (requests) timeline.push({ at: "", text: `${requests} model requests in total` });
  return { report, evidence, reviews, timeline };
}

export function formatStudyTab(tab: StudyTab, a: StudyArtifacts, id: string): string {
  const head = `${studyTabs.map((t) => (t === tab ? `[${t}]` : t)).join("  ")}  ·  research/${id}/`;
  let body: string;
  if (tab === "report")
    body = a.report ? `${a.report.path}\n\n${clip(a.report.text.trim(), 8000)}` : "No report yet. The director writes one before research_complete.";
  else if (tab === "evidence")
    body = a.evidence.length
      ? a.evidence.map((f) => `${f.path}  ${f.bytes < 1024 ? `${f.bytes} B` : `${(f.bytes / 1024).toFixed(1)} KB`}`).join("\n")
      : "No evidence files yet.";
  else if (tab === "reviews")
    body = a.reviews.length
      ? a.reviews.map((r) => `Reviewer ${r.id} · ${r.model}\nAsked: ${clip(r.task, 160)}\n${clip(r.verdict, 1800)}`).join("\n\n")
      : "No independent review yet.";
  else
    body = a.timeline.length
      ? a.timeline.map((e) => `${e.at ? e.at.slice(11, 19) : "        "}  ${e.text}`).join("\n")
      : "No events yet.";
  return `${head}\n\n${body}`;
}
