import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { KestUI } from "./ui";

test("a late tool update after its row was trimmed from the transcript does not throw", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kest-destroyed-"));
  const r = await createTestRenderer({ width: 100, height: 30 });
  const ui = new KestUI(r.renderer, directory, { provider: "baseten", apiKey: "not-used" });
  try {
    const raw = ui as unknown as Record<string, any>;
    const added = raw.add("tool", "→ Read file", { input: "{}", output: "Running…", language: "JSON", toolName: "read_file" });
    const view = raw.toolViews.get(added.node);
    added.node.destroyRecursively();
    expect(() => raw.renderTool(view)).not.toThrow();
  } finally {
    ui.close();
    await r.dispose();
  }
});
