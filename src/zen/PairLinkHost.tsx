import { useEffect } from "react";
import { usePairLinkStore, watchPairLinks } from "../lib/pairLinks";
import { useBackHandler } from "../lib/androidBack";
import { OverlayAddServer } from "./OverlayAddServer";

/** A pair link that opened the app (K2 0.46.4 `companion-pairing-v1`):
 *  "Pairing code", filled in, on its confirm step. Nothing is paired until
 *  the user taps Pair there. */
export function PairLinkHost() {
  const pending = usePairLinkStore((s) => s.pending);
  const clear = () => usePairLinkStore.getState().set(null);
  useEffect(() => watchPairLinks(), []);
  useBackHandler(Boolean(pending), clear);
  if (!pending) return null;
  return (
    <div
      className="fixed inset-0 flex flex-col"
      style={{ background: "#000", zIndex: 80, paddingTop: "env(safe-area-inset-top)" }}
      data-testid="pair-link"
    >
      <OverlayAddServer key={`${pending.serverUrl ?? ""}#${pending.code}`} pairLink={pending} onCancel={clear} onSaved={clear} />
    </div>
  );
}
