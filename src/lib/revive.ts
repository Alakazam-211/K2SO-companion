// Runtime re-auth for stale server sessions — the companion port of the
// desktop's `lib/remote-session.ts`.
//
// THE BUG THIS FIXES
// Connect-user sessions are IN-MEMORY in the daemon, so a server
// restart/update WIPES them while the app still holds the old token. Every
// authed `/cli/*` call then returns **403** `{"error":"Invalid or missing
// auth token"}` (NOT a 401), and the grid-WS close looks like a network
// drop — so every retry loop used to spin forever on the dead token until
// the app was force-quit and relaunched.
//
// THE FIX
// `reviveServerSession` re-runs the same session-mint flow login uses:
// confirm the session is dead via `GET /cli/auth/whoami` (the daemon's
// token-gate 403 body is byte-identical to a role-denial 403, so only
// whoami can tell "stale token" from "not permitted"), then re-login with
// the remembered password — committing the fresh token into the servers
// store, where `api/client.ts` and the grid-WS pick it up on their next
// attempt.
//
// Guarantees:
//   - SINGLE-FLIGHT per server: concurrent 401/403s share one re-login.
//   - BACKOFF between failed attempts ([1s, 4s, 15s, 30s] cap) so a
//     plaintext login is never hammered in a loop.
//   - `unreachable` (network blip) NEVER drops a token.
//   - No remembered password / password rejected → token dropped + the
//     server marked `signin-required` — the one case that needs the user.

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import {
  useServersStore,
  loginToServer,
  resolvePassword,
  type ServerEntry,
} from "../stores/servers";

/**
 * Classify an HTTP response as a POSSIBLE stale-session rejection — distinct
 * from network errors and from ordinary app errors.
 *
 *   - 401 → always auth.
 *   - 403 → auth ONLY when the body carries the daemon's token-gate message
 *     ("Invalid or missing auth token" from the /cli/* dispatch gate,
 *     "invalid or missing token" from WS upgrades / owner gates). A
 *     role-denial 403 reuses the same copy, which is why a positive match
 *     still goes through the whoami probe before anything is dropped.
 *
 * `body` may be the raw response text or an extracted error message.
 * Pure — import-safe for future vitest.
 */
export function isPossibleAuthFailure(status: number, body: string): boolean {
  if (status === 401) return true;
  if (status !== 403) return false;
  return /invalid or missing (?:auth )?token/i.test(body);
}

/** Outcome of a revival attempt. Callers replay their request ONLY on
 *  'revived' (the token actually changed). */
export type ReviveOutcome =
  /** A fresh session was minted and committed to the store — retry now. */
  | "revived"
  /** whoami says the current session is ALIVE — the 403 that triggered this
   *  was a role denial (or a race with an earlier revival), not staleness. */
  | "still-valid"
  /** No remembered password, or it was rejected — the token was dropped and
   *  the server is marked signin-required. The user must act. */
  | "signin-required"
  /** Network-level failure probing/logging in — the token was NOT touched;
   *  the caller's own reconnect backoff keeps going. */
  | "unreachable"
  /** A recent attempt failed and the backoff window hasn't elapsed. */
  | "cooldown"
  /** Unknown server id — nothing to revive. */
  | "not-applicable";

/** Widening pauses REQUIRED between successive failed revival attempts for
 *  one server: first retry after 1s, then 4s / 15s, capped at 30s. */
export const REVIVE_BACKOFF_MS = [1000, 4000, 15000, 30000];

/** Per-attempt timeout for the whoami staleness probe. */
const WHOAMI_TIMEOUT_MS = 4000;

// Single-flight + backoff bookkeeping, keyed by server id.
const inflight = new Map<string, Promise<ReviveOutcome>>();
const failures = new Map<string, { count: number; lastAt: number }>();

/** The pure backoff rule: given how many attempts have FAILED in a row, how
 *  long after the last one is the next allowed? */
export function reviveBackoffMs(failedCount: number): number {
  if (failedCount <= 0) return 0;
  return REVIVE_BACKOFF_MS[Math.min(failedCount, REVIVE_BACKOFF_MS.length) - 1];
}

/** Probe a server's session via `GET /cli/auth/whoami?token=…`. 401/403 is
 *  an authoritative 'dead'; 2xx 'alive'; anything else (timeout, 5xx) is a
 *  blip — 'unknown', never grounds to drop a token. */
async function probeSession(
  server: ServerEntry,
  token: string
): Promise<"alive" | "dead" | "unknown"> {
  try {
    const res = await Promise.race([
      tauriFetch(
        `${server.url}/cli/auth/whoami?token=${encodeURIComponent(token)}`,
        { method: "GET" }
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("whoami timed out")), WHOAMI_TIMEOUT_MS)
      ),
    ]);
    if (res.status === 401 || res.status === 403) return "dead";
    if (res.ok) return "alive";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Revive a server's connect-session after an auth-classified failure (or on
 * an explicit reconnect gesture with `force`, which bypasses the cooldown
 * but still joins an in-flight attempt).
 *
 * Flow: whoami-confirm dead → resolve the remembered password →
 * `loginToServer` → commit the fresh token. Recovery-state mapping:
 * revived/still-valid → connected, signin-required → signin-required,
 * unreachable → reconnecting (this server only — other servers' states are
 * never touched).
 */
export function reviveServerSession(
  serverId: string,
  opts?: { force?: boolean }
): Promise<ReviveOutcome> {
  const existing = inflight.get(serverId);
  if (existing) return existing;
  const failed = failures.get(serverId);
  if (
    !opts?.force &&
    failed &&
    Date.now() - failed.lastAt < reviveBackoffMs(failed.count)
  ) {
    return Promise.resolve("cooldown");
  }

  const store = useServersStore.getState();
  if (store.servers.some((s) => s.id === serverId)) {
    store.setRecovery(serverId, "reauthenticating");
  }

  const attempt = doRevive(serverId)
    .then((outcome) => {
      if (outcome === "revived" || outcome === "still-valid") {
        failures.delete(serverId);
      } else if (outcome !== "not-applicable") {
        const prev = failures.get(serverId);
        failures.set(serverId, {
          count: (prev?.count ?? 0) + 1,
          lastAt: Date.now(),
        });
      }
      const s = useServersStore.getState();
      if (outcome === "revived" || outcome === "still-valid") {
        s.setRecovery(serverId, "connected");
      } else if (outcome === "signin-required") {
        s.setRecovery(serverId, "signin-required");
      } else if (outcome === "unreachable") {
        s.setRecovery(serverId, "reconnecting");
      }
      return outcome;
    })
    .finally(() => {
      inflight.delete(serverId);
    });
  inflight.set(serverId, attempt);
  return attempt;
}

async function doRevive(serverId: string): Promise<ReviveOutcome> {
  const state = useServersStore.getState();
  const server = state.servers.find((s) => s.id === serverId);
  if (!server) return "not-applicable";

  // Confirm staleness before touching anything: the daemon's token-gate 403
  // body is identical to a role-denial 403, and racing callers may arrive
  // after an earlier revival already fixed the token.
  const token = state.tokens[serverId] ?? "";
  if (token.length > 0) {
    const probe = await probeSession(server, token);
    if (probe === "alive") return "still-valid";
    if (probe === "unknown") return "unreachable";
  }

  const password = await resolvePassword(serverId);
  if (!password) {
    state.clearToken(serverId);
    return "signin-required";
  }

  // The SAME mint flow the add-server page uses (loginToServer already rides
  // withNetRetry for the dead-pooled-socket eviction). The password never
  // leaves this scope.
  const result = await loginToServer(server, password);
  if (result.ok) {
    state.setToken(serverId, result.token);
    return "revived";
  }
  if (result.kind === "auth") {
    // The remembered password itself is rejected — only the user can fix
    // this. Drop the token so the UI surfaces sign-in instead of retrying.
    state.clearToken(serverId);
    return "signin-required";
  }
  return "unreachable";
}

/** Explicit user gesture: make a server active elsewhere, then call this to
 *  (re)connect it — probes/re-logs-in as needed, bypassing the cooldown. */
export function connectServer(serverId: string): Promise<ReviveOutcome> {
  return reviveServerSession(serverId, { force: true });
}

/** Test-only: clear the single-flight + backoff maps. */
export function __resetReviveForTests(): void {
  inflight.clear();
  failures.clear();
}
