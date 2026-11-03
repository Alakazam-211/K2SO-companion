// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const api = vi.hoisted(() => ({
  feed: vi.fn(),
  page: vi.fn(),
  frame: vi.fn(),
  report: vi.fn(),
  call: vi.fn(),
}));
vi.mock("./gardensApi", async (orig) => ({
  ...(await orig<typeof import("./gardensApi")>()),
  fetchGardenFeed: api.feed,
  fetchGardenPage: api.page,
  fetchGardenFrame: api.frame,
  reportGardenFrame: api.report,
  callGardenVerb: api.call,
}));
vi.mock("../zenScope", async () => (await import("../../test/zenScopeMock")).zenScopeModule);

import { ZenGardens } from "../../pages/ZenGardens";
import { fakeScope } from "../../test/fakeScope";
import { setZenScope } from "../../test/zenScopeMock";
import { screensOf, shouldRun, stackHeight } from "./gardenLayout";
import { answerHostVerb, layoutOf, switchAllowed, type HostContext } from "./hostVerbs";
import type { GardenPageBody } from "./gardensApi";

const FEED = {
  serverId: "s",
  person: "owner",
  setUp: true,
  cursor: "c",
  full: true,
  gardens: [
    { id: "g1", name: "Garden 1", index: 1, version: "v" },
    { id: "g2", name: "Diary", index: 2, version: "v" },
  ],
};

const body = (over: Partial<GardenPageBody["page"]> = {}, runs: GardenPageBody["remote"]["widgets"] = []): GardenPageBody => ({
  schema: 1,
  version: "v",
  garden: { id: "g1", name: "Garden 1", index: 1 },
  page: {
    layout: { columns: [{ widget: "b1" }] },
    widgets: [{ id: "b1", kind: "custom", column: 0, name: "Board" }],
    ...over,
  },
  remote: { widgets: runs.length ? runs : [{ id: "b1", run: "frame" }] },
});

const FRAME = {
  garden: "g1",
  placement: "b1",
  widget: "board",
  hash: "h",
  nonce: "n",
  srcdoc: "<!doctype html><p>hi</p>",
  libs: [],
  hello: { k2: "hello" },
};

function open(path = "/zen/gardens") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ZenGardens />
    </MemoryRouter>
  );
}

beforeEach(() => {
  setZenScope(fakeScope({ id: "s1" }));
  for (const f of Object.values(api)) f.mockReset();
  api.feed.mockResolvedValue({ ok: true, data: FEED });
  api.page.mockResolvedValue({ ok: true, data: body() });
  api.frame.mockResolvedValue({ ok: true, data: FRAME });
});
afterEach(() => cleanup());

describe("the Gardens screen", () => {
  it("lists the feed; a row opens that Garden", async () => {
    open();
    await waitFor(() => expect(screen.getAllByTestId("gardens-row")).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId("gardens-row")[0]);
    await waitFor(() => expect(screen.getByTestId("garden-frame")).toBeTruthy());
    expect(screen.getByTestId("gardens-title").textContent).toBe("Garden 1");
  });

  it("a widget's frame is sandboxed with allow-scripts and nothing else", async () => {
    open("/zen/gardens?garden=g1");
    const f = await screen.findByTestId("garden-frame");
    expect(f.getAttribute("sandbox")).toBe("allow-scripts");
    expect(f.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(f.getAttribute("srcdoc")).toContain("<p>hi</p>");
  });

  it.each([
    ["garden_device_only", "Pair this phone."],
    ["garden_person_only", "Only the owner."],
    ["device_session_ended", "Pair again."],
  ])("%s: shows the server's own words", async (code, hint) => {
    api.feed.mockResolvedValue({ ok: false, refusal: { status: 403, code, hint } });
    open();
    expect((await screen.findByTestId("gardens-problem")).textContent).toBe(hint);
  });

  it("a Zen never turned on says so", async () => {
    api.feed.mockResolvedValue({ ok: true, data: { ...FEED, setUp: false, gardens: [] } });
    open();
    expect((await screen.findByTestId("gardens-empty")).textContent).toContain("No Gardens on");
  });

  it("an unknown page schema asks for an update", async () => {
    api.page.mockResolvedValue({ ok: true, data: { ...body(), schema: 2 } });
    open("/zen/gardens?garden=g1");
    expect((await screen.findByTestId("garden-problem")).textContent).toContain("Update K2");
  });

  it("the session ending anywhere in a Garden clears it", async () => {
    api.page.mockResolvedValue({ ok: false, refusal: { status: 403, code: "device_session_ended", hint: "Pair again." } });
    open("/zen/gardens?garden=g1");
    expect((await screen.findByTestId("gardens-problem")).textContent).toBe("Pair again.");
    await act(async () => {});
    expect(screen.queryByTestId("garden-view")).toBeNull();
  });

  it("a page's desktop-only piece points to the computer; an empty Garden says so", async () => {
    api.page.mockResolvedValue({
      ok: true,
      data: body(
        {
          widgets: [
            { id: "rail", kind: "rail", column: 0, name: "Rail" },
            { id: "e", kind: "garden-empty", column: 0 },
          ],
        },
        [
          { id: "rail", run: "placeholder", reason: "desktop_only" },
          { id: "e", run: "native" },
        ]
      ),
    });
    open("/zen/gardens?garden=g1");
    expect((await screen.findByTestId("garden-placeholder")).textContent).toBe("Rail: open this on your computer.");
    expect(screen.getByTestId("garden-empty").textContent).toContain("Ask an agent");
  });
});

describe("a Garden laid out on a phone", () => {
  it("one screen per column that has something, widgets in page order", () => {
    const s = screensOf(
      body(
        {
          layout: { columns: [{ label: "Left" }, {}, { label: "Right" }] },
          widgets: [
            { id: "a", kind: "custom", column: 0 },
            { id: "c", kind: "custom", column: 2 },
            { id: "b", kind: "custom", column: 0 },
          ],
        },
        [
          { id: "a", run: "frame" },
          { id: "b", run: "frame" },
          { id: "c", run: "native" },
        ]
      )
    );
    expect(s.map((x) => [x.label, x.slots.map((y) => y.widget.id)])).toEqual([
      ["Left", ["a", "b"]],
      ["Right", ["c"]],
    ]);
  });

  it("the stacked height rule", () => {
    expect(stackHeight(undefined, 700)).toBe(420);
    expect(stackHeight(undefined, 100)).toBe(160);
    expect(stackHeight(50, 700)).toBe(160);
    expect(stackHeight(500, 700)).toBe(500);
    expect(stackHeight(9000, 700)).toBe(2100);
  });

  it("runs the screen in view and its neighbours only", () => {
    expect([0, 1, 2, 3].map((i) => shouldRun(i, 1))).toEqual([true, true, true, false]);
  });
});

describe("verbs the phone answers (§5.2)", () => {
  const page = body({ layout: { columns: [{ collapsible: true }, { label: "Two" }] } });
  const ctx = (over: Partial<HostContext> = {}): HostContext => ({
    feed: FEED.gardens,
    page,
    scheme: "dark",
    switchGarden: vi.fn(),
    folds: new Map(),
    setFold: vi.fn(() => true),
    ...over,
  });
  const limit = () => ({ loadedAt: 0, lastAt: null as number | null });

  it("gardens.list and gardens.current", () => {
    expect(answerHostVerb(ctx(), limit(), "gardens.list", [], false, 9000)).toEqual({
      ok: true,
      value: [
        { id: "g1", name: "Garden 1", index: 1 },
        { id: "g2", name: "Diary", index: 2 },
      ],
    });
    expect(answerHostVerb(ctx(), limit(), "gardens.current", [], false, 9000)).toMatchObject({ value: { id: "g1" } });
  });

  it("gardens.switch: never in the first 2 s, then once every 2 s, known Gardens only", () => {
    const c = ctx();
    const l = limit();
    expect(switchAllowed(l, 1000)).toBe(false);
    expect(answerHostVerb(c, l, "gardens.switch", [{ garden: "g2" }], false, 1000)).toMatchObject({ error: { code: "rate_limited" } });
    expect(answerHostVerb(c, l, "gardens.switch", [{ garden: "nope" }], false, 3000)).toMatchObject({ error: { code: "not_found" } });
    expect(answerHostVerb(c, l, "gardens.switch", [{ garden: "g2" }], false, 3000).ok).toBe(true);
    expect(c.switchGarden).toHaveBeenCalledWith("g2");
    expect(answerHostVerb(c, l, "gardens.switch", [{ garden: "g2" }], false, 4000).ok).toBe(false);
  });

  it("layout.*: labels, press window, collapsible only", () => {
    expect(layoutOf(ctx()).columns.map((c) => c.label)).toEqual(["Column 1", "Two"]);
    const c = ctx();
    expect(answerHostVerb(c, limit(), "layout.toggle", [{ column: 0 }], false, 0)).toMatchObject({ error: { message: "needs a tap" } });
    expect(answerHostVerb(c, limit(), "layout.toggle", [{ column: 1 }], true, 0).ok).toBe(false);
    expect(answerHostVerb(c, limit(), "layout.toggle", [{ column: 0 }], true, 0).ok).toBe(true);
    expect(c.setFold).toHaveBeenCalledWith(0, true);
  });
});
