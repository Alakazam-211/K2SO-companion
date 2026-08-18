// Acting human for Project / Feedback attribution.
//
// Daemon D3: owner token stores author `"owner"` (agent injection uses
// the server display name). A Connect-user token stores their username
// and the agent is framed `[from <username>]`. The phone must treat
// "mine" as that session identity — not every `"owner"` row.

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { getBaseUrl, getToken } from "../api/client";
import { useServersStore } from "../stores/servers";

export interface SessionIdentity {
  /** Connect login name, or `"owner"` when the token is the host. */
  username: string;
  owner: boolean;
}

let cached: { serverId: string | null; identity: SessionIdentity } | null =
  null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function subscribeIdentity(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getIdentity(): SessionIdentity | null {
  return cached?.identity ?? null;
}

/** True when this row was posted by the signed-in session. */
export function isMyAuthor(
  author: string,
  identity: SessionIdentity | null,
): boolean {
  if (!author) return false;
  if (!identity) return author === "owner";
  if (identity.owner) return author === "owner";
  return author === identity.username;
}

export function displayAuthor(
  author: string,
  identity: SessionIdentity | null,
): string {
  return isMyAuthor(author, identity) ? "You" : author;
}

/** Probe `/cli/auth/whoami` for the active server. Cached per server. */
export async function ensureIdentity(): Promise<SessionIdentity | null> {
  const serverId = useServersStore.getState().activeServerId;
  if (cached && cached.serverId === serverId) return cached.identity;
  const base = getBaseUrl();
  const token = getToken();
  const fallback: SessionIdentity = {
    username: useServersStore.getState().servers.find((s) => s.id === serverId)
      ?.username ?? "owner",
    owner: false,
  };
  if (!base || !token) {
    cached = { serverId, identity: fallback };
    emit();
    return fallback;
  }
  try {
    const res = await tauriFetch(
      `${base}/cli/auth/whoami?token=${encodeURIComponent(token)}`,
    );
    if (!res.ok) throw new Error(String(res.status));
    const j = (await res.json()) as {
      username?: string | null;
      owner?: boolean;
    };
    const identity: SessionIdentity = {
      username: (j.username && j.username.trim()) || fallback.username,
      owner: j.owner === true,
    };
    cached = { serverId, identity };
    emit();
    return identity;
  } catch {
    cached = { serverId, identity: fallback };
    emit();
    return fallback;
  }
}

/** Tests / server-switch. */
export function __resetIdentityForTests(): void {
  cached = null;
}
