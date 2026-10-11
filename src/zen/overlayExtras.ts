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

/** Per-server key: `k2-zen-hidden-sidecar-addrs.<serverId>`. */
export function hiddenSidecarKey(serverId: string): string {
  return `${HIDDEN_SIDECAR_KEY}.${serverId}`;
}

/** `serverId`'s hidden extras. `adoptLegacy` (the active server only)
 *  moves the pre-multi-server list under this server first. */
export function readHiddenSidecarAddrs(
  serverId: string,
  opts: { adoptLegacy?: boolean } = {}
): string[] {
  if (!serverId) return [];
  try {
    const key = hiddenSidecarKey(serverId);
    let raw = localStorage.getItem(key);
    if (opts.adoptLegacy) {
      const legacy = localStorage.getItem(HIDDEN_SIDECAR_KEY);
      if (legacy !== null) {
        if (raw === null) {
          localStorage.setItem(key, legacy);
          raw = legacy;
        }
        localStorage.removeItem(HIDDEN_SIDECAR_KEY);
      }
    }
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

export function writeHiddenSidecarAddrs(serverId: string, addrs: string[]): void {
  if (!serverId) return;
  try {
    localStorage.setItem(hiddenSidecarKey(serverId), JSON.stringify(addrs));
  } catch {
    /* quota / private mode */
  }
}

export function forgetHiddenSidecarAddrs(serverId: string): void {
  try {
    localStorage.removeItem(hiddenSidecarKey(serverId));
  } catch {
    /* no storage */
  }
}

export function hideSidecarAddr(serverId: string, addr: string): void {
  const a = (addr || "").trim();
  if (!isOverlayExtraAddr(a)) return;
  writeHiddenSidecarAddrs(serverId, [
    a,
    ...readHiddenSidecarAddrs(serverId, { adoptLegacy: true }).filter((x) => x !== a),
  ]);
}

export function unhideSidecarAddr(serverId: string, addr: string): void {
  const a = (addr || "").trim();
  writeHiddenSidecarAddrs(
    serverId,
    readHiddenSidecarAddrs(serverId, { adoptLegacy: true }).filter((x) => x !== a)
  );
}

export function isHiddenSidecarAddr(serverId: string, addr: string | null | undefined): boolean {
  const a = (addr || "").trim();
  if (!a) return false;
  return readHiddenSidecarAddrs(serverId).includes(a);
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
