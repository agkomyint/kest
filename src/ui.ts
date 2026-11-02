import { rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { responseText } from "./response-text";
import { tipsFor, type Tip } from "./tips";
import { loadTipsEnabled, saveTipsEnabled } from "./ui-settings";
import { tavilyKey, saveTavilyKey, tavilyConnectionMessage } from "./tavily";
import { lsiKey, saveLsiKey, lsiConnectionMessage, lsiBaseUrl } from "./lsi";
import { BrowserSession, browserRequest } from "./browser";
import {
  toolPanel,
  toolColors,
  actionLabel,
  connectionFailure,
} from "./tool-display";
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
import { Inbox, type FormField, type InboxItem } from "./inbox";
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
  formatModelPricing,
  MODELS,
  MODAL_BASE_URL,
  MODAL_MODEL,
  BASETEN_BASE_URL,
  BASETEN_MODEL,
  NEBIUS_MODEL,
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
  deleteSession,
  loadLocalChat,
} from "./sessions";
import { Room, RoomManager, roomList, roomOrder, statusSymbol, studySpentUsd } from "./rooms";
import { loadCompanyLimits, saveCompanyLimits } from "./company-settings";
import { formatStudyTab, loadStudyArtifacts, studyTabs, type StudyTab } from "./study-view";
import {
  formatUsage,
  formatModelCosts,
  loadUsage,
  recordUsage,
  flushUsage,
} from "./usage";
import type { Approval } from "./tools";
import { theme } from "./theme";
import {
  newCompany,
  formatCompany,
  parseCostBudget,
  proposedFunding,
  recoverCompany,
  researchStatus,
} from "./research-company";
import { listWorkerRecords, workerTranscript } from "./research-workers";
import {
  listResearchModels,
  saveResearchModel,
  saveResearchEndpoint,
} from "./research-models";
import { formatContext, describeMessages, type ContextState } from "./context";
import {
  slashCommands as commands,
  completeCandidates,
  completionHasChildren,
  longestCommonPrefix,
  describeCandidate,
  argumentHint,
  suggestCommand,
  setStudyHints,
} from "./complete";
import {
  budgetHud,
  formatDuration,
  shouldOpenBudgetDecision,
  truncateMiddle,
  compactHud,
} from "./research-hud";

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

type ToolView = {
  callId?: string;
  toolName?: string;
  rawArgs?: string;
  entry: Entry;
  node: TextRenderable;
  block?: BoxRenderable;
  expanded: boolean;
  panels: BoxRenderable;
  inputScroll?: ScrollBoxRenderable;
  outputScroll?: ScrollBoxRenderable;
  inputText?: TextRenderable;
  outputText?: TextRenderable;
  lastInput?: string;
  lastOutput?: string;
};

/** Wrap up: stop new experiments, review, report, then publish to LSI if connected. */
// Commands that only read, so they are safe while a study is running.
const runningSafeCommand =
  /^\/(chat|rooms|help|status|usage|stats|tasks|agents|tools|permission)(\s|$)|^\/research\s+(show|open)(\s|$)/;

/** Fastest path: the study is done, so publish its saved report in one tool call. */
function publishPrompt(study: { id: string; finalReportPath?: string }, domain: string) {
  return `Publish this completed study to LSI now, in as few steps as possible. Read ${study.finalReportPath ?? `research/${study.id}/`} once, then ${domain ? `use domain "${domain}"` : "call lsi_domains and pick the best domain id"}, and call lsi_publish a single time. Summarize the report into the URS: findings as short strings, honest limitations, conclusion, method. For evidence use inline text excerpts (key result tables, numbers, review verdicts copied from research/${study.id}/ files, up to 6000 chars each) when nothing is hosted publicly, or uri for real public links; never invent links. Link it to its question: if the study's objective or report names an LSI question id (LSI-Q-…), claim it with lsi_claim and set answers_question to it; if none is named, find the match with lsi_questions/lsi_novelty, or post the study's question with lsi_post_question and claim it. Add provenance {tool: "kest"}. Then reply with the LSI id and stop. Do not run new experiments.`;
}

/** "stop and publish", "publish it to lsi now", "wrap up and publish" … typed while a study runs. */
export function wantsStopAndPublish(text: string) {
  return /\bpublish\b/i.test(text) && /\b(stop|now|enough|wrap|finish|done|lsi)\b/i.test(text) && !/\b(don't|do not|dont|never)\s+publish\b/i.test(text);
}

function wrapupPrompt(now = false) {
  return (
    (now
      ? "Stop and publish now: do NOT start reviewers, workers or experiments. Write the final report from the evidence that exists, say plainly in limitations that it was not independently reviewed, then call research_complete."
      : "Wrap up now: stop new experiments, run independent review of existing evidence, and write the final report with limitations and the evidence chain. Then call research_complete.") +
    (lsiKey()
      ? " After it succeeds, publish the reviewed findings to LSI with lsi_publish: a short URS summarizing the report, evidence as stable public file links (repository evidence needs a full commit; Kest hashes each linked file so LSI can mark it verified, inline text is never verified), honest limitations, and answers_question set to the LSI question this study answers (claim the question named in the objective first; if none exists, post it with lsi_post_question and claim it). Publishing without answers_question is refused. If publishing fails, report the error instead of retrying blindly."
      : "")
  );
}

export class KestUI {
  readonly composer: TextareaRenderable;
  readonly scroll: ScrollBoxRenderable;
  private status: TextRenderable;
  private footer: TextRenderable;
  private roomTargets: (Room | null)[] = [];
  private toastText = "";
  private toastWarn = false;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private secretText: TextRenderable;
  private hints: TextRenderable;
  private roomBar: TextRenderable;
  private tipRow: BoxRenderable;
  private tipText: TextRenderable;
  private tipPrevious: TextRenderable;
  private tipNext: TextRenderable;
  private tipCounter: TextRenderable;
  private tipClose: TextRenderable;
  private tipsEnabled = loadTipsEnabled();
  private availableTips: Tip[] = [];
  private tipIndex = 0;
  private tipContextKey = "";
  private tipsBlockedByError = false;
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
  // Rooms: the chat plus one room per research study. These accessors always
  // mean the focused room, so single-room code paths keep working unchanged.
  private rooms = new RoomManager();
  private agentRooms = new WeakMap<Agent, Room>();
  private browser = new BrowserSession();
  private get session(): Session {
    // Undefined only while the constructor is still creating the chat room.
    return this.rooms.focused?.session as Session;
  }
  private set session(value: Session) {
    this.rooms.focused!.session = value;
  }
  private get agent(): Agent {
    return this.rooms.focused!.agent;
  }
  private set agent(value: Agent) {
    const room = this.rooms.focused!;
    room.agent = value;
    this.agentRooms.set(value, room);
  }
  private get active(): AbortController | null {
    return this.rooms.focused?.controller ?? null;
  }
  private set active(value: AbortController | null) {
    this.rooms.focused!.controller = value;
  }
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
  private pauseDecisionPending = false;
  private budgetSyncedAt = 0;
  /** Newest worker tool calls, shown on the team head without expanding workers. */
  private teamFeed: string[] = [];
  private teamGroup: {
    entry: Entry;
    node: TextRenderable;
    view: ToolView;
    children: ToolView[];
  } | null = null;
  private toolGroup: {
    entry: Entry;
    node: TextRenderable;
    view: ToolView;
    children: ToolView[];
    count: number;
    failures: number;
    totalMs: number;
    running: number;
    names: string[];
  } | null = null;
  private groupHeads = new Set<ToolView>();
  private activityGroups = new Map<
    string,
    { head: ToolView; children: ToolView[] }
  >();
  private pendingTools: ToolView[] = [];
  private tabCycle: {
    prefix: string;
    candidates: string[];
    index: number;
  } | null = null;
  private menu: { items: string[]; index: number; touched: boolean; value: string } | null = null;
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
    const chatAgent = this.makeAgent();
    const chatSession = newSession(cwd, chatAgent.messages);
    chatSession.context = chatAgent.context;
    const chat = new Room(
      "chat",
      "chat",
      chatSession,
      chatAgent,
      this.browser,
    );
    this.rooms.add(chat);
    this.agentRooms.set(chatAgent, chat);
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
    this.roomBar = new TextRenderable(renderer, {
      content: "",
      visible: false,
      fg: theme.muted,
      height: 1,
      flexShrink: 0,
      wrapMode: "none",
      onMouseDown: (event) => {
        const room = this.roomTargets[event.y - this.roomBar.y];
        if (!room) return;
        event.preventDefault();
        event.stopPropagation();
        if (this.focusRoom(room)) this.composer.focus();
      },
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
    this.tipRow = new BoxRenderable(renderer, {
      width: "100%",
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
    });
    const arrow = (content: string, direction: number) =>
      new TextRenderable(renderer, {
        content,
        width: 3,
        height: 1,
        flexShrink: 0,
        fg: theme.muted,
        textAlign: "center",
        selectable: false,
        onMouseDown: (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.changeTip(direction);
        },
      });
    this.tipPrevious = arrow("‹", -1);
    this.tipNext = arrow("›", 1);
    this.tipText = new TextRenderable(renderer, {
      content: "",
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      height: "100%",
      fg: theme.muted,
      wrapMode: "word",
      selectable: false,
    });
    this.tipCounter = new TextRenderable(renderer, {
      content: "",
      width: 7,
      height: 1,
      flexShrink: 0,
      textAlign: "right",
      fg: theme.muted,
      selectable: false,
    });
    this.tipClose = new TextRenderable(renderer, {
      content: "×",
      width: 3,
      height: 1,
      flexShrink: 0,
      fg: theme.muted,
      textAlign: "center",
      selectable: false,
      onMouseDown: (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.setTips(false);
      },
    });
    this.tipRow.add(this.tipPrevious);
    this.tipRow.add(this.tipText);
    this.tipRow.add(this.tipNext);
    this.tipRow.add(this.tipCounter);
    this.tipRow.add(this.tipClose);
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
    root.add(this.tipRow);
    root.add(this.promptBox);
    root.add(this.roomBar);
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
      this.drawFooter();
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
      this.stopAllRooms();
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
    browser?: BrowserSession,
  ) {
    const agent: Agent = new Agent(
      this.cwd,
      (request, signal) => this.askFor(agent, request, signal),
      messages,
      goal,
      browser ?? this.rooms.focused?.browser ?? this.browser,
      context,
    );
    agent.modelOverride = this.effectiveModel();
    agent.research =
      this.session?.researchEnabled === false
        ? null
        : (this.session?.research ?? null);
    agent.onPrepareResearch = async (objective, opts) => {
      // Never create a second study for an idea that is already prepared: update it.
      await this.loadSavedStudies();
      const words = (t: string) => new Set(t.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
      const similar = (a: string, b: string) => {
        const x = words(a), y = words(b);
        if (!x.size || !y.size) return false;
        let shared = 0;
        for (const w of x) if (y.has(w)) shared++;
        return shared / (x.size + y.size - shared) >= 0.6;
      };
      const unstarted = this.rooms.studies().filter((r) => r.study && r.study.status === "ready" && !r.running && studySpentUsd(r.study) === 0);
      let existing = opts?.studyId
        ? this.rooms.studies().find((r) => r.study && (r.study.id === opts.studyId || r.study.id.startsWith(opts.studyId!)))
        : unstarted.find((r) => similar(r.study!.objective, objective));
      if (opts?.studyId && !existing) return `No prepared study with id "${opts.studyId}". Call research_list for ids, or prepare a new one with an objective.`;
      if (existing && (existing.running || existing.study!.status !== "ready" || studySpentUsd(existing.study) > 0))
        return `Study ${existing.study!.id} already ran or is running, so it cannot be changed here. Prepare a new study with a different objective if the user wants another.`;
      const reused = !!existing;
      let room: Room;
      let session: Session;
      if (existing) {
        room = existing;
        session = existing.session;
      } else {
        session = newSession(this.cwd, []);
        session.research = newCompany(objective);
        session.goal = objective;
        session.title = objective.slice(0, 70);
        if (opts?.budgetUsd !== undefined) {
          session.research.maxCostUsd = opts.budgetUsd;
          session.research.strictBudget = true;
          if (opts.autoPublish) session.research.autoPublish = true;
        }
        await saveSession(session);
        room = this.addStudyRoom(session);
      }
      if (reused) {
        const study = existing!.study!;
        if (opts?.budgetUsd !== undefined) {
          study.maxCostUsd = opts.budgetUsd;
          study.strictBudget = true;
        }
        if (opts?.autoPublish) study.autoPublish = true;
        session.research = study;
        await saveSession(session);
      }
      const studyRef = session.research!.id;
      if (opts?.budgetUsd === undefined) {
        this.toast(reused ? "study already prepared · reused" : "study prepared · Alt+↑↓ to open");
        return `${reused ? "That study was already prepared, so no duplicate was created" : "Prepared a study room"} "${session.title}" (id ${studyRef}). Nothing has run and nothing was spent. To set its budget or start it, call research_prepare again with study_id "${studyRef}" and budget_usd (never a new objective), or tell the user to open it (Alt+Up/Down or Ctrl+K), /research budget 10$, then /research start.`;
      }
      const budget = `$${opts.budgetUsd.toFixed(2)}${opts.autoPublish ? " (auto-publish to LSI)" : ""}`;
      if (!opts.start) {
        this.toast(`study prepared · ${budget} budget`);
        return `Prepared a study room "${session.title}" with a ${budget} total allowance. Nothing has run. The user starts it with /research start.`;
      }
      if (!this.credentials)
        return `Prepared "${session.title}" with a ${budget} allowance but could not start: no model provider is connected. Tell the user to run /connect, then /research start in the study room.`;
      // Run in the background: the chat stays in front, the study shows in the room bar.
      const blocker = this.rooms.startBlocker(room);
      if (blocker) return `Prepared "${session.title}" with a ${budget} allowance but did not start it: ${blocker} The user can start it later from its room with /research start.`;
      void this.runStudyInBackground(room);
      return `Prepared "${session.title}" with a ${budget} total allowance and started it in the background in its own room. The screen stays on this chat. Tell the user briefly that it is running (strict budget: it will conclude and publish within the allowance, no extra funding) and that they can keep chatting or prepare another idea; do not repeat the setup steps.`;
    };
    agent.onStartPrepared = async () => this.startAllPrepared();
    agent.onListResearch = async () => this.listStudies();
    agent.onDeleteResearch = async (id) => this.deleteStudy(id);
    agent.onNotifyControl = (kind, title, body) => {
      const room = this.agentRooms.get(agent);
      if (!room?.study) return "Not inside a study; nothing posted.";
      this.inbox.notify(room.study.id, room.title, kind, title, body);
      return "Posted to the control inbox. Keep working; there is no reply.";
    };
    agent.onAskControl = async (title, rawFields, signal) => {
      const room = this.agentRooms.get(agent);
      if (!room?.study) throw new Error("ask_control only works inside a study.");
      const fields = this.parseFormFields(rawFields);
      room.question = `form: ${title}`;
      this.drawBar();
      try {
        return (await this.inbox.ask(room.study.id, room.title, title, fields, signal)).text;
      } finally {
        if (room.question?.startsWith("form: ")) room.question = null;
        if (!this.closed) this.drawBar();
      }
    };
    agent.inboxState = () => {
      const read = this.inbox.items.filter((i) => i.kind === "form" && i.status === "read");
      return read.length ? (read.some((i) => i.draft) ? "send" : "draft") : "none";
    };
    agent.onInboxDraft = (id, answers) => {
      const item = this.inbox.setDraft(id, answers);
      const miss = this.inbox.missing(item);
      return `Draft for #${id} (NOT sent):\n${this.inbox.describeAnswers(item)}\n${miss.length ? `Still unanswered: ${miss.join(", ")}.` : "Complete. Show it to the user and wait for them to say send."}`;
    };
    agent.onInboxSend = (id) => {
      const item = this.inbox.get(id);
      if (!item || item.kind !== "form") throw new Error(`No form #${id}.`);
      if (item.status !== "read") throw new Error(`Form #${id} is ${item.status}; it can only be sent while it is read and open.`);
      const miss = this.inbox.missing(item);
      if (miss.length) throw new Error(`Still unanswered: ${miss.join(", ")}.`);
      return {
        preview: `${item.studyTitle}: ${item.title}\n${this.inbox.describeAnswers(item)}`,
        send: () => {
          try {
            this.inbox.send(id);
            return `Sent to ${item.studyTitle}. It continues with these answers.`;
          } catch (error) {
            return error instanceof Error ? error.message : "Could not send.";
          }
        },
      };
    };
    agent.onBackground = () => {
      const room = this.agentRooms.get(agent);
      if (room) void this.wakeFromBackground(room);
    };
    return agent;
  }

  private openSession(session: Session) {
    this.session = session;
    this.agent = this.makeAgent(
      session.messages,
      session.goal,
      session.context,
    );
    session.context = this.agent.context;
    this.agent.tasks = session.tasks.map((task) => ({ ...task }));
    this.renderEntries(session);
    this.ready();
  }

  private renderEntries(session: Session) {
    this.clearView();
    let legacyGroup: string | undefined;
    for (const entry of session.entries.slice(-180)) {
      // Older saved groups had no membership metadata. Reconstruct it without
      // dropping their original action labels, outputs, or timings.
      if (
        entry.role === "tool" &&
        /^[✓✕→] Tools(?: \(| ·|$)/.test(entry.text) &&
        !entry.activityGroup
      )
        entry.activityGroup = crypto.randomUUID();
      if (entry.activityGroup) legacyGroup = entry.activityGroup;
      else if (entry.role !== "tool") legacyGroup = undefined;
      else if (legacyGroup && !entry.parentActivityGroup)
        entry.parentActivityGroup = legacyGroup;
      this.display(entry);
    }
  }

  private async prepareResearch(objective: string) {
    // Each study is its own room with a fresh session, agent and browser. The
    // chat and any other studies keep their state (and keep running).
    const session = newSession(this.cwd, []);
    session.research = newCompany(objective);
    session.goal = objective;
    session.title = objective.slice(0, 70);
    await saveSession(session);
    return this.openStudy(session);
  }

  /** Open a study session as a room (or focus its room) and make it current. */
  private openStudy(session: Session): Room | null {
    const room = this.rooms.get(session.id) ?? this.addStudyRoom(session);
    return this.focusRoom(room) ? room : null;
  }

  /** Add saved, unfinished studies as paused rooms. Idempotent. */
  private async loadSavedStudies(): Promise<Room[]> {
    const added: Room[] = [];
    const seen = new Set(this.rooms.studies().map((room) => room.study?.id));
    for (const saved of await listSessions(this.cwd)) {
      const study = saved.research;
      if (!study || study.status === "completed" || seen.has(study.id)) continue;
      if (this.rooms.get(saved.id)) continue;
      seen.add(study.id);
      await recoverCompany(this.cwd, study);
      if (study.status === "running") study.status = "paused";
      added.push(this.addStudyRoom(saved));
      if (this.rooms.studies().length >= 8) break;
    }
    return added;
  }

  /** Reopening Kest in a folder continues that folder's main chat instead of starting blank. */
  async restoreLastChat() {
    if (this.closed || this.rooms.focused?.kind !== "chat") return;
    if (this.session.messages.some((m) => m.role === "user")) return;
    const saved =
      (await loadLocalChat(this.cwd)) ??
      (await listSessions(this.cwd)).find((s) => !s.research && s.messages.some((m) => m.role === "user"));
    if (!saved || this.closed) return;
    this.openSession(saved);
    this.info(`Continued your last chat in this folder: ${saved.title.slice(0, 60)}. /new starts a fresh one.`);
  }

  async showSavedResearchHint() {
    Object.assign(this.rooms.limits, await loadCompanyLimits());
    await this.loadSavedStudies();
    const saved = (await listSessions(this.cwd)).filter(
      (session) => session.research,
    );
    if (!saved.length || this.closed) return;
    const latest = saved[0]!;
    const state = latest.research!;
    const status =
      latest.researchEnabled === false
        ? "off"
        : state.status === "running"
          ? "paused (previous session)"
          : researchStatus(state);
    this.info(
      saved.length === 1
        ? `Saved research · ${status}\n${state.objective.slice(0, 100)}\n/research show to inspect · /resume ${latest.id.slice(0, 8)} to open`
        : `${saved.length} saved research studies in this workspace · /research show to inspect and choose`,
    );
  }

  private async restoreResearch() {
    if (this.rooms.focused?.kind === "study") return true;
    await this.loadSavedStudies();
    const open = this.rooms
      .studies()
      .filter((room) => room.study?.status !== "completed");
    if (open.length > 1) {
      this.info(
        "Multiple saved research studies. Use /research show, or Ctrl+K to switch rooms, before updating a budget or continuing.",
      );
      return false;
    }
    const room = open[0];
    if (!room) return true;
    if (!this.focusRoom(room)) return false;
    this.info(
      `Restored saved research: ${room.study!.objective}. Progress and spending preserved.`,
    );
    return true;
  }

  // Ctrl+C / Esc: stop the active turn and any background work with it.
  // During a research run this is a PAUSE: state flips to paused, the
  // session is saved, and a decision sheet opens once the turn unwinds.
  private stopActiveWork() {
    const study =
      this.agent.research ??
      (this.session.researchEnabled === false
        ? undefined
        : this.session.research);
    if (study && this.active) {
      if (study.status !== "ready") study.status = "paused";
      this.session.research = study;
      this.pauseDecisionPending = true;
      void saveSession(this.session).catch(() => {});
    }
    this.agent.cancelBackground();
    this.active?.abort();
  }

  private stoppedMessage(): string {
    const study =
      this.agent.research ??
      (this.session.researchEnabled === false
        ? undefined
        : this.session.research);
    return study
      ? `Research paused · progress checkpointed in research/${study.id}/ · choose below or /research resume.`
      : "Stopped. Completed tool actions are kept.";
  }

  // Live HUD: snapshot elapsed + local clock since last budget sync.
  private compactHudText(): string {
    const study = this.agent.research ?? this.session.research;
    if (!study) return "";
    if (this.session.researchEnabled === false) return "Research off · /research show";
    return compactHud(study);
  }

  private liveHud(): string {
    const study = this.agent.research ?? this.session.research;
    if (!study) return "";
    if (this.session.researchEnabled === false)
      return "Research off · /research show";
    const live =
      this.active && this.budgetSyncedAt
        ? study.elapsedMs + (performance.now() - this.budgetSyncedAt)
        : study.elapsedMs;
    return budgetHud(study, live);
  }

  // Budget reached: one yes/no. Yes adds the proposed funding and resumes;
  // no wraps up and publishes what exists to LSI.
  private async answerFunding(yes: boolean) {
    const study = this.session.research;
    if (!study || this.closed) return;
    const current = study.maxCostUsd ?? 0;
    const { additional, total } = proposedFunding(current);
    if (yes) {
      study.maxCostUsd = total;
      study.status = "running";
      void saveSession(this.session).catch(() => {});
      this.info(`Budget raised by $${additional.toFixed(2)} to $${total.toFixed(2)}. Resuming.`);
      this.composer.setText(
        "Resume the research from the last checkpoint. Continue within budget; do not repeat completed work.",
      );
      this.settled = this.submit();
      return;
    }
    // A spent budget cannot fund even the closing model calls: grant a small, disclosed wrap-up reserve.
    const spent = (study.spentCostMicros + study.estimatedCostMicros) / 1_000_000;
    const reserve = Math.min(0.5, Math.max(0.1, Math.round(current * 0.02 * 100) / 100));
    if (current - spent < reserve) {
      study.maxCostUsd = Math.round((spent + reserve) * 100) / 100;
      this.info(`No extra funding. A $${reserve.toFixed(2)} wrap-up reserve is allowed just to write the report and publish.`);
    }
    study.status = "paused";
    void saveSession(this.session).catch(() => {});
    await this.command("/research wrapup now");
  }

  // Decision sheet after a research pause: resume, extend, wrap up, stay.
  private openPauseDecision() {
    const study = this.session.research;
    if (!study || this.closed || this.listPicker) return;
    if (study.strictBudget && study.status === "budget_exhausted") {
      void this.strictConclude(this.rooms.focused!);
      return;
    }
    if (study.status === "budget_exhausted") {
      const { additional, total } = proposedFunding(study.maxCostUsd ?? 0);
      this.info(`Budget reached · ${this.liveHud()}`);
      this.openListPicker(
        `? Add $${additional.toFixed(2)} (total $${total.toFixed(2)}) and continue?`,
        ["Yes — add funds and continue", "No — wrap up and publish to LSI"],
        ["yes", "no"],
        (value) => {
          this.settled = this.answerFunding(value === "yes");
        },
      );
      return;
    }
    const over = shouldOpenBudgetDecision(study);
    this.info(
      `⏸ Research paused at checkpoint · ${this.liveHud()}${over ? " · budget watch/critical" : ""}`,
    );
    this.openListPicker(
      "? Research paused — direction?",
      [
        "Resume research",
        "Change research dollar budget",
        "Wrap up: review + final report now",
        "Stay paused (resume later with /research resume)",
      ],
      ["resume", "extend", "wrapup", "stay"],
      (value) => {
        if (value === "stay" || !this.session.research) {
          this.ready();
          return;
        }
        if (value === "extend") {
          this.restoreInput();
          this.composer.setText("/research budget ");
          this.composer.focus();
          this.info(
            "Enter a new total USD allowance, e.g. /research budget set 15$, or top up with /research budget add 5$. Nothing has been increased.",
          );
          return;
        }
        study.status = "running";
        void saveSession(this.session).catch(() => {});
        this.composer.setText(
          value === "wrapup"
            ? wrapupPrompt()
            : "Resume the research from the last checkpoint. Continue within budget; do not repeat completed work.",
        );
        this.settled = this.submit();
      },
    );
  }

  /** Start a prepared study in its own room without focusing it. */
  private async runStudyInBackground(room: Room) {
    const study = room.session.research;
    if (!study || !this.credentials || room.controller) return;
    try {
      await recoverCompany(this.cwd, study);
      room.session.goal = study.objective;
      room.session.researchEnabled = true;
      room.agent.research = study;
      room.agent.publishNow = false;
      room.agent.wrappingUp = false;
      await saveSession(room.session);
      this.toast(`study started in background · $${(study.maxCostUsd ?? 0).toFixed(2)} strict budget`);
      const strict = study.strictBudget
        ? "\nSTRICT BUDGET: the allowance is final. Never propose or request extra funding. Plan to finish inside it and conclude with research_complete (limitations and unanswered questions stated honestly) even if the result is partial."
        : "";
      await this.runTurn(
        room,
        `Research objective: ${study.objective}\nUse the research company workflow. Save reproducible evidence in research/${study.id}/. Check research_status for the shared allowance. Reserve funding for independent review; call research_complete only with a reviewed report.${strict}${lsiKey() ? " Publish the reviewed findings to LSI with lsi_publish when complete, answering the LSI question named in the objective." : ""}`,
      );
    } catch (error) {
      room.buffer.push({ type: "note", text: this.errorText(error) });
    }
  }

  /** Prepared studies waiting for a free run slot (filled by start-all). */
  private startQueue: Room[] = [];

  /** Notices and forms from studies. UI state only: the chat model sees an item only after the user reads it. */
  private inbox = (() => {
    const inbox = new Inbox();
    inbox.onChange = () => {
      if (!this.closed) this.drawBar();
    };
    inbox.onEvent = (item, what) => this.inboxNotice(item, what);
    return inbox;
  })();
  private notifiedStates = new Set<string>();

  private chatRoom() {
    return this.rooms.list().find((room) => room.kind === "chat");
  }

  /** A one-line card in the main chat's transcript. Never added to the model's messages. */
  private inboxNotice(item: InboxItem, what: "added" | "answered" | "expired") {
    const chat = this.chatRoom();
    if (!chat || this.closed) return;
    const minutes = Math.max(1, Math.round(this.inbox.timeoutMs / 60_000));
    const text =
      what === "answered"
        ? `✓ #${item.id} answers sent to ${item.studyTitle}; it continues.`
        : what === "expired"
          ? `⏱ #${item.id} no reply in ${minutes} min: the ${item.studyTitle} director decided and continued.`
          : item.kind === "form"
            ? `▲ #${item.id} ${item.studyTitle} asks: ${item.title} · ${item.fields.length} question(s) · reply within ${minutes} min or the director decides · /inbox read ${item.id}`
            : `${item.kind === "done" ? "✓" : item.kind === "blocked" ? "!" : "•"} #${item.id} ${item.studyTitle}: ${item.title}${item.body ? ` · ${item.body.replace(/\s+/g, " ").slice(0, 120)}` : ""} · /inbox read ${item.id}`;
    if (this.rooms.focused === chat) this.info(text);
    else chat.session.entries.push({ role: "info", text });
    this.drawBar();
  }

  private inboxLine(item: InboxItem) {
    const mark = item.status === "new" ? "●" : item.status === "read" ? "○" : item.status === "answered" ? "✓" : item.status === "expired" ? "⏱" : "–";
    return `${mark} #${item.id} [${item.kind}] ${item.studyTitle}: ${item.title} (${item.status}${item.draft && item.status === "read" ? ", draft ready" : ""})`;
  }

  /** What the chat model is told when the user reads an item. This is the only way inbox content reaches it. */
  private inboxContext(item: InboxItem) {
    if (item.kind !== "form")
      return `[Control inbox #${item.id}, ${item.kind} from study "${item.studyTitle}"] ${item.title}${item.body ? `\n${item.body}` : ""}\nThe user read this and may give you direction about it.`;
    const fields = item.fields
      .map((f) => `- ${f.id} (${f.type}${f.options ? `: ${f.options.join(" | ")}` : ""}${f.default !== undefined ? `; default ${f.default}` : ""}) ${f.label}${f.why ? ` — ${f.why}` : ""}`)
      .join("\n");
    return `[Control inbox #${item.id}, form from study "${item.studyTitle}"] ${item.title}\n${fields}\nThe study is waiting; if there is no answer in ${Math.max(1, Math.round(this.inbox.timeoutMs / 60_000))} minutes its director decides alone. The user will now give you direction in their own words. Draft answers with inbox_draft and show them. Do not send anything until the user tells you to; sending asks them to confirm.`;
  }

  private async inboxCommand(value: string) {
    const [action = "list", rest = ""] = [value.trim().split(/\s+/)[0] ?? "", value.trim().split(/\s+/).slice(1).join(" ")];
    const num = Number(rest.split(/\s+/)[0]?.replace("#", ""));
    const item = Number.isInteger(num) ? this.inbox.get(num) : undefined;
    const need = () => {
      if (!item) this.info(`Give an inbox number, for example /inbox ${action || "read"} 1. /inbox lists them.`);
      return item;
    };
    if (!action || action === "list") {
      const items = this.inbox.items.slice(-20);
      this.info(
        items.length
          ? `Inbox (${this.inbox.unread()} unread, forms wait ${Math.round(this.inbox.timeoutMs / 60_000)} min):\n${items.map((i) => this.inboxLine(i)).join("\n")}\n/inbox read N · open N · dismiss N · answer N id=value; id=value · send N · timeout MINUTES`
          : "Inbox is empty. Studies post progress and questions here; nothing reaches the chat until you read it.",
      );
      return;
    }
    if (action === "timeout") {
      const minutes = Number(rest);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 30) return this.info("Use /inbox timeout MINUTES, from 1 to 30. It applies to forms posted from now on.");
      this.inbox.timeoutMs = Math.round(minutes * 60_000);
      return this.info(`Forms now wait ${minutes} min for you before the director decides.`);
    }
    const target = need();
    if (!target) return;
    try {
      if (action === "read") {
        const chat = this.chatRoom();
        if (!chat) return;
        this.inbox.markRead(target.id);
        if (this.rooms.focused !== chat) this.focusRoom(chat);
        chat.agent.messages.push({ role: "user", content: this.inboxContext(target) });
        chat.session.messages = chat.agent.messages;
        this.info(`Read #${target.id}: now in the chat's context.\n${target.title}${target.body ? `\n${target.body}` : ""}${target.kind === "form" ? "\nGive your direction in your own words; the chat drafts the answers, you confirm the send." : ""}`);
      } else if (action === "open") {
        const room = this.rooms.list().find((r) => r.study?.id === target.studyId);
        if (!room) return this.info("That study's room is not open.");
        this.focusRoom(room);
      } else if (action === "dismiss") {
        this.inbox.dismiss(target.id);
        this.info(target.kind === "form" ? `Form #${target.id} stays open until it times out; the director decides if you do not answer.` : `Dismissed #${target.id}.`);
      } else if (action === "answer") {
        if (target.status === "new") this.inbox.markRead(target.id);
        const values: Record<string, string> = {};
        for (const part of rest.split(/\s+/).slice(1).join(" ").split(";")) {
          const at = part.indexOf("=");
          if (at > 0) values[part.slice(0, at).trim()] = part.slice(at + 1).trim();
        }
        const updated = this.inbox.setDraft(target.id, values);
        const miss = this.inbox.missing(updated);
        this.info(`Draft for #${target.id} (not sent):\n${this.inbox.describeAnswers(updated)}${miss.length ? `\nStill needed: ${miss.join(", ")}` : `\nReady. /inbox send ${target.id}`}`);
      } else if (action === "send") {
        this.inbox.send(target.id);
      } else this.info("Usage: /inbox [list] | read N | open N | dismiss N | answer N id=value; … | send N | timeout MINUTES");
    } catch (error) {
      this.info(error instanceof Error ? error.message : "Inbox action failed.");
    }
  }

  private parseFormFields(raw: unknown[]): FormField[] {
    const types = ["choice", "yesno", "number", "text"];
    return raw.map((entry, index) => {
      const f = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
      if (typeof f.id !== "string" || typeof f.label !== "string" || !types.includes(String(f.type))) throw new Error(`Field ${index + 1}: needs id, label and a type of choice, yesno, number or text.`);
      return {
        id: f.id.trim().slice(0, 40),
        label: f.label.trim().slice(0, 300),
        type: f.type as FormField["type"],
        ...(Array.isArray(f.options) ? { options: f.options.map(String).slice(0, 8) } : {}),
        ...(typeof f.default === "string" ? { default: f.default.slice(0, 300) } : {}),
        ...(typeof f.why === "string" ? { why: f.why.slice(0, 200) } : {}),
      };
    });
  }

  /** Start queued studies while there are free slots. */
  private drainStartQueue() {
    if (this.closed || !this.credentials) return;
    const cap = this.rooms.limits.totalUsd;
    if (cap !== null && this.rooms.totalSpentUsd() >= cap) return;
    while (this.startQueue.length) {
      const free = this.rooms.limits.maxRunning - this.rooms.running().length - this.pendingStarts;
      if (free <= 0) return;
      const next = this.startQueue.shift()!;
      if (next.study?.status !== "ready" || next.running) continue;
      this.pendingStarts++;
      void this.runStudyInBackground(next).finally(() => (this.pendingStarts = Math.max(0, this.pendingStarts - 1)));
    }
  }
  /** Studies launched but not yet counted as running (their turn has not begun). */
  private pendingStarts = 0;

  /** Start every prepared study that has a budget, in the background, up to the concurrent-run limit. */
  private async startAllPrepared(): Promise<string> {
    if (!this.credentials) return "No model provider is connected: tell the user to run /connect, then start the studies.";
    await this.loadSavedStudies();
    const ready = this.rooms.studies().filter((r) => r.study?.status === "ready" && !r.running);
    if (!ready.length) return "No prepared studies are waiting. Prepare some with research_prepare first.";
    const withBudget = ready.filter((r) => r.study!.maxCostUsd !== null);
    const noBudget = ready.filter((r) => r.study!.maxCostUsd === null);
    let slots = Math.max(0, this.rooms.limits.maxRunning - this.rooms.running().length - this.pendingStarts);
    const cap = this.rooms.limits.totalUsd;
    const allowanceUsed = cap !== null && this.rooms.totalSpentUsd() >= cap;
    if (allowanceUsed) slots = 0;
    const started = withBudget.slice(0, slots);
    const queued = allowanceUsed ? [] : withBudget.slice(slots);
    for (const room of started) {
      this.pendingStarts++;
      void this.runStudyInBackground(room).finally(() => (this.pendingStarts = Math.max(0, this.pendingStarts - 1)));
    }
    for (const room of queued) if (!this.startQueue.includes(room)) this.startQueue.push(room);
    if (started.length) this.toast(`${started.length} stud${started.length === 1 ? "y" : "ies"} started in background`);
    const label = (r: Room) => `"${r.title.slice(0, 50)}" ($${r.study!.maxCostUsd?.toFixed(2) ?? "?"})`;
    return [
      started.length ? `Started in the background: ${started.map(label).join("; ")}.` : "Nothing was started.",
      queued.length ? `Queued (only ${this.rooms.limits.maxRunning} studies run at once; these start automatically as others finish, or raise /research parallel up to 10): ${queued.map(label).join("; ")}.` : "",
      allowanceUsed ? `Not started: the total allowance is used up; raise /research total.` : "",
      noBudget.length ? `Skipped, no budget set: ${noBudget.map((r) => `"${r.title.slice(0, 50)}"`).join("; ")}.` : "",
      "Tell the user briefly; do not repeat setup steps.",
    ].filter(Boolean).join("\n");
  }

  /** Every study in this workspace (live rooms win over saved copies). */
  private async allStudies() {
    const byId = new Map<string, { study: NonNullable<Room["study"]>; sessionId: string; running: boolean }>();
    for (const saved of await listSessions(this.cwd)) {
      if (saved.research) byId.set(saved.research.id, { study: saved.research, sessionId: saved.id, running: false });
    }
    for (const room of this.rooms.studies()) {
      if (room.study) byId.set(room.study.id, { study: room.study, sessionId: room.session.id, running: room.running });
    }
    return [...byId.values()];
  }

  private async listStudies(): Promise<string> {
    const all = await this.allStudies();
    if (!all.length) return "No research studies in this workspace yet.";
    const state = (e: (typeof all)[number]) => (e.running ? "running" : e.study.status === "running" ? "paused" : e.study.status);
    const names: Record<string, string> = { running: "running", ready: "prepared (not started)", paused: "paused", budget_exhausted: "out of budget", completed: "completed" };
    const counts = new Map<string, number>();
    for (const e of all) counts.set(state(e), (counts.get(state(e)) ?? 0) + 1);
    const summary = [...counts].map(([k, n]) => `${n} ${names[k] ?? k}`).join(" · ");
    const rows = all.map((e) => {
      const s = e.study;
      const budget = s.maxCostUsd === null ? "no budget" : `$${s.maxCostUsd.toFixed(2)}`;
      return `- ${s.id} [${names[state(e)] ?? state(e)}] $${studySpentUsd(s).toFixed(2)}/${budget}${s.autoPublish ? " · auto-publish" : ""} · ${e.running ? "cannot delete while running" : "deletable"} · ${s.objective.slice(0, 90)}`;
    });
    const total = all.reduce((n, e) => n + studySpentUsd(e.study), 0).toFixed(2);
    return `${all.length} studies: ${summary}\n${rows.join("\n")}\nTotal spent $${total}. Deleting removes local files only; findings already on LSI stay (unpublish with lsi_set_published).`;
  }

  private async deleteStudy(query: string): Promise<string> {
    const all = await this.allStudies();
    const hits = all.filter((e) => e.study.id === query || e.study.id.startsWith(query));
    if (hits.length !== 1) return hits.length ? `"${query}" matches ${hits.length} studies; give a longer id.` : `No study matches "${query}". Call research_list for ids.`;
    const hit = hits[0]!;
    if (hit.running) return "That study is running. Pause it first (Esc in its room), then delete.";
    if (!/^[\w-]+$/.test(hit.study.id)) return "Refusing to delete: unexpected study id.";
    const room = this.rooms.list().find((r) => r.study?.id === hit.study.id);
    if (room && this.rooms.focused?.id === room.id) return "That study's room is focused. Switch to another room (Ctrl+K), then delete.";
    this.startQueue = this.startQueue.filter((r) => r.study?.id !== hit.study.id);
    if (room) this.rooms.remove(room.id);
    await deleteSession(hit.sessionId);
    await rm(join(this.cwd, "research", hit.study.id), { recursive: true, force: true });
    return `Deleted ${hit.study.id} (${hit.study.status}). Local files only; anything it published to LSI is unchanged.`;
  }

  /** Strict budget ran out: one automatic conclude-and-publish turn within what is left, never a funding request. */
  private async strictConclude(room: Room) {
    const study = room.session.research;
    if (!study?.strictBudget || study.strictWrapUp || study.status === "completed" || this.closed) return;
    study.strictWrapUp = true;
    const left = (study.maxCostUsd ?? 0) - (study.spentCostMicros + study.estimatedCostMicros) / 1_000_000;
    if (left < 0.01) {
      study.status = "budget_exhausted";
      await saveSession(room.session).catch(() => {});
      this.toast("strict budget used up · study stopped without a final report", true);
      return;
    }
    study.status = "paused";
    room.agent.research = study;
    room.agent.publishNow = true;
    room.agent.wrappingUp = true;
    await saveSession(room.session).catch(() => {});
    this.toast("strict budget reached · concluding with what exists");
    await this.runTurn(room, wrapupPrompt(true));
  }

  // A finished background task wakes the agent in its own turn. If a turn
  // is already active, the wake-up stays queued and is drained at the head
  // of the next turn instead.
  private async wakeFromBackground(room: Room = this.rooms.focused!) {
    if (
      this.closed ||
      room.controller ||
      (this.rooms.focused === room && (this.connectStep || this.listPicker)) ||
      (room.agent.research &&
        ["budget_exhausted", "completed"].includes(
          room.agent.research.status,
        )) ||
      !this.credentials
    )
      return;
    const wakes = room.agent.takeBackgroundWakeups();
    if (!wakes.length) return;
    const note = "Background result arrived · waking the agent to review it.";
    if (this.rooms.focused === room) this.info(note);
    else room.buffer.push({ type: "note", text: note });
    await this.runTurn(room, wakes.join("\n\n"), "wake");
  }

  private emitFor(room: Room) {
    return (event: AgentEvent) => {
      if (this.closed) return;
      if (this.rooms.focused === room) this.event(event);
      else this.observe(room, event);
    };
  }

  // Events from a room that is not on screen: keep its state current and
  // buffer what the user will want to see when they open it.
  private observe(room: Room, event: AgentEvent) {
    if (event.type === "budget") {
      room.agent.research = event.state;
      room.session.research = event.state;
      this.drawBar();
      return;
    }
    if (event.type === "usage") {
      void recordUsage(event.model, event.input, event.output).catch(() => {});
      return;
    }
    if (event.type === "response") room.lastText = "";
    if (event.type === "text") room.lastText += event.delta;
    room.buffer.push(event);
  }

  private errorText(error: unknown) {
    if (error instanceof OpenAI.APIError)
      return `Endpoint error ${error.status ?? "network"}. ${error.status === 401 || error.status === 403 ? "Use /connect to update credentials." : "Try again; /new clears context."}`;
    return error instanceof Error ? clean(error.message) : "Action failed.";
  }

  // One turn in one room. Everything it needs from the UI is captured per
  // room, so the user can switch rooms while it runs.
  private async runTurn(
    room: Room,
    input: string,
    mode: "turn" | "wake" = "turn",
  ) {
    const credentials = this.credentials;
    if (!credentials || room.controller || this.closed) return;
    const controller = new AbortController();
    room.controller = controller;
    room.question = null;
    room.lastText = "";
    const emit = this.emitFor(room);
    const focused = () => this.rooms.focused === room;
    const start = performance.now();
    if (focused()) {
      this.tipRow.visible = false;
      // Study rooms stay typeable so the user can steer the director.
      if (room.kind === "chat") this.composer.blur();
      if (mode === "turn")
        this.idleVerb = `${idleVerbs[Math.floor(Math.random() * idleVerbs.length)]}…`;
    }
    this.drawBar();
    try {
      await room.agent.run(input, credentials, controller.signal, emit);
      if (focused()) {
        this.stopLoading();
        this.flushResponse();
        this.status.content = `Landed · ${((performance.now() - start) / 1000).toFixed(1)}s`;
      }
    } catch (error) {
      const aborted = controller.signal.aborted;
      if (focused()) {
        this.stopLoading();
        this.tipsBlockedByError = !aborted;
        this.status.content = aborted
          ? "Paused · progress saved"
          : "Stopped · see error above";
        this.status.fg = theme.error;
        if (aborted) {
          if (mode === "turn") this.info(this.stoppedMessage());
        } else if (!this.showConnectionFailure(error))
          this.info(this.errorText(error));
      } else if (!aborted)
        room.buffer.push({ type: "note", text: this.errorText(error) });
      else
        room.buffer.push({
          type: "note",
          text: `Paused · progress checkpointed in research/${room.study?.id ?? ""}/`,
        });
    } finally {
      room.controller = null;
      if (focused()) {
        this.stopLoading();
        this.toolGroup = null;
        this.pendingText = "";
      }
      room.session.messages = room.agent.messages;
      room.session.context = room.agent.context;
      if (room.agent.research) room.session.research = room.agent.research;
      room.session.tasks = room.agent.tasks;
      try {
        await saveSession(room.session);
      } catch {
        if (!this.closed && focused())
          this.info("Could not save session to disk.");
      }
      if (!focused() && !controller.signal.aborted && room.kind === "study")
        room.question = brief(
          room.lastText.trim() || "Waiting for your direction.",
          120,
        );
      this.drawBar();
      if (!this.closed && focused()) {
        if (!this.connectStep && !this.approval) this.composer.focus();
        if (this.pauseDecisionPending && room.kind === "study") {
          this.pauseDecisionPending = false;
          this.openPauseDecision();
        } else void this.wakeFromBackground(room);
        this.refreshTipRow();
      } else if (!this.closed) void this.wakeFromBackground(room);
      if (!this.closed && !controller.signal.aborted && room.kind === "study") this.drainStartQueue();
      if (!this.closed && !controller.signal.aborted && room.kind === "study" && room.study) {
        const status = room.study.status;
        const key = `${room.study.id}:${status}`;
        if ((status === "completed" || status === "budget_exhausted") && !this.notifiedStates.has(key)) {
          this.notifiedStates.add(key);
          this.inbox.notify(
            room.study.id,
            room.title,
            status === "completed" ? "done" : "blocked",
            status === "completed" ? `Finished · $${studySpentUsd(room.study).toFixed(2)} spent` : "Out of budget: needs your decision in the room",
          );
        }
      }
      if (
        !this.closed &&
        !controller.signal.aborted &&
        room.kind === "study" &&
        room.session.research?.strictBudget &&
        room.session.research.status === "budget_exhausted"
      )
        void this.strictConclude(room);
    }
  }

  private drawBar() {
    if (this.closed || !this.roomBar) return;
    const rooms = this.rooms.list();
    const focused = this.rooms.focused;
    setStudyHints(
      this.rooms
        .studies()
        .map((room) =>
          (room.study?.objective ?? room.session.title)
            .replace(/\s+/g, " ")
            .slice(0, 40),
        ),
    );
    this.composer.placeholder =
      focused?.kind === "study"
        ? "to director ❯ direct this study…  /chat leaves"
        : "Build, fix, explain…  /help";
    if (rooms.length < 2) {
      this.roomBar.visible = false;
      return;
    }
    const { lines, targets } = roomList(
      this.rooms,
      Math.max(20, this.renderer.width - 4),
      Math.max(3, Math.min(10, Math.floor((this.renderer.height - 14) / 2))),
      performance.now(),
      this.inbox.unread() ? `✉${this.inbox.unread()} unread · /inbox` : "",
    );
    this.roomTargets = targets;
    this.roomBar.content = lines.join("\n");
    this.roomBar.height = Math.max(1, lines.length);
    this.roomBar.visible = true;
    this.drawFooter();
  }

  // Left: workspace. Right: a short-lived toast, else room shortcuts.
  private drawFooter() {
    if (this.closed || !this.footer) return;
    const width = Math.max(10, this.renderer.width - 4);
    const home = homedir();
    let left = this.cwd.startsWith(home) ? `~${this.cwd.slice(home.length)}` : this.cwd;
    const focused = this.rooms.focused;
    const right = this.toastText
      ? this.toastText
      : focused?.kind === "study"
        ? "Alt+↑↓ rooms · /chat leaves"
        : this.rooms.list().length > 1
          ? "Alt+↑↓ rooms"
          : "";
    if (right && left.length + right.length + 2 > width) {
      if (this.toastText) left = truncateMiddle(left, Math.max(8, width - right.length - 2));
      else {
        this.footer.content = truncateMiddle(left, width);
        this.footer.fg = theme.muted;
        return;
      }
    }
    const gap = Math.max(1, width - left.length - right.length);
    this.footer.content = right ? `${left}${" ".repeat(gap)}${right}` : left;
    this.footer.fg = this.toastText && this.toastWarn ? theme.error : theme.muted;
  }

  private toast(text: string, warn = false) {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastText = text;
    this.toastWarn = warn;
    this.drawFooter();
    this.toastTimer = setTimeout(() => {
      this.toastText = "";
      this.toastTimer = null;
      this.drawFooter();
    }, warn ? 5_000 : 2_000);
    this.toastTimer.unref();
  }

  // Bring a room on screen. Its transcript is rebuilt from saved entries and
  // whatever it did while hidden is replayed. Nothing running is interrupted.
  private focusRoom(target: Room): boolean {
    const leaving = this.rooms.focused;
    if (!leaving || leaving === target) return true;
    if (this.approval || this.connectStep || this.listPicker) {
      this.info("Finish the current prompt first, then switch rooms.");
      return false;
    }
    this.flushResponse();
    for (const entry of leaving.session.entries) {
      if (entry.detail?.output === "Running…") {
        const where = leaving.study
          ? `research/${leaving.study.id}/events.jsonl`
          : "the session";
        entry.detail.output = `Still running when you left this room. Result recorded in ${where}.`;
        entry.text = entry.text.replace("Running…", entry.detail.output);
      }
    }
    void saveSession(leaving.session).catch(() => {});
    this.rooms.focus(target.id);
    this.stopLoading();
    this.pauseDecisionPending = false;
    this.renderEntries(target.session);
    const { events, dropped } = target.buffer.drain();
    if (dropped)
      this.info(
        `${dropped} earlier events were not kept while you were away${target.study ? ` · full log: research/${target.study.id}/events.jsonl` : ""}`,
      );
    for (const event of events) {
      if (event.type === "note") this.info(event.text);
      else this.event(event);
    }
    target.question = null;
    if (target.running) this.showLoading("Working");
    else {
      // Replayed "working" events start the spinner timer; a room that is not running must not keep it.
      this.stopLoading();
      this.flushResponse();
      this.ready();
    }
    this.drawBar();
    void this.presentApprovals(target);
    this.composer.focus();
    return true;
  }

  // A study gets its own session, agent and browser, so it runs independently.
  private addStudyRoom(session: Session): Room {
    const browser = new BrowserSession();
    const fresh = session.messages.length === 0;
    const agent = this.makeAgent(
      fresh ? undefined : session.messages,
      session.goal,
      session.context,
      browser,
    );
    if (fresh) session.messages = agent.messages;
    agent.research =
      session.researchEnabled === false ? null : (session.research ?? null);
    agent.tasks = session.tasks.map((task) => ({ ...task }));
    session.context = agent.context;
    const room = new Room(session.id, "study", session, agent, browser);
    this.rooms.add(room);
    this.startBarTimer();
    this.agentRooms.set(agent, room);
    this.drawBar();
    return room;
  }

  private async presentApprovals(room: Room) {
    while (
      !this.closed &&
      this.rooms.focused === room &&
      room.pending.length &&
      !this.approval
    ) {
      const entry = room.nextApproval()!;
      const signal = room.controller?.signal ?? new AbortController().signal;
      entry.resolve(await this.ask(entry.request, signal));
    }
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
        "No providers connected yet. Run /connect baseten, /connect modal or /connect nebius first.",
      );
      return;
    }
    const current = this.effectiveModel();
    this.openListPicker(
      "Choose a model",
      usable.map(
        (m) =>
          `${m.provider} — ${m.label}${m.id === current ? " (current)" : ""}\n    ${formatModelPricing(m.pricing)}\n    ${m.provider === "nebius" ? "Published rate" : "Public reference; endpoint billing unverified"}`,
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

  private refreshTipRow() {
    if (!this.tipRow) return;
    this.tipRow.visible =
      this.tipsEnabled &&
      !this.closed &&
      !this.active &&
      !this.loadingTimer &&
      !this.approval &&
      !this.connectStep &&
      !this.listPicker &&
      !this.tipsBlockedByError;
    if (!this.tipRow.visible) return;
    if (!this.availableTips.length || !this.composer.plainText) {
      const context = {
        connected: Boolean(this.credentials),
        permission: this.permission,
        research: this.session.research,
        researchEnabled: this.session.researchEnabled !== false,
        tavily: Boolean(tavilyKey()),
        lsi: Boolean(lsiKey()),
      };
      const key = JSON.stringify([
        context.connected,
        context.permission,
        context.research?.status,
        context.research?.maxCostUsd === null,
        Boolean(context.research?.agents),
        context.researchEnabled,
        context.tavily,
        context.lsi,
      ]);
      if (key !== this.tipContextKey || !this.availableTips.length) {
        this.availableTips = tipsFor(context);
        this.tipContextKey = key;
        this.tipIndex = 0;
      }
    }
    const tip = this.availableTips[this.tipIndex];
    if (!tip) {
      this.tipRow.visible = false;
      return;
    }
    const width = Math.max(8, this.renderer.width - 20);
    const text = `Tip: ${tip.text}`;
    const rows = Math.min(2, Math.max(1, Math.ceil(text.length / width)));
    this.tipRow.height = rows;
    this.tipText.content =
      text.length > width * 2 ? text.slice(0, width * 2 - 1) + "…" : text;
    this.tipCounter.content = `${this.tipIndex + 1}/${this.availableTips.length}`;
  }

  private async setTips(enabled: boolean) {
    this.tipsEnabled = enabled;
    this.refreshTipRow();
    if (!enabled) this.composer.focus();
    await saveTipsEnabled(enabled).catch(() => {});
  }

  private changeTip(direction: number) {
    if (!this.tipRow.visible || !this.availableTips.length) return;
    this.tipIndex =
      (this.tipIndex + direction + this.availableTips.length) %
      this.availableTips.length;
    this.refreshTipRow();
    this.composer.focus();
  }

  private ready(clearTipError = true) {
    if (clearTipError) this.tipsBlockedByError = false;
    this.refreshTipRow();
    this.status.fg = theme.muted;
    const goal =
      this.session.goal && !this.session.research
        ? `Goal: ${this.session.goal.length > 40 ? this.session.goal.slice(0, 40) + "…" : this.session.goal}`
        : "";
    const total = this.session.tasks.length;
    const done = this.session.tasks.filter((t) => t.status === "done").length;
    const tasks = total ? `Tasks ${done}/${total}` : "";
    const hud = this.session.research ? this.compactHudText() : "";
    this.status.content = [goal, tasks, hud].filter(Boolean).join(" · ");
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
    const expandable = entry.role === "tool" || Boolean(entry.detail);
    const block = new BoxRenderable(this.renderer, {
      flexDirection: "row",
      flexShrink: 0,
      width: "100%",
    });
    if (entry.role !== "info" && entry.role !== "tool")
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
          width: 2,
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
    const column = expandable
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
    if (expandable) {
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
        block,
        expanded: false,
        panels,
      };
      this.toolViews.set(tool.node, tool);
      if (entry.activityGroup) {
        this.activityGroups.set(entry.activityGroup, {
          head: tool,
          children: [],
        });
        this.groupHeads.add(tool);
      }
      if (entry.parentActivityGroup) {
        const group = this.activityGroups.get(entry.parentActivityGroup);
        group?.children.push(tool);
        block.visible = group?.head.expanded ?? true;
      }
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
          // Group heads also show/hide their individual tool rows.
          if (this.groupHeads.has(tool)) {
            this.applyGroupVisibility();
            this.applyTeamVisibility();
          }
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
  private add(
    role: Entry["role"],
    text: string,
    detail?: Entry["detail"],
    metadata: Pick<Entry, "activityGroup" | "parentActivityGroup"> = {},
  ) {
    this.markActivity();
    const entry: Entry = {
      role,
      text,
      ...(detail ? { detail } : {}),
      ...metadata,
    };
    this.session.entries.push(entry);
    return { entry, node: this.display(entry) };
  }
  private renderTool(tool: ToolView) {
    // Old rows are destroyed once the transcript passes 180 entries; a late update must not touch them.
    if (tool.node.isDestroyed) return;
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
        `↓ Input${detail.toolName ? ` · ${detail.toolName}` : ""} · ${detail.language}  · scroll to inspect`,
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

  private showConnectionFailure(error: unknown): boolean {
    if (
      !(error instanceof OpenAI.APIConnectionError) &&
      !connectionFailure(error)
    )
      return false;
    this.tipsBlockedByError = true;
    this.tipRow.visible = false;
    const research = Boolean(this.agent.research);
    const recovery = research ? "/research resume" : "Send your request again";
    const value = error as Error & {
      code?: string;
      cause?: { code?: string; message?: string };
    };
    this.add(
      "info",
      `✕ Connection interrupted · ${research ? "research paused" : "request stopped"}\nThe model connection closed unexpectedly. Completed actions are kept.\nNext: ${recovery}. Expand for technical details.`,
      {
        input: `Provider: ${this.credentials?.provider ?? "unknown"}\nRecovery: ${recovery}\nNo automatic retry: completed actions will not be replayed by the client.`,
        output: clean(
          `${value.code ?? value.name ?? "Error"}: ${value.message ?? String(error)}${value.cause ? `\nCause: ${value.cause.code ?? ""} ${value.cause.message ?? ""}` : ""}`,
        ),
        language: "text",
      },
    );
    this.status.content = `Connection interrupted · ${recovery}`;
    this.status.fg = theme.error;
    return true;
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
    this.refreshTipRow();
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
    const matches = completeCandidates(value);
    const single = !value.includes("\n");
    const exact = matches.length === 1 && matches[0] === value.trim();
    const idle =
      !this.connectStep &&
      (!this.active || this.rooms.focused?.kind === "study");
    if (single && matches.length && !exact) {
      if (!this.menu || this.menu.value !== value)
        this.menu = { items: matches, index: 0, touched: false, value };
      const start = Math.max(
        0,
        Math.min(this.menu.index - 7, matches.length - 8),
      );
      const window = matches.slice(start, start + 8);
      const pad = Math.max(...window.map((m) => m.length)) + 2;
      this.hints.height = window.length + (matches.length > 8 ? 1 : 0);
      this.hints.content =
        window
          .map(
            (m, i) =>
              `${start + i === this.menu!.index ? "▸" : " "} ${m.padEnd(pad)}${describeCandidate(m)}`,
          )
          .join("\n") +
        (matches.length > 8
          ? `\n  ${matches.length} matches · ↑↓ select · Tab fill`
          : "");
      this.hints.visible = idle;
      return;
    }
    this.menu = null;
    const hint = single ? argumentHint(value) : "";
    this.hints.height = 1;
    this.hints.content =
      hint || `${value.length} chars · ${value.split("\n").length} lines`;
    this.hints.visible = idle && (Boolean(hint) || value.length > 80);
  }

  private key(key: KeyEvent) {
    if (
      (key.meta || key.option) &&
      !key.ctrl &&
      ["left", "right"].includes(key.name) &&
      this.tipRow.visible
    ) {
      key.preventDefault();
      key.stopPropagation();
      this.changeTip(key.name === "left" ? -1 : 1);
      return;
    }
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
      if (this.active) this.stopActiveWork();
      else if (this.agent.hasRunningBackground()) {
        // Ctrl+C with only background work running stops that work and
        // stays open; a second Ctrl+C with nothing running quits.
        this.agent.cancelBackground();
        this.info(this.stoppedMessage());
      } else this.close();
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
        this.serviceConnect = null;
        this.connectStep = null;
        this.connectKeyName = null;
        this.secretValue = this.tokenId = "";
        this.restoreInput();
      } else if (this.approval) this.approval.finish(false);
      else if (this.active) this.stopActiveWork();
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
    if (
      (key.meta || key.option) &&
      !key.ctrl &&
      ["up", "down"].includes(key.name) &&
      this.rooms.list().length > 1
    ) {
      key.preventDefault();
      key.stopPropagation();
      const order = roomOrder(this.rooms);
      const at = order.indexOf(this.rooms.focused as Room);
      const next = order[(at + (key.name === "up" ? -1 : 1) + order.length) % order.length];
      if (next && this.focusRoom(next)) this.composer.focus();
      return;
    }
    if (key.ctrl && key.name === "k" && this.rooms.list().length > 1) {
      key.preventDefault();
      this.openRoomPicker();
      return;
    }
    if (key.ctrl && key.name === "o" && this.lastTool) {
      key.preventDefault();
      const tool = this.lastTool;
      tool.expanded = !tool.expanded;
      this.renderTool(tool);
      this.applyGroupVisibility();
      this.applyTeamVisibility();
      return;
    }
    if (this.active && this.rooms.focused?.kind !== "study") {
      key.preventDefault();
      return;
    }
    if (
      this.menu &&
      (key.name === "up" || key.name === "down") &&
      this.menu.items.length > 1
    ) {
      key.preventDefault();
      const n = this.menu.items.length;
      this.menu.index = (this.menu.index + (key.name === "up" ? n - 1 : 1)) % n;
      this.menu.touched = true;
      const keep = this.menu;
      this.inputChanged();
      this.menu = keep;
      return;
    }
    if (key.name === "tab" && this.menu?.touched) {
      key.preventDefault();
      this.fillMenuSelection();
      return;
    }
    if (key.name === "tab" && this.composer.plainText.startsWith("/")) {
      key.preventDefault();
      const current = this.composer.plainText.split("\n")[0]!;
      let candidates: string[];
      let index: number;
      let prefix: string;
      if (
        this.tabCycle &&
        this.tabCycle.candidates.includes(current) &&
        completeCandidates(this.tabCycle.prefix).join("\n") ===
          this.tabCycle.candidates.join("\n")
      ) {
        candidates = this.tabCycle.candidates;
        index = this.tabCycle.index + 1;
        prefix = this.tabCycle.prefix;
      } else {
        candidates = completeCandidates(current);
        if (!candidates.length) {
          this.tabCycle = null;
          return;
        }
        if (candidates.length > 1) {
          const common = longestCommonPrefix(candidates);
          if (common.length > current.length) {
            this.composer.setText(common);
            this.composer.cursorOffset = common.length;
            this.tabCycle = null;
            this.inputChanged();
            return;
          }
        }
        index = 0;
        prefix = current;
      }
      const next = candidates[index % candidates.length]!;
      const completed =
        candidates.length === 1 && completionHasChildren(next)
          ? `${next} `
          : next;
      this.composer.setText(completed);
      this.composer.cursorOffset = completed.length;
      this.tabCycle = { prefix, candidates, index: index % candidates.length };
      this.inputChanged();
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
      this.toast("Drag across text to select, then Ctrl+C");
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
        this.toast(`✓ copied ${text.length} chars`);
        this.renderer.clearSelection();
      } else if (result.terminal.status === "attempted") {
        this.toast("copy sent to terminal");
        this.renderer.clearSelection();
      } else
        this.toast("clipboard unavailable · try Shift+drag", true);
    } catch {
      if (!this.closed)
        this.toast("copy failed · try Shift+drag", true);
    }
  }

  private drawSecret() {
    const keySuffix = this.connectKeyName
      ? ` · key ${this.connectKeyName}`
      : "";
    const label =
      this.serviceConnect === "tavily"
        ? "Tavily API key"
        : this.serviceConnect === "lsi"
          ? "LSI API key (lsi_…)"
          : this.connectStep === "id"
            ? `Modal token ID${keySuffix}`
            : this.connectStep === "key"
              ? `${this.connectProvider === "nebius" ? "Nebius Token Factory" : "Baseten"} API key${keySuffix}`
              : "Modal token secret";
    this.secretText.content = `${label}\n${"•".repeat(Math.min(28, this.secretValue.length))}  ${this.secretValue.length} characters`;
  }
  private describeProvider(provider: Provider) {
    return provider === "nebius"
      ? "nebius — Nebius Token Factory API key"
      : provider === "baseten"
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
    this.tipRow.visible = false;
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
        height: label.split("\n").length,
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
    this.refreshTipRow();
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
    const labels = (["baseten", "modal", "nebius"] as Provider[]).map(
      (provider) => {
        const count = this.keychain[provider]?.keys.length ?? 0;
        const state =
          count > 0
            ? `  (${count} key${count === 1 ? "" : "s"}, connected)`
            : "";
        return `${this.describeProvider(provider)}${state}`;
      },
    );
    labels.push(
      `tavily — Web research tools${tavilyKey() ? " (connected)" : ""}`,
      `lsi — Publish and query research${lsiKey() ? " (connected)" : ""}`,
    );
    this.openListPicker(
      "Choose a provider",
      labels,
      ["baseten", "modal", "nebius", "tavily", "lsi"],
      (value) =>
        value === "tavily"
          ? this.startTavilyEntry()
          : value === "lsi"
            ? this.startLsiEntry()
            : this.connect(value as Provider),
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
  private connectProvider: Provider = "modal";
  private serviceConnect: "tavily" | "lsi" | null = null;
  private startLsiEntry() {
    this.startKeyEntry("baseten", "a");
    this.serviceConnect = "lsi";
    this.connectKeyName = null;
    let host = "LSI";
    try {
      host = lsiBaseUrl();
    } catch {
      /* invalid override is reported on use */
    }
    this.status.content = `LSI API key from ${host}/account · saved locally in plaintext. Enter to save, Esc to cancel. Model provider stays unchanged.`;
    this.drawSecret();
  }
  private startTavilyEntry() {
    this.startKeyEntry("baseten", "a");
    this.serviceConnect = "tavily";
    this.connectKeyName = null;
    this.status.content =
      "Tavily API key · saved locally in plaintext. Enter to save, Esc to cancel. Model provider stays unchanged.";
    this.drawSecret();
  }
  private startKeyEntry(provider: Provider, name: string) {
    this.tipRow.visible = false;
    this.serviceConnect = null;
    this.renderer.clearSelection();
    this.connectProvider = provider;
    this.connectKeyName = name;
    this.connectStep = provider !== "modal" ? "key" : "id";
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
    if (this.serviceConnect === "lsi") {
      try {
        await saveLsiKey(value);
        this.connectStep = null;
        this.serviceConnect = null;
        this.connectKeyName = null;
        this.secretValue = "";
        this.restoreInput();
        this.info(lsiConnectionMessage);
      } catch (error) {
        this.status.content =
          error instanceof Error && /valid LSI/.test(error.message)
            ? error.message
            : "Could not save LSI key. Check the config directory permissions, then try again.";
      }
      return;
    }
    if (this.serviceConnect === "tavily") {
      try {
        await saveTavilyKey(value);
        this.connectStep = null;
        this.serviceConnect = null;
        this.connectKeyName = null;
        this.secretValue = "";
        this.restoreInput();
        this.info(tavilyConnectionMessage);
      } catch {
        this.status.content =
          "Could not save Tavily key. Check the key and config directory permissions, then try again.";
      }
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
      nextKeyName(this.storeForNames(), this.connectProvider);
    const next: Credentials =
      this.connectStep === "key"
        ? {
            provider: this.connectProvider as "baseten" | "nebius",
            apiKey: value,
          }
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
        `${next.provider === "nebius" ? "Nebius" : next.provider === "baseten" ? "Baseten" : "Modal"} key ${savedName} saved and active — tucked into the nest.`,
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
  // Approvals from a room that is not on screen wait in that room's queue
  // (it shows as "needs you") and are presented when the user opens it.
  private askFor(
    agent: Agent,
    request: Approval,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted || this.closed) return Promise.resolve(false);
    if (autoApprove(this.permission, request)) return Promise.resolve(true);
    const room = this.agentRooms.get(agent);
    if (!room || room === this.rooms.focused) return this.ask(request, signal);
    const answer = room.queueApproval(request, signal);
    this.drawBar();
    return answer;
  }

  private ask(request: Approval, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || this.closed) return Promise.resolve(false);
    if (autoApprove(this.permission, request)) return Promise.resolve(true);
    this.stopLoading();
    this.tipRow.visible = false;
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
      // Hybrid team UI: one head per team; each worker keeps its OWN row
      // (old UI) hidden under the head until the head is expanded.
      // Every worker row individually expands to its own live activity log.
      if (!this.teamGroup) {
        this.teamFeed = [];
        const head = this.add(
          "tool",
          "→ Research team",
          {
            input:
              "Research team — expand the head for per-worker rows, then expand a worker for its live tool activity. /agents <id> inspects a saved transcript.",
            output: "Starting…",
            language: "text",
          },
          { activityGroup: crypto.randomUUID() },
        );
        const view = this.toolViews.get(head.node as TextRenderable)!;
        this.groupHeads.add(view);
        this.teamGroup = {
          entry: head.entry,
          node: head.node as TextRenderable,
          view,
          children: this.activityGroups.get(head.entry.activityGroup!)!
            .children,
        };
      }
      const team = this.teamGroup;
      const added = this.add(
        "tool",
        `→ ${event.role} ${event.workerId.slice(0, 8)} · ${event.model}`,
        {
          input: `Task: ${event.task}\nRole: ${event.role}\nModel: ${event.model}\nParent: ${event.parentId}\nDepth: ${event.depth}\n\nClick this row for live activity. /agents ${event.workerId.slice(0, 8)} inspects its transcript.`,
          output: "Starting…",
          language: "text",
        },
        { parentActivityGroup: team.entry.activityGroup },
      );
      const childView = this.toolViews.get(added.node as TextRenderable)!;
      if (childView.block && !childView.block.isDestroyed) childView.block.visible = team.view.expanded;
      worker = {
        meta: event,
        entry: added.entry,
        view: childView,
        log: "",
        latest: "Starting",
        renderedAt: 0,
      };
      this.workerViews.set(event.workerId, worker);
    }
    worker.meta = event;
    const activity = event.event;
    if (activity?.type === "tool") {
      worker.latest = `${actionLabel(activity.name, activity.args)} · ${activity.state}`;
      if (activity.state !== "running") {
        this.teamFeed.push(
          `${activity.state === "error" ? "✕" : "✓"} ${event.role} ${event.workerId.slice(0, 6)} · ${brief(actionLabel(activity.name, activity.args), 70)}${activity.durationMs === undefined ? "" : ` · ${formatDuration(activity.durationMs)}`}`,
        );
        if (this.teamFeed.length > 8) this.teamFeed.shift();
      }
      worker.log += `\n[${activity.state}] ${activity.name}${activity.durationMs === undefined ? "" : ` · ${formatDuration(activity.durationMs)}`}\n${activity.state === "running" ? activity.args : (activity.output ?? "")}\n`;
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
    // Own row, old style: status + role/id/model + latest tool, expandable
    // to this worker's live log (with per-tool timings).
    worker.entry.text = `${event.state === "done" ? "✓" : event.state === "error" ? "✕" : "→"} ${event.role} ${event.workerId.slice(0, 8)} · ${truncateMiddle(event.model, 36)} · ${brief(worker.latest, 70)}`;
    worker.entry.detail!.output = worker.log || "Starting…";
    if (
      activity?.type === "text" &&
      performance.now() - worker.renderedAt < 100
    )
      return;
    worker.renderedAt = performance.now();
    if (!worker.view.node.isDestroyed) this.renderTool(worker.view);
    this.renderTeamGroup();
  }

  private applyTeamVisibility() {
    const team = this.teamGroup;
    if (!team) return;
    for (const child of team.children)
      if (child.block && !child.block.isDestroyed) child.block.visible = team.view.expanded;
  }

  private renderTeamGroup() {
    const team = this.teamGroup;
    if (!team) return;
    const workers = [...this.workerViews.values()];
    const running = workers.filter((w) => w.meta.state === "running").length;
    const done = workers.filter((w) => w.meta.state === "done").length;
    const failed = workers.filter((w) => w.meta.state === "error").length;
    const roles = [...new Set(workers.map((w) => w.meta.role))].join(", ");
    const live = workers.find((w) => w.meta.state === "running");
    team.entry.text =
      running > 0
        ? `→ Research team · ${workers.length} ${roles} · ${running} running${done ? ` · ${done} done` : ""}${failed ? ` · ${failed} failed` : ""}${live ? ` · ${truncateMiddle(live.latest, 48)}` : ""}`
        : `${failed ? "✕" : "✓"} Research team · ${done}/${workers.length} done${failed ? ` · ${failed} failed` : ""}`;
    // Head detail stays a thin index; per-tool logs live on worker rows.
    team.entry.detail!.output = [
      ...(this.teamFeed.length ? ["Recent tool calls:", ...this.teamFeed.map((l) => `  ${l}`), ""] : []),
      ...workers
      .map(
        (w) =>
          `${w.meta.state === "done" ? "✓" : w.meta.state === "error" ? "✕" : "→"} ${w.meta.role} ${w.meta.workerId.slice(0, 8)} · ${truncateMiddle(w.meta.model, 36)} · ${w.latest}`,
      ),
    ].join("\n");
    if (failed > 0 && running === 0) team.view.expanded = true;
    if (!team.view.node.isDestroyed) this.renderTool(team.view);
    this.applyTeamVisibility();
  }

  private event(event: AgentEvent) {
    if (this.closed) return;
    if (event.type === "worker") {
      this.workerEvent(event);
      return;
    }
    if (event.type === "checkpoint") {
      this.toolGroup = null;
      this.teamGroup = null;
      // The checkpoint body is the director's own write-up: render it as Markdown.
      if (event.text.trim()) this.add("kest", brief(event.text, 6000));
      this.add("info", `Research checkpoint ${event.cycle} · continuing`);
      this.pendingText = "";
      return;
    }
    if (event.type === "background") {
      this.info(
        event.state === "running"
          ? `Background task ${event.taskId.slice(0, 8)} started · ${brief(event.task, 120)} · the agent keeps working`
          : `Background task ${event.taskId.slice(0, 8)} ${event.state} · ${brief(event.task, 120)}`,
      );
      return;
    }
    if (event.type === "budget") {
      // Live runtime sync for real research runs only. A budget event
      // must never create research state in a plain session.
      if (!this.agent.research && !this.session.research) return;
      this.session.research = event.state;
      this.agent.research = event.state;
      this.budgetSyncedAt = performance.now();
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
      // Emitted every model round — do NOT close the tool group here,
      // or sequential tools each become their own row again. The group
      // closes on flushResponse/checkpoint/turn end instead.
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
      const heading = `→ ${brief(actionLabel(event.name, event.args), 180)}`;
      let input = event.args;
      if (event.name === "shell") {
        try {
          input = JSON.parse(event.args).command ?? event.args;
        } catch {
          /* Keep raw input. */
        }
      }
      // Hybrid grouped UI: one group head per turn; each tool keeps its
      // OWN row (old UI) hidden under the head until the head is expanded.
      // Every row individually expands to its own Input/Output panels.
      if (!this.toolGroup) {
        const head = this.add("tool", "→ Activity", undefined, {
          activityGroup: crypto.randomUUID(),
        });
        const view = this.toolViews.get(head.node as TextRenderable)!;
        this.groupHeads.add(view);
        this.toolGroup = {
          entry: head.entry,
          node: head.node as TextRenderable,
          view,
          children: this.activityGroups.get(head.entry.activityGroup!)!
            .children,
          count: 0,
          failures: 0,
          totalMs: 0,
          running: 0,
          names: [],
        };
      }
      const group = this.toolGroup;
      group.count++;
      group.running++;
      if (!group.names.includes(event.name)) group.names.push(event.name);
      const tool = this.add(
        "tool",
        event.name === "shell"
          ? `${heading}\n\nInput\n${brief(input, 12_000)}\n\nOutput\nRunning…`
          : heading,
        {
          input,
          output: "Running…",
          language: event.name === "shell" ? "TypeScript" : "JSON",
          toolName: event.name,
        },
        { parentActivityGroup: group.entry.activityGroup },
      );
      const childView = this.toolViews.get(tool.node as TextRenderable)!;
      childView.callId = event.callId;
      childView.toolName = event.name;
      childView.rawArgs = event.args;
      this.pendingTools.push(childView);
      if (childView.block) childView.block.visible = group.view.expanded;
      this.renderToolGroup();
      this.toolNode = tool.node as TextRenderable;
      this.toolEntry = tool.entry;
      this.showLoading(actionLabel(event.name, event.args));
    } else {
      if (event.durationMs !== undefined) {
        (this.session.toolStats ??= []).push({
          name: event.name,
          durationMs: event.durationMs,
          error: event.state === "error",
        });
      }
      const group = this.toolGroup;
      let pendingIndex = this.pendingTools.findIndex((tool) =>
        event.callId
          ? tool.callId === event.callId
          : tool.toolName === event.name && tool.rawArgs === event.args,
      );
      if (pendingIndex < 0 && !event.callId)
        pendingIndex = this.pendingTools.findIndex(
          (tool) => tool.toolName === event.name,
        );
      const child =
        pendingIndex < 0
          ? undefined
          : this.pendingTools.splice(pendingIndex, 1)[0];
      if (child) {
        // Old per-tool rendering: this row's own title, detail and panels.
        const title = `${event.state === "error" ? "✕" : "✓"} ${child.entry.text.split("\n")[0]!.slice(2)}${event.durationMs === undefined ? "" : ` · ${formatDuration(event.durationMs)}`}`;
        let input = event.args;
        if (event.name === "shell") {
          try {
            input = JSON.parse(event.args).command ?? event.args;
          } catch {
            /* Keep raw input. */
          }
        }
        child.entry.text =
          event.name === "shell"
            ? `${title}\n\nInput\n${brief(input, 12_000)}\n\nOutput\n${brief(event.output ?? "", 12_000)}`
            : `${title}\n\n${brief(event.output ?? "", 12_000)}`;
        child.entry.detail = {
          input,
          output: event.output ?? "",
          language: event.name === "shell" ? "TypeScript" : "JSON",
          toolName: event.name,
        };
        this.renderTool(child);
      }
      if (group) {
        group.running = Math.max(0, group.running - 1);
        if (event.state === "error") group.failures++;
        if (event.durationMs !== undefined) group.totalMs += event.durationMs;
        this.renderToolGroup();
      }
      this.toolNode = null;
      this.toolEntry = null;
    }
  }
  private applyGroupVisibility() {
    for (const group of this.activityGroups.values())
      for (const child of group.children)
        if (child.block && !child.block.isDestroyed)
          child.block.visible = group.head.expanded;
  }

  private renderToolGroup() {
    const group = this.toolGroup;
    if (!group) return;
    const done = group.count - group.running;
    group.entry.text =
      group.running > 0
        ? `→ Activity · ${done}/${group.count} done · ${brief(group.children.at(-1)?.entry.text.split("\n")[0]?.slice(2) ?? "Working", 70)}`
        : `${group.failures ? "✕" : "✓"} Activity · ${group.count} ${group.count === 1 ? "action" : "actions"} · ${formatDuration(group.totalMs)} total action time${group.failures ? ` · ${group.failures} failed` : ""}`;
    group.entry.text += `\nTechnical tools: ${group.names.join(", ")}\nExpand each action for its input, output and timing. Concurrent action times overlap.`;
    // Failures auto-expand the head so the failed row is visible.
    if (group.failures > 0 && group.running === 0) group.view.expanded = true;
    this.renderTool(group.view);
    this.applyGroupVisibility();
    // Group stays open for the whole turn (sequential tools included);
    // closed by checkpoint/flushResponse handlers.
  }

  private flushResponse() {
    this.toolGroup = null;
    if (this.pendingText && !this.closed) this.add("kest", this.pendingText);
    this.pendingText = "";
  }
  private showLoading(label: string) {
    this.tipRow.visible = false;
    this.status.fg = theme.tool;
    this.loadingLabel = label;
    if (this.loadingTimer) return;
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let frame = 0;
    const draw = () => {
      if (!this.closed) {
        const study = this.agent.research ?? this.session.research;
        const hud = study ? ` │ ${this.compactHudText()}` : "";
        const label = hud
          ? truncateMiddle(
              this.loadingLabel,
              Math.max(18, this.renderer.width - hud.length - 3),
            )
          : this.loadingLabel;
        this.status.content = `${frames[frame++ % frames.length]} ${label}${hud}`;
        this.status.fg =
          study && shouldOpenBudgetDecision(study) ? theme.error : theme.tool;
      }
    };
    draw();
    this.loadingTimer = setInterval(draw, 120);
    this.loadingTimer.unref();
  }
  private stopLoading() {
    if (this.loadingTimer) clearInterval(this.loadingTimer);
    this.loadingTimer = null;
  }

  private fillMenuSelection() {
    const menu = this.menu;
    if (!menu) return;
    const next = menu.items[menu.index]!;
    const filled = completionHasChildren(next) ? `${next} ` : next;
    this.menu = null;
    this.composer.setText(filled);
    this.composer.cursorOffset = filled.length;
    this.inputChanged();
  }

  private async submit(displayLabel?: string) {
    if (
      (this.active && this.rooms.focused?.kind !== "study") ||
      this.connectStep ||
      this.listPicker ||
      this.closed
    )
      return;
    if (this.menu?.touched && !displayLabel) {
      this.fillMenuSelection();
      return;
    }
    this.tabCycle = null;
    const draft = this.composer.plainText;
    const text = draft
      .replace(
        /\[Pasted text #\d+ · \d+ chars · \d+ lines\]/g,
        (label) => this.pastedTexts.get(label) ?? label,
      )
      .trim();
    if (!text) return;
    this.tipsBlockedByError = false;
    this.tipRow.visible = false;
    this.pastedTexts.clear();
    this.composer.setText("");
    this.hints.visible = false;
    this.tipRow.visible = false;
    this.inputHistory.push(text);
    this.historyIndex = this.inputHistory.length;
    const room = this.rooms.focused!;
    if (this.active) {
      // A study is running: slash commands that only read are fine; anything
      // else is direction for the director, delivered before its next step.
      if (text.startsWith("/")) {
        if (/^\/research\s+(wrapup|publish)(\s+now)?\s*$/i.test(text)) {
          // Typed while the study runs: switch the live director to stop-and-publish instead of refusing.
          room.agent.publishNow = true;
          room.agent.pendingNotes.push("Stop and publish now.");
          this.info("Stop and publish · no new reviews or experiments; the director will write the report and publish to LSI.");
          return;
        }
        if (!runningSafeCommand.test(text))
          this.info("Press Esc to pause this study before running that command.");
        else await this.command(text);
        return;
      }
      if (!displayLabel && wantsStopAndPublish(text)) room.agent.publishNow = true;
      room.agent.pendingNotes.push(text);
      this.add("you", text);
      this.info(
        room.agent.publishNow
          ? "Stop and publish · no more reviews or experiments; the director will write the report and publish to LSI."
          : "Direction queued · the director reads it before its next step.",
      );
      return;
    }
    if (
      !displayLabel &&
      this.session.research?.status === "budget_exhausted" &&
      /^(y|yes|yep|ok|okay|n|no|nope)$/i.test(text)
    ) {
      this.add("you", text);
      await this.answerFunding(/^(y|yes|yep|ok|okay)$/i.test(text));
      return;
    }
    if (!displayLabel && !text.startsWith("/") && room.kind === "study" && wantsStopAndPublish(text)) {
      this.info("Stop and publish · finishing the study without another review round.");
      await this.command("/research wrapup now");
      return;
    }
    let turn = false;
    try {
      if (text.startsWith("/")) {
        await this.command(text);
        return;
      }
      if (!this.credentials) {
        this.info(
          "Use /connect baseten, /connect modal or /connect nebius to add credentials.",
        );
        return;
      }
      if (displayLabel)
        this.add("info", displayLabel, {
          input: text,
          output:
            "Generated instructions sent to the research director. The exact text is retained here for inspection.",
          language: "text",
        });
      else this.add("you", text);
      if (this.session.title === "New session")
        this.session.title = text.replace(/\s+/g, " ").slice(0, 70);
      turn = true;
    } catch (error) {
      // Keep the real error even when the window is already gone (it would otherwise vanish with the screen).
      void import("node:fs/promises")
        .then(async (fs) => {
          const dir = process.env.KEST_CONFIG_DIR?.trim() || (await import("./config")).configDir;
          await fs.mkdir(dir, { recursive: true });
          await fs.appendFile(`${dir}/last-error.log`, `${new Date().toISOString()} submit: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}

`);
        })
        .catch(() => {});
      if (this.closed) return; // the window was closed mid-command; nothing left to draw on
      this.stopLoading();
      this.tipsBlockedByError = true;
      this.status.content = "Stopped · see error above";
      this.status.fg = theme.error;
      if (!this.showConnectionFailure(error)) this.info(this.errorText(error));
    } finally {
      if (!turn && !this.closed) {
        this.stopLoading();
        this.toolGroup = null;
        this.pendingText = "";
        if (!this.closed && !this.connectStep && !this.approval)
          this.composer.focus();
        if (this.pauseDecisionPending) {
          this.pauseDecisionPending = false;
          this.openPauseDecision();
        } else void this.wakeFromBackground();
        this.refreshTipRow();
      }
    }
    if (turn) await this.runTurn(room, text);
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
    if (command === "/inbox") {
      await this.inboxCommand(value);
      return;
    }
    if (command === "/research") {
      const [action, ...rest] = value.split(/\s+/);
      let parts = rest;
      let budgetOp: "set" | "add" | "remove" = "set";
      // "/research wrapup now" (or `publish now`): finish and publish without another review round.
      const wrapNow = action === "wrapup" && rest.at(-1) === "now";
      if (wrapNow) parts = rest.slice(0, -1);
      if (action === "budget" && ["set", "add", "remove"].includes(parts[0] ?? "")) {
        budgetOp = parts[0] as typeof budgetOp;
        parts = parts.slice(1);
      }
      if (action === "budget" && parts.length > 1) {
        const amount = parts.at(-1)!;
        const room = await this.resolveStudy(parts.slice(0, -1).join(" "));
        if (!room || !this.focusRoom(room)) return;
        parts = [amount];
      } else if ((action === "resume" || action === "wrapup") && parts.length) {
        const room = await this.resolveStudy(parts.join(" "));
        if (!room || !this.focusRoom(room)) return;
        parts = [];
      }
      if (
        (action === "budget" ||
          action === "resume" ||
          action === "wrapup" ||
          (action === "start" && !parts.length)) &&
        !(await this.restoreResearch())
      )
        return;
      if (action === "show" && parts.length) {
        const room = await this.resolveStudy(parts.join(" "));
        if (!room) return;
        await recoverCompany(this.cwd, room.study!);
        this.info(
          `${formatCompany(room.study)}\nSession: ${room.session.id.slice(0, 8)}\n/research open report|evidence|reviews|timeline ${room.session.id.slice(0, 8)}`,
        );
        return;
      }
      if (action === "show") {
        const sessions = (await listSessions(this.cwd)).map(
          (saved) => this.rooms.get(saved.id)?.session ?? saved,
        );
        const studies = [
          this.session,
          ...sessions.filter((saved) => saved.id !== this.session.id),
        ].filter((saved) => saved.research);
        for (const saved of studies)
          await recoverCompany(this.cwd, saved.research!);
        this.info(
          studies.length
            ? studies
                .map(
                  (saved) =>
                    `${formatCompany(saved.research)}${saved.researchEnabled === false ? "\nContinuation: off (saved study retained)" : ""}\nSession: ${saved.id.slice(0, 8)}${saved.id === this.session.id ? " (current)" : ` — /resume ${saved.id.slice(0, 8)} to open`}`,
                )
                .join("\n\n")
            : "No saved research in this workspace. /research prepare <objective> to prepare a study.",
        );
        return;
      }
      if (!value) {
        if (this.rooms.studies().length) this.openRoomPicker();
        else this.info(formatCompany(this.session.research));
        return;
      }
      if (action === "publish") {
        if (!lsiKey()) {
          this.info("Connect LSI first: /connect lsi");
          return;
        }
        const words = [...parts];
        const domainAt = words.findIndex((w) => /^domain=/.test(w));
        const domain = domainAt >= 0 ? words.splice(domainAt, 1)[0]!.slice(7) : "";
        const ready = (r: Room | null | undefined) => r?.kind === "study" && r.study?.status === "completed" && !!r.study.finalReportPath;
        const focusedStudy = this.rooms.focused?.kind === "study" ? this.rooms.focused : null;
        // With no name, prefer the focused study; if it isn't finished, use the one completed study that is.
        if (!words.length && !ready(focusedStudy)) await this.loadSavedStudies();
        const finished = this.rooms.studies().filter(ready);
        const room = words.length
          ? await this.resolveStudy(words.join(" "))
          : ready(focusedStudy)
            ? focusedStudy
            : finished.length === 1
              ? finished[0]!
              : focusedStudy;
        if (!words.length && room && room !== focusedStudy && ready(room)) this.info(`Publishing the completed study "${room.title.slice(0, 40)}".`);
        if (!room || !this.focusRoom(room)) {
          if (!room && !words.length) this.info("/research publish [domain=<id>] [study]  (open a study or name one)");
          return;
        }
        const study = room.study!;
        if (study.status !== "completed" || !study.finalReportPath) {
          this.info(`Not ready: publishing needs a completed, reviewed study. Use /research wrapup ${room.title.slice(0, 20)} to finish and publish in one step.`);
          return;
        }
        const blocker = this.rooms.startBlocker(room);
        if (blocker) {
          this.info(blocker);
          return;
        }
        this.info("Publishing to LSI… (domains, question link, then lsi_publish)");
        room.agent.publishRequested = true;
        this.composer.setText(publishPrompt(study, domain));
        await this.submit("Publish instructions · expand to inspect");
        return;
      }
      if (action === "open") {
        const words = [...parts];
        const tab = (studyTabs as readonly string[]).includes(words[0] ?? "")
          ? (words.shift() as StudyTab)
          : null;
        const only = this.rooms.studies();
        const room = words.length
          ? await this.resolveStudy(words.join(" "))
          : this.rooms.focused?.kind === "study"
            ? this.rooms.focused
            : only.length === 1
              ? only[0]!
              : null;
        if (!room) {
          if (!words.length)
            this.info("/research open [report|evidence|reviews|timeline] <study>");
          return;
        }
        const study = room.study!;
        const show = async (which: StudyTab) =>
          this.info(
            formatStudyTab(which, await loadStudyArtifacts(this.cwd, study), study.id),
          );
        if (tab) await show(tab);
        else
          this.openListPicker(
            `Open which part of "${room.title}"?`,
            ["Report", "Evidence", "Reviews", "Timeline"],
            [...studyTabs],
            (which) => void show(which as StudyTab),
          );
        return;
      }
      if (action === "total") {
        const limits = this.rooms.limits;
        if (!parts.length) {
          this.info(
            `Total research allowance: ${limits.totalUsd === null ? "none" : `$${limits.totalUsd.toFixed(2)}`} · spent across studies $${this.rooms.totalSpentUsd().toFixed(2)}\n/research total 30$ sets it · /research total off removes it`,
          );
          return;
        }
        limits.totalUsd =
          parts[0] === "off" ? null : parseCostBudget(parts[0]!);
        await saveCompanyLimits(limits);
        this.info(
          limits.totalUsd === null
            ? "Total allowance removed. Each study keeps its own budget."
            : `Total allowance $${limits.totalUsd.toFixed(2)} across all studies. Running studies pause when it is reached.`,
        );
        this.enforceAllowance();
        this.drawBar();
        return;
      }
      if (action === "parallel") {
        const limits = this.rooms.limits;
        if (!parts.length) {
          this.info(`Studies may run at once: ${limits.maxRunning} · /research parallel <1-10>`);
          return;
        }
        const n = Number(parts[0]);
        if (!Number.isInteger(n) || n < 1 || n > 10) {
          this.info("/research parallel <1-10>");
          return;
        }
        limits.maxRunning = n;
        await saveCompanyLimits(limits);
        this.info(`Up to ${n} studies may run at once.`);
        return;
      }
      if (action === "autopublish") {
        const study = this.rooms.focused?.session.research;
        if (!study) {
          this.info("Open a study room first, then /research autopublish on|off.");
          return;
        }
        study.autoPublish = parts[0] !== "off";
        await saveSession(this.rooms.focused!.session);
        this.info(study.autoPublish ? "Auto-publish on: this study claims the best-fit LSI question and publishes without asking each time." : "Auto-publish off: LSI claim/post/publish will ask for approval.");
        return;
      }
      if (action === "startall") {
        this.info(await this.startAllPrepared());
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
        if (!(await this.prepareResearch(objective))) return;
        this.add(
          "info",
          "Research prepared · set a budget with /research budget 10$",
          {
            input: objective,
            output: formatCompany(this.session.research),
            language: "text",
          },
        );
        return;
      }
      if (action === "model") {
        const [alias, provider, model] = parts;
        if (!alias || !provider || !model || parts.length !== 3)
          throw new Error(
            "/research model <alias> <modal|baseten|nebius> <model-id>",
          );
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
        this.session.researchEnabled = false;
        await saveSession(this.session);
        this.ready();
        this.info(
          "Research is off. Saved objective, budget and artifacts are preserved. /research show to inspect; /research start or /research resume to enable again.",
        );
        return;
      }
      if (action === "tokens") {
        this.info(
          "Research uses a USD budget now. Use /research budget 10$. Token usage remains visible under /usage.",
        );
        return;
      }
      if (action === "budget") {
        const study = this.session.research;
        if (!study || parts.length !== 1)
          throw new Error(
            "Prepare a research objective first, then /research budget set 10$ (or add 5$ / remove 5$).",
          );
        const amount = parseCostBudget(parts[0]!);
        await recoverCompany(this.cwd, study);
        if (budgetOp !== "set" && study.maxCostUsd === null)
          throw new Error(
            `No budget is set yet. Use /research budget set ${parts[0]} first.`,
          );
        const total =
          budgetOp === "set"
            ? amount
            : Math.round(
                (study.maxCostUsd! + (budgetOp === "add" ? amount : -amount)) * 100,
              ) / 100;
        if (total < 0.01)
          throw new Error(
            `Cannot remove $${amount.toFixed(2)}: the budget is only $${study.maxCostUsd!.toFixed(2)}.`,
          );
        if (study.status === "completed") {
          this.info(
            "This study is complete; its budget and result are preserved. /research show to inspect, or /research prepare <objective> for a new study.",
          );
          return;
        }
        const used = study.spentCostMicros + study.estimatedCostMicros;
        if (Math.round(total * 1_000_000) < used)
          throw new Error(
            `Budget cannot be below $${(used / 1_000_000).toFixed(4)} already spent or reserved.`,
          );
        study.maxCostUsd = total;
        if (study.status !== "ready")
          study.status =
            Math.round(total * 1_000_000) > used
              ? "paused"
              : "budget_exhausted";
        if (this.session.researchEnabled !== false) this.agent.research = study;
        await saveSession(this.session);
        this.add(
          "info",
          `Budget ${budgetOp === "set" ? "set" : budgetOp === "add" ? `raised by $${amount.toFixed(2)}` : `lowered by $${amount.toFixed(2)}`} · $${total.toFixed(2)} total · ${study.status === "ready" ? "/research start" : "/research show for next steps"}`,
          {
            input: `Total allowance: $${total.toFixed(2)} USD. Existing consumption is preserved.`,
            output: formatCompany(study),
            language: "text",
          },
        );
        this.ready();
        return;
      }
      const startPrepared = action === "start" && !parts.join(" ").trim();
      if (startPrepared && !this.session.research) {
        this.info(
          "Prepare an objective with /research prepare <objective> (or /research start <objective>).\nThen set /research budget 10$ and run /research start.\nConnect a model provider with /connect if needed.",
        );
        return;
      }
      if (!this.credentials) {
        this.info("Connect a model provider first with /connect.");
        return;
      }
      if (action === "resume" || action === "wrapup" || startPrepared) {
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
        if (!(await this.prepareResearch(objective))) return;
      }
      const study = this.session.research!;
      await recoverCompany(this.cwd, study);
      if (study.maxCostUsd === null) {
        this.session.goal = study.objective;
        this.agent.research = study;
        await saveSession(this.session);
        this.info(
          "Research prepared. Set /research budget 10$ then /research start. No model calls made.",
        );
        return;
      }
      if (study.status === "completed" && action === "wrapup" && study.finalReportPath) {
        this.info("Study already complete · publishing the report to LSI.");
        await this.command("/research publish");
        return;
      }
      if (study.status === "completed") {
        this.info(
          "This research study is complete. Start a new objective with /research prepare <objective>.",
        );
        return;
      }
      if (action === "wrapup" && study.status === "ready") {
        this.info(
          "Nothing to wrap up yet: this study has not started. Run /research start first.",
        );
        return;
      }
      const blocker = this.rooms.startBlocker(this.rooms.focused!);
      if (blocker) {
        this.info(blocker);
        return;
      }
      this.session.goal = study.objective;
      this.session.researchEnabled = true;
      this.agent = this.makeAgent(
        this.agent.messages,
        this.session.goal,
        this.agent.context,
      );
      this.session.messages = this.agent.messages;
      this.agent.research = study;
      this.agent.publishNow = wrapNow;
      this.agent.wrappingUp = action === "wrapup";
      this.agent.tasks = this.session.tasks.map((t) => ({ ...t }));
      await saveSession(this.session);
      this.info(
        `${action === "wrapup" ? "Wrapping up" : study.status === "ready" ? "Starting" : "Resuming"} research · $${study.maxCostUsd.toFixed(2)} total allowance\nEsc to pause · /agents for workers · /research show for status`,
      );
      if (tavilyKey())
        this.info(
          "This allowance covers model calls. Tavily requests use separate credits.",
        );
      this.composer.setText(
        action === "wrapup"
          ? wrapupPrompt(wrapNow)
          : study.status === "ready"
            ? `Research objective: ${study.objective}\nUse the research company workflow. Save reproducible evidence in research/${study.id}/. Check research_status for the shared allowance. Reserve funding for independent review; call research_complete only with a reviewed report.`
            : `Resume research/${study.id}/ from the saved checkpoint. Objective: ${study.objective}\nUse research_status for spending. Read the saved report, worker findings and relevant evidence before choosing the next unresolved task. Do not repeat completed experiments or read the whole event journal for status. Keep the shared allowance and obtain independent review before research_complete.`,
      );
      await this.submit("Research instructions · expand to inspect");
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
        this.tipsBlockedByError = true;
        this.tipRow.visible = false;
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
      if (arg === "tavily") {
        this.startTavilyEntry();
        return;
      }
      if (arg === "lsi") {
        this.startLsiEntry();
        return;
      }
      if (!arg) {
        this.openProviderPicker();
        return;
      }
      if (arg === "modal" || arg === "baseten" || arg === "nebius") {
        this.connect(arg);
        return;
      }
      this.info(
        "Usage: /connect [modal|baseten|nebius|tavily]\n/connect baseten  Baseten API key\n/connect modal  Modal token ID + secret\n/connect nebius  Nebius Token Factory API key\n/connect tavily  Tavily web tools API key",
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
          "Connect first: /connect baseten, /connect modal or /connect nebius, then send any message to begin.",
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
    if (command === "/tips") {
      if (value === "on" || value === "off") {
        await this.setTips(value === "on");
        this.info(
          value === "on"
            ? "Tips are on."
            : "Tips are hidden. /tips on brings them back.",
        );
      } else {
        this.info(
          `Tips are ${this.tipsEnabled ? "on" : "off"}. /tips on|off  (or click × on the tip row)`,
        );
      }
      return;
    }
    if (command === "/rooms") {
      this.openRoomPicker();
      return;
    }
    if (command === "/chat") {
      const chat = this.rooms.list().find((room) => room.kind === "chat");
      if (chat && this.focusRoom(chat)) return;
      return;
    }
    if (command === "/usage" || command === "/tokens") {
      await flushUsage();
      const sessions = await allSessions(this.session);
      this.info(
        formatUsage(await loadUsage(), {
          sessions: sessions.length,
          workspaces: new Set(sessions.map((s) => s.cwd)).size,
        }) +
          "\n\n" +
          formatModelCosts(await loadUsage()),
      );
      return;
    }
    if (command === "/stats") {
      await flushUsage();
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
          this.tipsBlockedByError = true;
          this.tipRow.visible = false;
          if (!this.closed)
            this.info(
              error instanceof Error
                ? error.message
                : "Context summary failed; original history retained.",
            );
        } finally {
          this.active = null;
          this.stopLoading();
          if (!this.closed) this.ready(false);
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
          `No provider connected.\nbaseten  ${BASETEN_MODEL}\nmodal  ${MODAL_MODEL}\nnebius  ${NEBIUS_MODEL}\n\n/connect baseten, /connect modal or /connect nebius`,
        );
      }
      return;
    }
    if (command === "/help") {
      this.info(
        "Research: /research (pick a study) · prepare <objective> · start · resume|wrapup|budget [study] · open [report|evidence|reviews|timeline] [study] · total <USD>$ · parallel <1-10> · /rooms or Ctrl+K switches · /chat leaves a study · /agents [id] inspects workers",
      );
      this.info(
        "/connect [modal|baseten|nebius|tavily]  credentials (provider switcher)\n/provider  current provider and model\n/model  list models and select one\n/research start|prepare|resume|wrapup|budget  research company, model profiles and budgets\n/rooms  switch between chat and running studies (Ctrl+K)\n/chat  leave a study room, keep it running\n/context  context size, memory, archives and compaction\n/usage  token usage, pricing and estimated cost (this machine)\n/stats  all-time tool counts and timings across sessions (ms)\n/permission [all|minimal|strict]  approval level\n/browser [url|tabs|close]  control the visible browser\n/goal <text>|clear  session objective\n/tasks  plan checklist and progress\n/new  fresh session\n/sessions  saved workspace sessions\n/resume <id>  reopen a session\n/tools  available tools\n/status  model and connection\n/system <instructions>  customize agent (new session)\n/exit  quit\n\nEnter send · Shift+Enter or Ctrl+Enter newline · Tab completes commands + subcommands (/res → /research, /research b → /research budget)\nUp/Down prompt history · Mouse wheel or PgUp/PgDn scroll\nAlt+Left/Right previous/next tip · clickable ‹ / › above input\nEdits and shell commands require y/n approval.",
      );
      return;
    }
    if (command === "/tools") {
      this.info(
        `${this.agent.toolDefs().length} tools available\n` +
          (tavilyKey()
            ? tavilyConnectionMessage.replace(
                "Tavily connected · your model provider is unchanged.\n\nNew tools:",
                "Tavily web tools:",
              ) + "\n\n"
            : "Tavily: /connect tavily adds web search, extraction, mapping, crawling and remote research.\n\n") +
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
        `${this.credentials ? `${this.credentials.provider === "nebius" ? "Nebius" : this.credentials.provider === "baseten" ? "Baseten" : "Modal"} credentials loaded; access checked on request` : "Not connected"}\n${model ? `Model: ${model}${selected ? " (selected)" : " (default)"}` : `baseten  ${BASETEN_MODEL}\nmodal  ${MODAL_MODEL}\nnebius  ${NEBIUS_MODEL}`}\n${endpoint ? `${endpoint.baseURL}\n` : ""}${this.credentials ? `${this.describeKeys(this.credentials.provider)}\n` : ""}Usage (this machine): in ${totals.input.toLocaleString("en-US")} · out ${totals.output.toLocaleString("en-US")} · /usage for details\nGoal: ${this.session.goal ?? "none — /goal <objective>"}\nWorkspace: ${this.cwd}\nCredentials: ${configPath}\nSession: ${this.session.id}`,
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
      const saved = matches[0]!;
      if (saved.research) {
        await recoverCompany(this.cwd, saved.research);
        if (saved.research.status === "running")
          saved.research.status = "paused";
      }
      if (saved.research) {
        const room = this.rooms.get(saved.id);
        this.openStudy(room ? room.session : saved);
        return;
      }
      if (this.rooms.focused?.kind === "study") {
        const chat = this.rooms.list().find((room) => room.kind === "chat");
        if (!chat || !this.focusRoom(chat)) return;
      }
      this.openSession(saved);
      return;
    }
    if (command === "/new" || command === "/system") {
      if (command === "/system" && !value) {
        this.info("Usage: /system <instructions>");
        return;
      }
      if (this.rooms.focused?.kind === "study") {
        const chat = this.rooms.list().find((room) => room.kind === "chat");
        if (!chat || !this.focusRoom(chat)) return;
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
    const guess = suggestCommand(command);
    this.composer.setText(text);
    this.composer.cursorOffset = text.length;
    this.info(
      guess
        ? `Unknown command ${command}. Did you mean ${guess}? Your text is still in the prompt. /help lists commands.`
        : `Unknown command ${command}. Your text is still in the prompt. /help lists commands.`,
    );
  }
  private clearView() {
    this.workerViews.clear();
    this.teamGroup = null;
    this.toolGroup = null;
    this.groupHeads.clear();
    this.activityGroups.clear();
    this.toolViews = new WeakMap<TextRenderable, ToolView>();
    this.lastTool = null;
    this.toolNode = null;
    this.toolEntry = null;
    this.pendingTools = [];
    this.unseenActivity = false;
    this.activity.visible = false;
    this.scroll.stickyScroll = true;
    for (const child of this.scroll.getChildren()) child.destroyRecursively();
  }
  private barTimer: ReturnType<typeof setInterval> | null = null;
  // Spend and status of background studies change without any UI event.
  private startBarTimer() {
    if (this.barTimer) return;
    this.barTimer = setInterval(() => {
      if (this.rooms.running().length) {
        this.enforceAllowance();
        this.drawBar();
      }
    }, 1000);
    this.barTimer.unref?.();
  }
  // Pause every running study once combined spend reaches the company allowance.
  private enforceAllowance() {
    for (const room of this.rooms.overAllowance()) {
      const cap = this.rooms.limits.totalUsd!;
      this.pauseRoom(
        room,
        `Paused: total research allowance $${cap.toFixed(2)} reached across all studies. Raise it with /research total <amount>$, then /research resume.`,
      );
    }
  }
  private pauseRoom(room: Room, reason: string) {
    const study = room.study;
    if (!study || !room.running) return;
    if (study.status !== "ready") study.status = "paused";
    room.session.research = study;
    void saveSession(room.session).catch(() => {});
    room.agent.cancelBackground();
    room.controller?.abort();
    if (room === this.rooms.focused) this.info(reason);
    else room.buffer.push({ type: "note", text: reason });
  }
  private async resolveStudy(query: string): Promise<Room | null> {
    await this.loadSavedStudies();
    const matches = this.rooms.find(query);
    if (matches.length === 1) return matches[0]!;
    this.info(
      matches.length
        ? `Several studies match "${query}":\n${matches.map((r) => `• ${r.title} (${r.session.id.slice(0, 8)})`).join("\n")}\nBe more specific.`
        : `No study matches "${query}". /research show lists them.`,
    );
    return null;
  }
  private openRoomPicker() {
    if (this.approval || this.connectStep || this.listPicker) return;
    const rooms = this.rooms.list();
    const here = this.rooms.focused;
    const labels = rooms.map((room) => {
      const study = room.study;
      const spend =
        study && study.maxCostUsd !== null
          ? `  $${studySpentUsd(study).toFixed(1)}/${study.maxCostUsd}`
          : "";
      return `${statusSymbol(room.status)} ${room.title}${spend}  ${room.status}${room === here ? "  (here)" : ""}`;
    });
    this.openListPicker(
      "Rooms · Enter opens · Esc closes",
      labels,
      rooms.map((room) => room.id),
      (id) => {
        const room = this.rooms.get(id);
        if (room) this.focusRoom(room);
      },
    );
    const picker = this.listPicker as KestUI["listPicker"];
    if (picker && here) {
      picker.selected = Math.max(0, rooms.indexOf(here));
      this.drawListPicker();
    }
  }
  private stopAllRooms() {
    if (this.barTimer) clearInterval(this.barTimer);
    this.barTimer = null;
    for (const room of this.rooms.list()) {
      room.controller?.abort();
      room.agent.cancelBackground();
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.inbox.closeAll();
    this.stopAllRooms();
    this.approval?.finish(false);
    this.secretValue = this.tokenId = "";
    this.stopLoading();
    if (this.toastTimer) clearTimeout(this.toastTimer);
    for (const room of this.rooms.list()) void room.browser.close();
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
  await ui.restoreLastChat();
  await ui.showSavedResearchHint();
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
