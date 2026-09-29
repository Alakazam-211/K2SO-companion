// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FilePane } from "./FilePane";
import { STUB_FILES } from "./stubData";
import { useZenStore } from "./zenStore";

afterEach(() => cleanup());

describe("FilePane stub markers", () => {
  it("collapsed tab says STUB files, not a bare Files", () => {
    useZenStore.setState({
      filesOpen: false,
      fileSource: "stub",
      files: STUB_FILES,
      fileError: null,
    });
    render(<FilePane />);
    const tab = screen.getByLabelText("Open STUB files");
    expect(tab.textContent).toMatch(/STUB files/i);
    expect(tab.textContent).not.toBe("Files");
  });

  it("each stub file row carries its own STUB mark", () => {
    useZenStore.setState({
      filesOpen: true,
      fileSource: "stub",
      files: STUB_FILES,
      fileError: null,
      openFileIds: [],
    });
    render(<FilePane />);
    const marks = document.querySelectorAll("[data-stub='true']");
    expect(marks.length).toBe(STUB_FILES.length);
  });

  it("live read fail shows the error and no stub rows", () => {
    useZenStore.setState({
      filesOpen: true,
      fileSource: "error",
      files: [],
      fileError: "read-dir failed",
      openFileIds: [],
    });
    render(<FilePane />);
    expect(screen.getByText("read-dir failed")).not.toBeNull();
    expect(document.querySelectorAll("[data-stub='true']").length).toBe(0);
    expect(screen.queryByText(/not-a-real-file/)).toBeNull();
  });
});
