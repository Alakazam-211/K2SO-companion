// Add to Home's People and Channels tabs (K2 0.46.13; brief §2.4; desktop
// `components/HomeChat/HomeChatPickers.tsx` + `AddToHomeModal.tsx`).
//
//   - People: one list, a section per server (the active one first, then
//     by name), each read with THAT server's own login. A server where you
//     are Voice & Chat only is listed. A server with no usable chat says
//     the desktop's picker line (a Mac server; still being set up; else
//     "No chat on this server."). `ready: false` → "Setting up…", not
//     pickable. A pick writes a `person` row and closes (add one, close);
//     the DM is opened on the first open. A possible match already on this
//     group from another server asks "Same person?" first: Same person and
//     Cancel add nothing; Different person adds a second row.
//   - Channels: "Add a channel" (each server's text channels you can see;
//     # open, a lock invite-only) or "New channel" (server, name, Invite
//     only (default) | Open, people) → create, wait for Sew's id (1 s polls
//     up to 30 s), then the row; on timeout the desktop's line.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { scopeFor } from "../../api/scope";
import { createHomeChatChannel, waitForHomeChatChannel } from "../../api/homeChat";
import {
  HOME_CHAT_CHANNEL_NAME_MAX,
  HOME_CHAT_COPY_NO_CHAT,
  HOME_CHAT_CREATE_POLL_MS,
  HOME_CHAT_CREATE_TIMEOUT_COPY,
  HOME_CHAT_CREATE_WAIT_MS,
  type HomeChatChannel,
  type HomeChatPerson,
} from "../../api/homeChatPure";
import { useServersStore } from "../../stores/servers";
import { homeHasAddress, type Home, type HomeRow } from "../homes";
import { savedServerForHost, serverDisplayName } from "../homeView";
import { CheckIcon } from "../icons";
import { ChannelAvatar, PersonAvatar } from "./HomeChatGlyphs";
import { channelRow, chatRowParts, isPersonExt, matchesElsewhere, personRow, pickablePerson, samePersonCopy } from "./homeChatRows";
import {
  refreshChatChannels,
  refreshChatPeople,
  refreshChatServer,
  useHomeChatStore,
  type HomeChatServerState,
} from "./homeChatStore";
import { askHome } from "./HomeConfirmSheet";

/** A server the pickers list: its saved id, its name, and the host its
 *  rows are written with (box id once known, else the host key). */
export interface ChatPickServer {
  id: string;
  label: string;
  host: string;
}

export interface ChatPanelProps {
  home: Home;
  servers: ChatPickServer[];
  q: string;
  /** Add the row to `home`; true when it went on (the sheet then closes). */
  onAddRow: (row: HomeRow) => boolean;
}

const MUTED = "var(--color-text-muted)";

/** Every word of the search starts a word of the haystack. */
export function tokenMatch(q: string, hay: readonly string[]): boolean {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const parts = hay.flatMap((h) => h.toLowerCase().split(/[\s._@:-]+/)).filter(Boolean);
  const whole = hay.map((h) => h.toLowerCase());
  return words.every((w) => parts.some((p) => p.startsWith(w)) || whole.some((h) => h.includes(w)));
}

/** A server's line while it has nothing to list (none: list it). */
export function chatSectionStatus(st: HomeChatServerState | undefined, need: "people" | "channels"): string | null {
  const gate = st?.gate ?? null;
  if (!gate || gate.checkedAt === null) return "Loading…";
  if (!gate.offered) {
    if (gate.feature && gate.on === null && gate.refusal) return "Can’t reach this server right now.";
    return gate.pickerLine ?? HOME_CHAT_COPY_NO_CHAT;
  }
  if (need === "people") {
    if (!st?.people) return st?.peopleError ? `Couldn’t list people: ${st.peopleError}` : "Loading people…";
    return null;
  }
  if (!st?.channels) return st?.channelsError ? `Couldn’t list channels: ${st.channelsError}` : "Loading channels…";
  return null;
}

function SectionHead({ label, count }: { label: string; count?: number | null }) {
  return (
    <h3
      className="flex items-center justify-between text-[13px] font-semibold uppercase"
      style={{ color: MUTED, padding: "10px 16px 4px", letterSpacing: "0.3px", gap: 8 }}
    >
      <span className="truncate">{label}</span>
      {count ? <span style={{ fontWeight: 400 }}>{count}</span> : null}
    </h3>
  );
}

function StatusLine({ text, testId }: { text: string; testId?: string }) {
  return (
    <p className="text-[14px]" style={{ color: MUTED, padding: "4px 16px 10px" }} data-testid={testId}>
      {text}
    </p>
  );
}

function PlusMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}

/** One pickable row: picture, name, detail; + to add, or "✓ In <group>". */
function PickRow({
  avatar,
  name,
  detail,
  taken,
  disabled,
  groupName,
  testId,
  onPick,
}: {
  avatar: ReactNode;
  name: string;
  detail: string;
  taken: boolean;
  disabled: boolean;
  groupName: string;
  testId: string;
  onPick: () => void;
}) {
  const off = taken || disabled;
  return (
    <button
      type="button"
      className="w-full flex items-center text-left bg-transparent border-0"
      style={{ gap: 12, padding: "8px 16px", minHeight: 56, color: "var(--color-text-primary)", opacity: disabled ? 0.45 : 1 }}
      aria-disabled={off || undefined}
      aria-label={taken ? `${name}, already in ${groupName}` : disabled ? `${name}, ${detail}` : `Add ${name} to ${groupName}`}
      data-testid={testId}
      data-taken={taken ? "1" : undefined}
      onClick={() => {
        if (!off) onPick();
      }}
    >
      {avatar}
      <span className="flex-1 min-w-0">
        <span className="block truncate text-[16px] font-medium">{name}</span>
        <span className="block truncate text-[13px]" style={{ color: MUTED }}>
          {detail}
        </span>
      </span>
      <span className="shrink-0 flex items-center" style={{ gap: 4, color: taken ? "var(--color-text-secondary)" : "var(--color-accent-text)" }}>
        {taken ? (
          <>
            <CheckIcon size={16} strokeWidth={2.6} />
            <span className="text-[13px] truncate" style={{ maxWidth: 90 }}>
              In {groupName}
            </span>
          </>
        ) : disabled ? null : (
          <PlusMark />
        )}
      </span>
    </button>
  );
}

/** Read every listed server's gate (and people / channels when open). */
function useServersRead(servers: readonly ChatPickServer[], what: "people" | "channels"): void {
  const key = servers.map((s) => s.id).join("\n");
  useEffect(() => {
    for (const id of key ? key.split("\n") : []) {
      void refreshChatServer(id, { people: what === "people", channels: what === "channels" }).then(() =>
        what === "people" ? refreshChatPeople(id, true) : refreshChatChannels(id, true)
      );
    }
  }, [key, what]);
}

/** The people on this group's person rows from other servers, for "Same
 *  person?": their server's list when read, else the row's label. */
export function groupPeopleByServer(
  home: Home,
  serverOf: (host: string) => string | null,
  byServer: Readonly<Record<string, HomeChatServerState | undefined>>
): Record<string, Array<Pick<HomeChatPerson, "ext" | "username" | "displayName">>> {
  const out: Record<string, Array<Pick<HomeChatPerson, "ext" | "username" | "displayName">>> = {};
  for (const r of home.rows) {
    const parts = chatRowParts(r);
    if (parts?.kind !== "person") continue;
    const sid = serverOf(parts.host);
    if (!sid) continue;
    const p = byServer[sid]?.people?.people.find((x) => x.ext.toLowerCase() === parts.handle);
    (out[sid] ??= []).push(p ?? { ext: parts.handle, username: "", displayName: r.label });
  }
  return out;
}

/** Ask "Same person?" when `person` may already be on `home` from another
 *  server. True: add the row. */
export async function samePersonGate(
  person: HomeChatPerson,
  serverId: string,
  home: Home,
  ctx: {
    serverOf: (host: string) => string | null;
    labelOf: (serverId: string) => string;
    byServer: Readonly<Record<string, HomeChatServerState | undefined>>;
  }
): Promise<boolean> {
  const match = matchesElsewhere(person, serverId, groupPeopleByServer(home, ctx.serverOf, ctx.byServer))[0];
  if (!match) return true;
  const copy = samePersonCopy(person.displayName, match.person.displayName, ctx.labelOf(match.serverId));
  const answer = await askHome({
    title: copy.title,
    body: copy.body,
    choices: [
      { id: "same", label: "Same person", primary: true },
      { id: "different", label: "Different person" },
    ],
    testId: "same-person",
  });
  // Same person: their row stays. Cancel: nothing. Only Different adds.
  return answer === "different";
}

function useServerLookup() {
  const saved = useServersStore((s) => s.servers);
  const tokens = useServersStore((s) => s.tokens);
  return useMemo(
    () => ({
      serverOf: (host: string) => savedServerForHost(saved, host, tokens)?.id ?? null,
      labelOf: (id: string) => {
        const s = saved.find((x) => x.id === id);
        return s ? serverDisplayName(s) : id;
      },
    }),
    [saved, tokens]
  );
}

// ─── People ───

export function PeoplePanel({ home, servers, q, onAddRow }: ChatPanelProps) {
  useServersRead(servers, "people");
  const byServer = useHomeChatStore((s) => s.byServer);
  const lookup = useServerLookup();
  const [busy, setBusy] = useState(false);

  const pick = async (server: ChatPickServer, p: HomeChatPerson) => {
    if (busy || !pickablePerson(p)) return;
    const row = personRow(p, server.host);
    if (!row) return;
    setBusy(true);
    try {
      const add = await samePersonGate(p, server.id, home, { ...lookup, byServer: useHomeChatStore.getState().byServer });
      if (add) onAddRow(row);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="add-people">
      {servers.map((server) => {
        const st = byServer[server.id];
        const status = chatSectionStatus(st, "people");
        const people = status ? [] : (st?.people?.people ?? []).filter((p) => isPersonExt(p.ext));
        const shown = people.filter((p) => tokenMatch(q, [p.displayName, p.username]));
        if (q.trim() && !status && shown.length === 0) return null;
        return (
          <section key={server.id} data-testid={`add-people-server-${server.id}`}>
            <SectionHead label={server.label} count={status ? null : people.length} />
            {status ? (
              <StatusLine text={status} testId={`add-people-status-${server.id}`} />
            ) : people.length === 0 ? (
              <StatusLine text="Nobody else on this server" />
            ) : (
              shown.map((p) => {
                const row = personRow(p, server.host);
                const taken = !!row && homeHasAddress(home, row.address);
                const ready = pickablePerson(p);
                return (
                  <PickRow
                    key={p.ext}
                    avatar={<PersonAvatar username={p.username} name={p.displayName} picture={p.picture} size={40} fontSize={15} />}
                    name={p.displayName}
                    detail={ready ? (p.role ? `${p.username} · ${p.role === "voice_chat" ? "voice & chat" : p.role}` : p.username) : "Setting up…"}
                    taken={taken}
                    disabled={!ready}
                    groupName={home.name}
                    testId={`add-person-${server.id}-${p.ext}`}
                    onPick={() => void pick(server, p)}
                  />
                );
              })
            )}
          </section>
        );
      })}
      {servers.length === 0 ? <StatusLine text={HOME_CHAT_COPY_NO_CHAT} /> : null}
    </div>
  );
}

// ─── Channels ───

export type ChannelMode = "pick" | "new";

export function ChannelsPanel({ home, servers, q, onAddRow, mode }: ChatPanelProps & { mode: ChannelMode }) {
  return mode === "pick" ? (
    <ChannelPickList home={home} servers={servers} q={q} onAddRow={onAddRow} />
  ) : (
    <NewChannelForm servers={servers} onAddRow={onAddRow} />
  );
}

function ChannelPickList({ home, servers, q, onAddRow }: ChatPanelProps) {
  useServersRead(servers, "channels");
  const byServer = useHomeChatStore((s) => s.byServer);
  return (
    <div data-testid="add-channels">
      {servers.map((server) => {
        const st = byServer[server.id];
        const status = chatSectionStatus(st, "channels");
        const channels = status ? [] : (st?.channels ?? []).filter((c) => !c.archived);
        const shown = channels.filter((c) => tokenMatch(q, [c.name]));
        if (q.trim() && !status && shown.length === 0) return null;
        return (
          <section key={server.id} data-testid={`add-channels-server-${server.id}`}>
            <SectionHead label={server.label} count={status ? null : channels.length} />
            {status ? (
              <StatusLine text={status} testId={`add-channels-status-${server.id}`} />
            ) : channels.length === 0 ? (
              <StatusLine text="No channels yet: make one with New channel" />
            ) : (
              shown.map((c: HomeChatChannel) => {
                const row = channelRow(c.conv, c.name, server.host);
                const taken = !!row && homeHasAddress(home, row.address);
                return (
                  <PickRow
                    key={c.conv}
                    avatar={<ChannelAvatar inviteOnly={c.inviteOnly} size={40} />}
                    name={c.name}
                    detail={c.inviteOnly ? "Invite only" : "Open"}
                    taken={taken}
                    disabled={false}
                    groupName={home.name}
                    testId={`add-channel-${server.id}-${c.conv}`}
                    onPick={() => {
                      if (row) onAddRow(row);
                    }}
                  />
                );
              })
            )}
          </section>
        );
      })}
    </div>
  );
}

type FormState = { kind: "idle" } | { kind: "busy"; line: string } | { kind: "error"; line: string };

/** New channel. `deps` lets tests make the wait instant. */
export function NewChannelForm({
  servers,
  onAddRow,
  waitDeps,
}: {
  servers: ChatPickServer[];
  onAddRow: (row: HomeRow) => boolean;
  waitDeps?: { sleep?: (ms: number) => Promise<void>; now?: () => number };
}) {
  useServersRead(servers, "people");
  const byServer = useHomeChatStore((s) => s.byServer);
  const usable = servers.filter((s) => byServer[s.id]?.gate?.offered);
  const [serverId, setServerId] = useState<string | null>(null);
  const server = usable.find((s) => s.id === serverId) ?? usable[0] ?? null;
  const [name, setName] = useState("");
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<Set<string>>(() => new Set());
  const [state, setState] = useState<FormState>({ kind: "idle" });
  const people = server ? (byServer[server.id]?.people?.people ?? []).filter(pickablePerson) : [];
  const anyRead = servers.some((s) => byServer[s.id]?.gate?.checkedAt != null);

  const create = async () => {
    const clean = name.trim();
    if (!server || !clean || state.kind === "busy") return;
    setState({ kind: "busy", line: "Making the channel…" });
    const scope = scopeFor(server.id);
    const made = await createHomeChatChannel(scope, { name: clean, open, members: [...members] });
    if (!made.ok) {
      setState({ kind: "error", line: made.hint || "Couldn’t make the channel." });
      return;
    }
    let conv = made.conv;
    if (!conv) {
      setState({ kind: "busy", line: "Setting up the channel…" });
      const waited = await waitForHomeChatChannel(scope, made.slug, {
        waitMs: HOME_CHAT_CREATE_WAIT_MS,
        pollMs: HOME_CHAT_CREATE_POLL_MS,
        ...waitDeps,
      });
      if (!waited.ok) {
        setState({ kind: "error", line: waited.hint || "Couldn’t make the channel." });
        return;
      }
      conv = waited.conv;
    }
    if (!conv) {
      setState({ kind: "error", line: HOME_CHAT_CREATE_TIMEOUT_COPY });
      return;
    }
    void refreshChatChannels(server.id, true);
    const row = channelRow(conv, clean, server.host);
    setState({ kind: "idle" });
    if (row) onAddRow(row);
  };

  if (usable.length === 0) {
    return <StatusLine text={anyRead ? HOME_CHAT_COPY_NO_CHAT : "Loading…"} testId="new-channel-none" />;
  }
  const label = (t: string) => (
    <span className="block text-[13px] font-semibold uppercase" style={{ color: MUTED, letterSpacing: "0.3px", marginBottom: 6 }}>
      {t}
    </span>
  );
  return (
    <div className="flex flex-col" style={{ gap: 18, padding: "6px 16px 12px" }} data-testid="new-channel">
      {usable.length > 1 ? (
        <div data-testid="new-channel-server">
          {label("Server")}
          <div className="flex flex-wrap" style={{ gap: 8 }}>
            {usable.map((s) => (
              <button
                key={s.id}
                type="button"
                className="zen-glass zen-glass-pill text-[14px]"
                style={{
                  padding: "6px 12px",
                  color: s.id === server?.id ? "var(--color-on-accent)" : "var(--color-text-primary)",
                  background: s.id === server?.id ? "var(--color-accent-fill)" : undefined,
                }}
                aria-pressed={s.id === server?.id}
                data-testid={`new-channel-server-${s.id}`}
                onClick={() => {
                  setServerId(s.id);
                  setMembers(new Set());
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <label className="block">
        {label("Name")}
        <span className="zen-glass zen-glass-field flex items-center" style={{ padding: "9px 14px" }}>
          <input
            type="text"
            value={name}
            maxLength={HOME_CHAT_CHANNEL_NAME_MAX}
            placeholder="e.g. launch"
            aria-label="Channel name"
            autoCapitalize="none"
            className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[16px]"
            style={{ color: "var(--color-text-primary)" }}
            data-testid="new-channel-name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void create();
              }
            }}
          />
        </span>
      </label>
      <div>
        {label("Who can see it")}
        <Seg
          ariaLabel="Who can see it"
          value={open ? "open" : "invite"}
          onChange={(v) => setOpen(v === "open")}
          options={[
            { value: "invite", label: "Invite only" },
            { value: "open", label: "Open" },
          ]}
          testIdPrefix="new-channel-privacy"
        />
        <p className="text-[13px]" style={{ color: MUTED, marginTop: 6, lineHeight: 1.35 }} data-testid="new-channel-privacy-hint">
          {open ? "Everyone on this server can find it and join." : "Only the people in it see it."} This can't be changed later.
        </p>
      </div>
      <div>
        {label("People")}
        {people.length === 0 ? (
          <p className="text-[14px]" style={{ color: MUTED }}>
            Nobody else to add yet.
          </p>
        ) : (
          <div className="flex flex-col" style={{ margin: "0 -4px" }}>
            {people.map((p) => {
              const on = members.has(p.ext);
              return (
                <button
                  key={p.ext}
                  type="button"
                  className="flex items-center bg-transparent border-0 text-left"
                  style={{ gap: 12, minHeight: 48, padding: "4px", color: "var(--color-text-primary)" }}
                  role="checkbox"
                  aria-checked={on}
                  data-testid={`new-channel-member-${p.ext}`}
                  onClick={() =>
                    setMembers((cur) => {
                      const next = new Set(cur);
                      if (next.has(p.ext)) next.delete(p.ext);
                      else next.add(p.ext);
                      return next;
                    })
                  }
                >
                  <span
                    aria-hidden
                    className="shrink-0 flex items-center justify-center"
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: "50%",
                      background: on ? "var(--color-accent-fill)" : undefined,
                      color: "var(--color-on-accent)",
                      boxShadow: on ? undefined : "inset 0 0 0 1.5px var(--color-control-edge)",
                    }}
                  >
                    {on ? <CheckIcon size={14} strokeWidth={3} /> : null}
                  </span>
                  <PersonAvatar username={p.username} name={p.displayName} picture={p.picture} size={32} fontSize={12} />
                  <span className="flex-1 min-w-0 truncate text-[16px]">{p.displayName}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="flex items-center" style={{ gap: 12 }}>
        <p
          className="flex-1 min-w-0 text-[13px]"
          style={{ color: state.kind === "error" ? "var(--color-status-error-text)" : "var(--color-text-secondary)", lineHeight: 1.35 }}
          role={state.kind === "error" ? "alert" : "status"}
          data-testid="new-channel-state"
        >
          {state.kind === "idle" ? "" : state.line}
        </p>
        <button
          type="button"
          className="shrink-0 text-[16px] font-semibold"
          style={{
            minHeight: 44,
            padding: "0 18px",
            borderRadius: 22,
            border: 0,
            background: "var(--color-accent-fill)",
            color: "var(--color-on-accent)",
            opacity: !name.trim() || state.kind === "busy" ? 0.45 : 1,
          }}
          disabled={!name.trim() || state.kind === "busy"}
          data-testid="new-channel-create"
          onClick={() => void create()}
        >
          Make channel
        </button>
      </div>
    </div>
  );
}

// ─── The segmented control (the Agents sheet's look) ───

export function Seg<V extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  testIdPrefix,
  height = 34,
}: {
  value: V;
  options: ReadonlyArray<{ value: V; label: string }>;
  onChange: (v: V) => void;
  ariaLabel: string;
  testIdPrefix: string;
  height?: number;
}) {
  const n = options.length;
  const at = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="zen-seg flex items-center shrink-0 zen-glass zen-glass-pill"
      style={{ position: "relative", height, padding: 2, borderRadius: height / 2, overflow: "hidden" }}
      data-testid={testIdPrefix}
    >
      <span
        className="zen-seg-thumb"
        aria-hidden
        style={{
          position: "absolute",
          top: 2,
          bottom: 2,
          left: 2,
          width: `calc(${100 / n}% - ${4 / n}px)`,
          borderRadius: height / 2 - 2,
          transform: `translateX(${at * 100}%)`,
        }}
      />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="zen-seg-btn flex-1 text-[14px] font-medium"
          style={{ height: "100%" }}
          aria-pressed={o.value === value}
          data-selected={o.value === value || undefined}
          data-testid={`${testIdPrefix}-${o.value}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
