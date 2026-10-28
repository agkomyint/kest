import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { KestUI } from "./ui";
import { MODAL_MODEL } from "./config";

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
  const modalCredential = { provider: "modal", tokenId: "id", tokenSecret: "s" } as const;
  try {
    const testUI = await createTestRenderer({ width: 100, height: 30 });
    const ui = new KestUI(
      testUI.renderer,
      process.cwd(),
      { provider: "baseten", apiKey: "bk" },
      null,
      {
        baseten: {
          keys: [{ name: "a", credential: { provider: "baseten", apiKey: "bk" } }],
          active: "a",
        },
        modal: { keys: [{ name: "a", credential: modalCredential }], active: "a" },
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
  } finally {
    ui.close();
    await testUI.dispose();
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
    const toolNode = ui["lastTool"]!.node;
    await testUI.mockMouse.click(toolNode.x + 2, toolNode.y);
    await testUI.flush();
    expect(testUI.captureCharFrame()).toContain("detailed tool output");
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
