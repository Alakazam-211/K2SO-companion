import { useEffect, useState } from "react";
import { ensureBootStatus, onBootInfo, scopeFor, type ServerScope } from "../../api/scope";
import { isPairedServer, useServersStore, type ServerEntry } from "../../stores/servers";
import { useHomesSyncStore } from "../homesSync";
import { useZenScope, zenScope } from "../zenScope";

// Which server's Gardens the phone shows (Rosson 2026-11-09): the paired
// home server, whichever server is active or has a room open. That's the
// server Home syncs from when the phone is paired with it, else the first
// paired server in the saved list. A phone paired with none keeps the
// current server, whose refusal says why there are no Gardens.

export function pickGardensServer(
  servers: Pick<ServerEntry, "id" | "auth">[],
  syncServerId: string | null
): string | null {
  const paired = servers.filter(isPairedServer);
  return (paired.find((s) => s.id === syncServerId) ?? paired[0])?.id ?? null;
}

/** For one operation; `useGardensScope` where it should follow changes. */
export function gardensScope(): ServerScope {
  const id = pickGardensServer(useServersStore.getState().servers, useHomesSyncStore.getState().serverId);
  return id ? scopeFor(id) : zenScope();
}

/** The Gardens server, re-rendering once its `/boot-status` has answered:
 *  it may not be the server the rest of the app has been reading. */
export function useGardensScope(): ServerScope {
  const zen = useZenScope();
  const servers = useServersStore((s) => s.servers);
  const syncServerId = useHomesSyncStore((s) => s.serverId);
  const id = pickGardensServer(servers, syncServerId);
  const scope = id ? scopeFor(id) : zen;
  const [, bump] = useState(0);
  const elsewhere = scope.id !== zen.id;
  useEffect(() => {
    if (!elsewhere) return;
    const off = onBootInfo((changed) => {
      if (changed === scope.id) bump((n) => n + 1);
    });
    void ensureBootStatus(scope);
    return off;
  }, [scope, elsewhere]);
  return scope;
}
