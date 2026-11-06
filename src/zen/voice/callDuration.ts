import { useEffect, useState } from "react";
import { useVoiceCall } from "./voiceCall";

// The call's time (Rosson 2026-11-06: "there is no call duration value that
// I can use"): from the call's first connect (`startedAt` in the call
// store), shown in the call bar always and on the floating card while its
// picture is up.

/** A call's time: `m:ss` under an hour, `h:mm:ss` after. */
export function formatCallDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The call's time, ticking once a second while mounted and the page is
 *  in front (paused while hidden, caught up on return); `null` until the
 *  call first connects. */
export function useCallDuration(): string | null {
  const startedAt = useVoiceCall((s) => s.startedAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const tick = () => {
      stop();
      const t = Date.now();
      setNow(t);
      if (document.visibilityState === "hidden") return;
      // On the call's own second, so the digits turn together.
      timer = setTimeout(tick, 1000 - (((t - startedAt) % 1000) + 1000) % 1000);
    };
    const onVisibility = () => (document.visibilityState === "hidden" ? stop() : tick());
    tick();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [startedAt]);
  return startedAt === null ? null : formatCallDuration(now - startedAt);
}
