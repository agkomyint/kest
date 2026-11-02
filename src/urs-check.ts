/**
 * Client-side check of a Universal Research Submission, mirroring LSI's rules,
 * so mistakes are reported before the user is asked to approve a publish and
 * before a round trip. LSI stays the authority; this only catches the common
 * rejections early with precise, fixable messages.
 */
const KEYS = new Set([
  "title", "domain", "topic", "question", "hypothesis", "method", "findings",
  "evidence", "limitations", "conclusion", "open_questions", "references",
  "answers_question", "relations", "provenance",
]);
const EVIDENCE_KEYS = new Set([
  "type", "description", "uri", "text", "sha256", "commit", "path", "size_bytes", "mime",
]);
const PROVENANCE_KEYS = new Set(["tool", "version", "models", "cost_usd", "run_id"]);
const MAX_INLINE = 6_000;

const str = (v: unknown, min: number, max: number) =>
  typeof v === "string" && v.trim().length >= min && v.trim().length <= max;

export function checkUrs(value: unknown): string[] {
  const problems: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value))
    return ["research must be a JSON object (not a string or array)."];
  const r = value as Record<string, unknown>;
  for (const key of Object.keys(r))
    if (!KEYS.has(key))
      problems.push(`unknown key "${key}": remove it (allowed: ${[...KEYS].join(", ")}).`);
  if (!str(r.title, 3, 300)) problems.push("title must be 3-300 characters.");
  if (typeof r.domain !== "string" || !/^[a-z][a-z0-9_]{1,40}$/.test(r.domain))
    problems.push("domain must be a lowercase id from lsi_domains (letters, digits, underscore).");
  if (!str(r.question, 10, 20000)) problems.push("question must be at least 10 characters.");
  if (!str(r.method, 10, 20000)) problems.push("method must be at least 10 characters.");
  if (!str(r.limitations, 1, 20000)) problems.push("limitations is required (a string).");
  if (!str(r.conclusion, 1, 20000)) problems.push("conclusion is required (a string).");
  if (!Array.isArray(r.findings) || !r.findings.length)
    problems.push('findings must be an ARRAY of short strings, e.g. ["…"].');
  else if (r.findings.some((f) => !str(f, 1, 20000)))
    problems.push("every finding must be a non-empty string.");
  if (!Array.isArray(r.evidence) || !r.evidence.length)
    problems.push("evidence must be an ARRAY with at least one item.");
  else
    r.evidence.forEach((raw, i) => {
      const at = `evidence[${i}]`;
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return void problems.push(`${at} must be an object.`);
      const e = raw as Record<string, unknown>;
      for (const key of Object.keys(e))
        if (!EVIDENCE_KEYS.has(key))
          problems.push(`${at} has unknown key "${key}" (allowed: ${[...EVIDENCE_KEYS].join(", ")}).`);
      if (!str(e.type, 1, 60)) problems.push(`${at}.type is required (benchmark, dataset, source, artifact, proof).`);
      if (!str(e.description, 3, 2000)) problems.push(`${at}.description must be 3-2000 characters.`);
      const hasUri = typeof e.uri === "string" && e.uri.trim() !== "";
      const hasText = typeof e.text === "string" && e.text.trim() !== "";
      if (!hasUri && !hasText) problems.push(`${at} needs a public uri or inline text.`);
      if (hasUri) {
        try {
          const url = new URL(String(e.uri));
          if (url.protocol !== "http:" && url.protocol !== "https:")
            problems.push(`${at}.uri must be a public http(s) link, not ${url.protocol} or a local path; put key results in text instead.`);
          else if (["localhost", "127.0.0.1", "0.0.0.0"].includes(url.hostname))
            problems.push(`${at}.uri points at this machine; use inline text instead.`);
        } catch {
          problems.push(`${at}.uri is not a valid URL (local paths are not allowed); put key results in text instead.`);
        }
      }
      if (hasText && String(e.text).trim().length > MAX_INLINE)
        problems.push(`${at}.text is over ${MAX_INLINE} characters: excerpt it (key rows only).`);
      if (typeof e.type === "string" && e.type.toLowerCase() === "repository") {
        if (!hasUri) problems.push(`${at} repository evidence needs a uri.`);
        if (typeof e.commit !== "string" || !/^[a-fA-F0-9]{40}$/.test(e.commit))
          problems.push(`${at} repository evidence needs a full 40-character commit SHA (otherwise use type "artifact" or "source").`);
      }
      if (e.sha256 !== undefined && !(typeof e.sha256 === "string" && /^[a-fA-F0-9]{64}$/.test(e.sha256)))
        problems.push(`${at}.sha256 must be 64 hex characters (or omit it).`);
    });
  if (r.provenance !== undefined) {
    if (!r.provenance || typeof r.provenance !== "object" || Array.isArray(r.provenance))
      problems.push("provenance must be an object like {\"tool\":\"kest\"}.");
    else {
      const p = r.provenance as Record<string, unknown>;
      for (const key of Object.keys(p))
        if (!PROVENANCE_KEYS.has(key))
          problems.push(`provenance has unknown key "${key}" (allowed: ${[...PROVENANCE_KEYS].join(", ")}).`);
      if (!str(p.tool, 1, 60)) problems.push('provenance.tool is required, e.g. "kest".');
    }
  }
  if (!(typeof r.answers_question === "string" && /^LSI-Q-\d{6}$/.test(r.answers_question)))
    problems.push("answers_question is required and must look like LSI-Q-000001: a finding cannot be published without the LSI question it answers (pick an existing question, or post one with lsi_post_question first).");
  for (const key of ["open_questions", "references"] as const)
    if (r[key] !== undefined && (!Array.isArray(r[key]) || (r[key] as unknown[]).some((v) => typeof v !== "string")))
      problems.push(`${key} must be an array of strings.`);
  return problems;
}

export const URS_EXAMPLE = {
  title: "Short descriptive title",
  domain: "computer_science",
  question: "What was investigated, as a full sentence?",
  method: "How it was done: setup, baselines, measurements, repetitions.",
  findings: ["One measured result per string, with numbers."],
  evidence: [
    { type: "benchmark", description: "What this shows", text: "key rows or numbers copied from your result files" },
    { type: "source", description: "Primary source", uri: "https://example.org/paper" },
  ],
  limitations: "What remains uncertain.",
  conclusion: "What the evidence supports, no more.",
  answers_question: "LSI-Q-000001",
  provenance: { tool: "kest" },
};
