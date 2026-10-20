import { apiErrorText } from "./apiError";

/** 401 = credentials. 403 = not a password problem. Do not collapse them. */
/** /cli/auth/login 401: wrong credentials OR a temporary per-username lock. */
export const LOGIN_401_TEXT =
  "Wrong username or password. After a few misses K2 pauses sign-in for this username for 15 minutes, so if you're sure it's right, wait and try again.";

export type LoginFailKind = "auth" | "forbidden" | "not-found" | "network";

/** /cli/auth/login 429: K2's per-IP limit (5 sign-in attempts per 5 min
 *  from one network), `Retry-After` in seconds. Rounded up to minutes;
 *  5 when the header is missing. */
export function loginRateLimitText(retryAfter: string | null | undefined): string {
  const secs = Number.parseInt(String(retryAfter ?? ""), 10);
  const mins = Number.isFinite(secs) && secs > 0 ? Math.ceil(secs / 60) : 5;
  return `Too many attempts. Try again in ${mins} min.`;
}

export function loginErrorFromStatus(
  status: number,
  bodyText: string,
  viaEdge: boolean,
  edge404: string,
  retryAfter?: string | null
): { kind: LoginFailKind; error: string } | null {
  if (status === 429) {
    return { kind: "network", error: loginRateLimitText(retryAfter) };
  }
  if (status === 401) {
    // K2 answers a locked username (3 misses → 15 min) with the same 401
    // as a wrong password, on purpose: say both.
    return {
      kind: "auth",
      error: LOGIN_401_TEXT,
    };
  }
  if (status === 403) {
    return {
      kind: "forbidden",
      error: apiErrorText(
        bodyText,
        "Not allowed. Your password is not the problem."
      ),
    };
  }
  if (status === 404) {
    return {
      kind: "not-found",
      error: viaEdge
        ? edge404
        : "Server returned 404. It may not be a K2 server.",
    };
  }
  if (status >= 400) {
    return {
      kind: "network",
      error: apiErrorText(bodyText, `Login failed (HTTP ${status})`),
    };
  }
  return null;
}
