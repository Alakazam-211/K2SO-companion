// The three Home builders' seams, joined (4.3.0): the chat view's Call
// button and "Call back" ring through the calls part; a person row's long
// press calls; a call notification's or ring card's tap opens the DM.
// Called once from main.tsx.

import { createElement } from "react";
import { DmCallButton, callBack, callPersonFromRow, onOpenHomeChat } from "../calls";
import { openHomeChat, setHomeChatCallHooks, type HomeChatCallHooks } from "./homeChatStore";
import { setCallPersonHandler } from "./openHomeChat";

const HeaderActions: NonNullable<HomeChatCallHooks["HeaderActions"]> = ({ conversation }) =>
  conversation && conversation.kind === "dm"
    ? createElement(DmCallButton, {
        serverId: conversation.serverId,
        conversationId: conversation.conversationId,
        name: conversation.title,
      })
    : null;

export function wireHomeChatCalls(): () => void {
  setHomeChatCallHooks({
    onCallBack: (c) => void callBack(c.serverId, c.conversationId, c.title),
    HeaderActions,
  });
  const offCall = setCallPersonHandler((serverId, p) => {
    void callPersonFromRow(serverId, {
      ext: p.ext,
      displayName: p.displayName,
      username: p.username,
      conv: p.conversationId ?? null,
    });
  });
  const offOpen = onOpenHomeChat((r) =>
    openHomeChat({ serverId: r.serverId, kind: "dm", conversationId: r.conversationId, title: "", ext: null })
  );
  return () => {
    offCall();
    offOpen();
    setHomeChatCallHooks({});
  };
}
