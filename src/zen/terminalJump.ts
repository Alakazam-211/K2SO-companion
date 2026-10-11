import type { GlobalSession } from "../api/client";
import { sidecarSuffix } from "./sidecarRows";
import { posixNormalize } from "./workspacePath";

export const ZEN_THREAD_KEY = "k2-zen-thread";

export function rememberZenThread(agentId: string | null | undefined): void {
  try {
    if (agentId) sessionStorage.setItem(ZEN_THREAD_KEY, agentId);
    else sessionStorage.removeItem(ZEN_THREAD_KEY);
  } catch {
    /* private mode */
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

/** Pick the original-UI terminal for an overlay agent. Null → /sessions. */
export function terminalIdForAgent(
  agent: { path?: string | null; addr?: string | null } | null | undefined,
  sessions: GlobalSession[]
): string | null {
  if (!agent || !sessions.length) return null;
  const path = posixNormalize((agent.path || "").trim());
  if (!path) return null;
  const onPath = sessions.filter((s) => posixNormalize(s.cwd || "") === path);
  if (!onPath.length) return null;
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
};

export function readZenTerminalAgent(state: unknown): ZenTerminalAgent | null {
  if (!state || typeof state !== "object") return null;
  const a = (state as { agent?: unknown }).agent;
  if (!a || typeof a !== "object") return null;
  const agentId = (a as { agentId?: unknown }).agentId;
  const name = (a as { name?: unknown }).name;
  if (typeof agentId !== "string" || !agentId.trim()) return null;
  return { ...(a as ZenTerminalAgent), name: typeof name === "string" ? name : "" };
}
