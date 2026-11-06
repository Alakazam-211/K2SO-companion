import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async () => null));
vi.mock("@tauri-apps/api/core", () => ({ invoke, addPluginListener: vi.fn(), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import type { VideoControls, VoiceSnapshot } from "@sew/voice";
import { __setTileCameraLoaderForTests, useTileCamera } from "../tileCamera";
import { followTileCamera, tileCameraOf, type TileKit, type TileVideo } from "./tileCameraKit";

const POLICY = { video_enabled: true, camera_allowed: true, screen_allowed: true };
const CONTROLS: VideoControls = {
  camera: { shown: true, enabled: true, reason: null, paused: null, canSwitch: false },
  screen: { shown: false, enabled: false, reason: null, paused: null, sources: false, picker: false },
};
const HANDLE = { key: "local:camera", attach() {}, detach() {} };

function snap(over: Partial<VoiceSnapshot> = {}): VoiceSnapshot {
  return {
    phase: "connected",
    camera: "off",
    policy: POLICY,
    videoControls: CONTROLS,
    notice: null,
    ...over,
  } as VoiceSnapshot;
}

function video(self: "on" | "paused" | "off" = "off", mirrored = true): TileVideo {
  return {
    subscribe: () => () => {},
    selfState: () => self,
    selfMirrored: () => mirrored,
    handles: () => ({ camera: self === "off" ? null : HANDLE }),
  };
}

const cam = (camera: Partial<VideoControls["camera"]>): VideoControls => ({ ...CONTROLS, camera: { ...CONTROLS.camera, ...camera } });

beforeEach(() => {
  invoke.mockClear();
  __setTileCameraLoaderForTests(null);
});

describe("the floating tile's camera button, from the kit", () => {
  it("shows as the kit's own does: video in the call and this phone can send it", () => {
    expect(tileCameraOf(snap(), video()).shown).toBe(true);
    // No video in the room's policy, no camera caps, or no call.
    expect(tileCameraOf(snap({ policy: { ...POLICY, video_enabled: false } as never }), video()).shown).toBe(false);
    expect(tileCameraOf(snap({ policy: null }), video()).shown).toBe(false);
    expect(tileCameraOf(snap({ videoControls: cam({ shown: false }) }), video()).shown).toBe(false);
    expect(tileCameraOf(snap({ videoControls: null }), video()).shown).toBe(false);
    expect(tileCameraOf(snap({ phase: "idle" }), video()).shown).toBe(false);
  });

  it("off, asking, on and paused, with the words to match", () => {
    expect(tileCameraOf(snap(), video())).toMatchObject({ state: "off", enabled: true, label: "Turn on camera", selfOn: false, self: null });
    expect(tileCameraOf(snap({ camera: "asking" }), video())).toMatchObject({ state: "asking", enabled: false, label: "Turning on camera…" });
    expect(tileCameraOf(snap({ camera: "on" }), video("on"))).toMatchObject({ state: "on", enabled: true, label: "Turn off camera", selfOn: true, self: HANDLE });
    // In the background: still on (the track stays), shown paused with the kit's sentence.
    const paused = tileCameraOf(snap({ camera: "on", videoControls: cam({ paused: "Camera paused while the app is in the background." }) }), video("paused"));
    expect(paused).toMatchObject({ state: "paused", enabled: true, label: "Camera paused while the app is in the background.", selfOn: true });
    // Not while connecting.
    expect(tileCameraOf(snap({ phase: "connecting" }), video()).enabled).toBe(false);
  });

  it("refused for the call: disabled, the kit's sentence its label", () => {
    const r = tileCameraOf(snap({ videoControls: cam({ enabled: false, reason: "You can't send video in this call." }) }), video());
    expect(r).toMatchObject({ shown: true, state: "off", enabled: false, label: "You can't send video in this call." });
  });

  it("the permission refused: its iPhone sentence on the button, still pressable for after Settings", () => {
    const text = "Camera access is off. Turn it on in Settings › K2 › Camera.";
    const r = tileCameraOf(snap({ notice: { text, reason: "camera_permission_denied" } }), video());
    expect(r).toMatchObject({ state: "off", enabled: true, label: text });
    // Another notice is not the camera's.
    expect(tileCameraOf(snap({ notice: { text: "Reconnecting…", reason: "lost" } }), video()).label).toBe("Turn on camera");
  });

  it("you, mirrored for the front camera only", () => {
    expect(tileCameraOf(snap({ camera: "on" }), video("on", true)).mirrored).toBe(true);
    expect(tileCameraOf(snap({ camera: "on" }), video("on", false)).mirrored).toBe(false);
  });

  it("follows the kit into the store; a tap is logged as the call screen's and goes to the kit's camera path", async () => {
    let s = snap();
    const listeners = new Set<() => void>();
    const kit: TileKit = {
      controller: {
        subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
        snapshot: () => s,
        toggleCamera: vi.fn(async () => {}),
      },
      video: video(),
    };
    const stop = followTileCamera(kit);
    expect(useTileCamera.getState()).toMatchObject({ shown: true, state: "off" });
    useTileCamera.getState().toggle();
    expect(kit.controller.toggleCamera).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("voice_note", { words: ["camera", "tap", "off"] });
    s = snap({ camera: "asking" });
    for (const fn of listeners) fn();
    expect(useTileCamera.getState().state).toBe("asking");
    stop();
    expect(listeners.size).toBe(0);
  });
});
