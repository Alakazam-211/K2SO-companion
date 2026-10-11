// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  AgentIcon,
  CheckIcon,
  CogIcon,
  FileIcon,
  HomeIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
} from "./icons";
import { HomeTabToggle } from "./HomeTabToggle";
import { ConsoleGlyph } from "./LlmIcon";
import { BinaryEmptyState } from "./files/BinaryEmptyState";
import homeTabToggleSrc from "./HomeTabToggle.tsx?raw";
import chatsListSrc from "./ChatsList.tsx?raw";
import llmIconSrc from "./LlmIcon.tsx?raw";
import stripSrc from "./ThreadWorkingStrip.tsx?raw";
import binarySrc from "./files/BinaryEmptyState.tsx?raw";
import addAgentSrc from "./AddAgentSheet.tsx?raw";
import focusGroupSrc from "./FocusGroupPicker.tsx?raw";
import homeMenuSrc from "./HomeMenu.tsx?raw";
import zenSrc from "../pages/Zen.tsx?raw";
import zenTerminalSrc from "../pages/ZenTerminal.tsx?raw";
import chatSessionSrc from "../pages/ChatSession.tsx?raw";
import serversSrc from "../pages/Servers.tsx?raw";
import htmlDocsSrc from "../pages/ProjectHtmlDocs.tsx?raw";

afterEach(cleanup);

const ALL = {
  home: HomeIcon,
  agent: AgentIcon,
  cog: CogIcon,
  terminal: TerminalIcon,
  pencil: PencilIcon,
  file: FileIcon,
  search: SearchIcon,
  check: CheckIcon,
};

describe("shared icons", () => {
  it("each is a decorative currentColor stroke icon that names itself", () => {
    for (const [name, Icon] of Object.entries(ALL)) {
      const { container, unmount } = render(<Icon />);
      const svg = container.querySelector("svg")!;
      expect(svg.getAttribute("data-k2-icon")).toBe(name);
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      expect(svg.getAttribute("stroke")).toBe("currentColor");
      expect(svg.getAttribute("fill")).toBe("none");
      expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
      unmount();
    }
  });

  it("size, stroke width and test id are per call site", () => {
    render(<PencilIcon size={15} strokeWidth={1.75} testId="p" />);
    const svg = screen.getByTestId("p");
    expect(svg.getAttribute("width")).toBe("15");
    expect(svg.getAttribute("height")).toBe("15");
    expect(svg.getAttribute("stroke-width")).toBe("1.75");
  });
});

describe("original call sites draw through the shared module", () => {
  it("Home | Agents toggle: home and agent", () => {
    render(<HomeTabToggle tab="agents" onTab={() => {}} />);
    expect(screen.getByTestId("home-icon").getAttribute("data-k2-icon")).toBe("home");
    expect(screen.getByTestId("agent-icon").getAttribute("data-k2-icon")).toBe("agent");
    expect(screen.getByTestId("agent-icon").getAttribute("stroke-width")).toBe("1.7");
  });

  it("console glyph: terminal; binary empty state: file", () => {
    const { container } = render(<ConsoleGlyph />);
    expect(container.querySelector("svg")?.getAttribute("data-k2-icon")).toBe("terminal");
    cleanup();
    render(<BinaryEmptyState filePath="/ws/app.wasm" />);
    expect(screen.getByTestId("file-binary").querySelector("svg")?.getAttribute("data-k2-icon")).toBe("file");
  });

  it("no live call site keeps its own copy of a shared path", () => {
    const paths = [
      "M12 3v4", // agent antenna
      "M12.22 2h-.44", // cog
      "4 17 10 11 4 5", // terminal
      "M17 3a2.828 2.828", // pencil
      "M14 2H6a2 2 0 0 0-2 2v16", // file
      "M3 10.5 12 3l9 7.5", // home
      "M20 6 9 17l-5-5", // check
    ];
    const sites: Record<string, string> = {
      HomeTabToggle: homeTabToggleSrc,
      ChatsList: chatsListSrc,
      LlmIcon: llmIconSrc,
      ThreadWorkingStrip: stripSrc,
      BinaryEmptyState: binarySrc,
      AddAgentSheet: addAgentSrc,
      FocusGroupPicker: focusGroupSrc,
      HomeMenu: homeMenuSrc,
      Zen: zenSrc,
      ZenTerminal: zenTerminalSrc,
      ChatSession: chatSessionSrc,
      Servers: serversSrc,
      ProjectHtmlDocs: htmlDocsSrc,
    };
    for (const [site, src] of Object.entries(sites)) {
      for (const p of paths) expect(src.includes(p), `${site} redraws ${p}`).toBe(false);
    }
  });
});
