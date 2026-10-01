import { posixNormalize } from "./workspacePath";

/** Live GET /cli/companion/sessions (companion-shaped GlobalSession[]).
 *  A sidecar is a non-main tab. Overlay addr is parentHandle/agentName. */
export type SessionSidecarInput = {
  cwd?: unknown;
  workspaceName?: unknown;
  agentName?: unknown;
  label?: unknown;
  isMainChat?: unknown;
};

export type OverlaySidecar = {
  addr: string;
  path: string;
  name: string;
  chatTitle: string;
};

export type MainForSidecar = {
  path: string;
  name: string;
  addr: string | null;
};

/** Next unused `handle/N` from addrs the SERVER already listed.
 *  The old composer always opened `handle/1` even when that sidecar
 *  already existed — twice could never make a second. */
export function nextSidecarAddr(baseAddr: string, existingAddrs: string[]): string {
  const handle = (baseAddr || "").trim().split("/")[0];
  if (!handle) return "";
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}/(\\d+)$`);
  const used = new Set<number>();
  for (const raw of existingAddrs) {
    const m = (raw || "").trim().match(re);
    if (m) used.add(Number(m[1]));
  }
  let n = 1;
  while (used.has(n)) n += 1;
  return `${handle}/${n}`;
}

export function sidecarSuffix(addr: string): string {
  const parts = (addr || "").split("/");
  return parts.slice(1).join("/");
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Overlay sidecar suffix (`1`, `reviewer`). Desktop PTY tabs (`tab-<uuid>`,
 *  heartbeat `…:hb:…`) are not overlay addrs — listing them is QA FAIL 2e76f7f. */
export function isOverlaySidecarSuffix(suffix: string): boolean {
  const s = (suffix || "").trim();
  if (!s) return false;
  if (s.includes(":")) return false;
  if (/^tab-/i.test(s)) return false;
  if (UUID.test(s)) return false;
  return true;
}

export function parseCompanionSessions(data: unknown): SessionSidecarInput[] | null {
  if (Array.isArray(data)) {
    return data.filter((item) => item && typeof item === "object") as SessionSidecarInput[];
  }
  if (
    data &&
    typeof data === "object" &&
    Array.isArray((data as { sessions?: unknown }).sessions)
  ) {
    return ((data as { sessions: unknown[] }).sessions).filter(
      (item) => item && typeof item === "object"
    ) as SessionSidecarInput[];
  }
  return null;
}

function asText(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Sidecar rows from the live session list. Line 1 is the parent workspace
 * name; line 2 is the session's own label (or the addr suffix). Never
 * invent `${parent} / 1`.
 */
export function sidecarsFromSessions(
  sessions: SessionSidecarInput[],
  mains: MainForSidecar[]
): OverlaySidecar[] {
  const byPath = new Map<string, MainForSidecar>();
  for (const m of mains) {
    const key = posixNormalize((m.path || "").trim());
    const addr = (m.addr || "").trim();
    if (!key || !addr || addr.includes("/")) continue;
    byPath.set(key, m);
  }
  const out: OverlaySidecar[] = [];
  const seen = new Set<string>();
  for (const s of sessions) {
    if (s.isMainChat === true) continue;
    const suffix = asText(s.agentName);
    if (!suffix) continue;
    const key = posixNormalize(asText(s.cwd));
    const parent = key ? byPath.get(key) : undefined;
    if (!parent?.addr) continue;
    if (suffix === parent.addr) continue;
    const addr = suffix.includes("/") ? suffix : `${parent.addr}/${suffix}`;
    if (addr === parent.addr || seen.has(addr)) continue;
    if (!isOverlaySidecarSuffix(sidecarSuffix(addr))) continue;
    seen.add(addr);
    const label = asText(s.label);
    const fromAddr = sidecarSuffix(addr) || addr;
    const chatTitle =
      label && label.toLowerCase() !== "main chat tab" ? label : fromAddr;
    out.push({
      addr,
      path: parent.path,
      name: parent.name,
      chatTitle,
    });
  }
  return out;
}

export const SIDECAR_STORAGE_KEY = "k2-zen-sidecar-addrs";

export type RememberedSidecar = {
  addr: string;
  path: string;
  name: string;
  chatTitle: string;
};

export function readRememberedSidecars(): RememberedSidecar[] {
  try {
    const raw = localStorage.getItem(SIDECAR_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: RememberedSidecar[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const row = item as Partial<RememberedSidecar>;
      const addr = typeof row.addr === "string" ? row.addr.trim() : "";
      const path = typeof row.path === "string" ? row.path.trim() : "";
      if (!addr || !path) continue;
      if (!isOverlaySidecarSuffix(sidecarSuffix(addr))) continue;
      out.push({
        addr,
        path,
        name: typeof row.name === "string" ? row.name : "",
        chatTitle: typeof row.chatTitle === "string" ? row.chatTitle : sidecarSuffix(addr),
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function writeRememberedSidecars(rows: RememberedSidecar[]): void {
  try {
    localStorage.setItem(SIDECAR_STORAGE_KEY, JSON.stringify(rows));
  } catch {
    /* quota / private mode */
  }
}

export function rememberSidecar(row: RememberedSidecar): void {
  const addr = (row.addr || "").trim();
  const path = (row.path || "").trim();
  if (!addr || !path || !isOverlaySidecarSuffix(sidecarSuffix(addr))) return;
  const next = [
    {
      addr,
      path,
      name: (row.name || "").trim(),
      chatTitle: (row.chatTitle || sidecarSuffix(addr)).trim(),
    },
    ...readRememberedSidecars().filter((r) => r.addr !== addr),
  ];
  writeRememberedSidecars(next);
}

/** Overlay extra chats persist after the Mac tab closes. Parent main
 *  chat must still exist. Do not restore desktop PTY suffixes. */
export function extrasFromRemembered(
  remembered: RememberedSidecar[],
  already: Set<string>,
  mains: MainForSidecar[]
): OverlaySidecar[] {
  const byPath = new Map<string, MainForSidecar>();
  for (const m of mains) {
    const key = posixNormalize((m.path || "").trim());
    const addr = (m.addr || "").trim();
    if (!key || !addr || addr.includes("/")) continue;
    byPath.set(key, m);
  }
  const out: OverlaySidecar[] = [];
  for (const r of remembered) {
    const addr = (r.addr || "").trim();
    if (!addr || already.has(addr)) continue;
    if (!isOverlaySidecarSuffix(sidecarSuffix(addr))) continue;
    const key = posixNormalize((r.path || "").trim());
    const parent = key ? byPath.get(key) : undefined;
    if (!parent?.addr) continue;
    already.add(addr);
    out.push({
      addr,
      path: parent.path,
      name: parent.name,
      chatTitle: (r.chatTitle || sidecarSuffix(addr)).trim() || sidecarSuffix(addr),
    });
  }
  return out;
}
