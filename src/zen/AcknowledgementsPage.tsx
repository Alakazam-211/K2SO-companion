import { useEffect, useState } from "react";
import { useBackHandler } from "../lib/androidBack";
import { BackArrowButton } from "./BackArrowButton";

// The open-source notices that have to ship with the app (MIT, Apache-2.0,
// OFL and the rest): `public/acknowledgements.txt`, made by
// scripts/gen-acknowledgements.mjs and read only when this page opens.

const NOTICES_URL = "/acknowledgements.txt";

export function AcknowledgementsPage({ onBack }: { onBack: () => void }) {
  useBackHandler(true, onBack);
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(NOTICES_URL)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.text();
      })
      .then((t) => {
        if (live) setText(t);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);
  return (
    <div
      className="absolute inset-0 flex flex-col"
      style={{ background: "#000", zIndex: 7, paddingTop: "env(safe-area-inset-top)" }}
      data-testid="acknowledgements-page"
    >
      <div
        className="grid items-center shrink-0"
        style={{ gridTemplateColumns: "1fr auto 1fr", minHeight: 44, padding: "12px 12px 8px", columnGap: 8 }}
      >
        <BackArrowButton onClick={onBack} />
        <h1 className="text-[17px] font-semibold pointer-events-none">Acknowledgements</h1>
        <span />
      </div>
      <div
        className="flex-1 min-h-0 overflow-y-auto"
        style={{ padding: "4px 16px calc(24px + var(--safe-bottom))", WebkitOverflowScrolling: "touch" }}
      >
        {failed ? (
          <p className="text-[15px]" style={{ color: "var(--text-muted)" }} data-testid="acknowledgements-failed">
            Couldn't load the acknowledgements.
          </p>
        ) : (
          <pre
            className="text-[12px] whitespace-pre-wrap break-words"
            style={{ color: "var(--text-secondary)", userSelect: "text", WebkitUserSelect: "text" }}
            data-testid="acknowledgements-text"
          >
            {text ?? ""}
          </pre>
        )}
      </div>
    </div>
  );
}
