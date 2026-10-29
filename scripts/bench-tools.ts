import { WorkspaceTools } from "../src/tools";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = await mkdtemp(join(tmpdir(), "kest-bench-"));
try {
  await Promise.all(
    Array.from({ length: 800 }, (_, i) =>
      Bun.write(join(root, `${i}.txt`), "ordinary line\n".repeat(80)),
    ),
  );
  const tools = new WorkspaceTools(root, async () => true);
  await Bun.write(
    join(root, "edit.txt"),
    "ordinary line\n".repeat(60000) + "unique-marker",
  );
  await tools.execute(
    "read_file",
    '{"path":"edit.txt"}',
    new AbortController().signal,
  );
  let revision = 0;
  for (const name of [
    "list_files",
    "search",
    "read_file",
    "edit_file",
    "write_file",
    "shell",
  ]) {
    const samples: number[] = [];
    for (let i = 0; i < 7; i++) {
      const start = performance.now();
      await tools.execute(
        name,
        JSON.stringify(
          name === "shell"
            ? { command: "console.log('benchmark')" }
            : name === "edit_file"
              ? {
                  path: "edit.txt",
                  old_string: revision % 2 ? "changed-marker" : "unique-marker",
                  new_string:
                    revision++ % 2 ? "unique-marker" : "changed-marker",
                }
              : name === "write_file"
                ? { path: `new-${i}.txt`, content: "benchmark" }
                : {
                    path: name === "read_file" ? "0.txt" : ".",
                    query: "absent-needle",
                  },
        ),
        new AbortController().signal,
      );
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    console.log(`${name}: median ${samples[3]!.toFixed(2)} ms`);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
