/** Desktop workspace colour / icon from GET /cli/projects/list. */

export function workspaceColorOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)) return s;
  if (/^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i.test(s)) {
    return s;
  }
  return null;
}

export function workspaceIconOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^data:image\//i.test(s)) return s;
  return null;
}
