import { StyledText, fg } from "@opentui/core";
import { theme } from "./theme";

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
