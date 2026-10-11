import { create } from "zustand";

/** The Files drawer → composer drag. One drag at a time, app-wide. */
export type FileDrag = {
  /** Absolute path on the server. */
  path: string;
  name: string;
  /** Text a drop puts in the draft (`fileRefText`). */
  ref: string;
  x: number;
  y: number;
};

type FileDragState = {
  drag: FileDrag | null;
  /** The finger is over the composer. */
  overComposer: boolean;
  /** A reference waiting for the mounted composer to take it. */
  pendingInsert: { seq: number; text: string } | null;
  begin: (d: FileDrag) => void;
  move: (x: number, y: number) => void;
  /** Release: drop on the composer inserts, anywhere else cancels.
   *  True when it inserted. */
  end: (x: number, y: number) => boolean;
  cancel: () => void;
  /** Queue `text` for the composer (drop, or a direct insert). */
  insert: (text: string) => void;
  takeInsert: (seq: number) => void;
};

/** The composer field marks itself `data-k2-drop="composer"`. A rect
 *  test (not elementFromPoint): the drawer may sit on top of it. */
export function composerAt(x: number, y: number): boolean {
  if (typeof document === "undefined") return false;
  const nodes = document.querySelectorAll<HTMLElement>("[data-k2-drop='composer']");
  for (const el of Array.from(nodes)) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
  }
  return false;
}

let seq = 0;

export const useFileDrag = create<FileDragState>((set, get) => ({
  drag: null,
  overComposer: false,
  pendingInsert: null,
  begin: (d) => set({ drag: d, overComposer: composerAt(d.x, d.y) }),
  move: (x, y) => {
    const d = get().drag;
    if (!d) return;
    const over = composerAt(x, y);
    set({ drag: { ...d, x, y }, ...(over !== get().overComposer ? { overComposer: over } : {}) });
  },
  end: (x, y) => {
    const d = get().drag;
    set({ drag: null, overComposer: false });
    if (!d || !composerAt(x, y)) return false;
    get().insert(d.ref);
    return true;
  },
  cancel: () => set({ drag: null, overComposer: false }),
  insert: (text) => set({ pendingInsert: { seq: ++seq, text } }),
  takeInsert: (s) => {
    if (get().pendingInsert?.seq === s) set({ pendingInsert: null });
  },
}));
