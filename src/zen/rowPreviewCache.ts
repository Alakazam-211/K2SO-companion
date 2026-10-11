import type { RowLast } from "./rowPreview";

/** Row snippets kept on this device, so a cold launch draws line two at
 *  once and the background `thread/latest` call only fixes what moved.
 *  Keyed `<hostKey>|<addr>`. Read-only of the server: nothing here asks
 *  the daemon for anything. */
export const ROW_PREVIEW_CACHE_KEY = "k2.zen.rowPreviews.v1";
export const ROW_PREVIEW_CACHE_CAP = 200;

type Entry = { last: RowLast | null; t: number };
type Stored = Record<string, Entry>;

/** `https` on 443 is the bare hostname; anything else keeps its port
 *  (the same spelling as Home's host keys). */
export function serverHostKey(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

let memo: Stored | null = null;

function load(): Stored {
  if (memo) return memo;
  let out: Stored = {};
  try {
    const raw = localStorage.getItem(ROW_PREVIEW_CACHE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) out = parsed as Stored;
  } catch {
    out = {};
  }
  memo = out;
  return out;
}

function validLast(v: unknown): v is RowLast | null {
  if (v === null) return true;
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.text === "string" && typeof o.kind === "string" && typeof o.mine === "boolean";
}

/** Every cached snippet for one server, by addr. */
export function readRowPreviews(host: string): Record<string, RowLast | null> {
  const out: Record<string, RowLast | null> = {};
  if (!host) return out;
  const prefix = `${host}|`;
  for (const [k, e] of Object.entries(load())) {
    if (!k.startsWith(prefix) || !e || !validLast(e.last)) continue;
    const last = e.last;
    out[k.slice(prefix.length)] = last
      ? { ...last, at: last.at ?? null, seq: last.seq ?? null }
      : null;
  }
  return out;
}

/** Store snippets for one server; the oldest writes fall off past the cap. */
export function writeRowPreviews(host: string, lasts: Record<string, RowLast | null>): void {
  if (!host) return;
  const stored = { ...load() };
  const now = Date.now();
  let i = 0;
  for (const [addr, last] of Object.entries(lasts)) {
    // `i` keeps one batch's order stable inside the same millisecond.
    stored[`${host}|${addr}`] = { last, t: now + i++ / 1000 };
  }
  const keys = Object.keys(stored);
  if (keys.length > ROW_PREVIEW_CACHE_CAP) {
    keys
      .sort((a, b) => (stored[a]?.t ?? 0) - (stored[b]?.t ?? 0))
      .slice(0, keys.length - ROW_PREVIEW_CACHE_CAP)
      .forEach((k) => delete stored[k]);
  }
  memo = stored;
  try {
    localStorage.setItem(ROW_PREVIEW_CACHE_KEY, JSON.stringify(stored));
  } catch {
    /* private mode / full: the in-memory copy still serves this launch */
  }
}

/** Tests only. */
export function resetRowPreviewMemo(): void {
  memo = null;
}
