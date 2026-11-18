// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MoveToHomeSheet } from "./MoveToHomeSheet";
import type { Home } from "./homes";

const ADDR = "alpha::example.k2.dev";
const HOMES: Home[] = [
  { id: "h1", name: "Group 1", rows: [{ address: ADDR, workspaceId: "pa", label: "alpha" }] },
  { id: "h2", name: "Work", icon: "briefcase", rows: [] },
  { id: "h3", name: "Lab", rows: [{ address: ADDR, workspaceId: "pa", label: "alpha" }] },
];

function mount(over: Partial<Parameters<typeof MoveToHomeSheet>[0]> = {}) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  render(
    <MoveToHomeSheet agentName="alpha" address={ADDR} homes={HOMES} fromId="h1" onPick={onPick} onClose={onClose} {...over} />
  );
  return { onPick, onClose };
}

afterEach(() => cleanup());

describe("Move to group sheet (Home groups)", () => {
  it("is a titled dialog listing every Home by name, the current one checked and off", () => {
    mount();
    const dialog = screen.getByRole("dialog", { name: "Move alpha to a group" });
    const list = within(dialog).getByRole("list", { name: "Groups" });
    const buttons = within(list).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Group 1, current",
      "Work",
      "Lab, already in it",
    ]);
    const current = screen.getByTestId("move-home-h1") as HTMLButtonElement;
    expect(current.disabled).toBe(true);
    expect(current.getAttribute("aria-current")).toBe("true");
    expect(within(current).getByTestId("move-home-check")).not.toBeNull();
    // A Home that already has the agent can't be picked either.
    expect((screen.getByTestId("move-home-h3") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("move-home-h2") as HTMLButtonElement).disabled).toBe(false);
    // Each Home's mark: its icon, or its number.
    expect(screen.getByTestId("move-home-h2").querySelector("[data-group-icon='briefcase']")).not.toBeNull();
    expect(screen.getByTestId("move-home-h1").querySelector("[data-group-numeral='1']")).not.toBeNull();
  });

  it("a pick names that Home; the current one does nothing", () => {
    const { onPick, onClose } = mount();
    fireEvent.click(screen.getByTestId("move-home-h1"));
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    expect(onPick).toHaveBeenCalledWith("h2");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Cancel, the backdrop and Escape close it; a tap inside the sheet doesn't", () => {
    const { onClose } = mount();
    fireEvent.click(screen.getByTestId("move-home-title"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByTestId("move-home-sheet"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
