import { useState } from "react";
import type { StubAgent } from "./stubData";
import { WorkspaceAvatar } from "./WorkspaceAvatar";
import { useZenStore } from "./zenStore";

/** New Message picker. Groups open immediately. Agents ask main vs sidecar. */
export function OverlayCompose({ onClose }: { onClose: () => void }) {
  const agents = useZenStore((s) => s.agents);
  const source = useZenStore((s) => s.agentSource);
  const setAgent = useZenStore((s) => s.setAgent);
  const openSidecar = useZenStore((s) => s.openSidecar);
  const [ask, setAsk] = useState<StubAgent | null>(null);
  const [busy, setBusy] = useState(false);
  const [sideError, setSideError] = useState<string | null>(null);

  const pickable = agents.filter((a) => {
    if (a.kind === "group") return true;
    if (source === "stub") return true;
    const addr = (a.addr || "").trim();
    if (!addr || a.joinMiss) return false;
    return !addr.includes("/");
  });

  const pick = (a: StubAgent) => {
    if (source === "stub" || a.kind === "group") {
      onClose();
      setAgent(a.id);
      return;
    }
    setAsk(a);
  };

  return (
    <div
      className="absolute inset-0 flex flex-col"
      style={{ background: "#000", zIndex: 6 }}
      data-testid="overlay-compose"
    >
      <div
        className="flex items-center justify-between relative shrink-0"
        style={{
          minHeight: 44,
          padding: "12px 16px 8px",
        }}
      >
        <button
          type="button"
          className="text-[17px] k2-tile"
          style={{
            minHeight: 34,
            padding: "0 14px",
            borderRadius: 17,
          }}
          onClick={onClose}
        >
          Cancel
        </button>
        <h1 className="absolute left-1/2 -translate-x-1/2 text-[17px] font-semibold pointer-events-none">
          New Message
        </h1>
        <span style={{ width: 72 }} />
      </div>
      <p
        className="text-center shrink-0"
        style={{ fontSize: 11, color: "#8e8e93", padding: "0 16px 10px", lineHeight: 1.3 }}
      >
        Pick someone. Next we’ll ask main chat or a separate chat.
      </p>
      <div
        className="flex-1 min-h-0 overflow-y-auto"
        style={{ paddingBottom: 24, WebkitOverflowScrolling: "touch" }}
        data-testid="compose-list"
      >
        {pickable.length === 0 ? (
          <p className="px-4 py-6 text-[14px]" style={{ color: "#8e8e93" }}>
            No one to message on this list.
          </p>
        ) : (
          pickable.map((a) => (
            <button
              key={a.id}
              type="button"
              className="w-full flex items-center text-left"
              style={{ gap: 10, padding: "10px 14px" }}
              onClick={() => pick(a)}
            >
              <WorkspaceAvatar
                initial={a.initial}
                color={a.color}
                iconUrl={a.iconUrl}
                size={50}
                fontSize={18}
              />
              <span className="truncate text-[16px] font-semibold">{a.name}</span>
            </button>
          ))
        )}
      </div>
      {ask ? (
        <div
          className="absolute inset-0 flex items-end justify-center"
          style={{ background: "rgba(0,0,0,.45)", zIndex: 7 }}
          data-testid="compose-ask"
          onClick={(e) => {
            if (e.target === e.currentTarget) setAsk(null);
          }}
        >
          <div
            className="w-full k2-tile k2-tile-sheet"
            style={{
              borderTopLeftRadius: 14,
              borderTopRightRadius: 14,
              padding: "18px 16px max(16px, env(safe-area-inset-bottom))",
            }}
          >
            <p className="text-[15px] text-center" style={{ lineHeight: 1.35, padding: "0 8px 16px" }}>
              Do you want to talk to the main chat or start a separate chat with {ask.name}?
            </p>
            <button
              type="button"
              className="w-full font-semibold text-[17px]"
              style={{
                minHeight: 44,
                borderRadius: 12,
                background: "#0a84ff",
                color: "#fff",
                marginBottom: 8,
              }}
              onClick={() => {
                const id = ask.id;
                setAsk(null);
                onClose();
                setAgent(id);
              }}
            >
              Main chat
            </button>
            <button
              type="button"
              className="w-full font-semibold text-[17px] k2-tile k2-tile-raised"
              style={{
                minHeight: 44,
                borderRadius: 12,
                color: "#fff",
                marginBottom: 8,
                opacity: busy ? 0.4 : 1,
              }}
              disabled={busy}
              onClick={() => {
                const id = ask.id;
                setBusy(true);
                setSideError(null);
                void openSidecar(id).then((result) => {
                  setBusy(false);
                  if (result.ok) {
                    setAsk(null);
                    onClose();
                    return;
                  }
                  setSideError(result.error || "Could not start a separate chat");
                });
              }}
            >
              {busy ? "Starting…" : "Separate chat"}
            </button>
            {sideError ? (
              <p
                className="text-[13px] text-center"
                style={{ color: "#ef4444", padding: "0 8px 8px" }}
                data-testid="compose-sidecar-error"
              >
                {sideError}
              </p>
            ) : null}
            <button
              type="button"
              className="w-full text-[17px]"
              style={{ minHeight: 44, color: "#8e8e93" }}
              onClick={() => setAsk(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
