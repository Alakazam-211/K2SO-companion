// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
});
