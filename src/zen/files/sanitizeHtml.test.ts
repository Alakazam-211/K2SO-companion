// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "./sanitizeHtml";
import { withFrameCsp } from "./HtmlView";

describe("sanitizeHtml (DOCX output)", () => {
  it("keeps mammoth's structure", () => {
    const out = sanitizeHtml("<h1>T</h1><p><strong>b</strong> <em>i</em></p><table><tr><td colspan=\"2\">x</td></tr></table>");
    expect(out).toContain("<h1>T</h1>");
    expect(out).toContain("<strong>b</strong>");
    expect(out).toContain('colspan="2"');
  });

  it("drops scripts, handlers, styles and unsafe links", () => {
    const out = sanitizeHtml(
      '<p onclick="x()" style="color:red">a<script>alert(1)</script></p><a href="javascript:alert(1)">j</a><a href="https://k2.dev">k</a><img src="https://t.co/x.png" onerror="x()"><img src="data:image/png;base64,AA==">'
    );
    expect(out).not.toMatch(/script|onclick|onerror|style=|javascript:/);
    expect(out).toContain('href="https://k2.dev"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('src="data:image/png;base64,AA=="');
    expect(out).not.toContain("t.co");
  });

  it("unwraps unknown tags but keeps their text", () => {
    expect(sanitizeHtml("<p><font>hello</font></p>")).toBe("<p>hello</p>");
  });
});

describe("withFrameCsp (HTML files)", () => {
  it("puts the CSP first in an existing head", () => {
    const out = withFrameCsp("<html><head><title>x</title></head><body>y</body></html>");
    expect(out.indexOf("Content-Security-Policy")).toBeLessThan(out.indexOf("<title>"));
    expect(out).toContain("default-src 'none'");
  });

  it("wraps a fragment in a document with the CSP", () => {
    const out = withFrameCsp("<p>hi</p>");
    expect(out.startsWith("<!doctype html>")).toBe(true);
    expect(out).toContain("Content-Security-Policy");
    expect(out).toContain("<body><p>hi</p></body>");
  });
});
