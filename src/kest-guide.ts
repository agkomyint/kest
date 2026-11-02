import type OpenAI from "openai";
import guide from "../prompts/kest-guide.md" with { type: "text" };

const sections = new Map<string, string>();
for (const part of guide.split(/^## /m).slice(1)) {
  const [title = "", ...body] = part.split("\n");
  sections.set(title.trim(), body.join("\n").trim());
}

export const KEST_GUIDE_TOPICS = [...sections.keys()];

export const kestGuideToolDefinition: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "kest_guide",
    description: `Read-only reference about Kest itself (what it can do, commands, research, rooms, LSI, permissions, budgets). Use it when the user asks about Kest's capabilities. Topics: ${KEST_GUIDE_TOPICS.join(", ")}.`,
    parameters: {
      type: "object",
      properties: { topic: { type: "string", enum: KEST_GUIDE_TOPICS } },
      additionalProperties: false,
    },
  },
};

export function kestGuide(topic?: unknown): string {
  const key = typeof topic === "string" ? topic.trim().toLowerCase() : "overview";
  const text = sections.get(key || "overview");
  if (!text)
    throw new Error(`Unknown topic. Choose one of: ${KEST_GUIDE_TOPICS.join(", ")}.`);
  return text;
}

export const kestGuideHint =
  "You are running inside Kest. When the user asks what Kest or its /research can do, call the kest_guide tool (topics: overview, research, rooms, lsi, permissions, budgets, tools, commands) and answer from it instead of guessing.";
