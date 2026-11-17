// @vitest-environment jsdom
// "Set your new password" (K2 Cloud S1): a login with a temporary password
// must choose its own. The phone shows the step right after such a sign-in
// (reusing the password just typed), from a "Change password on {server}"
// row (asking for it), and from a pairing code refused with
// `password_change_required`. All against a fake server: no real network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => {
    throw new Error("no tauri");
  }),
}));

import { useServersStore } from "../stores/servers";
import { blankEntry, pool } from "./multi/pool";
import { resolveRowStatus, rowFailure } from "./multi/rowStatus";
import { OverlayAddServer } from "./OverlayAddServer";
import { useZenStore } from "./zenStore";

const TEMP = "Temp-pass-0001";
const NEW = "Brand-new-pass-42";

type Answer = { status: number; body: unknown };

/** A K2 daemon's login routes, as `connect_users_routes.rs` answers them. */
const srv = {
  password: TEMP,
  must: true,
  policy: { minLength: 8, requireSpecial: false, requireNumber: false, requireUppercase: false },
  live: new Set<string>(),
  n: 0,
  /** Forces the next change-password answer. */
  changeAnswer: null as Answer | null,
  /** Forces the pairing check answer. */
  pairCheck: null as Answer | null,
};

function resp(status: number, body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
    headers: { get: () => null },
  };
}

const calls = (path: string) =>
  fetchMock.mock.calls.filter(([u]) => new URL(String(u)).pathname === path);

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  Object.assign(srv, {
    password: TEMP,
    must: true,
    policy: { minLength: 8, requireSpecial: false, requireNumber: false, requireUppercase: false },
    live: new Set<string>(),
    n: 0,
    changeAnswer: null,
    pairCheck: null,
  });
  fetchMock.mockImplementation(async (url: string, init: { body?: string; headers?: Record<string, string> } = {}) => {
    const u = new URL(String(url));
    const body = init.body ? (JSON.parse(init.body) as Record<string, string>) : {};
    const bearer = (init.headers?.Authorization ?? "").replace(/^Bearer /, "");
    switch (u.pathname) {
      case "/cli/auth/login": {
        if (body.password !== srv.password) return resp(401, { error: "invalid username or password" });
        const token = `sess-${++srv.n}`;
        srv.live.add(token);
        return resp(200, { token, username: body.username, expiresAt: "2026-12-17T00:00:00Z", mustChangePassword: srv.must });
      }
      case "/cli/users/policy":
        return resp(200, srv.policy);
      case "/cli/auth/change-password": {
        if (srv.changeAnswer) {
          const a = srv.changeAnswer;
          srv.changeAnswer = null;
          return resp(a.status, a.body);
        }
        if (!srv.live.has(bearer) || body.currentPassword !== srv.password) return resp(401, { error: "unauthorized" });
        if ([...body.newPassword].length < srv.policy.minLength) {
          return resp(400, { error: `Password must be at least ${srv.policy.minLength} characters.` });
        }
        srv.password = body.newPassword;
        srv.must = false;
        srv.live.clear(); // every session of the login ends
        return resp(200, { success: true });
      }
      case "/cli/auth/logout":
        srv.live.delete(bearer);
        return resp(200, { success: true });
      case "/cli/auth/device/pair/check":
        return srv.pairCheck ? resp(srv.pairCheck.status, srv.pairCheck.body) : resp(404, "");
      default:
        return resp(404, "");
    }
  });
  useServersStore.setState({ hydrated: true, servers: [], tokens: {}, activeServerId: null, recovery: {} });
  pool.store.setState({ entries: {} });
  useZenStore.setState({ hydrateAgents: vi.fn(async () => {}) } as never);
});
afterEach(() => cleanup());

const type = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });
const submit = () => act(async () => void fireEvent.submit(screen.getByTestId("set-password")));

/** Every byte the phone keeps on disk (the store's localStorage fallback). */
function storedText(): string {
  let out = "";
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    out += `${k}=${localStorage.getItem(k)}\n`;
  }
  return out + JSON.stringify(useServersStore.getState());
}

async function signInWithTemp() {
  fireEvent.change(screen.getByPlaceholderText("your-name.k2.dev"), { target: { value: "box.k2.dev" } });
  fireEvent.change(screen.getByPlaceholderText("Username"), { target: { value: "ada" } });
  fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: TEMP } });
  await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Connect & save" })));
  await screen.findByTestId("set-password");
}

describe("after a sign-in with a temporary password", () => {
  it("shows Set your new password, saves nothing yet, and reuses the password just typed", async () => {
    render(<OverlayAddServer onCancel={() => {}} />);
    await signInWithTemp();
    expect(screen.getByRole("heading", { name: "Set your new password" })).not.toBeNull();
    expect(screen.getByText("Your server admin gave you a temporary password. Choose a new one to continue.")).not.toBeNull();
    expect(screen.getByTestId("set-password-login").textContent).toBe("ada");
    // The temporary password isn't asked for again.
    expect(screen.queryByTestId("set-password-current")).toBeNull();
    // The restricted session is not saved: no server, no token.
    expect(useServersStore.getState().servers).toEqual([]);
    expect(useServersStore.getState().tokens).toEqual({});
    // Labelled fields with the right autocomplete.
    const next = screen.getByTestId("set-password-new") as HTMLInputElement;
    expect(next.closest("label")?.textContent).toContain("New password");
    const confirm = screen.getByLabelText("Confirm new password") as HTMLInputElement;
    expect(next.getAttribute("autocomplete")).toBe("new-password");
    expect(confirm.getAttribute("autocomplete")).toBe("new-password");
    expect(next.type).toBe("password");
  });

  it("shows the server's rules live as the person types", async () => {
    srv.policy = { minLength: 10, requireSpecial: false, requireNumber: true, requireUppercase: true };
    render(<OverlayAddServer onCancel={() => {}} />);
    await signInWithTemp();
    await waitFor(() => expect(document.querySelector('[data-rule="number"]')).not.toBeNull());
    const met = (id: string) => document.querySelector(`[data-rule="${id}"]`)?.getAttribute("data-met");
    expect(screen.getByText("At least 10 characters")).not.toBeNull();
    expect([met("length"), met("number"), met("uppercase")]).toEqual(["false", "false", "false"]);
    type("set-password-new", "abcdefghij");
    expect([met("length"), met("number"), met("uppercase")]).toEqual(["true", "false", "false"]);
    type("set-password-new", "Abcdefghi1");
    expect([met("length"), met("number"), met("uppercase")]).toEqual(["true", "true", "true"]);
    // The match line shows once the confirm is typed.
    expect(met("match")).toBeUndefined();
    type("set-password-confirm", "Abcdefghi");
    expect(met("match")).toBe("false");
    type("set-password-confirm", "Abcdefghi1");
    expect(met("match")).toBe("true");
  });

  it("one toggle shows and hides the passwords", async () => {
    render(<OverlayAddServer onCancel={() => {}} />);
    await signInWithTemp();
    const next = screen.getByTestId("set-password-new") as HTMLInputElement;
    const confirm = screen.getByTestId("set-password-confirm") as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: "Show passwords" }));
    expect([next.type, confirm.type]).toEqual(["text", "text"]);
    fireEvent.click(screen.getByRole("button", { name: "Hide passwords" }));
    expect([next.type, confirm.type]).toEqual(["password", "password"]);
  });

  it("a mismatch or a too-short password never reaches the server", async () => {
    render(<OverlayAddServer onCancel={() => {}} />);
    await signInWithTemp();
    type("set-password-new", "short");
    type("set-password-confirm", "short");
    await submit();
    expect(screen.getByTestId("set-password-error").textContent).toBe("Password must be at least 8 characters.");
    type("set-password-new", NEW);
    type("set-password-confirm", `${NEW}x`);
    await submit();
    expect(screen.getByTestId("set-password-error").textContent).toBe("New passwords do not match.");
    expect(calls("/cli/auth/change-password")).toHaveLength(0);
  });

  it("shows the server's weak-password and wrong-password errors inline", async () => {
    render(<OverlayAddServer onCancel={() => {}} />);
    await signInWithTemp();
    type("set-password-new", NEW);
    type("set-password-confirm", NEW);
    srv.changeAnswer = { status: 400, body: { error: "Password must include a special character." } };
    await submit();
    expect(screen.getByTestId("set-password-error").textContent).toBe("Password must include a special character.");

    srv.changeAnswer = { status: 401, body: { error: "unauthorized" } };
    await submit();
    expect(screen.getByTestId("set-password-error").textContent).toBe(
      "Temporary password incorrect, or too many attempts. Try again later."
    );
    // Now it asks for the temporary password, filled with what was typed.
    expect((screen.getByTestId("set-password-current") as HTMLInputElement).value).toBe(TEMP);
    expect(screen.getByLabelText("Temporary password").getAttribute("autocomplete")).toBe("current-password");
    expect(useServersStore.getState().servers).toEqual([]);
  });

  it("on success: signs in with the new password, saves that session like a sign-in, and goes on", async () => {
    const onSaved = vi.fn();
    const onSignedIn = vi.fn();
    render(<OverlayAddServer onCancel={() => {}} onSaved={onSaved} onSignedIn={onSignedIn} />);
    await signInWithTemp();
    type("set-password-new", NEW);
    type("set-password-confirm", NEW);
    await submit();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const change = calls("/cli/auth/change-password");
    expect(change).toHaveLength(1);
    expect(String(change[0][0])).toBe("https://box.k2.dev/cli/auth/change-password");
    expect(change[0][1].headers.Authorization).toBe("Bearer sess-1");
    expect(JSON.parse(change[0][1].body)).toEqual({ currentPassword: TEMP, newPassword: NEW });
    // The server ended sess-1; the phone signed in again with the new one.
    const logins = calls("/cli/auth/login");
    expect(logins.map(([, init]) => JSON.parse(init.body).password)).toEqual([TEMP, NEW]);
    expect(String(logins[1][0])).toBe("https://box.app.k2.dev/cli/auth/login");

    const s = useServersStore.getState();
    expect(s.servers).toHaveLength(1);
    const id = s.servers[0].id;
    expect(s.servers[0]).toMatchObject({ url: "https://box.k2.dev", username: "ada", rememberPassword: false });
    expect(s.servers[0].auth).toBeUndefined();
    expect(s.tokens[id]).toBe("sess-2");
    expect(s.recovery[id]).toBe("connected");
    expect(s.activeServerId).toBe(id);
    expect(onSignedIn).toHaveBeenCalledWith(id);
    expect(pool.entry(id)?.auth).not.toBe("rotate-required");

    // Neither password lands on disk or in the store.
    const text = storedText();
    expect(text).not.toContain(TEMP);
    expect(text).not.toContain(NEW);
  });

  it("Back returns to the sign-in form and signs the unused restricted session out", async () => {
    render(<OverlayAddServer onCancel={() => {}} />);
    await signInWithTemp();
    await act(async () => void fireEvent.click(screen.getByTestId("set-password-back")));
    expect(screen.queryByTestId("set-password")).toBeNull();
    expect(screen.getByRole("button", { name: "Connect & save" })).not.toBeNull();
    await waitFor(() => expect(calls("/cli/auth/logout")).toHaveLength(1));
    expect(calls("/cli/auth/logout")[0][1].headers.Authorization).toBe("Bearer sess-1");
    expect(useServersStore.getState().servers).toEqual([]);
  });
});

describe("a saved login already in must-change", () => {
  const S1 = { id: "s1", nickname: "Box", url: "https://box.k2.dev", username: "ada", rememberPassword: false };

  beforeEach(() => {
    useServersStore.setState({ servers: [S1], tokens: { s1: "held-restricted" }, activeServerId: "s1", recovery: { s1: "connected" } });
    pool.store.setState({
      entries: {
        s1: { ...blankEntry("s1", "box.k2.dev"), reach: "live", auth: "rotate-required", authKnown: true, authNote: "Box needs a new password." },
      },
    });
  });

  it("the row offers Change password", () => {
    const entry = pool.entry("s1")!;
    const status = resolveRowStatus({ saved: true, hasLogin: true, serverLabel: "Box", entry });
    const f = rowFailure(status, entry, "Box", Date.now());
    expect(f).toMatchObject({ state: "rotate-required", copy: "Change password on Box", action: "sign-in", actionLabel: "Change password" });
  });

  it("its sign-in sheet opens on the step and asks for the temporary password", async () => {
    const onSignedIn = vi.fn();
    render(<OverlayAddServer editingId="s1" activate={false} onCancel={() => {}} onSaved={() => {}} onSignedIn={onSignedIn} />);
    expect(screen.getByTestId("set-password")).not.toBeNull();
    expect(screen.queryByTestId("add-server-mode")).toBeNull();
    expect(screen.getByText(/box\.k2\.dev needs a new password before you can continue/)).not.toBeNull();
    expect(screen.getByTestId("set-password-login").textContent).toBe("ada");
    const current = screen.getByLabelText("Temporary password") as HTMLInputElement;
    expect(current.value).toBe("");
    expect(current.getAttribute("autocomplete")).toBe("current-password");

    type("set-password-new", NEW);
    type("set-password-confirm", NEW);
    await submit();
    expect(screen.getByTestId("set-password-error").textContent).toBe("Enter the temporary password you were given.");
    expect(calls("/cli/auth/login")).toHaveLength(0);

    type("set-password-current", "wrong-one");
    await submit();
    expect(screen.getByTestId("set-password-error").textContent).toBe(
      "Temporary password incorrect, or too many attempts. Try again later."
    );
    expect(calls("/cli/auth/change-password")).toHaveLength(0);

    type("set-password-current", TEMP);
    await submit();
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith("s1"));
    const s = useServersStore.getState();
    expect(s.servers).toHaveLength(1);
    expect(s.tokens.s1).toBe("sess-2");
    expect(s.activeServerId).toBe("s1");
    expect(pool.entry("s1")?.auth).toBe("ok");
    expect(pool.entry("s1")?.authNote).toBeNull();
    expect(JSON.parse(calls("/cli/auth/change-password")[0][1].body)).toEqual({ currentPassword: TEMP, newPassword: NEW });
    const text = storedText();
    expect(text).not.toContain(TEMP);
    expect(text).not.toContain(NEW);
  });

  it("a normal saved server still opens the sign-in form", () => {
    pool.store.setState({ entries: { s1: { ...blankEntry("s1", "box.k2.dev"), auth: "signin-required", authKnown: true } } });
    render(<OverlayAddServer editingId="s1" activate={false} onCancel={() => {}} />);
    expect(screen.queryByTestId("set-password")).toBeNull();
    expect(screen.getByRole("button", { name: "Connect & save" })).not.toBeNull();
  });
});

describe("a pairing code for a login with a temporary password", () => {
  it("opens the step with the username and temporary password, then signs in", async () => {
    srv.pairCheck = {
      status: 409,
      body: { ok: false, error: { code: "password_change_required", hint: "that login must change its password before a phone can be paired to it" } },
    };
    const onSaved = vi.fn();
    render(
      <OverlayAddServer
        pairLink={{ serverUrl: "https://box.k2.dev", code: "K2P-ABCDE-FGH12-34567-89XYZ" }}
        onCancel={() => {}}
        onSaved={onSaved}
      />
    );
    await screen.findByTestId("set-password");
    expect(screen.queryByTestId("add-server-mode")).toBeNull();
    expect(screen.getByLabelText("Username").getAttribute("autocomplete")).toBe("username");
    expect(screen.getByLabelText("Temporary password")).not.toBeNull();

    type("set-password-username", "ada");
    type("set-password-current", TEMP);
    type("set-password-new", NEW);
    type("set-password-confirm", NEW);
    await submit();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const s = useServersStore.getState();
    expect(s.servers).toHaveLength(1);
    expect(s.servers[0]).toMatchObject({ url: "https://box.k2.dev", username: "ada" });
    expect(s.tokens[s.servers[0].id]).toBe("sess-2");
    expect(storedText()).not.toContain(TEMP);
  });
});
