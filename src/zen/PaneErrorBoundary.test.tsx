// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PaneErrorBoundary } from "./PaneErrorBoundary";

afterEach(() => cleanup());

function Boom(): never {
  throw new Error("objects are not valid as a React child");
}

describe("PaneErrorBoundary", () => {
  it("shows the throw in the pane and keeps siblings", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <div>
        <span>rail survives</span>
        <PaneErrorBoundary name="thread">
          <Boom />
        </PaneErrorBoundary>
      </div>
    );
    expect(screen.getByText("rail survives")).not.toBeNull();
    expect(screen.getByTestId("pane-error").textContent).toMatch(/objects are not valid/i);
  });
});