import { useEffect } from "react";
import type { VideoHandle } from "@sew/voice";
import { create } from "zustand";

// The floating tile's camera (Rosson 2026-11-06: "Add the camera option too
// … to the floating pill"): its button and your self-view, read from Sew's
// kit. The kit loads with the call screen (never at the app's start), so
// this store holds what the tile needs and kit/tileCameraKit.ts fills it,
// loaded only while the tile is up. Camera on and off only: the switch and
// the screen share stay in the call screen's bar (Rosson).

/** The button: on, off, paused (the app in the background) or asking (the
 *  permission step, the camera on its way). */
export type TileCameraState = "off" | "asking" | "on" | "paused";

export type TileCamera = {
  /** Show the button: the call can do video and this phone can send it
   *  (the kit's own rule for its camera button). */
  shown: boolean;
  state: TileCameraState;
  /** It can be pressed now (not while asking, nor when refused for the call). */
  enabled: boolean;
  /** What it says: turn on / turn off, paused, or the refusal's sentence. */
  label: string;
  /** Your camera runs (`local_video` on or paused): the card shows you. */
  selfOn: boolean;
  /** Your self-view: the kit's `local:camera` webview sink (`null`: none
   *  this webview can draw). Never the native layer, never PiP. */
  self: VideoHandle | null;
  /** Mirrored: the front camera. */
  mirrored: boolean;
  /** The button's tap: the kit's own camera path (its permission step). */
  toggle(): void;
};

export const TILE_CAMERA_IDLE: Omit<TileCamera, "toggle"> = {
  shown: false,
  state: "off",
  enabled: false,
  label: "Turn on camera",
  selfOn: false,
  self: null,
  mirrored: true,
};

export const useTileCamera = create<TileCamera>(() => ({ ...TILE_CAMERA_IDLE, toggle() {} }));

const loadKit = (): Promise<() => void> => import("./kit/tileCameraKit").then((m) => m.followTileCamera());
let load: () => Promise<() => void> = loadKit;

/** Follow the kit's camera while the tile is up (loads the kit if need be). */
export function useTileCameraFeed(): void {
  useEffect(() => {
    let off: (() => void) | null = null;
    let gone = false;
    void load().then(
      (stop) => {
        if (gone) stop();
        else off = stop;
      },
      () => {}
    );
    return () => {
      gone = true;
      off?.();
    };
  }, []);
}

export function __setTileCameraLoaderForTests(next: (() => Promise<() => void>) | null): void {
  load = next ?? loadKit;
  useTileCamera.setState({ ...TILE_CAMERA_IDLE, toggle() {} });
}
