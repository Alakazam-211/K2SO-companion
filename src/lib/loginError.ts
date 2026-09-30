import { apiErrorText } from "./apiError";

/** 401 = credentials. 403 = not a password problem. Do not collapse them. */
export type LoginFailKind = "auth" | "forbidden" | "not-found" | "network";

export function loginErrorFromStatus(
  status: number,
  bodyText: string,
  viaEdge: boolean,
  edge404: string
): { kind: LoginFailKind; error: string } | null {
  if (status === 401) {
    return {
      kind: "auth",
      error: apiErrorText(bodyText, "Invalid username or password"),
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
