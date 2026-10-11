// File and folder icons, ported from desktop K2:
//   files   → Seti UI glyphs (src/renderer/lib/seti-file-icons/resolve.ts)
//   folders → K2's gold open/closed folder (FileTree.tsx `FolderIcon`)
// Matching order mirrors VS Code's Seti theme: exact file name →
// extensionless basenames → compound extensions from the right → default.
// Desktop has no special folder icons (src, .git, node_modules all get
// the same folder), so neither does the phone.

import {
  SETI_DEFAULT_ID,
  SETI_FILE_EXTENSIONS,
  SETI_FILE_NAMES,
  SETI_ICON_DEFS,
  type SetiIconDef,
} from "./setiData";

export type { SetiIconDef };

const FALLBACK: SetiIconDef = SETI_ICON_DEFS[SETI_DEFAULT_ID] ?? { code: 0xe023, color: "#d4d7d6" };

/** Extensionless basenames VS Code maps by language id, not file name
 *  (same small table as desktop). */
const EXTENSIONLESS_BASENAMES: Record<string, string> = {
  dockerfile: "_docker",
  makefile: "_makefile",
  gemfile: "_ruby",
  rakefile: "_ruby",
  procfile: "_heroku",
  jenkinsfile: "_jenkins",
  brewfile: "_ruby",
  vagrantfile: "_ruby",
};

/** Seti icon id for a file name or path (the basename is used). */
export function resolveSetiIconId(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() || fileName;
  if (!base) return SETI_DEFAULT_ID;
  const byName = SETI_FILE_NAMES[base] ?? SETI_FILE_NAMES[base.toLowerCase()];
  if (byName) return byName;
  const lower = base.toLowerCase();
  const extless = EXTENSIONLESS_BASENAMES[lower];
  if (extless) return extless;
  let rest = lower;
  while (rest.includes(".")) {
    rest = rest.slice(rest.indexOf(".") + 1);
    const byExt = SETI_FILE_EXTENSIONS[rest];
    if (byExt) return byExt;
  }
  return SETI_DEFAULT_ID;
}

/** Glyph (Seti font code point) + colour for a file name. */
export function resolveSetiIcon(fileName: string | null | undefined): SetiIconDef {
  if (!fileName) return FALLBACK;
  return SETI_ICON_DEFS[resolveSetiIconId(fileName)] ?? FALLBACK;
}

export type EntryIconSpec =
  | { kind: "folder"; open: boolean }
  | { kind: "file"; id: string; code: number; color: string };

/** What a row shows on its left: a folder (open or closed) or a file glyph. */
export function entryIcon(name: string | null | undefined, isDirectory = false, open = false): EntryIconSpec {
  if (isDirectory) return { kind: "folder", open };
  const id = name ? resolveSetiIconId(name) : SETI_DEFAULT_ID;
  const def = SETI_ICON_DEFS[id] ?? FALLBACK;
  return { kind: "file", id: SETI_ICON_DEFS[id] ? id : SETI_DEFAULT_ID, code: def.code, color: def.color };
}

/** Desktop's dark-scheme folder colours. */
export const FOLDER_FILL = "#EAB308";
export const FOLDER_STROKE = "#CA8A04";
