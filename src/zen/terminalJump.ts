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
    if (hit) return hit.terminalId;
  }
  const main = onPath.find((s) => s.isMainChat);
  if (main) return main.terminalId;
  return onPath[0]?.terminalId ?? null;
}
