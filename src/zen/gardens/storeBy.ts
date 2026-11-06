// `by` in the person's words, as the desktop shows it (K2's
// zen-custom-store.ts `zenStoreBy`; K2 11-06: the phone renames, the daemon
// keeps answering `you`, `you via <widget>` or `agent:<handle>`).

/** How long the person's name is reused before `viewer.get` again. */
export const VIEWER_NAME_MS = 30_000;

export function storeBy(by: unknown, name: string): unknown {
  if (by === "you") return name;
  if (typeof by === "string" && by.startsWith("you via ")) return `${name} via ${by.slice("you via ".length)}`;
  return by;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A store answer with its `by` fields renamed; other verbs pass through.
 *  `name` is asked only when the answer has something to rename. */
export async function namedStoreAnswer(verb: string, v: unknown, name: () => Promise<string>): Promise<unknown> {
  if (verb === "store.get" && isObj(v) && "by" in v) return { ...v, by: storeBy(v.by, await name()) };
  if ((verb === "store.list" || verb === "store.changes" || verb === "store.history") && isObj(v) && Array.isArray(v.items)) {
    if (!v.items.some((i) => isObj(i) && typeof i.by === "string" && i.by.startsWith("you"))) return v;
    const n = await name();
    return { ...v, items: v.items.map((i: unknown) => (isObj(i) ? { ...i, by: storeBy(i.by, n) } : i)) };
  }
  return v;
}

/** The person's name from `viewer.get`, kept for VIEWER_NAME_MS; "You" when
 *  it can't be read. */
export function viewerNameCache(read: () => Promise<unknown>, now: () => number = Date.now): () => Promise<string> {
  let kept: { value: string; at: number } | null = null;
  return async () => {
    if (kept && now() - kept.at < VIEWER_NAME_MS) return kept.value;
    let v: unknown = null;
    try {
      v = await read();
    } catch {
      v = null;
    }
    const value = isObj(v) && typeof v.name === "string" && v.name ? v.name : "You";
    kept = { value, at: now() };
    return value;
  };
}
