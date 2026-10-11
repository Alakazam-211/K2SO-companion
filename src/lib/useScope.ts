import { useServersStore } from "../stores/servers";
import { scopeFor, type ServerScope } from "../api/scope";

/** The active server's scope, re-rendering on a switch. The classic-page
 *  shim (MS5): Zen code uses `useZenScope()` instead. */
export function useActiveScope(): ServerScope {
  const id = useServersStore((s) => s.activeServerId);
  return scopeFor(id);
}
