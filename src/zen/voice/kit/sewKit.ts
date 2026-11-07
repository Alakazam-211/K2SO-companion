import { Channel, invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { SewStore } from "@sew/client/store";
import {
  createVoiceController,
  type CallKind,
  type NativeBridge,
  type PluginParticipant,
  type VoiceAnswer,
  type VoiceControllerApi,
  type VoiceHost,
  type VoiceSnapshot,
} from "@sew/voice";
import { useVoiceCall } from "../voiceCall";
import { cameraRefusalText, isCameraRefusal } from "../voiceWire";
import { LayerVideo } from "./layerVideo";

// Sew's call UI kit (@sew/voice) on the phone, over the same native plugin
// the call store already drives (src-tauri/src/voice.rs). The kit draws the
// call; the phone keeps everything only it can do:
//   - Joins stay ours. The store asks for the mic, names the CallKit call and
//     invokes `join` with `target` = the K2 server id. The kit's controller
//     never joins: it adopts the call from the plugin's `state` event
//     (NativeVoiceController.onState, native/controller.ts:285-298) through
//     `callOf` below. The bridge refuses a kit `join` so nothing can skip the
//     mic prompt or the CallKit label.
//   - Rings are native (K2 push → CallKit in Rust): the bridge refuses the
//     kit's `ring` / `ring_ended`, and nothing feeds it `call_ring`.
//   - Leave goes through the store (one leave path, the bar goes at once).
//   - Video: `LayerVideo` (layerVideo.ts). Your camera is the kit's own
//     PluginVideo (on, off, flip, the permission step, your self-view on a
//     `local:camera` sink); everyone else is the phone's native layer, and
//     LayerVideo tells the kit whose tile it belongs on (no remote sinks).
//   - The camera's permission sentences name the iPhone's settings
//     (Settings › K2 › Camera), not the Mac's (`phoneController`).
//   - No Sew-API sender yet: K2's door passes only the call-credential
//     routes. `send` rejects with `sew_api_unavailable`, the store stays
//     empty, and the parts that need either stay hidden.

const CMD = "plugin:sew-voice|";

/** What `send` rejects with until K2 passes Sew's client API through. */
export const SEW_API_UNAVAILABLE = "sew_api_unavailable";

/** A kit command the phone does itself (join, rings). */
export const NOT_THROUGH_KIT = "not_through_kit";

/** The kit's channel id for a K2 room: the server and the room. */
export function kitChannelId(serverId: string, roomKey: string): string {
  return `${encodeURIComponent(serverId)}/${encodeURIComponent(roomKey)}`;
}

/** The reverse: the plugin's `{target, room}` for a kit channel id. */
export function kitRoomOf(channelId: string): { serverId: string; roomKey: string } | null {
  const i = channelId.indexOf("/");
  if (i <= 0 || i === channelId.length - 1) return null;
  try {
    return {
      serverId: decodeURIComponent(channelId.slice(0, i)),
      roomKey: decodeURIComponent(channelId.slice(i + 1)),
    };
  } catch {
    return null;
  }
}

/** The plugin as Tauri exposes it to this page. */
export type BaseBridge = {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  listen(event: string, handler: (payload: unknown) => void): Promise<() => void>;
  /** A Tauri Channel for a video sink's frames (your self-view). */
  channel?(onMessage: (msg: ArrayBuffer | Uint8Array) => void): unknown;
};

const tauriBridge: BaseBridge = {
  invoke: (cmd, args) => tauriInvoke(cmd, args),
  listen: (event, handler) => tauriListen(event, (e) => handler(e.payload)),
  channel(onMessage) {
    const ch = new Channel<ArrayBuffer | Uint8Array>();
    ch.onmessage = onMessage;
    return ch;
  },
};

/** Your own Sew member id, as the plugin last said (`is_self`). */
let selfId: string | null = null;

function noteSelf(rows: unknown): void {
  if (!Array.isArray(rows)) return;
  const me = (rows as Partial<PluginParticipant>[]).find((p) => p?.is_self && typeof p.member_id === "string");
  if (me?.member_id) selfId = me.member_id;
}

export function kitSelfId(): string | null {
  return selfId;
}

/** The camera's commands, logged by outcome in "Send call log". */
const CAMERA_CMDS = new Set(["camera_permission", "request_camera_permission", "camera", "set_video_device", "video_devices"]);

/** One call-log line (codes only; Rust keeps nothing else). */
export function note(words: string[]): void {
  void tauriInvoke("voice_note", { words }).catch(() => {});
}

/** The function that asked for camera off: the nearest caller frame's
 *  name, outside this bridge (a code; never a path or argument). */
function offCaller(): string {
  const lines = (new Error().stack ?? "").split("\n").slice(1);
  for (const l of lines) {
    const m = /^\s*(?:at\s+)?([A-Za-z_$][\w$.]*)/.exec(l.replace(/@.*$/, ""));
    const fn = m?.[1] ?? "";
    if (!fn || /^(offCaller|invoke|Object\.invoke|k2Bridge|Promise|async)$/.test(fn) || fn.endsWith(".invoke")) continue;
    return fn.replace(/[^\w.$]/g, "").slice(0, 40) || "unknown";
  }
  return "unknown";
}

function outcomeOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.code === "string") return o.code;
    if (Array.isArray(o.cameras)) return `cameras_${o.cameras.length}`;
  }
  return v == null ? "ok" : "answered";
}

function refuse(cmd: string): Promise<never> {
  return Promise.reject({ code: NOT_THROUGH_KIT, detail: `${cmd} is the phone's own` });
}

/** The kit's bridge, plus a replay of the last `local_video`. */
export type K2Bridge = NativeBridge & {
  /** Hands the last `local_video` to its listeners again: the screen
   *  button's Stop opened iOS's sheet and the person closed it without
   *  stopping, so the kit's button (off on the tap) goes back on. */
  replayLocalVideo(): void;
};

/** The kit's bridge: the plugin's own commands and events, with the
 *  phone's joins, rings and leave kept on the phone's paths. */
export function k2Bridge(base: BaseBridge = tauriBridge): K2Bridge {
  let lastLocal: unknown = null;
  const localHandlers = new Set<(payload: unknown) => void>();
  return {
    replayLocalVideo() {
      if (lastLocal == null) return;
      for (const h of [...localHandlers]) h(lastLocal);
    },
    invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
      const name = cmd.startsWith(CMD) ? cmd.slice(CMD.length) : null;
      if (name === "join" || name === "ring" || name === "ring_ended") return refuse(name);
      if (name === "leave") {
        const call = useVoiceCall.getState();
        if (call.phase !== "idle") return call.leave() as Promise<T>;
      }
      const out = base.invoke(cmd, args);
      if (name && CAMERA_CMDS.has(name)) {
        const on = name === "camera" ? [args?.on === true ? "on" : "off"] : [];
        // Who turned it off (Sew asked): the first of our own or the kit's
        // frames above this bridge, as a code.
        if (name === "camera" && args?.on !== true) note(["camera", "off_from", offCaller()]);
        void out.then(
          (v) => note(["camera", name, ...on, outcomeOf(v)]),
          (e) => note(["camera", name, ...on, "refused", outcomeOf(e)])
        );
      }
      if (name === "state") {
        void out.then((s) => noteSelf((s as { participants?: unknown } | null)?.participants), () => {});
      }
      return out as Promise<T>;
    },
    listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
      const local = event === "sew-voice://local_video";
      const h = handler as (payload: unknown) => void;
      if (local) localHandlers.add(h);
      const off = base.listen(event, (payload) => {
        if (event === "sew-voice://participants") noteSelf(payload);
        if (local && payload && typeof payload === "object") {
          lastLocal = payload;
          const v = payload as { camera?: unknown; reason?: unknown };
          note(["camera", "local_video", String(v.camera ?? "none"), String(v.reason ?? "none")]);
        }
        handler(payload as T);
      });
      return off.then(
        (unlisten) => () => {
          localHandlers.delete(h);
          unlisten();
        },
        (e) => {
          localHandlers.delete(h);
          throw e;
        }
      );
    },
    ...(base.channel ? { channel: base.channel.bind(base) } : {}),
  };
}

/** A snapshot with the camera's permission sentences in the iPhone's words. */
export function phoneSnapshot(s: VoiceSnapshot): VoiceSnapshot {
  const reason = s.notice?.reason;
  if (!s.notice || !isCameraRefusal(reason)) return s;
  return { ...s, notice: { ...s.notice, text: cameraRefusalText(reason) } };
}

/** The kit's controller, its snapshot through `phoneSnapshot` (the same
 *  object back while the kit's is unchanged, as the kit's hooks need). */
export function phoneController(c: VoiceControllerApi): VoiceControllerApi {
  let seen: VoiceSnapshot | null = null;
  let out: VoiceSnapshot | null = null;
  const snapshot = (): VoiceSnapshot => {
    const s = c.snapshot();
    if (s !== seen || !out) {
      seen = s;
      out = phoneSnapshot(s);
    }
    return out;
  };
  return new Proxy(c, {
    get(target, prop) {
      if (prop === "snapshot") return snapshot;
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

function noSewApi(method: string, path: string): Promise<VoiceAnswer> {
  return Promise.reject(
    Object.assign(new Error(`Sew's API isn't reachable from the phone yet (${method} ${path})`), {
      code: SEW_API_UNAVAILABLE,
    })
  );
}

/** The kit's host: an empty store, no Sew API, and stubs for the fields the
 *  native controller never reads (installId, gatewaySession, readyCallKeys,
 *  assets: Sew's answers, native/controller.ts). */
export function k2VoiceHost(store: SewStore): VoiceHost {
  return {
    send: noSewApi,
    store,
    installId: () => null,
    me: () => selfId,
    gatewaySession: () => null,
    readyCallKeys: () => null,
    assets: { workerUrl: "", wasmUrl: "" },
  };
}

/** The plugin's `{target, room}` is a K2 server and room: the kit's channel. */
export function callOf(target: string, room: string): { kind: CallKind; channelId: string } | null {
  return target && room ? { kind: "voice", channelId: kitChannelId(target, room) } : null;
}

/** Only for the kit's own ring path (refused by the bridge); joins are the store's. */
export function joinArgs(_kind: CallKind, channelId: string): { target: string; room: string } {
  const r = kitRoomOf(channelId);
  return r ? { target: r.serverId, room: r.roomKey } : { target: "", room: channelId };
}

export type SewKit = { controller: VoiceControllerApi; store: SewStore; video: LayerVideo };

let kit: SewKit | null = null;

/** The kit's controller over this phone's plugin: one per app, made with the
 *  call screen and kept, following the plugin from then on. */
export function createSewKit(base?: BaseBridge): SewKit {
  const store = new SewStore();
  const bridge = k2Bridge(base);
  const video = new LayerVideo(bridge);
  const controller = createVoiceController(k2VoiceHost(store), {
    native: { bridge, joinArgs, callOf, video },
  });
  return { controller: phoneController(controller), store, video };
}

export function sewKit(): SewKit {
  kit ??= createSewKit();
  return kit;
}

export function __resetSewKitForTests(): void {
  kit?.controller.close();
  kit = null;
  selfId = null;
}
