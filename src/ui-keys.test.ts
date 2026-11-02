import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { KestUI } from "./ui";

test("Ctrl+K opens the room picker from the prompt when several rooms exist", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kest-keys-"));
  const r = await createTestRenderer({ width: 100, height: 40 });
  const ui = new KestUI(r.renderer, directory, { provider: "baseten", apiKey: "not-used" });
  try {
    r.mockInput.pressKey("k", { ctrl: true });
    await r.flush();
    expect(ui["listPicker"]).toBeNull();
    await ui["command"]("/research prepare One");
    await ui["command"]("/research prepare Two");
    r.mockInput.pressKey("k", { ctrl: true });
    await r.flush();
    expect(ui["listPicker"]).not.toBeNull();
  } finally {
    ui.close();
    await r.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
