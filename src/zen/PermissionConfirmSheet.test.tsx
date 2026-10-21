// @vitest-environment jsdom
// Permission cards' fresh confirm (K2 0.46.3 contract DRAFT §Q1): start →
// finish (connect-password) → one-use token → the card's answer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: (...a: unknown[]) => tauriFetch(...a) }));

import { __resetScopesForTests, scopeFor } from "../api/scope";
import { pickConfirmMethod } from "../api/permissionConfirm";
import { answerThread } from "../api/client";
import { useServersStore } from "../stores/servers";
import { PermissionConfirmSheet } from "./PermissionConfirmSheet";

const res = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => JSON.stringify(body),
  json: async () => body,
});
type Call = { path: string; body: Record<string, unknown> };
const calls = (): Call[] =>
  tauriFetch.mock.calls.map(([u, init]) => ({
    path: new URL(u as string).pathname,
    body: JSON.parse(((init as { body?: string })?.body as string) || "{}"),
  }));

beforeEach(() => {
  tauriFetch.mockReset();
  __resetScopesForTests();
  useServersStore.setState({
    servers: [{ id: "s1", nickname: "Home", url: "https://home.k2.dev", username: "rosson", rememberPassword: false }],
    activeServerId: "s1",
    tokens: { s1: "tok1" },
    recovery: {},
  });
});
afterEach(() => cleanup());

function server(finish: (body: Record<string, unknown>) => ReturnType<typeof res>, methods = ["connect-password"]) {
  tauriFetch.mockImplementation(async (u: string, init: { body?: string }) => {
    const path = new URL(u).pathname;
    const body = JSON.parse(init?.body || "{}");
    if (path === "/cli/vault/confirm/start") return res(200, { methods, expiresIn: 60 });
    if (path === "/cli/vault/confirm/finish") return finish(body);
    if (path === "/cli/thread/answer") return res(200, { ok: true });
    return res(404, {});
  });
}

describe("confirm sheet", () => {
  it("password → token → the answer carries confirmToken (never the password)", async () => {
    server(() => res(200, { token: "ct_1", expiresIn: 60 }));
    const scope = scopeFor("s1");
    const onConfirmed = vi.fn(async (token: string) => {
      await answerThread(scope, "billing", "card-1", "Allow", { confirmToken: token });
      return null;
    });
    render(
      <PermissionConfirmSheet scope={scope} action="app-approve" requestId="pr_7f3a" headline="Approve the App request" onConfirmed={onConfirmed} onCancel={vi.fn()} />
    );
    const pw = await screen.findByTestId("permission-confirm-password");
    fireEvent.change(pw, { target: { value: "hunter2" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("permission-confirm-allow"));
    });
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith("ct_1"));
    const c = calls();
    expect(c[0]).toEqual({ path: "/cli/vault/confirm/start", body: { action: "app-approve", secretId: "pr_7f3a" } });
    expect(c[1]).toEqual({
      path: "/cli/vault/confirm/finish",
      body: { action: "app-approve", secretId: "pr_7f3a", method: "connect-password", password: "hunter2" },
    });
    expect(c[2]).toEqual({ path: "/cli/thread/answer", body: { addr: "billing", id: "card-1", answer: "Allow", confirmToken: "ct_1" } });
    expect(JSON.stringify(c[2].body)).not.toContain("hunter2");
    expect((pw as HTMLInputElement).value).toBe("");
  });

  it("a wrong password says so and clears the field; 429 says wait", async () => {
    let n = 0;
    server(() => (++n === 1 ? res(401, { error: { code: "wrong_password" } }) : res(429, { error: "rate_limited" })));
    render(
      <PermissionConfirmSheet scope={scopeFor("s1")} action="node-admin" requestId="pr_1" headline="x" onConfirmed={vi.fn()} onCancel={vi.fn()} />
    );
    const pw = await screen.findByTestId("permission-confirm-password");
    for (const want of ["didn't match", "Too many tries"]) {
      fireEvent.change(pw, { target: { value: "nope" } });
      await act(async () => {
        fireEvent.click(screen.getByTestId("permission-confirm-allow"));
      });
      await waitFor(() => expect(screen.getByTestId("permission-confirm-error").textContent).toContain(want));
      expect((pw as HTMLInputElement).value).toBe("");
    }
  });

  it("no phone method (or not allowed) → approve on the desktop, no password box", async () => {
    server(() => res(200, {}), ["local-auth"]);
    render(
      <PermissionConfirmSheet scope={scopeFor("s1")} action="x" requestId="pr_2" headline="x" onConfirmed={vi.fn()} onCancel={vi.fn()} />
    );
    expect((await screen.findByTestId("permission-confirm-unavailable")).textContent).toContain("desktop");
    expect(screen.queryByTestId("permission-confirm-password")).toBeNull();
  });

  it("method choice: login password first, then vault password", () => {
    expect(pickConfirmMethod(["vault-password", "connect-password"])).toBe("connect-password");
    expect(pickConfirmMethod(["vault-password"])).toBe("vault-password");
    expect(pickConfirmMethod(["local-auth"])).toBeNull();
  });
});
