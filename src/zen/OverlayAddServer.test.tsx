// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useServersStore } from "../stores/servers";
import { OverlayAddServer } from "./OverlayAddServer";

afterEach(() => cleanup());

describe("OverlayAddServer", () => {
  it("is the overlay Add server form, with no remember-password checkbox", () => {
    render(<OverlayAddServer />);
    expect(screen.getByTestId("overlay-add-server")).not.toBeNull();
    expect(screen.getByText("Add server")).not.toBeNull();
    expect(screen.getByPlaceholderText("your-name.k2.dev")).not.toBeNull();
    expect(screen.getByPlaceholderText("Username")).not.toBeNull();
    expect(screen.getByPlaceholderText("Password")).not.toBeNull();
    expect(screen.queryByText(/Remember password/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    const password = screen.getByPlaceholderText("Password") as HTMLInputElement;
    expect(password.getAttribute("autocorrect")).toBe("off");
    expect(password.getAttribute("autocapitalize")).toBe("off");
    expect(password.getAttribute("spellcheck")).toBe("false");
  });

  it("Cancel is present when the in-overlay list can go back", () => {
    render(<OverlayAddServer onCancel={() => {}} />);
    expect(screen.getByRole("button", { name: "Cancel" })).not.toBeNull();
  });

  it("Remove asks for confirmation before deleting the server", () => {
    useServersStore.setState({
      servers: [
        {
          id: "s1",
          nickname: "Home",
          url: "https://home.k2.dev",
          username: "baden",
          rememberPassword: false,
        },
      ],
      activeServerId: "s1",
      hydrated: true,
      tokens: { s1: "t" },
      recovery: { s1: "connected" },
    });
    const onCancel = vi.fn();
    render(<OverlayAddServer editingId="s1" onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(useServersStore.getState().servers).toHaveLength(1);
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep server" }));
    expect(useServersStore.getState().servers).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove server" }));
    expect(useServersStore.getState().servers).toHaveLength(0);
    expect(onCancel).toHaveBeenCalled();
  });
});
