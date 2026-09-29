// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { FileStage } from "./FileStage";
import { STUB_FILES } from "./stubData";
import { useZenStore } from "./zenStore";

afterEach(() => cleanup());

describe("FileStage tab markers", () => {
  it("each open stub file tab carries STUB", () => {
    useZenStore.setState({
      fileSource: "stub",
      files: STUB_FILES,
      openFileIds: [STUB_FILES[0].id, STUB_FILES[1].id],
      focusId: STUB_FILES[0].id,
      splitId: STUB_FILES[1].id,
    });
    render(<FileStage />);
    expect(document.querySelectorAll("[data-stub='true']").length).toBe(2);
  });

  it("live file tabs have no STUB mark", () => {
    useZenStore.setState({
      fileSource: "live",
      files: [{ id: "/ws/a.md", name: "a.md", body: "x" }],
      openFileIds: ["/ws/a.md"],
      focusId: "/ws/a.md",
      splitId: null,
    });
    render(<FileStage />);
    expect(document.querySelectorAll("[data-stub='true']").length).toBe(0);
  });
});
