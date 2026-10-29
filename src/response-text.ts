import {
  BoxRenderable,
  TextRenderable,
  StyledText,
  fg,
  bg,
  bold,
  italic,
  underline,
  type CliRenderer,
  type Renderable,
  type TextChunk,
} from "@opentui/core";
import { toolPanel, toolColors } from "./tool-display";
import { theme } from "./theme";

type Token = {
  type: string;
  text?: string;
  href?: string;
  lang?: string;
  tokens?: Token[];
  items?: Token[];
  start?: number | string;
  ordered?: boolean;
  checked?: boolean;
};
type Style = {
  color?: string;
  strong?: boolean;
  italic?: boolean;
  link?: string;
  showURLs?: boolean;
};
const safe = (text: string) =>
  text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const palette = {
  text: theme.fg,
  muted: theme.muted,
  heading: theme.accent,
  emphasis: theme.model,
  inline: theme.tool,
  inlineBg: theme.inlineBg,
  link: theme.user,
};

function inline(tokens: Token[], style: Style = {}): TextChunk[] {
  const chunks: TextChunk[] = [];
  const text = (value: string, code = false) => {
    let chunk = fg(code ? palette.inline : (style.color ?? palette.text))(
      safe(value),
    );
    if (code) chunk = bg(palette.inlineBg)(chunk);
    if (style.strong) chunk = bold(chunk);
    if (style.italic) chunk = italic(chunk);
    if (style.link) chunk = { ...underline(chunk), link: { url: style.link } };
    chunks.push(chunk);
  };
  for (const token of tokens) {
    const children = token.tokens ?? [{ type: "text", text: token.text ?? "" }];
    if (token.type === "codespan") text(token.text ?? "", true);
    else if (token.type === "strong")
      chunks.push(
        ...inline(children, {
          ...style,
          color: palette.emphasis,
          strong: true,
        }),
      );
    else if (token.type === "em")
      chunks.push(...inline(children, { ...style, italic: true }));
    else if (token.type === "link") {
      const href = safe(token.href ?? "");
      const clickable = /^https?:\/\//i.test(href);
      chunks.push(
        ...inline(children, {
          ...style,
          color: palette.link,
          ...(clickable ? { link: href } : {}),
        }),
      );
      if ((!clickable || style.showURLs) && href && href !== token.text)
        chunks.push(fg(palette.link)(` (${href})`));
    } else if (token.type === "br") text("\n");
    else if (token.tokens) chunks.push(...inline(token.tokens, style));
    else text(token.text ?? "");
  }
  return chunks;
}

// Render Markdown tokens directly, avoiding asynchronous grammar loading for final replies.
export function responseText(
  renderer: CliRenderer,
  value: unknown,
  color = palette.text,
): Renderable | undefined {
  const token = value as Token;
  const label = (content: StyledText | string) =>
    new TextRenderable(renderer, {
      content,
      fg: color,
      width: "100%",
      flexShrink: 0,
      wrapMode: "word",
      selectable: true,
      selectionBg: palette.heading,
      selectionFg: theme.bg,
    });
  if (["heading", "paragraph", "text"].includes(token.type)) {
    const node = label(
      new StyledText(
        inline(token.tokens ?? [{ type: "text", text: token.text ?? "" }], {
          color: token.type === "heading" ? palette.heading : color,
          strong: token.type === "heading",
          showURLs: renderer.capabilities?.hyperlinks !== true,
        }),
      ),
    );
    node.marginBottom = token.type === "text" ? 0 : 1;
    return node;
  }
  if (token.type === "code") {
    const language = safe(token.lang ?? "").split(/\s/)[0] ?? "";
    const box = new BoxRenderable(renderer, {
      width: "100%",
      flexDirection: "column",
      padding: 1,
      backgroundColor: toolColors.inputBg,
    });
    box.add(
      new TextRenderable(renderer, {
        content: language || "Code",
        fg: toolColors.input,
        height: 1,
        marginBottom: 1,
        selectable: false,
      }),
    );
    const code = label(
      toolPanel(
        safe(token.text ?? ""),
        ["ts", "typescript", "js", "javascript", "jsx", "tsx"].includes(
          language.toLowerCase(),
        )
          ? "TypeScript"
          : ["json", "jsonc"].includes(language.toLowerCase())
            ? "JSON"
            : "text",
      ),
    );
    box.add(code);
    return box;
  }
  if (token.type === "list") {
    const list = new BoxRenderable(renderer, {
      width: "100%",
      flexDirection: "column",
    });
    const items = token.items ?? [];
    const markers = items.map((item, i) =>
      typeof item.checked === "boolean"
        ? item.checked
          ? "[x] "
          : "[ ] "
        : token.ordered
          ? `${(Number(token.start) || 1) + i}. `
          : "• ",
    );
    const width = Math.max(2, ...markers.map((x) => x.length));
    for (const [i, item] of items.entries()) {
      const row = new BoxRenderable(renderer, {
        width: "100%",
        flexDirection: "row",
      });
      row.add(
        new TextRenderable(renderer, {
          content: markers[i],
          fg: palette.heading,
          width,
          flexShrink: 0,
          selectable: false,
        }),
      );
      const body = new BoxRenderable(renderer, {
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
        flexDirection: "column",
      });
      for (const child of item.tokens ?? [
        { type: "text", text: item.text ?? "" },
      ]) {
        const node = responseText(renderer, child, color);
        if (node) body.add(node);
      }
      row.add(body);
      list.add(row);
    }
    return list;
  }
  if (token.type === "blockquote") {
    const box = new BoxRenderable(renderer, {
      width: "100%",
      flexDirection: "column",
      paddingLeft: 2,
    });
    for (const child of token.tokens ?? [
      { type: "text", text: token.text ?? "" },
    ]) {
      const node = responseText(renderer, child, palette.muted);
      if (node) box.add(node);
    }
    return box;
  }
  return undefined;
}
