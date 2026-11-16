import { addPluginListener } from "@tauri-apps/api/core";
import { scopeFor } from "../../api/scope";
import { onHomeChatGate, refreshHomeChatGate } from "../../api/homeChat";
import { subscribeHomeChat } from "../../api/homeChatEvents";
import { isIosWebView } from "../../lib/nativePicker";
import { useServersStore } from "../../stores/servers";
import { followNativeDmIds, noteCallPush, onHomeChatCallFrame, type CallPushData } from "./dmCall";

// Rings reach the phone wherever the person is in the app: one Home chat
// socket per signed-in server that offers Home chat (the gate: `home-chat-v1`
// in `/boot-status` AND `status.on`; never assumed), shared with any other
// subscriber (`subscribeHomeChat` is ref-counted, one socket per server).
// A server whose gate opens later is joined then; a signed-out or removed
// one is let go. Mounted once, at the app's root (App.tsx).

export function startDmCallWatch(): () => void {
  const subs = new Map<string, () => void>();
  const asking = new Set<string>();
  let stopped = false;

  const wanted = (): Set<string> => {
    const { servers, tokens } = useServersStore.getState();
    return new Set(servers.filter((s) => !!tokens[s.id]).map((s) => s.id));
  };

  const join = (id: string): void => {
    if (stopped || subs.has(id) || !wanted().has(id)) return;
    subs.set(
      id,
      subscribeHomeChat(scopeFor(id), (frame) => onHomeChatCallFrame(id, frame))
    );
  };

  const sync = (): void => {
    if (stopped) return;
    const want = wanted();
    for (const [id, off] of subs) {
      if (!want.has(id)) {
        off();
        subs.delete(id);
      }
    }
    for (const id of want) {
      if (subs.has(id) || asking.has(id)) continue;
      asking.add(id);
      void refreshHomeChatGate(scopeFor(id))
        .then((g) => {
          if (g.offered) join(id);
        })
        .finally(() => asking.delete(id));
    }
  };

  const offGate = onHomeChatGate((id, gate) => {
    if (gate.offered) join(id);
  });
  const offServers = useServersStore.subscribe((s, prev) => {
    if (s.servers !== prev.servers || s.tokens !== prev.tokens) sync();
  });
  const offIds = followNativeDmIds();

  // A call push with the app in front (no banner; K2PushPlugin `callPush`).
  let offPush: (() => void) | null = null;
  if (isIosWebView()) {
    void addPluginListener("k2-push", "callPush", (data: CallPushData) => {
      const known = new Set(useServersStore.getState().servers.map((s) => s.id));
      noteCallPush(data, (id) => known.has(id));
    }).then(
      (l) => {
        if (stopped) void l.unregister();
        else offPush = () => void l.unregister();
      },
      () => {}
    );
  }

  sync();
  return () => {
    stopped = true;
    offGate();
    offServers();
    offIds();
    offPush?.();
    for (const off of subs.values()) off();
    subs.clear();
  };
}
