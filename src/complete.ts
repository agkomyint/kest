export const slashCommands = [
  "/connect",
  "/provider",
  "/model",
  "/context",
  "/research",
  "/agents",
  "/usage",
  "/stats",
  "/stat",
  "/permission",
  "/browser",
  "/goal",
  "/tasks",
  "/new",
  "/sessions",
  "/resume",
  "/tools",
  "/status",
  "/system",
  "/help",
  "/exit",
] as const;

export type SlashCommand = (typeof slashCommands)[number];

export const slashSubcommands: Record<string, string[]> = {
  "/research": [
    "start",
    "prepare",
    "resume",
    "budget",
    "tokens",
    "models",
    "model",
    "endpoint",
    "off",
  ],
  "/context": ["summary", "messages", "archive", "show", "archived", "compact"],
  "/connect": ["modal", "baseten"],
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
  if (parts.length === 3) {
    const [cmd, sub, frag] = parts as [string, string, string];
    if (cmd === "/research" && sub === "budget") {
      if (frag === "") return [`${cmd} ${sub} tokens`];
      if ("tokens".startsWith(frag)) return [`${cmd} ${sub} tokens`];
    }
    return [];
  }
  return [];
}

export function completionHasChildren(candidate: string): boolean {
  if (slashSubcommands[candidate]?.length) return true;
  if (candidate === "/research budget") return true;
  return false;
}
