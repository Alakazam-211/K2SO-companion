// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { rememberZenThread } from "./terminalJump";
import { ZenReturnButton } from "./ZenReturnButton";

afterEach(() => cleanup());

function Loc() {
  const loc = useLocation();
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>;
}

describe("ZenReturnButton", () => {
  it("opens the overlay thread remembered from the chat", () => {
    rememberZenThread("/Users/Baden/Appa");
    render(
      <MemoryRouter initialEntries={["/chat/abc"]}>
        <ZenReturnButton />
        <Routes>
          <Route path="*" element={<Loc />} />
        </Routes>
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(screen.getByTestId("loc").textContent).toBe(
      "/zen?thread=%2FUsers%2FBaden%2FAppa"
    );
  });
});
