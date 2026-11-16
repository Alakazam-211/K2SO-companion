// Where the open Home chat shows: over Zen (Home stays under it), while
// `openHomeChat` has set one. Like a Thread: a fixed backdrop the left-edge
// swipe takes back (Home peeks underneath), Android Back closes it, and a
// column sized to the visual viewport so the composer sits on the
// keyboard. Mounted once in Zen.tsx.

import { useCallback } from "react";
import { useBackHandler } from "../../lib/androidBack";
import { useSwipeBack } from "../../lib/useSwipeBack";
import { fullViewportHeight, useViewport, useViewportTrackRef } from "../../lib/useViewportHeight";
import { keyboardColumnHeight } from "../../kit/mobileChat/useKeyboardFlip";
import { PaneErrorBoundary } from "../PaneErrorBoundary";
import { closeHomeChat, useHomeChatCallHooks, useHomeChatStore } from "./homeChatStore";
import { HomeChatView } from "./HomeChatView";
import type { HomeChatTarget } from "./homeChatModel";

/** Above Zen's thread column and lists; under the app's sheets (58+). */
export const HOME_CHAT_Z = 40;

export function HomeChatHost() {
  const open = useHomeChatStore((s) => s.open);
  if (!open) return null;
  return <HomeChatScreen key={`${open.serverId}|${open.kind}|${open.conversationId ?? open.ext ?? ""}`} target={open} />;
}

function HomeChatScreen({ target }: { target: HomeChatTarget }) {
  const back = useCallback(() => closeHomeChat(), []);
  // Android Back = the header's Back; menus and sheets open later and
  // register on top. The swipe, too, only while nothing sits over it.
  const onTop = useBackHandler(true, back);
  const swipeRef = useSwipeBack(back, { enabled: onTop });
  const vp = useViewport();
  const columnRef = useViewportTrackRef();
  const onCallBack = useHomeChatCallHooks((s) => s.onCallBack);
  return (
    <div
      ref={swipeRef}
      className="fixed left-0 right-0 bottom-0"
      style={{ top: vp.offsetTop, zIndex: HOME_CHAT_Z, background: "var(--color-bg)" }}
      data-testid="home-chat-home"
    >
      <div
        ref={columnRef}
        className="relative flex flex-col min-h-0 overflow-x-hidden"
        // The keyboard's motion plays on the compositor (the view's FLIP):
        // no height transition here.
        style={{ height: keyboardColumnHeight(vp, fullViewportHeight()) }}
        data-testid="home-chat-column"
      >
        <PaneErrorBoundary name="home-chat">
          <HomeChatView target={target} onBack={back} onCallBack={onCallBack} />
        </PaneErrorBoundary>
      </div>
    </div>
  );
}
