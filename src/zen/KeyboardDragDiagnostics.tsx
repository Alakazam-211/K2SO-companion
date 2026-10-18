import { useState, useSyncExternalStore } from "react";
import {
  clearRecordedDrags,
  recordedDrags,
  recorderOn,
  setRecorderOn,
  subscribeRecorder,
  type RecordedDrag,
} from "../lib/kbDragRecorder";
import { gapSeries, type KbScore } from "../lib/kbDragScore";
import { Switch } from "./ZenSettings";

const MUTED = "#8e8e93";

let version = 0;
function subscribe(fn: () => void) {
  return subscribeRecorder(() => {
    version += 1;
    fn();
  });
}
let seen = -1;
let snap: { on: boolean; drags: RecordedDrag[] } = { on: recorderOn(), drags: recordedDrags() };
function getSnapshot() {
  if (seen !== version) {
    seen = version;
    snap = { on: recorderOn(), drags: recordedDrags() };
  }
  return snap;
}

const n = (v: number | null, unit = "") => (v == null ? "—" : `${v}${unit}`);

/** One drag's score in a line or two. */
export function scoreLines(s: KbScore): [string, string] {
  return [
    `${s.frames} frames · max ${s.maxGap}px · p95 ${s.p95Gap}px · ${s.within1Pct}% ≤1px · ${s.droppedFrames} dropped`,
    `correction ${n(s.correctionStartMs, "ms")} +${n(s.correctionMs, "ms")} · steady off ${s.steadyOffFrames}/${s.steadyFrames} (max ${s.steadyMaxGap}px) · release jump ${n(s.releaseJump, "px")}, landing ${n(s.releaseLandingErr, "px")}` +
      ` · tail max ${s.tailMaxGap}px, ${s.tailDropped} dropped` +
      (s.earlyAttachMs > 0 ? ` · attached ${s.earlyAttachMs}ms early` : ""),
  ];
}

/** Gap over time, ±GAP_RANGE px around the keyboard line. */
const GAP_RANGE = 8;
function Sparkline({ drag }: { drag: RecordedDrag }) {
  const pts = gapSeries(drag.trace);
  if (pts.length < 2) return null;
  const W = 240;
  const H = 36;
  const t0 = pts[0][0];
  const t1 = pts[pts.length - 1][0] || t0 + 1;
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const y = (g: number) => H / 2 - (Math.max(-GAP_RANGE, Math.min(GAP_RANGE, g)) / GAP_RANGE) * (H / 2);
  const d = pts.map(([t, g], i) => `${i ? "L" : "M"}${x(t).toFixed(1)},${y(g).toFixed(1)}`).join("");
  const release = drag.trace.events.find((e) => e.k === "release");
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      aria-label="Gap between composer and keyboard over time"
      style={{ display: "block", margin: "4px 0" }}
    >
      <rect x={0} y={y(1)} width={W} height={y(-1) - y(1)} fill="rgba(52,199,89,0.18)" />
      <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="rgba(255,255,255,0.25)" strokeWidth={1} />
      {release ? (
        <line x1={x(release.t)} x2={x(release.t)} y1={0} y2={H} stroke="rgba(10,132,255,0.6)" strokeWidth={1} />
      ) : null}
      <path d={d} fill="none" stroke="#fff" strokeWidth={1.25} />
    </svg>
  );
}

function CopyTrace({ drag }: { drag: RecordedDrag }) {
  const [shown, setShown] = useState<string | null>(null);
  const json = () => JSON.stringify(drag.trace);
  return (
    <>
      <button
        type="button"
        className="text-[12px]"
        style={{ color: "#0a84ff", minHeight: 32, padding: "0 4px" }}
        data-testid="kb-drag-copy"
        onClick={() => {
          const text = json();
          try {
            const p = navigator.clipboard?.writeText(text);
            if (!p) throw new Error("no clipboard");
            p.catch(() => setShown(text));
          } catch {
            setShown(text);
          }
        }}
      >
        Copy trace JSON
      </button>
      {shown ? (
        <textarea
          readOnly
          value={shown}
          onFocus={(e) => e.currentTarget.select()}
          className="w-full text-[10px]"
          style={{ height: 80, background: "#111", color: "#ddd", border: 0 }}
          data-testid="kb-drag-json"
        />
      ) : null}
    </>
  );
}

/** Server settings → Diagnostics → "Keyboard drag recorder": the toggle
 *  and the last recorded interactive-dismiss drags with their scores. */
export function KeyboardDragRow() {
  const [open, setOpen] = useState(false);
  const { on, drags } = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const labelId = "kb-drag-recorder-label";
  return (
    <div data-testid="server-settings-kb-drag">
      <div className="flex items-center justify-between" style={{ padding: "0 16px" }}>
        <button
          type="button"
          className="flex-1 text-left text-[15px]"
          style={{ minHeight: 40, color: MUTED }}
          aria-expanded={open}
          data-testid="kb-drag-toggle-panel"
          onClick={() => setOpen((v) => !v)}
        >
          <span id={labelId}>Keyboard drag recorder</span>
        </button>
        <Switch on={on} disabled={false} onToggle={() => setRecorderOn(!on)} labelledBy={labelId} />
      </div>
      {open ? (
        <div
          className="text-[12px]"
          style={{ padding: "0 16px 10px", color: MUTED, lineHeight: 1.45 }}
          data-testid="kb-drag-panel"
        >
          <div style={{ marginBottom: 6 }}>
            {on
              ? "Recording each drag of the chat list into the keyboard. Gap = composer bottom − keyboard top (green band ±1px; blue line = release)."
              : "Off. Turn on, then dismiss the keyboard by dragging a chat's messages down into it."}
          </div>
          {drags.length === 0 ? (
            <span>No drags recorded.</span>
          ) : (
            <>
              {drags.map((d, i) => {
                const [a, b] = scoreLines(d.score);
                return (
                  <div key={i} style={{ marginBottom: 8 }} data-testid="kb-drag-row">
                    <Sparkline drag={d} />
                    <div style={{ color: "#fff" }}>{a}</div>
                    <div>{b}</div>
                    <CopyTrace drag={d} />
                  </div>
                );
              })}
              <button
                type="button"
                className="text-[13px]"
                style={{ color: "#ff453a", minHeight: 36 }}
                data-testid="kb-drag-clear"
                onClick={() => clearRecordedDrags()}
              >
                Clear
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
