import { describe, expect, it } from "vitest";
import { LOGIN_401_TEXT, loginErrorFromStatus } from "./loginError";

const EDGE = "edge-404";

describe("loginErrorFromStatus", () => {
  it("401 is wrong credentials or K2's silent lock: one fixed sentence that says both", () => {
    expect(loginErrorFromStatus(401, "", false, EDGE)).toEqual({ kind: "auth", error: LOGIN_401_TEXT });
    expect(loginErrorFromStatus(401, '{"error":"invalid credentials"}', false, EDGE)).toEqual({
      kind: "auth",
      error: LOGIN_401_TEXT,
    });
    expect(LOGIN_401_TEXT).toMatch(/15 minutes/);
  });

  it("403 is not a password problem and does not reuse the 401 sentence", () => {
    const empty = loginErrorFromStatus(403, "", false, EDGE);
    expect(empty?.kind).toBe("forbidden");
    expect(empty?.error).not.toBe(LOGIN_401_TEXT);
    expect(
      loginErrorFromStatus(403, '{"error":"not allowed"}', false, EDGE)
    ).toEqual({ kind: "forbidden", error: "not allowed" });
  });

  it("404 stays a not-a-K2-server message", () => {
    expect(loginErrorFromStatus(404, "", false, EDGE)?.kind).toBe("not-found");
    expect(loginErrorFromStatus(404, "", true, EDGE)).toEqual({
      kind: "not-found",
      error: EDGE,
    });
  });
});

describe("login 429 (K2 per-IP limit)", () => {
  it("says how long to wait, from Retry-After seconds rounded up", async () => {
    const { loginErrorFromStatus } = await import("./loginError");
    expect(loginErrorFromStatus(429, '{"error":"rate_limited"}', true, EDGE, "300")).toEqual({
      kind: "network",
      error: "Too many attempts. Try again in 5 min.",
    });
    expect(loginErrorFromStatus(429, "", true, EDGE, "61")?.error).toBe("Too many attempts. Try again in 2 min.");
    expect(loginErrorFromStatus(429, "", true, EDGE, null)?.error).toBe("Too many attempts. Try again in 5 min.");
  });
});
