/** Line two of an Agents / Home row: an iMessage-style snippet of the
 *  newest message in the agent's main Thread, with inline Markdown kept
 *  (bold, italics, strike, `code`, links) and block Markdown flattened
 *  onto one line. Never the words "main chat". Shared by the Agents list
 *  and the Home list (render it with `RowSnippet`). */

/** Newest Thread item for one row, as the list needs it. `text` is the
 *  Markdown source (a choice card's prompt; empty for a secret card).
 *  `flat`: the text came whitespace-collapsed (server `thread/latest`
 *  preview), so line-based block rules cannot apply. */
export type RowLast = {
  at: number | null;
  seq: number | null;
  mine: boolean;
  kind: string;
  text: string;
  flat?: boolean;
};

export const NO_MESSAGES_TEXT = "No messages yet";
export const SECRET_TEXT = "Asked for a secret";
export const TABLE_MARKER = "[table]";
export const YOU_PREFIX = "You: ";

export type OverlayPreviewInput = {
  kind?: "agent" | "group";
  joinMiss?: string | null;
  addr?: string | null;
  name?: string | null;
  chatTitle?: string | null;
};

/** What line two shows. `loading` keeps the line's height, empty. */
export type RowPreview =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "label"; text: string }
  | { kind: "snippet"; mine: boolean; nodes: InlineNode[] };

const PROJECT_CHAT_LABEL: RowPreview = { kind: "label", text: "Project Chat" };

/** Line two for a row. `last` (from `previewByKey`): undefined = not
 *  fetched yet; null = the Thread has no messages. Render with `RowSnippet`. */
export function rowPreviewFor(
  row: OverlayPreviewInput,
  last?: RowLast | null
): RowPreview {
  if (row.kind === "group") return PROJECT_CHAT_LABEL;
  if (row.joinMiss) return { kind: "label", text: row.joinMiss };
  const addr = (row.addr || "").trim();
  if (addr.includes("/")) {
    // A separate session (not on the Agents list today): its own title.
    const title = (row.chatTitle || "").trim();
    return { kind: "label", text: title || addr.split("/").slice(1).join("/") || addr };
  }
  return lastPreview(last);
}

/** Line two as plain text (aria-labels, plain-string callers). */
export function overlayRowPreview(row: OverlayPreviewInput, last?: RowLast | null): string {
  return rowPreviewText(rowPreviewFor(row, last));
}

const LOADING: RowPreview = { kind: "loading" };
const EMPTY: RowPreview = { kind: "empty" };
/** Line two per `last` entry: the lists re-render often (activity polls,
 *  search keystrokes, unread), and a row's snippet is parsed once per
 *  message, not once per render — and is the same object, so a memoized
 *  RowSnippet skips. Checked against the fields it was made from. */
const parsed = new WeakMap<RowLast, { from: RowLast; preview: RowPreview }>();

export function lastPreview(last: RowLast | null | undefined): RowPreview {
  if (last === undefined) return LOADING;
  if (last === null) return EMPTY;
  const hit = parsed.get(last);
  if (
    hit &&
    hit.from.text === last.text &&
    hit.from.kind === last.kind &&
    hit.from.mine === last.mine &&
    hit.from.flat === last.flat
  ) {
    return hit.preview;
  }
  const preview = parseLastPreview(last);
  parsed.set(last, { from: { ...last }, preview });
  return preview;
}

function parseLastPreview(last: RowLast): RowPreview {
  if (last.kind === "secret") {
    return { kind: "snippet", mine: last.mine, nodes: [SECRET_TEXT] };
  }
  const nodes = snippetNodes(last.text, { flat: last.flat });
  if (!nodes.length) return { kind: "empty" };
  return { kind: "snippet", mine: last.mine, nodes };
}

/** Plain text of line two, for `aria-label`. Empty while loading. */
export function rowPreviewText(p: RowPreview): string {
  switch (p.kind) {
    case "loading":
      return "";
    case "empty":
      return NO_MESSAGES_TEXT;
    case "label":
      return p.text;
    case "snippet":
      return (p.mine ? YOU_PREFIX : "") + nodesText(p.nodes);
  }
}

// ─── Inline Markdown, one line ───

export type InlineNode =
  | string
  | { tag: "strong" | "em" | "del" | "link"; children: InlineNode[] }
  | { tag: "code"; text: string }
  | { tag: "marker"; text: string };

export function nodesText(nodes: InlineNode[]): string {
  let out = "";
  for (const n of nodes) {
    if (typeof n === "string") out += n;
    else if (n.tag === "code" || n.tag === "marker") out += n.text;
    else out += nodesText(n.children);
  }
  return out;
}

/** Source past this is never shown on one line; parsing it is waste. */
const SOURCE_CAP = 1200;
/** Flattened pieces stop once this many chars are queued. */
const LINE_CAP = 240;

type Piece =
  | { t: "inline"; md: string; list?: boolean; heading?: boolean }
  | { t: "code"; text: string }
  | { t: "marker" };

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$|^\s*\|\s*:?-{3,}:?\s*\|\s*$/;
const INLINE_TABLE_SEP = /\|\s*:?-{3,}:?\s*\|/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const LIST = /^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;
const QUOTE = /^\s{0,3}>\s?/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const LANGS = new Set(
  "ts tsx js jsx json bash sh zsh shell console rust rs python py go diff text txt html css scss yaml yml toml sql swift kotlin md markdown c cpp java ruby rb php".split(" ")
);

function blockPieces(src: string, flat: boolean): Piece[] {
  const pieces: Piece[] = [];
  let queued = 0;
  const push = (p: Piece) => {
    pieces.push(p);
    queued += p.t === "inline" ? p.md.length : p.t === "code" ? p.text.length : 6;
  };
  const lines = src.slice(0, SOURCE_CAP).split(/\r?\n/);
  for (let i = 0; i < lines.length && queued < LINE_CAP; i++) {
    let line = lines[i];
    while (QUOTE.test(line)) line = line.replace(QUOTE, "");
    if (!line.trim() || RULE.test(line)) continue;
    const fence = FENCE.exec(line);
    if (fence && !flat) {
      const close = fence[1];
      let first: string | null = null;
      for (i += 1; i < lines.length; i++) {
        const l = lines[i].replace(QUOTE, "");
        if (l.trim().startsWith(close[0].repeat(3)) && !l.trim().slice(close.length).trim()) break;
        if (first == null && l.trim()) first = l.trim();
      }
      if (first) push({ t: "code", text: first });
      continue;
    }
    if (!flat && line.includes("|") && TABLE_SEP.test(lines[i + 1] ?? "")) {
      i += 1;
      while (i + 1 < lines.length && lines[i + 1].includes("|") && lines[i + 1].trim()) i++;
      push({ t: "marker" });
      continue;
    }
    if (INLINE_TABLE_SEP.test(line)) {
      // A table squashed onto one line (flat preview): text before it, then the marker.
      const head = line.slice(0, line.indexOf("|")).trim();
      if (head) push({ t: "inline", md: head });
      push({ t: "marker" });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      // A flat preview has lost where the heading ends: drop the hashes only.
      push({ t: "inline", md: h[1], heading: !flat });
      continue;
    }
    const li = LIST.exec(line);
    if (li && li[1].trim()) {
      push({ t: "inline", md: li[1], list: true });
      continue;
    }
    push({ t: "inline", md: line });
  }
  return pieces;
}

/** Markdown → one line of inline nodes. Tables become a marker, code
 *  fences their first line as inline code, images vanish. */
export function snippetNodes(src: string, opts: { flat?: boolean } = {}): InlineNode[] {
  const pieces = blockPieces(src || "", !!opts.flat);
  const out: InlineNode[] = [];
  let prev: Piece | null = null;
  for (const p of pieces) {
    let nodes: InlineNode[];
    if (p.t === "code") nodes = [{ tag: "code", text: p.text }];
    else if (p.t === "marker") nodes = [{ tag: "marker", text: TABLE_MARKER }];
    else {
      nodes = parseInline(p.md);
      if (p.heading) nodes = [{ tag: "strong", children: nodes }];
    }
    if (!nodesText(nodes).trim()) continue;
    if (prev) {
      const listJoin = prev.t === "inline" && prev.list && p.t === "inline" && p.list;
      out.push(listJoin ? " · " : " ");
    }
    out.push(...nodes);
    prev = p;
  }
  return mergeText(trimEnds(out));
}

function trimEnds(nodes: InlineNode[]): InlineNode[] {
  if (typeof nodes[0] === "string") nodes[0] = nodes[0].replace(/^\s+/, "");
  const last = nodes.length - 1;
  if (typeof nodes[last] === "string") nodes[last] = (nodes[last] as string).replace(/\s+$/, "");
  return nodes.filter((n) => n !== "");
}

function mergeText(nodes: InlineNode[]): InlineNode[] {
  const out: InlineNode[] = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (typeof n === "string" && typeof prev === "string") {
      out[out.length - 1] = (prev + n).replace(/\s+/g, " ");
    } else {
      out.push(typeof n === "string" ? n.replace(/\s+/g, " ") : n);
    }
  }
  return out;
}

const PUNCT = /[\\`*_{}[\]()#+\-.!~|>]/;
const WORD = /[\p{L}\p{N}]/u;

/** Inline Markdown on one line. Unclosed delimiters stay literal. */
export function parseInline(s: string, depth = 0): InlineNode[] {
  const out: InlineNode[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push(text);
    text = "";
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && PUNCT.test(s[i + 1] ?? "")) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      let n = 0;
      while (s[i + n] === "`") n++;
      const fence = "`".repeat(n);
      const end = s.indexOf(fence, i + n);
      let body = end < 0 ? (n >= 3 ? s.slice(i + n) : null) : s.slice(i + n, end);
      if (body != null) {
        if (n >= 3) {
          // A squashed fence: "```ts const x = 1 ```". Drop a known language tag.
          const m = /^\s*([\w+#.-]+)\s+(\S[\s\S]*)$/.exec(body);
          if (m && LANGS.has(m[1].toLowerCase())) body = m[2];
        }
        const code = body.replace(/\s+/g, " ").trim();
        flush();
        if (code) out.push({ tag: "code", text: code });
        i = end < 0 ? s.length : end + n;
        continue;
      }
      text += fence;
      i += n;
      continue;
    }
    if (c === "!" && s[i + 1] === "[") {
      const link = linkAt(s, i + 1);
      if (link) {
        i = link.end; // images are omitted
        continue;
      }
    }
    if (c === "[") {
      const link = linkAt(s, i);
      if (link) {
        flush();
        out.push({ tag: "link", children: depth < 4 ? parseInline(link.label, depth + 1) : [link.label] });
        i = link.end;
        continue;
      }
    }
    if (c === "<") {
      const m = /^<(https?:\/\/[^\s>]+|[^\s@>]+@[^\s>]+)>/.exec(s.slice(i));
      if (m) {
        flush();
        out.push({ tag: "link", children: [m[1]] });
        i += m[0].length;
        continue;
      }
    }
    if ((c === "*" || c === "_" || c === "~") && depth < 4) {
      const hit = emphasisAt(s, i);
      if (hit) {
        flush();
        out.push({ tag: hit.tag, children: parseInline(hit.inner, depth + 1) });
        i = hit.end;
        continue;
      }
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

function linkAt(s: string, i: number): { label: string; end: number } | null {
  let depth = 0;
  let j = i;
  for (; j < s.length; j++) {
    if (s[j] === "[") depth++;
    else if (s[j] === "]" && --depth === 0) break;
  }
  if (j >= s.length || s[j + 1] !== "(") return null;
  const close = s.indexOf(")", j + 2);
  if (close < 0) return null;
  return { label: s.slice(i + 1, j), end: close + 1 };
}

function emphasisAt(
  s: string,
  i: number
): { tag: "strong" | "em" | "del"; inner: string; end: number } | null {
  const c = s[i];
  let n = 0;
  while (s[i + n] === c) n++;
  if (c === "~") {
    if (n !== 2) return null;
  } else if (n > 3) return null;
  // `_` only opens at a word edge (snake_case stays literal).
  if (c === "_" && i > 0 && WORD.test(s[i - 1])) return null;
  const after = s[i + n];
  if (!after || /\s/.test(after)) return null;
  const tryRun = (len: number, tag: "strong" | "em" | "del") => {
    const delim = c.repeat(len);
    let from = i + len;
    while (from < s.length) {
      const end = s.indexOf(delim, from);
      if (end < 0) return null;
      const before = s[end - 1];
      const next = s[end + len];
      const okClose =
        end > i + len &&
        !/\s/.test(before) &&
        (c !== "_" || !next || !WORD.test(next)) &&
        // `**a*` must not close a single `*` on the first star of `**`.
        (len !== 1 || next !== c || s[end - 1] === c);
      if (okClose) return { tag, inner: s.slice(i + len, end), end: end + len };
      from = end + 1;
    }
    return null;
  };
  if (c === "~") return tryRun(2, "del");
  if (n === 3) {
    const hit = tryRun(3, "strong");
    if (hit) return { tag: "strong", inner: `${c}${hit.inner}${c}`, end: hit.end };
    return tryRun(2, "strong") ?? tryRun(1, "em");
  }
  if (n === 2) return tryRun(2, "strong");
  return tryRun(1, "em");
}
