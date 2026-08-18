import { useEffect, useState } from "react";
import { useServersStore } from "../stores/servers";
import {
  ensureIdentity,
  getIdentity,
  subscribeIdentity,
  type SessionIdentity,
} from "./sessionAuthor";

/** Live whoami for the active server (Connect username + owner bit). */
export function useSessionIdentity(): SessionIdentity | null {
  const serverId = useServersStore((s) => s.activeServerId);
  const [identity, setIdentity] = useState<SessionIdentity | null>(getIdentity);
  useEffect(() => {
    const unsub = subscribeIdentity(() => setIdentity(getIdentity()));
    void ensureIdentity().then(setIdentity);
    return unsub;
  }, [serverId]);
  return identity;
}
