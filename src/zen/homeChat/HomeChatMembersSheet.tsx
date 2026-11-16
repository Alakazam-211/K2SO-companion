// A channel's members sheet (brief §2.9; desktop
// `HomeChatMembersSheet.tsx`, as a phone bottom sheet): who is in it (an
// avatar row each, in their colour, with their role and "Created it" for
// the maker), Invite people (a checklist of who can be added), and Rename,
// Leave and Delete in its footer. Delete asks "Delete #name?" with Keep it
// focused. The daemon checks every change; the sheet only hides what the
// caller's role can't do (`channelPerms`).

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { ServerScope } from "../../api/scope";
import {
  addHomeChatPeople,
  deleteHomeChatChannel,
  leaveHomeChatChannel,
  removeHomeChatPerson,
  renameHomeChatChannel,
} from "../../api/homeChat";
import type { HomeChatPerson } from "../../api/homeChatPure";
import { useBackHandler } from "../../lib/androidBack";
import { useViewport } from "../../lib/useViewportHeight";
import { CheckIcon } from "../icons";
import { ensureHomeChatPeople, loadHomeChatChannel, refusalText } from "./homeChatActions";
import {
  DELETE_MESSAGE,
  HOME_CHAT_NAME_MAX,
  callerIsAdmin,
  channelPerms,
  convKey,
  deleteTitle,
  leaveCopy,
  memberRoleLabel,
  membersSubline,
  pickablePerson,
} from "./homeChatModel";
import { noteHomeChatGone, useHomeChatStore } from "./homeChatStore";
import { ChannelGlyph, PersonAvatar } from "./HomeChatGlyphs";
import { HomeChatConfirmSheet } from "./HomeChatConfirmSheet";

const ROW = "flex items-center gap-3 min-w-0";
const SECTION = "text-[12px] font-semibold uppercase tracking-wide px-1 mb-1";

export function HomeChatMembersSheet({
  scope,
  conv,
  onClose,
  onLeft,
}: {
  scope: ServerScope;
  conv: string;
  onClose: () => void;
  /** You left the channel (the chat closes). */
  onLeft: () => void;
}) {
  const key = convKey(scope.id, conv);
  const members = useHomeChatStore((s) => s.channels[key] ?? null);
  const people = useHomeChatStore((s) => s.people[scope.id]?.people ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [ask, setAsk] = useState<"leave" | "delete" | null>(null);
  const vp = useViewport();
  useBackHandler(ask === null, onClose);

  useEffect(() => {
    void loadHomeChatChannel(scope, conv).then((e) => e && setError(e));
    void ensureHomeChatPeople(scope);
  }, [scope, conv]);

  const meExt = people?.me.ext ?? "";
  const inChannel = useMemo(() => new Set((members?.people ?? []).map((p) => p.ext)), [members]);
  const perms = channelPerms({
    callerExt: meExt,
    admin: callerIsAdmin(people),
    creator: members?.creator ?? "",
    member: inChannel.has(meExt),
    open: members?.open ?? false,
    archived: members?.state === "archived",
  });
  const personOf = (ext: string): HomeChatPerson | undefined => people?.people.find((p) => p.ext === ext);
  const nameOf = (ext: string): string => {
    if (ext === meExt) return "You";
    const p = personOf(ext);
    return p ? p.displayName : ext === "k2:owner" ? "Owner" : "Someone";
  };
  const usernameOf = (ext: string): string =>
    ext === meExt ? scope.username() || "you" : ext === "k2:owner" ? "owner" : (personOf(ext)?.username ?? ext);
  const addable = (people?.people ?? []).filter((p) => pickablePerson(p, meExt) && !inChannel.has(p.ext));

  /** One change, then the sheet's facts again. */
  const run = async (fn: () => Promise<string | null>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const err = await fn();
      if (err) {
        setError(err);
        return false;
      }
      const again = await loadHomeChatChannel(scope, conv);
      if (again) setError(again);
      return true;
    } finally {
      setBusy(false);
    }
  };

  const invite = () =>
    void run(async () => {
      const r = await addHomeChatPeople(scope, conv, [...picked]);
      if (!r.ok) return refusalText(r);
      const refused = r.results.filter((x) => x.outcome === "refused");
      setPicked(new Set());
      setInviting(false);
      return refused.length ? `Couldn't add ${refused.map((x) => nameOf(x.ext)).join(", ")}.` : null;
    });

  const rename = (name: string) =>
    void run(async () => {
      const r = await renameHomeChatChannel(scope, conv, name);
      if (!r.ok) return refusalText(r);
      setRenaming(null);
      return null;
    });

  const leave = () =>
    void run(async () => {
      const r = await leaveHomeChatChannel(scope, conv);
      if (!r.ok) return refusalText(r);
      setAsk(null);
      noteHomeChatGone({ serverId: scope.id, conv, why: "left" });
      onLeft();
      return null;
    });

  const archive = () =>
    void run(async () => {
      const r = await deleteHomeChatChannel(scope, conv);
      setAsk(null);
      if (!r.ok) return refusalText(r);
      noteHomeChatGone({ serverId: scope.id, conv, why: "deleted" });
      return null;
    });

  const leaveWords = leaveCopy(members);
  return createPortal(
    <div
      className="fixed left-0 right-0 flex items-end justify-center"
      style={{ top: vp.offsetTop, height: vp.height, background: "var(--color-scrim)", zIndex: 58, fontFamily: "var(--zen-font)" }}
      data-testid="home-chat-members"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={members ? `Members of ${members.name}` : "Members"}
        className="w-full k2-tile k2-tile-sheet flex flex-col min-h-0"
        style={{
          borderTopLeftRadius: 14,
          borderTopRightRadius: 14,
          maxHeight: "88%",
          color: "var(--color-text-primary)",
        }}
      >
        {/* Head: the glyph and name (or Rename's field), then who it's for. */}
        <div className="shrink-0" style={{ padding: "14px 16px 10px" }}>
          <div className="flex items-center" style={{ gap: 8 }}>
            {renaming !== null ? (
              <form
                className="flex items-center flex-1 min-w-0"
                style={{ gap: 8 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  const n = renaming.trim();
                  if (n) rename(n);
                }}
              >
                <input
                  autoFocus
                  aria-label="Channel name"
                  data-testid="home-chat-rename-input"
                  value={renaming}
                  maxLength={HOME_CHAT_NAME_MAX}
                  onChange={(e) => setRenaming(e.target.value)}
                  className="flex-1 min-w-0 text-[16px] outline-none"
                  style={{ height: 36, padding: "0 12px", borderRadius: 10, border: 0, background: "var(--color-bg-elevated)", color: "var(--color-text-primary)" }}
                />
                <button
                  type="submit"
                  className="shrink-0 text-[15px] font-semibold"
                  style={{ minHeight: 36, padding: "0 12px", borderRadius: 10, background: "var(--color-accent-fill)", color: "var(--color-on-accent)" }}
                  disabled={busy || !renaming.trim()}
                  data-testid="home-chat-rename-save"
                >
                  Save
                </button>
                <button type="button" className="shrink-0 text-[15px] bg-transparent border-0" style={{ color: "var(--color-accent-text)" }} onClick={() => setRenaming(null)}>
                  Cancel
                </button>
              </form>
            ) : (
              <>
                <h2 className="flex items-center flex-1 min-w-0 text-[18px] font-semibold" style={{ gap: 6 }} data-testid="home-chat-members-title">
                  {members ? (
                    <span className="flex" style={{ color: "var(--color-text-secondary)" }}>
                      <ChannelGlyph inviteOnly={!members.open} size={17} />
                    </span>
                  ) : null}
                  <span className="min-w-0 truncate">{members ? members.name : "Members"}</span>
                </h2>
                <button
                  type="button"
                  className="shrink-0 text-[16px] font-semibold bg-transparent border-0"
                  style={{ color: "var(--color-accent-text)", padding: "4px 2px" }}
                  onClick={onClose}
                  data-testid="home-chat-members-done"
                >
                  Done
                </button>
              </>
            )}
          </div>
          {members ? (
            <p className="mt-1 text-[13px]" style={{ color: "var(--color-text-secondary)" }} data-testid="home-chat-members-sub">
              {membersSubline(members)}
            </p>
          ) : null}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: "0 12px 8px", WebkitOverflowScrolling: "touch" }} data-testid="home-chat-members-body">
          {error ? (
            <p className="px-1 pb-2 text-[13px]" style={{ color: "var(--color-status-error-text)" }} role="alert" data-testid="home-chat-members-error">
              {error}
            </p>
          ) : null}
          {members === null && !error ? (
            <p className="px-1 py-4 text-[14px]" style={{ color: "var(--color-text-muted)" }}>
              Loading…
            </p>
          ) : null}
          {members ? (
            <>
              <h3 className={SECTION} style={{ color: "var(--color-text-muted)" }}>
                People
              </h3>
              <ul className="flex flex-col list-none m-0 p-0" data-testid="home-chat-member-list">
                {members.people.map((p) => {
                  const person = personOf(p.ext);
                  const role = memberRoleLabel(person?.role ?? (p.ext === "k2:owner" ? "owner" : null));
                  const notes = [role, p.ext === members.creator ? "Created it" : null, p.state === "pending_add" ? "Adding…" : null].filter(Boolean);
                  return (
                    <li key={p.ext} className={ROW} style={{ minHeight: 52, padding: "6px 4px" }} data-member={p.ext}>
                      <PersonAvatar username={usernameOf(p.ext)} name={p.ext === meExt ? scope.username() || "You" : nameOf(p.ext)} picture={person?.picture ?? null} size={34} />
                      <span className="flex flex-col flex-1 min-w-0">
                        <span className="text-[16px] truncate">{nameOf(p.ext)}</span>
                        {notes.length ? (
                          <span className="text-[12px] truncate" style={{ color: "var(--color-text-secondary)" }} data-member-role="">
                            {notes.join(" · ")}
                          </span>
                        ) : null}
                      </span>
                      {perms.removeOthers && p.ext !== meExt ? (
                        <button
                          type="button"
                          className="shrink-0 text-[14px] bg-transparent border-0"
                          style={{ color: "var(--color-status-error-text)" }}
                          disabled={busy}
                          data-testid="home-chat-remove-member"
                          onClick={() =>
                            void run(async () => {
                              const r = await removeHomeChatPerson(scope, conv, p.ext);
                              return r.ok ? null : refusalText(r);
                            })
                          }
                        >
                          Remove
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>

              {perms.addPeople && inviting ? (
                <div className="mt-3" data-testid="home-chat-invite-list">
                  <h3 className={SECTION} style={{ color: "var(--color-text-muted)" }}>
                    Invite people
                  </h3>
                  {addable.length === 0 ? (
                    <p className="px-1 py-1 text-[14px]" style={{ color: "var(--color-text-muted)" }}>
                      Everyone you can add is already here.
                    </p>
                  ) : (
                    <ul className="flex flex-col list-none m-0 p-0">
                      {addable.map((p) => {
                        const on = picked.has(p.ext);
                        return (
                          <li key={p.ext}>
                            <button
                              type="button"
                              role="checkbox"
                              aria-checked={on}
                              className={`${ROW} w-full bg-transparent border-0 text-left`}
                              style={{ minHeight: 48, padding: "6px 4px", color: "var(--color-text-primary)" }}
                              data-testid="home-chat-invite-person"
                              onClick={() =>
                                setPicked((cur) => {
                                  const next = new Set(cur);
                                  if (next.has(p.ext)) next.delete(p.ext);
                                  else next.add(p.ext);
                                  return next;
                                })
                              }
                            >
                              <span
                                aria-hidden
                                className="flex items-center justify-center shrink-0"
                                style={{
                                  width: 22,
                                  height: 22,
                                  borderRadius: 11,
                                  border: on ? 0 : "1.5px solid var(--color-control-edge)",
                                  background: on ? "var(--color-accent-fill)" : "transparent",
                                  color: "var(--color-on-accent)",
                                }}
                              >
                                {on ? <CheckIcon size={14} strokeWidth={3} /> : null}
                              </span>
                              <PersonAvatar username={p.username} name={p.displayName} picture={p.picture} size={30} />
                              <span className="flex-1 min-w-0 truncate text-[16px]">{p.displayName}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <div className="flex mt-2" style={{ gap: 10 }}>
                    <button
                      type="button"
                      className="flex-1 text-[16px] font-semibold"
                      style={{ minHeight: 42, borderRadius: 12, background: "var(--color-accent-fill)", color: "var(--color-on-accent)", opacity: busy || picked.size === 0 ? 0.5 : 1 }}
                      disabled={busy || picked.size === 0}
                      data-testid="home-chat-invite-confirm"
                      onClick={invite}
                    >
                      {picked.size > 1 ? `Invite ${picked.size} people` : "Invite"}
                    </button>
                    <button
                      type="button"
                      className="flex-1 text-[16px] k2-tile"
                      style={{ minHeight: 42, borderRadius: 12, color: "var(--color-text-primary)" }}
                      onClick={() => {
                        setInviting(false);
                        setPicked(new Set());
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        {members ? (
          <div
            className="shrink-0 flex flex-wrap items-center"
            style={{ gap: 8, padding: "10px 16px max(12px, var(--safe-bottom))", borderTop: "0.5px solid var(--color-wash-2)" }}
            data-testid="home-chat-members-foot"
          >
            {perms.addPeople && !inviting ? (
              <button
                type="button"
                className="text-[15px] font-semibold"
                style={{ minHeight: 36, padding: "0 14px", borderRadius: 18, background: "var(--color-accent-fill)", color: "var(--color-on-accent)" }}
                disabled={busy}
                data-testid="home-chat-invite"
                onClick={() => setInviting(true)}
              >
                Invite people
              </button>
            ) : null}
            <span className="flex-1" />
            {perms.rename && renaming === null ? (
              <button type="button" className="text-[15px] bg-transparent border-0" style={{ color: "var(--color-accent-text)", padding: "6px 4px" }} disabled={busy} data-testid="home-chat-rename" onClick={() => setRenaming(members.name)}>
                Rename
              </button>
            ) : null}
            {perms.leave ? (
              <button type="button" className="text-[15px] bg-transparent border-0" style={{ color: "var(--color-accent-text)", padding: "6px 4px" }} disabled={busy} data-testid="home-chat-leave" onClick={() => setAsk("leave")}>
                Leave
              </button>
            ) : null}
            {perms.remove ? (
              <button type="button" className="text-[15px] bg-transparent border-0" style={{ color: "var(--color-status-error-text)", padding: "6px 4px" }} disabled={busy} data-testid="home-chat-delete" onClick={() => setAsk("delete")}>
                Delete
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {ask === "delete" ? (
        <HomeChatConfirmSheet
          testId="home-chat-delete-confirm"
          title={deleteTitle(members)}
          message={DELETE_MESSAGE}
          confirmLabel="Delete"
          cancelLabel="Keep it"
          destructive
          busy={busy}
          onCancel={() => setAsk(null)}
          onConfirm={archive}
        />
      ) : ask === "leave" ? (
        <HomeChatConfirmSheet
          testId="home-chat-leave-confirm"
          title={leaveWords.title}
          message={leaveWords.message}
          confirmLabel="Leave"
          destructive
          busy={busy}
          onCancel={() => setAsk(null)}
          onConfirm={leave}
        />
      ) : null}
    </div>,
    document.body
  );
}
