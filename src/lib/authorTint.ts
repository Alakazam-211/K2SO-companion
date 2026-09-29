// Gentle per-author wash for Project / Feedback cards. Same author
// always hashes to the same hue so a thread scans as people, not a
// wall of identical surface tiles. "Mine" uses the accent wash.

export interface AuthorTint {
  background: string;
  border: string;
  name: string;
}

/** djb2 over the author key → 0..359 hue. */
export function authorHue(key: string): number {
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 360;
}

export function authorTint(authorKey: string, mine: boolean): AuthorTint {
  if (mine) {
    return {
      background: "color-mix(in srgb, var(--accent) 16%, var(--surface))",
      border: "color-mix(in srgb, var(--accent) 40%, var(--border))",
      name: "var(--accent)",
    };
  }
  const hue = authorHue(authorKey || "?");
  return {
    background: `hsla(${hue}, var(--author-s), var(--author-l), var(--author-a))`,
    border: `hsla(${hue}, var(--author-border-s), var(--author-border-l), var(--author-border-a))`,
    name: `hsl(${hue}, var(--author-name-s), var(--author-name-l))`,
  };
}
