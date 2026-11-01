import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { attachPressSpring, type PressSpring } from "../../lib/usePressSpring";
import { HOLD_MENU_MS, HOLD_SLOP_PX, rectOf, type HeldMenu } from "../useHoldMenu";

/** The attribute marking a message that opens the hold menu. */
export const MESSAGE_HOLD_ATTR = "data-message-hold";

/** Words are selected somewhere (the system's selection): while they are,
 *  a bubble's hold menu stays shut (Rosson 2026-10-31); deselecting brings
 *  it back. The field's own text doesn't count (a textarea's selection
 *  reads as empty here). */
export function wordsSelected(): boolean {
  try {
    const sel = window.getSelection?.();
    return !!sel && !sel.isCollapsed && sel.toString().trim() !== "";
  } catch {
    return false;
  }
}

/** The holdable message under `t`. */
function holdTarget(t: EventTarget | null): Element | null {
  return (t as Element | null)?.closest?.(`[${MESSAGE_HOLD_ATTR}]`) ?? null;
}

type CaretDoc = Document & {
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
};

/** Is (x, y) on a character of `within`'s words (not the padding, nor the
 *  blank beside a short line)? There a long press is the system's text
 *  selection; anywhere else on the bubble it is the hold menu. */
export function pointOnText(x: number, y: number, within: Element): boolean {
  const doc = within.ownerDocument as CaretDoc;
  let node: Node | null = null;
  let offset = 0;
  if (typeof doc.caretRangeFromPoint === "function") {
    const r = doc.caretRangeFromPoint(x, y);
    if (r) {
      node = r.startContainer;
      offset = r.startOffset;
    }
  } else if (typeof doc.caretPositionFromPoint === "function") {
    const p = doc.caretPositionFromPoint(x, y);
    if (p) {
      node = p.offsetNode;
      offset = p.offset;
    }
  }
  if (!node || node.nodeType !== 3 || !within.contains(node)) return false;
  const len = node.textContent?.length ?? 0;
  const range = doc.createRange();
  // The caret sits between two characters: the point is on text when it is
  // inside either one's box.
  for (const at of [offset - 1, offset]) {
    if (at < 0 || at >= len) continue;
    range.setStart(node, at);
    range.setEnd(node, at + 1);
    for (const b of Array.from(range.getClientRects())) {
      if (x >= b.left - 1 && x <= b.right + 1 && y >= b.top - 1 && y <= b.bottom + 1) return true;
    }
  }
  return false;
}

/**
 * Press and hold a message's bubble (its edge, or the blank beside its
 * words) for its menu (Reply, Save to stash, Copy). A press on the words
 * themselves is left to the system's text selection (useMessageSelection
 * offers Reply / Copy / Save to stash for it). One listener set on the message list, not per bubble, so
 * the memoised bubbles stay untouched: a press on an element carrying
 * MESSAGE_HOLD_ATTR held still for HOLD_MENU_MS opens the menu; moving
 * past HOLD_SLOP_PX, the list scrolling, or a cancel drops it, and the
 * release's click is eaten. Same feel as the agent rows (useHoldMenu).
 * `contextmenu` opens it too (iPad pointer right-click, Android long-press,
 * Shift+F10, VoiceOver's double-tap-and-hold). A message whose text is
 * being selected (Select Text) takes no hold: a finger resting on a
 * selection handle must not pop the menu over it.
 */
export function useMessageHold(area: RefObject<HTMLElement | null>, enabled: boolean) {
  const [menu, setMenu] = useState<HeldMenu | null>(null);
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const eatClick = useRef(false);

  useEffect(() => {
    const el = area.current;
    if (!el || !enabled) return;
    // The bubble under a hold grows like Send while the finger is down and
    // springs back on release (Rosson 2026-10-31).
    const springs = new WeakMap<Element, PressSpring>();
    let pressed: PressSpring | null = null;
    const letGo = () => {
      pressed?.release();
      pressed = null;
    };
    const clear = () => {
      if (press.current) clearTimeout(press.current.timer);
      press.current = null;
      letGo();
    };
    const down = (e: PointerEvent) => {
      eatClick.current = false;
      clear();
      if (e.button && e.button !== 0) return;
      const target = holdTarget(e.target);
      // Buttons and links inside a message keep their own press; the
      // words themselves are the system's selection (Rosson 2026-10-31).
      if (!target || (e.target as Element).closest("button, a")) return;
      if (pointOnText(e.clientX, e.clientY, target)) return;
      if (wordsSelected()) return;
      const id = target.getAttribute(MESSAGE_HOLD_ATTR) ?? "";
      if (!id) return;
      let spring = springs.get(target);
      if (!spring && target instanceof HTMLElement) {
        spring = attachPressSpring(target);
        springs.set(target, spring);
      }
      pressed = spring ?? null;
      pressed?.press();
      press.current = {
        x: e.clientX,
        y: e.clientY,
        timer: setTimeout(() => {
          // The menu opens; the bubble stays grown until the finger lifts.
          press.current = null;
          eatClick.current = true;
          setMenu({ id, rect: rectOf(target), armed: false });
        }, HOLD_MENU_MS),
      };
    };
    const move = (e: PointerEvent) => {
      const p = press.current;
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > HOLD_SLOP_PX) clear();
    };
    const click = (e: MouseEvent) => {
      if (!eatClick.current) return;
      eatClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    };
    const context = (e: MouseEvent) => {
      const target = holdTarget(e.target);
      if (!target) return;
      // Words selected: the system's menu, never the bubble's.
      if (wordsSelected()) return;
      // On the words: the system's own menu (Android's long-press selects).
      if (e.button === 0 && pointOnText(e.clientX, e.clientY, target) && !press.current) return;
      e.preventDefault();
      const id = target.getAttribute(MESSAGE_HOLD_ATTR) ?? "";
      if (!id) return;
      // A touch long-press is still down: its release must not hit the
      // menu. A right-click or a key has no press: the menu takes clicks.
      const touching = !!press.current || eatClick.current;
      clear();
      eatClick.current = touching;
      setMenu({ id, rect: rectOf(target), armed: !touching });
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", clear);
    el.addEventListener("pointercancel", clear);
    el.addEventListener("scroll", clear, { passive: true });
    el.addEventListener("click", click, true);
    el.addEventListener("contextmenu", context);
    return () => {
      clear();
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", clear);
      el.removeEventListener("pointercancel", clear);
      el.removeEventListener("scroll", clear);
      el.removeEventListener("click", click, true);
      el.removeEventListener("contextmenu", context);
    };
  }, [area, enabled]);

  const close = useCallback(() => setMenu(null), []);
  return { menu, close };
}

/** A message's words (the selectable part of its bubble). */
const BODY_SELECTOR = "[data-bubble-body]";

function elementOf(n: Node): Element | null {
  return n.nodeType === 1 ? (n as Element) : n.parentElement;
}

/** The first or last caret position on `body`'s words. */
function edgeOf(body: Element, end: boolean): { node: Node; offset: number } | null {
  const walk = body.ownerDocument.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */);
  let first: Node | null = null;
  let last: Node | null = null;
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!n.textContent?.trim()) continue;
    if (!first) first = n;
    last = n;
  }
  const n = end ? last : first;
  return n ? { node: n, offset: end ? (n.textContent?.length ?? 0) : 0 } : null;
}

/** A selection that starts in one message's words but ends outside them
 *  (iOS's long press on the newest message's last line ran on into the
 *  empty space below, Rosson 2026-10-31): pull its end back to the end
 *  (or the start) of those words. True when it moved the selection. */
export function keepSelectionInMessage(sel: Selection): boolean {
  if (!sel.anchorNode || !sel.focusNode || sel.isCollapsed) return false;
  const body = elementOf(sel.anchorNode)?.closest(BODY_SELECTOR) ?? null;
  if (!body || body.contains(sel.focusNode)) return false;
  const after = (body.compareDocumentPosition(sel.focusNode) & 4) /* DOCUMENT_POSITION_FOLLOWING */ !== 0;
  const edge = edgeOf(body, after);
  if (!edge) return false;
  try {
    sel.setBaseAndExtent(sel.anchorNode, sel.anchorOffset, edge.node, edge.offset);
    return true;
  } catch {
    return false;
  }
}

/** What is selected inside one message's words, or null. */
export type MessageSelection = { id: string; text: string };

/** A selection inside one message's words (the system's long-press
 *  selection, dragged handles included). Null when nothing is selected, or
 *  it spans more than one message or leaves the list. */
export function useMessageSelection(area: RefObject<HTMLElement | null>) {
  const [sel, setSel] = useState<MessageSelection | null>(null);
  useEffect(() => {
    if (typeof document === "undefined") return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const s = window.getSelection?.();
      const root = area.current;
      if (!s || s.isCollapsed || !root || !s.anchorNode || !s.focusNode) {
        setSel((cur) => (cur ? null : cur));
        return;
      }
      // Kept inside its message; the change this makes reads again.
      if (root.contains(s.anchorNode) && keepSelectionInMessage(s)) return;
      const at = (n: Node) => (n.nodeType === 1 ? (n as Element) : n.parentElement)?.closest(`[${MESSAGE_HOLD_ATTR}]`) ?? null;
      const a = at(s.anchorNode);
      const text = s.toString().trim();
      const id = a && a === at(s.focusNode) && root.contains(a) ? a.getAttribute(MESSAGE_HOLD_ATTR) : null;
      setSel((cur) => (id && text ? (cur?.id === id && cur.text === text ? cur : { id, text }) : cur ? null : cur));
    };
    const onChange = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      document.removeEventListener("selectionchange", onChange);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [area]);
  const clear = useCallback(() => {
    window.getSelection?.()?.removeAllRanges();
    setSel(null);
  }, []);
  return { sel, clear };
}
