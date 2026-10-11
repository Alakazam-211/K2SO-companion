import { sidecarSuffix } from "./sidecarRows";

export const HIDDEN_SIDECAR_KEY = "k2-zen-hidden-sidecar-addrs";

export function isOverlayExtraAddr(addr: string | null | undefined): boolean {
  return Boolean(sidecarSuffix(addr || ""));
}

export function threadHeaderTitle(row: {
  name?: string | null;
  addr?: string | null;
  chatTitle?: string | null;
} | null | undefined): string {
  return (row?.name || "").trim() || "—";
}

/** Sidecar title under the workspace name. Null on main chat. */
export function threadSidecarTitle(row: {
  addr?: string | null;
  chatTitle?: string | null;
} | null | undefined): string | null {
  if (!isOverlayExtraAddr(row?.addr)) return null;
  const title = (row?.chatTitle || "").trim();
  if (title) return title;
  return sidecarSuffix(row?.addr || "") || null;
}

/** Centre header title. Main chat: `<Agent>`. A separate session (extra
 *  chat, or any Done-mode pick from the Sessions drawer): `<Agent>/<sidecar>`,
 *  the same addr suffix the composer placeholder uses (`k2/reviewer` →
 *  `K2/reviewer`). A Done-mode session with no suffix (conversation id) falls
 *  back to its title, else a short id. */
export function threadSessionHeaderTitle(
  row: {
    name?: string | null;
    addr?: string | null;
    chatTitle?: string | null;
  } | null | undefined,
  drawerPicked = false
): string {
  const name = threadHeaderTitle(row);
  if (name === "—") return name;
  const addr = (row?.addr || "").trim();
  let suffix = sidecarSuffix(addr).trim();
  if (!suffix && drawerPicked) {
    suffix = (row?.chatTitle || "").trim() || addr.slice(0, 8);
  }
  return suffix ? `${name}/${suffix}` : name;
}

export function readHiddenSidecarAddrs(): string[] {
  try {
    const raw = localStorage.getItem(HIDDEN_SIDECAR_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is string => typeof x === "string" && isOverlayExtraAddr(x))
      .map((x) => x.trim());
  } catch {
    return [];
  }
}

export function writeHiddenSidecarAddrs(addrs: string[]): void {
  try {
    localStorage.setItem(HIDDEN_SIDECAR_KEY, JSON.stringify(addrs));
  } catch {
    /* quota / private mode */
  }
}

export function hideSidecarAddr(addr: string): void {
  const a = (addr || "").trim();
  if (!isOverlayExtraAddr(a)) return;
  writeHiddenSidecarAddrs([a, ...readHiddenSidecarAddrs().filter((x) => x !== a)]);
}

export function unhideSidecarAddr(addr: string): void {
  const a = (addr || "").trim();
  writeHiddenSidecarAddrs(readHiddenSidecarAddrs().filter((x) => x !== a));
}

export function isHiddenSidecarAddr(addr: string | null | undefined): boolean {
  const a = (addr || "").trim();
  if (!a) return false;
  return readHiddenSidecarAddrs().includes(a);
}

function chatSearchHay(row: {
  name?: string | null;
  addr?: string | null;
  chatTitle?: string | null;
}): string {
  return [row.name, row.chatTitle, row.addr].filter(Boolean).join(" ").toLowerCase();
}

/** Default list hides archived extras. A search query shows them again. */
export function visibleOverlayAgents<T extends {
  name?: string | null;
  addr?: string | null;
  chatTitle?: string | null;
  kind?: string | null;
  hostLive?: boolean | null;
}>(agents: T[], query: string, hiddenAddrs: string[] | null | undefined = []): T[] {
  const q = query.trim().toLowerCase();
  const hidden = new Set(hiddenAddrs ?? []);
  return agents.filter((a) => {
    if (q) return chatSearchHay(a).includes(q);
    const addr = (a.addr || "").trim();
    if (a.kind === "group") return true;
    if (isOverlayExtraAddr(addr) && hidden.has(addr)) return false;
    // Hostless extras and History conversation rows stay out of the list.
    if (a.hostLive === false) return false;
    return true;
  });
}
