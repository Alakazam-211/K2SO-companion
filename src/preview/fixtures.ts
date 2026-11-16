// Theme preview fixtures: one saved server, a handful of agents, one open
// Thread. Everything goes straight into the stores (as the component tests
// do); the stubbed network never answers, so nothing replaces it.
// Names are made up: never a real fleet.

import { serverHostKey, useServersStore, type ServerEntry } from "../stores/servers";
import { HOMES_LAST_SELECTED_KEY, HOMES_STORAGE_KEY, LIST_TAB_KEY, homeAddress, useHomesStore } from "../zen/homes";
import { useGroupsSheet } from "../zen/groups/groupsSheetStore";
import { groupRowId, useZenStore } from "../zen/zenStore";
import { useMultiServerPrefs } from "../zen/multi/prefs";
import { useUnreadStore } from "../zen/unreadStore";
import { unreadKey, type UnreadEntry } from "../zen/unread";
import { lastAtKey } from "../zen/lastAtFetch";
import { composerDraftKey, useComposerDrafts } from "../zen/composerDrafts";
import type { ThreadMessage } from "../zen/threadModel";
import type { StubAgent } from "../zen/stubData";
import type { ServerProject } from "../zen/serverPins";
import type { RowLast } from "../zen/rowPreview";
import { useHomeGridStore } from "../zen/homeGrid";
import { seedHomeChatServer } from "../zen/homeChat/homeChatRowsStore";
import type { HomeChatGate } from "../api/homeChat";
import {
  NO_HOME_CHAT_FLAGS,
  homeChatNoChatLine,
  type HomeChatChannel,
  type HomeChatFlags,
  type HomeChatPerson,
  type HomeChatSummaryRow,
} from "../api/homeChatPure";
import { seedHomeChat } from "./homeChatFixtures";

export const SERVER_ID = "preview";
const SERVER: ServerEntry = {
  id: SERVER_ID,
  nickname: "Studio",
  url: "https://studio.preview.invalid",
  username: "sam",
  rememberPassword: false,
};

type Agent = StubAgent & { id: string };

function agent(handle: string, name: string, color: string): Agent {
  const path = `/Users/sam/${handle}`;
  return { id: path, name, initial: name[0], path, addr: handle, kind: "agent", color, enabled: true, live: true };
}

const ASPEN = agent("aspen", "Aspen", "#5e5ce6");
const BUILDER = agent("builder", "Builder", "#30b0c7");
const SCRIBE = agent("scribe", "Scribe", "#ff9f0a");
const LEDGER = agent("ledger", "Ledger", "#34c759");
const ATLAS = agent("atlas", "Atlas", "#bf5af2");
const QUILL = agent("quill", "Quill", "#ff375f");
const HARBOR = agent("harbor", "Harbor", "#64d2ff");
const RELAY = agent("relay", "Relay", "#ac8e68");
const LAUNCH: Agent = {
  id: groupRowId("launch"),
  name: "Launch",
  initial: "L",
  kind: "group",
  groupId: "launch",
  memberCount: 3,
  addr: null,
  color: "#0a84ff",
};

const AGENTS: Agent[] = [ASPEN, BUILDER, SCRIBE, LEDGER, ATLAS, QUILL, HARBOR, RELAY, LAUNCH];

const PROJECTS: ServerProject[] = AGENTS.filter((a) => a.kind === "agent").map((a, i) => ({
  id: `p-${a.addr}`,
  name: a.name,
  path: a.path ?? null,
  handle: a.addr ?? null,
  pinned: a === ASPEN || a === SCRIBE || a === ATLAS,
  tabOrder: i,
  focusGroupId: null,
}));

const MIN = 60_000;

/** Line two of each row: its Thread's newest message. */
function lasts(now: number): Record<string, RowLast> {
  const row = (ago: number, text: string, mine = false): RowLast => ({
    at: now - ago * MIN,
    seq: 10,
    mine,
    kind: "text",
    text,
  });
  return {
    [lastAtKey(SERVER_ID, "thread", "aspen")]: row(1, "Which accent should Dusk default to?"),
    [lastAtKey(SERVER_ID, "thread", "builder")]: row(6, "Build **202611150912** is up on TestFlight."),
    [lastAtKey(SERVER_ID, "thread", "scribe")]: row(12, "Looking into the keyboard drag lag.", true),
    [lastAtKey(SERVER_ID, "thread", "ledger")]: row(40, "Approve the invoice run for November?"),
    [lastAtKey(SERVER_ID, "thread", "atlas")]: row(180, "Mapped every `--color-*` use in src/zen."),
    [lastAtKey(SERVER_ID, "thread", "quill")]: row(60 * 26, "Release notes drafted.", true),
    [lastAtKey(SERVER_ID, "thread", "harbor")]: row(60 * 30, "Pushed the [deploy checklist](https://example.invalid) to the wiki."),
    [lastAtKey(SERVER_ID, "thread", "relay")]: row(60 * 72, "No new tickets since Tuesday."),
    [lastAtKey(SERVER_ID, "group", "launch")]: row(90, "Builder: green across the board."),
  };
}

function entry(conv: string, over: Partial<UnreadEntry>): UnreadEntry {
  return {
    kind: "thread",
    id: conv,
    projectId: null,
    lastReadSeq: 0,
    lastSeq: 10,
    unread: 0,
    waiting: 0,
    muted: false,
    mutedUntil: null,
    ...over,
  };
}

const msg = (seq: number, text: string, over: Partial<ThreadMessage> = {}): ThreadMessage => ({
  id: `m${seq}`,
  seq,
  text,
  from: "aspen",
  at: Math.floor(Date.now() / 1000) - (20 - seq) * 60,
  mine: false,
  kind: "text",
  choice: null,
  ...over,
});

const LONG = [
  "Here's the plan for the palette switch:",
  "",
  "1. **Obsidian** stays exactly as today.",
  "2. **Veil** flips every surface to light; glass gets a white frost.",
  "3. **Dusk** keeps the dark grounds with a warm gold accent.",
  "",
  "The one call every component makes:",
  "",
  "```ts",
  'applyTheme("veil", null);',
  'document.documentElement.dataset.scheme; // "light"',
  "```",
  "",
  "The full colour map is in [the conversion guide](https://github.com/Alakazam-211/K2SO-companion/blob/main/docs/glass-palettes-conversion.md).",
].join("\n");

export function threadFixture(): ThreadMessage[] {
  return [
    msg(1, "Morning! The palette tokens are stamped on `<html>`. Want me to start converting the Thread?"),
    msg(2, "Yes please. Keep Obsidian looking the same as today.", { mine: true, from: "sam" }),
    msg(3, LONG),
    msg(4, "", { choice: { prompt: "Ship the palette build to TestFlight?", options: ["Ship it", "Wait"], answer: "Ship it" } }),
    msg(5, "↩ #3 aspen:\n> Here's the plan for the palette switch:\n\nLooks right. Do the jump pill too.", {
      mine: true,
      from: "sam",
    }),
    msg(6, "", {
      choice: { prompt: "Which accent should Dusk default to?", options: ["Gold", "Blue", "Pink"], answer: null },
    }),
  ];
}

export type PreviewScreen =
  | "thread"
  | "home"
  | "settings"
  | "themes"
  /** A DM (Maya): reactions, a reply and its chip, typing, a missed call. */
  | "home-chat"
  /** A channel (#design): names over runs, three people typing. */
  | "home-chat-channel"
  /** The DM with a bubble's hold menu open (quick emoji on top). */
  | "home-chat-menu"
  /** The channel's members sheet. */
  | "home-chat-members"
  /** Home groups (the group bar) and the Groups sheet on Errands. */
  | "home-groups"
  | "home-groups-sheet"
  /** People and channel rows on Home (a pinned person, badges, a greyed
   *  row from a Mac server), a person's hold menu, "Same person?". */
  | "home-people"
  | "home-people-menu"
  | "home-same-person"
  /** Add to Home on People, Channels, and the New channel form. */
  | "add-to-home"
  | "add-to-home-channels"
  | "add-to-home-new";

/** The people and channel ROWS screens (Home list, Add to Home). */
export const HOME_ROWS_SCREENS: readonly PreviewScreen[] = [
  "home-people",
  "home-people-menu",
  "home-same-person",
  "add-to-home",
  "add-to-home-channels",
  "add-to-home-new",
];

export const PREVIEW_SCREENS: readonly PreviewScreen[] = [
  "thread",
  "home",
  "settings",
  "themes",
  "home-chat",
  "home-chat-channel",
  "home-chat-menu",
  "home-chat-members",
  "home-groups",
  "home-groups-sheet",
  ...HOME_ROWS_SCREENS,
];

/** The Home chat screens: which conversation they open. */
export function homeChatKindOf(screen: PreviewScreen): "dm" | "channel" | null {
  if (screen === "home-chat" || screen === "home-chat-menu") return "dm";
  if (screen === "home-chat-channel" || screen === "home-chat-members") return "channel";
  return null;
}

/** A second saved server, signed in, whose chat is off (a Mac server): its
 *  rows grey and its picker sections say why. */
export const PARITY_ID = "preview-parity";
const PARITY: ServerEntry = {
  id: PARITY_ID,
  nickname: "Parity",
  url: "https://parity.preview.invalid",
  username: "sam",
  rememberPassword: false,
};

const ALL_FLAGS: HomeChatFlags = {
  channelMemberAddRemove: true,
  channelMembersCanLeave: true,
  httpTyping: true,
  readStateUnreadCount: true,
  memberChannelsLevelOnly: true,
  agentsDmWithBoxPeople: true,
  callCancel: true,
};

const PEOPLE: HomeChatPerson[] = [
  { ext: "k2:connect:ana", username: "ana", displayName: "Ana Ruiz", picture: null, role: "admin", ready: true, memberId: "77" },
  { ext: "k2:connect:ben", username: "ben", displayName: "Ben Okafor", picture: null, role: "member", ready: true, memberId: "78" },
  { ext: "k2:connect:chloe", username: "chloe", displayName: "Chloé Martin", picture: null, role: "member", ready: true, memberId: "79" },
  { ext: "k2:connect:dev", username: "dev", displayName: "Dev Patel", picture: null, role: "voice_chat", ready: false, memberId: null },
  { ext: "k2:owner", username: "owner", displayName: "Rosa Lind", picture: null, role: "owner", ready: true, memberId: "1" },
];

const CHANNELS: HomeChatChannel[] = [
  { conv: "501", name: "general", open: true, inviteOnly: false, archived: false, home: false, allowAgents: false },
  { conv: "502", name: "design-crit", open: false, inviteOnly: true, archived: false, home: true, allowAgents: false },
  { conv: "503", name: "launch-room", open: false, inviteOnly: true, archived: false, home: true, allowAgents: false },
  { conv: "504", name: "random", open: true, inviteOnly: false, archived: false, home: false, allowAgents: false },
];

/** People and channels on Home: the Studio group with agents, people and
 *  channels (a pinned person in the grid, badges, a greyed row from a Mac
 *  server), the Home chat state of both servers, and the extras each
 *  screen opens. Once, before the first render. */
export function seedHomeRows(screen: PreviewScreen): void {
  try {
    localStorage.removeItem(HOMES_STORAGE_KEY);
    localStorage.removeItem(HOMES_LAST_SELECTED_KEY);
    localStorage.setItem(LIST_TAB_KEY, "home");
  } catch {
    /* in-memory only */
  }
  useHomesStore.getState().reload();
  useHomesStore.getState().ensureSeeded();
  const s = () => useHomesStore.getState();
  const host = serverHostKey(SERVER);
  const parity = serverHostKey(PARITY);
  const launch = s().selectedId;
  s().renameGroup(launch, "Launch");
  s().setHomeIcon(launch, "rocket");
  const agentRow = (a: Agent) => ({ address: homeAddress(a.addr as string, host), workspaceId: null, label: a.name });
  const person = (ext: string, label: string, h = host) => ({ kind: "person" as const, address: homeAddress(ext, h), workspaceId: null, label });
  const channel = (conv: string, label: string) => ({ kind: "channel" as const, address: homeAddress(conv, host), workspaceId: null, label });
  s().addRow(launch, person("k2:connect:ana", "Ana Ruiz"));
  s().addRow(launch, agentRow(QUILL));
  s().addRow(launch, agentRow(ATLAS));
  s().addRow(launch, person("k2:connect:ben", "Ben Okafor"));
  s().addRow(launch, channel("501", "general"));
  s().addRow(launch, channel("502", "design-crit"));
  s().addRow(launch, person("k2:connect:mia", "Mia Chen", parity));
  s().pinRow(launch, homeAddress("k2:connect:ana", host));
  s().pinRow(launch, homeAddress("quill", host));
  s().pinRow(launch, homeAddress("atlas", host));
  useHomeGridStore.getState().setSize(launch, 3);
  try {
    const tab = screen === "add-to-home-channels" || screen === "add-to-home-new" ? "channels" : "people";
    localStorage.setItem(`k2.addToHome.tab.${launch}`, tab);
  } catch {
    /* opens on Agents */
  }
}

/** The two servers' Home chat state (re-seeded with the stores). */
function seedHomeChatServers(now: number): void {
  const gate = (offered: boolean, reason: string | null): HomeChatGate => ({
    offered,
    feature: true,
    on: offered,
    reason,
    flags: offered ? { ...ALL_FLAGS } : { ...NO_HOME_CHAT_FLAGS },
    chat: offered ? "live" : null,
    checkedAt: now,
    refusal: null,
    pickerLine: offered ? null : homeChatNoChatLine(reason),
  });
  const iso = (minAgo: number) => new Date(now - minAgo * MIN).toISOString();
  const conv = (c: string, kind: "dm" | "channel", n: number | "dot" | 0, minAgo: number, extra: Partial<HomeChatSummaryRow> = {}): HomeChatSummaryRow => ({
    conv: c,
    kind,
    unread: n !== 0,
    badge: n === "dot" ? { kind: "dot" } : n === 0 ? { kind: "none" } : { kind: "count", n },
    lastAt: iso(minAgo),
    lastAtMs: now - minAgo * MIN,
    lastMessageId: null,
    with: null,
    inviteOnly: null,
    ...extra,
  });
  seedHomeChatServer(SERVER_ID, {
    gate: gate(true, null),
    people: { me: { ext: "k2:connect:sam", memberId: "80" }, people: PEOPLE },
    peopleAt: now,
    channels: CHANNELS,
    channelsAt: now,
    summary: {
      chat: "live",
      convs: [
        conv("601", "dm", 2, 3, { with: "k2:connect:ana" }),
        conv("602", "dm", 0, 95, { with: "k2:connect:ben" }),
        conv("501", "channel", 0, 30, { inviteOnly: false }),
        conv("502", "channel", "dot", 8, { inviteOnly: true }),
      ],
    },
  });
  seedHomeChatServer(PARITY_ID, { gate: gate(false, "mac") });
}

/** Home groups (K2 0.46.13): groups with icons, one without, pins, on the
 *  Home tab; `sheet` opens the Groups sheet on Errands. Once, before the
 *  first render (storage is this preview origin's own). */
export function seedHomeGroups(sheet: boolean): void {
  try {
    localStorage.removeItem(HOMES_STORAGE_KEY);
    localStorage.removeItem(HOMES_LAST_SELECTED_KEY);
    localStorage.setItem(LIST_TAB_KEY, "home");
  } catch {
    /* in-memory only */
  }
  useHomesStore.getState().reload();
  useHomesStore.getState().ensureSeeded();
  const s = () => useHomesStore.getState();
  const host = serverHostKey(SERVER);
  const add = (id: string, a: Agent) =>
    s().addRow(id, { address: homeAddress(a.addr as string, host), workspaceId: null, label: a.name });
  const studio = s().selectedId;
  s().renameGroup(studio, "Studio");
  s().setHomeIcon(studio, "briefcase");
  for (const a of [ASPEN, BUILDER, SCRIBE, LEDGER, ATLAS, HARBOR]) add(studio, a);
  s().pinRow(studio, homeAddress("scribe", host));
  s().pinRow(studio, homeAddress("aspen", host));
  const errands = s().createGroup();
  s().renameGroup(errands, "Errands");
  s().setHomeIcon(errands, "rocket");
  s().setRecentFirst(errands, true);
  for (const a of [QUILL, RELAY]) add(errands, a);
  const reading = s().createGroup();
  s().renameGroup(reading, "Reading");
  s().setHomeIcon(reading, "book-open");
  add(reading, LEDGER);
  s().createGroup();
  const lab = s().createGroup();
  s().renameGroup(lab, "Lab");
  s().setHomeIcon(lab, "flask-conical");
  s().selectHome(studio);
  useGroupsSheet.setState({ open: sheet ? { view: "group", groupId: errands } : null });
}

/** Put the fixtures in the stores. Safe to call again (after the app's
 *  mount effects started their loads, which then never answer). */
export function seedStores(screen: PreviewScreen): void {
  const now = Date.now();
  const rows = HOME_ROWS_SCREENS.includes(screen);
  useServersStore.setState({
    servers: rows ? [SERVER, PARITY] : [SERVER],
    activeServerId: SERVER_ID,
    hydrated: true,
    tokens: rows ? { [SERVER_ID]: "preview-token", [PARITY_ID]: "preview-token-2" } : { [SERVER_ID]: "preview-token" },
    recovery: { [SERVER_ID]: "connected" },
  });
  useMultiServerPrefs.setState({ multiServer: rows });
  if (rows) seedHomeChatServers(now);

  const byKey: Record<string, UnreadEntry> = {
    [unreadKey("thread", "conv-builder")]: entry("conv-builder", { unread: 3, lastReadSeq: 7 }),
    [unreadKey("thread", "conv-ledger")]: entry("conv-ledger", { waiting: 1, unread: 1, lastReadSeq: 9 }),
    [unreadKey("thread", "conv-quill")]: entry("conv-quill", { muted: true }),
  };
  useUnreadStore.setState({
    servers: { [SERVER_ID]: { byKey, total: 4, waitingTotal: 1, loaded: true } },
    addrs: {
      [SERVER_ID]: {
        aspen: "conv-aspen",
        builder: "conv-builder",
        scribe: "conv-scribe",
        ledger: "conv-ledger",
        atlas: "conv-atlas",
        quill: "conv-quill",
        harbor: "conv-harbor",
        relay: "conv-relay",
      },
    },
  });

  const rowLasts = lasts(now);
  const thread = screen === "thread";
  useZenStore.setState({
    agentSource: "live",
    fileSource: "live",
    agents: AGENTS,
    agentError: null,
    fileError: null,
    serverProjects: PROJECTS,
    pinnedIds: [ASPEN.id, SCRIBE.id, ATLAS.id],
    activity: {
      byPath: {
        [SCRIBE.path!]: { display: "working", counts: { subagents: 1, tools: 4, commands: 2 } },
        [LEDGER.path!]: { display: "waiting", counts: { subagents: 0, tools: 0, commands: 0 } },
      },
      bySession: {},
    },
    previewByKey: rowLasts,
    lastAtByKey: Object.fromEntries(Object.entries(rowLasts).map(([k, v]) => [k, v.at])),
    screen: thread ? "thread" : "list",
    agentId: thread ? ASPEN.id : "",
    threadAddr: thread ? "aspen" : null,
    threadGroupId: null,
    threadConversationId: thread ? "conv-aspen" : null,
    thread: thread ? threadFixture() : [],
    threadSource: thread ? "live" : "stub",
    threadError: null,
    outbox: [],
    sending: false,
    sendError: null,
  });
  const chat = homeChatKindOf(screen);
  if (chat) seedHomeChat(chat, SERVER_ID);
}

/** The composer's text in the open Thread (a saved draft, as on the phone). */
export function seedDraft(): void {
  useComposerDrafts.getState().setDraft(composerDraftKey(SERVER_ID, null, "aspen"), "Gold for Dusk, and check Veil's glass");
}
