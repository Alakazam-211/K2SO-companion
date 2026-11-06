import type { VideoHandle, VoiceControllerApi, VoiceSnapshot } from "@sew/voice";
import { useTileCamera, type TileCamera, type TileCameraState } from "../tileCamera";
import { isCameraRefusal } from "../voiceWire";
import { note, sewKit } from "./sewKit";

// The floating tile's camera from Sew's kit (tileCamera.ts): the button as
// the kit's CallBar has it (shown, on / off / asking, disabled with its
// refusal's sentence) and your self-view as the call screen's own tile has
// it (the kit's `local:camera` sink, mirrored for the front camera). The tap
// is the kit's: `toggleCamera()` runs the permission step, then the plugin.

/** What the tile reads of the kit's video hook (LayerVideo). */
export type TileVideo = {
  subscribe(fn: () => void): () => void;
  selfState(): "on" | "paused" | "off";
  selfMirrored(): boolean;
  handles(identity: string, local: boolean, memberId?: string | null): { camera: VideoHandle | null };
};

export type TileKit = {
  controller: Pick<VoiceControllerApi, "subscribe" | "snapshot" | "toggleCamera">;
  video: TileVideo;
};

/** The kit's camera button, for the tile (the same rules as its CallBar). */
export function tileCameraOf(v: VoiceSnapshot, video: TileVideo): Omit<TileCamera, "toggle"> {
  const vc = v.videoControls;
  const shown = v.phase !== "idle" && (v.policy?.video_enabled ?? false) && (vc === undefined || !!vc?.camera.shown);
  // Refused for this call (the policy, no video here): shown, not pressable.
  const blocked = v.camera === "off" && !!vc && !vc.camera.enabled;
  const self = video.selfState();
  const paused = v.camera === "on" && (self === "paused" || !!vc?.camera.paused);
  const state: TileCameraState = v.camera === "asking" ? "asking" : v.camera === "on" ? (paused ? "paused" : "on") : "off";
  // The permission refused (its sentence in the iPhone's words: phoneSnapshot):
  // said on the button, which stays pressable so Settings › K2 › Camera can
  // fix it mid-call, as the kit's own button does.
  const refusal = v.camera === "off" && v.notice && isCameraRefusal(v.notice.reason) ? v.notice.text : null;
  const label =
    blocked && vc?.camera.reason
      ? vc.camera.reason
      : (refusal ??
        (state === "paused"
          ? (vc?.camera.paused ?? "Camera paused")
          : state === "asking"
            ? "Turning on camera…"
            : state === "on"
              ? "Turn off camera"
              : "Turn on camera"));
  const selfOn = self !== "off";
  return {
    shown,
    state,
    enabled: v.camera !== "asking" && v.phase === "connected" && !blocked,
    label,
    selfOn,
    self: selfOn ? video.handles("", true, null).camera : null,
    mirrored: video.selfMirrored(),
  };
}

/** Fill the tile's store from the kit until the returned stop. */
export function followTileCamera(kit: TileKit = sewKit()): () => void {
  const toggle = () => {
    // A person's tap, logged as the call screen's (KitCall's `guard`).
    note(["camera", "tap", kit.controller.snapshot().camera]);
    void kit.controller.toggleCamera().catch(() => {});
  };
  const read = () => useTileCamera.setState({ ...tileCameraOf(kit.controller.snapshot(), kit.video), toggle });
  const offs = [kit.controller.subscribe(read), kit.video.subscribe(read)];
  read();
  return () => {
    for (const off of offs) off();
  };
}
