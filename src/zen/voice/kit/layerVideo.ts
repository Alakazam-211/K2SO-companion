import { NO_VIDEO_CAPS, type NativeBridge, type NativeVideo, type NativeVideoInfo, type PluginVideoTrack, type VideoHandle } from "@sew/voice";
import { useVoiceCall } from "../voiceCall";

// The kit's video hook (`native.video`) on the phone: no sinks, no WebCodecs.
// The phone has one picture, K2PiP's native layer, fed by Rust's
// active-speaker sink (src-tauri/src/voice.rs, PipSink). This tells the kit
// whose tile that picture belongs on, so its CallView's `renderTile` gives
// that tile's rect to the layer (videoLayer.tsx). Passing it also keeps the
// kit's own PluginVideo (the default since kit b735531) from opening a
// second set of sinks.
//   - whose: Rust's `k2-voice://pip_speaker` (the sink's `Switched`), else
//     the first remote screen share, else the first remote camera, from the
//     plugin's `sew-voice://video` tracks; only while the call has video
//     (the store's flag: the sink is open);
//   - never yourself (the sink never shows you);
//   - camera and screen buttons stay hidden (`NO_VIDEO_CAPS`): the phone
//     doesn't send video from this screen.

/** The layer's handle: the layer is the video, so nothing attaches. */
export const LAYER_HANDLE: VideoHandle = { key: "k2-layer", attach() {}, detach() {} };

const NONE = { camera: null, screen: null };

type Shown = { memberId: string; source: "camera" | "screen"; track: string | null };
type Speaker = { memberId: string | null; track: string | null };

function tracksOf(list: unknown): PluginVideoTrack[] {
  return Array.isArray(list) ? (list as PluginVideoTrack[]).filter((t) => t && typeof t.member_id === "string") : [];
}

export function speakerOf(payload: unknown): Speaker | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { member_id?: unknown; track?: unknown };
  return {
    memberId: typeof p.member_id === "string" ? p.member_id : null,
    track: typeof p.track === "string" ? p.track : null,
  };
}

/** Whose picture the layer shows, as far as the phone knows. */
export function shownOf(tracks: PluginVideoTrack[], speaker: Speaker | null, video: boolean): Shown | null {
  if (!video) return null;
  const remote = tracks.filter((t) => !t.is_self && !t.muted && !t.unsupported);
  if (speaker) {
    // Rust said: exactly this one, or nobody.
    if (!speaker.memberId) return null;
    const t = remote.find((x) => x.track === speaker.track) ?? remote.find((x) => x.member_id === speaker.memberId);
    return { memberId: speaker.memberId, source: t?.source ?? "camera", track: t?.track ?? speaker.track };
  }
  const t = remote.find((x) => x.source === "screen") ?? remote.find((x) => x.source === "camera");
  return t ? { memberId: t.member_id, source: t.source, track: t.track } : null;
}

export class LayerVideo implements NativeVideo {
  private tracks: PluginVideoTrack[] = [];
  private speaker: Speaker | null = null;
  private video = useVoiceCall.getState().video;
  private readonly listeners = new Set<() => void>();
  private unlisten: (() => void)[] = [];
  private closed = false;

  constructor(private readonly bridge: NativeBridge) {}

  async start(): Promise<void> {
    const on = async (event: string, fn: (p: unknown) => void) => {
      try {
        const off = await this.bridge.listen<unknown>(event, (p) => {
          if (!this.closed) fn(p);
        });
        if (this.closed) off();
        else this.unlisten.push(off);
      } catch {
        // an older shell: its part stays empty
      }
    };
    this.unlisten.push(
      useVoiceCall.subscribe((s) => {
        if (s.video === this.video) return;
        this.video = s.video;
        // The sink closed: its speaker goes with it.
        if (!s.video) this.speaker = null;
        this.changed();
      })
    );
    await Promise.all([
      on("sew-voice://video", (v) => {
        this.tracks = tracksOf(v);
        this.changed();
      }),
      on("k2-voice://pip_speaker", (p) => {
        this.speaker = speakerOf(p);
        this.changed();
      }),
    ]);
    if (this.closed) return;
    try {
      const snap = await this.bridge.invoke<{ video?: unknown } | null>("plugin:sew-voice|state");
      if (!this.tracks.length) this.tracks = tracksOf(snap?.video);
    } catch {
      // no plugin
    }
    this.changed();
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  shown(): Shown | null {
    return shownOf(this.tracks, this.speaker, this.video);
  }

  handles(_identity: string, local: boolean, memberId?: string | null): { camera: VideoHandle | null; screen: VideoHandle | null } {
    const s = this.shown();
    if (local || !s || !memberId || s.memberId !== memberId) return NONE;
    return s.source === "screen" ? { camera: null, screen: LAYER_HANDLE } : { camera: LAYER_HANDLE, screen: null };
  }

  tracksOf(memberId: string | null, local: boolean): { camera: string | null; screen: string | null } {
    const mine = this.tracks.filter((t) => (local ? t.is_self : t.member_id === memberId && !t.is_self) && !t.muted);
    return {
      camera: mine.find((t) => t.source === "camera")?.track ?? null,
      screen: mine.find((t) => t.source === "screen")?.track ?? null,
    };
  }

  info(): NativeVideoInfo {
    return { caps: NO_VIDEO_CAPS, devices: null, local: null, tiles: false };
  }

  setCamera(): Promise<void> {
    return Promise.reject({ code: "video_unsupported", detail: "the phone doesn't send video from the call screen" });
  }

  setScreen(): Promise<void> {
    return Promise.reject({ code: "video_unsupported", detail: "the phone doesn't send video from the call screen" });
  }

  close(): void {
    this.closed = true;
    for (const off of this.unlisten.splice(0)) off();
    this.listeners.clear();
  }
}
