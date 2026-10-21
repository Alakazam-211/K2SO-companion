// @vitest-environment jsdom
// Permission cards (K2 0.46.3 phone contract v1), against the contract's
// own JSON examples (src/test/fixtures/permissionCards.contract-v1.json;
// the golden samples replace them when K2's run writes them).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: (...a: unknown[]) => tauriFetch(...a) }));

import fixtures from "../test/fixtures/permissionCards.contract-v1.json";
import { __resetScopesForTests, scopeFor } from "../api/scope";
import { useServersStore } from "../stores/servers";
import { normaliseThreadItem } from "./threadModel";
import { PermissionCard } from "./PermissionCard";
import { noteProblem, parsePermissionCard, stateLine, waitingText, type PermissionCardModel } from "./permissionCardModel";

type Doc = Record<string, unknown> & { id: string; choice?: Record<string, unknown> };
const F = fixtures as Record<string, Doc>;

const card = (doc: Doc) => parsePermissionCard(doc.choice)!;
const single = (doc: Doc) => card(doc) as Extract<PermissionCardModel, { kind: "permission" }>;
const res = (status: number, body: unknown) => ({ status, ok: status < 300, text: async () => JSON.stringify(body), json: async () => body });
const posts = () =>
  tauriFetch.mock.calls.map(([u, init]) => ({ path: new URL(u as string).pathname, body: JSON.parse((init as { body?: string })?.body || "{}") }));

beforeEach(() => {
  tauriFetch.mockReset();
  tauriFetch.mockImplementation(async (u: string) =>
    new URL(u).pathname === "/cli/vault/confirm/start" ? res(200, { methods: ["connect-password"], expiresIn: 60 }) : res(200, { ok: true })
  );
  __resetScopesForTests();
  useServersStore.setState({
    servers: [{ id: "s1", nickname: "Home", url: "https://home.k2.dev", username: "rosson", rememberPassword: false }],
    activeServerId: "s1",
    tokens: { s1: "tok1" },
    recovery: {},
  });
});
afterEach(() => cleanup());

function draw(doc: Doc, onWritten = vi.fn()) {
  render(<PermissionCard card={card(doc)} id={doc.id} addr="billing" scope={scopeFor("s1")} enabled onWritten={onWritten} />);
  return onWritten;
}

describe("model (contract §2)", () => {
  it("approver pending: approve mode, click proof, notes, why", () => {
    const c = single(F["11.1"]);
    expect(c.state).toBe("pending");
    expect(c.viewer).toMatchObject({ mode: "approve", canAnswer: true, isAsker: false });
    expect(c.item.whatChanges).toBe("Let billing run jobs on this server's compute nodes.");
    expect(c.item.proof).toEqual({ kind: "click" });
    expect(c.item.notes[0]).toMatchObject({ by: "dana", text: "I need this for the payroll run" });
    expect(c.options).toEqual(["Allow", "Deny"]);
  });

  it("approved: result message, answer, undo", () => {
    const c = single(F["11.2"]);
    expect(c.state).toBe("approved");
    expect(c.resultMessage).toContain("Allowed.");
    expect(c.item.undo).toEqual({ label: "Turn off again", until: 1761666000 });
    expect(stateLine(c, () => "Oct 21")).toBe("Allowed by rosson, Oct 21");
  });

  it("confirm proof, and the asker's waiting text and note box", () => {
    expect(single(F["11.3"]).item.proof).toEqual({ kind: "confirm", action: "app-approve", secretId: "ar_22" });
    const a = single(F["11.5"]);
    expect(a.viewer.mode).toBe("wait");
    expect(waitingText(a)).toBe("Asked an admin to turn on Allow compute nodes for you. You can keep working with billing meanwhile.");
    expect(a.noteBox).toEqual({ allowed: true, max: 500, mine: "I need this for the payroll run" });
  });

  it("batch: items, canAnswerAll false with a confirm item", () => {
    const b = card(F["11.12"]);
    expect(b.kind).toBe("batch");
    if (b.kind !== "batch") return;
    expect(b.items.map((i) => i.requestId)).toEqual(["pr_a1", "pr_a2", "ar_23"]);
    expect(b.viewer.canAnswerAll).toBe(false);
  });

  it("fallback docs (agent passport, old build) carry no rich card", () => {
    expect(normaliseThreadItem({ doc: F["11.10"] } as never, "rosson")?.choice).toBeNull();
    expect(normaliseThreadItem({ doc: F["11.11"] } as never, "rosson")?.text).toContain("Asked an admin");
    expect(normaliseThreadItem({ doc: F["11.1"] } as never, "rosson")?.choice?.permission?.kind).toBe("permission");
  });

  it("note rules: length, one paragraph, no links", () => {
    expect(noteProblem("ok", 500)).toBeNull();
    expect(noteProblem("x".repeat(501), 500)).toContain("500");
    expect(noteProblem("a\nb", 500)).toContain("paragraph");
    expect(noteProblem("see https://x.y", 500)).toContain("links");
  });
});

describe("card (contract §3–§5)", () => {
  it("Allow posts the exact label; Deny takes an optional reason", async () => {
    const onWritten = draw(F["11.1"]);
    expect(screen.getByTestId("permission-headline").textContent).toContain("compute nodes");
    expect(screen.getByTestId("permission-direction").textContent).toBe("Loosens access");
    expect(screen.getByTestId("permission-why").textContent).toContain("billing says:");
    await act(async () => {
      fireEvent.click(screen.getByTestId("permission-allow"));
    });
    await waitFor(() => expect(onWritten).toHaveBeenCalled());
    expect(posts()[0]).toEqual({ path: "/cli/thread/answer", body: { addr: "billing", id: "tc_7f3a2c90", answer: "Allow" } });
    fireEvent.click(screen.getByTestId("permission-deny"));
    fireEvent.change(screen.getByTestId("permission-deny-reason"), { target: { value: "Not this week" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("permission-deny-send"));
    });
    expect(posts()[1].body).toEqual({ addr: "billing", id: "tc_7f3a2c90", answer: "Deny", reason: "Not this week" });
  });

  it("a confirm card opens the password sheet; the answer carries the token", async () => {
    tauriFetch.mockImplementation(async (u: string) => {
      const p = new URL(u).pathname;
      if (p === "/cli/vault/confirm/start") return res(200, { methods: ["connect-password"], expiresIn: 60 });
      if (p === "/cli/vault/confirm/finish") return res(200, { token: "ct_9", expiresIn: 60 });
      return res(200, { ok: true });
    });
    draw(F["11.3"]);
    expect(screen.getByTestId("permission-needs-password")).toBeTruthy();
    fireEvent.click(screen.getByTestId("permission-allow"));
    const pw = await screen.findByTestId("permission-confirm-password");
    fireEvent.change(pw, { target: { value: "pw" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("permission-confirm-allow"));
    });
    await waitFor(() => expect(screen.queryByTestId("permission-confirm")).toBeNull());
    const answer = posts().find((p) => p.path === "/cli/thread/answer");
    expect(answer?.body).toEqual({ addr: "billing", id: "tc_9b10ee41", answer: "Allow", confirmToken: "ct_9" });
  });

  it("the asker sees the waiting text and can replace their note; no buttons", async () => {
    draw(F["11.5"]);
    expect(screen.queryByTestId("permission-allow")).toBeNull();
    expect(screen.getByTestId("permission-waiting").textContent).toContain("You can keep working with billing");
    const input = screen.getByTestId("permission-note-input") as HTMLTextAreaElement;
    expect(input.value).toBe("I need this for the payroll run");
    fireEvent.change(input, { target: { value: "Needed by Friday" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("permission-note-send"));
    });
    expect(posts()[0]).toEqual({ path: "/cli/thread/permission-note", body: { addr: "billing", id: "tc_7f3a2c90", text: "Needed by Friday" } });
  });

  it("approved: state line, result and Turn off again", async () => {
    draw(F["11.2"]);
    expect(screen.getByTestId("permission-state").textContent).toContain("Allowed by rosson");
    expect(screen.getByTestId("permission-result").textContent).toContain("Turn it off again in Settings");
    await act(async () => {
      fireEvent.click(screen.getByTestId("permission-undo"));
    });
    expect(posts()[0]).toEqual({ path: "/cli/thread/permission-undo", body: { addr: "billing", id: "tc_7f3a2c90" } });
  });

  it("already on: Close answers it as a no-op", async () => {
    const doc = JSON.parse(JSON.stringify(F["11.1"])) as Doc;
    const c = doc.choice as Record<string, unknown>;
    c.options = [{ label: "Close" }];
    ((c.action as Record<string, unknown>).view as Record<string, unknown>).state = "already_done";
    draw(doc);
    expect(screen.getByTestId("permission-state").textContent).toBe("Already on");
    await act(async () => {
      fireEvent.click(screen.getByTestId("permission-close"));
    });
    expect(posts()[0].body).toEqual({ addr: "billing", id: "tc_7f3a2c90", answer: "Close" });
  });

  it("batch: no Allow all while a confirm item is pending; items answer with item", async () => {
    draw(F["11.12"]);
    expect(screen.queryByTestId("permission-allow-all")).toBeNull();
    expect(screen.getAllByTestId("permission-batch-item")).toHaveLength(3);
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("permission-item-allow")[0]);
    });
    expect(posts()[0].body).toEqual({ addr: "billing", id: "tc_b4a1c0de", answer: "Allow", item: "pr_a1" });
  });

  it("errors read as words: someone answered first", async () => {
    tauriFetch.mockImplementation(async () => res(409, { ok: false, error: { code: "request_not_pending" } }));
    draw(F["11.1"]);
    await act(async () => {
      fireEvent.click(screen.getByTestId("permission-allow"));
    });
    expect((await screen.findByTestId("permission-error")).textContent).toContain("already answered");
  });
});
