/** No scripts, no network beyond https images/styles/fonts, no forms. */
export const HTML_FRAME_CSP =
  "default-src 'none'; img-src data: blob: https:; style-src 'unsafe-inline' https:; font-src data: https:; media-src data: blob: https:";

/** Put the CSP meta first in <head> so it governs everything after it. */
export function withFrameCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${HTML_FRAME_CSP}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${meta}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${meta}</head>`);
  return `<!doctype html><html><head>${meta}<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${html}</body></html>`;
}

/** HTML file rendered in a sandboxed frame. Desktop allows scripts in a
 *  null-origin frame; the phone is stricter: `sandbox=""` (no scripts,
 *  no same-origin, no forms, no top navigation) plus a CSP meta. White
 *  page so dark app chrome does not bleed into light HTML. */
export function HtmlView({ html, title }: { html: string; title: string }) {
  return (
    <div className="h-full w-full bg-white fv-safe-bottom-white">
      <iframe
        title={title}
        sandbox=""
        srcDoc={withFrameCsp(html)}
        referrerPolicy="no-referrer"
        className="block h-full w-full border-0 bg-white"
        data-testid="file-html"
      />
    </div>
  );
}
