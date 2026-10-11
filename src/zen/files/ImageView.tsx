import { useEffect, useRef, useState } from "react";
import { ViewerNote } from "./BinaryEmptyState";
import { bytesToObjectUrl, imagePayload } from "./fileBytes";
import { useFileBytes } from "./useFileBytes";

const MAX_ZOOM = 5;

/** Image from daemon bytes (sniffed MIME → Blob URL; SVG stays an <img>,
 *  so its scripts never run). Fits the width; pinch zooms, double-tap
 *  toggles 1x / 2.5x. Zoom widens the <img> so the box scrolls natively. */
export function ImageView({ path, name }: { path: string | null; name: string }) {
  const { bytes, error } = useFileBytes(path);
  const [url, setUrl] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  const [zoom, setZoom] = useState(1);
  const boxRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;

  useEffect(() => {
    setBroken(false);
    setZoom(1);
    if (!bytes || !path) {
      setUrl(null);
      return;
    }
    const p = imagePayload(bytes, path);
    const u = bytesToObjectUrl(p.bytes, p.mime);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [bytes, path]);

  // Native listeners: React's touchmove is passive, so it cannot stop the
  // page from treating a pinch as a scroll.
  useEffect(() => {
    const el = boxRef.current;
    if (!el || !url) return;
    let startDist = 0;
    let startZoom = 1;
    let lastTap = 0;
    const dist = (t: TouchList) =>
      Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        startDist = dist(e.touches);
        startZoom = zoomRef.current;
      }
    };
    const onMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || startDist <= 0) return;
      e.preventDefault();
      const z = (startZoom * dist(e.touches)) / startDist;
      setZoom(Math.min(MAX_ZOOM, Math.max(1, z)));
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) startDist = 0;
      if (e.touches.length > 0 || e.changedTouches.length !== 1) return;
      const now = Date.now();
      if (now - lastTap < 300) {
        setZoom(zoomRef.current > 1 ? 1 : 2.5);
        lastTap = 0;
      } else {
        lastTap = now;
      }
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
    };
  }, [url]);

  if (error) return <ViewerNote tone="error" title="Could not load the image" detail={error} />;
  if (broken) {
    const heic = /\.(heic|heif|tiff?)$/i.test(name);
    return (
      <ViewerNote
        tone="error"
        title="This image could not be shown"
        detail={heic ? "This format may not paint in the app. Try a PNG or JPEG export." : null}
      />
    );
  }
  if (!url) return <ViewerNote title="Loading image…" />;

  return (
    <div
      ref={boxRef}
      className="h-full w-full overflow-auto fv-scroll fv-safe-bottom"
      data-testid="file-image"
      style={{ touchAction: "pan-x pan-y" }}
    >
      <div
        className="flex min-h-full items-center justify-center p-3"
        style={{ width: zoom > 1 ? `${zoom * 100}%` : "100%" }}
      >
        <img
          src={url}
          alt={name}
          draggable={false}
          onError={() => setBroken(true)}
          style={{ width: zoom > 1 ? "100%" : undefined, maxWidth: "100%", height: "auto" }}
        />
      </div>
    </div>
  );
}
