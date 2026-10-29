import { responseText } from "./response-text";
import { BrowserSession, browserRequest } from "./browser";
import { toolPanel, toolColors } from "./tool-display";
import { savePermission } from "./config";
import {
  autoApprove,
  parsePermission,
  permissionHelp,
  type Permission,
} from "./permissions";
import { formatToolStats } from "./stats";
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
import { Agent, formatTasks, systemPrompt, type AgentEvent } from "./agent";
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
  allSessions,
  newSession,
  saveSession,
  type Entry,
  type Session,
} from "./sessions";
import { formatUsage, loadUsage, recordUsage, flushUsage } from "./usage";
import type { Approval } from "./tools";
import { theme } from "./theme";
import {
  newCompany,
  formatCompany,
  parseTokenBudget,
  recoverCompany,
} from "./research-company";
import { listWorkerRecords, workerTranscript } from "./research-workers";
import {
  listResearchModels,
  saveResearchModel,
  saveResearchEndpoint,
} from "./research-models";
import { formatContext, describeMessages, type ContextState } from "./context";

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
  browser: "Browsing",
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
  "/context",
  "/research",
  "/agents",
  "/usage",
  "/stats",
  "/stat",
  "/permission",
  "/browser",
  "/goal",
  "/tasks",
  "/new",
  "/sessions",
  "/resume",
  "/tools",
  "/status",
  "/system",
  "/help",
  "/exit",
];

type ToolView = {
  entry: Entry;
  node: TextRenderable;
  expanded: boolean;
  panels: BoxRenderable;
  inputScroll?: ScrollBoxRenderable;
  outputScroll?: ScrollBoxRenderable;
  inputText?: TextRenderable;
  outputText?: TextRenderable;
  lastInput?: string;
  lastOutput?: string;
};

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
  private pastedTexts = new Map<string, string>();
  private pasteSequence = 0;
  private promptMark: TextRenderable;
  private modelTag: TextRenderable;
  private style: SyntaxStyle;
  private credentials: Credentials | null;
  private keychain: Partial<Record<Provider, ProviderKeys>> = {};
  private connectKeyName: string | null = null;
  private selectedModel: string | null = null;
  private session: Session;
  private agent: Agent;
  private browser = new BrowserSession();
  private active: AbortController | null = null;
  private pendingText = "";
  private toolNode: TextRenderable | null = null;
  private toolEntry: Entry | null = null;
  private lastTool: ToolView | null = null;
  private toolViews = new WeakMap<TextRenderable, ToolView>();
  private workerViews = new Map<
    string,
    {
      meta: Extract<AgentEvent, { type: "worker" }>;
      entry: Entry;
      view: ToolView;
      log: string;
      latest: string;
      renderedAt: number;
    }
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
    private permission: Permission = "strict",
  ) {
    // OpenTUI installs one selection listener per scroll box. Transcript rows
    // can each have two independent detail panes (up to 180 retained rows).
    // Keep a finite diagnostic limit appropriate for that legitimate fan-out.
    if (renderer.getMaxListeners() > 0)
      renderer.setMaxListeners(Math.max(renderer.getMaxListeners(), 512));
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
    this.session.context = this.agent.context;
    this.style = SyntaxStyle.fromStyles(
      {
        default: { fg: theme.fg },
        "markup.heading": { fg: theme.accent, bold: true },
        "markup.strong": { fg: theme.model, bold: true },
        "markup.raw": { fg: theme.tool, bg: theme.inlineBg },
        "markup.link": { fg: toolColors.input, underline: true },
        "markup.link.label": { fg: toolColors.input, underline: true },
        "markup.link.url": { fg: toolColors.input, underline: true },
        "markup.list": { fg: theme.accent },
        "markup.italic": { fg: theme.muted, italic: true },
        "markup.quote": { fg: theme.muted, italic: true },
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
      textColor: theme.user,
      cursorColor: theme.accent,
      wrapMode: "word",
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
      fg: theme.user,
      selectable: false,
    });
    this.modelTag = new TextRenderable(renderer, {
      content: "",
      visible: false,
      height: 1,
      flexShrink: 0,
      fg: theme.model,
      selectable: false,
    });
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
    root.add(this.modelTag);
    root.add(this.promptBox);
    root.add(this.footer);
    renderer.root.add(root);
    renderer.keyInput.on("keypress", (key) => this.key(key));
    renderer.keyInput.on("paste", (event) => {
      if (!this.connectStep) {
        const text = new TextDecoder().decode(event.bytes);
        if (text.length < 1000 && text.split("\n").length < 10) return;
        if (!this.composer.focused) return;
        event.preventDefault();
        event.stopPropagation();
        const label = `[Pasted text #${++this.pasteSequence} · ${text.length} chars · ${text.split("\n").length} lines]`;
        this.pastedTexts.set(label, text);
        this.composer.insertText(label);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.secretValue += new TextDecoder()
        .decode(event.bytes)
        .replace(/[\r\n\x00-\x1f\x7f]/g, "");
      this.drawSecret();
    });
    renderer.on("resize", () => {
      this.inputChanged();
      for (const block of this.scroll.getChildren()) {
        for (const child of block.getChildren()) {
          const nodes = [child, ...child.getChildren()];
          for (const node of nodes) {
            const tool = this.toolViews.get(node as TextRenderable);
            if (tool?.expanded) this.renderTool(tool);
          }
        }
      }
    });
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

  private makeAgent(
    messages?: Session["messages"],
    goal: string | null = null,
    context?: ContextState,
  ) {
    const agent = new Agent(
      this.cwd,
      (request, signal) => this.ask(request, signal),
      messages,
      goal,
      this.browser,
      context,
    );
    agent.modelOverride = this.effectiveModel();
    agent.research = this.session?.research ?? null;
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
    const option = MODELS.find((m) => m.id.toLowerCase() === id.toLowerCase());
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
        this.settled = this.selectModel(id);
      },
    );
  }
  private welcome() {
    const line = nestLines[Math.floor(Math.random() * nestLines.length)];
    this.display({ role: "info", text: `[k] kest  v${version}\n${line}` });
  }
  private ready() {
    this.status.fg = theme.muted;
    const goal = this.session.goal
      ? `Goal: ${this.session.goal.length > 40 ? this.session.goal.slice(0, 40) + "…" : this.session.goal}`
      : "";
    const total = this.session.tasks.length;
    const done = this.session.tasks.filter((t) => t.status === "done").length;
    const tasks = total ? `Tasks ${done}/${total}` : "";
    this.status.content = [goal, tasks].filter(Boolean).join(" · ");
    if (!this.credentials) {
      this.modelTag.visible = true;
      this.modelTag.content = "○ /connect";
      return;
    }
    const model = this.effectiveModel() ?? endpointFor(this.credentials).model;
    const short = model.split("/").pop() ?? model;
    const key = this.keyNameFor(this.credentials.provider);
    // This marks configured credentials, not a successful network health check.
    this.modelTag.content = key
      ? `● ${this.credentials.provider}:${key} · ${short}  `
      : `● ${this.credentials.provider} · ${short}  `;
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
          fg:
            entry.role === "you"
              ? theme.user
              : entry.role === "kest"
                ? theme.accent
                : theme.tool,
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
            conceal: true,
            internalBlockMode: "top-level",
            width: "100%",
            flexGrow: 1,
            flexShrink: 1,
            minWidth: 0,
            renderNode: (token, context) => {
              const styled = responseText(this.renderer, token);
              if (styled) return styled;
              const block = context.defaultRender();
              return block ? revealText(block) : undefined;
            },
          })
        : new TextRenderable(this.renderer, {
            content: clean(entry.text),
            fg:
              entry.role === "you"
                ? theme.user
                : entry.role === "tool"
                  ? theme.tool
                  : theme.info,
            width: "100%",
            flexGrow: 1,
            flexShrink: 1,
            minWidth: 0,
            wrapMode: "word",
            selectable: true,
            selectionBg: theme.accent,
            selectionFg: theme.bg,
          });
    const column =
      entry.role === "tool"
        ? new BoxRenderable(this.renderer, {
            width: "100%",
            flexGrow: 1,
            flexShrink: 1,
            minWidth: 0,
            flexDirection: "column",
          })
        : null;
    if (column) {
      column.add(node);
      block.add(column);
    } else block.add(node);
    if (entry.role === "tool") {
      const panels = new BoxRenderable(this.renderer, {
        width: "100%",
        flexDirection: "column",
        gap: 1,
        marginTop: 1,
        visible: false,
      });
      column!.add(panels);
      const tool: ToolView = {
        entry,
        node: node as TextRenderable,
        expanded: false,
        panels,
      };
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
  private add(role: Entry["role"], text: string, detail?: Entry["detail"]) {
    this.markActivity();
    const entry: Entry = { role, text, ...(detail ? { detail } : {}) };
    this.session.entries.push(entry);
    return { entry, node: this.display(entry) };
  }
  private renderTool(tool: ToolView) {
    const heading = clean(tool.entry.text.split("\n")[0] ?? "");
    tool.node.fg = heading.startsWith("✕")
      ? theme.error
      : heading.startsWith("✓")
        ? theme.accent
        : theme.tool;
    tool.node.content = `${tool.expanded ? "▾" : "▸"} ${heading}`;
    tool.panels.visible = tool.expanded && !!tool.entry.detail;
    if (!tool.expanded) {
      if (tool.inputScroll?.focused || tool.outputScroll?.focused)
        this.composer.focus();
      // Hidden panes otherwise keep native buffers and selection subscriptions.
      for (const child of tool.panels.getChildren()) child.destroyRecursively();
      tool.inputScroll = tool.outputScroll = undefined;
      tool.inputText = tool.outputText = undefined;
      tool.lastInput = tool.lastOutput = undefined;
      return;
    }
    const detail = tool.entry.detail;
    if (!detail) {
      tool.node.content = `▾ ${clean(tool.entry.text)}`;
      return;
    }
    if (!tool.inputScroll) {
      const addSection = (
        label: string,
        color: string,
        backgroundColor: string,
      ) => {
        const box = new BoxRenderable(this.renderer, {
          width: "100%",
          flexDirection: "column",
          backgroundColor,
        });
        box.add(
          new TextRenderable(this.renderer, {
            content: label,
            fg: color,
            height: 1,
            paddingLeft: 1,
            selectable: false,
          }),
        );
        const scroll = new ScrollBoxRenderable(this.renderer, {
          width: "100%",
          height: 6,
          flexShrink: 0,
          backgroundColor,
          scrollY: true,
          scrollX: false,
          contentOptions: { paddingLeft: 1, paddingRight: 1 },
          scrollbarOptions: {
            trackOptions: { backgroundColor, foregroundColor: color },
          },
        });
        const text = new TextRenderable(this.renderer, {
          content: "",
          width: "100%",
          wrapMode: "word",
          selectable: true,
          fg: toolColors.text,
          selectionBg: theme.accent,
          selectionFg: theme.bg,
        });
        scroll.add(text);
        box.add(scroll);
        tool.panels.add(box);
        return { scroll, text };
      };
      const input = addSection(
        `↓ Input · ${detail.language}  · scroll to inspect`,
        toolColors.input,
        toolColors.inputBg,
      );
      const output = addSection(
        "↑ Output  · scroll to inspect",
        toolColors.output,
        toolColors.outputBg,
      );
      tool.inputScroll = input.scroll;
      tool.inputText = input.text;
      tool.outputScroll = output.scroll;
      tool.outputText = output.text;
    }
    if (tool.lastInput !== detail.input) {
      tool.inputText!.content = toolPanel(detail.input, detail.language);
      tool.lastInput = detail.input;
    }
    if (tool.lastOutput !== detail.output) {
      tool.outputText!.content = toolPanel(detail.output, "text");
      tool.lastOutput = detail.output;
    }
    const columns = Math.max(8, this.renderer.width - 12);
    const height = (text: string) =>
      Math.min(
        Math.max(2, Math.min(6, Math.floor(this.renderer.height / 5))),
        Math.max(
          1,
          text
            .split("\n")
            .reduce(
              (n, line) =>
                n + Math.max(1, Math.ceil(Bun.stringWidth(line) / columns)),
              0,
            ),
        ),
      );
    tool.inputScroll!.height = height(detail.input);
    tool.outputScroll!.height = height(detail.output);
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
    const panel = this.lastTool?.inputScroll?.focused
      ? this.lastTool.inputScroll
      : this.lastTool?.outputScroll?.focused
        ? this.lastTool.outputScroll
        : null;
    if (panel && !this.approval && !this.connectStep && !this.listPicker) {
      if (key.name === "escape") {
        key.preventDefault();
        key.stopPropagation();
        this.composer.focus();
        return;
      }
      if (
        ["up", "down", "pageup", "pagedown", "home", "end"].includes(key.name)
      ) {
        key.preventDefault();
        key.stopPropagation();
        if (key.name === "home") panel.scrollTo(0);
        else if (key.name === "end") panel.scrollTo(panel.scrollHeight);
        else
          panel.scrollBy(
            (key.name === "up" || key.name === "pageup" ? -1 : 1) *
              (key.name.startsWith("page") ? Math.max(1, panel.height - 1) : 1),
          );
        return;
      }
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
    if (
      key.ctrl &&
      key.shift &&
      (key.name === "i" || key.name === "o") &&
      this.lastTool
    ) {
      key.preventDefault();
      const tool = this.lastTool;
      tool.expanded = true;
      this.renderTool(tool);
      if (key.name === "i") tool.inputScroll?.focus();
      else tool.outputScroll?.focus();
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
    const keySuffix = this.connectKeyName
      ? ` · key ${this.connectKeyName}`
      : "";
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
    const rows = labels.map((label, index) => {
      const row = new TextRenderable(this.renderer, {
        content: label,
        fg: theme.fg,
        height: 1,
        selectable: false,
        onMouseDown: (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (this.listPicker?.box !== box) return;
          this.listPicker.selected = index;
          this.confirmListPicker();
        },
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
      row.fg = i === picker.selected ? theme.user : theme.fg;
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
        count > 0 ? `  (${count} key${count === 1 ? "" : "s"}, connected)` : "";
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
    permission: Permission;
    version: 1;
    activeProvider: null;
    providers: Partial<Record<Provider, ProviderKeys>>;
    model: null;
  } {
    return {
      version: 1,
      permission: this.permission,
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
          this.startKeyEntry(
            provider,
            nextKeyName(this.storeForNames(), provider),
          );
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
    const replacing = this.keychain[provider]?.keys.some(
      (k) => k.name === name,
    );
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
      nextKeyName(
        this.storeForNames(),
        this.connectStep === "key" ? "baseten" : "modal",
      );
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
      if (existing >= 0)
        slot.keys[existing] = { name: savedName, credential: next };
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
    if (autoApprove(this.permission, request)) return Promise.resolve(true);
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

  private workerEvent(event: Extract<AgentEvent, { type: "worker" }>) {
    let worker = this.workerViews.get(event.workerId);
    if (!worker) {
      const added = this.add(
        "tool",
        `→ ${event.role} ${event.workerId.slice(0, 8)} · ${event.model}`,
        {
          input: `Task: ${event.task}\nRole: ${event.role}\nModel: ${event.model}\nParent: ${event.parentId}\nDepth: ${event.depth}\n\nClick this row for live activity. /agents ${event.workerId.slice(0, 8)} inspects its transcript.`,
          output: "Starting…",
          language: "text",
        },
      );
      worker = {
        meta: event,
        entry: added.entry,
        view: this.toolViews.get(added.node as TextRenderable)!,
        log: "",
        latest: "Starting",
        renderedAt: 0,
      };
      this.workerViews.set(event.workerId, worker);
    }
    worker.meta = event;
    const activity = event.event;
    if (activity?.type === "tool") {
      worker.latest = `${activity.name} · ${activity.state}`;
      worker.log += `\n[${activity.state}] ${activity.name}${activity.durationMs === undefined ? "" : ` · ${activity.durationMs.toFixed(1)} ms`}\n${activity.state === "running" ? activity.args : (activity.output ?? "")}\n`;
      if (activity.state !== "running" && activity.durationMs !== undefined)
        (this.session.toolStats ??= []).push({
          name: activity.name,
          durationMs: activity.durationMs,
          error: activity.state === "error",
        });
    } else if (activity?.type === "status") {
      worker.latest = activity.text;
      worker.log += `\n[status] ${activity.text}\n`;
    } else if (activity?.type === "text") worker.log += activity.delta;
    else if (activity?.type === "response") worker.log += "\n[assistant]\n";
    if (event.state !== "running") {
      worker.latest = event.state === "done" ? "Completed" : "Failed";
      worker.log += `\n[${worker.latest}]\n${event.output ?? ""}\n`;
    }
    // Bound the live preview; complete messages are saved with the worker.
    if (worker.log.length > 24000)
      worker.log =
        "[Earlier activity omitted from live preview; see saved transcript]\n" +
        worker.log.slice(-23000);
    worker.entry.text = `${event.state === "done" ? "✓" : event.state === "error" ? "✕" : "→"} ${"  ".repeat(Math.max(0, event.depth - 1))}${event.role} ${event.workerId.slice(0, 8)} · ${event.model} · ${brief(worker.latest, 70)}`;
    worker.entry.detail!.output = worker.log || "Starting…";
    if (
      activity?.type === "text" &&
      performance.now() - worker.renderedAt < 100
    )
      return;
    worker.renderedAt = performance.now();
    if (!worker.view.node.isDestroyed) this.renderTool(worker.view);
  }

  private event(event: AgentEvent) {
    if (this.closed) return;
    if (event.type === "worker") {
      this.workerEvent(event);
      return;
    }
    if (event.type === "checkpoint") {
      this.add(
        "info",
        `Research checkpoint ${event.cycle} · continuing\n${brief(event.text, 6000)}`,
      );
      this.pendingText = "";
      return;
    }
    if (event.type === "usage") {
      // Best-effort: a failed usage write must never interrupt a reply.
      void recordUsage(event.model, event.input, event.output).catch(() => {
        if (!this.closed) this.info("Could not save token usage to disk.");
      });
      return;
    }
    if (event.type === "status") {
      this.showLoading(
        event.text === "Working"
          ? `${workVerb}…`
          : event.text === "Thinking"
            ? this.idleVerb
            : event.text,
      );
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
        summary =
          event.name === "shell" || event.name === "browser"
            ? typeof args.title === "string" && args.title.trim()
              ? args.title.trim().split(/[\r\n]/)[0]
              : event.name === "browser"
                ? `Browser: ${args.action ?? "open"}`
                : "Run Bun script"
            : (args.path ?? args.command ?? args.query ?? args.task ?? "");
      } catch {
        /* Show name only. */
      }
      const heading =
        event.name === "shell" || event.name === "browser"
          ? `→ ${brief(summary, 100)}`
          : `→ ${event.name}  ${brief(summary, 180)}`;
      let input = event.args;
      if (event.name === "shell") {
        try {
          input = JSON.parse(event.args).command ?? event.args;
        } catch {
          /* Keep raw input. */
        }
      }
      const tool = this.add(
        "tool",
        event.name === "shell"
          ? `${heading}\n\nInput\n${brief(input, 12_000)}\n\nOutput\nRunning…`
          : heading,
        {
          input,
          output: "Running…",
          language: event.name === "shell" ? "TypeScript" : "JSON",
        },
      );
      this.toolNode = tool.node as TextRenderable;
      this.toolEntry = tool.entry;
      const verb = toolVerbs[event.name];
      this.showLoading(verb ? `${event.name} · ${verb}…` : event.name);
    } else {
      if (event.durationMs !== undefined) {
        (this.session.toolStats ??= []).push({
          name: event.name,
          durationMs: event.durationMs,
          error: event.state === "error",
        });
      }
      if (this.toolNode && this.toolEntry) {
        const title = `${event.state === "error" ? "✕" : "✓"} ${this.toolEntry.text.split("\n")[0]!.slice(2)}${event.durationMs === undefined ? "" : ` · ${event.durationMs.toFixed(2)} ms`}`;
        let input = event.args;
        if (event.name === "shell") {
          try {
            input = JSON.parse(event.args).command ?? event.args;
          } catch {
            /* Keep raw input. */
          }
        }
        this.toolEntry.text =
          event.name === "shell"
            ? `${title}\n\nInput\n${brief(input, 12_000)}\n\nOutput\n${brief(event.output ?? "", 12_000)}`
            : `${title}\n\n${brief(event.output ?? "", 12_000)}`;
        this.toolEntry.detail = {
          input,
          output: event.output ?? "",
          language: event.name === "shell" ? "TypeScript" : "JSON",
        };
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
    this.status.fg = theme.tool;
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
    const draft = this.composer.plainText;
    const text = draft
      .replace(
        /\[Pasted text #\d+ · \d+ chars · \d+ lines\]/g,
        (label) => this.pastedTexts.get(label) ?? label,
      )
      .trim();
    if (!text) return;
    this.pastedTexts.clear();
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
        this.session.context = this.agent.context;
        this.session.research = this.agent.research ?? undefined;
        this.session.tasks = this.agent.tasks;
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
    if (command === "/agents") {
      const records = this.session.research
        ? await listWorkerRecords(this.cwd, this.session.research.id)
        : [];
      if (!value) {
        const workers = new Map(
          records.map((record) => [
            record.id,
            `${record.id.slice(0, 8)} · ${record.role} · ${record.model} · ${record.state}\n  ${brief(record.task, 140)}`,
          ]),
        );
        for (const [id, worker] of this.workerViews)
          workers.set(
            id,
            `${id.slice(0, 8)} · ${worker.meta.role} · ${worker.meta.model} · ${worker.latest}\n  ${brief(worker.meta.task, 140)}`,
          );
        this.info(
          workers.size
            ? [...workers.values()].join("\n") +
                "\n\n/agents <id> · inspect a worker without leaving the director session. Click its tool row for live output."
            : "No researcher activity in this session yet.",
        );
      } else {
        const ids = [
          ...new Set([
            ...records.map((record) => record.id),
            ...this.workerViews.keys(),
          ]),
        ].filter((id) => id.startsWith(value));
        if (ids.length !== 1) {
          this.info("Worker not found or ID is ambiguous. Use /agents.");
          return;
        }
        const record = records.find((record) => record.id === ids[0]);
        const live = this.workerViews.get(ids[0]!);
        this.info(
          record
            ? brief(workerTranscript(record), 60000)
            : `${live!.entry.detail!.input}\n\n${live!.log}`,
        );
      }
      return;
    }
    if (command === "/exit" || command === "/quit") {
      this.close();
      return;
    }
    if (command === "/research") {
      const [action, ...parts] = value.split(/\s+/);
      if (!value) {
        this.info(formatCompany(this.session.research));
        return;
      }
      if (action === "models") {
        this.info(JSON.stringify(await listResearchModels(), null, 2));
        return;
      }
      if (action === "prepare") {
        const objective = parts.join(" ").trim();
        if (!objective) {
          this.info("/research prepare <objective>");
          return;
        }
        this.session.research = newCompany(objective);
        this.session.goal = objective;
        this.agent = this.makeAgent(
          this.agent.messages,
          objective,
          this.agent.context,
        );
        this.session.messages = this.agent.messages;
        this.session.tasks = [];
        this.agent.research = this.session.research;
        await saveSession(this.session);
        this.info(
          formatCompany(this.session.research) +
            "\nPrepared without model calls. Set /research budget if needed, then /research resume.",
        );
        return;
      }
      if (action === "model") {
        const [alias, provider, model] = parts;
        if (!alias || !provider || !model || parts.length !== 3)
          throw new Error("/research model <alias> <modal|baseten> <model-id>");
        await saveResearchModel(alias, provider, model);
        this.info(
          `Research model ${alias} saved. Workers can select this profile.`,
        );
        return;
      }
      if (action === "endpoint") {
        const [alias, url, model, envName] = parts;
        if (!alias || !url || !model || !envName || parts.length !== 4)
          throw new Error(
            "/research endpoint <alias> <https-base-url> <model-id> <API_KEY_ENV_NAME>",
          );
        await saveResearchEndpoint(alias, url, model, envName);
        this.info(
          `Research endpoint ${alias} saved. Set ${envName} in the environment before starting Kest; do not enter the API key in chat.`,
        );
        return;
      }
      if (action === "off") {
        this.agent.research = null;
        this.session.research = undefined;
        await saveSession(this.session);
        this.info(
          "Research continuation is off. Existing artifacts are preserved.",
        );
        return;
      }
      if (
        action === "tokens" ||
        (action === "budget" && parts[0] === "tokens")
      ) {
        const tokenArgs = action === "budget" ? parts.slice(1) : parts;
        const study = this.session.research;
        if (!study || tokenArgs.length !== 1)
          throw new Error(
            "Prepare a research objective first, then /research tokens <total, e.g. 500k, 10m, 500b|off>.",
          );
        await recoverCompany(this.cwd, study);
        const limit =
          tokenArgs[0] === "off" ? null : parseTokenBudget(tokenArgs[0]!);
        const consumed =
          study.inputTokens + study.outputTokens + study.estimatedTokens;
        if (limit !== null && limit < consumed)
          throw new Error(
            `Token total cannot be below ${consumed.toLocaleString("en-US")} already consumed or estimated.`,
          );
        study.maxTokens = limit;
        study.status = "paused";
        this.agent.research = study;
        await saveSession(this.session);
        this.info(formatCompany(study));
        return;
      }
      if (action === "budget") {
        const minutes = Number(parts[0]),
          requests = Number(parts[1]);
        const agents =
          parts[2] === undefined
            ? this.session.research?.maxAgents
            : Number(parts[2]);
        if (
          !this.session.research ||
          (parts.length !== 2 && parts.length !== 3) ||
          !Number.isInteger(minutes) ||
          minutes < 1 ||
          minutes > 1440 ||
          !Number.isInteger(requests) ||
          requests < 1 ||
          requests > 10000 ||
          requests < this.session.research.requests ||
          !Number.isInteger(agents) ||
          agents! < 1 ||
          agents! > 64 ||
          agents! < this.session.research.agents ||
          minutes * 60000 < this.session.research.elapsedMs
        )
          throw new Error(
            "Start a research objective first, then /research budget <total-minutes 1–1440> <total-requests 1–10000> [total-agents 1–64]. Totals cannot be below usage already consumed.",
          );
        this.session.research.maxMs = minutes * 60000;
        this.session.research.maxRequests = requests;
        this.session.research.maxAgents = agents!;
        this.session.research.status = "paused";
        await saveSession(this.session);
        this.info(formatCompany(this.session.research));
        return;
      }
      if (!this.credentials) {
        this.info("Connect a model provider first with /connect.");
        return;
      }
      if (action === "resume") {
        if (!this.session.research) {
          this.info("No research objective yet. /research <objective>");
          return;
        }
      } else {
        const objective = action === "start" ? parts.join(" ") : value;
        if (!objective.trim()) {
          this.info("/research <objective>");
          return;
        }
        this.session.research = newCompany(objective);
        this.session.tasks = [];
      }
      const study = this.session.research!;
      this.session.goal = study.objective;
      this.agent = this.makeAgent(
        this.agent.messages,
        this.session.goal,
        this.agent.context,
      );
      this.session.messages = this.agent.messages;
      this.agent.research = study;
      this.agent.tasks = this.session.tasks.map((t) => ({ ...t }));
      await saveSession(this.session);
      this.info(
        `Research company started with ${study.maxRequests - study.requests} requests remaining. Experiments still follow /permission; Esc cancels. Logs: research/${study.id}/`,
      );
      this.composer.setText(
        `Research objective: ${study.objective}\nUse the company workflow, preserve reproducible evidence and negative findings, and reserve time for independent review. Persist source, raw logs, results and the paper in research/${study.id}/. Continue within the shared request/time budget; never fabricate results or claim unsupported novelty.`,
      );
      await this.submit();
      return;
    }
    if (command === "/browser") {
      try {
        const request = browserRequest(
          value === "tabs"
            ? { action: "tabs" }
            : value === "close"
              ? { action: "close" }
              : {
                  action: "open",
                  ...(value && value !== "open" ? { url: value } : {}),
                },
        );
        const start = performance.now();
        const output = await this.browser.execute(
          request,
          new AbortController().signal,
        );
        this.add(
          "tool",
          `✓ Browser: ${request.action} · ${(performance.now() - start).toFixed(2)} ms`,
          { input: JSON.stringify(request, null, 2), output, language: "JSON" },
        );
        this.info(
          request.action === "open"
            ? "Browser opened. Kest can control it across messages. /browser tabs · /browser close"
            : output,
        );
      } catch (error) {
        this.info(
          error instanceof Error ? error.message : "Browser action failed.",
        );
      }
      return;
    }
    if (command === "/permission") {
      if (value) {
        try {
          const next = parsePermission(value.toLowerCase());
          await savePermission(next);
          this.permission = next;
        } catch {
          this.info(
            `Could not save permission. Use /permission all|minimal|strict; check config directory access.\n${permissionHelp}`,
          );
          return;
        }
      }
      this.info(`Permission: ${this.permission}\n${permissionHelp}`);
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
    if (command === "/goal") {
      if (!value) {
        this.info(
          this.session.goal
            ? `Goal: ${this.session.goal}`
            : "No goal set. Usage: /goal <objective> · /goal clear",
        );
        return;
      }
      if (value.toLowerCase() === "clear") {
        this.session.goal = null;
        const priorTasks = this.agent.tasks;
        this.agent = this.makeAgent(
          this.agent.messages,
          null,
          this.agent.context,
        );
        this.agent.tasks = priorTasks;
        this.session.messages = this.agent.messages;
        try {
          await saveSession(this.session);
        } catch {
          this.info("Could not save session to disk.");
        }
        this.info("Goal cleared.");
        this.ready();
        return;
      }
      this.session.goal = value;
      const priorTasks = this.agent.tasks;
      this.agent = this.makeAgent(
        this.agent.messages,
        value,
        this.agent.context,
      );
      this.agent.tasks = priorTasks;
      this.session.messages = this.agent.messages;
      try {
        await saveSession(this.session);
      } catch {
        this.info("Goal set, but the session could not be saved to disk.");
        this.ready();
        return;
      }
      this.info(`Goal set: ${value}`);
      this.ready();
      if (!this.credentials) {
        this.info(
          "Connect first: /connect baseten or /connect modal, then send any message to begin.",
        );
        return;
      }
      if (this.session.title === "New session") {
        this.session.title = value.replace(/\s+/g, " ").slice(0, 70);
      }
      // A goal alone does nothing until the agent gets a turn: kick off the
      // first one so planning starts immediately.
      this.composer.setText(
        "Begin. Start with set_plan, then work through the plan.",
      );
      await this.submit();
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
      await flushUsage();
      const sessions = await allSessions(this.session);
      this.info(
        formatUsage(await loadUsage(), {
          sessions: sessions.length,
          workspaces: new Set(sessions.map((s) => s.cwd)).size,
        }),
      );
      return;
    }
    if (command === "/stats" || command === "/stat") {
      const sessions = await allSessions(this.session);
      this.info(
        formatToolStats(
          this.agent.toolDefs(),
          sessions.flatMap((s) =>
            (s.toolStats ?? []).filter(
              (t) =>
                t &&
                typeof t.name === "string" &&
                Number.isFinite(t.durationMs) &&
                t.durationMs >= 0,
            ),
          ),
          {
            sessions: sessions.length,
            workspaces: new Set(sessions.map((s) => s.cwd)).size,
          },
        ),
      );
      return;
    }
    if (command === "/context") {
      if (!value)
        this.info(
          formatContext(
            this.agent.messages,
            this.agent.toolDefs(),
            this.agent.context,
          ),
        );
      else if (value === "summary")
        this.info(
          this.agent.context.summary ||
            "No summary yet. Recent conversation is still in active context.",
        );
      else if (value === "messages")
        this.info(describeMessages(this.agent.messages));
      else if (value === "archive")
        this.info(describeMessages(this.agent.context.archive));
      else if (/^(show|archived) [1-9]\d*$/.test(value)) {
        const [kind, index] = value.split(" ");
        const messages =
          kind === "show" ? this.agent.messages : this.agent.context.archive;
        const message = messages[Number(index) - 1];
        this.info(
          message
            ? brief(JSON.stringify(message, null, 2), 16000)
            : "Message not found. Use /context messages or /context archive.",
        );
      } else if (value === "compact") {
        if (!this.credentials) {
          this.info(
            "Connect a provider first. Summarizing uses that model and counts in /usage.",
          );
          return;
        }
        this.active = new AbortController();
        try {
          const changed = await this.agent.compactContext(
            this.credentials,
            this.active.signal,
            (event) => this.event(event),
            true,
          );
          this.session.messages = this.agent.messages;
          this.session.context = this.agent.context;
          await saveSession(this.session);
          this.info(
            changed
              ? "Context summarized; original messages archived locally. /context summary"
              : "No completed history is eligible for compaction yet.",
          );
        } catch (error) {
          if (!this.closed)
            this.info(
              error instanceof Error
                ? error.message
                : "Context summary failed; original history retained.",
            );
        } finally {
          this.active = null;
          this.stopLoading();
          if (!this.closed) this.ready();
        }
      } else
        this.info(
          "/context · /context summary · /context messages · /context archive · /context show <number> · /context archived <number> · /context compact",
        );
      return;
    }
    if (command === "/tasks") {
      this.info(formatTasks(this.session.tasks));
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
        "Research: /agents [id] inspects live/saved workers · /research tokens <total|off> · /research budget <total-minutes> <total-requests> [total-agents] · /research resume",
      );
      this.info(
        "/connect [modal|baseten]  credentials (provider switcher)\n/provider  current provider and model\n/model  list models and select one\n/research  research company, model profiles and budgets\n/context  context size, memory, archives and compaction\n/usage  all-time token usage and session count (this machine)\n/stats or /stat  all-time tool counts and timings across sessions (ms)\n/permission [all|minimal|strict]  approval level\n/browser [url|tabs|close]  control the visible browser\n/goal <text>|clear  session objective\n/tasks  plan checklist and progress\n/new  fresh session\n/sessions  saved workspace sessions\n/resume <id>  reopen a session\n/tools  available tools\n/status  model and connection\n/system <instructions>  customize agent (new session)\n/exit  quit\n\nEnter send · Shift+Enter or Ctrl+Enter newline · Tab completes commands\nUp/Down prompt history · Mouse wheel or PgUp/PgDn scroll\nEdits and shell commands require y/n approval.",
      );
      return;
    }
    if (command === "/tools") {
      this.info(
        `${this.agent.toolDefs().length} tools available\n` +
          "read_file · list_files · search  → automatic\nedit_file · write_file · shell  → approval required\nset_plan · update_task  → agent plans and tracks its own tasks\nspawn_subagent · research_team  → bounded hierarchical researchers\nlist_models · research_status · research_review  → profiles, budgets and independent review\nbrowser  → visible browser with page and tab control\n\nFiles stay inside this workspace. Credential files are excluded.\nApproved shell commands can access your system; they are not sandboxed.",
      );
      return;
    }
    if (command === "/status") {
      const endpoint = this.credentials ? endpointFor(this.credentials) : null;
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
        `${this.credentials ? `${this.credentials.provider === "baseten" ? "Baseten" : "Modal"} credentials loaded; access checked on request` : "Not connected"}\n${model ? `Model: ${model}${selected ? " (selected)" : " (default)"}` : `baseten  ${BASETEN_MODEL}\nmodal  ${MODAL_MODEL}`}\n${endpoint ? `${endpoint.baseURL}\n` : ""}${this.credentials ? `${this.describeKeys(this.credentials.provider)}\n` : ""}Usage (this machine): in ${totals.input.toLocaleString("en-US")} · out ${totals.output.toLocaleString("en-US")} · /usage for details\nGoal: ${this.session.goal ?? "none — /goal <objective>"}\nWorkspace: ${this.cwd}\nCredentials: ${configPath}\nSession: ${this.session.id}`,
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
      this.agent = this.makeAgent(
        this.session.messages,
        this.session.goal,
        this.session.context,
      );
      this.session.context = this.agent.context;
      this.agent.tasks = this.session.tasks.map((t) => ({ ...t }));
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
      this.agent.research = null;
      this.session.context = this.agent.context;
      this.clearView();
      this.welcome();
      this.ready();
      return;
    }
    this.info("Unknown command. /help");
  }
  private clearView() {
    this.workerViews.clear();
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
    void this.browser.close();
    this.renderer.destroy();
  }
}

export async function start(cwd: string, permission: Permission = "strict") {
  let credentials: Credentials | null = null;
  let selectedModel: string | null = null;
  let keychain: Partial<Record<Provider, ProviderKeys>> = {};
  try {
    const store = await loadStore();
    permission ??= store.permission;
    selectedModel = store.model;
    keychain = store.providers;
    credentials =
      (store.activeProvider &&
        activeKey(store, store.activeProvider)?.credential) ||
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
    permission ?? "strict",
  );
  const exit = () => ui.close();
  process.once("SIGTERM", exit);
  try {
    await renderer.closed;
    await ui.settled;
  } finally {
    process.off("SIGTERM", exit);
    ui.close();
    await ui["browser"].close();
  }
}
