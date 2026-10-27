// @vitest-environment jsdom
// "Pairing code" (K2 0.46.4 companion-pairing-v1). K2's security review: a
// pair link can come from anyone, so the phone names the server and the
// login and waits for the user's Pair; a saved server is never replaced
// without saying so; a host outside k2.dev is warned about.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const { check, pair } = vi.hoisted(() => ({ check: vi.fn(), pair: vi.fn() }));
vi.mock("../api/pairing", async (orig) => ({ ...(await orig<typeof import("../api/pairing")>()), checkPairCode: check }));
vi.mock("./pairFlow", () => ({ pairServer: pair, switchToPairing: vi.fn() }));

import { useServersStore } from "../stores/servers";
import { OverlayAddServer } from "./OverlayAddServer";
import { useZenStore } from "./zenStore";

const CODE = "K2P-ABCDE-FGH12-34567-89XYZ";
const flush = () => act(async () => {});

beforeEach(() => {
  check.mockReset();
  pair.mockReset();
  useServersStore.setState({ servers: [], tokens: {}, activeServerId: null, recovery: {} });
});
afterEach(() => cleanup());

describe("pairing", () => {
  it("a link opens the confirm with the server and the login; nothing pairs until Pair", async () => {
    check.mockResolvedValue({ ok: true, user: "rosson", host: "rosson.k2.dev", expiresInSecs: 500 });
    pair.mockResolvedValue({ ok: true, id: "new", username: "rosson" });
    const onSaved = vi.fn();
    render(<OverlayAddServer pairLink={{ serverUrl: "https://rosson.k2.dev", code: CODE }} onCancel={() => {}} onSaved={onSaved} />);
    await flush();
    expect(check).toHaveBeenCalledWith("https://rosson.k2.dev", CODE);
    expect(screen.getByTestId("pair-confirm-host").textContent).toBe("rosson.k2.dev");
    expect(screen.getByTestId("pair-confirm-login").textContent).toBe("rosson");
    expect(screen.queryByTestId("pair-warn-host")).toBeNull();
    expect(pair).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("pair-confirm-button"));
    await flush();
    expect(pair).toHaveBeenCalledWith(
      expect.objectContaining({ serverUrl: "https://rosson.k2.dev", code: CODE, replaceId: null, activate: true })
    );
    // A clear "Paired" moment; the overlay closes on Done, not by itself.
    expect(screen.getByTestId("pair-success-text").textContent).toContain("rosson.k2.dev as rosson");
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("pair-done"));
    expect(onSaved).toHaveBeenCalled();
  });

  it("once Pair is tapped, a step list shows progress and nothing is tappable until Paired", async () => {
    check.mockResolvedValue({ ok: true, user: "rosson", host: "rosson.k2.dev", expiresInSecs: 500 });
    let answer!: (r: unknown) => void;
    let onStep!: (s: string) => void;
    pair.mockImplementation((input: { onStep: (s: string) => void }) => {
      onStep = input.onStep;
      onStep("pair");
      return new Promise((r) => (answer = r));
    });
    let reloaded!: () => void;
    const hydrateAgents = vi.fn(() => new Promise<void>((r) => (reloaded = r)));
    const real = useZenStore.getState().hydrateAgents;
    useZenStore.setState({ hydrateAgents });
    useServersStore.setState({
      servers: [{ id: "a", nickname: "", url: "https://rosson.k2.dev", username: "rosson", rememberPassword: false }],
      tokens: { a: "old" },
    });
    try {
      const onSaved = vi.fn();
      const onCancel = vi.fn();
      render(<OverlayAddServer pairLink={{ serverUrl: "https://rosson.k2.dev", code: CODE }} onCancel={onCancel} onSaved={onSaved} />);
      await flush();
      fireEvent.click(screen.getByTestId("pair-confirm-button"));
      await flush();
      const state = (k: string) => screen.getByTestId(`pair-step-${k}`).getAttribute("data-state");
      expect(screen.queryByTestId("pair-confirm-button")).toBeNull();
      expect(state("pair")).toBe("now");
      // Replacing a signed-in server lists signing it out.
      expect(state("leave")).toBe("next");
      expect((screen.getByTestId("add-server-cancel") as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByTestId("add-server-mode-password") as HTMLButtonElement).disabled).toBe(true);

      await act(async () => onStep("leave"));
      expect(state("pair")).toBe("done");
      expect(state("leave")).toBe("now");
      await act(async () => answer({ ok: true, id: "a", username: "rosson" }));
      expect(state("agents")).toBe("now");
      expect(hydrateAgents).toHaveBeenCalled();
      expect(screen.queryByTestId("pair-success")).toBeNull();

      await act(async () => reloaded());
      expect(screen.getByTestId("pair-success")).not.toBeNull();
      expect(onSaved).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId("pair-done"));
      expect(onSaved).toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();
    } finally {
      useZenStore.setState({ hydrateAgents: real });
    }
  });

  it("Paired names the computer when the server sends serverName (0.46.6)", async () => {
    check.mockResolvedValue({ ok: true, user: "rosson", host: "rosson.k2.dev", expiresInSecs: 500 });
    pair.mockResolvedValue({ ok: true, id: "new", username: "rosson", serverName: "Rosson's MacBook Pro" });
    render(<OverlayAddServer pairLink={{ serverUrl: "https://rosson.k2.dev", code: CODE }} onCancel={() => {}} />);
    await flush();
    fireEvent.click(screen.getByTestId("pair-confirm-button"));
    await flush();
    expect(screen.getByTestId("pair-success-text").textContent).toContain(
      "signed in to Rosson's MacBook Pro (rosson.k2.dev) as rosson"
    );
  });

  it("a failed pairing goes back to the confirm with the error and unlocks Cancel", async () => {
    check.mockResolvedValue({ ok: true, user: "rosson", host: "rosson.k2.dev", expiresInSecs: 500 });
    pair.mockResolvedValue({ ok: false, error: "That code was already used." });
    render(<OverlayAddServer pairLink={{ serverUrl: "https://rosson.k2.dev", code: CODE }} onCancel={() => {}} />);
    await flush();
    fireEvent.click(screen.getByTestId("pair-confirm-button"));
    await flush();
    expect(screen.queryByTestId("pair-progress")).toBeNull();
    expect(screen.getByTestId("pair-confirm").textContent).toContain("That code was already used.");
    expect((screen.getByTestId("add-server-cancel") as HTMLButtonElement).disabled).toBe(false);
  });

  it("warns on a host outside k2.dev and names a saved server it would replace", async () => {
    check.mockResolvedValue({ ok: true, user: "mallory", host: null, expiresInSecs: 500 });
    pair.mockResolvedValue({ ok: false, error: "That code didn't work." });
    useServersStore.setState({
      servers: [{ id: "a", nickname: "Home", url: "https://box.example.com", username: "rosson", rememberPassword: false }],
      tokens: { a: "t" },
    });
    render(<OverlayAddServer pairLink={{ serverUrl: "https://box.example.com", code: CODE }} onCancel={() => {}} />);
    await flush();
    expect(screen.getByTestId("pair-warn-host")).not.toBeNull();
    expect(screen.getByTestId("pair-warn-replace").textContent).toContain("Pairing switches it to mallory");
    fireEvent.click(screen.getByTestId("pair-confirm-button"));
    await flush();
    expect(pair.mock.calls[0][0].replaceId).toBe("a");
  });

  it("typed: pasting the QR link fills the server; a bad code stays on the form", async () => {
    check.mockResolvedValue({ ok: false, kind: "code", error: "That code didn't work." });
    render(<OverlayAddServer onCancel={() => {}} />);
    fireEvent.click(screen.getByTestId("add-server-mode-pair"));
    fireEvent.change(screen.getByTestId("pair-code"), { target: { value: `https://ada.k2.dev/pair#${CODE}` } });
    expect((screen.getByTestId("pair-server") as HTMLInputElement).value).toBe("ada.k2.dev");
    fireEvent.click(screen.getByTestId("pair-continue"));
    await flush();
    expect(screen.getByTestId("pair-error").textContent).toBe("That code didn't work.");
    expect(screen.queryByTestId("pair-confirm")).toBeNull();
  });

  it("a paired server's sign-in opens on Pair again", () => {
    useServersStore.setState({
      servers: [{ id: "a", nickname: "Home", url: "https://a.k2.dev", username: "rosson", rememberPassword: false, auth: "paired" }],
    });
    render(<OverlayAddServer editingId="a" onCancel={() => {}} />);
    expect(screen.getByText("Pair again")).not.toBeNull();
    expect((screen.getByTestId("pair-server") as HTMLInputElement).value).toBe("a.k2.dev");
  });
});
