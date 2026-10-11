import { useEffect, useState } from "react";
import { ViewerNote } from "./BinaryEmptyState";
import { bytesToObjectUrl, formatBytes } from "./fileBytes";
import { mediaMimeFromPath } from "./fileCategory";
import { useFileBytes } from "./useFileBytes";

/** Audio/video (desktop `MediaViewer`). Plays on the phone from a Blob
 *  URL; never on the Mac. Over 50MB the bytes arrive in ranged slices. */
export function MediaView({ path, kind }: { path: string | null; kind: "audio" | "video" }) {
  const { bytes, error, progress } = useFileBytes(path, true);
  const [url, setUrl] = useState<string | null>(null);
  const [unplayable, setUnplayable] = useState(false);

  useEffect(() => {
    setUnplayable(false);
    if (!bytes || !path) {
      setUrl(null);
      return;
    }
    const u = bytesToObjectUrl(bytes, mediaMimeFromPath(path));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [bytes, path]);

  if (error) return <ViewerNote tone="error" title={`Could not load the ${kind}`} detail={error} />;
  if (!url || !bytes) {
    const pct = progress != null ? ` ${Math.round(progress * 100)}%` : "";
    return <ViewerNote title={`Loading ${kind}…${pct}`} detail="Plays on this phone, not on the server." />;
  }
  if (unplayable) {
    return (
      <ViewerNote
        tone="error"
        title={`This ${kind} format does not play on iOS`}
        detail="MKV, FLAC and some WebM files have no iOS decoder. Try MP4, M4A or MP3."
      />
    );
  }

  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 px-4 fv-safe-bottom"
      data-testid="file-media"
    >
      {kind === "audio" ? (
        <audio controls src={url} preload="metadata" className="w-full" onError={() => setUnplayable(true)} />
      ) : (
        <video
          controls
          playsInline
          src={url}
          preload="metadata"
          className="w-full max-h-full bg-black rounded-[12px]"
          onError={() => setUnplayable(true)}
        />
      )}
      <span className="text-[11px] text-[var(--text-muted)]">{formatBytes(bytes.byteLength)}</span>
    </div>
  );
}
