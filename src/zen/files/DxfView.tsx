import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { ViewerNote } from "./BinaryEmptyState";
import type { Bounds, DxfDrawing, DxfNode } from "./dxfModel";

type Box = { x: number; y: number; w: number; h: number };

/** Zoom limits, relative to the fitted view. */
const MIN_SCALE = 0.25;
const MAX_SCALE = 400;
const DOUBLE_TAP_MS = 300;

/** The fitted viewBox in SVG space (Y already flipped), 4% margin. */
export function fitBox(b: Bounds): Box {
  const w = Math.max(b.maxX - b.minX, 1e-6);
  const h = Math.max(b.maxY - b.minY, 1e-6);
  const pad = Math.max(w, h) * 0.04;
  return { x: b.minX - pad, y: -b.maxY - pad, w: w + 2 * pad, h: h + 2 * pad };
}

const fmtNum = (v: number) =>
  String(Number(Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2)));

function skippedLabel(skipped: Record<string, number>): string {
  return Object.entries(skipped)
    .sort((a, b) => b[1] - a[1])
    .map(([t, c]) => (c > 1 ? `${t} ×${c}` : t))
    .join(", ");
}

function renderNode(node: DxfNode, key: number): ReactNode {
  switch (node.k) {
    case "line":
      return <line key={key} x1={node.x1} y1={node.y1} x2={node.x2} y2={node.y2} stroke={node.c} />;
    case "circle":
      return <circle key={key} cx={node.cx} cy={node.cy} r={node.r} stroke={node.c} />;
    case "path":
      return node.fill ? (
        <path key={key} d={node.d} fill={node.c} stroke={node.c} />
      ) : (
        <path key={key} d={node.d} stroke={node.c} />
      );
    case "text":
      // Un-flip so it reads; DXF rotation is counter-clockwise.
      return (
        <text
          key={key}
          transform={`translate(${node.x} ${node.y}) scale(1 -1)${node.rot ? ` rotate(${-node.rot})` : ""}`}
          fontSize={node.h}
          textAnchor={node.anchor}
          fill={node.c}
          stroke="none"
        >
          {node.lines.length === 1 ? (
            <tspan x={0} y={node.y0}>{node.lines[0]}</tspan>
          ) : (
            node.lines.map((l, i) => (
              <tspan key={i} x={0} y={node.y0 + i * node.lh}>
                {l || " "}
              </tspan>
            ))
          )}
        </text>
      );
    case "group":
      return (
        <g key={key} transform={`matrix(${node.m.join(" ")})`}>
          {node.children.map(renderNode)}
        </g>
      );
  }
}

/** The drawing itself; memoised so pan/zoom never re-renders it. */
const DxfShapes = memo(function DxfShapes({ nodes }: { nodes: DxfNode[] }) {
  return (
    <g transform="scale(1 -1)" fill="none" strokeWidth={1} className="fv-dxf" data-testid="dxf-shapes">
      {nodes.map(renderNode)}
    </g>
  );
});

/** ASCII DXF as SVG: parsed lazily (dxf-parser), fitted on open, one
 *  finger pans, pinch zooms around the fingers, double-tap refits. */
export function DxfView({ text }: { text: string }) {
  const [drawing, setDrawing] = useState<DxfDrawing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const viewRef = useRef<Box | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDrawing(null);
    setError(null);
    import("./dxfModel")
      .then((m) => {
        const d = m.buildDrawing(text);
        if (!cancelled) setDrawing(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [text]);

  const fit = drawing?.bounds ? fitBox(drawing.bounds) : null;

  // Gestures write the viewBox straight to the DOM: no React render per frame.
  useEffect(() => {
    const el = boxRef.current;
    const svg = svgRef.current;
    if (!el || !svg || !fit) return;
    const apply = (v: Box) => {
      viewRef.current = v;
      svg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
    };
    apply(fit);

    /** SVG units per screen pixel (viewBox is "meet"-fitted). */
    const unitsPerPx = (v: Box) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return { k: 1, r };
      return { k: Math.max(v.w / r.width, v.h / r.height), r };
    };
    /** Screen point → SVG point under it. */
    const toSvg = (v: Box, cx: number, cy: number) => {
      const { k, r } = unitsPerPx(v);
      const ox = v.x + v.w / 2 - (r.width * k) / 2;
      const oy = v.y + v.h / 2 - (r.height * k) / 2;
      return { x: ox + (cx - r.left) * k, y: oy + (cy - r.top) * k };
    };
    const zoomAt = (v: Box, factor: number, cx: number, cy: number): Box => {
      const scaleNow = fit.w / v.w;
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scaleNow * factor));
      const f = scaleNow / next;
      const p = toSvg(v, cx, cy);
      return { x: p.x - (p.x - v.x) * f, y: p.y - (p.y - v.y) * f, w: v.w * f, h: v.h * f };
    };

    let last: { x: number; y: number; d: number } | null = null;
    let lastTap = 0;
    let moved = false;
    const mid = (t: TouchList) =>
      t.length >= 2
        ? {
            x: (t[0].clientX + t[1].clientX) / 2,
            y: (t[0].clientY + t[1].clientY) / 2,
            d: Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY),
          }
        : { x: t[0].clientX, y: t[0].clientY, d: 0 };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 1) moved = false;
      if (e.touches.length > 1) moved = true;
      last = mid(e.touches);
    };
    const onMove = (e: TouchEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      if (!v || !last || e.touches.length === 0) return;
      const now = mid(e.touches);
      let next = v;
      if (now.d > 0 && last.d > 0) next = zoomAt(next, now.d / last.d, now.x, now.y);
      const { k } = unitsPerPx(next);
      const dx = (now.x - last.x) * k;
      const dy = (now.y - last.y) * k;
      if (Math.abs(now.x - last.x) + Math.abs(now.y - last.y) > 2) moved = true;
      apply({ ...next, x: next.x - dx, y: next.y - dy });
      last = now;
    };
    const onEnd = (e: TouchEvent) => {
      last = e.touches.length ? mid(e.touches) : null;
      if (e.touches.length > 0 || moved) return;
      const t = Date.now();
      if (t - lastTap < DOUBLE_TAP_MS) {
        apply(fit);
        lastTap = 0;
      } else {
        lastTap = t;
      }
    };
    // Trackpad / mouse (dev builds, iPad pointer).
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      if (v) apply(zoomAt(v, Math.exp(-e.deltaY * 0.002), e.clientX, e.clientY));
    };
    const onDbl = () => apply(fit);
    // Safari's own page pinch.
    const stopGesture = (e: Event) => e.preventDefault();

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onEnd, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("dblclick", onDbl);
    el.addEventListener("gesturestart", stopGesture);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("dblclick", onDbl);
      el.removeEventListener("gesturestart", stopGesture);
    };
    // `fit` is derived from `drawing`: re-bind only when the drawing changes.
  }, [drawing]);

  if (error) {
    const binary = /binary dxf/i.test(error);
    return <ViewerNote tone="error" title={binary ? "Binary DXF is not supported" : "Could not draw the DXF"} detail={binary ? "Save it as ASCII DXF to preview it here." : error} testId="dxf-error" />;
  }
  if (!drawing) return <ViewerNote title="Drawing…" />;
  if (!fit || !drawing.bounds) {
    return (
      <ViewerNote
        title="Nothing to draw"
        detail={drawing.skippedTotal ? `${drawing.skippedTotal} entities not shown (${skippedLabel(drawing.skipped)}).` : null}
        testId="dxf-empty"
      />
    );
  }

  const b = drawing.bounds;
  return (
    <div className="flex h-full w-full flex-col" data-testid="file-dxf">
      <div className="shrink-0 px-4 pb-1.5 text-[12px] text-[var(--text-muted)]" data-testid="dxf-stats">
        {drawing.drawn.toLocaleString()} entities · {fmtNum(b.maxX - b.minX)} × {fmtNum(b.maxY - b.minY)} units
        {drawing.layers > 1 ? ` · ${drawing.layers} layers` : ""}
      </div>
      <div
        ref={boxRef}
        className="relative min-h-0 flex-1 overflow-hidden"
        style={{ touchAction: "none", color: "var(--text)" }}
      >
        <svg
          ref={svgRef}
          className="block h-full w-full"
          viewBox={`${fit.x} ${fit.y} ${fit.w} ${fit.h}`}
          preserveAspectRatio="xMidYMid meet"
          data-testid="dxf-svg"
        >
          <DxfShapes nodes={drawing.nodes} />
        </svg>
        {drawing.skippedTotal ? (
          <div
            className="pointer-events-none absolute left-3 right-3 text-[11px] text-[var(--text-muted)]"
            style={{ bottom: "max(10px, env(safe-area-inset-bottom))" }}
            data-testid="dxf-skipped"
          >
            {drawing.skippedTotal} {drawing.skippedTotal === 1 ? "entity" : "entities"} not shown ({skippedLabel(drawing.skipped)})
          </div>
        ) : null}
      </div>
    </div>
  );
}
