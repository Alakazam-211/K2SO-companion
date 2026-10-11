import { collapseWs, type FeedbackBrief } from "./feedbackPure";

// Ticket HTML brief — the phone port of the desktop's `brief-srcdoc.ts`,
// `frame-csp.ts` (inert profile) and `quickAnswerOptions`. The daemon
// already cleaned the HTML (ammonia allowlist, `k2-brief-v1`); this module
// only presents it:
//
//   - Links come OUT of the frame. An inert frame can't catch a tap, so
//     every `<a>` loses href/target/ping and gets a `[n]` marker; the view
//     lists the full URLs under the card and opens them in the system
//     browser (openExternal).
//   - The frame document is doctype, then the inert CSP `<meta>` as the
//     first `<head>` element, then our dark stylesheet, then
//     `<body class="k2-brief">` + the brief. Rendered with `sandbox=""`.
//   - Anything that isn't a `k2-brief-v1` brief falls back to plain text.
//
// The HTML is only ever parsed with an inert DOMParser (no browsing
// context: nothing runs, nothing loads) — never put into the app's DOM.

/** The expected `brief.sanitizer`. Anything else → text fallback. */
export const BRIEF_SANITIZER = "k2-brief-v1";

/** Desktop `frameCsp("inert")`, verbatim (tickets reference §3.3). */
export const INERT_FRAME_CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; " +
  "img-src data: blob:; media-src data: blob:; font-src data:; " +
  "connect-src 'none'; frame-src 'none'; child-src 'none'; " +
  "worker-src 'none'; object-src 'none'; manifest-src 'none'; " +
  "form-action 'none'; base-uri 'none'";

export const INERT_FRAME_CSP_META = `<meta http-equiv="Content-Security-Policy" content="${INERT_FRAME_CSP}">`;

export interface BriefLink {
  /** 1-based marker shown in the frame as `[n]`. */
  n: number;
  url: string;
}

export interface BriefSrcDoc {
  frameHtml: string;
  links: BriefLink[];
}

/** True when the brief is safe to render as HTML (else show `text`). */
export function briefRenderable(brief: FeedbackBrief | null | undefined): brief is FeedbackBrief {
  return Boolean(
    brief &&
      brief.sanitizer === BRIEF_SANITIZER &&
      typeof brief.html === "string" &&
      brief.html.trim()
  );
}

/** Dark Zen tokens (index.css :root / .k2-tile). No color-mix: iOS 15–16.1
 *  lacks it, so tints are plain rgba. */
const T = {
  bg: "#1c1c1e",
  text: "#e4e4e7",
  text2: "#a1a1aa",
  muted: "#8e8e93",
  border: "#3a3a3c",
  accent: "#22d3ee",
  accentTint: "rgba(34, 211, 238, 0.10)",
  wash: "rgba(255, 255, 255, 0.06)",
  font: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
  mono: 'ui-monospace, Menlo, "SF Mono", monospace',
};

/** The K2 brief stylesheet on our dark tokens. Agents can't style a brief
 *  (no `style=`), so this is the whole look. `.k2-need` is "What I need
 *  from you", `.k2-options` the choices, `.k2-callout` an aside. */
export function briefStylesheet(): string {
  return [
    `:root{color-scheme:dark;}`,
    `html,body{margin:0;padding:0;background:${T.bg};color:${T.text};}`,
    `body.k2-brief{font-family:${T.font};font-size:15px;line-height:1.5;padding:14px 16px;overflow-wrap:anywhere;-webkit-text-size-adjust:100%;}`,
    `h1,h2,h3,h4{color:${T.text};line-height:1.3;margin:1.1em 0 .45em;}`,
    `h1{font-size:1.3em}h2{font-size:1.15em}h3{font-size:1.05em}h4{font-size:1em}`,
    `body.k2-brief>:first-child{margin-top:0}`,
    `p{margin:.55em 0}ul,ol{margin:.5em 0;padding-left:1.4em}li{margin:.2em 0}`,
    `a{color:${T.accent};text-decoration:underline}`,
    `sup.k2-link-ref{color:${T.muted};font-size:.75em;margin-left:.15em}`,
    `code,kbd,pre{font-family:${T.mono};font-size:.9em}`,
    `code,kbd{background:${T.wash};padding:.05em .3em;border-radius:4px}`,
    `pre{background:${T.wash};border:1px solid ${T.border};border-radius:8px;padding:.6em .8em;overflow-x:auto;white-space:pre;-webkit-overflow-scrolling:touch}`,
    `pre code{background:none;padding:0}`,
    `blockquote{margin:.6em 0;padding:.2em .9em;border-left:3px solid ${T.border};color:${T.text2}}`,
    `hr{border:0;border-top:1px solid ${T.border};margin:1em 0}`,
    `table{border-collapse:collapse;margin:.6em 0;max-width:100%;display:block;overflow-x:auto}`,
    `th,td{border:1px solid ${T.border};padding:.3em .6em;text-align:left;vertical-align:top}`,
    `th{background:${T.wash}}`,
    `img{max-width:100%;height:auto}`,
    `figure{margin:.8em 0}figcaption{color:${T.muted};font-size:.9em}`,
    `details{margin:.5em 0}`,
    `mark{background:rgba(34,211,238,.3);color:inherit}`,
    `.k2-need{border:1px solid ${T.accent};background:${T.accentTint};border-radius:12px;padding:.2em .9em .4em;margin:.9em 0}`,
    `.k2-need::before{content:"What I need from you";display:block;margin:.6em 0 .2em;font-size:.72em;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:${T.accent}}`,
    `ol.k2-options,.k2-options ol,.k2-options ul{padding-left:1.6em}.k2-options li{padding:.15em 0}`,
    `.k2-callout{border-left:3px solid ${T.accent};background:${T.wash};border-radius:0 8px 8px 0;padding:.4em .9em;margin:.7em 0}`,
  ].join("\n");
}

const LINK_SCHEMES = /^(https?:|mailto:)/i;

/** Elements no k2-brief-v1 brief carries. The sanitizer check already
 *  routes unknown briefs to text; this is belt and braces for the frame. */
const DROP_TAGS = "script,style,link,meta,base,iframe,frame,object,embed,form,template,noscript";

/** Build the frame document for a cleaned brief, plus the links taken out
 *  of it. Pure apart from the inert DOMParser. */
export function buildBriefSrcDoc(html: string): BriefSrcDoc {
  const doc = new DOMParser().parseFromString(
    `<!doctype html><html><head></head><body>${html}</body></html>`,
    "text/html"
  );
  for (const el of Array.from(doc.body.querySelectorAll(DROP_TAGS))) el.remove();
  for (const el of Array.from(doc.body.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name) || attr.name.toLowerCase() === "style") {
        el.removeAttribute(attr.name);
      }
    }
  }
  const links: BriefLink[] = [];
  for (const a of Array.from(doc.body.querySelectorAll("a"))) {
    const href = (a.getAttribute("href") ?? "").trim();
    a.removeAttribute("href");
    a.removeAttribute("target");
    a.removeAttribute("ping");
    if (!href || !LINK_SCHEMES.test(href)) continue;
    const n = links.length + 1;
    links.push({ n, url: href });
    const sup = doc.createElement("sup");
    sup.className = "k2-link-ref";
    sup.textContent = `[${n}]`;
    a.appendChild(sup);
  }
  const frameHtml =
    "<!doctype html><html><head>" +
    INERT_FRAME_CSP_META +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<style>" +
    briefStylesheet() +
    '</style></head><body class="k2-brief">' +
    doc.body.innerHTML +
    "</body></html>";
  return { frameHtml, links };
}

// ─── Quick answers (desktop feedback-api.ts quickAnswerOptions) ───

/** One quick-answer pill: `answer` is what gets sent, `label` what the
 *  pill says, `detail` the full option text. */
export interface QuickAnswerOption {
  answer: string;
  label: string;
  detail: string;
}

/** The brief's Options list: one entry per `<li>` of an `ol/ul.k2-options`
 *  (or the `li`s inside any `.k2-options`). An item that starts with
 *  `<strong>`/`<b>` answers with that short label; otherwise with its whole
 *  text. Duplicates and empty items are dropped. */
export function extractBriefOptions(html: string | null | undefined): QuickAnswerOption[] {
  if (!html || typeof DOMParser === "undefined") return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out: QuickAnswerOption[] = [];
  const seen = new Set<string>();
  for (const root of Array.from(doc.querySelectorAll(".k2-options"))) {
    const items =
      root.tagName === "OL" || root.tagName === "UL"
        ? Array.from(root.children).filter((el) => el.tagName === "LI")
        : Array.from(root.querySelectorAll("li"));
    for (const li of items) {
      const detail = collapseWs(li.textContent);
      if (!detail) continue;
      const first = li.firstElementChild;
      const lead =
        first && (first.tagName === "STRONG" || first.tagName === "B")
          ? collapseWs(first.textContent)
          : "";
      const answer = lead || detail;
      if (seen.has(answer)) continue;
      seen.add(answer);
      out.push({ answer, label: answer, detail });
    }
  }
  return out;
}

/** Quick-answer pills for a ticket: the brief's Options list when it has
 *  one, else the structured `options`. */
export function quickAnswerOptions(
  item: { options: string[] | null },
  briefHtml: string | null | undefined
): QuickAnswerOption[] {
  const fromBrief = extractBriefOptions(briefHtml);
  if (fromBrief.length > 0) return fromBrief;
  const seen = new Set<string>();
  return (item.options ?? [])
    .map((o) => collapseWs(o))
    .filter((o) => {
      if (!o || seen.has(o)) return false;
      seen.add(o);
      return true;
    })
    .map((o) => ({ answer: o, label: o, detail: o }));
}
