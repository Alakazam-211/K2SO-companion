// "Set your new password": the rules mirror K2's `validate_password`
// exactly, and the change-password answers map to the screen's words.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));

import {
  changeServerPassword,
  DEFAULT_CHANGE_PATH,
  DEFAULT_TICKET_PATH,
  FEATURE_PASSWORD_TICKET,
  lockedButtonText,
  lockedText,
  requestPasswordTicket,
  safeCliPath,
  serverListsPasswordTicket,
  DEFAULT_PASSWORD_POLICY,
  fetchPasswordPolicy,
  firstUnmetRule,
  parsePolicy,
  passwordRules,
  SET_PASSWORD_COPY,
  type PasswordPolicy,
} from "./changePassword";

const ALL: PasswordPolicy = { minLength: 10, requireSpecial: true, requireNumber: true, requireUppercase: true };

function resp(status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  };
}

beforeEach(() => fetchMock.mockReset());

describe("password rules (K2 connect_users::validate_password)", () => {
  it("the default policy is length 8 only", () => {
    expect(passwordRules("", DEFAULT_PASSWORD_POLICY).map((r) => r.id)).toEqual(["length"]);
    expect(firstUnmetRule("1234567", DEFAULT_PASSWORD_POLICY)).toBe("Password must be at least 8 characters.");
    expect(firstUnmetRule("12345678", DEFAULT_PASSWORD_POLICY)).toBeNull();
  });

  it("lists only the active rules, in the server's order, met or not", () => {
    expect(passwordRules("abc", ALL).map((r) => [r.id, r.met])).toEqual([
      ["length", false],
      ["special", false],
      ["number", false],
      ["uppercase", false],
    ]);
    expect(passwordRules("Abcdefgh1!", ALL).every((r) => r.met)).toBe(true);
    expect(passwordRules("x", { ...DEFAULT_PASSWORD_POLICY, requireNumber: true }).map((r) => r.id)).toEqual([
      "length",
      "number",
    ]);
  });

  it("reports the FIRST unmet rule with the server's own words", () => {
    expect(firstUnmetRule("short", ALL)).toBe("Password must be at least 10 characters.");
    expect(firstUnmetRule("abcdefghij", ALL)).toBe("Password must include a special character.");
    expect(firstUnmetRule("abcdefghi!", ALL)).toBe("Password must include a number.");
    expect(firstUnmetRule("abcdefgh1!", ALL)).toBe("Password must include an uppercase letter.");
  });

  it("counts characters, not UTF-16 units (Rust chars().count())", () => {
    const p = { ...DEFAULT_PASSWORD_POLICY, minLength: 4 };
    // Three emoji are six UTF-16 units but three characters.
    expect(firstUnmetRule("😀😀😀", p)).toBe("Password must be at least 4 characters.");
    expect(firstUnmetRule("😀😀😀😀", p)).toBeNull();
  });

  it("special, number and uppercase follow Rust's char classes", () => {
    const special = { ...DEFAULT_PASSWORD_POLICY, minLength: 1, requireSpecial: true };
    // A letter in another script is alphanumeric, so not special.
    expect(firstUnmetRule("passwordé", special)).toBe("Password must include a special character.");
    expect(firstUnmetRule("密码", special)).toBe("Password must include a special character.");
    expect(firstUnmetRule("pass word", special)).toBeNull();
    expect(firstUnmetRule("pass😀", special)).toBeNull();
    const number = { ...DEFAULT_PASSWORD_POLICY, minLength: 1, requireNumber: true };
    // Only 0-9 count (is_ascii_digit), not other scripts' digits.
    expect(firstUnmetRule("abc٣", number)).toBe("Password must include a number.");
    expect(firstUnmetRule("abc3", number)).toBeNull();
    const upper = { ...DEFAULT_PASSWORD_POLICY, minLength: 1, requireUppercase: true };
    expect(firstUnmetRule("abc", upper)).toBe("Password must include an uppercase letter.");
    expect(firstUnmetRule("abcÉ", upper)).toBeNull();
  });

  it("parses the policy body and rejects a malformed one", () => {
    expect(parsePolicy({ minLength: 12, requireNumber: true })).toEqual({
      minLength: 12,
      requireSpecial: false,
      requireNumber: true,
      requireUppercase: false,
    });
    expect(parsePolicy({ requireNumber: true })).toBeNull();
    expect(parsePolicy(null)).toBeNull();
  });
});

describe("fetchPasswordPolicy", () => {
  it("reads GET /cli/users/policy on the server's own address with the session as Bearer", async () => {
    fetchMock.mockResolvedValue(resp(200, ALL));
    expect(await fetchPasswordPolicy("https://box.k2.dev/", "tok")).toEqual(ALL);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://box.k2.dev/cli/users/policy");
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("is null without a token, on an error, or offline", async () => {
    expect(await fetchPasswordPolicy("https://box.k2.dev", null)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(resp(403, { error: "invalid or missing token" }));
    expect(await fetchPasswordPolicy("https://box.k2.dev", "t")).toBeNull();
    fetchMock.mockRejectedValueOnce(new Error("Load failed"));
    expect(await fetchPasswordPolicy("https://box.k2.dev", "t")).toBeNull();
  });
});

describe("changeServerPassword", () => {
  it("POSTs {currentPassword,newPassword} as the session to the server itself", async () => {
    fetchMock.mockResolvedValue(resp(200, { success: true }));
    expect(await changeServerPassword("https://box.k2.dev", "restricted", "temp-pass", "My-new-pass1")).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://box.k2.dev/cli/auth/change-password");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer restricted");
    expect(JSON.parse(init.body)).toEqual({ currentPassword: "temp-pass", newPassword: "My-new-pass1" });
    // Never through the login edge, never a k2skn_ pass.
    expect(String(url)).not.toContain("app.k2.dev");
    expect(init.body).not.toContain("k2skn_");
  });

  it("400: the server's first unmet rule, verbatim", async () => {
    fetchMock.mockResolvedValue(resp(400, { error: "Password must include a number." }));
    expect(await changeServerPassword("https://box.k2.dev", "t", "a", "b")).toEqual({
      ok: false,
      kind: "weak",
      error: "Password must include a number.",
    });
    fetchMock.mockResolvedValue(resp(400, { error: "invalid request" }));
    expect(await changeServerPassword("https://box.k2.dev", "t", "a", "b")).toMatchObject({
      kind: "weak",
      error: SET_PASSWORD_COPY.weakFallback,
    });
  });

  it("401: wrong temporary password or locked, said both ways", async () => {
    fetchMock.mockResolvedValue(resp(401, { error: "unauthorized" }));
    expect(await changeServerPassword("https://box.k2.dev", "t", "a", "b")).toEqual({
      ok: false,
      kind: "bad-current",
      error: "Temporary password incorrect, or too many attempts. Try again later.",
    });
  });

  it("403 password_fixed: the server's message", async () => {
    fetchMock.mockResolvedValue(
      resp(403, { error: "password_fixed", message: "This login's password is fixed: only the server's owner or an Admin changes it." })
    );
    expect(await changeServerPassword("https://box.k2.dev", "t", "a", "b")).toMatchObject({
      kind: "fixed",
      error: "This login's password is fixed: only the server's owner or an Admin changes it.",
    });
  });

  it("no answer: unreachable, not retried (a retry would read as a wrong password)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Load failed"));
    expect(await changeServerPassword("https://box.k2.dev", "t", "a", "b")).toMatchObject({
      ok: false,
      kind: "unreachable",
      error: "Couldn't reach box.k2.dev to set the password. Try again.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("other errors: the daemon's text", async () => {
    fetchMock.mockResolvedValue(resp(500, { error: { code: "boom", hint: "the store is busy" } }));
    expect(await changeServerPassword("https://box.k2.dev", "t", "a", "b")).toMatchObject({
      kind: "server",
      error: "the store is busy",
    });
  });
});

// ─── K2 0.46.16: companion-password-ticket-v1 ───

const TICKET = `k2pct_${"ab".repeat(32)}`;

describe("the 0.46.16 checklist rule and words", () => {
  it("lists 'Different from your temporary password' only when asked, last", () => {
    expect(passwordRules("abcdefgh", DEFAULT_PASSWORD_POLICY).map((r) => r.id)).toEqual(["length"]);
    const rules = passwordRules("Temp-pass-1", DEFAULT_PASSWORD_POLICY, { differentFrom: "Temp-pass-1" });
    expect(rules.map((r) => [r.id, r.met])).toEqual([
      ["length", true],
      ["different", false],
    ]);
    expect(rules[1].label).toBe("Different from your temporary password");
    expect(passwordRules("Another-1", DEFAULT_PASSWORD_POLICY, { differentFrom: "Temp-pass-1" })[1].met).toBe(true);
    // Unknown temporary password (not typed yet): met once anything is typed.
    expect(passwordRules("", DEFAULT_PASSWORD_POLICY, { differentFrom: "" })[1].met).toBe(false);
    expect(firstUnmetRule("Temp-pass-1", DEFAULT_PASSWORD_POLICY, { differentFrom: "Temp-pass-1" })).toBe(
      "Choose a password different from your temporary one."
    );
  });

  it("the lock reads in minutes, under a minute in seconds; the button counts m:ss", () => {
    expect(lockedText(900)).toBe("Too many tries. Try again in 15 minutes.");
    expect(lockedText(61)).toBe("Too many tries. Try again in 2 minutes.");
    expect(lockedText(60)).toBe("Too many tries. Try again in 1 minute.");
    expect(lockedText(42)).toBe("Too many tries. Try again in 42 seconds.");
    expect(lockedText(1)).toBe("Too many tries. Try again in 1 second.");
    expect(lockedButtonText(900)).toBe("Try again in 15:00");
    expect(lockedButtonText(65.2)).toBe("Try again in 1:06");
    expect(lockedButtonText(9)).toBe("Try again in 0:09");
  });

  it("a route the server names must be a plain /cli/ path", () => {
    expect(safeCliPath("/cli/auth/device/password-ticket", "x")).toBe("/cli/auth/device/password-ticket");
    expect(safeCliPath("https://evil.example/cli/x", "x")).toBe("x");
    expect(safeCliPath("//evil.example/cli/x", "x")).toBe("x");
    expect(safeCliPath("/cli/../x", "x")).toBe("x");
    expect(safeCliPath(undefined, DEFAULT_CHANGE_PATH)).toBe("/cli/auth/change-password");
  });
});

describe("serverListsPasswordTicket (/boot-status features)", () => {
  it("true only when the box lists companion-password-ticket-v1", async () => {
    fetchMock.mockResolvedValueOnce(resp(200, { view: "compat", features: ["companion-pairing-v1", FEATURE_PASSWORD_TICKET] }));
    expect(await serverListsPasswordTicket("https://box.k2.dev/")).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://box.k2.dev/boot-status");
    fetchMock.mockResolvedValueOnce(resp(200, { view: "compat", features: ["companion-pairing-v1"] }));
    expect(await serverListsPasswordTicket("https://box.k2.dev")).toBe(false);
    // A stranger's view without the list, an error, offline: unknown → false.
    fetchMock.mockResolvedValueOnce(resp(200, { view: "public", phase: "ready" }));
    expect(await serverListsPasswordTicket("https://box.k2.dev")).toBe(false);
    fetchMock.mockResolvedValueOnce(resp(404, ""));
    expect(await serverListsPasswordTicket("https://box.k2.dev")).toBe(false);
    fetchMock.mockRejectedValueOnce(new Error("Load failed"));
    expect(await serverListsPasswordTicket("https://box.k2.dev")).toBe(false);
  });

  it("sends a held session as Bearer, once more without it on a 401/403", async () => {
    fetchMock.mockResolvedValueOnce(resp(401, { error: "unauthorized" }));
    fetchMock.mockResolvedValueOnce(resp(200, { features: [FEATURE_PASSWORD_TICKET] }));
    expect(await serverListsPasswordTicket("https://box.k2.dev", "held")).toBe(true);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer held");
    expect(fetchMock.mock.calls[1][1].headers).toBeUndefined();
  });
});

describe("requestPasswordTicket", () => {
  it("POSTs {username,password} with no token to the box's own address", async () => {
    fetchMock.mockResolvedValue(
      resp(200, {
        ok: true,
        ticket: TICKET,
        user: "ada",
        expiresAt: "2026-11-17T12:10:00Z",
        expiresInSecs: 600,
        changePath: "/cli/auth/change-password",
      })
    );
    expect(await requestPasswordTicket("https://box.k2.dev/", "ada", "temp")).toEqual({
      ok: true,
      ticket: TICKET,
      changePath: "/cli/auth/change-password",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://box.k2.dev${DEFAULT_TICKET_PATH}`);
    expect(String(url)).not.toContain("app.k2.dev");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.headers.Cookie).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({ username: "ada", password: "temp" });
  });

  it("uses the route a pairing 409 named; a changePath that isn't /cli/ falls back", async () => {
    fetchMock.mockResolvedValue(resp(200, { ok: true, ticket: TICKET, changePath: "https://evil.example/x" }));
    const r = await requestPasswordTicket("https://box.k2.dev", "ada", "temp", "/cli/auth/device/password-ticket2");
    expect(fetchMock.mock.calls[0][0]).toBe("https://box.k2.dev/cli/auth/device/password-ticket2");
    expect(r).toMatchObject({ ok: true, changePath: "/cli/auth/change-password" });
  });

  it("401 password_invalid: Temporary password incorrect.", async () => {
    fetchMock.mockResolvedValue(resp(401, { ok: false, error: { code: "password_invalid", hint: "x" } }));
    expect(await requestPasswordTicket("https://box.k2.dev", "ada", "nope")).toEqual({
      ok: false,
      kind: "bad-current",
      error: "Temporary password incorrect.",
    });
  });

  it("423 locked: the body's retryAfterSecs, else Retry-After, else 15 minutes", async () => {
    fetchMock.mockResolvedValueOnce(resp(423, { ok: false, error: { code: "locked", retryAfterSecs: 540 } }, { "retry-after": "540" }));
    expect(await requestPasswordTicket("https://box.k2.dev", "ada", "x")).toEqual({
      ok: false,
      kind: "locked",
      error: "Too many tries. Try again in 9 minutes.",
      retryAfterSecs: 540,
    });
    fetchMock.mockResolvedValueOnce(resp(423, { ok: false, error: { code: "locked" } }, { "retry-after": "120" }));
    expect(await requestPasswordTicket("https://box.k2.dev", "ada", "x")).toMatchObject({ kind: "locked", retryAfterSecs: 120 });
    fetchMock.mockResolvedValueOnce(resp(423, { ok: false, error: { code: "locked" } }));
    expect(await requestPasswordTicket("https://box.k2.dev", "ada", "x")).toMatchObject({ kind: "locked", retryAfterSecs: 900 });
  });

  it("429, 403 and 400 are refusals; 429 with Retry-After counts down", async () => {
    fetchMock.mockResolvedValueOnce(resp(429, { ok: false, error: { code: "rate_limited" } }));
    expect(await requestPasswordTicket("https://box.k2.dev", "ada", "x")).toEqual({
      ok: false,
      kind: "refused",
      error: "Too many tries. Wait a minute and try again.",
    });
    fetchMock.mockResolvedValueOnce(resp(429, { ok: false, error: { code: "rate_limited" } }, { "retry-after": "30" }));
    expect(await requestPasswordTicket("https://box.k2.dev", "ada", "x")).toMatchObject({ kind: "locked", retryAfterSecs: 30 });
    fetchMock.mockResolvedValueOnce(
      resp(403, { ok: false, error: { code: "device_pairing_not_from_browser", hint: "use the K2 app" } })
    );
    expect(await requestPasswordTicket("https://box.k2.dev", "ada", "x")).toMatchObject({ kind: "refused" });
    fetchMock.mockResolvedValueOnce(resp(400, { ok: false, error: { code: "usage", hint: "username and password are required" } }));
    expect(await requestPasswordTicket("https://box.k2.dev", "", "x")).toMatchObject({ kind: "refused" });
  });

  it("no answer, or an answer with no ticket", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Load failed"));
    expect(await requestPasswordTicket("https://box.k2.dev", "ada", "x")).toMatchObject({ kind: "unreachable" });
    fetchMock.mockResolvedValueOnce(resp(200, { ok: true }));
    expect(await requestPasswordTicket("https://box.k2.dev", "ada", "x")).toMatchObject({ ok: false, kind: "server" });
  });
});

describe("changeServerPassword under the 0.46.16 contract", () => {
  const v2 = { ticketContract: true };

  it("a ticket goes as Bearer on the changePath, never as a cookie", async () => {
    fetchMock.mockResolvedValue(resp(200, { success: true }));
    expect(
      await changeServerPassword("https://box.k2.dev", TICKET, "temp", "New-pass-1", { ...v2, path: "/cli/auth/change-password" })
    ).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://box.k2.dev/cli/auth/change-password");
    expect(init.headers.Authorization).toBe(`Bearer ${TICKET}`);
    expect(init.headers.Cookie).toBeUndefined();
    expect(init.credentials).toBeUndefined();
  });

  it("401 unauthorized: the session or ticket ended (not a wrong password)", async () => {
    fetchMock.mockResolvedValue(resp(401, { error: "unauthorized" }));
    expect(await changeServerPassword("https://box.k2.dev", "t", "a", "b", v2)).toEqual({
      ok: false,
      kind: "ended",
      error: SET_PASSWORD_COPY.ended,
    });
  });

  it("401 current_password_wrong: Temporary password incorrect.", async () => {
    fetchMock.mockResolvedValue(resp(401, { error: "current_password_wrong" }));
    expect(await changeServerPassword("https://box.k2.dev", "t", "a", "b", v2)).toEqual({
      ok: false,
      kind: "bad-current",
      error: "Temporary password incorrect.",
    });
  });

  it("423 locked: Too many tries, with the wait", async () => {
    fetchMock.mockResolvedValue(resp(423, { error: "locked", retryAfterSecs: 900 }, { "retry-after": "900" }));
    expect(await changeServerPassword("https://box.k2.dev", "t", "a", "b", v2)).toEqual({
      ok: false,
      kind: "locked",
      error: "Too many tries. Try again in 15 minutes.",
      retryAfterSecs: 900,
    });
    fetchMock.mockResolvedValue(resp(423, { error: "locked" }, { "retry-after": "300" }));
    expect(await changeServerPassword("https://box.k2.dev", "t", "a", "b", v2)).toMatchObject({ retryAfterSecs: 300 });
  });

  it("400 password_unchanged; other 400s and 403 password_fixed as before", async () => {
    fetchMock.mockResolvedValue(resp(400, { error: "password_unchanged" }));
    expect(await changeServerPassword("https://box.k2.dev", "t", "a", "a", v2)).toEqual({
      ok: false,
      kind: "unchanged",
      error: "Choose a password different from your temporary one.",
    });
    fetchMock.mockResolvedValue(resp(400, { error: "Password must include a number." }));
    expect(await changeServerPassword("https://box.k2.dev", "t", "a", "b", v2)).toMatchObject({
      kind: "weak",
      error: "Password must include a number.",
    });
    fetchMock.mockResolvedValue(resp(403, { error: "password_fixed", message: "Fixed." }));
    expect(await changeServerPassword("https://box.k2.dev", "t", "a", "b", v2)).toMatchObject({ kind: "fixed", error: "Fixed." });
  });

  it("without the contract a 401 still reads the old way, whatever its body", async () => {
    fetchMock.mockResolvedValue(resp(401, { error: "current_password_wrong" }));
    expect(await changeServerPassword("https://box.k2.dev", "t", "a", "b")).toMatchObject({
      kind: "bad-current",
      error: "Temporary password incorrect, or too many attempts. Try again later.",
    });
  });
});
