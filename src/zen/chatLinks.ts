import { isUnderWorkspace, posixNormalize, usableFsPath } from "./workspacePath";

export function isWebUrl(url: string): boolean {
  const u = url.trim().toLowerCase();
  return (
    u.startsWith("https://") ||
    u.startsWith("http://") ||
    u.startsWith("mailto:") ||
    u.startsWith("tel:")
  );
}

export function fileRefFromHref(href: string): string {
  const raw = href.trim();
  if (raw.toLowerCase().startsWith("file:")) {
    try {
      return decodeURIComponent(new URL(raw).pathname);
    } catch {
      return raw.replace(/^file:\/\//i, "");
    }
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Path or filename an agent would mention — not a URL, not a bare word. */
export function looksLikeFileRef(s: string): boolean {
  const t = s.trim();
  if (!t || t.length > 256 || /\s/.test(t)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !t.toLowerCase().startsWith("file:")) {
    return false;
  }
  if (t.includes("://")) return false;
  return /\/./.test(t) || /\.[A-Za-z0-9]{1,8}$/.test(t);
}

export function classifyHref(href?: string | null): "web" | "file" | "none" {
  if (!href) return "none";
  const t = href.trim();
  const lower = t.toLowerCase();
  if (
    lower.startsWith("javascript:") ||
    lower.startsWith("data:") ||
    lower.startsWith("vbscript:")
  ) {
    return "none";
  }
  if (isWebUrl(t)) return "web";
  if (lower.startsWith("file:") || t.startsWith("/") || looksLikeFileRef(t)) {
    return "file";
  }
  return "none";
}

/** Absolute path under this agent's workspace, or null. */
export function resolveFileRef(
  ref: string,
  workspace: string | null | undefined
): string | null {
  const r = fileRefFromHref(ref).replace(/\\/g, "/").trim();
  if (!r) return null;
  const root = usableFsPath(workspace ?? "");
  if (!root) return null;
  const abs = r.startsWith("/")
    ? usableFsPath(r)
    : posixNormalize(`${root}/${r.replace(/^\.\//, "")}`);
  if (!abs || !isUnderWorkspace(abs, root)) return null;
  return abs;
}

/** Turn `@AGENTS.md` / `@src/foo.ts` into markdown links. Skip emails. */
export function linkifyFileMentions(text: string): string {
  return text.replace(
    /(^|[^A-Za-z0-9._])@((?:[\w.-]+\/)+[\w.-]+|[\w.-]+\.[A-Za-z0-9]{1,8})\b/g,
    (_full, prefix: string, path: string) => `${prefix}[${path}](${path})`
  );
}
