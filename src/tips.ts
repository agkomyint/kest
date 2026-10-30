import catalog from "../tips.md" with { type: "text" };
import type { Permission } from "./permissions";
import type { CompanyState } from "./research-company";

export type Tip = { id: string; situation: string; text: string };
export type TipContext = {
  connected: boolean;
  permission: Permission;
  research?: CompanyState | null;
  researchEnabled: boolean;
  tavily: boolean;
  lsi: boolean;
};

// tips.md is the editable source of truth; never put private session data here.
const section =
  catalog
    .split("## Short tip catalog")[1]
    ?.split("## Every application CLI flag")[0] ?? "";
export const allTips: Tip[] = section.split("\n").flatMap((line) => {
  const match = /^\|\s*([^|]+?)\s*\|\s*Tip:\s*([^|]+?)\s*\|\s*$/.exec(line);
  return match
    ? [
        {
          id: match[1]!.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          situation: match[1]!,
          text: match[2]!,
        },
      ]
    : [];
});

export function tipsFor(context: TipContext): Tip[] {
  const study = context.research;
  const eligible = allTips.filter((tip) => {
    switch (tip.situation) {
      case "First launch":
        return !context.connected;
      case "Wants fewer interruptions":
        return context.permission !== "all";
      case "Wants edits approved automatically":
        return context.permission !== "minimal";
      case "Wants to review every change":
        return context.permission !== "strict";
      case "Prepared without funding":
        return study?.status === "ready" && study.maxCostUsd === null;
      case "Prepared and funded":
        return study?.status === "ready" && study.maxCostUsd !== null;
      case "Continuing after a pause":
        return study?.status === "paused";
      case "Changing funding":
        return Boolean(study && study.status !== "completed");
      case "Pausing research":
        return Boolean(
          study && study.status !== "completed" && context.researchEnabled,
        );
      case "Inspecting researchers":
        return Boolean(study?.agents);
      case "Switching to ordinary chat":
        return Boolean(study && context.researchEnabled);
      case "Starting another study":
        return Boolean(study);
      case "Checking an existing report":
        return study?.status === "completed";
      case "Adding web research":
        return !context.tavily;
      case "Using Tavily":
      case "Checking remote research":
        return context.tavily;
      case "Adding LSI":
        return !context.lsi;
      case "LSI account actions":
        return context.lsi;
      default:
        return true;
    }
  });
  const priority = !context.connected
    ? "First launch"
    : study?.status === "ready"
      ? study.maxCostUsd === null
        ? "Prepared without funding"
        : "Prepared and funded"
      : study?.status === "paused"
        ? "Continuing after a pause"
        : study?.status === "budget_exhausted"
          ? "Changing funding"
          : study?.status === "completed"
            ? "Checking an existing report"
            : context.permission !== "all"
              ? "Wants fewer interruptions"
              : "Learning commands";
  return [
    ...eligible.filter((tip) => tip.situation === priority),
    ...eligible.filter((tip) => tip.situation !== priority),
  ];
}
