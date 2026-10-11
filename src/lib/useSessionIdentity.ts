import { useEffect, useState } from "react";
import type { ServerScope } from "../api/scope";
import {
  ensureIdentity,
  getIdentity,
  subscribeIdentity,
  type SessionIdentity,
} from "./sessionAuthor";

/** Live whoami for `scope`'s server (Connect username + owner bit). Pass the
 *  surface's scope: `useActiveScope()` on classic pages, `useZenScope()` in
 *  Zen. A new scope re-probes (cached per server). */
export function useSessionIdentity(scope: ServerScope): SessionIdentity | null {
  const [identity, setIdentity] = useState<SessionIdentity | null>(() => getIdentity(scope));
  useEffect(() => {
    let live = true;
    setIdentity(getIdentity(scope));
    const unsub = subscribeIdentity(() => {
      if (live) setIdentity(getIdentity(scope));
    });
    void ensureIdentity(scope).then((id) => {
      if (live) setIdentity(id);
    });
    return () => {
      live = false;
      unsub();
    };
  }, [scope]);
  return identity;
}
