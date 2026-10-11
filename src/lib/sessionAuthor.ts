// Acting human for Project / Feedback attribution.
//
// Daemon D3: owner token stores author `"owner"` (agent injection uses
// the server display name). A Connect-user token stores their username
// and the agent is framed `[from <username>]`. The phone must treat
// "mine" as that session identity — not every `"owner"` row.

import { scopedFetch } from "../api/scopedFetch";
import { serverMemory, type ServerScope } from "../api/scope";
import { useServersStore } from "../stores/servers";

export interface SessionIdentity {
  /** Connect login name, or `"owner"` when the token is the host. */
  username: string;
  owner: boolean;
  /** whoami `role`: "owner" | "admin" | "member". Absent on older daemons
   *  or when whoami failed. */
  role?: string | null;
}

// One identity per server (MA6): a whoami for server B never answers for
// server A. Dropped when a server is removed or re-keyed (MS3).
const cached = serverMemory<{ identity: SessionIdentity | null }>(() => ({ identity: null }));
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function subscribeIdentity(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The cached identity for `scope`'s server, or null before the first probe. */
export function getIdentity(scope: ServerScope): SessionIdentity | null {
  return cached.peek(scope.id)?.identity ?? null;
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

/** Probe `/cli/auth/whoami` on `scope`'s server. Cached per server. No
 *  revive: an identity probe must not move recovery state. */
export async function ensureIdentity(scope: ServerScope): Promise<SessionIdentity | null> {
  const hit = cached.peek(scope.id)?.identity;
  if (hit) return hit;
  const entry = useServersStore.getState().servers.find((s) => s.id === scope.id);
  const fallback: SessionIdentity = {
    username: entry?.username ?? "owner",
    owner: false,
  };
  const remember = (identity: SessionIdentity): SessionIdentity => {
    cached.get(scope.id).identity = identity;
    emit();
    return identity;
  };
  let base = "";
  let token = "";
  try {
    base = scope.httpBase();
    token = scope.token();
  } catch {
    return remember(fallback);
  }
  if (!base || !token) return remember(fallback);
  try {
    const res = await scopedFetch(scope, "/cli/auth/whoami", { revive: false });
    if (!res.ok) throw new Error(String(res.status));
    const j = JSON.parse(res.text) as {
      username?: string | null;
      owner?: boolean;
      role?: string | null;
    };
    return remember({
      username: (j.username && j.username.trim()) || fallback.username,
      owner: j.owner === true,
      role: typeof j.role === "string" && j.role.trim() ? j.role.trim() : null,
    });
  } catch {
    return remember(fallback);
  }
}

/** Tests only. */
export function __resetIdentityForTests(): void {
  cached.clear();
}
