import { createTestRenderer } from "@opentui/core/testing";
import { KestUI } from "../src/ui";
import { chromium } from "playwright-core";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Render real Kest UI states with an isolated config and no provider calls.
// These are native-renderer captures, not desktop screenshots.
const config = await mkdtemp(join(tmpdir(), "kest-readme-"));
const previous = process.env.KEST_CONFIG_DIR;
process.env.KEST_CONFIG_DIR = config;
await mkdir("docs/images", { recursive: true });
const terminal = await createTestRenderer({ width: 112, height: 24 });
const ui = new KestUI(terminal.renderer, "D:\\projects\\kest", null);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 2 });
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
async function capture(name: string, title: string) {
  await terminal.renderOnce();
  const frame = terminal.captureSpans();
  const lines = frame.lines.map(line => line.spans.map(span => {
    const fg = span.fg.toInts().slice(0, 3).join(",");
    const bg = span.bg.toInts().slice(0, 3).join(",");
    return `<span style="color:rgb(${fg});background:rgb(${bg});display:inline-block;width:${span.width}ch">${escape(span.text)}</span>`;
  }).join("")).join("\n");
  await page.setContent(`<html><style>*{box-sizing:border-box}body{margin:0;padding:36px;background:#101923;font-family:Consolas,monospace}.window{border:1px solid #304052;border-radius:12px;overflow:hidden;box-shadow:0 20px 50px #0006;background:#0c111b}.bar{height:46px;background:#182230;display:flex;align-items:center;padding:0 20px;gap:9px;color:#a8b5c9;font:13px 'Segoe UI',sans-serif}.dot{width:10px;height:10px;border-radius:50%;background:#50dca0}.title{margin-left:12px}pre{margin:0;padding:22px;font:16px/23px Consolas,monospace;white-space:pre}.note{color:#75869b;font:12px 'Segoe UI',sans-serif;text-align:right;margin-top:14px}</style><div class="window"><div class="bar"><i class="dot"></i><span class="title">${escape(title)}</span></div><pre>${lines}</pre></div><div class="note">Kest v0.1.0 · native UI renderer capture · no model calls</div></html>`);
  await page.screenshot({ path: `docs/images/${name}.png`, fullPage: true });
}
try {
  ui.composer.setText("Read this project and explain how its pieces fit together.");
  await capture("terminal", "kest / your workspace");
  ui.composer.setText("");
  await ui["command"]("/research prepare Compare indexing algorithms using reproducible benchmarks.");
  await ui["command"]("/research budget 10$");
  ui["clearView"]();
  await ui["command"]("/research show");
  ui.composer.setText("/research start");
  await capture("research", "kest / prepared research");
} finally {
  ui.close();
  await terminal.dispose();
  await browser.close();
  if (previous === undefined) delete process.env.KEST_CONFIG_DIR;
  else process.env.KEST_CONFIG_DIR = previous;
  await rm(config, { recursive: true, force: true });
}
