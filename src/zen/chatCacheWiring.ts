import { onServerForget, useServersStore } from "../stores/servers";
import { chatCache } from "./chatCache";

// When the chat cache forgets (privacy): a server removed or re-keyed (it
// may be another daemon), a server signed out (its token went away), and
// everything once no server is left. At start (servers loaded), entries
// of servers no longer saved are pruned. Pending writes go out when the
// app goes to the background.

let installed = false;

export function installChatCacheWiring(): void {
  if (installed) return;
  installed = true;

  onServerForget((id) => {
    void chatCache().forgetServer(id);
  });

  let pruned = false;
  const pruneOnce = (ids: string[]) => {
    if (pruned) return;
    pruned = true;
    void chatCache().prune(ids);
  };
  const ids = (list: { id: string }[] | undefined) => (list ?? []).map((s) => s.id);
  const st0 = useServersStore.getState();
  if (st0?.hydrated) pruneOnce(ids(st0.servers));

  useServersStore.subscribe((st, prev) => {
    if (st.hydrated && !prev.hydrated) pruneOnce(ids(st.servers));
    if (st.tokens !== prev.tokens) {
      for (const [id, tok] of Object.entries(prev.tokens ?? {})) {
        if (tok && !st.tokens?.[id]) void chatCache().forgetServer(id);
      }
    }
    if (st.hydrated && (prev.servers?.length ?? 0) > 0 && (st.servers?.length ?? 0) === 0) {
      void chatCache().clearAll();
    }
  });

  if (typeof document !== "undefined" && typeof window !== "undefined") {
    const flush = () => void chatCache().flush();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
    window.addEventListener("pagehide", flush);
  }
}
