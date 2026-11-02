import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { KestUI } from "./ui";
import { compactHud, money } from "./research-hud";
import { newCompany } from "./research-company";

test("money is short and the compact status never repeats spend", () => {
  expect(money(0.026)).toBe("$0.03");
  expect(money(12.4)).toBe("$12.40");
  expect(money(1.24)).toBe("$1.24");
  const state = newCompany("obj");
  state.maxCostUsd = 10;
  expect(compactHud(state)).not.toContain("$");
});

test("footer shows room shortcuts on the right and a toast replaces them briefly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kest-footer-"));
  const r = await createTestRenderer({ width: 100, height: 30 });
  const ui = new KestUI(r.renderer, directory, { provider: "baseten", apiKey: "not-used" });
  const lastLine = () => r.captureCharFrame().split("\n").filter((l) => l.trim()).at(-1)!;
  try {
    await ui["command"]("/research prepare Footer study");
    await r.renderOnce();
    expect(lastLine()).toContain("Alt+↑↓ rooms · /chat leaves");
    expect(r.captureCharFrame()).not.toContain("typing directs");
    ui["toast"]("✓ copied 42 chars");
    await r.renderOnce();
    expect(lastLine()).toContain("✓ copied 42 chars");
    expect(lastLine()).not.toContain("Alt+");
  } finally {
    ui.close();
    await r.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Alt+Up/Down and clicking a row switch rooms", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kest-rooms-list-"));
  const r = await createTestRenderer({ width: 100, height: 40 });
  const ui = new KestUI(r.renderer, directory, { provider: "baseten", apiKey: "not-used" });
  try {
    await ui["command"]("/research prepare First study");
    await ui["command"]("/research prepare Second study");
    ui["rooms"].studies().forEach((room) => (room.controller = new AbortController()));
    ui["drawBar"]();
    await r.renderOnce();
    const focused = () => ui["rooms"].focused!.title;
    const start = focused();
    r.mockInput.pressArrow("up", { meta: true });
    await r.flush();
    expect(focused()).not.toBe(start);
    const row = ui["roomTargets"].findIndex((room) => room && room.title === start);
    expect(row).toBeGreaterThanOrEqual(0);
    await r.mockMouse.click(5, ui["roomBar"].y + row);
    await r.flush();
    expect(focused()).toBe(start);
  } finally {
    ui["rooms"].studies().forEach((room) => (room.controller = null));
    ui.close();
    await r.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
