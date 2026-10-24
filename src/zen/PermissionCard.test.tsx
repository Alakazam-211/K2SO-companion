// @vitest-environment jsdom
// Permission cards (K2 0.46.3, `cards=2`, view v1) against K2's golden
// samples: src/test/fixtures/permission-cards-0463/, written by the
// daemon's own code (lane F). Where the phone contract and a sample
// disagree, the sample is right (the README there lists the 17 cases).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: (...a: unknown[]) => tauriFetch(...a) }));

import { __resetScopesForTests, scopeFor } from "../api/scope";
import { useServersStore } from "../stores/servers";
import { normaliseThreadItem } from "./threadModel";
import { PermissionCard } from "./PermissionCard";
import { noteProblem, parsePermissionCard, stateLine, waitingText, type PermissionCardModel } from "./permissionCardModel";

type Doc = Record<string, unknown> & { id: string; choice?: Record<string, unknown> };
const files = import.meta.glob("../test/fixtures/permission-cards-0463/*.json", { eager: true, import: "default" }) as Record<string, unknown>;
const S: Record<string, Record<string, unknown>> = Object.fromEntries(
  Object.entries(files).map(([p, v]) => [p.split("/").pop()!.replace(/\.json$/, ""), v as Record<string, unknown>])
);
const names = (form: string) => Object.keys(S).filter((n) => n.endsWith(`__${form}`)).sort();
const doc = (name: string) => S[name] as Doc;

const card = (d: Doc) => parsePermissionCard(d.choice)!;
const single = (d: Doc) => card(d) as Extract<PermissionCardModel, { kind: "permission" }>;
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

function draw(d: Doc, onWritten = vi.fn()) {
  render(<PermissionCard card={card(d)} id={d.id} addr="billing" scope={scopeFor("s1")} enabled onWritten={onWritten} />);
  return onWritten;
}

describe("golden samples: every form", () => {
  it("the set is all here", () => {
    const index = (S.index as { files: { file: string }[] }).files.map((f) => f.file.replace(/\.json$/, "")).sort();
    expect(index).toHaveLength(116);
    expect(Object.keys(S).filter((n) => n !== "index").sort()).toEqual(index);
    expect(names("cards2")).toHaveLength(44);
    expect(names("response")).toHaveLength(17);
  });

  it("every cards2 doc, GET item and WS frame parses as a rich card", () => {
    for (const n of names("cards2")) expect(card(doc(n)), n).not.toBeNull();
    for (const n of [...names("item"), ...names("ws")]) {
      const m = normaliseThreadItem(S[n] as never, "rosson");
      expect(m?.choice?.permission, n).toBeTruthy();
      expect(m?.id, n).toBe((S[n].doc as Doc).id);
    }
  });

  it("no fallback doc (agents, today's builds) carries a rich card", () => {
    for (const n of names("fallback")) {
      const m = normaliseThreadItem({ doc: doc(n) } as never, "rosson");
      expect(m, n).not.toBeNull();
      expect(m?.choice?.permission ?? null, n).toBeNull();
    }
    expect(normaliseThreadItem({ doc: doc("agent__pending__fallback") } as never, "rosson")?.text).toBe(
      "billing asked an admin to turn on Allow compute nodes."
    );
  });

  it("App guests get no doc at all", () => {
    for (const n of names("hidden")) expect(S[n].doc, n).toBeNull();
  });

  it("open while choice.status is pending, whatever the options", () => {
    for (const n of names("cards2")) {
      const d = doc(n);
      const c = card(d);
      expect(c.open, n).toBe(d.choice!.status === "pending");
      expect(normaliseThreadItem({ doc: d } as never, "rosson")?.choice?.permission?.open, n).toBe(c.open);
    }
  });

  it("every card draws; buttons only for an approver on an open card", () => {
    for (const n of names("cards2")) {
      const c = card(doc(n));
      draw(doc(n));
      const answerable = c.open && c.viewer.mode === "approve" && c.viewer.canAnswer;
      if (c.kind === "permission") {
        expect(!!screen.queryByTestId("permission-allow"), n).toBe(answerable && c.state === "pending");
        expect(!!screen.queryByTestId("permission-close"), n).toBe(answerable && c.state === "already_done");
        if (!c.open || c.state === "already_done" || c.state === "applying") expect(stateLine(c, () => "t"), n).not.toBeNull();
        if (c.open && c.state === "pending" && c.viewer.mode === "wait") expect(screen.getByTestId("permission-waiting"), n).toBeTruthy();
      } else {
        const itemButtons = screen.queryAllByTestId("permission-item-allow").length;
        expect(itemButtons, n).toBe(answerable ? c.items.filter((i) => i.state === "pending").length : 0);
        expect(!!screen.queryByTestId("permission-allow-all"), n).toBe(answerable && c.viewer.canAnswerAll);
      }
      cleanup();
    }
  });
});

describe("model", () => {
  it("approver pending: approve mode, click proof, notes, why", () => {
    const c = single(doc("approver-click__pending__cards2"));
    expect(c.state).toBe("pending");
    expect(c.viewer).toMatchObject({ mode: "approve", canAnswer: true, isAsker: false });
    expect(c.item.whatChanges).toBe("Let billing run jobs on this server's compute nodes.");
    expect(c.item.proof).toEqual({ kind: "click" });
    expect(c.item.notes[0]).toMatchObject({ by: "dana", role: "member", text: "I need this for the payroll run" });
    expect(c.approvers.names).toEqual(["maya", "rosson"]);
    expect(c.options).toEqual(["Allow", "Deny"]);
  });

  it("closed cards keep Allow/Deny but read their state", () => {
    const lines: Record<string, string> = {
      approved: "Allowed by rosson, t",
      denied: "Denied by rosson",
      expired: "Expired unanswered",
      stale: "The compute pool changed after billing asked.",
      cancelled: "Withdrawn by billing",
      closed: "Closed: permission cards were turned off",
    };
    for (const [state, line] of Object.entries(lines)) {
      const c = single(doc(`approver-click__${state}__cards2`));
      expect(c.options, state).toEqual(["Allow", "Deny"]);
      expect(c.open, state).toBe(false);
      expect(stateLine(c, () => "t"), state).toBe(line);
    }
    expect(stateLine(single(doc("approver-click__failed__cards2")), () => "t")).toMatch(/^Couldn't apply: /);
  });

  it("approved: result message, answer via phone, undo", () => {
    const c = single(doc("approver-click__approved__cards2"));
    expect(c.resultMessage).toBe("Allowed. Turn it off again in Settings → Workspaces → billing → Agent.");
    expect(c.item.answer).toMatchObject({ decision: "allow", by: "rosson", via: "phone" });
    expect(c.item.undo).toEqual({ label: "Turn off again", until: 1761666000 });
  });

  it("confirm proof; the admin below the owner floor waits", () => {
    expect(single(doc("approver-confirm__pending__cards2")).item.proof).toEqual({ kind: "confirm", action: "app-approve", secretId: "ar_22" });
    const w = single(doc("admin-wait-confirm__pending__cards2"));
    expect(w.viewer.mode).toBe("wait");
    expect(w.options).toEqual([]);
  });

  it("the asker's waiting text and note box", () => {
    const a = single(doc("asker__pending__cards2"));
    expect(a.viewer.mode).toBe("wait");
    expect(waitingText(a)).toBe("Asked an admin to turn on Allow compute nodes for you. You can keep working with billing meanwhile.");
    // A tightening card turns its setting off.
    const t = { ...a, item: { ...a.item, direction: "tighten" as const } };
    expect(waitingText(t)).toBe("Asked an admin to turn off Allow compute nodes for you. You can keep working with billing meanwhile.");
    expect(a.noteBox).toEqual({ allowed: true, max: 500, mine: "I need this for the payroll run" });
  });

  it("batch: partial keeps pending with mixed items; done", () => {
    const p = card(doc("batch-approver__partial__cards2"));
    if (p.kind !== "batch") throw new Error("not a batch");
    expect(p.state).toBe("pending");
    expect(p.items.map((i) => [i.requestId, i.state])).toEqual([
      ["pr_a1a1a1", "approved"],
      ["pr_a2a2a2", "approved"],
      ["ar_23", "pending"],
    ]);
    expect(p.viewer.canAnswerAll).toBe(false);
    const d = card(doc("batch-approver__done__cards2"));
    expect(d.kind === "batch" && d.state).toBe("done");
    expect(d.open).toBe(false);
  });

  it("Garden cards (garden.access / garden.delete) are ordinary permission cards", () => {
    const a = single(doc("garden-access__pending__cards2"));
    expect(a.item.action).toBe("garden.access");
    expect(a.item.whatChanges).toBe("Let billing edit Sales board.");
    expect(a.approvers.floor).toBe("owner");
    expect(a.options).toEqual(["Allow", "Deny"]);
    // An admin below the GardenOwner floor waits, in the server's own words.
    const w = single(doc("garden-access-admin__pending__cards2"));
    expect(w.viewer.mode).toBe("wait");
    expect(waitingText(w)).toBe("billing asked an owner to turn on Edit Sales board.");
    const d = single(doc("garden-delete__approved__cards2"));
    expect(d.resultMessage).toBe("Deleted. K2 keeps a copy in history.");
    expect(d.item.undo).toBeNull();
    expect(stateLine(single(doc("garden-access__denied__cards2")), () => "t")).toBe("Denied by rosson");
  });

  it("note rules: length, one paragraph, no links", () => {
    expect(noteProblem("ok", 500)).toBeNull();
    expect(noteProblem("x".repeat(501), 500)).toContain("500");
    expect(noteProblem("a\nb", 500)).toContain("paragraph");
    expect(noteProblem("see https://x.y", 500)).toContain("links");
  });
});

describe("answers", () => {
  const ID = "7f3a2c90-4f1e-4c2a-9b0d-3e5f6a7b8c90";

  it("Allow posts the exact label with client phone; Deny takes an optional reason", async () => {
    tauriFetch.mockImplementation(async () => {
      const r = S["answer__allow__response"] as { status: number; body: unknown };
      return res(r.status, r.body);
    });
    const onWritten = draw(doc("approver-click__pending__cards2"));
    expect(screen.getByTestId("permission-headline").textContent).toContain("compute nodes");
    expect(screen.getByTestId("permission-direction").textContent).toBe("Loosens access");
    expect(screen.getByTestId("permission-why").textContent).toContain("billing says:");
    await act(async () => {
      fireEvent.click(screen.getByTestId("permission-allow"));
    });
    await waitFor(() => expect(onWritten).toHaveBeenCalled());
    expect(posts()[0]).toEqual({ path: "/cli/thread/answer", body: { addr: "billing", id: ID, answer: "Allow", client: "phone" } });
    fireEvent.click(screen.getByTestId("permission-deny"));
    fireEvent.change(screen.getByTestId("permission-deny-reason"), { target: { value: "Not this week; the minis are busy" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("permission-deny-send"));
    });
    expect(posts()[1].body).toEqual({ addr: "billing", id: ID, answer: "Deny", client: "phone", reason: "Not this week; the minis are busy" });
  });

  it("a confirm card opens the password sheet; the answer carries the token", async () => {
    tauriFetch.mockImplementation(async (u: string) => {
      const p = new URL(u).pathname;
      if (p === "/cli/vault/confirm/start") return res(200, { methods: ["connect-password"], expiresIn: 60 });
      if (p === "/cli/vault/confirm/finish") return res(200, { token: "ct_9", expiresIn: 60 });
      const r = S["answer__allow-confirmed__response"] as { status: number; body: unknown };
      return res(r.status, r.body);
    });
    const d = doc("approver-confirm__pending__cards2");
    draw(d);
    expect(screen.getByTestId("permission-needs-password")).toBeTruthy();
    fireEvent.click(screen.getByTestId("permission-allow"));
    const pw = await screen.findByTestId("permission-confirm-password");
    fireEvent.change(pw, { target: { value: "pw" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("permission-confirm-allow"));
    });
    await waitFor(() => expect(screen.queryByTestId("permission-confirm")).toBeNull());
    const answer = posts().find((p) => p.path === "/cli/thread/answer");
    expect(answer?.body).toEqual({ addr: "billing", id: d.id, answer: "Allow", client: "phone", confirmToken: "ct_9" });
  });

  it("the asker sees the waiting text and can replace their note; no buttons", async () => {
    draw(doc("asker__pending__cards2"));
    expect(screen.queryByTestId("permission-allow")).toBeNull();
    expect(screen.getByTestId("permission-waiting").textContent).toContain("You can keep working with billing");
    const input = screen.getByTestId("permission-note-input") as HTMLTextAreaElement;
    expect(input.value).toBe("I need this for the payroll run");
    fireEvent.change(input, { target: { value: "Needed by Friday" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("permission-note-send"));
    });
    expect(posts()[0]).toEqual({ path: "/cli/thread/permission-note", body: { addr: "billing", id: ID, text: "Needed by Friday" } });
  });

  it("approved: state line, result and Turn off again", async () => {
    draw(doc("approver-click__approved__cards2"));
    expect(screen.getByTestId("permission-state").textContent).toContain("Allowed by rosson");
    expect(screen.getByTestId("permission-result").textContent).toContain("Turn it off again in Settings");
    await act(async () => {
      fireEvent.click(screen.getByTestId("permission-undo"));
    });
    expect(posts()[0]).toEqual({ path: "/cli/thread/permission-undo", body: { addr: "billing", id: ID } });
  });

  it("already on: Close answers it as a no-op; once closed, no Close", async () => {
    draw(doc("approver-click__already_done__cards2"));
    expect(screen.getByTestId("permission-state").textContent).toBe("Already on");
    await act(async () => {
      fireEvent.click(screen.getByTestId("permission-close"));
    });
    expect(posts()[0].body).toEqual({ addr: "billing", id: ID, answer: "Close", client: "phone" });
    cleanup();
    draw(doc("approver-click__already_done-closed__cards2"));
    expect(screen.queryByTestId("permission-close")).toBeNull();
    expect(screen.getByTestId("permission-result").textContent).toBe("Already on. Nothing was applied.");
  });

  it("batch: no Allow all while a confirm item waits; a click item answers with item", async () => {
    const d = doc("batch-approver__pending__cards2");
    draw(d);
    expect(screen.queryByTestId("permission-allow-all")).toBeNull();
    expect(screen.getAllByTestId("permission-batch-item")).toHaveLength(3);
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("permission-item-allow")[0]);
    });
    expect(posts()[0].body).toEqual({ addr: "billing", id: d.id, answer: "Allow", client: "phone", item: "pr_a1a1a1" });
  });

  it("batch partial: only the confirm item is left, and it opens the password sheet", async () => {
    draw(doc("batch-approver__partial__cards2"));
    const allow = screen.getAllByTestId("permission-item-allow");
    expect(allow).toHaveLength(1);
    fireEvent.click(allow[0]);
    expect(await screen.findByTestId("permission-confirm-password")).toBeTruthy();
  });

  it("each refused answer reads as words", async () => {
    const words: Record<string, string> = {
      "answer__answered-already__response": "already answered",
      "answer__below-floor__response": "Only an owner or admin",
      "answer__admin-below-owner-floor__response": "Only the owner",
      "answer__confirm-required__response": "needs your password",
      "answer__not-an-option__response": "This card changed",
    };
    for (const [n, text] of Object.entries(words)) {
      const r = S[n] as { status: number; body: unknown };
      tauriFetch.mockImplementation(async () => res(r.status, r.body));
      draw(doc("approver-click__pending__cards2"));
      await act(async () => {
        fireEvent.click(screen.getByTestId("permission-allow"));
      });
      expect((await screen.findByTestId("permission-error")).textContent, n).toContain(text);
      cleanup();
    }
  });
});
