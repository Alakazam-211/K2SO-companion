import { useEffect, useState } from "react";
import { STOPPED_LINGER_MS, threadStripView, type ThreadStripTone } from "./threadStrip";
import type { ThreadTurn } from "./threadTurn";

// The Thread working strip: under the last message while the agent works
// on your message; gone when the turn ends. Nothing in it is stored.
// It counts its own clock (1 Hz, from the daemon's `startedAt` /
// `phaseSince`, corrected by `serverNow`), so the list around it does not
// re-render every second. Words: `threadStripView`.

const TONE: Record<ThreadStripTone, string> = {
  working: "var(--success)",
  monitoring: "var(--accent)",
  "needs-you": "var(--warning)",
  stopped: "var(--text-muted)",
  unverifiable: "var(--text-muted)",
};

/** A tool line: backtick spans become code. */
function StepText({ text }: { text: string }) {
  const parts = text.split("`");
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 && i < parts.length - 1 ? (
          <code
            key={i}
            className="px-1 font-mono text-[0.92em] rounded-[5px]"
            style={{ background: "var(--wash-08)" }}
          >
            {p}
          </code>
        ) : (
          <span key={i}>{i % 2 === 1 ? `\`${p}` : p}</span>
        )
      )}
    </>
  );
}

function useStripNow(turn: ThreadTurn): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (turn.end === null) {
      const id = setInterval(() => setNow(Date.now()), 1_000);
      return () => clearInterval(id);
    }
    if (turn.end.reason === "interrupted") {
      const left = turn.end.at + STOPPED_LINGER_MS - (Date.now() + turn.skewMs);
      if (left <= 0) return;
      const id = setTimeout(() => setNow(Date.now()), left + 50);
      return () => clearTimeout(id);
    }
  }, [turn]);
  return now;
}

export function ThreadWorkingStrip({ turn }: { turn: ThreadTurn }) {
  const now = useStripNow(turn);
  const view = threadStripView(turn, now);
  if (!view) return null;
  const color = TONE[view.tone];
  const pulsing = view.tone === "working";
  // Full width, fixed rows: the tile spans the message column and keeps
  // its step and tally rows while the turn is live, so it neither widens
  // with the tool line nor jumps in height as rows come and go. Text
  // truncates; the clocks sit right with tabular digits.
  const live = turn.end === null;
  return (
    <div
      role="status"
      aria-label={view.ariaLabel}
      data-testid="thread-working-strip"
      data-tone={view.tone}
      data-phase={turn.phase}
      className="k2-tile self-stretch w-full min-w-0 flex flex-col gap-[3px] px-3 py-2 mt-1"
      style={{
        borderRadius: 16,
        borderStyle: view.tone === "unverifiable" ? "dashed" : undefined,
      }}
    >
      <div className="flex items-center gap-2 min-w-0 text-[13px] leading-[18px] min-h-[18px]">
        <span
          aria-hidden
          className={`relative inline-block flex-none w-2 h-2 rounded-full box-border ${pulsing ? "k2-pulse" : ""}`}
          style={
            view.tone === "monitoring" || view.tone === "stopped" || view.tone === "unverifiable"
              ? { border: `2px solid ${color}` }
              : { background: color, color }
          }
        />
        {view.label ? (
          <span
            data-testid="thread-strip-state"
            className="flex-1 min-w-0 font-semibold truncate"
            style={{ color }}
          >
            {view.label}
          </span>
        ) : null}
        <span
          data-testid="thread-strip-since"
          className="ml-auto flex-none tabular-nums text-right"
          style={{ color: "var(--text-muted)" }}
        >
          {view.since}
        </span>
      </div>
      {view.step ? (
        <div
          data-testid="thread-strip-step"
          className="flex items-baseline gap-2 min-w-0 text-[14px] leading-[20px] min-h-[20px]"
          style={{ color: "var(--text)" }}
        >
          {view.step.kind === "needs" ? (
            <span aria-hidden className="flex-none" style={{ color: "var(--warning)" }}>
              !
            </span>
          ) : null}
          <span
            data-testid="thread-strip-step-text"
            className={`flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap ${
              view.step.kind === "thinking" ? "k2-shimmer" : ""
            }`}
          >
            {view.step.kind === "line" ? <StepText text={view.step.text} /> : view.step.text}
          </span>
          {view.step.elapsed ? (
            <span
              data-testid="thread-strip-elapsed"
              className="ml-auto flex-none tabular-nums text-right text-[12px]"
              style={{ color: "var(--text-muted)" }}
            >
              {view.step.elapsed}
            </span>
          ) : null}
        </div>
      ) : live ? (
        <div aria-hidden data-testid="thread-strip-step-slot" className="min-h-[20px]" />
      ) : null}
      {view.tally.length ? (
        <div
          data-testid="thread-strip-tally"
          className="min-w-0 truncate text-[12px] leading-[16px] min-h-[16px]"
          style={{ color: "var(--text-muted)" }}
        >
          {view.tally.join(" · ")}
        </div>
      ) : live ? (
        <div aria-hidden data-testid="thread-strip-tally-slot" className="min-h-[16px]" />
      ) : null}
    </div>
  );
}
