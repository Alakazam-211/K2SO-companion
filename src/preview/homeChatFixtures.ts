// Theme preview fixtures for the Home chat view: one DM (Maya) and one
// channel (#design) on the preview server, with reactions (one of them
// yours), a reply, someone typing, and a call's record line. Straight into
// the Home chat store; the stubbed network never answers, so nothing
// replaces them. Names are made up.

import type { HomeChatMembers, HomeChatMessage, HomeChatPeople } from "../api/homeChatPure";
import type { SewCallId } from "../api/homeChatCallsPure";
import { convKey, type HomeChatTarget } from "../zen/homeChat/homeChatModel";
import { useHomeChatStore } from "../zen/homeChat/homeChatStore";

const ME = "100";
const MAYA = "101";
const JORDAN = "102";
const PRIYA = "103";

const PEOPLE: HomeChatPeople = {
  me: { ext: "k2:owner", memberId: ME },
  people: [
    { ext: "k2:connect:maya", username: "maya", displayName: "Maya Chen", picture: null, role: "member", ready: true, memberId: MAYA },
    { ext: "k2:connect:jordan", username: "jordan", displayName: "Jordan Reyes", picture: null, role: "admin", ready: true, memberId: JORDAN },
    { ext: "k2:connect:priya", username: "priya", displayName: "Priya Natarajan", picture: null, role: "member", ready: true, memberId: PRIYA },
    { ext: "k2:connect:sol", username: "sol", displayName: "Sol Okafor", picture: null, role: "member", ready: true, memberId: "104" },
  ],
};

export const DM_CONV = "7001";
export const CHANNEL_CONV = "7002";

const MIN = 60_000;

function message(
  conv: string,
  id: number,
  author: string,
  body: string,
  agoMin: number,
  over: Partial<HomeChatMessage> = {}
): HomeChatMessage {
  return {
    id: String(id),
    conv,
    authorId: author,
    body,
    createdAtMs: Date.now() - agoMin * MIN,
    seq: id,
    reactions: [],
    replyTo: null,
    edited: false,
    editedAtMs: null,
    deleted: false,
    nonce: null,
    call: null,
    ...over,
  };
}

function dmMessages(): HomeChatMessage[] {
  const c = DM_CONV;
  return [
    message(c, 9001, MAYA, "Hey! Did the palette build land on TestFlight?", 42, {
      reactions: [{ emoji: "👍", count: 1, me: true }],
    }),
    message(c, 9002, ME, "Yes, build 202611150912. Veil looks great on the Home grid.", 40),
    message(c, 9003, ME, "Dusk's gold accent needs one more pass on the chips.", 39),
    message(c, 9004, MAYA, "", 30, {
      call: {
        callId: "55" as SewCallId,
        startedBy: MAYA,
        ended: true,
        endReason: "no_answer",
        durationMs: null,
        joinedIds: [MAYA],
        rungIds: [ME],
        declinedIds: [],
        missedIds: [ME],
      },
    }),
    message(c, 9005, MAYA, "Tried calling. The jump pill reads **much** better on light now.", 28, {
      reactions: [
        { emoji: "🎉", count: 1, me: false },
        { emoji: "❤️", count: 1, me: true },
      ],
    }),
    message(c, 9006, ME, "Thanks! I'll send the screenshots tonight.", 6, { replyTo: "9005" }),
    message(c, 9007, MAYA, "Perfect. Ping me when they're up.", 2),
  ];
}

function channelMessages(): HomeChatMessage[] {
  const c = CHANNEL_CONV;
  return [
    message(c, 9101, JORDAN, "Morning all. Design review for the Home groups bar is at 2.", 95),
    message(c, 9102, JORDAN, "Mocks are in the usual place.", 94),
    message(c, 9103, PRIYA, "I left notes on the swipe between groups: start it only away from the left edge.", 80, {
      reactions: [
        { emoji: "👍", count: 3, me: true },
        { emoji: "🙏", count: 1, me: false },
      ],
    }),
    message(c, 9104, ME, "Agreed. The back gesture wins at the edge.", 70, { replyTo: "9103" }),
    message(c, 9105, MAYA, "Can we keep the plain slide, no peek tile?", 22),
    message(c, 9106, JORDAN, "Yes, that's Riley's desktop rule.", 20, {
      reactions: [{ emoji: "😂", count: 2, me: false }],
    }),
    message(c, 9107, ME, "Then I'll match it on the phone.", 4),
  ];
}

const CHANNEL: HomeChatMembers = {
  conv: CHANNEL_CONV,
  slug: "c-design",
  state: "active",
  name: "design",
  open: true,
  inviteOnly: false,
  creator: "k2:connect:jordan",
  allowAgents: false,
  people: [
    { ext: "k2:owner", state: "in" },
    { ext: "k2:connect:jordan", state: "in" },
    { ext: "k2:connect:priya", state: "in" },
    { ext: "k2:connect:maya", state: "in" },
  ],
  agents: [],
};

export function homeChatTarget(kind: "dm" | "channel", serverId: string): HomeChatTarget {
  return kind === "dm"
    ? { serverId, kind: "dm", conversationId: DM_CONV, title: "Maya Chen", ext: "k2:connect:maya" }
    : { serverId, kind: "channel", conversationId: CHANNEL_CONV, title: "design", inviteOnly: false };
}

/** Seed (or re-seed) the Home chat store with the open chat. */
export function seedHomeChat(kind: "dm" | "channel", serverId: string): void {
  const now = Date.now();
  // Names stay a while (the view prunes names past their time).
  const typingUntil = now + 60 * MIN;
  const st = useHomeChatStore.getState();
  useHomeChatStore.setState({
    open: st.open ?? homeChatTarget(kind, serverId),
    people: { [serverId]: { people: PEOPLE, at: now } },
    convs: {
      [convKey(serverId, DM_CONV)]: { messages: dmMessages(), hasMore: false, loaded: true, error: null, loadingOlder: false },
      [convKey(serverId, CHANNEL_CONV)]: { messages: channelMessages(), hasMore: false, loaded: true, error: null, loadingOlder: false },
    },
    channels: { [convKey(serverId, CHANNEL_CONV)]: CHANNEL },
    typing: {
      [convKey(serverId, DM_CONV)]: { [MAYA]: typingUntil },
      [convKey(serverId, CHANNEL_CONV)]: { [JORDAN]: typingUntil, [PRIYA]: typingUntil + 1, ["104"]: typingUntil + 2 },
    },
  });
}
