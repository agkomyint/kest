import { mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Message } from "./agent";
import type { ContextState } from "./context";
import { replaceCheckpoint } from "./research-company";

export type WorkerRecord = {
  id: string;
  parentId: string;
  task: string;
  role: string;
  model: string;
  depth: number;
  state: "running" | "done" | "error";
  error?: string;
  messages: Message[];
  context?: ContextState;
};
const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
export async function saveWorkerRecord(
  directory: string,
  record: WorkerRecord,
) {
  if (!uuid.test(record.id)) throw new Error("Invalid worker ID.");
  const folder = join(directory, "agents");
  await mkdir(folder, { recursive: true });
  const target = join(folder, `${record.id}.json`);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record, null, 2));
    await replaceCheckpoint(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function listWorkerRecords(
  cwd: string,
  runId: string,
): Promise<WorkerRecord[]> {
  if (!uuid.test(runId)) throw new Error("Invalid research run ID.");
  const directory = join(cwd, "research", runId, "agents");
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error: any) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return Promise.all(
    files
      .filter(
        (name) =>
          uuid.test(name.replace(/\.json$/, "")) && name.endsWith(".json"),
      )
      .sort()
      .map(async (name) => {
        const record = JSON.parse(
          await readFile(join(directory, name), "utf8"),
        ) as WorkerRecord;
        if (record.id + ".json" !== name || !Array.isArray(record.messages))
          throw new Error("Invalid saved worker transcript.");
        return record;
      }),
  );
}
export function workerTranscript(record: WorkerRecord) {
  const messages = [...(record.context?.archive ?? []), ...record.messages];
  return (
    `${record.role} ${record.id} · ${record.model} · ${record.state}\nParent: ${record.parentId} · depth ${record.depth}\nTask: ${record.task}\n${record.error ? `Error: ${record.error}\n` : ""}\n` +
    messages
      .filter((m) => m.role !== "system" && m.role !== "developer")
      .map((m) => {
        const calls =
          m.role === "assistant"
            ? (m.tool_calls ?? [])
                .map((c) =>
                  c.type === "function"
                    ? `Tool call: ${c.function.name}\n${c.function.arguments}`
                    : "",
                )
                .join("\n")
            : "";
        return `[${m.role}]\n${typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")}\n${calls}`;
      })
      .join("\n\n")
  );
}
