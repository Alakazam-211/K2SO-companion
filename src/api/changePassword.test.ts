// "Set your new password": the rules mirror K2's `validate_password`
// exactly, and the change-password answers map to the screen's words.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));

import {
  changeServerPassword,
  DEFAULT_PASSWORD_POLICY,
  fetchPasswordPolicy,
  firstUnmetRule,
  parsePolicy,
  passwordRules,
  SET_PASSWORD_COPY,
  type PasswordPolicy,
} from "./changePassword";

const ALL: PasswordPolicy = { minLength: 10, requireSpecial: true, requireNumber: true, requireUppercase: true };

function resp(status: number, body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
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
