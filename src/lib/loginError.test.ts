import { describe, expect, it } from "vitest";
import { loginErrorFromStatus } from "./loginError";

const EDGE = "edge-404";

describe("loginErrorFromStatus", () => {
  it("401 is wrong credentials, and keeps the server string when present", () => {
    expect(loginErrorFromStatus(401, "", false, EDGE)).toEqual({
      kind: "auth",
      error: "Invalid username or password",
    });
    expect(
      loginErrorFromStatus(401, '{"error":"no such user"}', false, EDGE)
    ).toEqual({ kind: "auth", error: "no such user" });
  });

  it("403 is not a password problem and does not reuse the 401 sentence", () => {
    const empty = loginErrorFromStatus(403, "", false, EDGE);
    expect(empty?.kind).toBe("forbidden");
    expect(empty?.error).not.toBe("Invalid username or password");
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
