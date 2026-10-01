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
  if (!row) return "—";
  if (isOverlayExtraAddr(row.addr)) {
    const title = (row.chatTitle || "").trim();
    if (title) return title;
    return sidecarSuffix(row.addr || "") || (row.name || "").trim() || "—";
  }
  return (row.name || "").trim() || "—";
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
}>(agents: T[], query: string, hiddenAddrs: string[] | null | undefined = []): T[] {
  const q = query.trim().toLowerCase();
  const hidden = new Set(hiddenAddrs ?? []);
  return agents.filter((a) => {
    if (q) return chatSearchHay(a).includes(q);
    const addr = (a.addr || "").trim();
    if (a.kind === "group") return true;
    if (isOverlayExtraAddr(addr) && hidden.has(addr)) return false;
    return true;
  });
}
