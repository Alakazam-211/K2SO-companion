import { useState } from "react";
import { kbClear, kbReport, returnHoldOn, setReturnHoldOn } from "../lib/kbDiag";
import { Switch } from "./ZenSettings";

const MUTED = "#8e8e93";

/** Server settings → Diagnostics → "Keyboard events": the switch for
 *  keeping the keyboard as left when the app returns (WebKit focus hold),
 *  and the native keyboard / app lifecycle log with page marks, to copy
 *  into a bug report. iOS only (empty elsewhere). */
export function KeyboardEventsRow() {
  const [open, setOpen] = useState(false);
  const [hold, setHold] = useState(returnHoldOn);
  const [log, setLog] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const labelId = "kb-events-hold-label";
  const refresh = async () => {
    setCopied(false);
    setLog((await kbReport()) || "No log (iOS only).");
  };
  return (
    <div>
      <div className="flex items-center justify-between" style={{ padding: "0 16px" }}>
        <button
          type="button"
          className="flex-1 text-left text-[15px]"
          style={{ minHeight: 40, color: MUTED }}
          aria-expanded={open}
          data-testid="kb-events-toggle-panel"
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next) void refresh();
          }}
        >
          <span id={labelId}>Keep keyboard on return</span>
        </button>
        <Switch
          on={hold}
          disabled={false}
          onToggle={() => {
            setReturnHoldOn(!hold);
            setHold(!hold);
          }}
          labelledBy={labelId}
        />
      </div>
      {open ? (
        <div className="text-[12px]" style={{ padding: "0 16px 10px", color: MUTED, lineHeight: 1.45 }} data-testid="kb-events-panel">
          <div style={{ marginBottom: 6 }}>
            Keyboard events: app and keyboard changes, focus and swipes, newest last. No message content.
          </div>
          <pre
            className="text-[10px]"
            style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", background: "#111", color: "#ddd", padding: 8, borderRadius: 8, maxHeight: 260, overflow: "auto" }}
            data-testid="kb-events-log"
          >
            {log ?? "…"}
          </pre>
          <div className="flex" style={{ gap: 16 }}>
            <button type="button" style={{ color: "#0a84ff", minHeight: 36 }} data-testid="kb-events-refresh" onClick={() => void refresh()}>
              Refresh
            </button>
            <button
              type="button"
              style={{ color: "#0a84ff", minHeight: 36 }}
              data-testid="kb-events-copy"
              onClick={() => {
                try {
                  void navigator.clipboard?.writeText(log ?? "").then(() => setCopied(true));
                } catch {
                  /* select the text by hand */
                }
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              style={{ color: "#ff453a", minHeight: 36 }}
              data-testid="kb-events-clear"
              onClick={() => void kbClear().then(refresh)}
            >
              Clear
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
