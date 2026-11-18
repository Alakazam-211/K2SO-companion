// DM calls (K2 0.46.13): what the other Home builders use.
//   - `startDmCall(serverId, conversationId, {name})`: call (or answer).
//   - `DmCallButton`: a DM header's Call button (`headerActions`).
//   - `callBack(serverId, conversationId, name)`: a call record line's
//     Call back (`onCallBack(conversation)`).
//   - `callPersonFromRow(serverId, person)`: a person's Home row, long press.
//   - `useDmCallState(serverId, conversationId)`: this DM's call phase.
//   - `onOpenHomeChat(fn)`: the chat view hears "open this DM" (a call
//     push's tap, a ring card's tap). TODO(home-chat-view): wire it.
// The ring cards, the caller's bar and the watch are mounted in App.tsx.
export { startDmCall, callPersonFromRow, useDmCalls, type CallablePerson, type DmCallOutcome } from "./dmCall";
export { DmCallButton, callBack, useDmCallState } from "./DmCallButton";
export { onOpenHomeChat, requestOpenHomeChat, OPEN_HOME_CHAT_EVENT, type OpenHomeChatRequest } from "./homeChatOpen";
