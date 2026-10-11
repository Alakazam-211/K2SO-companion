import { useEffect, useRef, useState } from "react";
import { ViewerNote } from "./BinaryEmptyState";
import { formatBytes, READ_BINARY_MAX_BYTES } from "./fileBytes";
import { getFileExtension } from "./fileCategory";
import type { ModelStats } from "./modelParse";
import { useFileBytes } from "./useFileBytes";

/** Past this a phone tab risks dying while three.js builds buffers. */
export const MODEL_MAX_BYTES = READ_BINARY_MAX_BYTES;

/** "Too large" note for a model of `size` bytes, or null if it fits. */
export function modelSizeError(size: number): string | null {
  return size > MODEL_MAX_BYTES
    ? `${formatBytes(size)} is over the ${formatBytes(MODEL_MAX_BYTES)} preview limit.`
    : null;
}

const fmtDim = (v: number) => {
  const a = Math.abs(v);
  if (a === 0) return "0";
  // Trailing zeros dropped: "60", not "60.0".
  return String(Number(a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a >= 0.1 ? v.toFixed(2) : v.toPrecision(2)));
};

export function statsLine(s: ModelStats): string {
  const tris = `${s.triangles.toLocaleString()} triangle${s.triangles === 1 ? "" : "s"}`;
  return `${tris} · ${s.size.map(fmtDim).join(" × ")} units`;
}

type Phase =
  | { k: "loading" }
  | { k: "ready" }
  | { k: "nogl" }
  | { k: "error"; title: string; detail: string };

/** STL / OBJ / 3MF / PLY / glTF in a three.js canvas (lazy chunk).
 *  Stats sit under the header; the canvas fills the rest. */
export function ModelView({ path, name }: { path: string | null; name: string }) {
  const { bytes, error: loadError } = useFileBytes(path);
  const [stats, setStats] = useState<ModelStats | null>(null);
  const [phase, setPhase] = useState<Phase>({ k: "loading" });
  const hostRef = useRef<HTMLDivElement>(null);
  const ext = getFileExtension(name || path || "");

  useEffect(() => {
    setStats(null);
    setPhase({ k: "loading" });
    if (!bytes) return;
    const tooBig = modelSizeError(bytes.byteLength);
    if (tooBig) {
      setPhase({ k: "error", title: "Too large to preview", detail: tooBig });
      return;
    }
    let cancelled = false;
    let dispose: (() => void) | null = null;
    void (async () => {
      try {
        const m = await import("./modelScene");
        const parsed = await m.parseModel(bytes, ext);
        if (cancelled) {
          m.disposeObject(parsed.root);
          return;
        }
        setStats(parsed.stats);
        const host = hostRef.current;
        if (!host || !m.hasWebGL2()) {
          m.disposeObject(parsed.root);
          setPhase({ k: "nogl" });
          return;
        }
        try {
          dispose = m.createViewer(host, parsed.root).dispose;
          setPhase({ k: "ready" });
        } catch {
          m.disposeObject(parsed.root);
          setPhase({ k: "nogl" });
        }
      } catch (e) {
        if (!cancelled) {
          setPhase({ k: "error", title: "Could not open the model", detail: e instanceof Error ? e.message : String(e) });
        }
      }
    })();
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [bytes, ext]);

  if (loadError) {
    const big = /too large|50mb/i.test(loadError);
    return (
      <ViewerNote
        tone="error"
        title={big ? "Too large to preview" : "Could not load the model"}
        detail={loadError}
        testId="model-error"
      />
    );
  }

  const note =
    phase.k === "error" ? (
      <ViewerNote tone="error" title={phase.title} detail={phase.detail} testId="model-error" />
    ) : phase.k === "nogl" ? (
      <ViewerNote title="3D preview needs WebGL" detail="This device's web view did not start WebGL 2." testId="model-nogl" />
    ) : phase.k === "loading" ? (
      <ViewerNote title={bytes ? "Building the model…" : "Loading model…"} />
    ) : null;

  return (
    <div className="flex h-full w-full flex-col" data-testid="file-model">
      {stats ? (
        <div className="shrink-0 px-4 pb-1.5 text-[12px] text-[var(--text-muted)]" data-testid="model-stats">
          {statsLine(stats)}
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-hidden" style={{ touchAction: "none" }}>
        <div ref={hostRef} className="absolute inset-0" data-testid="model-host" />
        {note ? <div className="absolute inset-0">{note}</div> : null}
        {phase.k === "ready" ? (
          <div
            className="pointer-events-none absolute left-3 right-3 text-center text-[11px] text-[var(--text-muted)]"
            style={{ bottom: "max(10px, env(safe-area-inset-bottom))" }}
          >
            Drag to orbit · pinch to zoom · two fingers to pan · double-tap to reset
          </div>
        ) : null}
      </div>
    </div>
  );
}
