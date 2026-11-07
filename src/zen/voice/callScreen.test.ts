// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { useCallScreen } from "./callScreen";

afterEach(() => {
  useCallScreen.setState({ open: false, pending: false });
  document.body.innerHTML = "";
});

describe("useCallScreen.ask", () => {
  it("opens the call screen and drops a focused composer's keyboard", () => {
    const input = document.createElement("textarea");
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    useCallScreen.getState().ask();

    expect(useCallScreen.getState().open).toBe(true);
    expect(document.activeElement).not.toBe(input);
  });
});
