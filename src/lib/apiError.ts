/** Daemon errors are often `{error:{code,hint}}`, not a string.
 *  Putting that object in JSX blanks the app (not a valid React child). */
export function apiErrorText(raw: string, fallback: string): string {
  try {
    const j = JSON.parse(raw) as { error?: unknown };
    const e = j?.error;
    if (typeof e === "string" && e.trim()) return e;
    if (e && typeof e === "object") {
      const o = e as { hint?: unknown; message?: unknown; code?: unknown };
      if (typeof o.hint === "string" && o.hint.trim()) return o.hint;
      if (typeof o.message === "string" && o.message.trim()) return o.message;
      if (typeof o.code === "string" && o.code.trim()) return o.code;
      return JSON.stringify(e);
    }
  } catch {
    /* not JSON */
  }
  return fallback;
}

export function asErrorText(value: unknown, fallback = "error"): string {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object") {
    const o = value as { hint?: unknown; message?: unknown; error?: unknown };
    if (typeof o.hint === "string" && o.hint) return o.hint;
    if (typeof o.message === "string" && o.message) return o.message;
    if (typeof o.error === "string" && o.error) return o.error;
    try {
      return JSON.stringify(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
}