// Pictures for rows from other servers (multi-server MA24, new MS43).
//
// A row whose `projects/list` entry has no usable `iconUrl` asks its OWN
// server `GET /cli/projects/get-icon {path, project_id}` — only while that
// server's pool entry is live with a good login, at most once a day per
// (server, project), with a 60 s back-off after a failure. `get-icon`
// writes the daemon's icon cache, so it is never asked on every poll. Not
// gated on `home-avatars-v1` (that key is desktop's local-daemon cache).
// Kept in memory, per server id; a removed or re-keyed server drops its
// pictures.

import { create } from "zustand";
import { getProjectIcon } from "../../api/client";
import { scopeFor } from "../../api/scope";
import { onServerForget } from "../../stores/servers";

export const ICON_REFRESH_MS = 24 * 60 * 60 * 1000;
export const ICON_FAILURE_BACKOFF_MS = 60_000;

type IconEntry = { dataUrl: string | null; at: number };

export const useRemoteIcons = create<{ icons: Record<string, IconEntry> }>(() => ({ icons: {} }));

const failedAt = new Map<string, number>();
const inflight = new Set<string>();

export function iconKey(serverId: string, projectId: string): string {
  return `${serverId}|${projectId}`;
}

export function isImageDataUrl(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("data:image/");
}

/** Ask `serverId` for a workspace's picture when due. Never throws. */
export async function ensureRemoteIcon(
  serverId: string,
  projectId: string | null,
  path: string | null | undefined,
  now: () => number = Date.now
): Promise<void> {
  if (!projectId || !path) return;
  const key = iconKey(serverId, projectId);
  const known = useRemoteIcons.getState().icons[key];
  const t = now();
  if (known && t - known.at < ICON_REFRESH_MS) return;
  const failed = failedAt.get(key);
  if (failed !== undefined && t - failed < ICON_FAILURE_BACKOFF_MS) return;
  if (inflight.has(key)) return;
  inflight.add(key);
  try {
    const r = await getProjectIcon(scopeFor(serverId), path, projectId);
    if (!r.ok) {
      failedAt.set(key, now());
      return;
    }
    const d = r.data;
    const dataUrl = d && d.found === true && isImageDataUrl(d.dataUrl) ? d.dataUrl : null;
    failedAt.delete(key);
    useRemoteIcons.setState((s) => ({ icons: { ...s.icons, [key]: { dataUrl, at: now() } } }));
  } catch {
    failedAt.set(key, now());
  } finally {
    inflight.delete(key);
  }
}

/** The fetched picture for a remote row, or null. */
export function remoteIconFor(
  icons: Record<string, IconEntry>,
  serverId: string,
  projectId: string | null
): string | null {
  if (!projectId) return null;
  return icons[iconKey(serverId, projectId)]?.dataUrl ?? null;
}

onServerForget((id) => {
  const prefix = `${id}|`;
  for (const k of [...failedAt.keys()]) if (k.startsWith(prefix)) failedAt.delete(k);
  useRemoteIcons.setState((s) => {
    const icons = { ...s.icons };
    let changed = false;
    for (const k of Object.keys(icons)) {
      if (k.startsWith(prefix)) {
        delete icons[k];
        changed = true;
      }
    }
    return changed ? { icons } : s;
  });
});

/** Tests only. */
export function __resetRemoteIconsForTests(): void {
  failedAt.clear();
  inflight.clear();
  useRemoteIcons.setState({ icons: {} });
}
