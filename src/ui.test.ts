import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { KestUI } from "./ui";
import { MODAL_MODEL } from "./config";

test("tab completes slash commands and child subcommands with cycling", async () => {
  const testUI = await createTestRenderer({ width: 130, height: 40 });
  const ui = new KestUI(testUI.renderer, process.cwd(), null);
  const tab = () =>
    ui["key"]({
      name: "tab",
      preventDefault: () => {},
      stopPropagation: () => {},
    } as never);
  try {
    ui.composer.setText("/res");
    tab();
    expect(ui.composer.plainText).toBe("/research");
    tab();
    expect(ui.composer.plainText).toBe("/resume");
    tab();
    expect(ui.composer.plainText).toBe("/research");

    ui.composer.setText("/research ");
    ui["inputChanged"]();
    await testUI.renderOnce();
    const hintFrame = testUI.captureCharFrame();
    expect(hintFrame).toContain("/research budget");
    expect(hintFrame).toContain("/research tokens");

    ui.composer.setText("/research b");
    tab();
    expect(ui.composer.plainText).toBe("/research budget ");

    ui.composer.setText("/research m");
    tab();
    expect(ui.composer.plainText).toBe("/research model");
    tab();
    expect(ui.composer.plainText).toBe("/research models");
    tab();
    expect(ui.composer.plainText).toBe("/research model");
  } finally {
    ui.close();
    await testUI.dispose();
  }
});

test("research commands configure models and budgets without starting paid work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kest-company-ui-"));
  const previous = process.env.KEST_CONFIG_DIR;
  process.env.KEST_CONFIG_DIR = directory;
  const testUI = await createTestRenderer({ width: 130, height: 40 });
  const ui = new KestUI(testUI.renderer, process.cwd(), null);
  const command = async (text: string) => {
    ui.composer.setText(text);
    ui.composer.submit();
    await ui.settled;
    return ui["session"].entries.at(-1)?.text ?? "";
  };
  try {
    expect(await command("/research")).toContain("No research run");
    expect(
      await command("/research model critic modal test-review-model"),
    ).toContain("saved");
    expect(await command("/research models")).toContain("test-review-model");
    expect(
      await command(
        "/research endpoint local http://localhost:12345/v1 local-model RESEARCH_LOCAL_KEY",
      ),
    ).toContain("RESEARCH_LOCAL_KEY");
    expect(await command("/research test an algorithm")).toContain(
      "Connect a model provider",
    );
    await command("/goal Old unrelated goal");
    await command("/research prepare New indexing study");
    expect(ui["session"].goal).toBe("New indexing study");
    expect(String(ui["agent"].messages[0]!.content)).not.toContain(
      "User goal:\nOld unrelated goal",
    );
    const { newCompany } = await import("./research-company");
    ui["session"].research = newCompany("Test budget persistence");
    ui["agent"].research = ui["session"].research!;
    await command("/research budget 60");
    expect(ui["agent"].research?.maxMs).toBe(3600000);
    expect(ui["agent"].research?.maxRequests).toBe(Number.MAX_SAFE_INTEGER);
    await command("/research budget 120 32");
    expect(ui["agent"].research?.maxAgents).toBe(32);
    expect(ui["agent"].research?.maxMs).toBe(7200000);
    await command("/research tokens 500b");
    expect(ui["agent"].research?.maxTokens).toBe(500_000_000_000);
    expect(await command("/research")).toContain("500,000,000,000");
    ui["agent"].research!.inputTokens = 100;
    expect(await command("/research tokens 99")).toContain("cannot be below");
    expect(ui["agent"].research?.inputTokens).toBe(100);
    await command("/research tokens off");
    expect(ui["agent"].research?.maxTokens).toBeNull();
    await command("/new");
    expect(ui["agent"].research).toBeNull();
  } finally {
    ui.close();
    await testUI.dispose();
    if (previous === undefined) delete process.env.KEST_CONFIG_DIR;
    else process.env.KEST_CONFIG_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("/context inspects active messages without a provider and does not add model context", async () => {
  const testUI = await createTestRenderer({ width: 125, height: 40 });
  const ui = new KestUI(testUI.renderer, process.cwd(), null);
  const messages = JSON.stringify(ui["agent"].messages);
  async function command(value: string) {
    ui.composer.setText(value);
    ui.composer.submit();
    await ui.settled;
    return ui["session"].entries.at(-1)?.text ?? "";
  }
  try {
    const report = await command("/context");
    expect(report).toContain("Estimated next input");
    expect(report).toContain("local budget");
    expect(report).toContain("Archived locally: 0");
    expect(report).toContain("counts in /usage");
    expect(await command("/context summary")).toContain("No summary yet");
    expect(await command("/context messages")).toContain("1. system");
    expect(await command("/context show 1")).toContain("You are Kest");
    expect(await command("/context archive")).toBe("No messages.");
    expect(await command("/context compact")).toContain(
      "Connect a provider first",
    );
    expect(JSON.stringify(ui["agent"].messages)).toBe(messages);
  } finally {
    ui.close();
    await testUI.dispose();
  }
});

test("/context compact saves memory, /goal preserves it and /new resets it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kest-context-ui-"));
  const previous = process.env.KEST_CONFIG_DIR;
  process.env.KEST_CONFIG_DIR = dir;
  const testUI = await createTestRenderer({ width: 125, height: 40 });
  const ui = new KestUI(testUI.renderer, process.cwd(), {
    provider: "baseten",
    apiKey: "not-used",
  });
  async function command(value: string) {
    ui.composer.setText(value);
    ui.composer.submit();
    await ui.settled;
  }
  try {
    ui["agent"].messages.push(
      { role: "user", content: "Use Bun and keep existing changes" },
      { role: "assistant", content: "Old investigation ".repeat(3000) },
      { role: "user", content: "Next task" },
    );
    ui["agent"].summarizeContext = async () =>
      "Use Bun. Keep user changes. Investigation complete. Next task is unfinished.";
    await command("/context compact");
    expect(ui["agent"].context.compactions).toBe(1);
    const id = ui["session"].id;
    const { listSessions } = await import("./sessions");
    expect(
      (await listSessions(process.cwd()))[0]?.context?.archive.length,
    ).toBeGreaterThan(0);
    await command("/context archived 1");
    expect(ui["session"].entries.at(-1)?.text).toContain("Use Bun");
    ui["credentials"] = null;
    await command("/goal clear");
    expect(ui["agent"].context.compactions).toBe(1);
    await command("/new");
    expect(ui["agent"].context.compactions).toBe(0);
    await command(`/resume ${id}`);
    expect(ui["agent"].context.compactions).toBe(1);
    expect(ui["agent"].context.summary).toContain("Next task");
  } finally {
    ui.close();
    await testUI.dispose();
    if (previous === undefined) delete process.env.KEST_CONFIG_DIR;
    else process.env.KEST_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("bare /connect opens a provider picker with keyboard selection", async () => {
  const testUI = await createTestRenderer({ width: 90, height: 28 });
  const ui = new KestUI(testUI.renderer, process.cwd(), null);
  try {
    await testUI.renderOnce();
    expect(testUI.captureCharFrame()).toContain(process.cwd());
    ui.composer.setText("/connect");
    ui.composer.submit();
    await ui.settled;
    await testUI.renderOnce();
    const picker = testUI.captureCharFrame();
    expect(picker).toContain("Choose a provider");
    expect(picker).toContain("baseten");
    expect(picker).toContain("modal");
    testUI.mockInput.pressArrow("down"); // highlight modal
    await testUI.flush();
    testUI.mockInput.pressEnter();
    await testUI.flush();
    await testUI.renderOnce();
    expect(testUI.captureCharFrame()).toContain("Modal token ID");
    await testUI.mockInput.pasteBracketedText("test-private-token");
    await testUI.renderOnce();
    const frame = testUI.captureCharFrame();
    expect(frame).toContain("18 characters");
    expect(frame).not.toContain("test-private-token");
    testUI.mockInput.pressEscape();
    await Bun.sleep(40); // Escape is ambiguous with terminal escape sequence prefixes.
    await testUI.flush();
    expect(ui.composer.visible).toBe(true);
    expect(ui.composer.plainText).toBe("");
  } finally {
    ui.close();
    await testUI.dispose();
  }
});

test("/connect picker marks connected providers and their key counts", async () => {
  const testUI = await createTestRenderer({ width: 100, height: 30 });
  const ui = new KestUI(testUI.renderer, process.cwd(), {
    provider: "baseten",
    apiKey: "k",
  });
  try {
    ui.composer.setText("/connect");
    ui.composer.submit();
    await ui.settled;
    await testUI.renderOnce();
    const picker = testUI.captureCharFrame();
    expect(picker).toContain("Choose a provider");
    expect(picker).toContain("1 key, connected");
    testUI.mockInput.pressEscape();
    await Bun.sleep(40); // Escape is ambiguous with terminal escape sequence prefixes.
    await testUI.flush();
    expect(ui.composer.visible).toBe(true);
  } finally {
    ui.close();
    await testUI.dispose();
  }
});

test("/connect key picker switches keys and warns on replace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kest-config-"));
  const prev = process.env.KEST_CONFIG_DIR;
  process.env.KEST_CONFIG_DIR = dir;
  try {
    const testUI = await createTestRenderer({ width: 100, height: 30 });
    const ui = new KestUI(
      testUI.renderer,
      process.cwd(),
      { provider: "baseten", apiKey: "first" },
      null,
      {
        baseten: {
          keys: [
            {
              name: "a",
              credential: { provider: "baseten", apiKey: "first" },
            },
            {
              name: "b",
              credential: { provider: "baseten", apiKey: "second" },
            },
          ],
          active: "a",
        },
      },
    );
    try {
      ui.composer.setText("/connect");
      ui.composer.submit();
      await ui.settled;
      await testUI.renderOnce();
      testUI.mockInput.pressEnter(); // baseten is the first provider
      await testUI.flush();
      await testUI.renderOnce();
      expect(testUI.captureCharFrame()).toContain("Keys for baseten");
      testUI.mockInput.pressArrow("down"); // highlight key b
      await testUI.flush();
      testUI.mockInput.pressEnter(); // switch to key b
      await testUI.flush();
      await testUI.renderOnce();
      let frame = testUI.captureCharFrame();
      expect(frame).toContain("Switched to baseten key b");
      expect(ui["credentials"]).toEqual({
        provider: "baseten",
        apiKey: "second",
      });
      ui.composer.setText("/connect");
      ui.composer.submit();
      await ui.settled;
      await testUI.renderOnce();
      testUI.mockInput.pressEnter(); // baseten provider again
      await testUI.flush();
      await testUI.renderOnce();
      testUI.mockInput.pressArrow("down"); // highlight key b (now active)
      await testUI.flush();
      testUI.mockInput.pressEnter(); // replace the active key b
      await testUI.flush();
      await testUI.renderOnce();
      frame = testUI.captureCharFrame();
      expect(frame).toContain("Baseten API key");
      expect(frame).toContain("key b");
      expect(frame).toContain("Replacing baseten key b");
      testUI.mockInput.pressEscape();
      await Bun.sleep(40); // Escape is ambiguous with terminal escape sequence prefixes.
      await testUI.flush();
      expect(ui.composer.visible).toBe(true);
    } finally {
      ui.close();
      await testUI.dispose();
    }
  } finally {
    if (prev === undefined) delete process.env.KEST_CONFIG_DIR;
    else process.env.KEST_CONFIG_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test("/connect baseten prompts for the Baseten API key with masking", async () => {
  const testUI = await createTestRenderer({ width: 90, height: 28 });
  const ui = new KestUI(testUI.renderer, process.cwd(), null);
  try {
    ui.composer.setText("/connect baseten");
    ui.composer.submit();
    await ui.settled;
    await testUI.mockInput.pasteBracketedText("baseten-key-123");
    await testUI.renderOnce();
    const frame = testUI.captureCharFrame();
    expect(frame).toContain("Baseten API key");
    expect(frame).toContain("15 characters");
    expect(frame).not.toContain("baseten-key-123");
    testUI.mockInput.pressEscape();
    await Bun.sleep(40); // Escape is ambiguous with terminal escape sequence prefixes.
    await testUI.flush();
    expect(ui.composer.visible).toBe(true);
  } finally {
    ui.close();
    await testUI.dispose();
  }
});

test("/model lists only models whose provider is connected", async () => {
  const testUI = await createTestRenderer({ width: 100, height: 30 });
  const ui = new KestUI(testUI.renderer, process.cwd(), {
    provider: "baseten",
    apiKey: "k",
  });
  try {
    ui.composer.setText("/model");
    ui.composer.submit();
    await ui.settled;
    await testUI.renderOnce();
    const frame = testUI.captureCharFrame();
    expect(frame).toContain("Choose a model");
    expect(frame).toContain("baseten");
    expect(frame).not.toContain("modal —");
    testUI.mockInput.pressEscape();
    await Bun.sleep(40); // Escape is ambiguous with terminal escape sequence prefixes.
    await testUI.flush();
    expect(ui.composer.visible).toBe(true);
    expect(ui.composer.plainText).toBe("");
  } finally {
    ui.close();
    await testUI.dispose();
  }
});

test("/model with no connected providers explains how to connect", async () => {
  const testUI = await createTestRenderer({ width: 100, height: 30 });
  const ui = new KestUI(testUI.renderer, process.cwd(), null);
  try {
    ui.composer.setText("/model");
    ui.composer.submit();
    await ui.settled;
    await testUI.flush();
    await testUI.renderOnce();
    const frame = testUI.captureCharFrame();
    expect(frame).toContain("No providers connected yet");
    expect(frame).not.toContain("Choose a model");
    expect(ui.composer.visible).toBe(true);
  } finally {
    ui.close();
    await testUI.dispose();
  }
});

test("/model switches providers when both are connected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kest-config-"));
  const prev = process.env.KEST_CONFIG_DIR;
  process.env.KEST_CONFIG_DIR = dir;
  const modalCredential = {
    provider: "modal",
    tokenId: "id",
    tokenSecret: "s",
  } as const;
  try {
    const testUI = await createTestRenderer({ width: 100, height: 30 });
    const ui = new KestUI(
      testUI.renderer,
      process.cwd(),
      { provider: "baseten", apiKey: "bk" },
      null,
      {
        baseten: {
          keys: [
            { name: "a", credential: { provider: "baseten", apiKey: "bk" } },
          ],
          active: "a",
        },
        modal: {
          keys: [{ name: "a", credential: modalCredential }],
          active: "a",
        },
      },
    );
    try {
      ui.composer.setText("/model");
      ui.composer.submit();
      await ui.settled;
      await testUI.renderOnce();
      testUI.mockInput.pressArrow("down"); // highlight modal, second entry
      await testUI.flush();
      testUI.mockInput.pressEnter();
      await ui.settled;
      await testUI.flush();
      await testUI.renderOnce();
      const frame = testUI.captureCharFrame();
      expect(frame).toContain("Switched to");
      expect(frame).toContain(MODAL_MODEL);
      expect(frame).not.toContain("Modal token ID");
      expect(ui["agent"].modelOverride).toBe(MODAL_MODEL);
      expect(ui["credentials"]?.provider).toBe("modal");
    } finally {
      ui.close();
      await testUI.dispose();
    }
  } finally {
    if (prev === undefined) delete process.env.KEST_CONFIG_DIR;
    else process.env.KEST_CONFIG_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test("/model marks the selected model and rejects unknown ids", async () => {
  const testUI = await createTestRenderer({ width: 100, height: 30 });
  const ui = new KestUI(
    testUI.renderer,
    process.cwd(),
    { provider: "baseten", apiKey: "k" },
    "meta-models/muse-spark-open-1026",
  );
  try {
    ui.composer.setText("/model");
    ui.composer.submit();
    await ui.settled;
    await testUI.renderOnce();
    expect(testUI.captureCharFrame()).toContain("(current)");
    testUI.mockInput.pressEscape();
    await Bun.sleep(40); // Escape is ambiguous with terminal escape sequence prefixes.
    await testUI.flush();
    ui.composer.setText("/model no-such-model");
    ui.composer.submit();
    await ui.settled;
    await testUI.flush();
    expect(testUI.captureCharFrame()).toContain("Unknown model");
  } finally {
    ui.close();
    await testUI.dispose();
  }
});

test("/usage shows recorded per-model token totals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kest-usage-"));
  const prev = process.env.KEST_USAGE_FILE;
  process.env.KEST_USAGE_FILE = join(dir, "usage.json");
  try {
    const testUI = await createTestRenderer({ width: 100, height: 30 });
    const ui = new KestUI(testUI.renderer, process.cwd(), null);
    try {
      ui["event"]({
        type: "usage",
        model: "meta-models/muse-spark-open-1026",
        input: 1200,
        output: 340,
      });
      for (let i = 0; i < 50; i++) {
        try {
          await Bun.file(join(dir, "usage.json")).json();
          break;
        } catch {
          await Bun.sleep(50);
        }
      }
      ui.composer.setText("/usage");
      ui.composer.submit();
      await ui.settled;
      await testUI.flush();
      await testUI.renderOnce();
      const frame = testUI.captureCharFrame();
      expect(frame).toContain("meta-models/muse-spark-open-1026");
      expect(frame).toContain("1,200");
      expect(frame).toContain("340");
    } finally {
      ui.close();
      await testUI.dispose();
    }
  } finally {
    if (prev === undefined) delete process.env.KEST_USAGE_FILE;
    else process.env.KEST_USAGE_FILE = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test("input shows the active provider and model tag", async () => {
  const testUI = await createTestRenderer({ width: 100, height: 30 });
  const ui = new KestUI(
    testUI.renderer,
    process.cwd(),
    { provider: "baseten", apiKey: "k" },
    "meta-models/muse-spark-open-1026",
  );
  try {
    await testUI.renderOnce();
    const frame = testUI.captureCharFrame();
    expect(frame).toContain("baseten:a");
    expect(frame).toContain("muse-spark-open-1026");
    expect(frame).toContain("● baseten:a");
    expect(frame).not.toContain("Baseten ready");
    expect(ui["status"].content.chunks.map((c) => c.text).join("")).toBe("");
  } finally {
    ui.close();
    await testUI.dispose();
  }
});

test("provider status uses a small configured indicator instead of a ready banner", async () => {
  const testUI = await createTestRenderer({ width: 100, height: 30 });
  const ui = new KestUI(testUI.renderer, process.cwd(), {
    provider: "modal",
    tokenId: "id",
    tokenSecret: "secret",
  });
  try {
    await testUI.renderOnce();
    expect(testUI.captureCharFrame()).toContain("● modal:a");
    expect(testUI.captureCharFrame()).not.toContain("Modal ready");
    ui["credentials"] = null;
    ui["ready"]();
    await testUI.renderOnce();
    expect(testUI.captureCharFrame()).toContain("○ /connect");
    expect(ui["status"].content.chunks.map((c) => c.text).join("")).toBe("");
  } finally {
    ui.close();
    await testUI.dispose();
  }
});

test("/goal sets, persists, injects, and clears the objective", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kest-config-"));
  const prev = process.env.KEST_CONFIG_DIR;
  process.env.KEST_CONFIG_DIR = dir;
  try {
    const testUI = await createTestRenderer({ width: 100, height: 30 });
    const ui = new KestUI(testUI.renderer, process.cwd(), null);
    try {
      ui.composer.setText("/goal Ship the login flow");
      ui.composer.submit();
      await ui.settled;
      await testUI.flush();
      await testUI.renderOnce();
      let frame = testUI.captureCharFrame();
      expect(frame).toContain("Goal set: Ship the login flow");
      expect(frame).toContain("Connect first");
      expect(ui["session"].goal).toBe("Ship the login flow");
      expect(ui["agent"].messages[0]?.content).toContain("Ship the login flow");
      expect(frame).toContain("Goal:");
      const { listSessions } = await import("./sessions");
      const saved = await listSessions(process.cwd());
      expect(saved[0]?.goal).toBe("Ship the login flow");
      ui.composer.setText("/goal clear");
      ui.composer.submit();
      await ui.settled;
      await testUI.flush();
      await testUI.renderOnce();
      frame = testUI.captureCharFrame();
      expect(frame).toContain("Goal cleared");
      expect(ui["session"].goal).toBeNull();
      expect(ui["agent"].messages[0]?.content).not.toContain(
        "Ship the login flow",
      );
    } finally {
      ui.close();
      await testUI.dispose();
    }
  } finally {
    if (prev === undefined) delete process.env.KEST_CONFIG_DIR;
    else process.env.KEST_CONFIG_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test("/tasks shows the plan checklist and status progress", async () => {
  const testUI = await createTestRenderer({ width: 100, height: 30 });
  const ui = new KestUI(testUI.renderer, process.cwd(), null);
  try {
    ui["session"].tasks = [
      { id: "t1", title: "Read the code", status: "done" },
      { id: "t2", title: "Write the fix", status: "doing" },
    ];
    ui.composer.setText("/tasks");
    ui.composer.submit();
    await ui.settled;
    await testUI.flush();
    await testUI.renderOnce();
    const frame = testUI.captureCharFrame();
    expect(frame).toContain("Tasks 1/2");
    expect(frame).toContain("Read the code");
    expect(frame).toContain("Write the fix");
    ui["ready"]();
    await testUI.renderOnce();
    expect(testUI.captureCharFrame()).toContain("Tasks 1/2");
  } finally {
    ui.close();
    await testUI.dispose();
  }
});

test("long pastes collapse while preserving the full submitted text", async () => {
  const testUI = await createTestRenderer({ width: 60, height: 22 });
  const ui = new KestUI(testUI.renderer, process.cwd(), null);
  try {
    const pasted = "Research evidence and details. ".repeat(100);
    await testUI.mockInput.pasteBracketedText(pasted);
    expect(ui.composer.plainText).toContain("[Pasted text #1");
    expect(ui.composer.plainText.length).toBeLessThan(100);
    expect(ui.composer.wrapMode).toBe("word");
    ui.composer.insertText(" Please review.");
    ui.composer.submit();
    await ui.settled;
    expect(ui["inputHistory"].at(-1)).toBe(pasted + " Please review.");
    expect(ui["pastedTexts"].size).toBe(0);
  } finally {
    ui.close();
    await testUI.dispose();
  }
});

test("many expanded tool panels support legitimate selection listeners and release them on collapse and clear", async () => {
  const testUI = await createTestRenderer({ width: 90, height: 30 });
  const warnings: Error[] = [];
  const onWarning = (warning: Error) => {
    if (warning.name === "MaxListenersExceededWarning") warnings.push(warning);
  };
  process.on("warning", onWarning);
  const ui = new KestUI(testUI.renderer, process.cwd(), null);
  const baseline = testUI.renderer.listenerCount("selection");
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      const tools = Array.from({ length: 12 }, (_, i) => {
        ui["add"]("tool", `✓ Inspect evidence ${i}`, {
          input: "{}",
          output: "Evidence read",
          language: "JSON",
        });
        const tool = ui["lastTool"]!;
        tool.expanded = true;
        ui["renderTool"](tool);
        return tool;
      });
      expect(testUI.renderer.listenerCount("selection")).toBe(baseline + 24);
      for (const tool of tools) {
        tool.expanded = false;
        ui["renderTool"](tool);
      }
      expect(testUI.renderer.listenerCount("selection")).toBe(baseline);
      const reopened = tools[0]!;
      reopened.expanded = true;
      ui["renderTool"](reopened);
      expect(reopened.outputText!.plainText).toContain("Evidence read");
      ui["clearView"]();
      expect(testUI.renderer.listenerCount("selection")).toBe(baseline);
    }
    await testUI.flush();
    expect(warnings).toEqual([]);
  } finally {
    ui.close();
    expect(testUI.renderer.listenerCount("selection")).toBe(0);
    process.off("warning", onWarning);
    await testUI.dispose();
  }
});

test("parallel worker rows stream separate activity without overwriting the director tool", async () => {
  const testUI = await createTestRenderer({ width: 120, height: 40 });
  const ui = new KestUI(testUI.renderer, process.cwd(), null);
  const worker = (workerId: string, model: string) => ({
    type: "worker" as const,
    workerId,
    parentId: "director",
    task: "Inspect research evidence",
    role: "researcher",
    model,
    depth: 1,
    state: "running" as const,
  });
  try {
    ui["event"]({
      type: "tool",
      name: "research_team",
      args: '{"tasks":[]}',
      state: "running",
    });
    const director = ui["toolEntry"];
    ui["event"](worker("aaaaaaaa-1111", "model-a"));
    ui["event"](worker("bbbbbbbb-2222", "model-b"));
    ui["event"]({
      ...worker("aaaaaaaa-1111", "model-a"),
      event: {
        type: "tool",
        name: "read_file",
        args: '{"path":"raw.json"}',
        state: "running",
      },
    });
    ui["event"]({
      ...worker("bbbbbbbb-2222", "model-b"),
      event: { type: "status", text: "Inspecting references" },
    });
    const first = ui["workerViews"].get("aaaaaaaa-1111")!;
    const second = ui["workerViews"].get("bbbbbbbb-2222")!;
    first.view.expanded = true;
    ui["renderTool"](first.view);
    ui["event"]({
      ...worker("aaaaaaaa-1111", "model-a"),
      event: {
        type: "tool",
        name: "read_file",
        args: "{}",
        state: "done",
        output: "Measured evidence",
        durationMs: 12,
      },
    });
    // Hybrid team UI: head row + one row per worker, like normal tools.
    expect(first.entry).not.toBe(second.entry);
    expect(first.entry.detail!.output).toContain("Measured evidence");
    expect(second.entry.detail!.output).not.toContain("Measured evidence");
    const head = ui["teamGroup"]!.view;
    expect(head.entry.text).toContain("Research team");
    await testUI.renderOnce();
    // Collapsed by default: head visible, worker rows hidden.
    expect(testUI.captureCharFrame()).toContain("Research team");
    expect(testUI.captureCharFrame()).not.toContain("aaaaaaaa");
    await testUI.mockMouse.click(head.node.x + 2, head.node.y);
    await testUI.flush();
    // Expanded head: worker rows appear, each with its own activity.
    expect(testUI.captureCharFrame()).toContain("aaaaaaaa");
    expect(ui["toolEntry"]).toBe(director);
    expect(director!.text).toContain("research_team");
    ui["event"]({
      ...worker("bbbbbbbb-2222", "model-b"),
      state: "error",
      output: "Provider unavailable",
    });
    expect(second.entry.text).toContain("✕");
    expect(second.entry.detail!.output).toContain("Failed");
    expect(head.entry.text).toContain("1 failed");
    ui["event"]({
      ...worker("aaaaaaaa-1111", "model-a"),
      state: "done",
      output: "Evidence checked",
    });
    expect(first.entry.text).toContain("✓");
    expect(first.entry.detail!.output).toContain("Completed");
    expect(head.entry.text).toContain("1/2 done");
    ui["event"]({
      type: "tool",
      name: "research_team",
      args: "{}",
      state: "done",
      output: "One returned; one failed",
      durationMs: 50,
    });
    expect(director!.detail!.output).toContain("One returned");
    await ui["command"]("/agents aaaaaaaa");
    expect(ui["session"].entries.at(-1)!.text).toContain("Measured evidence");
    ui["event"]({
      type: "checkpoint",
      cycle: 1,
      text: "Hypothesis rejected; trying the next experiment.",
    });
    expect(ui["session"].entries.at(-1)!.text).toContain("continuing");
    await testUI.renderOnce();
    expect(testUI.captureCharFrame()).toContain("continuing");
  } finally {
    ui.close();
    await testUI.dispose();
  }
});

test("saved worker transcripts can be inspected without replacing the director context", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kest-worker-inspector-"));
  const { newCompany } = await import("./research-company");
  const { saveWorkerRecord } = await import("./research-workers");
  const study = newCompany("Inspect saved researchers");
  const id = crypto.randomUUID();
  await saveWorkerRecord(join(cwd, "research", study.id), {
    id,
    parentId: "director",
    role: "researcher",
    model: "worker-model",
    depth: 1,
    state: "done",
    task: "Check actual evidence",
    messages: [
      { role: "system", content: "Worker-only system instructions" },
      { role: "user", content: "Inspect raw.json" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "read",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"raw.json"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "read", content: "Observed raw result" },
      { role: "assistant", content: "Supported finding only" },
    ],
  });
  const testUI = await createTestRenderer({ width: 100, height: 30 });
  const ui = new KestUI(testUI.renderer, cwd, null);
  ui["session"].research = study;
  const parent = JSON.stringify(ui["agent"].messages);
  try {
    await ui["command"]("/agents");
    expect(ui["session"].entries.at(-1)!.text).toContain(id.slice(0, 8));
    await ui["command"](`/agents ${id.slice(0, 8)}`);
    const transcript = ui["session"].entries.at(-1)!.text;
    expect(transcript).toContain("read_file");
    expect(transcript).toContain("Observed raw result");
    expect(transcript).not.toContain("Worker-only system instructions");
    expect(JSON.stringify(ui["agent"].messages)).toBe(parent);
  } finally {
    ui.close();
    await testUI.dispose();
    await rm(cwd, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 25,
    });
  }
});

test("TUI pastes multiline code and displays command completion", async () => {
  const testUI = await createTestRenderer({ width: 60, height: 22 });
  const ui = new KestUI(testUI.renderer, process.cwd(), null);
  try {
    await testUI.mockInput.pasteBracketedText(
      "function hello() {\n  return 42;\n}",
    );
    expect(ui.composer.plainText).toContain("\n  return 42;");
    ui.composer.setText("/con");
    testUI.mockInput.pressTab();
    await testUI.flush();
    expect(ui.composer.plainText).toBe("/connect");
    testUI.resize(40, 18);
    await testUI.flush();
    expect(ui.composer.visible).toBe(true);
  } finally {
    ui.close();
    await testUI.dispose();
  }
});

test("edit approval shows the diff, requires y, and can be cancelled", async () => {
  const testUI = await createTestRenderer({ width: 90, height: 28 });
  const ui = new KestUI(testUI.renderer, process.cwd(), null);
  try {
    const controller = new AbortController();
    const approval = ui["ask"](
      {
        title: "Edit example.ts",
        preview: "--- before\n+++ after\n-old code\n+new code",
      },
      controller.signal,
    );
    await testUI.renderOnce();
    expect(testUI.captureCharFrame()).toContain("+new code");
    expect(testUI.captureCharFrame()).toContain("Approval required");
    testUI.mockInput.pressKey("y");
    expect(await approval).toBe(true);
    const cancelled = ui["ask"](
      { title: "Run shell command", preview: "echo hello" },
      controller.signal,
    );
    controller.abort();
    expect(await cancelled).toBe(false);
    await testUI.flush();
    expect(ui.composer.visible).toBe(true);
  } finally {
    ui.close();
    await testUI.dispose();
  }
});

test("tool output expands and collapses by click, and Markdown renders", async () => {
  const testUI = await createTestRenderer({ width: 90, height: 28 });
  const ui = new KestUI(testUI.renderer, process.cwd(), null);
  try {
    ui["event"]({
      type: "tool",
      name: "read_file",
      args: '{"path":"example.ts"}',
      state: "running",
    });
    ui["event"]({
      type: "tool",
      name: "read_file",
      args: '{"path":"example.ts"}',
      state: "done",
      output: "detailed tool output",
    });
    await testUI.renderOnce();
    expect(testUI.captureCharFrame()).not.toContain("detailed tool output");
    // Expand group head, then the individual row and its own output panel.
    const toolNode = ui["lastTool"]!.node;
    const head = ui["toolGroup"]!.view.node;
    await testUI.mockMouse.click(head.x + 2, head.y);
    await testUI.flush();
    expect(testUI.captureCharFrame()).toContain("read_file  example.ts");
    await testUI.mockMouse.click(toolNode.x + 2, toolNode.y);
    await testUI.flush();
    expect(testUI.captureCharFrame()).toContain("Output");
    expect(ui["lastTool"]!.entry.detail?.output).toContain(
      "detailed tool output",
    );
    await testUI.mockMouse.drag(
      toolNode.x,
      toolNode.y + 2,
      toolNode.x + 7,
      toolNode.y + 2,
    );
    await testUI.flush();
    expect(ui["lastTool"]!.expanded).toBe(true);
    await testUI.mockMouse.click(toolNode.x + 2, toolNode.y);
    await testUI.flush();
    expect(testUI.captureCharFrame()).not.toContain("detailed tool output");
    ui["event"]({
      type: "text",
      delta: "**Done**\n\n```ts\nconst answer = 42;\n```",
    });
    ui["flushResponse"]();
    await testUI.flush();
    expect(testUI.captureCharFrame()).toContain("const answer = 42;");
  } finally {
    ui.close();
    await testUI.dispose();
  }
});

test("mouse selection copies exactly selected text with Ctrl+C without quitting", async () => {
  const testUI = await createTestRenderer({
    width: 90,
    height: 28,
    exitOnCtrlC: false,
  });
  const ui = new KestUI(testUI.renderer, process.cwd(), null);
  let copied = "";
  ui["clipboard"] = {
    writeText: async (text) => {
      copied = text;
      return {
        host: { status: "written" },
        terminal: { status: "not-attempted", capability: "unknown" },
      };
    },
    dispose: async () => {},
  };
  try {
    await testUI.renderOnce();
    const row = testUI
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => line.includes("[k] kest"));
    await testUI.mockMouse.drag(2, row, 16, row);
    const selected = testUI.renderer.getSelection()?.getSelectedText();
    expect(selected).toContain("kest");
    testUI.mockInput.pressCtrlC();
    await testUI.flush();
    expect(copied).toBe(selected!);
    expect(ui["closed"]).toBe(false);
    expect(testUI.renderer.hasSelection).toBe(false);
    expect(testUI.captureCharFrame()).toContain("Copied");
  } finally {
    ui.close();
    await testUI.dispose();
  }
});

test("Ctrl+C stops background research instead of quitting and reports how to resume", async () => {
  const testUI = await createTestRenderer({
    width: 90,
    height: 28,
    exitOnCtrlC: false,
  });
  const ui = new KestUI(testUI.renderer, process.cwd(), {
    provider: "baseten",
    apiKey: "not-used",
  });
  try {
    const { newCompany } = await import("./research-company");
    const study = newCompany("Ctrl+C study");
    ui["session"].research = study;
    ui["agent"].research = study;
    ui["agent"].runChild = (_task, _expected, _credentials, signal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("Worker cancelled")),
          { once: true },
        );
      });
    await ui["agent"].executeSpawn(
      JSON.stringify({ task: "Long survey", background: true }),
      { provider: "baseten", apiKey: "not-used" },
      new AbortController().signal,
      () => {},
    );
    expect(ui["agent"].hasRunningBackground()).toBe(true);
    testUI.mockInput.pressCtrlC();
    await ui["agent"].waitForBackground();
    await testUI.flush();
    expect(ui["agent"].hasRunningBackground()).toBe(false);
    expect(ui["closed"]).toBe(false);
    expect(testUI.captureCharFrame()).toContain("/research resume");
  } finally {
    ui.close();
    await testUI.dispose();
  }
});

test("Ctrl+Y with no selection explains how to copy", async () => {
  const testUI = await createTestRenderer({ width: 90, height: 28 });
  const ui = new KestUI(testUI.renderer, process.cwd(), null);
  try {
    testUI.mockInput.pressKey("y", { ctrl: true });
    await testUI.flush();
    expect(testUI.captureCharFrame()).toContain("Drag across text");
    expect(ui.composer.plainText).toBe("");
  } finally {
    ui.close();
    await testUI.dispose();
  }
});

test("replies stay hidden while loading and only the completed final reply appears", async () => {
  const testUI = await createTestRenderer({ width: 90, height: 28 });
  const ui = new KestUI(testUI.renderer, process.cwd(), null);
  try {
    ui["event"]({ type: "status", text: "Thinking" });
    ui["event"]({ type: "response" });
    ui["event"]({ type: "text", delta: "Intermediate narration" });
    await testUI.renderOnce();
    expect(testUI.captureCharFrame()).toContain("Kesting");
    expect(testUI.captureCharFrame()).not.toContain("Intermediate narration");
    ui["event"]({ type: "response" });
    ui["event"]({ type: "text", delta: "Completed " });
    ui["event"]({ type: "text", delta: "final reply" });
    await Bun.sleep(150);
    await testUI.flush();
    expect(testUI.captureCharFrame()).not.toContain("Completed final reply");
    ui["stopLoading"]();
    ui["flushResponse"]();
    await Bun.sleep(30);
    await testUI.flush();
    const frame = testUI.captureCharFrame();
    expect(frame).toContain("• Completed final reply");
    expect(frame).not.toContain("Intermediate narration");
    expect(frame).not.toMatch(/[╭╮╰╯│]/);
  } finally {
    ui.close();
    await testUI.dispose();
  }
});

test("new activity preserves reading position and clicking its indicator jumps to the bottom", async () => {
  const testUI = await createTestRenderer({ width: 90, height: 28 });
  const ui = new KestUI(testUI.renderer, process.cwd(), null);
  try {
    expect(ui.scroll.verticalScrollBar.visible).toBe(false);
    expect(ui.scroll.horizontalScrollBar.visible).toBe(false);
    for (let i = 0; i < 35; i++) ui["info"](`History line ${i}`);
    await testUI.flush();
    ui.scroll.scrollTo(0);
    await testUI.flush();
    const readingPosition = ui.scroll.scrollTop;
    expect(ui["awayFromBottom"]()).toBe(true);
    ui["info"]("New tool result below");
    ui["event"]({ type: "text", delta: "Final reply generated below" });
    ui["flushResponse"]();
    await testUI.flush();
    expect(ui.scroll.scrollTop).toBe(readingPosition);
    expect(testUI.captureCharFrame()).toContain("New activity");
    await testUI.mockMouse.click(45, ui["activity"].y);
    await testUI.flush();
    expect(ui["awayFromBottom"]()).toBe(false);
    expect(testUI.captureCharFrame()).toContain("Final reply generated below");
    expect(testUI.captureCharFrame()).not.toContain("New activity");
    ui["info"]("Another result while following");
    await testUI.flush();
    expect(testUI.captureCharFrame()).toContain(
      "Another result while following",
    );
    expect(testUI.captureCharFrame()).not.toContain("New activity");
  } finally {
    ui.close();
    await testUI.dispose();
  }
});

test("sequential tools across model rounds collapse into one group row", async () => {
  const testUI = await createTestRenderer({ width: 120, height: 30 });
  const ui = new KestUI(testUI.renderer, process.cwd(), null);
  try {
    for (const name of ["set_plan", "update_task", "shell"]) {
      ui["event"]({ type: "response" });
      ui["event"]({ type: "tool", name, args: "{}", state: "running" });
      ui["event"]({
        type: "tool",
        name,
        args: "{}",
        state: "done",
        durationMs: 5,
        output: "ok",
      });
    }
    const toolEntries = ui["session"].entries.filter(
      (e) => e.role === "tool",
    );
    // 1 group head + 3 individual rows (rows hidden until head expands).
    expect(toolEntries).toHaveLength(4);
    expect(toolEntries[0]!.text).toContain("Tools (3)");
    await testUI.renderOnce();
    const collapsed = testUI.captureCharFrame();
    expect(collapsed).toContain("Tools (3)");
    expect(collapsed).not.toContain("✓ set_plan");
    const head = ui["toolGroup"]!.view.node;
    await testUI.mockMouse.click(head.x + 2, head.y);
    await testUI.flush();
    expect(testUI.captureCharFrame()).toContain("✓ set_plan");
  } finally {
    ui.close();
    await testUI.dispose();
  }
});

test("tool timing appears on rows and /stats aggregates all saved sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kest-global-stats-ui-"));
  const previousConfig = process.env.KEST_CONFIG_DIR;
  process.env.KEST_CONFIG_DIR = dir;
  const { newSession, saveSession } = await import("./sessions");
  const other = newSession(join(dir, "other-workspace"), []);
  other.toolStats = [{ name: "read_file", durationMs: 10, error: false }];
  await saveSession(other);
  const testUI = await createTestRenderer({ width: 140, height: 35 });
  const ui = new KestUI(testUI.renderer, process.cwd(), null);
  try {
    for (const [durationMs, state] of [
      [12, "done"],
      [28, "error"],
    ] as const) {
      ui["event"]({
        type: "tool",
        name: "read_file",
        args: "{}",
        state: "running",
      });
      ui["event"]({
        type: "tool",
        name: "read_file",
        args: "{}",
        state,
        durationMs,
      });
    }
    await testUI.renderOnce();
    expect(testUI.captureCharFrame()).toContain("Tools (2) · read_file · 40ms");
    ui.composer.setText("/stats");
    ui.composer.submit();
    await ui.settled;
    await testUI.flush();
    await testUI.renderOnce();
    const frame = testUI.captureCharFrame();
    expect(frame).toContain(`${ui["agent"].toolDefs().length} tools available`);
    expect(frame).toContain("3 calls across saved sessions");
    expect(frame).toContain("2 sessions · 2 workspaces");
    expect(frame).toContain(
      "3 calls · 1 errors · total 50.00 ms · avg 16.67 ms · max 28.00 ms",
    );
    expect(ui["session"].toolStats).toHaveLength(2);
    ui.composer.setText("/stat");
    ui.composer.submit();
    await ui.settled;
    expect(ui["session"].entries.at(-1)?.text).toContain(
      "3 calls across saved sessions",
    );
    ui.composer.setText("/usage");
    ui.composer.submit();
    await ui.settled;
    expect(ui["session"].entries.at(-1)?.text).toContain(
      "2 sessions · 2 workspaces",
    );
  } finally {
    ui.close();
    await testUI.dispose();
    if (previousConfig === undefined) delete process.env.KEST_CONFIG_DIR;
    else process.env.KEST_CONFIG_DIR = previousConfig;
    await rm(dir, { recursive: true, force: true });
  }
});

test("/permission saves the selected level and controls approvals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kest-permission-"));
  const previous = process.env.KEST_CONFIG_DIR;
  process.env.KEST_CONFIG_DIR = dir;
  const testUI = await createTestRenderer({ width: 100, height: 30 });
  const ui = new KestUI(testUI.renderer, process.cwd(), null);
  try {
    ui.composer.setText("/permission minimal");
    ui.composer.submit();
    await ui.settled;
    const { loadStore } = await import("./config");
    expect((await loadStore()).permission).toBe("minimal");
    const signal = new AbortController().signal;
    expect(
      await ui["ask"]({ kind: "file", title: "Edit", preview: "" }, signal),
    ).toBe(true);
    const controller = new AbortController();
    const pending = ui["ask"](
      { kind: "script", title: "Script", preview: "" },
      controller.signal,
    );
    expect(ui["approval"]).not.toBeNull();
    controller.abort();
    expect(await pending).toBe(false);
    ui.composer.setText("/permission all");
    ui.composer.submit();
    await ui.settled;
    expect((await loadStore()).permission).toBe("all");
    expect(
      await ui["ask"]({ kind: "script", title: "Script", preview: "" }, signal),
    ).toBe(true);
  } finally {
    ui.close();
    await testUI.dispose();
    if (previous === undefined) delete process.env.KEST_CONFIG_DIR;
    else process.env.KEST_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("shell rows hide code until expanded and display action timing", async () => {
  const testUI = await createTestRenderer({ width: 100, height: 30 });
  const ui = new KestUI(testUI.renderer, process.cwd(), null);
  try {
    const args = JSON.stringify({
      title: "Inspect machine specifications",
      command: "console.log('machine-details')",
    });
    ui["event"]({ type: "tool", name: "shell", args, state: "running" });
    await testUI.renderOnce();
    // Collapsed by default: only the group head shows.
    expect(testUI.captureCharFrame()).toContain("Tools ·");
    expect(testUI.captureCharFrame()).not.toContain(
      "Inspect machine specifications",
    );
    expect(testUI.captureCharFrame()).not.toContain("console.log");
    ui["event"]({
      type: "tool",
      name: "shell",
      args,
      state: "done",
      durationMs: 37.5,
      output: "machine-details",
    });
    await testUI.renderOnce();
    expect(testUI.captureCharFrame()).toContain("· 38ms");
    expect(testUI.captureCharFrame()).not.toContain("machine-details");
    // Expand the group head -> the individual tool row appears.
    const node = ui["lastTool"]!.node;
    const head = ui["toolGroup"]!.view.node;
    await testUI.mockMouse.click(head.x + 2, head.y);
    await testUI.flush();
    expect(testUI.captureCharFrame()).toContain(
      "Inspect machine specifications",
    );
    await testUI.mockMouse.click(node.x + 2, node.y);
    await testUI.flush();
    const frame = testUI.captureCharFrame();
    expect(frame).toContain("Input");
    expect(frame).toContain("console.log('machine-details')");
    expect(frame).toContain("Output");
    expect(frame).toContain("machine-details");
    // The individual row keeps its own panels/detail (old UI behavior).
    expect(frame).toContain("Input · TypeScript");
    expect(ui["lastTool"]!.entry.detail?.input).toBe(
      "console.log('machine-details')",
    );
    expect(ui["lastTool"]!.entry.detail?.output).toContain("machine-details");
    await testUI.mockMouse.click(node.x + 2, node.y);
    await testUI.flush();
    expect(testUI.captureCharFrame()).not.toContain("console.log");
  } finally {
    ui.close();
    await testUI.dispose();
  }
});

test("long tool input and output have independent bounded scroll panels", async () => {
  const testUI = await createTestRenderer({ width: 100, height: 65 });
  const ui = new KestUI(testUI.renderer, process.cwd(), null);
  try {
    const input = Array.from(
      { length: 12 },
      (_, i) => `// input-line-${i}`,
    ).join("\n");
    const output = Array.from(
      { length: 12 },
      (_, i) => `output-line-${i}`,
    ).join("\n");
    const args = JSON.stringify({ title: "Inspect details", command: input });
    ui["event"]({ type: "tool", name: "shell", args, state: "running" });
    ui["event"]({
      type: "tool",
      name: "shell",
      args,
      state: "done",
      output,
      durationMs: 10,
    });
    await testUI.renderOnce();
    const tool = ui["lastTool"]!;
    // Expand group head, then the individual tool row.
    const head = ui["toolGroup"]!.view.node;
    await testUI.mockMouse.click(head.x + 2, head.y);
    await testUI.renderOnce();
    await testUI.flush();
    await testUI.mockMouse.click(tool.node.x + 2, tool.node.y);
    await testUI.flush();
    expect(testUI.captureCharFrame()).not.toContain("Show more");
    expect(testUI.captureCharFrame()).not.toContain("input-line-11");
    expect(testUI.captureCharFrame()).not.toContain("output-line-11");
    expect(tool.inputScroll!.height).toBeLessThanOrEqual(6);
    expect(tool.inputScroll!.verticalScrollBar.visible).toBe(true);
    expect(tool.outputScroll!.verticalScrollBar.visible).toBe(true);
    const outer = ui.scroll.scrollTop;
    await testUI.mockMouse.scroll(
      tool.inputScroll!.x + 2,
      tool.inputScroll!.y + 1,
      "down",
    );
    await testUI.flush();
    expect(tool.inputScroll!.scrollTop).toBeGreaterThan(0);
    expect(tool.outputScroll!.scrollTop).toBe(0);
    expect(ui.scroll.scrollTop).toBe(outer);
    tool.inputScroll!.scrollTo(999);
    await testUI.flush();
    expect(testUI.captureCharFrame()).toContain("input-line-11");
    expect(testUI.captureCharFrame()).not.toContain("output-line-11");
    tool.outputScroll!.scrollTo(999);
    await testUI.flush();
    expect(testUI.captureCharFrame()).toContain("output-line-11");
    tool.inputScroll!.focus();
    expect(tool.inputScroll!.focused).toBe(true);
    testUI.mockInput.pressKey("END");
    await testUI.flush();
    expect(testUI.captureCharFrame()).toContain("input-line-11");
    testUI.mockInput.pressEscape();
    await Bun.sleep(40);
    await testUI.flush();
    expect(ui.composer.focused).toBe(true);
  } finally {
    ui.close();
    await testUI.dispose();
  }
});
