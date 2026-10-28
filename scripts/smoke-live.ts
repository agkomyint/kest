// Explicit live integration check: uses saved credentials and the real Modal endpoint.
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Agent } from "../src/agent";
import { loadCredentials } from "../src/config";

const credentials = await loadCredentials();
if (!credentials) throw new Error("Run kest and /connect first.");
const root = await mkdtemp(join(tmpdir(), "kest-live-"));
const file = join(root, "calculator.ts");
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 90_000);
try {
  await Bun.write(
    file,
    "export function add(a: number, b: number) {\n  return a - b;\n}\n",
  );
  const agent = new Agent(
    root,
    async (request) => request.title === "Edit calculator.ts",
  );
  await agent.run(
    "Read calculator.ts using read_file. Fix add so it adds instead of subtracting, using edit_file. Do not use shell or write_file. Then reply briefly.",
    credentials,
    controller.signal,
    (event) => {
      if (event.type === "tool") console.log(`${event.state}: ${event.name}`);
      if (event.type === "text") process.stdout.write(event.delta);
    },
  );
  const source = await Bun.file(file).text();
  if (!/return a \+ b/.test(source))
    throw new Error("The live agent did not make the expected edit.");
  console.log(
    "\nPASS: real endpoint → read_file → approved edit_file → final response.",
  );
} finally {
  clearTimeout(timer);
  await rm(root, { recursive: true, force: true });
}
