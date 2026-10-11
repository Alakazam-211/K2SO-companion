// The room's `companion/sessions` (multi-server MS23, MA18). On the active
// server it is the workspaces store, exactly as before; a room on another
// server reads that server's list on its own scope (the workspaces store
// is the active server's, classic pages share it).

import { useCallback, useEffect, useState } from "react";
import { getAllSessions, type GlobalSession } from "../../api/client";
import type { ServerScope } from "../../api/scope";
import { useServersStore } from "../../stores/servers";
import { useWorkspacesStore } from "../../stores/workspaces";

export function useRoomSessions(scope: ServerScope): {
  sessions: GlobalSession[];
  onActive: boolean;
  refresh: () => Promise<void>;
} {
  const activeServerId = useServersStore((s) => s.activeServerId);
  const onActive = !scope.id || scope.id === activeServerId;
  const activeSessions = useWorkspacesStore((s) => s.allSessions);
  const [own, setOwn] = useState<{ serverId: string; rows: GlobalSession[] } | null>(null);

  const refresh = useCallback(async () => {
    if (onActive) {
      await useWorkspacesStore.getState().fetchAllSessions();
      return;
    }
    const id = scope.id;
    try {
      const r = await getAllSessions(scope);
      if (r.ok && Array.isArray(r.data)) setOwn({ serverId: id, rows: r.data });
    } catch {
      /* keep what is on screen */
    }
  }, [onActive, scope]);

  useEffect(() => {
    if (!onActive) void refresh();
  }, [onActive, refresh]);

  const sessions = onActive ? activeSessions : own?.serverId === scope.id ? own.rows : [];
  return { sessions, onActive, refresh };
}
