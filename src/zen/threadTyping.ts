// Who is typing in an agent Thread (K2 `thread-typing-v1`, Riley via K2
// Design). People with K2 logins and App users who read the same Thread
// see each other type; agents never send it.
//
//   client → {"t":"typing","thread":"<thread addr>"}   on the Thread's live
//            socket, at most once every 8 s while the person types in the
//            Thread composer (input with words in it; never a draft put
//            back, never anything automated).
//   daemon → {collection:"typing", seq:0, id:<thread addr>, member, name,
//            kind:"person"|"app_guest", at}   to the OTHER readers of that
//            Thread (never the typist's own sockets), at most one per 2 s
//            per member.
//
// Client rules (K2 Design m_WKltKevINj, Sew's): send only with words in the
// field, at most once per 8 s, no stop frame, nothing on blur; a name holds
// 10 s from its last frame and clears as soon as that member's message
// lands in the Thread; never yourself; one entry per member across their
// devices; oldest first; per Thread. The daemon drops extras, is lossy and
// never replays. The look is Home chat's (HomeChatTyping); the words are
// the Thread's own (threadTypingLine: "Several people" from three).
//
// "Oldest first": by when each member's current run of typing began, so a
// repeat frame never reorders the line (nor re-announces it).
//
// A typing frame is not a message: `seq:0` there is no position in the
// message stream, so it is taken here and never reaches the list.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  typingCleared,
  typingMembers,
  typingNextExpiry,
  typingNoted,
  typingPruned,
  typingTick,
  TYPING_CLEAR_MS,
  TYPING_SEND_INTERVAL_MS,
  type TypingRoster,
  type TypingSent,
} from "../api/homeChatHelpers";

/** The `/boot-status` feature. Absent: nothing is sent or shown. */
export const FEATURE_THREAD_TYPING = "thread-typing-v1" as const;
/** At most one `typing` frame per Thread this often (Sew's 8 s, as Home chat). */
export const THREAD_TYPING_SEND_MS = TYPING_SEND_INTERVAL_MS;
/** A name clears this long after its last frame (Home chat's 10 s). */
export const THREAD_TYPING_CLEAR_MS = TYPING_CLEAR_MS;

export type ThreadTypingFrame = {
  thread: string;
  member: string;
  name: string;
  kind: string;
  at: number | null;
};

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** True for a `typing` frame (whatever its contents): never a message. */
export function isTypingFrame(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && (raw as { collection?: unknown }).collection === "typing";
}

/** The frame's fields, or null when it isn't a usable typing frame. */
export function parseThreadTypingFrame(raw: unknown): ThreadTypingFrame | null {
  if (!isTypingFrame(raw)) return null;
  const f = raw as Record<string, unknown>;
  const member = str(f.member);
  if (!member) return null;
  const at = typeof f.at === "number" && Number.isFinite(f.at) ? f.at : null;
  return { thread: str(f.id), member, name: str(f.name), kind: str(f.kind), at };
}

const same = (a: string, b: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Is this frame for the Thread on screen? A frame without an id, or a
 *  Thread whose addr isn't known yet, is taken (the socket is the
 *  Thread's own); two different addrs are not. */
export function typingFrameForThread(frame: ThreadTypingFrame, addr: string): boolean {
  const a = (addr || "").trim();
  if (!frame.thread || !a) return true;
  return same(frame.thread, a);
}

/** Who posted a Thread item: the daemon's `author` stamp (`{kind, login}`,
 *  K2 PostAuthor) and the `from` name it shows. */
export type ThreadPostAuthor = { login: string; kind: string; from: string };

export function threadPostAuthor(raw: unknown): ThreadPostAuthor | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as { doc?: unknown };
  const doc = (item.doc && typeof item.doc === "object" ? item.doc : raw) as Record<string, unknown>;
  // A tombstone or an empty frame posts nothing.
  if (doc.deleted === true) return null;
  const a = doc.author;
  let login = "";
  let kind = "";
  if (a && typeof a === "object" && !Array.isArray(a)) {
    login = str((a as { login?: unknown }).login);
    kind = str((a as { kind?: unknown }).kind);
  } else if (typeof a === "string") {
    login = a.trim();
  }
  const from = str(doc.from);
  if (!login && !from) return null;
  return { login, kind, from };
}

/** Does `author`'s post end `member`'s typing? The login stamp is the
 *  member (`login`, or `kind:login`); without a match there, the shown
 *  name: the frame's `name` against the post's `from`. An agent's post
 *  never clears a person. */
export function postEndsTyping(
  author: ThreadPostAuthor,
  member: string,
  name: string
): boolean {
  if (author.kind === "agent") return false;
  if (author.login) {
    if (same(author.login, member)) return true;
    if (author.kind && same(`${author.kind}:${author.login}`, member)) return true;
  }
  if (author.from) return same(author.from, name) || same(author.from, member);
  return false;
}

/** Should the composer send `typing` now? Words in the field, the feature
 *  on, a Thread addr; at most once per `THREAD_TYPING_SEND_MS`. Returns
 *  the memory to keep (unchanged when it says no). */
export function threadTypingTick(
  sent: TypingSent,
  addr: string,
  text: string,
  now: number
): { send: boolean; sent: TypingSent } {
  return typingTick(sent, addr, text, now, THREAD_TYPING_SEND_MS);
}

const NOBODY: readonly string[] = [];

/** The Thread's words: "A is typing…", "A and B are typing…", and from
 *  three "Several people are typing…" (Home chat keeps "and N others").
 *  "" when nobody is. The trailing "…" is drawn as the dots. */
export function threadTypingLine(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return "Several people are typing…";
}

/** The members typing now, oldest first: by the order each one's current
 *  run began (`since`: an arrival count, so two frames in the same
 *  millisecond keep their order), then by member id. */
export function typingOldestFirst(
  roster: TypingRoster,
  since: ReadonlyMap<string, number>,
  now: number
): string[] {
  return typingMembers(roster, now).sort(
    (a, b) => (since.get(a) ?? 0) - (since.get(b) ?? 0) || (a < b ? -1 : a > b ? 1 : 0)
  );
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i]);
}

/** Who is typing in the Thread on screen: frames in, names out.
 *  `me` (the viewer's login) is never listed: the daemon skips the
 *  typist's own sockets, but not the same login on another device.
 *  The roster lives in a ref; the pane re-renders only when the names
 *  shown change (a repeat frame every 2 s changes nothing on screen, so
 *  the live region says nothing again). */
export function useThreadTyping(opts: { on: boolean; roomKey: string; me: string }): {
  names: readonly string[];
  /** A `typing` frame for this Thread. */
  noteFrame: (frame: ThreadTypingFrame) => void;
  /** A message landed in this Thread (its author, from threadPostAuthor). */
  notePost: (author: ThreadPostAuthor | null) => void;
} {
  const { on, roomKey, me } = opts;
  const [shown, setShown] = useState<readonly string[]>(NOBODY);
  const roster = useRef<TypingRoster>({});
  const names = useRef(new Map<string, string>());
  /** member → the order their current run of typing began (oldest first). */
  const since = useRef(new Map<string, number>());
  const arrivals = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const meRef = useRef(me);
  meRef.current = me;
  const onRef = useRef(on);
  onRef.current = on;

  const publish = useCallback(() => {
    const now = Date.now();
    roster.current = typingPruned(roster.current, now);
    for (const m of Array.from(names.current.keys())) {
      if (m in roster.current) continue;
      names.current.delete(m);
      since.current.delete(m);
    }
    const list = typingOldestFirst(roster.current, since.current, now).map((m) => names.current.get(m) || m);
    setShown((prev) => (sameNames(prev, list) ? prev : list.length ? list : NOBODY));
    if (timer.current) clearTimeout(timer.current);
    const next = typingNextExpiry(roster.current, now);
    timer.current = next == null ? null : setTimeout(publish, Math.max(0, next - now) + 1);
  }, []);

  // Another Thread, or the feature off: nobody.
  useEffect(() => {
    roster.current = {};
    names.current.clear();
    since.current.clear();
    publish();
  }, [roomKey, on, publish]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    },
    []
  );

  const noteFrame = useCallback(
    (frame: ThreadTypingFrame) => {
      if (!onRef.current) return;
      const mine = meRef.current.trim();
      if (mine && same(frame.member, mine)) return;
      names.current.set(frame.member, frame.name || frame.member);
      // One entry per member, whichever device sent it: a repeat keeps
      // its place in the line.
      const now = Date.now();
      if (!((roster.current[frame.member] ?? 0) > now)) since.current.set(frame.member, ++arrivals.current);
      roster.current = typingNoted(roster.current, frame.member, now, THREAD_TYPING_CLEAR_MS);
      publish();
    },
    [publish]
  );

  const notePost = useCallback(
    (author: ThreadPostAuthor | null) => {
      if (!author) return;
      let next = roster.current;
      for (const member of Object.keys(next)) {
        if (postEndsTyping(author, member, names.current.get(member) ?? "")) next = typingCleared(next, member);
      }
      if (next === roster.current) return;
      roster.current = next;
      publish();
    },
    [publish]
  );

  return { names: on ? shown : NOBODY, noteFrame, notePost };
}

