import { studySpentUsd } from "./rooms";
import type { CompanyState } from "./research-company";
import { tierStats, type ToolTiming } from "./stats";

/** What a headless run leaves behind, for scripts and for the person reading the log. */
export type RunReport = {
  /** The final lines for stderr. */
  lines: string[];
  /** 0 on success; 2 when a study was asked to publish but nothing reached LSI. */
  exitCode: number;
  published: string[];
};

/**
 * The research id of a successful lsi_publish. The response also lists similar existing records, so
 * only the response's own "id" counts; ids elsewhere in the text are never read.
 */
export function publishedIds(output: string): string[] {
  const start = output.indexOf("{");
  if (start === -1) return [];
  try {
    const id = (JSON.parse(output.slice(start)) as { id?: unknown }).id;
    return typeof id === "string" && /^LSI-R-\d{6}$/.test(id) ? [id] : [];
  } catch {
    return [];
  }
}

export function runReport(o: {
  study: CompanyState | null;
  autoPublish: boolean;
  published: string[];
  denied: string[];
  toolStats: ToolTiming[];
  baseUrl: string;
}): RunReport {
  const lines: string[] = ["", "── run report ──"];
  if (o.study) {
    const spent = studySpentUsd(o.study);
    const budget = o.study.maxCostUsd;
    lines.push(`study ${o.study.id.slice(0, 8)} · ${o.study.status} · $${spent.toFixed(4)}${budget ? ` of $${budget}` : ""}`);
  }
  if (o.published.length)
    for (const id of o.published) lines.push(`published ${id} · ${o.baseUrl}/research/${id}`);
  else if (o.autoPublish) lines.push("NOT published: no successful lsi_publish in this run.");
  if (o.denied.length) {
    const kinds = [...new Set(o.denied)];
    lines.push(`approvals denied (${o.denied.length}): ${kinds.join(", ")}. Re-run with --permission all to allow them.`);
  }
  if (o.toolStats.length) lines.push("", ...tierStats(o.toolStats, { width: 78 }));
  const failed = o.autoPublish && !o.published.length;
  return { lines, exitCode: failed ? 2 : 0, published: o.published };
}
