// Live check (spends a few small model calls): does the lsi_publish tool text make the model
// produce a record LSI accepts on the FIRST attempt? Nothing is published; records are validated
// locally against LSI's own schema. Usage: bun run scripts/lsi-success.ts [runs-per-arm]
import OpenAI from "openai";
import { endpointFor, loadCredentials } from "../src/config";
import { lsiToolDefinitions } from "../src/lsi";
import { checkUrs } from "../src/urs-check";
import { ursSchema } from "../../lsi/src/lib/urs";

const runs = Number(process.argv[2] ?? 6);
const credentials = await loadCredentials();
if (!credentials) throw new Error("Run kest and /connect first.");
const endpoint = endpointFor(credentials);
const client = new OpenAI({ baseURL: endpoint.baseURL, apiKey: endpoint.apiKey });

const oldTool = JSON.parse(await Bun.file(new URL("../work/old-publish-tool.json", import.meta.url)).text());
const newTool = lsiToolDefinitions.find((t) => t.type === "function" && t.function.name === "lsi_publish")!;

const scenario = `A finished study. Publish it to LSI now with lsi_publish (domain: computer_science).
Study: "Group-commit journaling for a research agent". Question: does batching journal writes speed up a research run's event log? Method: a local harness recorded 200 concurrent events and 100 sequential events, 7 runs, median reported, baseline = one file write per event.
Results (from research/run-7/results.json, local file only, not hosted): concurrent 200 events 333 ms -> 41 ms; sequential 100 events 177 ms -> 168 ms. Code is in a private local repo at C:\\work\\kest (no public URL). Limitation: one machine, SSD, no network FS. Reviewer: approved.`;

async function arm(name: string, tool: unknown) {
  let accepted = 0, preflight = 0, calls = 0;
  const reasons: string[] = [];
  for (let i = 0; i < runs; i++) {
    const res = await client.chat.completions.create({
      model: endpoint.model,
      max_tokens: 4000,
      temperature: 0.7,
      messages: [{ role: "user", content: scenario }],
      tools: [tool as OpenAI.ChatCompletionTool],
      tool_choice: "required",
    });
    const call = res.choices[0]?.message.tool_calls?.[0];
    if (!call || call.type !== "function") { reasons.push("no tool call (" + res.choices[0]?.finish_reason + ")"); continue; }
    calls++;
    let research: unknown;
    try { research = JSON.parse(call.function.arguments).research; } catch { reasons.push("bad JSON"); continue; }
    if (typeof research === "string") { try { research = JSON.parse(research); } catch { /* keep */ } }
    const parsed = ursSchema.safeParse(research);
    if (parsed.success) accepted++;
    else reasons.push(parsed.error.issues[0]?.path.join(".") + ": " + parsed.error.issues[0]?.message);
    if (checkUrs(research).length === 0) preflight++;
  }
  console.log(`${name}: tool calls ${calls}/${runs}, LSI-schema accepted first try ${accepted}/${runs}, passes preflight ${preflight}/${runs}`);
  for (const reason of reasons.slice(0, 5)) console.log("   rejected:", reason.slice(0, 140));
  return { name, runs, calls, accepted, preflight, reasons };
}

const result = [await arm("old description", oldTool), await arm("new description", newTool)];
await Bun.write(new URL("../work/lsi-success.json", import.meta.url), JSON.stringify(result, null, 2));
process.exit(0);
