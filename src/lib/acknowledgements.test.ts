import { describe, expect, it } from "vitest";
import text from "../../public/acknowledgements.txt?raw";
import lockText from "../../package-lock.json?raw";

// The notices the app ships (scripts/gen-acknowledgements.mjs). A dependency
// added without `npm run gen:notices` fails here.

describe("public/acknowledgements.txt", () => {
  it("lists every npm package in the app", () => {
    const lock = JSON.parse(lockText) as {
      packages: Record<string, { dev?: boolean; devOptional?: boolean; link?: boolean; version?: string }>;
    };
    const missing = Object.entries(lock.packages)
      .filter(([k, v]) => k && !v.dev && !v.devOptional && !v.link)
      .map(([k, v]) => `${k.slice(k.lastIndexOf("node_modules/") + 13)} ${v.version} (npm)`)
      .filter((line) => !text.includes(line));
    expect(missing).toEqual([]);
  });

  it("carries the font's licences and LiveKit's notice", () => {
    expect(text).toContain("MesloLGM Nerd Font Mono");
    expect(text).toContain("Copyright 2009, 2010, 2013 André Berg");
    expect(text).toContain("SIL OPEN FONT LICENSE");
    expect(text).toMatch(/Reserved Font Name:? "?Pomicons/);
    expect(text).toContain("sew-lk-compat");
    expect(text).toContain("LiveKit");
  });

  it("names K2 as MIT and ships no FSL package", () => {
    expect(text).toContain("MIT License\n\nCopyright (c) 2025-2026 Alakazam Labs");
    expect(text).not.toContain("sew-crypto");
    expect(text).not.toMatch(/Functional Source/);
  });
});
