import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { KestUI } from "./ui";

test("the tip row closes with ×, stays closed on the next launch, and /tips on restores it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kest-tips-close-"));
  const previous = process.env.KEST_CONFIG_DIR;
  process.env.KEST_CONFIG_DIR = directory;
  const first = await createTestRenderer({ width: 100, height: 30 });
  const ui = new KestUI(first.renderer, directory, null);
  try {
    await first.renderOnce();
    expect(ui["tipRow"].visible).toBe(true);
    expect(first.captureCharFrame()).toContain("×");
    await first.mockMouse.click(ui["tipClose"].x + 1, ui["tipClose"].y);
    await first.flush();
    expect(ui["tipRow"].visible).toBe(false);
    expect(JSON.parse(await readFile(join(directory, "ui.json"), "utf8")).tips).toBe(false);
  } finally {
    ui.close();
    await first.dispose();
  }
  const second = await createTestRenderer({ width: 100, height: 30 });
  const again = new KestUI(second.renderer, directory, null);
  try {
    await second.renderOnce();
    expect(again["tipRow"].visible).toBe(false);
    await again["command"]("/tips on");
    await second.renderOnce();
    expect(again["tipRow"].visible).toBe(true);
    await again["command"]("/tips off");
    expect(again["tipRow"].visible).toBe(false);
  } finally {
    again.close();
    await second.dispose();
    if (previous === undefined) delete process.env.KEST_CONFIG_DIR;
    else process.env.KEST_CONFIG_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
