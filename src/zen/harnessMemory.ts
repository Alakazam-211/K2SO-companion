// The last LLM seen for a chat, per server, so the chat header's LLM icon
// stays put while the agent has no live session (the activity snapshot
// only lists running PTYs). Per-device convenience: localStorage, and a
// missing or blocked store just means no fallback.

const KEY = "k2.zen.harness.v1";
const MAX = 300;

type Store = Record<string, string>;

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    const o = raw ? (JSON.parse(raw) as unknown) : null;
    return o && typeof o === "object" ? (o as Store) : {};
  } catch {
    return {};
  }
}

/** `<serverId>|<workspace path or addr>`. */
export function harnessKey(serverId: string, row: { path?: string; addr?: string | null }): string {
  const where = (row.path || row.addr || "").trim();
  return serverId && where ? `${serverId}|${where}` : "";
}

export function recallHarness(key: string): string | null {
  if (!key) return null;
  const h = read()[key];
  return typeof h === "string" && h ? h : null;
}

export function rememberHarness(key: string, harness: string): void {
  if (!key || !harness) return;
  const store = read();
  if (store[key] === harness) return;
  // Newest last; the oldest go past MAX.
  delete store[key];
  store[key] = harness;
  const keys = Object.keys(store);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX))) delete store[k];
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Private mode / quota: no fallback next time.
  }
}
