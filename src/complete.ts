export const slashCommands = [
  "/connect",
  "/provider",
  "/model",
  "/context",
  "/research",
  "/agents",
  "/usage",
  "/stats",
  "/permission",
  "/browser",
  "/goal",
  "/tasks",
  "/new",
  "/sessions",
  "/resume",
  "/tools",
  "/status",
  "/chat",
  "/rooms",
  "/system",
  "/help",
  "/exit",
] as const;

export type SlashCommand = (typeof slashCommands)[number];

export const slashSubcommands: Record<string, string[]> = {
  "/research": [
    "start",
    "show",
    "prepare",
    "resume",
    "wrapup",
    "budget",
    "open",
    "publish",
    "total",
    "parallel",
    "models",
    "model",
    "endpoint",
    "off",
  ],
  "/context": ["summary", "messages", "archive", "show", "archived", "compact"],
  "/connect": ["modal", "baseten", "nebius", "tavily", "lsi"],
  "/permission": ["all", "minimal", "strict"],
  "/browser": ["open", "tabs", "close"],
  "/goal": ["clear"],
};

export function longestCommonPrefix(values: string[]): string {
  if (!values.length) return "";
  let prefix = values[0]!;
  for (const value of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && prefix[i] === value[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

let studyHints: string[] = [];
/** Titles of the studies in this workspace, offered when completing /research show|resume|wrapup|open. */
export function setStudyHints(titles: string[]) {
  studyHints = titles;
}

export function completeCandidates(input: string): string[] {
  if (!input.startsWith("/")) return [];
  const firstLine = input.split("\n")[0]!;
  const parts = firstLine.split(/\s+/);
  if (parts.length === 1) {
    const frag = parts[0]!;
    return (slashCommands as readonly string[]).filter((c) =>
      c.startsWith(frag),
    );
  }
  if (parts.length === 2) {
    const [cmd, frag] = parts as [string, string];
    const subs = slashSubcommands[cmd];
    if (!subs) return [];
    if (frag === "") return subs.map((s) => `${cmd} ${s}`);
    return subs.filter((s) => s.startsWith(frag)).map((s) => `${cmd} ${s}`);
  }
  if (
    parts[0] === "/research" &&
    ["show", "resume", "wrapup", "open", "publish"].includes(parts[1]!)
  ) {
    const sub = parts[1]!;
    let rest = parts.slice(2);
    let lead = `/research ${sub}`;
    if (
      sub === "open" &&
      ["report", "evidence", "reviews", "timeline"].includes(rest[0] ?? "") &&
      rest.length > 1
    ) {
      lead += ` ${rest[0]}`;
      rest = rest.slice(1);
    }
    const words = rest.join(" ").toLowerCase().split(/\s+/).filter(Boolean);
    return studyHints
      .filter((title) => words.every((w) => title.toLowerCase().includes(w)))
      .map((title) => `${lead} ${title}`);
  }
  return [];
}

export function completionHasChildren(candidate: string): boolean {
  if (slashSubcommands[candidate]?.length) return true;
  return false;
}

export const slashDescriptions: Record<string, string> = {
  "/connect": "add provider or service credentials",
  "/provider": "switch the model provider",
  "/model": "choose a model",
  "/context": "inspect or compact conversation context",
  "/research": "budgeted research team",
  "/agents": "show research workers",
  "/usage": "token usage and spend",
  "/stats": "tool and session statistics",
  "/permission": "set approval mode",
  "/browser": "control the browser tools",
  "/goal": "set or clear a standing goal",
  "/tasks": "background tasks",
  "/new": "start a fresh session",
  "/sessions": "list saved sessions",
  "/resume": "resume a saved session",
  "/tools": "list available tools",
  "/status": "connection and model status",
  "/chat": "leave this study and return to chat",
  "/rooms": "switch between chat and studies",
  "/system": "show the system prompt",
  "/help": "commands and shortcuts",
  "/exit": "quit Kest",
};

export const subDescriptions: Record<string, string> = {
  "/research start": "begin the prepared study",
  "/research show": "show the current study",
  "/research prepare": "draft a study from an objective",
  "/research resume": "continue a paused study",
  "/research wrapup": "review, finish and publish now",
  "/research budget": "set a total USD allowance",
  "/research open": "report, evidence, reviews or timeline",
  "/research publish": "publish a finished study to LSI in one step",
  "/research total": "one allowance across all studies",
  "/research parallel": "how many studies run at once",
  "/research models": "list research models",
  "/research model": "choose a research model",
  "/research endpoint": "set the research endpoint",
  "/research off": "turn research mode off",
  "/connect modal": "Modal GLM-5.1",
  "/connect baseten": "Baseten models",
  "/connect nebius": "Nebius models",
  "/connect tavily": "web search",
  "/connect lsi": "publish and query research",
  "/permission all": "approve everything automatically",
  "/permission minimal": "approve routine, ask for risky",
  "/permission strict": "ask before every action",
};

export function describeCandidate(candidate: string): string {
  return slashDescriptions[candidate] ?? subDescriptions[candidate] ?? "";
}

const argHints: Record<string, string> = {
  "/research budget": "<amount>$ · e.g. 10$",
  "/research prepare": "<objective> · what to study",
  "/research model": "<model id>",
  "/research endpoint": "<url>",
  "/goal": "<goal text> · or: /goal clear",
  "/resume": "[session id]",
  "/browser open": "<url>",
  "/permission": "all | minimal | strict",
  "/research": "start | prepare | resume | wrapup | budget …",
};

/** One-line usage hint for a command whose name is complete. */
export function argumentHint(input: string): string {
  const line = input.split("\n")[0]!.trimEnd();
  if (!line.startsWith("/")) return "";
  return argHints[line] ?? "";
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(
        row[j]! + 1,
        row[j - 1]! + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
  }
  return row[b.length]!;
}

/** Closest known slash command for a mistyped one, or null. */
export function suggestCommand(command: string): string | null {
  let best: string | null = null;
  let bestDistance = 3;
  for (const known of slashCommands) {
    const d = distance(command, known);
    if (d < bestDistance) {
      best = known;
      bestDistance = d;
    }
  }
  return best;
}

export function isKnownCommand(command: string): boolean {
  return (slashCommands as readonly string[]).includes(command);
}
