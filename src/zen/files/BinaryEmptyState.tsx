import { FileIcon } from "../icons";

/** Centered status line for a viewer: loading, error, or an empty state. */
export function ViewerNote({
  title,
  detail,
  tone = "muted",
  testId,
}: {
  title: string;
  detail?: string | null;
  tone?: "muted" | "error";
  testId?: string;
}) {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-1.5 px-8 text-center"
      data-testid={testId}
    >
      <span
        className={`text-[14px] ${tone === "error" ? "text-[var(--warning)]" : "text-[var(--text-secondary)]"}`}
      >
        {title}
      </span>
      {detail ? (
        <span className="max-w-full text-[12px] leading-4 text-[var(--text-muted)] break-words">
          {detail}
        </span>
      ) : null}
    </div>
  );
}

/** Desktop `BinaryEmptyState`: an honest note, never bytes dumped as text.
 *  No "Reveal in Finder": that opens a window on the Mac, not the phone. */
export function BinaryEmptyState({
  filePath,
  message = "Binary file. It can't be shown as text.",
  detail,
}: {
  filePath: string;
  message?: string;
  detail?: string | null;
}) {
  const name = filePath.split("/").pop() || filePath;
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-2 px-8 text-center"
      data-testid="file-binary"
    >
      <FileIcon size={40} strokeWidth={1.5} stroke="var(--text-muted)" />
      <span className="text-[14px] text-[var(--text)]">{message}</span>
      <span className="max-w-full truncate font-mono text-[12px] text-[var(--text-muted)]">
        {detail || name}
      </span>
    </div>
  );
}
