// @vitest-environment jsdom
// The Agents / Home lists re-render on activity polls, search keystrokes
// and unread changes. A row's line two is parsed once per message (and is
// the same object), and a row whose drawn values did not change is not
// re-rendered.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const renders = vi.hoisted(() => ({ avatar: 0 }));
vi.mock("./WorkspaceAvatar", () => ({
  WorkspaceAvatar: () => {
    renders.avatar++;
    return null;
  },
}));

import { AgentRowContent } from "./AgentRowContent";
import { RowSnippet } from "./RowSnippet";
import { lastPreview, rowPreviewFor, type RowLast } from "./rowPreview";

afterEach(cleanup);

describe("row line two", () => {
  it("is parsed once per message entry, and parsed again if the entry changed", () => {
    const last: RowLast = { at: 1, seq: 1, mine: false, kind: "text", text: "**Done** with `x`" };
    const a = lastPreview(last);
    expect(lastPreview(last)).toBe(a);
    expect(lastPreview({ ...last })).not.toBe(a);
    expect(lastPreview({ ...last })).toEqual(a);
    last.text = "Other";
    expect(lastPreview(last)).not.toEqual(a);
    expect(lastPreview(undefined)).toBe(lastPreview(undefined));
    expect(rowPreviewFor({ kind: "group" } as never)).toBe(rowPreviewFor({ kind: "group" } as never));
  });
});

describe("AgentRowContent", () => {
  const last: RowLast = { at: 1, seq: 1, mine: true, kind: "text", text: "hello _there_" };
  const row = (unreadCount: number, when = "9:41") => (
    <AgentRowContent
      name="Appa"
      initial="A"
      busy={null}
      when={when}
      preview={<RowSnippet preview={lastPreview(last)} />}
      unread={{ tone: "unread", count: unreadCount, emphasis: true, muted: false }}
    />
  );

  it("a list re-render with equal values (new objects, a new snippet element) skips the row", () => {
    renders.avatar = 0;
    const { rerender } = render(row(2));
    expect(renders.avatar).toBe(1);
    rerender(row(2));
    rerender(row(2));
    expect(renders.avatar).toBe(1);
  });

  it("a changed value re-renders it", () => {
    renders.avatar = 0;
    const { rerender, container } = render(row(2));
    rerender(row(3));
    expect(renders.avatar).toBe(2);
    rerender(row(3, "9:42"));
    expect(renders.avatar).toBe(3);
    expect(container.textContent).toContain("9:42");
  });
});
