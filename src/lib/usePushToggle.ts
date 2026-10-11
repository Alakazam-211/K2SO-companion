import { useCallback, useEffect, useState } from "react";
import { getActiveServer } from "../stores/servers";
import {
  pushAvailability,
  getPushEnabled,
  setPushEnabled,
  ensureRegistered,
  unregisterAll,
} from "./push";
import { scopeFor } from "../api/scope";

export interface PushToggleState {
  /** null while the availability probe runs. */
  available: boolean | null;
  /** Probe diagnostic when unavailable. */
  reason: string | null;
  enabled: boolean;
  busy: boolean;
  toggle: () => Promise<void>;
}

/** C6 "Push notifications" toggle state, shared by the old Settings page
 *  and Zen Settings. DORMANT builds (no APNs entitlement / no
 *  google-services.json) report `available: false`. Toggling ON runs the
 *  permission→token→register-device flow for the active server; OFF
 *  unregisters this device from every saved server (registration follows
 *  the active server around). A denied OS permission ends silently inside
 *  `ensureRegistered` — the switch stays on, as before. */
export function usePushToggle(): PushToggleState {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const a = await pushAvailability();
      const on = a.available ? await getPushEnabled() : false;
      if (!alive) return;
      setAvailable(a.available);
      setReason(a.reason ?? null);
      setEnabled(on);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const toggle = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const next = !enabled;
    setEnabled(next); // optimistic — the register/unregister is best-effort
    try {
      await setPushEnabled(next);
      if (next) {
        const active = getActiveServer();
        if (active) await ensureRegistered(scopeFor(active.id));
      } else {
        await unregisterAll();
      }
    } finally {
      setBusy(false);
    }
  }, [busy, enabled]);

  return { available, reason, enabled, busy, toggle };
}
