import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { inspectProjectsSummary } from "../api/client";
import { StubMark } from "./StubMark";
import { summariseProjectsSummary, type SummaryDump } from "./summaryDump";
import { sourceWord, useZenStore } from "./zenStore";

/** Phone-width overlay home. Look is public/imessage-baseline.html (7724968). */
export function ChatsList() {
  const navigate = useNavigate();
  const agents = useZenStore((s) => s.agents);
  const source = useZenStore((s) => s.agentSource);
  const agentError = useZenStore((s) => s.agentError);
  const setAgent = useZenStore((s) => s.setAgent);
  const [q, setQ] = useState("");
  const [settings, setSettings] = useState(false);
  const [dump, setDump] = useState<SummaryDump | null>(null);
  const [dumpBusy, setDumpBusy] = useState(false);

  const filtered = agents.filter((a) =>
    a.name.toLowerCase().includes(q.trim().toLowerCase())
  );

  return (
    <div
      className="flex flex-col h-full min-h-0 relative"
      style={{
        background: "#000",
        color: "#fff",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, sans-serif',
      }}
      data-testid="chats-home"
    >
      <header
        className="flex items-center justify-between relative shrink-0"
        style={{
          minHeight: 44,
          padding: "max(12px, env(safe-area-inset-top)) 16px 8px",
        }}
      >
        <button
          type="button"
          className="text-[17px]"
          style={{
            minHeight: 34,
            padding: "0 14px",
            borderRadius: 17,
            background: "#1c1c1e",
            color: "#fff",
          }}
          onClick={() => setSettings(true)}
        >
          Settings
        </button>
        <h1
          className="absolute left-1/2 -translate-x-1/2 text-[17px] font-semibold pointer-events-none"
          style={{ letterSpacing: "-0.2px" }}
        >
          Chats
        </h1>
        <span className="text-[11px] tracking-widest uppercase" style={{ color: "#8e8e93" }}>
          {sourceWord(source)}
        </span>
      </header>

      <div
        className="grid grid-cols-3 shrink-0"
        style={{ padding: "4px 10px 8px", gap: "14px 6px", minHeight: 96 }}
        data-testid="chats-pins"
      >
        <div className="text-center" style={{ opacity: 0.45 }}>
          <div
            className="mx-auto mb-2 flex items-center justify-center"
            style={{
              width: 74,
              height: 74,
              borderRadius: "50%",
              border: "1.5px dashed #636366",
              color: "#636366",
              fontSize: 26,
            }}
          >
            +
          </div>
          <div className="text-[12px]" style={{ color: "#d1d1d6" }}>
            Drop here
          </div>
        </div>
      </div>
      <p
        className="text-center shrink-0"
        style={{ fontSize: 11, color: "#8e8e93", padding: "0 16px 10px", lineHeight: 1.3 }}
      >
        Hold a chat, then drag it up here to pin.
      </p>

      <div
        className="flex-1 min-h-0 overflow-y-auto"
        style={{ paddingBottom: 96, WebkitOverflowScrolling: "touch" }}
        data-testid="chats-list"
      >
        {source === "loading" ? (
          <p className="px-4 py-6 text-[14px]" style={{ color: "#8e8e93" }}>
            Loading
          </p>
        ) : null}
        {source !== "loading" && agentError && filtered.length > 0 ? (
          <p className="px-4 py-3 text-[14px]" style={{ color: "#f59e0b" }}>
            {agentError}
          </p>
        ) : null}
        {source !== "loading" && filtered.length === 0 ? (
          <p
            className="px-4 py-6 text-[14px]"
            style={{ color: "#8e8e93" }}
            data-testid="chats-empty"
          >
            {agentError || "No agents on this list."}
          </p>
        ) : null}
        {filtered.map((a) => (
          <button
            key={a.id}
            type="button"
            className="w-full flex items-center text-left relative"
            style={{ gap: 10, padding: "10px 14px 10px 6px" }}
            onClick={() => setAgent(a.id)}
            aria-label={source === "stub" ? `STUB ${a.name}` : a.name}
          >
            <span
              className="flex items-center justify-center shrink-0 font-bold"
              style={{
                width: 50,
                height: 50,
                borderRadius: "50%",
                background: "#3a3a3c",
                fontSize: 18,
              }}
            >
              {a.initial}
            </span>
            <span className="flex-1 min-w-0">
              <span className="flex justify-between items-baseline gap-2">
                <span className="truncate text-[16px] font-semibold" style={{ letterSpacing: "-0.2px" }}>
                  {a.name}
                </span>
                {source === "stub" ? <StubMark /> : null}
              </span>
              <span
                className="block text-[14px] truncate"
                style={{ color: "#8e8e93", lineHeight: 1.3 }}
              >
                {source === "stub"
                  ? "STUB"
                  : a.addr
                    ? "Thread"
                    : a.joinMiss || "No thread addr"}
              </span>
            </span>
          </button>
        ))}
      </div>

      <div
        className="absolute left-3 right-3 flex items-center"
        style={{
          bottom: "max(14px, env(safe-area-inset-bottom))",
          gap: 10,
          zIndex: 4,
        }}
      >
        <label
          className="flex-1 flex items-center"
          style={{
            gap: 8,
            background: "#1c1c1e",
            borderRadius: 22,
            padding: "9px 14px",
          }}
        >
          <span className="sr-only">Search</span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search"
            className="flex-1 bg-transparent border-0 outline-none text-[17px]"
            style={{ color: "#fff" }}
            aria-label="Search"
          />
        </label>
        <button
          type="button"
          disabled
          title="New message — not wired"
          aria-label="New message"
          className="flex items-center justify-center"
          style={{
            width: 44,
            height: 44,
            borderRadius: 14,
            background: "#1c1c1e",
            color: "#8e8e93",
          }}
        >
          +
        </button>
      </div>

      {settings ? (
        <div
          className="absolute inset-0 flex flex-col"
          style={{ background: "#000", zIndex: 6 }}
          data-testid="overlay-settings"
        >
          <div
            className="flex items-center justify-between relative shrink-0"
            style={{
              minHeight: 44,
              padding: "max(12px, env(safe-area-inset-top)) 16px 8px",
            }}
          >
            <button
              type="button"
              className="text-[17px]"
              style={{
                minHeight: 34,
                padding: "0 14px",
                borderRadius: 17,
                background: "#1c1c1e",
              }}
              onClick={() => setSettings(false)}
            >
              Done
            </button>
            <h1 className="absolute left-1/2 -translate-x-1/2 text-[17px] font-semibold pointer-events-none">
              Settings
            </h1>
            <span style={{ width: 72 }} />
          </div>
          <button
            type="button"
            className="w-full flex justify-between text-[17px]"
            style={{
              padding: "14px 16px",
              borderBottom: "0.5px solid rgba(255,255,255,.12)",
            }}
            onClick={() => {
              setSettings(false);
              navigate("/servers");
            }}
          >
            <span>Current app</span>
            <span style={{ color: "#8e8e93" }}>›</span>
          </button>
          <p
            className="text-[13px]"
            style={{ color: "#8e8e93", padding: "8px 16px 16px", lineHeight: 1.35 }}
          >
            Leave this overlay and use the app as it is today — Servers, Sessions, Tickets.
          </p>
          <button
            type="button"
            className="w-full flex justify-between text-[17px]"
            style={{
              padding: "14px 16px",
              borderTop: "0.5px solid rgba(255,255,255,.12)",
              borderBottom: "0.5px solid rgba(255,255,255,.12)",
            }}
            onClick={() => {
              if (dumpBusy) return;
              setDumpBusy(true);
              void inspectProjectsSummary()
                .then((r) => setDump(summariseProjectsSummary(r.status, r.data, r.note)))
                .finally(() => setDumpBusy(false));
            }}
          >
            <span>DEBUG projects-summary</span>
            <span style={{ color: "#8e8e93" }}>{dumpBusy ? "…" : "›"}</span>
          </button>
          <p
            className="text-[13px]"
            style={{ color: "#f59e0b", padding: "8px 16px 8px", lineHeight: 1.35 }}
          >
            DEBUG — not a release. Dumps live shape on this screen. Never the token.
          </p>
          {dump ? (
            <div
              data-testid="summary-dump"
              className="text-[13px] overflow-y-auto"
              style={{
                color: "#d1d1d6",
                padding: "8px 16px 24px",
                lineHeight: 1.45,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              }}
            >
              <p>HTTP status: {dump.status ?? "none"}</p>
              <p>Top-level: {dump.top}</p>
              <p>Row count: {dump.rowCount ?? "none"}</p>
              <p>Row keys: {dump.rowKeys.length ? dump.rowKeys.join(", ") : "none"}</p>
              {dump.note ? <p>Note: {dump.note}</p> : null}
              <p style={{ marginTop: 8 }}>Samples (name · path):</p>
              {dump.samples.length === 0 ? (
                <p>none</p>
              ) : (
                dump.samples.map((s, i) => (
                  <p key={i}>
                    {i + 1}. {s.name} · {s.path}
                  </p>
                ))
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
