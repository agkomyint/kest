import { StyledText, fg } from "@opentui/core";
import { theme } from "./theme";

export function actionLabel(name: string, raw: string): string {
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      args = parsed;
  } catch {
    /* Preserve raw input in details. */
  }
  const path = typeof args.path === "string" ? args.path : "";
  const labels: Record<string, string> = {
    read_file: "Read file",
    search: "Search files",
    list_files: "Inspect workspace",
    write_file: "Save file",
    edit_file: "Edit file",
    shell: "Run script",
    browser: "Browse sources",
    research_status: "Check research progress",
    list_models: "Check available models",
    set_plan: "Plan research",
    update_task: "Update plan",
    research_team: "Coordinate research team",
    research_review: "Review evidence",
    research_complete: "Complete study",
    spawn_subagent: "Delegate task",
    background_status: "Check background work",
    background_cancel: "Stop background work",
  };
  if (
    (name === "shell" || name === "browser") &&
    typeof args.title === "string" &&
    args.title.trim()
  )
    return args.title
      .trim()
      .split(/[\r\n]/)[0]!
      .slice(0, 100);
  const label = labels[name] ?? "Perform action";
  return path ? `${label} · ${path}` : label;
}

export function connectionFailure(error: unknown): boolean {
  // Fetch may throw a Bun socket error directly or an SDK error with a cause.
  let current = error;
  for (
    let depth = 0;
    depth < 4 && current && typeof current === "object";
    depth++
  ) {
    const value = current as {
      name?: string;
      code?: string;
      message?: string;
      cause?: unknown;
    };
    if (
      /APIConnection|APITimeout/.test(value.name ?? "") ||
      /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|socket connection|connection (?:was )?(?:closed|reset)|fetch failed/i.test(
        `${value.code ?? ""} ${value.message ?? ""}`,
      )
    )
      return true;
    current = value.cause;
  }
  return false;
}

export const toolColors = {
  muted: theme.muted,
  text: theme.fg,
  input: theme.user,
  inputBg: theme.inputBg,
  outputBg: theme.outputBg,
  output: theme.accent,
  keyword: theme.model,
  string: theme.accent,
  number: theme.tool,
  comment: theme.muted,
};
const clean = (text: string) =>
  text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

// Lightweight lexical coloring: no parser startup or grammar downloads.
export function toolCode(text: string) {
  const tokens =
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|await|async|import|from|export|return|if|else|for|of|in|while|throw|new|function|class|try|catch|true|false|null|undefined|number|string|boolean|type|interface)\b|\b\d+(?:\.\d+)?\b/g;
  const chunks = [];
  let start = 0;
  for (const match of text.matchAll(tokens)) {
    if (match.index! > start)
      chunks.push(fg(toolColors.text)(text.slice(start, match.index)));
    const token = match[0];
    const color =
      token.startsWith("//") || token.startsWith("/*")
        ? toolColors.comment
        : /^["'`]/.test(token)
          ? toolColors.string
          : /^\d/.test(token)
            ? toolColors.number
            : toolColors.keyword;
    chunks.push(fg(color)(token));
    start = match.index! + token.length;
  }
  if (start < text.length) chunks.push(fg(toolColors.text)(text.slice(start)));
  return chunks;
}

export function toolPanel(
  text: string,
  language: "TypeScript" | "JSON" | "text",
) {
  const safe = clean(text || "(No output)");
  return new StyledText(
    language === "text" ? [fg(toolColors.text)(safe)] : toolCode(safe),
  );
}
