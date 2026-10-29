import type { Browser, BrowserContext, Page, Locator } from "playwright-core";

export const browserActions = [
  "batch",
  "open",
  "navigate",
  "tabs",
  "new_tab",
  "switch",
  "close_tab",
  "snapshot",
  "click",
  "fill",
  "press",
  "select",
  "back",
  "forward",
  "close",
] as const;
export type BrowserAction = (typeof browserActions)[number];
export type BrowserRequest = {
  action: BrowserAction;
  url?: string;
  tab?: string;
  role?: string;
  name?: string;
  selector?: string;
  index?: number;
  value?: string;
  key?: string;
  detail?: "none" | "compact" | "full";
  steps?: BrowserRequest[];
};

export function browserRequest(args: Record<string, unknown>): BrowserRequest {
  if (!browserActions.includes(args.action as BrowserAction))
    throw new Error("Unknown browser action.");
  for (const field of [
    "url",
    "tab",
    "role",
    "name",
    "selector",
    "value",
    "key",
  ])
    if (args[field] !== undefined && typeof args[field] !== "string")
      throw new Error(`${field} must be a string.`);
  if (
    args.index !== undefined &&
    (!Number.isInteger(args.index) || Number(args.index) < 0)
  )
    throw new Error("index must be a nonnegative integer.");
  if (args.url !== undefined) {
    const url = new URL(String(args.url));
    if (
      !["https:", "http:"].includes(url.protocol) &&
      url.href !== "about:blank"
    )
      throw new Error("Browser URLs must use http or https.");
  }
  if (
    args.detail !== undefined &&
    !["none", "compact", "full"].includes(String(args.detail))
  )
    throw new Error("detail must be none, compact, or full.");
  if (args.action === "batch") {
    if (
      !Array.isArray(args.steps) ||
      !args.steps.length ||
      args.steps.length > 12
    )
      throw new Error("batch requires 1–12 steps.");
    args.steps = args.steps.map((step) => {
      if (
        !step ||
        typeof step !== "object" ||
        !["fill", "click", "press", "select", "navigate"].includes(step.action)
      )
        throw new Error(
          "Batch steps may only fill, click, press, select, or navigate.",
        );
      return browserRequest({ ...step });
    });
  }
  return args as BrowserRequest;
}

export class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private opening: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private pages = new Map<string, Page>();
  private active: string | null = null;
  private nextId = 1;
  constructor(
    private options: { headless?: boolean; channel?: "chrome" | "msedge" } = {},
    private owner: BrowserSession | null = null,
  ) {}

  // Workers share the root browser/context, but keep their own active tab and
  // tab registry so parallel navigation cannot redirect another worker.
  fork() {
    return new BrowserSession(this.options, this.owner ?? this);
  }

  private register(page: Page) {
    const existing = [...this.pages].find(([, p]) => p === page)?.[0];
    if (existing) return existing;
    const id = `tab-${this.nextId++}`;
    this.pages.set(id, page);
    this.active = id;
    page.on("popup", (popup) => this.register(popup));
    page.on("close", () => {
      this.pages.delete(id);
      if (this.active === id)
        this.active = this.pages.keys().next().value ?? null;
    });
    return id;
  }

  private async ensure() {
    if (this.closing) await this.closing;
    if (this.owner) {
      if (!this.opening)
        this.opening = (async () => {
          await this.owner!.ensure();
          this.context = this.owner!.context;
          if (!this.pages.size) this.register(await this.context!.newPage());
        })().finally(() => {
          this.opening = null;
        });
      await this.opening;
      return;
    }
    if (this.context) return;
    if (!this.opening)
      this.opening = (async () => {
        const { chromium } = await import("playwright-core");
        const channels = this.options.channel
          ? [this.options.channel]
          : (["chrome", "msedge"] as const);
        let error: unknown;
        for (const channel of channels) {
          try {
            this.browser = await chromium.launch({
              channel,
              headless: this.options.headless ?? false,
              timeout: 15_000,
            });
            break;
          } catch (e) {
            error = e;
          }
        }
        if (!this.browser)
          throw new Error(
            `Could not open a browser. Install Chrome or Edge. ${String(error).slice(0, 300)}`,
          );
        const browser = this.browser;
        browser.on("disconnected", () => {
          if (this.browser !== browser) return;
          this.browser = null;
          this.context = null;
          this.pages.clear();
          this.active = null;
        });
        try {
          this.context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
          });
          this.context.setDefaultTimeout(10_000);
          this.context.setDefaultNavigationTimeout(20_000);
          this.register(await this.context.newPage());
        } catch (e) {
          await browser.close();
          throw e;
        }
      })().finally(() => {
        this.opening = null;
      });
    await this.opening;
  }

  async close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      await this.opening?.catch(() => {});
      if (this.owner) {
        await Promise.all([...this.pages.values()].map((page) => page.close()));
        this.pages.clear();
        this.active = null;
        this.context = null;
        return;
      }
      const browser = this.browser;
      this.browser = null;
      this.context = null;
      this.pages.clear();
      this.active = null;
      await browser?.close();
    })().finally(() => {
      this.closing = null;
    });
    return this.closing;
  }

  private page(tab?: string) {
    const id = tab ?? this.active;
    const page = id ? this.pages.get(id) : undefined;
    if (!page || page.isClosed())
      throw new Error("Tab not found. Use tabs or open/new_tab first.");
    return { page, id: id! };
  }

  private target(page: Page, args: BrowserRequest): Locator {
    let locator: Locator;
    if (args.role && args.name)
      locator = page.getByRole(args.role as Parameters<Page["getByRole"]>[0], {
        name: args.name,
        exact: true,
      });
    else if (args.selector) locator = page.locator(args.selector);
    else
      throw new Error(
        "Use an observed role and name, or an observed selector, to target an element.",
      );
    return args.index === undefined ? locator : locator.nth(args.index);
  }

  private async tabs() {
    return Promise.all(
      [...this.pages].map(async ([id, page]) => ({
        tab: id,
        active: id === this.active,
        url: page.url(),
        title: await page.title().catch(() => ""),
      })),
    );
  }

  private async snapshot(page: Page, id: string, full = false) {
    if (full) {
      const [title, snapshot, tabs] = await Promise.all([
        page.title(),
        page.locator("body").ariaSnapshot({ timeout: 5_000 }),
        this.tabs(),
      ]);
      return {
        tab: id,
        url: page.url(),
        title,
        tabs,
        snapshot:
          snapshot.length > 16_000
            ? snapshot.slice(0, 16_000) + "\n[truncated]"
            : snapshot,
      };
    }
    // One browser RPC rather than a full accessibility traversal plus one title RPC per tab.
    const capture = () =>
      page.evaluate(() => {
        const elements: {
          name: string;
          selector: string;
          index?: number;
          value?: string;
          href?: string;
        }[] = [];
        for (const element of document.querySelectorAll(
          'a,button,input,select,textarea,[role="button"],[role="link"],[role="textbox"],[role="searchbox"]',
        )) {
          if (
            !(element instanceof HTMLElement) ||
            !element.getClientRects().length ||
            getComputedStyle(element).visibility === "hidden"
          )
            continue;
          const field = element as HTMLInputElement;
          const name = (
            element.getAttribute("aria-label") ||
            field.labels?.[0]?.innerText ||
            element.innerText ||
            element.getAttribute("placeholder") ||
            element.getAttribute("title") ||
            element.tagName
          )
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120);
          const selector = element.id
            ? `#${CSS.escape(element.id)}`
            : element.tagName.toLowerCase();
          const item: (typeof elements)[number] = { name, selector };
          if (!element.id)
            item.index = Array.from(
              document.getElementsByTagName(element.tagName),
            ).indexOf(element);
          if (
            (element instanceof HTMLInputElement &&
              element.type !== "password") ||
            element instanceof HTMLTextAreaElement ||
            element instanceof HTMLSelectElement
          )
            item.value = field.value.slice(0, 200);
          if (element instanceof HTMLAnchorElement) item.href = element.href;
          elements.push(item);
          if (elements.length === 40) break;
        }
        const text =
          ((document.querySelector("main") as HTMLElement) ?? document.body)
            ?.innerText ?? "";
        return {
          title: document.title,
          url: location.href,
          readyState: document.readyState,
          text: text.slice(0, 3500),
          elements,
        };
      });
    let data;
    try {
      data = await capture();
    } catch (error) {
      if (
        !/Execution context was destroyed|Cannot find context/i.test(
          String(error),
        )
      )
        throw error;
      await page.waitForLoadState("domcontentloaded");
      data = await capture();
    }
    return {
      tab: id,
      title: data.title,
      url: data.url,
      readyState: data.readyState,
      tabs: [...this.pages].map(([tab, p]) => ({
        tab,
        active: tab === this.active,
        url: p.url(),
      })),
      snapshot: JSON.stringify({ text: data.text, elements: data.elements }),
      detail: "compact",
    };
  }

  async execute(args: BrowserRequest, signal: AbortSignal): Promise<string> {
    args = browserRequest({ ...args });
    const started = performance.now();
    if (args.action === "batch") {
      const completed: unknown[] = [];
      let lastTab = args.tab;
      for (const [index, step] of args.steps!.entries()) {
        try {
          const result = JSON.parse(
            await this.execute(
              { ...step, tab: step.tab ?? lastTab, detail: "none" },
              signal,
            ),
          );
          lastTab = result.tab;
          completed.push({
            step: index + 1,
            action: step.action,
            timing: result.timing,
          });
        } catch (error) {
          throw new Error(
            `Batch stopped at step ${index + 1}; ${completed.length} steps completed. ${String(error)}`,
          );
        }
      }
      const result = JSON.parse(
        await this.execute(
          {
            action: "snapshot",
            tab: lastTab,
            detail: args.detail ?? "compact",
          },
          signal,
        ),
      );
      return JSON.stringify({
        ...result,
        completed,
        timing: {
          totalMs: Math.round((performance.now() - started) * 100) / 100,
        },
      });
    }
    signal.throwIfAborted();
    if (args.action === "close") {
      await this.close();
      return "Kest browser closed.";
    }
    if (args.action === "tabs")
      return JSON.stringify(await this.tabs(), null, 2);
    if (args.action === "snapshot" && !this.context)
      throw new Error("Browser is not open. Use open first.");
    await this.ensure();
    signal.throwIfAborted();
    // Playwright has per-action timeouts. Closing the current page also interrupts an aborted action.
    let current: Page | undefined;
    const abort = () => {
      if (current) void current.close().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (
        args.action === "new_tab" ||
        (!this.pages.size && args.action === "open")
      )
        this.register(await this.context!.newPage());
      const { page, id } = this.page(args.tab);
      current = page;
      this.active = id;
      if (args.action === "close_tab") {
        await page.close();
        return JSON.stringify({ closed: id, tabs: await this.tabs() }, null, 2);
      }
      if (!this.owner && ["switch", "open", "new_tab"].includes(args.action))
        await page.bringToFront();
      if (args.action === "navigate" && !args.url)
        throw new Error("navigate requires url.");
      if (["open", "new_tab", "navigate"].includes(args.action) && args.url) {
        const response = await page.goto(args.url, {
          waitUntil: args.detail === "none" ? "commit" : "domcontentloaded",
        });
        if (response && !response.ok())
          throw new Error(
            `Page returned HTTP ${response.status()}: ${page.url()}`,
          );
      }
      if (args.action === "back")
        await page.goBack({ waitUntil: "domcontentloaded" });
      if (args.action === "forward")
        await page.goForward({ waitUntil: "domcontentloaded" });
      if (args.action === "click") {
        const previousUrl = page.url();
        if (args.url && args.url !== previousUrl)
          await Promise.all([
            page.waitForURL((url) => url.href !== previousUrl, {
              waitUntil: "domcontentloaded",
            }),
            this.target(page, args).click({ noWaitAfter: true }),
          ]);
        else await this.target(page, args).click();
      }
      if (args.action === "fill") {
        if (args.value === undefined) throw new Error("fill requires value.");
        await this.target(page, args).fill(args.value);
      }
      if (args.action === "select") {
        if (args.value === undefined) throw new Error("select requires value.");
        await this.target(page, args).selectOption(args.value);
      }
      if (args.action === "press") {
        if (!args.key) throw new Error("press requires key.");
        if (args.role || args.selector)
          await this.target(page, args).press(args.key);
        else await page.keyboard.press(args.key);
      }
      signal.throwIfAborted();
      const actionMs = performance.now() - started;
      const detail =
        args.detail ?? (args.action === "snapshot" ? "full" : "compact");
      if (detail === "none")
        return JSON.stringify({
          tab: id,
          url: page.url(),
          action: args.action,
          completed: true,
          timing: { actionMs: +actionMs.toFixed(2), observeMs: 0 },
        });
      const observation = await this.snapshot(page, id, detail === "full");
      return JSON.stringify({
        ...observation,
        timing: {
          actionMs: +actionMs.toFixed(2),
          observeMs: +(performance.now() - started - actionMs).toFixed(2),
          totalMs: +(performance.now() - started).toFixed(2),
        },
      });
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
}
