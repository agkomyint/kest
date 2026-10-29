import type { Approval } from "./tools";

export type Permission = "all" | "minimal" | "strict";
export function parsePermission(value: string): Permission {
  if (value === "all" || value === "minimal" || value === "strict")
    return value;
  throw new Error("Permission must be all, minimal, or strict.");
}
export function autoApprove(level: Permission, request: Approval): boolean {
  return level === "all" || (level === "minimal" && request.kind === "file");
}
export const permissionHelp =
  "all: auto-approve edits, writes, Bun scripts, and browser actions\nminimal: auto-approve edits and writes; ask before Bun scripts and browser actions\nstrict: ask before every edit, write, Bun script, and browser action (default)";
