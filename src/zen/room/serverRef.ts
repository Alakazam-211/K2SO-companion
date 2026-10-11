// `?server=` in Zen routes and deep links (multi-server MA17).
//
// Links say WHICH saved server a thread or terminal is on:
//   `/zen?server=<ref>&addr=…`, `/zen?server=<ref>&thread=…`,
//   `/zen/terminal/:terminalId?server=<ref>`.
// The ref is the server's host key when no other saved server shares it
// (readable, and stable across a reinstall), else its id. Reading accepts
// either. A link without `server=` means the active server (old links).
// A ref that names no saved server resolves to null: the caller drops the
// link rather than opening it on another server (MS7).

import { serverHostKey, useServersStore } from "../../stores/servers";

export const ZEN_SERVER_PARAM = "server";

/** The ref to write for `serverId`. */
export function serverRefFor(serverId: string | null | undefined): string | null {
  if (!serverId) return null;
  const { servers } = useServersStore.getState();
  const entry = servers.find((s) => s.id === serverId);
  if (!entry) return null;
  const key = serverHostKey(entry);
  const shared = servers.filter((s) => serverHostKey(s) === key).length > 1;
  return shared || !key ? serverId : key;
}

/** The saved server id a ref names: by id first, then by host key (the
 *  one holding a token wins, then the active one). */
export function resolveServerRef(ref: string | null | undefined): string | null {
  const r = (ref || "").trim();
  if (!r) return null;
  const st = useServersStore.getState();
  if (st.servers.some((s) => s.id === r)) return r;
  const key = r.toLowerCase();
  const hits = st.servers.filter((s) => serverHostKey(s) === key);
  if (hits.length === 0) return null;
  return (
    hits.find((s) => (st.tokens[s.id] ?? "").length > 0 && s.id === st.activeServerId)?.id ??
    hits.find((s) => (st.tokens[s.id] ?? "").length > 0)?.id ??
    hits[0].id
  );
}

/** `path` with `?server=<ref>` (or `&server=`) when `serverId` is given. */
export function withServerParam(path: string, serverId: string | null | undefined): string {
  const ref = serverRefFor(serverId);
  if (!ref) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}${ZEN_SERVER_PARAM}=${encodeURIComponent(ref)}`;
}
