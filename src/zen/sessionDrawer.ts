import { sidecarsFromSessions, type OverlaySidecar, type SessionSidecarInput } from "./sidecarRows";
import { posixNormalize } from "./workspacePath";

/** Sessions drawer in the Zen chat header: the tabs open in this chat's
 *  workspace. Sidecar chats come from the same join the Chats list uses
 *  (`sidecarsFromSessions`). Other live PTYs on the same path are plain
 *  terminals: they open the Zen terminal page, not a chat. */

export type DrawerTerminal = { terminalId: string; title: string };

export type WorkspaceSessions = {
  /** Main chat PTY for this workspace, when one is live. */
  mainTerminalId: string | null;
  sidecars: OverlaySidecar[];
  terminals: DrawerTerminal[];
};

function asText(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Main overlay handle for a chat addr: `k2/reviewer` → `k2`. */
export function mainHandleOf(addr: string | null | undefined): string {
  return (addr || "").trim().split("/")[0] || "";
}

export function workspaceSessions(
  sessions: SessionSidecarInput[],
  main: { path: string; name: string; addr: string }
): WorkspaceSessions {
  const path = posixNormalize((main.path || "").trim());
  const handle = mainHandleOf(main.addr);
  if (!path || !handle) return { mainTerminalId: null, sidecars: [], terminals: [] };
  const sidecars = sidecarsFromSessions(sessions, [
    { path: main.path, name: main.name, addr: handle },
  ]);
  const taken = new Set(sidecars.map((s) => s.terminalId).filter(Boolean));
  let mainTerminalId: string | null = null;
  const terminals: DrawerTerminal[] = [];
  const seen = new Set<string>();
  for (const s of sessions) {
    if (posixNormalize(asText(s.cwd)) !== path) continue;
    const id = asText(s.terminalId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (s.isMainChat === true) {
      mainTerminalId ??= id;
      continue;
    }
    if (taken.has(id)) continue;
    const agentName = asText(s.agentName);
    // Heartbeat PTYs are background work, not tabs.
    if (agentName.includes(":hb:")) continue;
    // A sidecar matched by name but listed without its terminal id.
    if (sidecars.some((c) => !c.terminalId && c.addr.endsWith(`/${agentName}`))) continue;
    terminals.push({ terminalId: id, title: asText(s.label) || agentName || "Terminal" });
  }
  return { mainTerminalId, sidecars, terminals };
}

/** The chat the drawer was first used from. Done returns there. */
export const DRAWER_ORIGIN_KEY = "k2-zen-drawer-origin";

export function readDrawerOrigin(): string | null {
  try {
    const v = sessionStorage.getItem(DRAWER_ORIGIN_KEY);
    return v && v.trim() ? v : null;
  } catch {
    return null;
  }
}

export function writeDrawerOrigin(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(DRAWER_ORIGIN_KEY, id);
    else sessionStorage.removeItem(DRAWER_ORIGIN_KEY);
  } catch {
    /* private mode */
  }
}

/** Origin after a drawer pick: the first pick records where the user was;
 *  later picks keep it; picking the origin itself ends drawer mode. */
export function nextDrawerOrigin(
  origin: string | null,
  currentId: string,
  pickedId: string
): string | null {
  const from = origin || currentId || null;
  return from && from !== pickedId ? from : null;
}
