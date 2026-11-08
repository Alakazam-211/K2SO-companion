import { useLayoutEffect, useRef, type ComponentPropsWithoutRef } from "react";
import { balanceColumns, type BalanceCell } from "../lib/tableBalance";

// A chat markdown table whose column widths make it as short as possible
// (lib/tableBalance). Words are measured once per table and font size with
// a canvas, the widths go on a <colgroup> with `table-layout: fixed`, and
// they're worked out again only when the width (or text size) changes,
// debounced. A table that can't fit scrolls inside its wrapper.

const RESIZE_DEBOUNCE_MS = 120;

let ctx: CanvasRenderingContext2D | null | undefined;
function measurer(): CanvasRenderingContext2D | null {
  if (ctx === undefined) {
    try {
      ctx = document.createElement("canvas").getContext("2d");
    } catch {
      ctx = null;
    }
  }
  return ctx;
}

function fontOf(s: CSSStyleDeclaration): string {
  return `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
}

function px(v: string): number {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/** A cell's unbreakable runs: text split at whitespace, with pieces from
 *  neighbouring elements (bold, inline code, punctuation) glued together. */
function measureCell(el: HTMLTableCellElement, m: CanvasRenderingContext2D): BalanceCell {
  const cs = getComputedStyle(el);
  m.font = fontOf(cs);
  const space = m.measureText(" ").width;
  const pad =
    px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth) + 2;
  const words: number[] = [];
  let run = 0;
  const seenCode = new Set<Element>();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement ?? el;
    m.font = fontOf(getComputedStyle(parent));
    // Inline code's own padding and border, once per code span.
    const code = parent.closest("code");
    let codeBox = 0;
    if (code && el.contains(code) && !seenCode.has(code)) {
      seenCode.add(code);
      const c = getComputedStyle(code);
      codeBox = px(c.paddingLeft) + px(c.paddingRight) + px(c.borderLeftWidth) + px(c.borderRightWidth);
    }
    for (const piece of (node.textContent ?? "").split(/(\s+)/)) {
      if (!piece) continue;
      if (/^\s+$/.test(piece)) {
        if (run > 0) words.push(run);
        run = 0;
        continue;
      }
      run += m.measureText(piece).width + codeBox;
      codeBox = 0;
    }
  }
  if (run > 0) words.push(run);
  return { words, space, pad };
}

function unbalance(table: HTMLTableElement) {
  table.querySelector("colgroup[data-balanced]")?.remove();
  table.style.tableLayout = "";
}

function balance(table: HTMLTableElement, wrap: HTMLElement, cache: { key: string; rows: BalanceCell[][] | null }) {
  const m = measurer();
  const available = wrap.clientWidth;
  if (!m || available <= 0) return;
  const fontKey = getComputedStyle(table).fontSize;
  if (cache.key !== fontKey || !cache.rows) {
    cache.key = fontKey;
    cache.rows = Array.from(table.rows, (row) => Array.from(row.cells, (c) => measureCell(c, m)));
  }
  const result = balanceColumns(cache.rows, available, { minColumn: px(fontKey) * 2.4 });
  if (result.kind !== "fixed") {
    unbalance(table);
    return;
  }
  let group = table.querySelector<HTMLTableColElement>("colgroup[data-balanced]");
  if (!group) {
    group = document.createElement("colgroup");
    group.setAttribute("data-balanced", "");
    table.insertBefore(group, table.firstChild);
  }
  while (group.children.length > result.widths.length) group.lastChild!.remove();
  while (group.children.length < result.widths.length) group.appendChild(document.createElement("col"));
  result.widths.forEach((w, i) => {
    (group!.children[i] as HTMLElement).style.width = `${w}px`;
  });
  table.style.tableLayout = "fixed";
}

export function BalancedTable({ node: _node, ...props }: ComponentPropsWithoutRef<"table"> & { node?: unknown }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const table = tableRef.current;
    if (!wrap || !table) return;
    const cache: { key: string; rows: BalanceCell[][] | null } = { key: "", rows: null };
    balance(table, wrap, cache);
    if (typeof ResizeObserver === "undefined") return;
    let width = wrap.clientWidth;
    let font = getComputedStyle(table).fontSize;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      const w = wrap.clientWidth;
      const f = getComputedStyle(table).fontSize;
      if (w === width && f === font) return;
      width = w;
      font = f;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        balance(table, wrap, cache);
      }, RESIZE_DEBOUNCE_MS);
    });
    ro.observe(wrap);
    ro.observe(table);
    return () => {
      ro.disconnect();
      if (timer) clearTimeout(timer);
      unbalance(table);
    };
  }, [props.children]);
  return (
    <div ref={wrapRef} className="chat-md-table-wrap">
      <table ref={tableRef} {...props} />
    </div>
  );
}
