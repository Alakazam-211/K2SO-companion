import { invoke } from "@tauri-apps/api/core";
import { isIosWebView } from "../../lib/nativePicker";

// The in-app ring for a DM call (never for a silent ring: busy, Do Not
// Disturb, a muted DM). Two tones for 1.5 s every 4 s, as a phone rings,
// with a light tap each time on iOS. Best effort: a webview that hasn't
// been touched yet may keep its audio suspended, and then only the tap and
// the card say it. With the app in the background the push rings instead.

export interface RingTone {
  start(): void;
  stop(): void;
}

const CYCLE_MS = 4_000;
const TONE_S = 1.5;

function haptic(): void {
  if (!isIosWebView()) return;
  void invoke("plugin:k2-push|call_op", { op: "haptic" }).catch(() => {});
}

export function webRingTone(): RingTone {
  let timer: ReturnType<typeof setInterval> | null = null;
  let ctx: AudioContext | null = null;

  function ring(): void {
    haptic();
    try {
      const Ctor =
        (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
        (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      ctx ??= new Ctor();
      if (ctx.state === "suspended") void ctx.resume().catch(() => {});
      const at = ctx.currentTime;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.12, at + 0.05);
      gain.gain.setValueAtTime(0.12, at + TONE_S - 0.05);
      gain.gain.linearRampToValueAtTime(0, at + TONE_S);
      gain.connect(ctx.destination);
      for (const hz of [440, 480]) {
        const osc = ctx.createOscillator();
        osc.frequency.value = hz;
        osc.connect(gain);
        osc.start(at);
        osc.stop(at + TONE_S);
      }
    } catch {
      // No audio here: the card and the tap still say it.
    }
  }

  return {
    start() {
      if (timer) return;
      ring();
      timer = setInterval(ring, CYCLE_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      const c = ctx;
      ctx = null;
      if (c) void c.close().catch(() => {});
    },
  };
}

let tone: RingTone | null = null;

export function ringTone(): RingTone {
  tone ??= webRingTone();
  return tone;
}

export function __setRingToneForTests(next: RingTone | null): void {
  tone?.stop();
  tone = next;
}
