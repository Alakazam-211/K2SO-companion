import { entryIcon, FOLDER_FILL, FOLDER_STROKE } from "./resolve";
import "./seti.css";

/** Default box: 16px, the same as desktop's Files drawer. */
const SIZE = 16;

/** K2's gold folder, open or closed (desktop FileTree `FolderIcon`). */
export function FolderIcon({ open = false, size = SIZE }: { open?: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={FOLDER_FILL}
      stroke={FOLDER_STROKE}
      strokeWidth={1}
      className="shrink-0"
      aria-hidden
      data-testid="entry-icon"
      data-icon={open ? "folder-open" : "folder"}
    >
      {open ? (
        <>
          <path d="M5 4h4l2 2h8a1 1 0 011 1v1H4V5a1 1 0 011-1z" />
          <path d="M3.5 9h17l-1.5 11H5L3.5 9z" />
        </>
      ) : (
        <path d="M5 4h4l2 2h8a1 1 0 011 1v12a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1z" />
      )}
    </svg>
  );
}

/** Coloured Seti file-type glyph for a file name (or path). */
export function FileIcon({ name, size = SIZE }: { name?: string | null; size?: number }) {
  const spec = entryIcon(name, false);
  if (spec.kind !== "file") return null;
  const px = `${size}px`;
  return (
    <span
      className="inline-flex items-center justify-center shrink-0 leading-none select-none"
      style={{ fontFamily: "k2-seti, sans-serif", fontSize: px, width: px, height: px, color: spec.color }}
      aria-hidden
      data-testid="entry-icon"
      data-icon={spec.id}
    >
      {String.fromCodePoint(spec.code)}
    </span>
  );
}

/** The left-hand icon for any Files row: folder or file. */
export function EntryIcon({
  name,
  isDirectory = false,
  open = false,
  size = SIZE,
}: {
  name?: string | null;
  isDirectory?: boolean;
  open?: boolean;
  size?: number;
}) {
  return isDirectory ? <FolderIcon open={open} size={size} /> : <FileIcon name={name} size={size} />;
}
