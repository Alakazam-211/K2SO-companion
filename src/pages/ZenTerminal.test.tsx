// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef, type MutableRefObject } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

// TerminalView opens sockets — stand in with a prop recorder whose
// reload seam is a spy. Its touch layer is simulated with the real
// gesture classifier (sgrMouse) and the real tapRequestsDrive gate, the
// same calls TerminalView's onTouchEnd makes.
const reloadSpy = vi.fn();
const termProps: Array<{
  terminalId: string;
  projectPath: string;
  drive?: boolean;
  hasTapWhileViewing: boolean;
}> = [];
vi.mock("../components/TerminalView", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/TerminalView")>();
  const { movedBeyond, classifyRelease, LONG_PRESS_MS } = await import("../lib/sgrMouse");
  type Gest = { x: number; y: number; t: number; moved: boolean; longPress: boolean };
  return {
    ...actual,
    TerminalView: (p: {
      terminalId: string;
      projectPath: string;
      drive?: boolean;
      onReloadRef?: MutableRefObject<(() => void) | null>;
      onTapWhileViewing?: () => void;
    }) => {
      termProps.push({
        terminalId: p.terminalId,
        projectPath: p.projectPath,
        drive: p.drive,
        hasTapWhileViewing: typeof p.onTapWhileViewing === "function",
      });
      useEffect(() => {
        if (p.onReloadRef) p.onReloadRef.current = reloadSpy;
      });
      const gest = useRef<Gest | null>(null);
      const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
      const selectionUp = useRef(false);
      const stopTimer = () => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
      };
      return (
        <div
          data-testid="terminal-view"
          data-drive={String(Boolean(p.drive))}
          onTouchStart={(e) => {
            const t = e.touches[0];
            gest.current = { x: t.clientX, y: t.clientY, t: Date.now(), moved: false, longPress: false };
            timer.current = setTimeout(() => {
              const g = gest.current;
              if (!g || g.moved) return;
              g.longPress = true;
              selectionUp.current = true;
            }, LONG_PRESS_MS);
          }}
          onTouchMove={(e) => {
            const g = gest.current;
            const t = e.touches[0];
            if (g && !g.moved && movedBeyond(g, t.clientX, t.clientY)) {
              g.moved = true;
              stopTimer();
            }
          }}
          onTouchEnd={() => {
            stopTimer();
            const g = gest.current;
            gest.current = null;
            if (!g) return;
            const kind = classifyRelease({
              moved: g.moved,
              longPressFired: g.longPress,
              durationMs: Date.now() - g.t,
            });
            if (kind === "tap" && selectionUp.current) {
              selectionUp.current = false; // tap clears the selection
              return;
            }
            if (
              actual.tapRequestsDrive({
                kind,
                selectionUp: selectionUp.current,
                drive: Boolean(p.drive),
              })
            ) {
              p.onTapWhileViewing?.();
            }
          }}
        />
      );
    },
  };
});

vi.mock("../api/sendMessage", () => ({
  sendMessageToSession: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../api/client", () => ({
  getProjects: vi.fn(),
  getAgentList: vi.fn(),
  getCliProjectsList: vi.fn(),
  getWorkspaceResources: vi.fn(),
  getFsReadFile: vi.fn(),
  getThread: vi.fn(),
  postThread: vi.fn(),
  answerThread: vi.fn(),
  inspectProjectsSummary: vi.fn(),
  getAllSessions: vi.fn(async () => ({ ok: true, data: [] })),
  spawnSidecarSession: vi.fn(),
  uploadFsBinary: vi.fn(),
  getThreadActivity: vi.fn(async () => ({ ok: true, data: { turn: null } })),
  setTabTitle: vi.fn(),
  setSessionLabel: vi.fn(),
  ensurePinnedChat: vi.fn(),
}));

vi.mock("../api/projectGroups", () => ({
  fetchProjectGroups: vi.fn(async () => ({ ok: true, data: [] })),
  fetchProjectGroupMessages: vi.fn(async () => ({
    ok: true,
    data: { messages: [], truncated: false },
  })),
  postProjectGroupMessage: vi.fn(),
}));

import { ensurePinnedChat, getAllSessions, uploadFsBinary } from "../api/client";
import { sendMessageToSession } from "../api/sendMessage";
import { useServersStore } from "../stores/servers";
import { useWorkspacesStore } from "../stores/workspaces";
import { STUB_AGENTS } from "../zen/stubData";
import { rememberZenThread, zenTerminalPath, type ZenTerminalAgent } from "../zen/terminalJump";
import { useZenStore } from "../zen/zenStore";
import { ThreadPane } from "../zen/ThreadPane";
import { COMPOSER_RADIUS_PX } from "../zen/GlassComposer";
import { ChatSession } from "./ChatSession";
import { Zen } from "./Zen";
import { ZenTerminal } from "./ZenTerminal";

/** MA21: the session token lives in the servers store (Zen reads it from
 *  its scope), not a mocked `getToken`. "" = signed out (stub list). */
function setSessionToken(token: string) {
  useServersStore.setState((s) => ({
    tokens: token ? { ...s.tokens, s1: token } : {},
  }));
}


const AGENT: ZenTerminalAgent = {
  agentId: STUB_AGENTS[0].id,
  name: "Appa",
  initial: "A",
  color: "#123456",
  iconUrl: "https://example.k2.dev/icon.png",
  chatTitle: null,
  projectPath: "/ws/appa",
};

function Loc() {
  const loc = useLocation();
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>;
}

function renderAt(entry: { pathname: string; state?: unknown } | string, withZen = false) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/zen/terminal/:terminalId" element={<ZenTerminal />} />
        <Route path="/chat/:terminalId" element={<ChatSession />} />
        <Route path="/zen" element={withZen ? <Zen /> : <Loc />} />
        <Route path="*" element={<Loc />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  termProps.length = 0;
  reloadSpy.mockReset();
  useServersStore.setState({
    servers: [
      { id: "s1", nickname: "test", url: "https://example.k2.dev", username: "u", rememberPassword: false },
    ],
    activeServerId: "s1",
    hydrated: true,
    tokens: { s1: "t" },
    recovery: { s1: "connected" },
  });
  // The old `getToken` mock defaulted to "" (signed out).
  setSessionToken("");
  useWorkspacesStore.setState({ allSessions: [], projects: [] });
  useZenStore.setState({ agents: [], agentId: "", screen: "list" });
  rememberZenThread(null);
  vi.mocked(sendMessageToSession).mockClear();
  vi.mocked(uploadFsBinary).mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ZenTerminal", () => {
  it("renders the glass header: Done, avatar, name, Terminal subtitle, Viewer/Claimer, reload", () => {
    renderAt({ pathname: zenTerminalPath("t1"), state: { agent: AGENT } });
    const header = screen.getByTestId("zen-terminal-header");
    const blur = screen.getByTestId("zen-terminal-header-blur");
    expect(header.contains(blur)).toBe(true);
    expect(blur.querySelectorAll("[class^='zen-header-blur-']").length).toBe(4);
    expect(blur.querySelector(".zen-header-tint")).not.toBeNull();

    expect(screen.getByTestId("zen-terminal-title").textContent).toBe("Appa");
    expect(screen.getByTestId("zen-terminal-subtitle").textContent).toBe("Terminal");
    expect(
      screen.getByTestId("zen-terminal-avatar").querySelector("img")?.getAttribute("src")
    ).toBe(AGENT.iconUrl);

    const done = screen.getByTestId("zen-terminal-done");
    expect(done.textContent).toBe("Done");
    expect(done.className).toMatch(/zen-glass/);
    expect(done.className).toMatch(/zen-glass-pill/);
    expect(done.className).toMatch(/text-\[17px\]/);
    expect(done.style.height).toBe("34px");
    expect(screen.queryByRole("button", { name: "Back to chat" })).toBeNull();

    const group = screen.getByRole("group", { name: "Viewer or claimer" });
    expect(group.className).toMatch(/zen-glass/);
    expect(screen.getByRole("button", { name: "Reload session" }).className).toMatch(/zen-glass/);
    // No thread door in this header — Done is the only way out.
    expect(screen.queryByRole("button", { name: "Chat" })).toBeNull();

    expect(termProps[termProps.length - 1]).toEqual({ terminalId: "t1", projectPath: "/ws/appa", drive: false, hasTapWhileViewing: true });
  });

  it("Viewer/Claimer switches drive on the same TerminalView", () => {
    renderAt({ pathname: zenTerminalPath("t1"), state: { agent: AGENT } });
    const watch = screen.getByRole("button", { name: "Viewer — watch only" });
    const claim = screen.getByRole("button", { name: "Claimer — type and resize" });
    expect(watch.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(claim);
    expect(claim.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("terminal-view").getAttribute("data-drive")).toBe("true");
    fireEvent.click(watch);
    expect(screen.getByTestId("terminal-view").getAttribute("data-drive")).toBe("false");
  });

  it("focusing the composer in view mode switches to Drive (pencil), keeping focus", () => {
    renderAt({ pathname: zenTerminalPath("t1"), state: { agent: AGENT } });
    const claim = screen.getByRole("button", { name: "Claimer — type and resize" });
    const input = screen.getByTestId("terminal-composer-input") as HTMLTextAreaElement;
    expect(claim.getAttribute("aria-pressed")).toBe("false");
    expect(termProps[termProps.length - 1].drive).toBe(false);
    act(() => input.focus());
    expect(claim.getAttribute("aria-pressed")).toBe("true");
    expect(termProps[termProps.length - 1].drive).toBe(true);
    expect(screen.getByTestId("terminal-view").getAttribute("data-drive")).toBe("true");
    // Same field, still focused — no blur, no re-mount (keyboard stays up).
    expect(screen.getByTestId("terminal-composer-input")).toBe(input);
    expect(document.activeElement).toBe(input);
  });

  it("focusing the composer in Drive mode is a no-op, and never flips back to view", () => {
    renderAt({ pathname: zenTerminalPath("t1"), state: { agent: AGENT } });
    const claim = screen.getByRole("button", { name: "Claimer — type and resize" });
    fireEvent.click(claim);
    expect(claim.getAttribute("aria-pressed")).toBe("true");
    const renders = termProps.length;
    const input = screen.getByTestId("terminal-composer-input") as HTMLTextAreaElement;
    act(() => input.focus());
    act(() => input.blur());
    act(() => input.focus());
    expect(claim.getAttribute("aria-pressed")).toBe("true");
    expect(termProps.length).toBe(renders);
    expect(screen.getByTestId("terminal-view").getAttribute("data-drive")).toBe("true");
  });

  describe("tapping the terminal in view mode claims Drive", () => {
    const touch = (x: number, y: number) => ({ touches: [{ clientX: x, clientY: y }] });
    const tap = (el: HTMLElement) => {
      fireEvent.touchStart(el, touch(100, 100));
      fireEvent.touchEnd(el, { touches: [] });
      fireEvent.click(el); // the synthetic click iOS sends after a tap
    };
    const setup = () => {
      renderAt({ pathname: zenTerminalPath("t1"), state: { agent: AGENT } });
      return {
        claim: screen.getByRole("button", { name: "Claimer — type and resize" }),
        watch: screen.getByRole("button", { name: "Viewer — watch only" }),
        term: () => screen.getByTestId("terminal-view"),
      };
    };
    afterEach(() => {
      vi.useRealTimers();
    });

    it("a tap switches to Drive (pencil pressed), same as the pencil", () => {
      const { claim, watch, term } = setup();
      expect(claim.getAttribute("aria-pressed")).toBe("false");
      tap(term());
      expect(claim.getAttribute("aria-pressed")).toBe("true");
      expect(watch.getAttribute("aria-pressed")).toBe("false");
      expect(term().getAttribute("data-drive")).toBe("true");
      expect(termProps[termProps.length - 1].drive).toBe(true);
    });

    it("direct send: the tap focuses the live input in the same gesture", () => {
      const { claim, term } = setup();
      fireEvent.click(screen.getByRole("button", { name: "Switch to direct typing" }));
      const capture = screen
        .getByTestId("zen-terminal-direct-bar")
        .querySelector("input") as HTMLInputElement;
      expect(document.activeElement).not.toBe(capture);
      // touchend alone (no synthetic click) — focus is synchronous there.
      fireEvent.touchStart(term(), touch(100, 100));
      fireEvent.touchEnd(term(), { touches: [] });
      expect(claim.getAttribute("aria-pressed")).toBe("true");
      expect(document.activeElement).toBe(capture);
      fireEvent.click(screen.getByRole("button", { name: "Switch to safe send" }));
    });

    it("a scroll drag does not switch", () => {
      const { claim, term } = setup();
      fireEvent.touchStart(term(), touch(100, 100));
      fireEvent.touchMove(term(), touch(100, 130));
      fireEvent.touchMove(term(), touch(100, 200));
      fireEvent.touchEnd(term(), { touches: [] });
      expect(claim.getAttribute("aria-pressed")).toBe("false");
      expect(term().getAttribute("data-drive")).toBe("false");
    });

    it("a small wobble within the tap slop still counts as a tap", () => {
      const { claim, term } = setup();
      fireEvent.touchStart(term(), touch(100, 100));
      fireEvent.touchMove(term(), touch(104, 105));
      fireEvent.touchEnd(term(), { touches: [] });
      expect(claim.getAttribute("aria-pressed")).toBe("true");
    });

    it("a long-press selection does not switch, nor does the tap that clears it", () => {
      vi.useFakeTimers();
      const { claim, term } = setup();
      fireEvent.touchStart(term(), touch(100, 100));
      act(() => {
        vi.advanceTimersByTime(600);
      });
      fireEvent.touchMove(term(), touch(160, 100)); // drag the selection
      fireEvent.touchEnd(term(), { touches: [] });
      expect(claim.getAttribute("aria-pressed")).toBe("false");
      tap(term()); // tap-elsewhere clears the selection, nothing else
      expect(claim.getAttribute("aria-pressed")).toBe("false");
      tap(term()); // the next plain tap claims
      expect(claim.getAttribute("aria-pressed")).toBe("true");
    });

    it("in Drive a tap is a no-op, and it never flips back to view", () => {
      const { claim, term } = setup();
      fireEvent.click(claim);
      const renders = termProps.length;
      tap(term());
      tap(term());
      expect(claim.getAttribute("aria-pressed")).toBe("true");
      expect(termProps.length).toBe(renders);
      expect(term().getAttribute("data-drive")).toBe("true");
    });
  });

  it("Viewer/Claimer is a segmented control: the selected thumb stays inside the pill", () => {
    renderAt({ pathname: zenTerminalPath("t1"), state: { agent: AGENT } });
    const group = screen.getByRole("group", { name: "Viewer or claimer" });
    // Container clips and pads; fixed iOS segmented height.
    expect(group.className).toMatch(/zen-glass-pill/);
    expect(group.style.overflow).toBe("hidden");
    expect(group.style.position).toBe("relative");
    const pad = parseFloat(group.style.padding);
    expect(pad).toBeGreaterThanOrEqual(2);
    expect(pad).toBeLessThanOrEqual(3);
    const h = parseFloat(group.style.height);
    expect(h).toBeGreaterThanOrEqual(30);
    expect(h).toBeLessThanOrEqual(32);

    // Thumb is inset by the padding, radius = outer radius − padding.
    const thumb = group.querySelector("[data-k2='watch-drive-thumb']") as HTMLElement;
    expect(thumb).not.toBeNull();
    expect(thumb.getAttribute("aria-hidden")).toBe("true");
    expect(thumb.style.position).toBe("absolute");
    expect(thumb.style.top).toBe(`${pad}px`);
    expect(thumb.style.bottom).toBe(`${pad}px`);
    expect(thumb.style.left).toBe(`${pad}px`);
    expect(thumb.style.width).toBe(`calc(50% - ${pad}px)`);
    expect(thumb.style.borderRadius).toBe(`${h / 2 - pad}px`);

    // Buttons carry no fill of their own — only the inset thumb highlights.
    const watch = screen.getByRole("button", { name: "Viewer — watch only" });
    const claim = screen.getByRole("button", { name: "Claimer — type and resize" });
    expect(watch.style.background).toBe("");
    expect(claim.style.background).toBe("");
    expect(watch.style.width).toBe(claim.style.width);

    // Toggling slides the thumb and moves the selection.
    expect(thumb.style.transform).toBe("translateX(0%)");
    expect(watch.hasAttribute("data-selected")).toBe(true);
    expect(claim.hasAttribute("data-selected")).toBe(false);
    fireEvent.click(claim);
    expect(thumb.style.transform).toBe("translateX(100%)");
    expect(claim.hasAttribute("data-selected")).toBe(true);
    expect(watch.hasAttribute("data-selected")).toBe(false);
    fireEvent.click(watch);
    expect(thumb.style.transform).toBe("translateX(0%)");
  });

  it("compact header: one row, Done → small avatar → name over Terminal → controls", () => {
    renderAt({ pathname: zenTerminalPath("t1"), state: { agent: AGENT } });
    const row = screen.getByTestId("zen-terminal-header-row");
    expect(row.className).toMatch(/\bflex\b/);
    expect(row.className).not.toMatch(/\bgrid\b/);
    const h = parseInt(row.style.height, 10);
    expect(h).toBeGreaterThanOrEqual(44);
    expect(h).toBeLessThanOrEqual(48);

    const kids = Array.from(row.children);
    const done = screen.getByTestId("zen-terminal-done");
    const avatar = screen.getByTestId("zen-terminal-avatar");
    const titles = screen.getByTestId("zen-terminal-titles");
    expect(kids.indexOf(done)).toBe(0);
    expect(kids.indexOf(avatar)).toBe(1);
    expect(kids.indexOf(titles)).toBe(2);
    expect(kids[3].contains(screen.getByRole("group", { name: "Viewer or claimer" }))).toBe(true);
    expect(kids[3].contains(screen.getByRole("button", { name: "Reload session" }))).toBe(true);

    // Avatar shrank to ~28px; name and "Terminal" stack to its right.
    const img = avatar.querySelector("img") as HTMLElement;
    expect((img.parentElement as HTMLElement).style.width || img.style.width).toBe("28px");
    const title = screen.getByTestId("zen-terminal-title");
    const sub = screen.getByTestId("zen-terminal-subtitle");
    expect(Array.from(titles.children)).toEqual([title, sub]);
    expect(titles.className).toMatch(/flex-col/);
    expect(title.className).toMatch(/text-\[15px\]/);
    expect(title.className).toMatch(/font-semibold/);
    expect(title.className).toMatch(/truncate/);
    expect(sub.className).toMatch(/text-\[12px\]/);
    expect(sub.textContent).toBe("Terminal");
  });

  it("Done restores the agent's Zen thread, not /sessions", async () => {
    renderAt({ pathname: zenTerminalPath("t1"), state: { agent: AGENT } }, true);
    fireEvent.click(screen.getByTestId("zen-terminal-done"));
    await waitFor(() => expect(useZenStore.getState().screen).toBe("thread"));
    expect(useZenStore.getState().agentId).toBe(AGENT.agentId);
    expect(screen.getByTestId("thread-column")).not.toBeNull();
    expect(screen.queryByTestId("zen-terminal")).toBeNull();
  });

  it("without router state, back uses the remembered thread", () => {
    rememberZenThread("/ws/remembered");
    renderAt(zenTerminalPath("t1"));
    fireEvent.click(screen.getByTestId("zen-terminal-done"));
    expect(screen.getByTestId("loc").textContent).toBe("/zen?thread=%2Fws%2Fremembered");
  });

  it("without router state, looks the agent up in the Zen store by terminal id", () => {
    useZenStore.setState({
      agents: [{ id: "/ws/b::b-2", name: "Bee", initial: "B", path: "/ws/b", addr: "b-2", terminalId: "t9" }],
    });
    renderAt(zenTerminalPath("t9"));
    expect(screen.getByTestId("zen-terminal-title").textContent).toBe("Bee");
    fireEvent.click(screen.getByTestId("zen-terminal-done"));
    expect(screen.getByTestId("loc").textContent).toBe("/zen?thread=%2Fws%2Fb%3A%3Ab-2");
  });

  it("with nothing to go on, shows a generic header and back goes to /zen", () => {
    renderAt(zenTerminalPath("t1"));
    expect(screen.getByTestId("zen-terminal-title").textContent).toBe("Terminal");
    fireEvent.click(screen.getByTestId("zen-terminal-done"));
    expect(screen.getByTestId("loc").textContent).toBe("/zen");
  });

  it("reload calls the TerminalView reload seam", async () => {
    vi.useFakeTimers();
    renderAt({ pathname: zenTerminalPath("t1"), state: { agent: AGENT } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reload session" }));
    });
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
  });

  it("a respawned main chat stays on the Zen terminal page with its agent", async () => {
    const main = {
      terminalId: "t-old",
      cwd: "/ws/appa",
      isMainChat: true,
      workspaceName: "appa",
      workspaceId: "w",
      workspaceColor: "#000",
      agentName: "appa",
      label: "main",
    };
    useWorkspacesStore.setState({ allSessions: [main] });
    vi.mocked(getAllSessions).mockResolvedValueOnce({
      ok: true,
      data: [{ ...main, terminalId: "t-new" }],
    } as never);
    vi.mocked(ensurePinnedChat).mockResolvedValueOnce({
      ok: true,
      data: { sessionId: "t-new" },
    } as never);
    renderAt({ pathname: zenTerminalPath("t-old"), state: { agent: AGENT } });
    fireEvent.click(screen.getByRole("button", { name: "Reload session" }));
    await waitFor(() => expect(termProps[termProps.length - 1]?.terminalId).toBe("t-new"));
    expect(ensurePinnedChat).toHaveBeenCalledWith(expect.anything(), "/ws/appa", { forceRespawn: true });
    expect(screen.getByTestId("zen-terminal-title").textContent).toBe("Appa");
  });

  it("composer is the thread's glass field: ＋ and send inside, send disabled when empty", () => {
    renderAt({ pathname: zenTerminalPath("t1"), state: { agent: AGENT } });
    const field = screen.getByTestId("terminal-composer-field");
    const attach = screen.getByTestId("terminal-composer-attach");
    const input = screen.getByTestId("terminal-composer-input");
    const send = screen.getByTestId("terminal-composer-send");
    expect(Array.from(field.children)).toEqual([attach, input, send]);
    expect(field.className).toMatch(/k2-tile/);
    expect(field.style.borderRadius).toBe(`${COMPOSER_RADIUS_PX}px`);
    expect(attach.textContent).toBe("＋");
    expect(send.getAttribute("type")).toBe("submit");
    expect(send).toHaveProperty("disabled", true);
    fireEvent.change(input, { target: { value: "  " } });
    expect(send).toHaveProperty("disabled", true);
    fireEvent.change(input, { target: { value: "ls" } });
    expect(send).toHaveProperty("disabled", false);
    expect(send.style.background).toBe("rgb(10, 132, 255)");
    expect(screen.getByTestId("terminal-composer-bar").className).toMatch(/zen-composer-bar/);
    expect(input.closest("[data-k2-variant='zen']")).not.toBeNull();
    // Send keeps the keyboard up.
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    send.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });

  it("composer markup matches the Zen thread composer", () => {
    const shape = (prefix: string) => {
      const field = screen.getByTestId(`${prefix}-field`);
      return {
        bar: screen.getByTestId(`${prefix}-bar`).className,
        form: screen.getByTestId(`${prefix}-form`).className,
        field: field.className,
        kids: Array.from(field.children).map((el) => [
          el.tagName,
          el.className,
          el.getAttribute("type"),
          el.getAttribute("aria-label"),
        ]),
        inputStyle: screen.getByTestId(`${prefix}-input`).getAttribute("style"),
      };
    };
    renderAt({ pathname: zenTerminalPath("t1"), state: { agent: AGENT } });
    const term = shape("terminal-composer");
    cleanup();
    useZenStore.setState({
      threadSource: "live",
      threadAddr: "appa",
      threadGroupId: null,
      threadError: null,
      sendError: null,
      sending: false,
      thread: [],
    });
    useZenStore.setState({
      agentId: STUB_AGENTS[0].id,
      agents: [{ ...STUB_AGENTS[0], name: "Appa", addr: "appa" }],
    });
    render(<ThreadPane />);
    // Same placeholder rule: both read "Message Appa" (aria-label too).
    expect(screen.getByTestId("composer-input").getAttribute("placeholder")).toBe(
      "Message Appa"
    );
    expect(shape("composer")).toEqual(term);
  });

  it("composer placeholder: Message <Agent> on a main terminal", () => {
    renderAt({ pathname: zenTerminalPath("t1"), state: { agent: { ...AGENT, addr: "appa" } } });
    const input = screen.getByTestId("terminal-composer-input");
    expect(input.getAttribute("placeholder")).toBe("Message Appa");
    expect(input.getAttribute("aria-label")).toBe("Message Appa");
  });

  it("composer placeholder: Message <Agent>/<sidecar> on a sidecar terminal", () => {
    renderAt({
      pathname: zenTerminalPath("t1"),
      state: { agent: { ...AGENT, addr: "appa/reviewer", chatTitle: "Renamed" } },
    });
    expect(screen.getByTestId("terminal-composer-input").getAttribute("placeholder")).toBe(
      "Message Appa/reviewer"
    );
  });

  it("composer placeholder: a drawer terminal (main addr) uses its title", () => {
    renderAt({
      pathname: zenTerminalPath("t1"),
      state: { agent: { ...AGENT, addr: "appa", chatTitle: "codex" } },
    });
    expect(screen.getByTestId("terminal-composer-input").getAttribute("placeholder")).toBe(
      "Message Appa/codex"
    );
  });

  it("composer placeholder falls back to Message without a name", () => {
    renderAt({ pathname: zenTerminalPath("t1"), state: { agent: { ...AGENT, name: "" } } });
    expect(screen.getByTestId("terminal-composer-input").getAttribute("placeholder")).toBe(
      "Message"
    );
  });

  it("the Zen thread composer is unaffected by the terminal's focus-to-Drive", () => {
    useZenStore.setState({
      threadSource: "live",
      threadAddr: "appa",
      threadGroupId: null,
      threadError: null,
      sendError: null,
      sending: false,
      thread: [],
    });
    render(<ThreadPane />);
    const input = screen.getByTestId("composer-input") as HTMLTextAreaElement;
    act(() => input.focus());
    expect(document.activeElement).toBe(input);
    expect(screen.queryByTestId("terminal-view")).toBeNull();
    expect(screen.queryByRole("group", { name: "Viewer or claimer" })).toBeNull();
    expect(termProps.length).toBe(0);
  });

  it("sending goes through the terminal send path (sendMessageToSession)", async () => {
    renderAt({ pathname: zenTerminalPath("t1"), state: { agent: AGENT } });
    const input = screen.getByPlaceholderText("Message Appa");
    fireEvent.change(input, { target: { value: "line one\nline two" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(sendMessageToSession).toHaveBeenCalledWith(expect.anything(), "t1", "line one\nline two")
    );
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(""));
  });

  it("Send clears the field at once, before the send answers", async () => {
    let answer!: (v: { ok: true }) => void;
    vi.mocked(sendMessageToSession).mockImplementationOnce(
      () => new Promise((ok) => (answer = ok as never))
    );
    renderAt({ pathname: zenTerminalPath("t1"), state: { agent: AGENT } });
    const input = screen.getByPlaceholderText("Message Appa") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(input.value).toBe("");
    expect(input.disabled).toBe(false);
    await act(async () => answer({ ok: true }));
    expect(input.value).toBe("");
  });

  it("a failed send puts the text back and says why", async () => {
    let answer!: (v: unknown) => void;
    vi.mocked(sendMessageToSession).mockImplementationOnce(
      () => new Promise((ok) => (answer = ok as never))
    );
    renderAt({ pathname: zenTerminalPath("t1"), state: { agent: AGENT } });
    const input = screen.getByPlaceholderText("Message Appa") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(input.value).toBe("");
    // Typed more while it was in flight: nothing is lost.
    fireEvent.change(input, { target: { value: "next" } });
    await act(async () => answer({ ok: false, message: "session gone" }));
    expect(input.value).toBe("hello\nnext");
    expect(screen.getByText("session gone")).not.toBeNull();
  });

  it("＋ uploads into the agent workspace .k2/downloads and puts the path in the draft", async () => {
    vi.mocked(uploadFsBinary).mockResolvedValueOnce({
      ok: true,
      data: { path: "/ws/appa/.k2/downloads/note.txt" },
    } as never);
    renderAt({
      pathname: zenTerminalPath("t1"),
      state: { agent: { ...AGENT, addr: "appa" } },
    });
    const attach = screen.getByTestId("terminal-composer-attach");
    expect(attach).toHaveProperty("disabled", false);
    const input = screen.getByTestId("terminal-composer-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "read this" } });
    const file = new File(["hi"], "note.txt", { type: "text/plain" });
    fireEvent.change(screen.getByTestId("terminal-composer-file-input"), {
      target: { files: [file] },
    });
    await waitFor(() => expect(input.value).toBe("read this /ws/appa/.k2/downloads/note.txt "));
    // Same folder and naming as the thread composer (`uploadDirOf`).
    expect(vi.mocked(uploadFsBinary).mock.calls[0].slice(1, 4)).toEqual([
      "appa",
      "/ws/appa/.k2/downloads",
      "note.txt",
    ]);
    expect(sendMessageToSession).not.toHaveBeenCalled();
  });

  it("＋ is disabled without a workspace (no addr)", () => {
    renderAt({ pathname: zenTerminalPath("t1"), state: { agent: AGENT } });
    expect(screen.getByTestId("terminal-composer-attach")).toHaveProperty("disabled", true);
  });

  it("direct mode: accessory keys are glass pills, no casing around the row", () => {
    renderAt({ pathname: zenTerminalPath("t1"), state: { agent: AGENT } });
    fireEvent.click(screen.getByRole("button", { name: "Switch to direct typing" }));
    const bar = screen.getByRole("toolbar", { name: "Terminal keys" });
    const wrap = screen.getByTestId("zen-terminal-direct-bar");
    for (const el of [wrap, bar, bar.parentElement as HTMLElement]) {
      expect(el.className).not.toMatch(/k2-tile|zen-glass|border|shadow/);
    }
    for (const key of Array.from(bar.querySelectorAll("button"))) {
      expect(key.className).toMatch(/zen-glass zen-glass-pill/);
      expect(key.style.height).toBe("32px");
    }
    expect(screen.queryByRole("button", { name: "Return" })).toBeNull();
    expect(screen.getByRole("button", { name: "Hide keyboard" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Switch to safe send" }));
  });
});

describe("old /chat/:id page is unchanged", () => {
  it("keeps its classic chrome and back to /sessions", () => {
    renderAt("/chat/t1");
    expect(screen.queryByTestId("zen-terminal")).toBeNull();
    // No tap-to-claim on the classic page: the prop is never passed.
    expect(termProps.length).toBeGreaterThan(0);
    expect(termProps.every((p) => !p.hasTapWhileViewing)).toBe(true);
    const term = screen.getByTestId("terminal-view");
    fireEvent.touchStart(term, { touches: [{ clientX: 50, clientY: 50 }] });
    fireEvent.touchEnd(term, { touches: [] });
    expect(term.getAttribute("data-drive")).toBe("false");
    const field = screen.getByPlaceholderText(/Message the agent…/);
    expect(field.closest("[data-k2-variant='zen']")).toBeNull();
    expect(field.className).toMatch(/border-\[var\(--accent-dim\)\]/);
    expect(screen.queryByRole("button", { name: "Add file" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send" }).className).toMatch(/w-11 h-11 border/);
    expect(screen.getByRole("button", { name: "Chat" })).not.toBeNull();
    const back = document.querySelector("button.-ml-2") as HTMLButtonElement;
    fireEvent.click(back);
    expect(screen.getByTestId("loc").textContent).toBe("/sessions");
  });
});
