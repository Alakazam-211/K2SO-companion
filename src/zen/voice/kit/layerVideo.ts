import {
  NO_VIDEO_CAPS,
  PluginVideo,
  type NativeBridge,
  type NativeVideo,
  type NativeVideoInfo,
  type PluginFacing,
  type PluginVideoDevices,
  type PluginVideoTrack,
  type VideoHandle,
} from "@sew/voice";
import { followPip, usePipStatus } from "../videoTile";
import { useVoiceCall } from "../voiceCall";

// The kit's video hook (`native.video`) on the phone. Two halves:
//   - Your camera: the kit's own PluginVideo (kit b735531), delegated to.
//     It turns the camera on and off through the plugin (`camera {on,
//     device?}`, after the kit's permission step in the controller), flips
//     it (`set_video_device` with the other `facing` from `video_devices`),
//     follows `local_video` (on, paused in the background, off after 5 min)
//     and gives your tile its self-view: a webview sink on `local:camera`.
//     Only `local:camera` ever opens through it: never a remote track, never
//     `local:screen` (your shared screen isn't drawn back on your tile).
//   - Your screen: iOS shares it only from a broadcast upload extension
//     (K2Broadcast), which the person starts in iOS's broadcast picker.
//     The kit's screen button shows once Rust armed the extension's ring
//     for this call (`k2-voice://screen` `armed`, read back with
//     `voice_screen` for a call screen opened late): `setScreen(true)` opens
//     the picker (`callOp broadcastPicker`) and answers `picker_cancelled`,
//     so the button stays off without a sentence until the share really
//     starts. It starts and stops outside the app: the plugin's
//     `local_video` (sent with `screen_share_changed`, which Rust passes on
//     as `active`) turns the kit's button on and off. Stop is the button
//     again: `setScreen(false)`, the plugin's `screen {on: false}`, which
//     asks the extension to finish. The kit shows it only while the room's
//     policy allows video (and the screen), enabled only while connected.
//   - Everyone else: no webview sinks. The phone has one picture of them,
//     K2PiP's native layer, fed by Rust's active-speaker sink (src-tauri/
//     src/voice.rs, PipSink), which never shows you. This tells the kit
//     whose tile that picture belongs on, so its CallView's `renderTile`
//     gives that tile's rect to the layer (videoLayer.tsx). Passing a hook
//     at all keeps the kit from making its own PluginVideo, which would open
//     a second set of remote sinks.
//
// Whose picture, and only while it is really live:
//   - whose: Rust's `k2-voice://pip_speaker` (the sink's `Switched`, also
//     read back with `voice_pip_speaker` when the call screen opens late;
//     a switch naming only the track gets its person from that track's
//     row), else
//     the first remote screen share, else the first remote camera, from the
//     plugin's `sew-voice://video` rows; only while the call has video (the
//     store's flag: the sink is open), never a muted or paused track, never
//     yourself;
//   - live: the layer shows a frame (K2PiP's `pip_first_frame` since the
//     last flush, until `pip_cleared` or `pip_stalled`), or plays in PiP.
//     Before that the tile is the person's avatar, with "Video starting…"
//     for at most STARTING_MS (KitCall's avatar note); after a stall, the
//     plain avatar.

/** The layer's handle: the layer is the video, so nothing attaches. */
export const LAYER_HANDLE: VideoHandle = { key: "k2-layer", attach() {}, detach() {} };

/** How long a person's tile says "Video starting…" before the first frame. */
export const STARTING_MS = 3000;

/** The iPhone's screen share (Rust's `k2-voice://screen`): the extension's
 *  ring is ready (`armed`), and the screen is being shared (`active`). */
export type ScreenShare = { armed: boolean; active: boolean };

const NO_SHARE: ScreenShare = { armed: false, active: false };

/** The kit's screen caps on the phone: no list, only iOS's picker. */
export const PHONE_SCREEN_CAPS = { supported: true, system_picker: true, list: false, windows: false };

export function screenShareOf(payload: unknown): ScreenShare {
  if (!payload || typeof payload !== "object") return NO_SHARE;
  const p = payload as { armed?: unknown; active?: unknown };
  return { armed: p.armed === true, active: p.active === true };
}

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

/** A track with pictures coming: not muted, not paused (congestion,
 *  background, policy), one the engine can decode. */
function flowing(t: PluginVideoTrack): boolean {
  return !t.muted && !t.paused && !t.unsupported;
}

/** Whose picture the layer shows, as far as the phone knows. */
export function shownOf(tracks: PluginVideoTrack[], speaker: Speaker | null, video: boolean): Shown | null {
  if (!video) return null;
  const remote = tracks.filter((t) => !t.is_self);
  const live = remote.filter(flowing);
  if (speaker) {
    // Rust said: exactly this one, or nobody. A switch that names only the
    // track gets its person from the track's row.
    const byTrack = speaker.track ? tracks.find((t) => t.track === speaker.track) : undefined;
    const memberId = speaker.memberId ?? byTrack?.member_id ?? null;
    if (!memberId) return null;
    // Never yourself.
    if (byTrack?.is_self || tracks.some((t) => t.is_self && t.member_id === memberId)) return null;
    // Their rows say muted or paused: nothing is coming.
    const theirs = remote.filter((x) => x.track === speaker.track || x.member_id === memberId);
    if (theirs.length > 0 && !theirs.some(flowing)) return null;
    const t = live.find((x) => x.track === speaker.track) ?? live.find((x) => x.member_id === memberId);
    return { memberId, source: t?.source ?? "camera", track: t?.track ?? speaker.track };
  }
  const t = live.find((x) => x.source === "screen") ?? live.find((x) => x.source === "camera");
  return t ? { memberId: t.member_id, source: t.source, track: t.track } : null;
}

/** The layer shows that picture now: a frame since the last flush, or PiP. */
export function liveOf(shown: Shown | null, pip: { frame: boolean; active: boolean }): Shown | null {
  return shown && (pip.frame || pip.active) ? shown : null;
}

/** Which way the camera in use faces (`null`: not listed). */
export function facingOf(devices: PluginVideoDevices | null, chosen: string | null): PluginFacing | null {
  if (!devices || !Array.isArray(devices.cameras)) return null;
  const id = devices.camera ?? chosen;
  const cam = devices.cameras.find((c) => c.id === id) ?? devices.cameras.find((c) => c.default) ?? devices.cameras[0];
  return cam?.facing ?? null;
}

/** Your self-view is mirrored for the front camera only (as in a mirror);
 *  an unlisted camera is taken as the front one, the phone's default. */
export function mirrorFor(facing: PluginFacing | null): boolean {
  return facing === "front" || facing === null;
}

export class LayerVideo implements NativeVideo {
  private tracks: PluginVideoTrack[] = [];
  private speaker: Speaker | null = null;
  private video = useVoiceCall.getState().video;
  private pip = { frame: usePipStatus.getState().frame, active: usePipStatus.getState().active };
  /** Whose tile is waiting for its first frame, since when. */
  private waiting: { memberId: string; at: number } | null = null;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  /** The camera last asked for by id (the plugin's list may not say yet). */
  private chosen: string | null = null;
  private share: ScreenShare = NO_SHARE;
  private readonly listeners = new Set<() => void>();
  private unlisten: (() => void)[] = [];
  private closed = false;
  /** The kit's own video hook: your camera and its self-view only. */
  readonly camera: PluginVideo;

  constructor(
    private readonly bridge: NativeBridge,
    camera?: PluginVideo,
    private readonly now: () => number = () => Date.now()
  ) {
    this.camera = camera ?? new PluginVideo({ bridge });
  }

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
    followPip();
    this.unlisten.push(
      useVoiceCall.subscribe((s) => {
        if (s.video === this.video) return;
        this.video = s.video;
        // The sink closed: its speaker goes with it.
        if (!s.video) this.speaker = null;
        this.changed();
      }),
      usePipStatus.subscribe((s) => {
        if (s.frame === this.pip.frame && s.active === this.pip.active) return;
        this.pip = { frame: s.frame, active: s.active };
        this.changed();
      }),
      this.camera.subscribe(() => this.changed())
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
      on("k2-voice://screen", (p) => {
        const was = this.share.active;
        this.share = screenShareOf(p);
        // iOS's broadcast sheet has no close button: once the share starts
        // or stops, it goes away by itself.
        if (this.share.active !== was) {
          void this.bridge.invoke("plugin:k2-push|call_op", { op: "broadcastPickerClose" }).catch(() => undefined);
        }
        this.changed();
      }),
      this.camera.start(),
    ]);
    if (this.closed) return;
    try {
      const snap = await this.bridge.invoke<{ video?: unknown } | null>("plugin:sew-voice|state");
      if (!this.tracks.length) this.tracks = tracksOf(snap?.video);
    } catch {
      // no plugin
    }
    // The sink's last switch, for a call screen opened after it went by
    // (else the picture would wait for the next switch, off its tile).
    try {
      const who = await this.bridge.invoke<unknown>("voice_pip_speaker");
      if (!this.speaker && this.video) this.speaker = speakerOf(who);
    } catch {
      // an older shell
    }
    // The screen share's state, for a call screen opened after the event.
    try {
      const now = screenShareOf(await this.bridge.invoke<unknown>("voice_screen"));
      if (!this.share.armed && !this.share.active) this.share = now;
    } catch {
      // an older shell: no screen share
    }
    this.changed();
  }

  private changed(): void {
    this.track();
    for (const fn of this.listeners) fn();
  }

  /** Follow whose tile waits for its first frame (and wake once its
   *  "Video starting…" is over). */
  private track(): void {
    const s = this.shown();
    if (!s) {
      this.waiting = null;
    } else if (this.waiting?.memberId !== s.memberId) {
      this.waiting = { memberId: s.memberId, at: this.now() };
      if (this.waitTimer) clearTimeout(this.waitTimer);
      this.waitTimer = setTimeout(() => {
        this.waitTimer = null;
        if (!this.closed) for (const fn of this.listeners) fn();
      }, STARTING_MS);
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  shown(): Shown | null {
    return shownOf(this.tracks, this.speaker, this.video);
  }

  /** The shown picture while the layer really plays it. */
  live(): Shown | null {
    return liveOf(this.shown(), this.pip);
  }

  /** The layer plays someone else's picture, even if the kit can't tell
   *  whose yet (no rows, no word from Rust): never when all it could be is
   *  you (the sink never shows you) or nobody. */
  othersPlaying(): boolean {
    if (!this.video || !(this.pip.frame || this.pip.active)) return false;
    if (this.speaker) return this.shown() !== null;
    return this.tracks.length === 0 || this.tracks.some((t) => !t.is_self && flowing(t));
  }

  /** Whose avatar says "Video starting…" now (`null`: nobody's). */
  starting(): string | null {
    const s = this.shown();
    if (!s || this.live() || !this.waiting || this.waiting.memberId !== s.memberId) return null;
    return this.now() - this.waiting.at < STARTING_MS ? s.memberId : null;
  }

  handles(identity: string, local: boolean, memberId?: string | null): { camera: VideoHandle | null; screen: VideoHandle | null } {
    if (local) {
      // Your camera's self-view: the kit's `local:camera` sink. Never the layer.
      return { camera: this.camera.handles(identity, true, memberId).camera, screen: null };
    }
    const s = this.live();
    if (!s || !memberId || s.memberId !== memberId) return NONE;
    return s.source === "screen" ? { camera: null, screen: LAYER_HANDLE } : { camera: LAYER_HANDLE, screen: null };
  }

  tracksOf(memberId: string | null, local: boolean): { camera: string | null; screen: string | null } {
    if (local) return { camera: this.camera.tracksOf(memberId, true).camera, screen: null };
    const mine = this.tracks.filter((t) => t.member_id === memberId && !t.is_self && flowing(t));
    return {
      camera: mine.find((t) => t.source === "camera")?.track ?? null,
      screen: mine.find((t) => t.source === "screen")?.track ?? null,
    };
  }

  /** The plugin's caps, with the screen as the phone has it: iOS's picker
   *  once the extension's ring is armed (the plugin's own screen capture
   *  says unsupported on iOS: the extension captures, not the engine). */
  info(): NativeVideoInfo {
    const i = this.camera.info();
    const armed = this.share.armed;
    const devices =
      i.devices && armed ? { ...i.devices, permission: { ...i.devices.permission, screen: "granted" as const } } : i.devices;
    return {
      ...i,
      devices,
      caps: i.caps ? { ...i.caps, screen: armed ? PHONE_SCREEN_CAPS : NO_VIDEO_CAPS.screen } : null,
    };
  }

  /** The screen share as Rust has it (`k2-voice://screen`). */
  screenShare(): ScreenShare {
    return this.share;
  }

  /** Your camera: on, paused (in the background) or off. */
  selfState(): "on" | "paused" | "off" {
    const c = this.camera.info().local?.camera;
    return c === "on" ? "on" : c === "paused" ? "paused" : "off";
  }

  /** Your self-view mirrored (the front camera). */
  selfMirrored(): boolean {
    return mirrorFor(facingOf(this.camera.info().devices, this.chosen));
  }

  /** Your camera is on but this webview can't draw it (no WebCodecs). */
  selfUndrawn(): boolean {
    return this.selfState() !== "off" && !this.camera.info().tiles;
  }

  async setCamera(on: boolean, deviceId?: string): Promise<void> {
    if (on && deviceId) this.chosen = deviceId;
    await this.camera.setCamera(on, deviceId);
  }

  /** On: iOS's broadcast picker, then `picker_cancelled` (the kit's button
   *  stays off, without a sentence, until `local_video` says the share
   *  started: the person may still cancel iOS's sheet). Off: the plugin's
   *  `screen {on: false}`, which asks the extension to finish. */
  async setScreen(on: boolean): Promise<void> {
    if (!on) {
      await this.camera.setScreen(false);
      return;
    }
    if (!this.share.armed) throw { code: "screen_unsupported", detail: "the screen ring isn't armed" };
    if (this.share.active) return;
    const r = await this.bridge
      .invoke<{ ok?: unknown } | null>("plugin:k2-push|call_op", { op: "broadcastPicker" })
      .catch(() => null);
    if (r?.ok !== true) throw { code: "screen_unsupported", detail: "iOS's broadcast picker didn't open" };
    throw { code: "picker_cancelled", detail: "the share starts in iOS's broadcast sheet" };
  }

  async setCameraDevice(id: string | null): Promise<void> {
    await this.camera.setCameraDevice(id);
    this.chosen = id;
    this.changed();
  }

  async flipCamera(): Promise<string | null> {
    const id = await this.camera.flipCamera();
    if (id) {
      this.chosen = id;
      this.changed();
    }
    return id;
  }

  cameras(): Promise<PluginVideoDevices | null> {
    return this.camera.cameras();
  }

  reset(): void {
    this.camera.reset();
    this.changed();
  }

  close(): void {
    this.closed = true;
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.waitTimer = null;
    this.camera.close();
    for (const off of this.unlisten.splice(0)) off();
    this.listeners.clear();
  }
}
