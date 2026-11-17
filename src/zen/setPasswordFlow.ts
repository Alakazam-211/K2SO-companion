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
// The passwords are arguments only: never stored, never logged.

import {
  changeServerPassword,
  fetchPasswordPolicy,
  firstUnmetRule,
  SET_PASSWORD_COPY,
  type PasswordPolicy,
} from "../api/changePassword";
import { clearMustChange } from "../api/scope";
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
       *  the password changed but signing in with it didn't work. */
      field: "current" | "new" | "signin" | "form";
      error: string;
      /** A fresher policy than the screen had, when one was read. */
      policy?: PasswordPolicy;
    };

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

/** Run the change. `sessions.current` may be null (sign in first) or a
 *  session held from before (whose state is unknown: it may be dead). */
export async function setNewPassword(input: {
  target: SetPasswordTarget;
  sessions: PendingSessions;
  currentPassword: string;
  newPassword: string;
  policy: PasswordPolicy;
  /** A change was sent before and its answer was lost. */
  maybeChanged?: boolean;
}): Promise<SetPasswordOutcome & { sent?: boolean }> {
  const { target, sessions, currentPassword, newPassword } = input;
  let policy = input.policy;

  // A change sent before lost its answer: if it went through, the
  // temporary password and every session are gone, and the NEW password
  // signs in. Tried only then, so a wrong temporary password never costs
  // the login a second miss.
  const changedBefore = async (): Promise<SetPasswordOutcome | null> => {
    if (!input.maybeChanged) return null;
    const after = await loginToServer({ url: target.url, username: target.username }, newPassword);
    if (!after.ok) return null;
    if (after.mustChangePassword) {
      revokeSession(target.url, after.token);
      return null;
    }
    return finish(target, sessions, after.token);
  };

  // 1. A session this screen minted is known good; anything else (a held
  // token from before a restart) is replaced by a fresh sign-in.
  let token = sessions.current && sessions.minted(sessions.current) ? sessions.current : null;
  if (!token) {
    const login = await loginToServer({ url: target.url, username: target.username }, currentPassword);
    if (!login.ok) {
      if (login.kind === "auth") {
        const done = await changedBefore();
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
      const done = await changedBefore();
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
  const login = await loginToServer({ url: target.url, username: target.username }, newPassword);
  sessions.forget();
  if (!login.ok) {
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
