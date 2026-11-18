// "Set your new password": the steps behind `SetPasswordStep.tsx`
// (requests in `api/changePassword.ts`, the store commit in
// `stores/servers.ts`). Every entry point uses the same steps:
//
//   1. a session to change it with: the restricted one the sign-in just
//      minted, else sign in with the temporary password (a wrong one is the
//      login's own 401, so it never looks like a dead token);
//   2. POST change-password {currentPassword, newPassword};
//   3. the server ended every session of this login: sign in again with
//      the NEW password (same login URL rule as every sign-in);
//   4. save that session exactly as a sign-in does, then clear the
//      must-change state (scope's explained token, the pool's
//      `rotate-required`) and check the server again.
//
// K2 0.46.16 (`/boot-status` lists `companion-password-ticket-v1`):
//
//   1'. the session the screen has (minted, or held from before) is used
//       as it is: the server now tells a dead session (401 `unauthorized`)
//       from a wrong temporary password (401 `current_password_wrong`), so
//       there is no fresh sign-in first. With no session, or a dead one, a
//       one-use password ticket (`POST /cli/auth/device/password-ticket`
//       on the box's own address) stands in: it works on a box with web
//       access off, where the password sign-in can't.
//   2'. a locked login (423) comes back with its wait; a new password the
//       same as the temporary one is caught before it is sent.
//   3'. from a pairing code, pairing is next (the code is checked again);
//       otherwise sign in with the new password, and on a web-off box
//       (403 `web_client_disabled`) pairing is next too.
//
// The passwords are arguments only: never stored, never logged. A ticket
// is a local of one attempt: never kept, never logged.

import {
  changeServerPassword,
  DEFAULT_CHANGE_PATH,
  FEATURE_PASSWORD_TICKET,
  fetchPasswordPolicy,
  firstUnmetRule,
  requestPasswordTicket,
  serverListsPasswordTicket,
  SET_PASSWORD_COPY,
  type PasswordPolicy,
} from "../api/changePassword";
import { bootInfoFor, clearMustChange } from "../api/scope";
import { commitPasswordSession, loginToServer, revokeSession } from "../stores/servers";
import { pool } from "./multi/pool";

/** Where the new password goes and where the session is saved. */
export interface SetPasswordTarget {
  /** The saved server this signs in (replaced by id), or null for new. */
  serverId: string | null;
  url: string;
  username: string;
  nickname: string;
  /** Make it the active server once signed in. */
  activate: boolean;
}

export type SetPasswordOutcome =
  | { ok: true; id: string }
  | {
      ok: false;
      /** Which field the error belongs to, so the screen can focus it.
       *  `current`: the temporary password. `new`: the new one. `signin`:
       *  the password changed but signing in with it didn't work. `pair`
       *  (K2 0.46.16): the password is set and pairing is how this phone
       *  signs in next; `error` is the notice to show there. */
      field: "current" | "new" | "signin" | "form" | "pair";
      error: string;
      /** A fresher policy than the screen had, when one was read. */
      policy?: PasswordPolicy;
      /** K2 0.46.16 423: seconds until the server takes another try. */
      retryAfterSecs?: number;
    };

/** Does this server speak K2 0.46.16's password ticket contract? The
 *  feature memory for a saved server when it lists the key, else one read
 *  of the box's `/boot-status`. False when unknown: the step as before. */
export async function passwordTicketContract(target: Pick<SetPasswordTarget, "serverId" | "url">, token?: string | null): Promise<boolean> {
  if (target.serverId && bootInfoFor(target.serverId)?.features?.has(FEATURE_PASSWORD_TICKET)) return true;
  return serverListsPasswordTicket(target.url, token);
}

/** The restricted sessions a screen holds (minted for it, not saved). One
 *  per screen; `release` signs out what was never used. */
export class PendingSessions {
  private tokens = new Set<string>();
  /** The session to change the password with. */
  current: string | null = null;
  constructor(private url: string, minted?: string | null, held?: string | null) {
    if (minted) {
      this.tokens.add(minted);
      this.current = minted;
    } else if (held) {
      this.current = held;
    }
  }
  adopt(token: string): void {
    this.tokens.add(token);
    this.current = token;
  }
  /** Did this screen mint `token` (so it may sign it out)? */
  minted(token: string): boolean {
    return this.tokens.has(token);
  }
  /** Signs out every session this screen minted. The server already ended
   *  them all after a successful change; then call `forget` instead. */
  release(): void {
    for (const t of this.tokens) revokeSession(this.url, t);
    this.forget();
  }
  forget(): void {
    this.tokens.clear();
    this.current = null;
  }
}

type SetNewPasswordInput = {
  target: SetPasswordTarget;
  sessions: PendingSessions;
  currentPassword: string;
  newPassword: string;
  policy: PasswordPolicy;
  /** A change was sent before and its answer was lost. */
  maybeChanged?: boolean;
  /** K2 0.46.16: the server lists `companion-password-ticket-v1`. */
  ticketContract?: boolean;
  /** The ticket route a pairing 409 named (0.46.16), else the default. */
  ticketPath?: string | null;
  /** What follows a set password under the 0.46.16 contract: `signin`
   *  (default) or `pair` (the step came from a pairing code). */
  then?: "signin" | "pair";
};

/** Run the change. `sessions.current` may be null (sign in first) or a
 *  session held from before (whose state is unknown: it may be dead). */
export async function setNewPassword(input: SetNewPasswordInput): Promise<SetPasswordOutcome & { sent?: boolean }> {
  return input.ticketContract ? setWithTicketContract(input) : setBeforeTicketContract(input);
}

/** A change sent before lost its answer: if it went through, the temporary
 *  password and every session are gone, and the NEW password signs in.
 *  Tried only then, so a wrong temporary password never costs the login a
 *  second miss. */
async function changedBefore(input: SetNewPasswordInput): Promise<SetPasswordOutcome | null> {
  if (!input.maybeChanged) return null;
  const { target, sessions, newPassword } = input;
  const after = await loginToServer({ url: target.url, username: target.username }, newPassword);
  if (!after.ok) return null;
  if (after.mustChangePassword) {
    revokeSession(target.url, after.token);
    return null;
  }
  return finish(target, sessions, after.token);
}

/** Servers before K2 0.46.16: a 401 is a wrong password, a lock, or a dead
 *  session alike, so a held session is never trusted (sign in fresh). */
async function setBeforeTicketContract(input: SetNewPasswordInput): Promise<SetPasswordOutcome & { sent?: boolean }> {
  const { target, sessions, currentPassword, newPassword } = input;
  let policy = input.policy;

  // 1. A session this screen minted is known good; anything else (a held
  // token from before a restart) is replaced by a fresh sign-in.
  let token = sessions.current && sessions.minted(sessions.current) ? sessions.current : null;
  if (!token) {
    const login = await loginToServer({ url: target.url, username: target.username }, currentPassword);
    if (!login.ok) {
      if (login.kind === "auth") {
        const done = await changedBefore(input);
        if (done) return done;
        return { ok: false, field: "current", error: SET_PASSWORD_COPY.badCurrent };
      }
      return { ok: false, field: "form", error: login.error };
    }
    sessions.adopt(login.token);
    token = login.token;
    // The policy the screen showed may be the default: check the real one.
    const fresh = await fetchPasswordPolicy(target.url, token);
    if (fresh) policy = fresh;
    const weak = firstUnmetRule(newPassword, policy);
    if (weak) return { ok: false, field: "new", error: weak, policy };
  }

  // 2. Change it.
  const changed = await changeServerPassword(target.url, token, currentPassword, newPassword);
  if (!changed.ok) {
    if (changed.kind === "bad-current") {
      const done = await changedBefore(input);
      if (done) return done;
      // Our session may have ended (a lockout, a restart): sign in afresh
      // next time.
      sessions.release();
      return { ok: false, field: "current", error: changed.error, policy };
    }
    if (changed.kind === "weak") return { ok: false, field: "new", error: changed.error, policy };
    return { ok: false, field: "form", error: changed.error, policy, sent: changed.kind === "unreachable" };
  }

  // 3. Every session of this login ended: sign in with the new password.
  return signInWithNew(target, sessions, newPassword);
}

/** How many tickets one attempt mints at most (a dead session or ticket is
 *  replaced once more, never in a loop). */
const MAX_TICKETS = 2;

/** K2 0.46.16 (`companion-password-ticket-v1`). */
async function setWithTicketContract(input: SetNewPasswordInput): Promise<SetPasswordOutcome & { sent?: boolean }> {
  const { target, sessions, currentPassword, newPassword } = input;
  const policy = input.policy;
  // The server answers 400 `password_unchanged`; say it without asking.
  if (newPassword === currentPassword) return { ok: false, field: "new", error: SET_PASSWORD_COPY.unchanged, policy };

  // 1'. The session the screen has, as it is; else a one-use ticket.
  let credential: string | null = sessions.current;
  let viaTicket = false;
  let changePath = DEFAULT_CHANGE_PATH;
  let tickets = 0;
  for (;;) {
    if (!credential) {
      if (tickets >= MAX_TICKETS) return { ok: false, field: "form", error: SET_PASSWORD_COPY.ended, policy };
      tickets += 1;
      const t = await requestPasswordTicket(target.url, target.username, currentPassword, input.ticketPath);
      if (!t.ok) {
        if (t.kind === "bad-current") {
          const done = await changedBefore(input);
          if (done) return done;
          return { ok: false, field: "current", error: t.error, policy };
        }
        if (t.kind === "locked") return { ok: false, field: "form", error: t.error, policy, retryAfterSecs: t.retryAfterSecs };
        return { ok: false, field: "form", error: t.error, policy };
      }
      credential = t.ticket;
      changePath = t.changePath;
      viaTicket = true;
    }

    // 2'. Change it.
    const changed = await changeServerPassword(target.url, credential, currentPassword, newPassword, {
      ticketContract: true,
      path: changePath,
    });
    if (changed.ok) break;
    // A ticket works once: whatever the answer, it is never sent again.
    const usedTicket = viaTicket;
    credential = null;
    viaTicket = false;
    changePath = DEFAULT_CHANGE_PATH;
    if (changed.kind === "ended") {
      // The session (or ticket) is gone: sign out what this screen minted
      // and go on with a fresh ticket.
      if (!usedTicket) sessions.release();
      continue;
    }
    // Every other answer leaves a live session in `sessions` as it is
    // (0.46.16 tells a wrong temporary password from a dead session).
    if (changed.kind === "bad-current") {
      const done = await changedBefore(input);
      if (done) return done;
      return { ok: false, field: "current", error: changed.error, policy };
    }
    if (changed.kind === "locked") {
      return { ok: false, field: "form", error: changed.error, policy, retryAfterSecs: changed.retryAfterSecs };
    }
    if (changed.kind === "weak" || changed.kind === "unchanged") {
      return { ok: false, field: "new", error: changed.error, policy };
    }
    return { ok: false, field: "form", error: changed.error, policy, sent: changed.kind === "unreachable" };
  }

  // 3'. From a pairing code, pairing is next.
  if (input.then === "pair") {
    sessions.forget();
    if (target.serverId) clearMustChange(target.serverId);
    return { ok: false, field: "pair", error: SET_PASSWORD_COPY.pairNextFromCode };
  }
  return signInWithNew(target, sessions, newPassword, true);
}

/** 3. Every session of this login ended: sign in with the new password.
 *  Under 0.46.16 (`pairOnWebOff`) a web-off box's refusal (403
 *  `web_client_disabled`) makes pairing the next step. */
async function signInWithNew(
  target: SetPasswordTarget,
  sessions: PendingSessions,
  newPassword: string,
  pairOnWebOff = false
): Promise<SetPasswordOutcome> {
  const login = await loginToServer({ url: target.url, username: target.username }, newPassword);
  sessions.forget();
  if (!login.ok) {
    if (pairOnWebOff && login.webOff) {
      if (target.serverId) clearMustChange(target.serverId);
      return { ok: false, field: "pair", error: SET_PASSWORD_COPY.pairNext };
    }
    return {
      ok: false,
      field: "signin",
      error: `Your new password is set. Sign in again with it. (${login.error})`,
    };
  }
  if (login.mustChangePassword) {
    revokeSession(target.url, login.token);
    return {
      ok: false,
      field: "signin",
      error: "The server still asks for a new password. Ask the server's owner for help.",
    };
  }
  return finish(target, sessions, login.token);
}

/** 4. Save the session like a sign-in and clear the must-change state. */
async function finish(
  target: SetPasswordTarget,
  sessions: PendingSessions,
  token: string
): Promise<SetPasswordOutcome> {
  sessions.forget();
  const saved = await commitPasswordSession({
    id: target.serverId,
    nickname: target.nickname,
    url: target.url,
    username: target.username,
    token,
    activate: target.activate,
  });
  if (!saved.ok) return { ok: false, field: "form", error: saved.error };
  clearMustChange(saved.id);
  pool.noteRotated(saved.id);
  void pool.check(saved.id);
  return { ok: true, id: saved.id };
}
