// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { WorkspaceAvatar } from "./WorkspaceAvatar";

afterEach(cleanup);

describe("WorkspaceAvatar glass edge", () => {
  it("draws the glass layer over an image icon", () => {
    render(<WorkspaceAvatar initial="K" iconUrl="https://x/icon.png" size={50} fontSize={18} />);
    const root = screen.getByTestId("workspace-avatar");
    const glass = screen.getByTestId("workspace-avatar-glass");
    const img = root.querySelector("img")!;
    expect(img).not.toBeNull();
    expect(glass.parentElement).toBe(root);
    // After the <img> in the DOM, so it paints on top of the icon.
    expect(img.compareDocumentPosition(glass) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(glass.className).toContain("k2-avatar-glass");
    expect(glass.style.pointerEvents).toBe("none");
    expect(glass.style.borderRadius).toBe("inherit");
    expect(glass.getAttribute("aria-hidden")).not.toBeNull();
  });

  it("draws the glass layer over an initial fallback", () => {
    render(<WorkspaceAvatar initial="Q" color="#f00" size={42} fontSize={16} />);
    const root = screen.getByTestId("workspace-avatar");
    const glass = screen.getByTestId("workspace-avatar-glass");
    expect(root.textContent).toBe("Q");
    expect(glass.parentElement).toBe(root);
    expect(glass.style.pointerEvents).toBe("none");
    expect(root.style.borderRadius).toBe("50%");
  });

  it("softens the sheen at small sizes only", () => {
    render(<WorkspaceAvatar initial="S" size={28} fontSize={12} />);
    expect(screen.getByTestId("workspace-avatar").className).toContain("k2-avatar-sm");
    cleanup();
    render(<WorkspaceAvatar initial="L" size={50} fontSize={18} />);
    expect(screen.getByTestId("workspace-avatar").className).not.toContain("k2-avatar-sm");
  });

  it("keeps the glass inside its own stacking context so a sibling activity dot stays on top", () => {
    render(
      <span className="relative">
        <WorkspaceAvatar initial="A" size={50} fontSize={18} />
        <span data-testid="dot" className="absolute" style={{ right: -1, bottom: -1 }} />
      </span>
    );
    const root = screen.getByTestId("workspace-avatar");
    const glass = screen.getByTestId("workspace-avatar-glass");
    const dot = screen.getByTestId("dot");
    // Positioned root with z-index 0 => stacking context; the glass's
    // z-index can't escape it, and the later positioned dot paints above.
    expect(root.style.position).toBe("relative");
    expect(root.style.zIndex).toBe("0");
    expect(root.contains(glass)).toBe(true);
    expect(root.contains(dot)).toBe(false);
    expect(root.compareDocumentPosition(dot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
