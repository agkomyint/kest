import {
  BoxRenderable,
  TextRenderable,
  TextareaRenderable,
  ScrollBoxRenderable,
  MarkdownRenderable,
  CodeRenderable,
  SyntaxStyle,
  createCliRenderer,
  createHostClipboard,
  createClipboard,
  createRendererClipboardAdapter,
  type ClipboardService,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
} from "@opentui/core";
import OpenAI from "openai";
import { version } from "../package.json";
import { Agent, systemPrompt, type AgentEvent } from "./agent";
import {
  activeKey,
  loadStore,
  nextKeyName,
  saveActiveKey,
  saveActiveProvider,
  saveKeyCredential,
  saveSelectedModel,
  endpointFor,
  modelProvider,
  MODELS,
  MODAL_BASE_URL,
  MODAL_MODEL,
  BASETEN_BASE_URL,
  BASETEN_MODEL,
  configPath,
  type Credentials,
  type Provider,
  type ProviderKeys,
} from "./config";
import {
  listSessions,
  newSession,
  saveSession,
  type Entry,
  type Session,
} from "./sessions";
import { formatUsage, loadUsage, recordUsage } from "./usage";
import type { Approval } from "./tools";

const theme = {
  bg: "#101214",
  fg: "#e3e5e8",
  muted: "#a0a6b0",
  accent: "#a5d6c5",
};
const clean = (s: string) => s.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
// Kestrel vocabulary for ambient states, Claude-style.
// Confirmations and errors stay plain; only the background chatter plays.
const idleVerbs = [
  "Kesting",
  "Hovering",
  "Scouting",
  "Swooping",
  "Nesting",
  "Circling",
  "Gliding",
  "Perching",
  "Keening",
  "Diving",
];
const workVerb = "Gathering";
const toolVerbs: Record<string, string> = {
  read_file: "Perusing",
  list_files: "Surveying",
  search: "Sniffing",
  edit_file: "Preening",
  write_file: "Weaving",
  shell: "Unleashing",
};
const nestLines = [
  "The nest is warm.",
  "Wings checked. Talons sharp.",
  "The sky is clear. Good hunting.",
  "Perched and listening.",
];
const brief = (s: string, n = 6000) =>
  s.length > n ? s.slice(0, n) + "\n[display truncated]" : s;
function revealText(node: Renderable): Renderable {
  if (node instanceof CodeRenderable) node.drawUnstyledText = true;
  for (const child of node.getChildren()) revealText(child);
  return node;
}
const commands = [
  "/connect",
  "/provider",
  "/model",
  "/usage",
  "/new",
  "/sessions",
  "/resume",
  "/tools",
  "/status",
  "/system",
  "/help",
  "/exit",
];

export class KestUI {
  readonly composer: TextareaRenderable;
  readonly scroll: ScrollBoxRenderable;
  private status: TextRenderable;
  private footer: TextRenderable;
  private secretText: TextRenderable;
  private hints: TextRenderable;
  private activity: TextRenderable;
  private unseenActivity = false;
  private promptBox: BoxRenderable;
  private promptMark: TextRenderable;
  private modelTag: TextRenderable;
  private style: SyntaxStyle;
  private credentials: Credentials | null;
  private keychain: Partial<Record<Provider, ProviderKeys>> = {};
  private connectKeyName: string | null = null;
  private selectedModel: string | null = null;
  private session: Session;
  private agent: Agent;
  private active: AbortController | null = null;
  private pendingText = "";
  private toolNode: TextRenderable | null = null;
  private toolEntry: Entry | null = null;
  private lastTool: {
    entry: Entry;
    node: TextRenderable;
    expanded: boolean;
  } | null = null;
  private toolViews = new WeakMap<
    TextRenderable,
    { entry: Entry; node: TextRenderable; expanded: boolean }
  >();
  private loadingTimer: ReturnType<typeof setInterval> | null = null;
  private loadingLabel = "Kesting…";
  private idleVerb = "Kesting…";
  private connectStep: "id" | "secret" | "key" | null = null;
  private secretValue = "";
  private tokenId = "";
  private listPicker: {
    selected: number;
    rows: TextRenderable[];
    box: BoxRenderable;
    labels: string[];
    values: string[];
    confirm: (value: string) => void;
  } | null = null;
  private approval: { finish: (value: boolean) => void } | null = null;
  private closed = false;
  settled: Promise<void> = Promise.resolve();
  private inputHistory: string[] = [];
  private historyIndex = 0;
  private clipboard: Pick<ClipboardService, "writeText" | "dispose"> | null =
    null;

  constructor(
    readonly renderer: CliRenderer,
    readonly cwd: string,
    credentials: Credentials | null,
    selectedModel: string | null = null,
    keychain: Partial<Record<Provider, ProviderKeys>> = {},
  ) {
    this.credentials = credentials;
    this.selectedModel = selectedModel;
    this.keychain = keychain;
    if (credentials && !this.keychain[credentials.provider]?.keys.length) {
      this.keychain[credentials.provider] = {
        keys: [{ name: "a", credential: credentials }],
        active: "a",
      };
    }
    this.agent = this.makeAgent();
    this.session = newSession(cwd, this.agent.messages);
    this.style = SyntaxStyle.fromStyles(
      {
        default: { fg: theme.fg },
        "markup.heading": { fg: theme.accent, bold: true },
        "markup.strong": { bold: true },
        "markup.raw": { fg: theme.accent },
        "markup.link": { fg: theme.accent, underline: true },
      },
      renderer.nativeScene,
    );
    const root = new BoxRenderable(renderer, {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: theme.bg,
      paddingX: 2,
    });
    this.scroll = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      flexShrink: 1,
      minHeight: 1,
      scrollX: false,
      stickyScroll: true,
      stickyStart: "bottom",
      renderAfter: () => this.syncActivity(),
      contentOptions: { flexDirection: "column", gap: 1, paddingY: 1 },
    });
    this.scroll.verticalScrollBar.visible = false;
    this.scroll.horizontalScrollBar.visible = false;
    this.status = new TextRenderable(renderer, {
      content: "",
      fg: theme.muted,
      height: 1,
      flexShrink: 0,
      wrapMode: "none",
    });
    this.hints = new TextRenderable(renderer, {
      content: "",
      visible: false,
      fg: theme.accent,
      height: 1,
      flexShrink: 0,
    });
    this.promptBox = new BoxRenderable(renderer, {
      border: false,
      height: 5,
      flexShrink: 0,
      flexDirection: "row",
      paddingY: 1,
      backgroundColor: theme.bg,
    });
    this.composer = new TextareaRenderable(renderer, {
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      height: "100%",
      placeholder: "Build, fix, explain…  /help",
      placeholderColor: theme.muted,
      backgroundColor: theme.bg,
      focusedBackgroundColor: theme.bg,
      textColor: theme.fg,
      cursorColor: theme.accent,
      keyBindings: [
        { name: "return", action: "submit" },
        { name: "return", shift: true, action: "newline" },
        { name: "return", ctrl: true, action: "newline" },
      ],
      onSubmit: () => {
        this.settled = this.submit();
      },
      onContentChange: () => this.inputChanged(),
    });
    this.secretText = new TextRenderable(renderer, {
      content: "",
      visible: false,
      fg: theme.accent,
      selectable: false,
    });
    this.promptMark = new TextRenderable(renderer, {
      content: ">",
      width: 2,
      height: 1,
      flexShrink: 0,
      fg: theme.accent,
      selectable: false,
    });
    this.modelTag = new TextRenderable(renderer, {
      content: "",
      visible: false,
      height: 1,
      flexShrink: 0,
      fg: theme.muted,
      selectable: false,
    });
    this.promptBox.add(this.modelTag);
    this.promptBox.add(this.promptMark);
    this.promptBox.add(this.composer);
    this.promptBox.add(this.secretText);
    this.footer = new TextRenderable(renderer, {
      content: cwd,
      fg: theme.muted,
      height: 1,
      flexShrink: 0,
      wrapMode: "none",
    });
    this.activity = new TextRenderable(renderer, {
      content: "↓ New activity · click to jump down",
      visible: false,
      width: "100%",
      height: 1,
      flexShrink: 0,
      textAlign: "center",
      fg: theme.accent,
      selectable: false,
      onMouseDown: (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.jumpToBottom();
      },
    });
    root.add(this.scroll);
    root.add(this.activity);
    root.add(this.status);
    root.add(this.hints);
    root.add(this.promptBox);
    root.add(this.footer);
    renderer.root.add(root);
    renderer.keyInput.on("keypress", (key) => this.key(key));
    renderer.keyInput.on("paste", (event) => {
      if (!this.connectStep) return;
      event.preventDefault();
      event.stopPropagation();
      this.secretValue += new TextDecoder()
        .decode(event.bytes)
        .replace(/[\r\n\x00-\x1f\x7f]/g, "");
      this.drawSecret();
    });
    renderer.on("resize", () => this.inputChanged());
    renderer.on("destroy", () => {
      this.closed = true;
      this.active?.abort();
      this.approval?.finish(false);
      this.stopLoading();
      void this.clipboard?.dispose().catch(() => {});
    });
    this.welcome();
    this.ready();
    this.composer.focus();
  }

  private makeAgent(messages?: Session["messages"]) {
    const agent = new Agent(
      this.cwd,
      (request, signal) => this.ask(request, signal),
      messages,
    );
    agent.modelOverride = this.effectiveModel();
    return agent;
  }
  private activeKeyCredential(provider: Provider): Credentials | null {
    if (this.credentials?.provider === provider) return this.credentials;
    const slot = this.keychain[provider];
    if (!slot || !slot.keys.length) return null;
    return (
      slot.keys.find((k) => k.name === slot.active)?.credential ??
      slot.keys[0]!.credential
    );
  }
  private effectiveModel(): string | null {
    if (!this.selectedModel) return null;
    if (
      this.credentials &&
      modelProvider(this.selectedModel) !== this.credentials.provider
    )
      return null;
    return this.selectedModel;
  }
  private async selectModel(id: string) {
    const option = MODELS.find(
      (m) => m.id.toLowerCase() === id.toLowerCase(),
    );
    if (!option) {
      this.info(
        `Unknown model. Available:\n${MODELS.map((m) => m.id).join("\n")}`,
      );
      return;
    }
    this.selectedModel = option.id;
    try {
      await saveSelectedModel(option.id);
    } catch {
      this.info("Could not save the model choice.");
      return;
    }
    const available = this.activeKeyCredential(option.provider);
    if (available) {
      this.credentials = available;
      try {
        await saveActiveProvider(option.provider);
      } catch {
        /* Env-only credentials stay in memory for this session. */
      }
      this.agent.modelOverride = this.effectiveModel();
      this.ready();
      const key = this.keyNameFor(option.provider);
      this.info(
        `Switched to ${option.id} (${option.provider}${key ? ` key ${key}` : ""}).`,
      );
      return;
    }
    this.agent.modelOverride = this.effectiveModel();
    this.ready();
    this.info(
      `Model set to ${option.id}. To use it, run /connect ${option.provider}.`,
    );
  }
  private openModelPicker() {
    // Only offer models the user can actually run right now.
    const usable = MODELS.filter((m) => this.isConnected(m.provider));
    if (!usable.length) {
      this.info(
        "No providers connected yet. Run /connect baseten or /connect modal first.",
      );
      return;
    }
    const current = this.effectiveModel();
    this.openListPicker(
      "Choose a model",
      usable.map(
        (m) =>
          `${m.provider} — ${m.label}${m.id === current ? " (current)" : ""}`,
      ),
      usable.map((m) => m.id),
      (id) => {
        void this.selectModel(id);
      },
    );
  }
  private welcome() {
    const line = nestLines[Math.floor(Math.random() * nestLines.length)];
    this.display({ role: "info", text: `[k] kest  v${version}\n${line}` });
  }
  private ready() {
    this.status.content = !this.credentials
      ? "/connect to begin"
      : this.credentials.provider === "baseten"
        ? "Baseten ready"
        : "Modal ready";
    if (!this.credentials) {
      this.modelTag.visible = false;
      this.modelTag.content = "";
      return;
    }
    const model =
      this.effectiveModel() ??
      endpointFor(this.credentials).model;
    const short = model.split("/").pop() ?? model;
    const key = this.keyNameFor(this.credentials.provider);
    this.modelTag.content = key
      ? `${this.credentials.provider}:${key} · ${short}  `
      : `${this.credentials.provider} · ${short}  `;
    this.modelTag.visible = true;
  }
  private display(entry: Entry) {
    const block = new BoxRenderable(this.renderer, {
      flexDirection: "row",
      flexShrink: 0,
      width: "100%",
    });
    if (entry.role !== "info")
      block.add(
        new TextRenderable(this.renderer, {
          content:
            entry.role === "you" ? ">" : entry.role === "kest" ? "•" : "TOOL",
          fg: entry.role === "you" ? theme.accent : theme.muted,
          width: entry.role === "tool" ? 5 : 2,
          height: 1,
          flexShrink: 0,
          selectable: false,
        }),
      );
    const node =
      entry.role === "kest"
        ? new MarkdownRenderable(this.renderer, {
            content: clean(entry.text),
            syntaxStyle: this.style,
            fg: theme.fg,
            streaming: false,
            internalBlockMode: "top-level",
            width: "100%",
            flexGrow: 1,
            flexShrink: 1,
            minWidth: 0,
            // Plain code blocks avoid loading language parsers or downloading grammars.
            renderNode: (token, context) =>
              token.type === "code"
                ? new TextRenderable(this.renderer, {
                    content: clean(token.text),
                    fg: theme.accent,
                    wrapMode: "word",
                    width: "100%",
                    selectable: true,
                    selectionBg: theme.accent,
                    selectionFg: theme.bg,
                  })
                : (() => {
                    const block = context.defaultRender();
                    return block ? revealText(block) : undefined;
                  })(),
          })
        : new TextRenderable(this.renderer, {
            content: clean(entry.text),
            fg: entry.role === "tool" ? theme.muted : theme.fg,
            width: "100%",
            flexGrow: 1,
            flexShrink: 1,
            minWidth: 0,
            wrapMode: "word",
            selectable: true,
            selectionBg: theme.accent,
            selectionFg: theme.bg,
          });
    block.add(node);
    if (entry.role === "tool") {
      const tool = { entry, node: node as TextRenderable, expanded: false };
      this.toolViews.set(tool.node, tool);
      this.lastTool = tool;
      this.renderTool(tool);
      let pressed = false;
      let dragged = false;
      tool.node.onMouseDown = (event) => {
        pressed = event.button === 0 && event.y === tool.node.y;
        dragged = false;
      };
      tool.node.onMouseDrag = () => {
        dragged = true;
      };
      tool.node.onMouseUp = (event) => {
        if (pressed && !dragged && event.y === tool.node.y) {
          event.preventDefault();
          event.stopPropagation();
          tool.expanded = !tool.expanded;
          this.lastTool = tool;
          this.renderTool(tool);
        }
        pressed = false;
      };
    }
    this.scroll.add(block);
    const children = this.scroll.getChildren();
    if (children.length > 180 && !this.awayFromBottom())
      children[0]!.destroyRecursively();
    return node;
  }
  private add(role: Entry["role"], text: string) {
    this.markActivity();
    const entry = { role, text };
    this.session.entries.push(entry);
    return { entry, node: this.display(entry) };
  }
  private renderTool(tool: NonNullable<KestUI["lastTool"]>) {
    tool.node.content = clean(
      tool.expanded
        ? `▾ ${tool.entry.text}`
        : `▸ ${tool.entry.text.split("\n")[0] ?? ""}`,
    );
  }
  private info(text: string) {
    this.add("info", text);
  }
  private awayFromBottom() {
    return (
      this.scroll.scrollHeight -
        this.scroll.viewport.height -
        this.scroll.scrollTop >
      1
    );
  }
  private markActivity() {
    if (!this.awayFromBottom()) return;
    this.unseenActivity = true;
    this.scroll.stickyScroll = false;
    this.activity.visible = true;
  }
  private syncActivity() {
    if (!this.activity || this.closed) return;
    if (!this.awayFromBottom()) {
      this.unseenActivity = false;
      this.scroll.stickyScroll = true;
    }
    this.activity.visible = this.unseenActivity;
  }
  private jumpToBottom() {
    this.unseenActivity = false;
    this.activity.visible = false;
    this.scroll.stickyScroll = true;
    this.scroll.scrollTo(this.scroll.scrollHeight);
    const children = this.scroll.getChildren();
    for (const child of children.slice(0, Math.max(0, children.length - 180)))
      child.destroyRecursively();
    if (!this.active && !this.connectStep && !this.listPicker && !this.approval)
      this.composer.focus();
  }
  private inputChanged() {
    if (
      !this.composer ||
      this.closed ||
      this.connectStep ||
      this.listPicker ||
      this.approval
    )
      return;
    const value = this.composer.plainText;
    const rows = value
      .split("\n")
      .reduce(
        (sum, line) =>
          sum +
          Math.max(
            1,
            Math.ceil(line.length / Math.max(10, this.renderer.width - 8)),
          ),
        0,
      );
    this.promptBox.height = Math.min(9, Math.max(5, rows + 2));
    const matches =
      value.startsWith("/") && !value.includes(" ")
        ? commands.filter((c) => c.startsWith(value))
        : [];
    this.hints.visible =
      (matches.length > 0 || value.length > 80) &&
      !this.connectStep &&
      !this.active;
    this.hints.content = matches.length
      ? matches.slice(0, 6).join("   ")
      : `${value.length} chars · ${value.split("\n").length} lines`;
  }

  private key(key: KeyEvent) {
    if (
      !this.connectStep &&
      key.ctrl &&
      (key.name === "y" ||
        (key.name === "c" &&
          Boolean(this.renderer.getSelection()?.getSelectedText())))
    ) {
      key.preventDefault();
      key.stopPropagation();
      void this.copySelected();
      return;
    }
    if (key.name === "c" && key.ctrl) {
      key.preventDefault();
      if (this.active) this.active.abort();
      else this.close();
      return;
    }
    if (key.name === "escape") {
      key.preventDefault();
      if (this.listPicker) {
        this.cancelListPicker();
      } else if (this.connectStep) {
        this.connectStep = null;
        this.connectKeyName = null;
        this.secretValue = this.tokenId = "";
        this.restoreInput();
      } else if (this.approval) this.approval.finish(false);
      else if (this.active) this.active.abort();
      else this.composer.setText("");
      return;
    }
    if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault();
      this.scroll.scrollBy(
        key.name === "pageup"
          ? -Math.max(3, this.renderer.height - 10)
          : Math.max(3, this.renderer.height - 10),
      );
      return;
    }
    if (key.name === "end" && (key.ctrl || !this.composer.plainText)) {
      key.preventDefault();
      this.jumpToBottom();
      return;
    }
    if (this.approval) {
      key.preventDefault();
      if (key.name === "y") this.approval.finish(true);
      else if (key.name === "n") this.approval.finish(false);
      return;
    }
    if (this.listPicker) {
      key.preventDefault();
      key.stopPropagation();
      if (key.name === "return") {
        this.confirmListPicker();
        return;
      }
      if (key.name === "up" || key.name === "down") {
        const n = this.listPicker.values.length;
        this.listPicker.selected =
          (this.listPicker.selected + (key.name === "up" ? n - 1 : 1)) % n;
        this.drawListPicker();
      }
      return;
    }
    if (this.connectStep) {
      key.preventDefault();
      key.stopPropagation();
      if (key.name === "return") {
        this.settled = this.submitSecret();
        return;
      }
      if (key.name === "backspace")
        this.secretValue = Array.from(this.secretValue).slice(0, -1).join("");
      else if (key.ctrl && key.name === "u") this.secretValue = "";
      else if (
        !key.ctrl &&
        !key.meta &&
        key.sequence &&
        !/[\x00-\x1f\x7f]/.test(key.sequence)
      )
        this.secretValue += key.sequence;
      this.drawSecret();
      return;
    }
    if (key.ctrl && key.name === "o" && this.lastTool) {
      key.preventDefault();
      const tool = this.lastTool;
      tool.expanded = !tool.expanded;
      this.renderTool(tool);
      return;
    }
    if (this.active) {
      key.preventDefault();
      return;
    }
    if (key.name === "tab" && this.composer.plainText.startsWith("/")) {
      const match = commands.find((c) => c.startsWith(this.composer.plainText));
      if (match) {
        key.preventDefault();
        this.composer.setText(match);
        this.composer.cursorOffset = match.length;
      }
    }
    if (
      (key.name === "up" || key.name === "down") &&
      !this.composer.plainText.includes("\n")
    ) {
      key.preventDefault();
      this.historyIndex = Math.max(
        0,
        Math.min(
          this.inputHistory.length,
          this.historyIndex + (key.name === "up" ? -1 : 1),
        ),
      );
      const text = this.inputHistory[this.historyIndex] ?? "";
      this.composer.setText(text);
      this.composer.cursorOffset = text.length;
    }
  }

  private async copySelected() {
    const text = this.renderer.getSelection()?.getSelectedText();
    if (!text) {
      this.status.content =
        "Drag across text to select, then Ctrl+C or Ctrl+Y to copy.";
      return;
    }
    try {
      this.clipboard ??= createClipboard({
        host: createHostClipboard(),
        terminal: createRendererClipboardAdapter(this.renderer),
      });
      const result = await this.clipboard.writeText(text, {
        destination: "best-available",
      });
      if (this.closed) return;
      if (result.host.status === "written") {
        this.status.content = `Copied ${text.length} characters.`;
        this.renderer.clearSelection();
      } else if (result.terminal.status === "attempted") {
        this.status.content = "Copy sent to terminal clipboard.";
        this.renderer.clearSelection();
      } else
        this.status.content =
          "Clipboard unavailable. Try Shift+drag and your terminal's Copy command.";
    } catch {
      if (!this.closed)
        this.status.content =
          "Copy failed. Try Shift+drag and your terminal's Copy command.";
    }
  }

  private drawSecret() {
    const keySuffix = this.connectKeyName ? ` · key ${this.connectKeyName}` : "";
    const label =
      this.connectStep === "id"
        ? `Modal token ID${keySuffix}`
        : this.connectStep === "key"
          ? `Baseten API key${keySuffix}`
          : "Modal token secret";
    this.secretText.content = `${label}\n${"•".repeat(Math.min(28, this.secretValue.length))}  ${this.secretValue.length} characters`;
  }
  private describeProvider(provider: Provider) {
    return provider === "baseten"
      ? "baseten — Baseten API key"
      : "modal — Modal token ID + secret";
  }
  private isConnected(provider: Provider) {
    return (
      this.credentials?.provider === provider ||
      (this.keychain[provider]?.keys.length ?? 0) > 0
    );
  }
  private keyNameFor(provider: Provider): string | null {
    const slot = this.keychain[provider];
    if (slot && slot.keys.length) {
      return slot.keys.some((k) => k.name === slot.active)
        ? slot.active
        : slot.keys[0]!.name;
    }
    return this.credentials?.provider === provider ? "a" : null;
  }
  private describeKeys(provider: Provider) {
    const slot = this.keychain[provider];
    if (!slot || !slot.keys.length) return "Keys: none";
    return `Keys: ${slot.keys.map((k) => k.name + (k.name === slot.active ? " (active)" : "")).join(", ")}`;
  }
  private openListPicker(
    title: string,
    labels: string[],
    values: string[],
    confirm: (value: string) => void,
  ) {
    this.composer.setText("");
    this.composer.blur();
    this.composer.visible = false;
    this.hints.visible = false;
    this.promptMark.visible = false;
    this.secretText.visible = false;
    const box = new BoxRenderable(this.renderer, {
      flexDirection: "column",
      flexShrink: 0,
      width: "100%",
    });
    box.add(
      new TextRenderable(this.renderer, {
        content: title,
        fg: theme.accent,
        height: 1,
      }),
    );
    const rows = labels.map((label) => {
      const row = new TextRenderable(this.renderer, {
        content: label,
        fg: theme.fg,
        height: 1,
      });
      box.add(row);
      return row;
    });
    this.listPicker = { selected: 0, rows, box, labels, values, confirm };
    this.scroll.add(box);
    this.drawListPicker();
    this.status.content = "Up/Down choose · Enter continue · Esc cancel";
  }
  private drawListPicker() {
    const picker = this.listPicker;
    if (!picker) return;
    picker.rows.forEach((row, i) => {
      row.content = `${i === picker.selected ? "> " : "  "}${picker.labels[i]!}`;
    });
  }
  private confirmListPicker() {
    const picker = this.listPicker;
    if (!picker) return;
    const value = picker.values[picker.selected]!;
    picker.box.destroyRecursively();
    this.listPicker = null;
    // Back to the composer; the confirmed action hides it again if needed.
    this.restoreInput();
    picker.confirm(value);
  }
  private cancelListPicker() {
    this.listPicker?.box.destroyRecursively();
    this.listPicker = null;
    this.restoreInput();
  }
  private openProviderPicker() {
    const labels = (["baseten", "modal"] as Provider[]).map((provider) => {
      const count = this.keychain[provider]?.keys.length ?? 0;
      const state =
        count > 0
          ? `  (${count} key${count === 1 ? "" : "s"}, connected)`
          : "";
      return `${this.describeProvider(provider)}${state}`;
    });
    this.openListPicker(
      "Choose a provider",
      labels,
      ["baseten", "modal"],
      (value) => this.connect(value as Provider),
    );
  }
  private storeForNames(): {
    version: 1;
    activeProvider: null;
    providers: Partial<Record<Provider, ProviderKeys>>;
    model: null;
  } {
    return {
      version: 1,
      activeProvider: null,
      providers: this.keychain,
      model: null,
    };
  }
  private openKeyPicker(provider: Provider) {
    const slot = this.keychain[provider];
    const active = slot?.active;
    const labels = [
      ...(slot?.keys.map(
        (k) => `Key ${k.name}${k.name === active ? " (active)" : ""}`,
      ) ?? []),
      "+ Add new key",
    ];
    const values = [
      ...(slot?.keys.map((k) => `key:${k.name}`) ?? []),
      "__add__",
    ];
    this.openListPicker(
      `Keys for ${provider} — Enter switches, Enter on the active key replaces it`,
      labels,
      values,
      (value) => {
        if (value === "__add__") {
          this.startKeyEntry(provider, nextKeyName(this.storeForNames(), provider));
          return;
        }
        const name = value.slice("key:".length);
        if (name === active) {
          // Re-entering the active key replaces its value.
          this.startKeyEntry(provider, name);
          return;
        }
        void this.switchKey(provider, name);
      },
    );
  }
  private async switchKey(provider: Provider, name: string) {
    const slot = this.keychain[provider];
    const key = slot?.keys.find((k) => k.name === name);
    if (!key) {
      this.info(`No ${provider} key named "${name}".`);
      return;
    }
    try {
      await saveActiveKey(provider, name);
    } catch {
      /* Env-only keys switch for this session without persisting. */
    }
    slot!.active = name;
    this.credentials = key.credential;
    this.agent.modelOverride = this.effectiveModel();
    this.ready();
    const model = this.effectiveModel();
    this.info(
      model
        ? `Switched to ${provider} key ${name} · ${model}.`
        : `Switched to ${provider} key ${name}. Using the default model.`,
    );
  }
  private connect(provider: Provider = "modal") {
    const names = this.keychain[provider]?.keys.map((k) => k.name) ?? [];
    // With existing keys, pick which one to use; otherwise create the first.
    if (names.length) {
      this.openKeyPicker(provider);
      return;
    }
    this.startKeyEntry(provider, "a");
  }
  private startKeyEntry(provider: Provider, name: string) {
    this.renderer.clearSelection();
    this.connectKeyName = name;
    this.connectStep = provider === "baseten" ? "key" : "id";
    this.secretValue = "";
    this.tokenId = "";
    this.composer.blur();
    this.composer.visible = false;
    this.hints.visible = false;
    this.secretText.visible = true;
    this.promptMark.visible = false;
    this.promptBox.paddingY = 0;
    this.promptBox.height = 4;
    const replacing = this.keychain[provider]?.keys.some((k) => k.name === name);
    this.status.content = replacing
      ? `Replacing ${provider} key ${name}. Enter to save, Esc to keep the old one.`
      : `New ${provider} key ${name}. Saved locally in plaintext. Enter to save.`;
    this.drawSecret();
  }
  private async submitSecret() {
    const value = this.secretValue.trim();
    if (!value) {
      this.status.content = "A value is required. Paste or type your token.";
      return;
    }
    if (this.connectStep === "id") {
      this.tokenId = value;
      this.secretValue = "";
      this.connectStep = "secret";
      this.drawSecret();
      return;
    }
    const name =
      this.connectKeyName ??
      nextKeyName(this.storeForNames(), this.connectStep === "key" ? "baseten" : "modal");
    const next: Credentials =
      this.connectStep === "key"
        ? { provider: "baseten", apiKey: value }
        : {
            provider: "modal",
            tokenId: this.tokenId,
            tokenSecret: value,
          };
    this.connectStep = null;
    this.connectKeyName = null;
    this.tokenId = this.secretValue = "";
    this.restoreInput();
    try {
      const savedName = await saveKeyCredential(next.provider, name, next);
      const slot = this.keychain[next.provider] ?? { keys: [], active: null };
      const existing = slot.keys.findIndex((k) => k.name === savedName);
      if (existing >= 0) slot.keys[existing] = { name: savedName, credential: next };
      else {
        slot.keys.push({ name: savedName, credential: next });
        slot.active = savedName;
      }
      this.keychain[next.provider] = slot;
      this.credentials = next;
      this.agent.modelOverride = this.effectiveModel();
      this.info(
        `${next.provider === "baseten" ? "Baseten" : "Modal"} key ${savedName} saved and active — tucked into the nest.`,
      );
      this.ready();
    } catch {
      this.info(
        "Could not save credentials. Check config directory permissions.",
      );
    }
  }
  private restoreInput() {
    this.secretText.content = "";
    this.secretText.visible = false;
    this.composer.visible = true;
    this.promptMark.visible = true;
    this.promptBox.border = false;
    this.promptBox.paddingY = 1;
    this.inputChanged();
    this.composer.focus();
    this.ready();
  }
  private ask(request: Approval, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || this.closed) return Promise.resolve(false);
    this.stopLoading();
    this.info(`${request.title}\n${brief(request.preview, 32_000)}`);
    this.composer.blur();
    this.composer.visible = false;
    this.secretText.visible = true;
    this.promptMark.visible = false;
    this.promptBox.paddingY = 0;
    this.secretText.content =
      "Approval required · [y] allow  [n] deny\nPgUp/PgDn to inspect · Esc deny";
    this.promptBox.height = 4;
    this.status.content = request.title;
    return new Promise((resolve) => {
      const finish = (value: boolean) => {
        if (!this.approval) return;
        this.approval = null;
        signal.removeEventListener("abort", abort);
        if (!this.closed) {
          this.restoreInput();
          this.composer.blur();
          this.info(value ? "Approved." : "Denied.");
          if (this.active) this.showLoading("Working");
        }
        resolve(value);
      };
      const abort = () => finish(false);
      this.approval = { finish };
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  private event(event: AgentEvent) {
    if (this.closed) return;
    if (event.type === "usage") {
      // Best-effort: a failed usage write must never interrupt a reply.
      void recordUsage(event.model, event.input, event.output).catch(() => {});
      return;
    }
    if (event.type === "status") {
      this.showLoading(event.text === "Working" ? `${workVerb}…` : this.idleVerb);
      return;
    }
    if (event.type === "response") {
      this.pendingText = "";
      return;
    }
    if (event.type === "text") {
      if (!this.pendingText) this.markActivity();
      this.pendingText += event.delta;
      return;
    }
    this.pendingText = "";
    if (event.state === "running") {
      let summary = "";
      try {
        const args = JSON.parse(event.args);
        summary = args.path ?? args.command ?? args.query ?? "";
      } catch {
        /* Show name only. */
      }
      const tool = this.add("tool", `→ ${event.name}  ${brief(summary, 180)}`);
      this.toolNode = tool.node as TextRenderable;
      this.toolEntry = tool.entry;
      const verb = toolVerbs[event.name];
      this.showLoading(verb ? `${event.name} · ${verb}…` : event.name);
    } else {
      if (this.toolNode && this.toolEntry) {
        const title = `${event.state === "error" ? "✕" : "✓"} ${this.toolEntry.text.slice(2)}`;
        this.toolEntry.text = `${title}\n\n${brief(event.output ?? "", 12_000)}`;
        const tool = this.toolViews.get(this.toolNode);
        if (tool) this.renderTool(tool);
      }
      this.toolNode = null;
      this.toolEntry = null;
    }
  }
  private flushResponse() {
    if (this.pendingText && !this.closed) this.add("kest", this.pendingText);
    this.pendingText = "";
  }
  private showLoading(label: string) {
    this.loadingLabel = label;
    if (this.loadingTimer) return;
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let frame = 0;
    const draw = () => {
      if (!this.closed)
        this.status.content = `${frames[frame++ % frames.length]} ${this.loadingLabel}`;
    };
    draw();
    this.loadingTimer = setInterval(draw, 120);
    this.loadingTimer.unref();
  }
  private stopLoading() {
    if (this.loadingTimer) clearInterval(this.loadingTimer);
    this.loadingTimer = null;
  }

  private async submit() {
    if (this.active || this.connectStep || this.listPicker || this.closed)
      return;
    const text = this.composer.plainText.trim();
    if (!text) return;
    this.composer.setText("");
    this.hints.visible = false;
    this.inputHistory.push(text);
    this.historyIndex = this.inputHistory.length;
    try {
      if (text.startsWith("/")) {
        await this.command(text);
        return;
      }
      if (!this.credentials) {
        this.info("Use /connect baseten or /connect modal to add credentials.");
        return;
      }
      this.add("you", text);
      if (this.session.title === "New session")
        this.session.title = text.replace(/\s+/g, " ").slice(0, 70);
      this.active = new AbortController();
      this.composer.blur();
      this.idleVerb = `${idleVerbs[Math.floor(Math.random() * idleVerbs.length)]}…`;
      const start = performance.now();
      await this.agent.run(
        text,
        this.credentials,
        this.active.signal,
        (event) => this.event(event),
      );
      this.stopLoading();
      this.flushResponse();
      this.status.content = `Landed · ${((performance.now() - start) / 1000).toFixed(1)}s`;
    } catch (error) {
      if (this.active?.signal.aborted)
        this.info("Recalled. Completed tool actions are kept.");
      else if (error instanceof OpenAI.APIError)
        this.info(
          `Endpoint error ${error.status ?? "network"}. ${error.status === 401 || error.status === 403 ? "Use /connect to update credentials." : "Try again; /new clears context."}`,
        );
      else
        this.info(
          error instanceof Error ? clean(error.message) : "Action failed.",
        );
    } finally {
      this.stopLoading();
      this.pendingText = "";
      if (this.active) {
        this.active = null;
        this.session.messages = this.agent.messages;
        try {
          await saveSession(this.session);
        } catch {
          if (!this.closed) this.info("Could not save session to disk.");
        }
      }
      if (!this.closed && !this.connectStep && !this.approval)
        this.composer.focus();
    }
  }

  private async command(text: string) {
    const [command, ...rest] = text.split(" ");
    const value = rest.join(" ").trim();
    if (command === "/exit" || command === "/quit") {
      this.close();
      return;
    }
    if (command === "/connect") {
      const arg = value.toLowerCase();
      if (!arg) {
        this.openProviderPicker();
        return;
      }
      if (arg === "modal" || arg === "baseten") {
        this.connect(arg);
        return;
      }
      this.info(
        "Usage: /connect [modal|baseten]\n/connect baseten  Baseten API key\n/connect modal  Modal token ID + secret",
      );
      return;
    }
    if (command === "/model") {
      if (!value) {
        this.openModelPicker();
        return;
      }
      await this.selectModel(value);
      return;
    }
    if (command === "/usage" || command === "/tokens") {
      this.info(formatUsage(await loadUsage()));
      return;
    }
    if (command === "/provider") {
      if (this.credentials) {
        const endpoint = endpointFor(this.credentials);
        const selected = this.effectiveModel();
        this.info(
          `Provider: ${this.credentials.provider}\nModel: ${selected ?? endpoint.model}${selected ? " (selected)" : " (default)"}\n${this.describeKeys(this.credentials.provider)}\n${endpoint.baseURL}`,
        );
      } else {
        this.info(
          `No provider connected.\nbaseten  ${BASETEN_MODEL}\nmodal  ${MODAL_MODEL}\n\n/connect baseten  or  /connect modal`,
        );
      }
      return;
    }
    if (command === "/help") {
      this.info(
        "/connect [modal|baseten]  credentials (provider switcher)\n/provider  current provider and model\n/model  list models and select one\n/usage  token usage by model (this machine)\n/new  fresh session\n/sessions  saved workspace sessions\n/resume <id>  reopen a session\n/tools  available tools\n/status  model and connection\n/system <instructions>  customize agent (new session)\n/exit  quit\n\nEnter send · Shift+Enter or Ctrl+Enter newline · Tab completes commands\nUp/Down prompt history · Mouse wheel or PgUp/PgDn scroll\nEdits and shell commands require y/n approval.",
      );
      return;
    }
    if (command === "/tools") {
      this.info(
        "read_file · list_files · search  → automatic\nedit_file · write_file · shell  → approval required\n\nFiles stay inside this workspace. Credential files are excluded.\nApproved shell commands can access your system; they are not sandboxed.",
      );
      return;
    }
    if (command === "/status") {
      const endpoint = this.credentials
        ? endpointFor(this.credentials)
        : null;
      const selected = this.effectiveModel();
      const model = selected ?? endpoint?.model;
      const log = await loadUsage();
      const totals = Object.values(log).reduce(
        (sum, t) => ({
          input: sum.input + t.input,
          output: sum.output + t.output,
        }),
        { input: 0, output: 0 },
      );
      this.info(
        `${this.credentials ? `${this.credentials.provider === "baseten" ? "Baseten" : "Modal"} credentials loaded; access checked on request` : "Not connected"}\n${model ? `Model: ${model}${selected ? " (selected)" : " (default)"}` : `baseten  ${BASETEN_MODEL}\nmodal  ${MODAL_MODEL}`}\n${endpoint ? `${endpoint.baseURL}\n` : ""}${this.credentials ? `${this.describeKeys(this.credentials.provider)}\n` : ""}Usage (this machine): in ${totals.input.toLocaleString("en-US")} · out ${totals.output.toLocaleString("en-US")} · /usage for details\nWorkspace: ${this.cwd}\nCredentials: ${configPath}\nSession: ${this.session.id}`,
      );
      return;
    }
    if (command === "/sessions" || command === "/resume") {
      const sessions = await listSessions(this.cwd);
      if (command === "/sessions") {
        this.info(
          sessions.length
            ? sessions
                .slice(0, 15)
                .map((s) => `${s.id.slice(0, 8)}  ${s.title}`)
                .join("\n") + "\n\n/resume <id>"
            : "No saved sessions in this workspace yet.",
        );
        return;
      }
      if (!value) {
        this.info("Usage: /resume <session id>");
        return;
      }
      const matches = sessions.filter((s) => s.id.startsWith(value));
      if (matches.length !== 1) {
        this.info("Session not found or ID is ambiguous. Use /sessions.");
        return;
      }
      this.session = matches[0]!;
      this.agent = this.makeAgent(this.session.messages);
      this.clearView();
      for (const entry of this.session.entries.slice(-180)) this.display(entry);
      this.ready();
      return;
    }
    if (command === "/new" || command === "/system") {
      if (command === "/system" && !value) {
        this.info("Usage: /system <instructions>");
        return;
      }
      this.agent = this.makeAgent(
        command === "/system"
          ? [
              {
                role: "system",
                content:
                  systemPrompt(this.cwd) + "\nUser preferences:\n" + value,
              },
            ]
          : undefined,
      );
      this.session = newSession(this.cwd, this.agent.messages);
      this.clearView();
      this.welcome();
      this.ready();
      return;
    }
    this.info("Unknown command. /help");
  }
  private clearView() {
    this.unseenActivity = false;
    this.activity.visible = false;
    this.scroll.stickyScroll = true;
    for (const child of this.scroll.getChildren()) child.destroyRecursively();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.active?.abort();
    this.approval?.finish(false);
    this.secretValue = this.tokenId = "";
    this.stopLoading();
    this.renderer.destroy();
  }
}

export async function start(cwd: string) {
  let credentials: Credentials | null = null;
  let selectedModel: string | null = null;
  let keychain: Partial<Record<Provider, ProviderKeys>> = {};
  try {
    const store = await loadStore();
    selectedModel = store.model;
    keychain = store.providers;
    credentials =
      (store.activeProvider && activeKey(store, store.activeProvider)?.credential) ||
      null;
  } catch {
    /* /connect replaces corrupt config. */
  }
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    backgroundColor: theme.bg,
    targetFps: 30,
    useMouse: true,
    consoleMode: "disabled",
  });
  const ui = new KestUI(
    renderer,
    cwd,
    credentials,
    selectedModel,
    keychain,
  );
  const exit = () => ui.close();
  process.once("SIGTERM", exit);
  try {
    await renderer.closed;
    await ui.settled;
  } finally {
    process.off("SIGTERM", exit);
    ui.close();
  }
}
