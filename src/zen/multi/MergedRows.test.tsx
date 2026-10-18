// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { RemoteAgentRow, ServerPlaceholderRow } from "./MergedRows";
import type { MergedRow } from "./merge";

afterEach(() => cleanup());

const row: MergedRow = {
  key: "s2:/a",
  address: "alpha@lab",
  serverId: "s2",
  hostKey: "lab",
  serverLabel: "Lab",
  active: false,
  workspaceId: null,
  agent: { id: "/a", name: "alpha", initial: "A", path: "/a", addr: "alpha", kind: "agent" },
};
const noop = () => {};

describe("Other servers' rows: dividers", () => {
  it("a remote row draws the shared hairline when asked, inset to the text column", () => {
    render(
      <RemoteAgentRow row={row} failure={null} busy={null} when="" iconUrl={null} inset="20px" divider onOpen={noop} onAction={noop} />
    );
    const d = within(screen.getByTestId("remote-row")).getByTestId("row-divider");
    expect(d.style.left).toBe("calc(80px)");
    expect(d.style.right).toBe("20px");
  });

  it("no divider by default (a section's last row), and none on placeholder rows", () => {
    render(
      <>
        <RemoteAgentRow row={row} failure={null} busy={null} when="" iconUrl={null} inset="20px" onOpen={noop} onAction={noop} />
        <ServerPlaceholderRow serverId="s3" label="Box" failure={null} note="Loading…" inset="20px" onAction={noop} />
      </>
    );
    expect(screen.queryAllByTestId("row-divider")).toHaveLength(0);
  });
});
