import type { GlobalSession } from "../api/client";
import { isConversationAddr } from "./sessionHistory";
import { sidecarSuffix, type OverlaySidecar } from "./sidecarRows";
import { posixNormalize } from "./workspacePath";

export const ZEN_THREAD_KEY = "k2-zen-thread";
/** The server that thread is on, when it is a room on a non-active
 *  server (MA17). Absent = the active server. */
export const ZEN_THREAD_SERVER_KEY = "k2-zen-thread-server";

export function rememberZenThread(
  agentId: string | null | undefined,
  serverId?: string | null
): void {
  try {
    if (agentId) sessionStorage.setItem(ZEN_THREAD_KEY, agentId);
    else sessionStorage.removeItem(ZEN_THREAD_KEY);
    if (agentId && serverId) sessionStorage.setItem(ZEN_THREAD_SERVER_KEY, serverId);
    else sessionStorage.removeItem(ZEN_THREAD_SERVER_KEY);
  } catch {
    /* private mode */
  }
}

export function readZenThreadServer(): string | null {
  try {
    return sessionStorage.getItem(ZEN_THREAD_SERVER_KEY);
  } catch {
    return null;
  }
}

export function readZenThread(): string | null {
  try {
    return sessionStorage.getItem(ZEN_THREAD_KEY);
  } catch {
    return null;
  }
}

export function zenThreadPath(agentId?: string | null): string {
  const id = (agentId || "").trim();
  if (!id) return "/zen";
  return `/zen?thread=${encodeURIComponent(id)}`;
}

/** Query key that opens the Zen Tickets overlay on one ticket. */
export const ZEN_TICKET_PARAM = "ticket";

/** Push-tap deep link: `/zen?ticket=<id>` opens Tickets on that ticket. */
export function zenTicketPath(ticketId?: string | null): string {
  const id = (ticketId || "").trim();
  if (!id) return "/zen";
  return `/zen?${ZEN_TICKET_PARAM}=${encodeURIComponent(id)}`;
}

/** Query key that opens Projects on one project chat
 *  (`/zen?project=<groupId>`, a project push tap). */
export const ZEN_PROJECT_PARAM = "project";

export function zenProjectPath(groupId?: string | null): string {
  const id = (groupId || "").trim();
  if (!id) return "/zen";
  return `/zen?${ZEN_PROJECT_PARAM}=${encodeURIComponent(id)}`;
}

/** Pick the original-UI terminal for an overlay agent. Null → /sessions. */
export function terminalIdForAgent(
  agent:
    | { path?: string | null; addr?: string | null; terminalId?: string | null }
    | null
    | undefined,
  sessions: GlobalSession[]
): string | null {
  if (!agent || !sessions.length) return null;
  const path = posixNormalize((agent.path || "").trim());
  if (!path) return null;
  const onPath = sessions.filter((s) => posixNormalize(s.cwd || "") === path);
  if (!onPath.length) return null;
  // The row's own PTY, while it is still live (a plain tab opened as its Thread).
  const own = (agent.terminalId || "").trim();
  if (own && onPath.some((s) => s.terminalId === own)) return own;
  // A bare conversation id (Sessions History) is not the main chat.
  if (isConversationAddr(agent.addr)) return null;
  const suffix = sidecarSuffix(agent.addr || "");
  if (suffix) {
    const hit = onPath.find((s) => {
      const name = (s.agentName || "").trim();
      return name === suffix || name === (agent.addr || "").trim();
    });
    return hit?.terminalId ?? null;
  }
  const main = onPath.find((s) => s.isMainChat);
  if (main) return main.terminalId;
  return onPath[0]?.terminalId ?? null;
}

/** Zen terminal page (glass shell over the same TerminalView). */
export function zenTerminalPath(terminalId: string): string {
  return `/zen/terminal/${encodeURIComponent(terminalId)}`;
}

/** Router state for `/zen/terminal/:id`: who the terminal belongs to.
 *  history.state survives a page reload; a cold entry falls back to the
 *  Zen store, then a generic header. */
export type ZenTerminalAgent = {
  agentId: string;
  name: string;
  initial?: string | null;
  color?: string | null;
  iconUrl?: string | null;
  /** Sidecar chat title, when the terminal is a sidecar's. */
  chatTitle?: string | null;
  projectPath?: string | null;
  /** Overlay addr (`appa` / `appa/1`) — the workspace handle for `＋` uploads. */
  addr?: string | null;
  /** The Thread Done returns to (session addr, Done mode, drawer origin). */
  back?: ZenTerminalReturn | null;
  /** The saved server the terminal is on when it is a room on a
   *  non-active server (MA17); absent = the active server. */
  serverId?: string | null;
};

export function readZenTerminalAgent(state: unknown): ZenTerminalAgent | null {
  if (!state || typeof state !== "object") return null;
  const a = (state as { agent?: unknown }).agent;
  if (!a || typeof a !== "object") return null;
  const agentId = (a as { agentId?: unknown }).agentId;
  const name = (a as { name?: unknown }).name;
  if (typeof agentId !== "string" || !agentId.trim()) return null;
  return {
    ...(a as ZenTerminalAgent),
    name: typeof name === "string" ? name : "",
    back: asReturn((a as { back?: unknown }).back),
  };
}

/** Query key that reopens one session's Thread by overlay addr
 *  (`/zen?addr=k2/reviewer`). Terminal Done uses it; so do push taps. */
export const ZEN_ADDR_PARAM = "addr";

export function zenAddrPath(addr?: string | null): string {
  const a = (addr || "").trim();
  if (!a) return "/zen";
  return `/zen?${ZEN_ADDR_PARAM}=${encodeURIComponent(a)}`;
}

/** Where the terminal page's Done goes back to: the session's Thread
 *  (row + addr), the Sessions drawer origin (Done mode), and enough of the
 *  row to rebuild it when a re-read of the agent list no longer has it
 *  (`ws/N` tabs, conversation ids, History rows). */
export type ZenTerminalReturn = {
  terminalId: string;
  agentId: string;
  addr: string;
  drawerOrigin: string | null;
  side?: OverlaySidecar | null;
  /** The room's server when it is not the active one (MA17). */
  serverId?: string | null;
};

/** Survives a reload of `/zen/terminal/:id` even without history.state. */
export const ZEN_RETURN_KEY = "k2-zen-terminal-return";

type ReturnRow = {
  id: string;
  name?: string | null;
  addr?: string | null;
  path?: string | null;
  chatTitle?: string | null;
  tabId?: string | null;
  projectId?: string | null;
  terminalId?: string | null;
  hostLive?: boolean | null;
  launch?: { command: string; args: string[] } | null;
};

export function zenTerminalReturn(
  row: ReturnRow | null | undefined,
  terminalId: string,
  drawerOrigin: string | null,
  serverId?: string | null
): ZenTerminalReturn | null {
  const addr = (row?.addr || "").trim();
  if (!row || !addr || !terminalId) return null;
  const path = (row.path || "").trim();
  const origin = drawerOrigin && drawerOrigin !== row.id ? drawerOrigin : null;
  const side: OverlaySidecar | null =
    path && (addr.includes("/") || isConversationAddr(addr))
      ? {
          addr,
          path,
          name: row.name || "",
          chatTitle: row.chatTitle || sidecarSuffix(addr) || addr,
          ...(row.tabId ? { tabId: row.tabId } : {}),
          ...(row.projectId ? { projectId: row.projectId } : {}),
          ...(row.terminalId ? { terminalId: row.terminalId } : {}),
          ...(row.hostLive != null ? { hostLive: row.hostLive } : {}),
          ...(row.launch ? { launch: row.launch } : {}),
        }
      : null;
  return {
    terminalId,
    agentId: row.id,
    addr,
    drawerOrigin: origin,
    side,
    ...(serverId ? { serverId } : {}),
  };
}

function asReturn(v: unknown): ZenTerminalReturn | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Partial<ZenTerminalReturn>;
  if (typeof r.addr !== "string" || !r.addr.trim()) return null;
  if (typeof r.agentId !== "string" || typeof r.terminalId !== "string") return null;
  const side = r.side && typeof r.side === "object" && typeof r.side.addr === "string" ? r.side : null;
  return {
    terminalId: r.terminalId,
    agentId: r.agentId,
    addr: r.addr.trim(),
    drawerOrigin: typeof r.drawerOrigin === "string" && r.drawerOrigin ? r.drawerOrigin : null,
    side,
    ...(typeof r.serverId === "string" && r.serverId ? { serverId: r.serverId } : {}),
  };
}

export function rememberZenReturn(ret: ZenTerminalReturn | null): void {
  try {
    if (ret) sessionStorage.setItem(ZEN_RETURN_KEY, JSON.stringify(ret));
    else sessionStorage.removeItem(ZEN_RETURN_KEY);
  } catch {
    /* private mode */
  }
}

/** The stored return for this terminal, if it is the one last opened. */
export function readZenReturn(terminalId: string | null | undefined): ZenTerminalReturn | null {
  try {
    const raw = sessionStorage.getItem(ZEN_RETURN_KEY);
    const ret = raw ? asReturn(JSON.parse(raw)) : null;
    return ret && terminalId && ret.terminalId === terminalId ? ret : null;
  } catch {
    return null;
  }
}

/** Router state `{ zenReturn }` handed to `/zen?addr=` by terminal Done. */
export function readZenReturnState(state: unknown, addr: string): ZenTerminalReturn | null {
  if (!state || typeof state !== "object") return null;
  const ret = asReturn((state as { zenReturn?: unknown }).zenReturn);
  return ret && ret.addr === addr.trim() ? ret : null;
}
