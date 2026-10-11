// Allowlist sanitizer for mammoth's DOCX → HTML. Mammoth emits a small,
// known tag set; anything else (and every event handler or style) goes.
// Images keep only inline `data:image/` sources: no network, no app files.

const ALLOWED_TAGS = new Set([
  "p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i",
  "u", "s", "del", "sub", "sup", "ul", "ol", "li", "table", "thead", "tbody",
  "tfoot", "tr", "th", "td", "a", "img", "blockquote", "pre", "code", "span",
  "div", "hr",
]);

const ALLOWED_ATTRS: Record<string, string[]> = {
  a: ["href", "id"],
  img: ["src", "alt"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan"],
  p: ["id"],
  span: ["id"],
};

function safeHref(v: string): boolean {
  return /^(https?:|mailto:|#)/i.test(v.trim());
}

function clean(node: Element, doc: Document): void {
  for (const child of Array.from(node.children)) {
    const tag = child.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      // Unknown wrapper: keep its text, drop the element. Script/style
      // bodies are not text worth keeping.
      if (tag === "script" || tag === "style" || tag === "iframe" || tag === "object") {
        child.remove();
      } else {
        clean(child, doc);
        child.replaceWith(...Array.from(child.childNodes));
      }
      continue;
    }
    const keep = ALLOWED_ATTRS[tag] ?? [];
    for (const attr of Array.from(child.attributes)) {
      const name = attr.name.toLowerCase();
      const ok =
        keep.includes(name) &&
        (name !== "href" || safeHref(attr.value)) &&
        (name !== "src" || /^data:image\//i.test(attr.value.trim()));
      if (!ok) child.removeAttribute(attr.name);
    }
    if (tag === "a" && child.getAttribute("href") && !child.getAttribute("href")!.startsWith("#")) {
      child.setAttribute("rel", "noopener noreferrer");
      child.setAttribute("target", "_blank");
    }
    clean(child, doc);
  }
}

/** HTML string → HTML string with only the allowlisted tags/attributes. */
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  clean(doc.body, doc);
  return doc.body.innerHTML;
}
