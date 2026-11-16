// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  briefRenderable,
  buildBriefSrcDoc,
  INERT_FRAME_CSP,
  quickAnswerOptions,
  briefStylesheet,
  safeBriefColors,
  DARK_BRIEF_COLORS,
} from "./ticketBrief";

const BRIEF_HTML =
  '<h2>Problem</h2><p>See <a href="https://example.com/spec" target="_blank" ping="https://t.example">the spec</a> ' +
  'and <a href="mailto:a@b.co">mail</a> and <a href="javascript:alert(1)">bad</a>.</p>' +
  '<section class="k2-need"><p>Pick a tier.</p></section>' +
  '<ol class="k2-options"><li><strong>Pro</strong> — cheaper</li><li><b>Business</b> — SSO</li>' +
  "<li>Neither, wait a month</li><li><strong>Pro</strong> again</li><li> </li></ol>";

describe("quickAnswerOptions", () => {
  it("reads the brief's .k2-options: leading strong/b is the label and the answer", () => {
    const opts = quickAnswerOptions({ options: ["ignored"] }, BRIEF_HTML);
    expect(opts.map((o) => o.answer)).toEqual(["Pro", "Business", "Neither, wait a month"]);
    expect(opts[0]).toEqual({ answer: "Pro", label: "Pro", detail: "Pro — cheaper" });
  });

  it("li inside any .k2-options wrapper count too", () => {
    const html = '<div class="k2-options"><ul><li><strong>Yes</strong></li><li>No</li></ul></div>';
    expect(quickAnswerOptions({ options: null }, html).map((o) => o.answer)).toEqual(["Yes", "No"]);
  });

  it("falls back to item.options (collapsed, deduped) without a brief list", () => {
    expect(
      quickAnswerOptions({ options: ["  Ship  it ", "Hold", "Hold", ""] }, "<p>no list</p>").map(
        (o) => o.answer
      )
    ).toEqual(["Ship it", "Hold"]);
    expect(quickAnswerOptions({ options: null }, null)).toEqual([]);
  });
});

describe("buildBriefSrcDoc", () => {
  it("puts the inert CSP meta first in <head>, then the stylesheet and the body", () => {
    const { frameHtml } = buildBriefSrcDoc(BRIEF_HTML);
    expect(frameHtml.startsWith("<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
    expect(frameHtml).toContain(`content="${INERT_FRAME_CSP}"`);
    expect(INERT_FRAME_CSP).toBe(
      "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; " +
        "media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; " +
        "worker-src 'none'; object-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'"
    );
    expect(frameHtml.indexOf("<style>")).toBeGreaterThan(frameHtml.indexOf("Content-Security-Policy"));
    expect(frameHtml).toContain("color-scheme:dark");
    expect(frameHtml).toContain(".k2-need");
    expect(frameHtml).toContain('<body class="k2-brief">');
  });

  it("strips href/target/ping, numbers the links and lists only http(s)/mailto", () => {
    const { frameHtml, links } = buildBriefSrcDoc(BRIEF_HTML);
    expect(links).toEqual([
      { n: 1, url: "https://example.com/spec" },
      { n: 2, url: "mailto:a@b.co" },
    ]);
    expect(frameHtml).not.toMatch(/href=/i);
    expect(frameHtml).not.toMatch(/target=/i);
    expect(frameHtml).not.toMatch(/ping=/i);
    expect(frameHtml).toContain('<sup class="k2-link-ref">[1]</sup>');
    expect(frameHtml).toContain('<sup class="k2-link-ref">[2]</sup>');
  });

  it("never carries a script, handler or inline style", () => {
    const { frameHtml } = buildBriefSrcDoc(
      '<p onclick="x()" style="color:red">hi</p><script>alert(1)</script><img src="data:image/png;base64,AA" onerror="y()">'
    );
    expect(frameHtml).not.toMatch(/<script/i);
    expect(frameHtml).not.toMatch(/onclick|onerror/i);
    expect(frameHtml).not.toContain("color:red");
    expect(frameHtml).toContain('<img src="data:image/png;base64,AA">');
  });
});

describe("briefRenderable", () => {
  const brief = { html: "<p>x</p>", text: "x", bytes: 8, sha256: "s", sanitizer: "k2-brief-v1", createdAt: 1 };
  it("only k2-brief-v1 with html renders as HTML", () => {
    expect(briefRenderable(brief)).toBe(true);
    expect(briefRenderable({ ...brief, sanitizer: "k2-brief-v0" })).toBe(false);
    expect(briefRenderable({ ...brief, html: "  " })).toBe(false);
    expect(briefRenderable(null)).toBe(false);
  });
});

describe("the brief follows the palette (Settings → Themes)", () => {
  it("defaults to Obsidian's dark colours", () => {
    const css = briefStylesheet();
    expect(css).toContain(":root{color-scheme:dark;}");
    expect(css).toContain("background:#1c1c1e;color:#ffffff;");
  });

  it("draws in the palette's colours, light included", () => {
    const css = briefStylesheet({ scheme: "light", bg: "#ffffff", text: "#000000", accent: "#086acc" });
    expect(css).toContain(":root{color-scheme:light;}");
    expect(css).toContain("background:#ffffff;color:#000000;");
    expect(css).toContain("a{color:#086acc;");
  });

  it("takes only plain colours into the frame's CSS", () => {
    const c = safeBriefColors({ bg: "red;}body{display:none", text: "url(x)", wash: "rgba(1, 2, 3, 0.5)" });
    expect(c.bg).toBe(DARK_BRIEF_COLORS.bg);
    expect(c.text).toBe(DARK_BRIEF_COLORS.text);
    expect(c.wash).toBe("rgba(1, 2, 3, 0.5)");
  });

  it("the frame document carries the colours it was given", () => {
    const { frameHtml } = buildBriefSrcDoc("<p>Hi</p>", { scheme: "light", bg: "#fafafa" });
    expect(frameHtml).toContain("color-scheme:light");
    expect(frameHtml).toContain("background:#fafafa;");
  });
});
