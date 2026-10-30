import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { KestUI } from "./ui";
import { completeCandidates } from "./complete";

test("fuzzy study targeting, /research open, total and parallel limits, pickers, completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kest-picker-"));
  const r = await createTestRenderer({ width: 110, height: 30 });
  const ui = new KestUI(r.renderer, directory, { provider: "baseten", apiKey: "not-used" });
  const last = () => ui["session"].entries.at(-1)!.text;
  try {
    await ui["command"]("/research prepare Tokenizer speed study");
    await ui["command"]("/research prepare Indexing recall study");
    await ui["command"]("/chat");
    await ui["command"]("/research show tokenizer");
    expect(last()).toContain("Tokenizer speed study");
    expect(last()).toContain("/research open");
    await ui["command"]("/research show study");
    expect(last()).toContain("Several studies match");
    await ui["command"]("/research show nothinghere");
    expect(last()).toContain("No study matches");
    await ui["command"]("/research budget indexing 7$");
    expect(ui["rooms"].focused!.study?.objective).toBe("Indexing recall study");
    expect(ui["rooms"].focused!.study?.maxCostUsd).toBe(7);
    await ui["command"]("/chat");
    await ui["command"]("/research open timeline tokenizer");
    expect(last()).toContain("[timeline]");
    await ui["command"]("/research open indexing");
    expect(ui["listPicker"]).not.toBeNull();
    ui["cancelListPicker"]();
    await ui["command"]("/research total 12$");
    expect(ui["rooms"].limits.totalUsd).toBe(12);
    await ui["command"]("/research parallel 5");
    expect(ui["rooms"].limits.maxRunning).toBe(5);
    await ui["command"]("/research parallel 99");
    expect(last()).toContain("1-10");
    await ui["command"]("/research total off");
    expect(ui["rooms"].limits.totalUsd).toBeNull();
    await ui["command"]("/research");
    expect(ui["listPicker"]).not.toBeNull();
    ui["cancelListPicker"]();
    await ui["command"]("/rooms");
    expect(ui["listPicker"]).not.toBeNull();
    ui["cancelListPicker"]();
    ui["drawBar"]();
    expect(completeCandidates("/research show tok")).toContain("/research show Tokenizer speed study");
    expect(completeCandidates("/research open report ind")).toContain("/research open report Indexing recall study");
    expect(completeCandidates("/research show zzz")).toEqual([]);
    expect(completeCandidates("/research o")).toContain("/research open");
  } finally {
    ui.close();
    await r.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
