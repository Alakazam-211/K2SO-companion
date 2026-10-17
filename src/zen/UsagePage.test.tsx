// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => tauriFetch(...args),
}));

import { UsagePage } from "./UsagePage";
import { useServersStore } from "../stores/servers";
import { __resetScopesForTests } from "../api/scope";
import { handleAndroidBack } from "../lib/androidBack";
import { ADD_ON_DESKTOP_NOTE, FORBIDDEN_SWITCH_TEXT } from "../api/llmTokensPure";
import { listBody, NOW_MS } from "../test/llmTokensFixture";

type Init = { method?: string; body?: string };
const res = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/** Route the fake daemon by path; records every call. */
function daemon(handlers: {
  list?: () => ReturnType<typeof res>;
  switch?: (body: unknown) => ReturnType<typeof res> | Promise<ReturnType<typeof res>>;
  refresh?: () => ReturnType<typeof res>;
}) {
  tauriFetch.mockImplementation(async (url: string, init: Init) => {
    const path = new URL(url).pathname;
    if (path === "/cli/llm/accounts/list") return (handlers.list ?? (() => res(200, listBody())))();
    if (path === "/cli/llm/accounts/switch")
      return (handlers.switch ?? (() => res(200, { warnings: [] })))(JSON.parse(init.body ?? "{}"));
    if (path === "/cli/llm/accounts/refresh")
      return (handlers.refresh ?? (() => res(200, { accounts: [], usageChecked: true })))();
    return res(404, { error: "route_unclassified" });
  });
}

const calls = (path: string) =>
  tauriFetch.mock.calls.filter(([url]) => new URL(url as string).pathname === path) as Array<[string, Init]>;

beforeEach(() => {
  tauriFetch.mockReset();
  __resetScopesForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_MS);
  useServersStore.setState({
    servers: [{ id: "s1", nickname: "Home", url: "https://home.k2.dev", username: "u", rememberPassword: false }],
    activeServerId: "s1",
    tokens: { s1: "tok1" },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useServersStore.setState({ servers: [], activeServerId: null, tokens: {} });
});

describe("UsagePage", () => {
  it("shows the server, the note, the active subscription first and the others", async () => {
    daemon({});
    render(<UsagePage serverId="s1" onBack={() => {}} />);
    expect(screen.getByTestId("usage-server").textContent).toBe("Home");
    expect(screen.getByTestId("usage-note").textContent).toBe(ADD_ON_DESKTOP_NOTE);
    expect(ADD_ON_DESKTOP_NOTE).toMatch(/use K2 on your desktop/);
    expect(ADD_ON_DESKTOP_NOTE).toMatch(/already active on your device\(s\)/);

    const claude = await screen.findByTestId("usage-tool-claude");
    const rows = within(claude).getAllByTestId(/^usage-token-acc_/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "usage-token-acc_work",
      "usage-token-acc_home",
      "usage-token-acc_team",
      "usage-token-acc_key",
    ]);
    expect(rows[0].getAttribute("data-active")).toBe("true");
    expect(within(rows[0]).getByText("Active")).toBeTruthy();
    expect(screen.getByTestId("usage-token-name-acc_work").textContent).toBe("Claude · Max · work");
    expect(within(rows[0]).getByText(/Server default · Signed in · rosson@example.test · Alakazam/)).toBeTruthy();
    expect(screen.getByTestId("usage-window-acc_work-Session").textContent).toBe("Session 42%");
    expect(within(rows[0]).getByText("resets in 3h")).toBeTruthy();
    expect(screen.getByTestId("usage-age-acc_work").textContent).toBe("Usage checked 2 min ago");
    expect(screen.getByTestId("usage-age-acc_home").textContent).toMatch(/last check failed \(HTTP 429\)/);

    // Switch only on the signed-in, free subscription.
    expect(screen.getByTestId("usage-switch-acc_home")).toBeTruthy();
    expect(screen.queryByTestId("usage-switch-acc_work")).toBeNull();
    expect(screen.queryByTestId("usage-switch-acc_team")).toBeNull();
    expect(screen.queryByTestId("usage-switch-acc_key")).toBeNull();
    expect(screen.queryByTestId("usage-switch-acc_cx")).toBeNull();
    expect(screen.getByTestId("usage-pinned-acc_team").textContent).toBe("Used by: K2");
    expect(screen.getByTestId("usage-blocked-acc_key").textContent).toMatch(/billed per token/);
    expect(screen.getByTestId("usage-blocked-acc_cx").textContent).toMatch(/Needs sign-in/);
    // Used-up warning before a confirm-free switch.
    expect(within(rows[1]).getByText("Session is used up (resets in 45m)")).toBeTruthy();
    // Codex has no default; Grok (no tokens) and Cursor (not supported) are absent.
    expect(within(screen.getByTestId("usage-tool-codex")).getByText("No server default for Codex.")).toBeTruthy();
    expect(screen.queryByTestId("usage-tool-grok")).toBeNull();
    expect(screen.queryByTestId("usage-tool-cursor")).toBeNull();
    expect(screen.getByTestId("usage-switch-note").textContent).toMatch(/server default token/);

    // The list was read with the server's token; usage refreshed on open.
    const [url, init] = calls("/cli/llm/accounts/list")[0] as [string, Init & { headers: Record<string, string> }];
    expect(url).toBe("https://home.k2.dev/cli/llm/accounts/list");
    expect(init.method).toBe("GET");
    expect(JSON.stringify(init.headers)).toContain("tok1");
    await waitFor(() => expect(calls("/cli/llm/accounts/refresh")).toHaveLength(1));
    const [, rInit] = calls("/cli/llm/accounts/refresh")[0];
    expect(rInit.method).toBe("POST");
    expect(JSON.parse(rInit.body!)).toEqual({ usage: true });
    await waitFor(() => expect(calls("/cli/llm/accounts/list")).toHaveLength(2));
  });

  it("Switch POSTs /cli/llm/accounts/switch {id}, shows pending, then re-lists", async () => {
    let switched = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    daemon({
      list: () => {
        const body = listBody();
        if (switched) {
          const claude = (body.tools as Array<Record<string, unknown>>)[0];
          claude.activeId = "acc_home";
        }
        return res(200, body);
      },
      switch: async () => {
        await gate;
        switched = true;
        return res(200, { switch: {}, account: {}, warnings: [], note: "" });
      },
    });
    render(<UsagePage serverId="s1" onBack={() => {}} />);
    const btn = await screen.findByTestId("usage-switch-acc_home");
    await waitFor(() => expect(calls("/cli/llm/accounts/list").length).toBeGreaterThanOrEqual(2));
    fireEvent.click(btn);
    await waitFor(() => expect(btn.textContent).toBe("Switching…"));
    expect(calls("/cli/llm/accounts/switch")).toHaveLength(1);
    const [, init] = calls("/cli/llm/accounts/switch")[0];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body!)).toEqual({ id: "acc_home" });
    release();
    await waitFor(() =>
      expect(screen.getByTestId("usage-token-acc_home").getAttribute("data-active")).toBe("true")
    );
    // The new default leads; the old one now offers Switch.
    const rows = within(screen.getByTestId("usage-tool-claude")).getAllByTestId(/^usage-token-acc_/);
    expect(rows[0].getAttribute("data-testid")).toBe("usage-token-acc_home");
    expect(screen.getByTestId("usage-switch-acc_work")).toBeTruthy();
  });

  it("a failed switch shows the daemon's reason inline on that row", async () => {
    daemon({
      switch: () => res(409, { error: { code: "signing_in", hint: "this token is signing in" } }),
    });
    render(<UsagePage serverId="s1" onBack={() => {}} />);
    fireEvent.click(await screen.findByTestId("usage-switch-acc_home"));
    const err = await screen.findByTestId("usage-switch-error-acc_home");
    expect(err.textContent).toBe("Couldn't switch: this token is signing in");
    expect((screen.getByTestId("usage-switch-acc_home") as HTMLButtonElement).disabled).toBe(false);
  });

  it("403 on switch disables Switch with a short reason", async () => {
    daemon({ switch: () => res(403, { error: "role_required", required: "member", role: "member" }) });
    render(<UsagePage serverId="s1" onBack={() => {}} />);
    fireEvent.click(await screen.findByTestId("usage-switch-acc_home"));
    const denied = await screen.findByTestId("usage-switch-denied");
    expect(denied.textContent).toBe(FORBIDDEN_SWITCH_TEXT);
    expect((screen.getByTestId("usage-switch-acc_home") as HTMLButtonElement).disabled).toBe(true);
  });

  it("an older K2 (404) gets a friendly not-supported state, no refresh", async () => {
    daemon({ list: () => res(404, { error: "route_unclassified", message: "…" }) });
    render(<UsagePage serverId="s1" onBack={() => {}} />);
    const msg = await screen.findByTestId("usage-unsupported");
    expect(msg.textContent).toBe(
      "Home's K2 doesn't support usage yet. Update K2 on that computer to see its subscriptions here."
    );
    expect(screen.getByTestId("usage-note")).toBeTruthy();
    expect(calls("/cli/llm/accounts/refresh")).toHaveLength(0);
  });

  it("403 on the list says the login can't see subscriptions", async () => {
    daemon({ list: () => res(403, { error: "role_required" }) });
    render(<UsagePage serverId="s1" onBack={() => {}} />);
    expect((await screen.findByTestId("usage-forbidden")).textContent).toMatch(/can't see its subscriptions/);
  });

  it("a body that isn't the daemon's shape shows the empty state, not a crash", async () => {
    daemon({ list: () => res(200, { unexpected: true }) });
    render(<UsagePage serverId="s1" onBack={() => {}} />);
    expect((await screen.findByTestId("usage-empty")).textContent).toBe("No subscriptions on Home yet.");
  });

  it("the back chevron and Android Back both go back", async () => {
    daemon({});
    const onBack = vi.fn();
    render(<UsagePage serverId="s1" onBack={onBack} />);
    fireEvent.click(screen.getByTestId("usage-back"));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(handleAndroidBack()).toBe(true);
    expect(onBack).toHaveBeenCalledTimes(2);
    await screen.findByTestId("usage-tool-claude");
  });
});
