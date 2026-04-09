"use client";

import { useState } from "react";

const screens = ["Login", "Dashboard", "Chat", "Sessions", "Reviews", "Settings"] as const;
type Screen = (typeof screens)[number];

export default function Mockup() {
  const [active, setActive] = useState<Screen>("Dashboard");
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex flex-col items-center gap-8 py-12 px-4 w-full max-w-5xl mx-auto font-mono">
      <div className="text-center">
        <h1 className="text-3xl font-bold tracking-tight text-[#e4e4e7]">K2SO Companion</h1>
        <p className="text-[#71717a] text-xs mt-1">Interactive UI Mockup</p>
      </div>

      {/* Screen selector */}
      <div className="flex gap-0 border border-[#1a1a1a]">
        {screens.map((s) => (
          <button
            key={s}
            onClick={() => setActive(s)}
            className={`px-4 py-1.5 text-xs font-medium transition-all duration-150 border-r border-[#1a1a1a] last:border-r-0 ${
              active === s
                ? "bg-[#0e7490] text-[#22d3ee]"
                : "text-[#71717a] hover:text-[#e4e4e7] hover:bg-[#111]"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Phone frame */}
      <div className="relative">
        <div className="w-[375px] h-[812px] bg-[#0a0a0a] rounded-[3rem] border-[3px] border-[#333] overflow-hidden shadow-2xl shadow-cyan-500/5 relative">
          {/* Notch */}
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[120px] h-[30px] bg-black rounded-b-2xl z-50" />

          {/* Status bar */}
          <div className="h-[50px] bg-[#0a0a0a] flex items-end justify-between px-8 pb-1 text-[10px] text-[#71717a] relative z-40">
            <span>9:41</span>
            <div className="flex gap-1 items-center">
              <span>||||</span>
              <span>5G</span>
              <span>100%</span>
            </div>
          </div>

          {/* Screen content */}
          <div className="h-[calc(100%-50px)] flex flex-col bg-[#0a0a0a] relative">
            {active === "Login" && <LoginScreen />}
            {active === "Dashboard" && <DashboardScreen onMenuOpen={() => setDrawerOpen(true)} />}
            {active === "Chat" && <ChatScreen />}
            {active === "Sessions" && <SessionsScreen />}
            {active === "Reviews" && <ReviewsScreen />}
            {active === "Settings" && <SettingsScreen />}

            {/* Workspace Drawer */}
            {drawerOpen && active !== "Login" && (
              <WorkspaceDrawer onClose={() => setDrawerOpen(false)} />
            )}
          </div>

          {/* Home indicator */}
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 w-[134px] h-[5px] bg-[#333] rounded-full" />
        </div>
      </div>

      <p className="text-[#71717a] text-[10px] text-center max-w-md leading-4">
        Built with Tauri v2 Mobile (Rust + React). Same design language as K2SO desktop.
        Connects via ngrok — no cloud required.
      </p>
    </div>
  );
}

/* ─── Login ─── */
function LoginScreen() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6">
      <div className="text-center mb-8">
        <h1 className="text-4xl font-extrabold tracking-[0.2em] text-[#e4e4e7]">K2SO</h1>
        <p className="text-[#71717a] text-[13px] mt-1">Companion</p>
      </div>
      <div className="w-full space-y-3">
        <Field label="Server URL" value="your-tunnel.ngrok.io" muted />
        <Field label="Username" value="admin" />
        <Field label="Password" value="••••••••" />
        <div className="w-full bg-white text-black font-semibold text-[13px] py-3.5 text-center mt-4">
          Connect
        </div>
      </div>
      <p className="text-[#71717a] text-[10px] text-center mt-8 leading-4">
        Enable Mobile Companion in K2SO settings to get your server URL
      </p>
    </div>
  );
}

/* ─── Dashboard ─── */
function DashboardScreen({ onMenuOpen }: { onMenuOpen?: () => void }) {
  return (
    <div className="flex-1 flex flex-col">
      {/* Header bar with hamburger */}
      <div className="flex items-center px-3 py-2.5 border-b border-[#1a1a1a] bg-[#111] shrink-0 gap-3">
        <button onClick={onMenuOpen} className="flex flex-col justify-center items-center w-8 h-8 gap-[5px] bg-[#22d3ee] shrink-0">
          <span className="block h-[2px] w-4 bg-[#0a0a0a]" />
          <span className="block h-[2px] w-4 bg-[#0a0a0a]" />
          <span className="block h-[2px] w-4 bg-[#0a0a0a]" />
        </button>
        <span className="w-4 h-4 flex items-center justify-center text-[8px] font-bold text-black" style={{ background: "#22d3ee" }}>K</span>
        <span className="text-[#e4e4e7] text-[13px] font-semibold">K2SO</span>
        <svg className="ml-auto shrink-0 text-[#71717a]" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="5" width="12" height="10" rx="1" />
          <path d="M5 5V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v7" />
          <path d="M6 9h4" strokeLinecap="round" />
          <path d="M6 12h2" strokeLinecap="round" />
        </svg>
      </div>

      <div className="flex border-b border-[#1a1a1a] bg-[#111] shrink-0">
        {[
          { value: "2", label: "Running" },
          { value: "5", label: "Agents" },
          { value: "2", label: "Reviews" },
        ].map((s) => (
          <div key={s.label} className="flex-1 text-center py-3 border-r border-[#1a1a1a] last:border-r-0">
            <div className="text-[#e4e4e7] text-xl font-bold">{s.value}</div>
            <div className="text-[#71717a] text-[10px]">{s.label}</div>
          </div>
        ))}
        <div className="flex-1 text-center py-3">
          <div className="text-[#e4e4e7] text-[11px] font-bold">Build</div>
          <div className="text-[#71717a] text-[10px]">Mode</div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        <AgentCard name="pod-leader" role="Pod orchestrator — delegates, reviews, drives milestones" badge="LEADER" status="running" active={1} inbox={0} />
        <AgentCard name="rust-eng" role="Rust backend — Tauri, agent hooks, SQLite, LLM" status="running" active={1} inbox={0} />
        <AgentCard name="frontend-eng" role="Frontend — React 19, TypeScript, Zustand, Tailwind" status="idle" active={0} inbox={2} />
        <AgentCard name="cli-eng" role="CLI — bash scripting, agent commands" status="idle" active={0} inbox={0} />
        <AgentCard name="qa-eng" role="QA — integration tests, behavior tests" status="idle" active={0} inbox={1} />
      </div>

      <TabBar active="dashboard" />
    </div>
  );
}

/* ─── Chat ─── */
function ChatScreen() {
  return (
    <div className="flex-1 flex flex-col">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-[#1a1a1a] shrink-0">
        <span className="text-[#22d3ee] text-[13px]">←</span>
        <span className="text-[#e4e4e7] text-[13px] font-semibold">rust-eng</span>
        <div className="ml-auto w-2 h-2 rounded-full bg-[#22c55e]" />
      </div>

      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-1.5">
        <Bubble from="agent">I&apos;ll implement the companion proxy module. Reading agent_hooks.rs to understand the routing...</Bubble>
        <Bubble from="agent">Found the HTTP server at line 280. Creating companion.rs with ngrok + auth proxy.</Bubble>
        <Bubble from="agent">Adding ngrok, tungstenite, argon2 to Cargo.toml. Should I add rate limiting?</Bubble>
        <Bubble from="user">Yes, 60 req/min per session token.</Bubble>
        <Bubble from="agent">Got it. Token-bucket rate limiter, counters per session in a HashMap with timestamps.</Bubble>
        <Bubble from="user">Make sure WebSocket bypasses the rate limiter.</Bubble>
        <Bubble from="agent">Good call. WS upgrade requests skip rate limit. Only REST endpoints limited. Implementing now...</Bubble>
      </div>

      <div className="flex gap-2 p-3 border-t border-[#1a1a1a] bg-[#111] shrink-0">
        <div className="flex-1 bg-[#0a0a0a] border border-[#1a1a1a] px-3 py-2.5 text-[#71717a] text-[13px]">
          Send a message to the agent...
        </div>
        <div className="w-10 h-10 border border-[#1a1a1a] text-[#71717a] flex items-center justify-center shrink-0 text-lg">
          ↑
        </div>
      </div>
    </div>
  );
}

/* ─── Sessions (⌘J) ─── */
function SessionsScreen() {
  return (
    <div className="flex-1 flex flex-col bg-black/60">
      <div className="mt-auto bg-[#0a0a0a] border-t border-[#1a1a1a] flex flex-col max-h-[70%]">
        <div className="flex items-center justify-center py-2"><div className="w-10 h-1 bg-[#333] rounded-full" /></div>
        <div className="px-4 pb-1 flex items-center justify-between">
          <span className="text-[#e4e4e7] text-[13px] font-semibold">Active Sessions</span>
          <span className="text-[#71717a] text-[10px]">4 sessions</span>
        </div>
        <div className="flex-1 overflow-y-auto px-4 pb-8">
          {/* K2SO workspace */}
          <div className="mt-3">
            <span className="text-[#71717a] text-[10px] font-semibold tracking-widest uppercase">K2SO</span>
            <div className="mt-1 space-y-1">
              <SessionRow color="#22d3ee" name="pod-leader" id="term-001" />
              <SessionRow color="#22d3ee" name="rust-eng" id="term-002" />
            </div>
          </div>
          {/* Alakazam website */}
          <div className="mt-3">
            <span className="text-[#71717a] text-[10px] font-semibold tracking-widest uppercase">Alakazam Website</span>
            <div className="mt-1 space-y-1">
              <SessionRow color="#f97316" name="frontend-eng" id="term-003" />
            </div>
          </div>
          {/* Design system */}
          <div className="mt-3">
            <span className="text-[#71717a] text-[10px] font-semibold tracking-widest uppercase">Design System</span>
            <div className="mt-1 space-y-1">
              <SessionRow color="#a78bfa" name="docs-writer" id="term-004" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SessionRow({ color, name, id }: { color: string; name: string; id: string }) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2.5 bg-[#111] border border-[#1a1a1a] hover:border-[#333] transition-all">
      <div className="w-1 h-6 shrink-0" style={{ background: color }} />
      <div className="flex-1 min-w-0">
        <span className="text-[#e4e4e7] text-[11px] font-medium block truncate">{name}</span>
        <span className="text-[#71717a] text-[9px] block">{id}</span>
      </div>
      <div className="w-2 h-2 rounded-full bg-[#22c55e] shrink-0" />
    </div>
  );
}

/* ─── Reviews ─── */
function ReviewsScreen() {
  return (
    <div className="flex-1 flex flex-col">
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {/* Auth warning */}
        <div className="border border-[#f59e0b]/30 bg-[#f59e0b]/5 p-3 mb-1">
          <p className="text-[#f59e0b] text-[10px] font-semibold mb-0.5">Preview links</p>
          <p className="text-[#71717a] text-[10px] leading-4">
            Previews are served through your ngrok tunnel. If the app uses OAuth/SSO, add your ngrok URL as an approved redirect URI.
          </p>
        </div>

        <Review
          agent="rust-eng"
          branch="feat/companion-proxy"
          title="Add companion proxy with ngrok tunnel"
          summary="13 endpoints, WebSocket, argon2 hashing, rate limiting"
          previewUrl="https://abc123.ngrok-free.app/_preview/3000/"
        />
        <Review
          agent="frontend-eng"
          branch="fix/tab-drag-split"
          title="Fix tab dragging between split windows"
          summary="Resolved react-mosaic drop target across window boundaries"
        />
      </div>
      <TabBar active="reviews" />
    </div>
  );
}

/* ─── Settings ─── */
function SettingsScreen() {
  return (
    <div className="flex-1 flex flex-col">
      <div className="flex-1 overflow-y-auto p-4">
        <Section title="Connection">
          <Row label="Server" value="abc123.ngrok-free.app" />
          <Row label="Username" value="admin" />
          <Row label="WebSocket" value={<><span className="w-2 h-2 rounded-full bg-[#22c55e] inline-block mr-1.5" />Connected</>} />
          <Row label="Latency" value="42ms" />
        </Section>
        <Section title="About">
          <Row label="Version" value="1.0.0" />
          <Row label="App" value="K2SO Companion" />
          <Row label="Engine" value="Tauri v2" />
        </Section>
        <div className="w-full border border-[#ef4444]/30 text-[#ef4444] font-semibold text-[13px] py-3.5 text-center mt-4">
          Disconnect
        </div>
      </div>
      <TabBar active="settings" />
    </div>
  );
}

/* ─── Shared ─── */

function Field({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div>
      <label className="text-[#71717a] text-[10px] mb-1 block">{label}</label>
      <div className={`w-full bg-[#111] border border-[#1a1a1a] px-4 py-3.5 text-[13px] ${muted ? "text-[#71717a]" : "text-[#e4e4e7]"}`}>
        {value}
      </div>
    </div>
  );
}

function AgentCard({ name, role, badge, status, active, inbox }: {
  name: string; role: string; badge?: string; status: "running" | "idle"; active: number; inbox: number;
}) {
  const isRunning = status === "running";
  const canWake = !isRunning && (inbox > 0 || active > 0);
  return (
    <div className="bg-[#111] border border-[#1a1a1a] p-3.5 transition-all duration-150 hover:border-[#333]">
      <div className="flex items-center gap-2 mb-0.5">
        <div className={`w-2 h-2 rounded-full shrink-0 ${isRunning ? "bg-[#22c55e]" : "bg-[#71717a]"}`} />
        <span className="text-[#e4e4e7] font-semibold text-[13px] flex-1 truncate">{name}</span>
        {badge && <span className="text-[9px] font-bold tracking-wide text-[#22d3ee] bg-[#22d3ee]/10 px-1.5 py-0.5">{badge}</span>}
      </div>
      <p className="text-[#71717a] text-[11px] truncate mb-1.5">{role}</p>
      <div className="flex gap-1.5">
        {active > 0 && <span className="text-[9px] text-[#22c55e] bg-[#22c55e]/10 px-1.5 py-0.5">{active} active</span>}
        {inbox > 0 && <span className="text-[9px] text-[#22d3ee] bg-[#22d3ee]/10 px-1.5 py-0.5">{inbox} inbox</span>}
        {active === 0 && inbox === 0 && <span className="text-[9px] text-[#71717a]">No work items</span>}
      </div>
      {isRunning && <p className="text-[9px] text-[#22c55e] font-medium mt-1">Running in terminal — tap to chat</p>}
      {canWake && (
        <div className="mt-2 w-full text-center py-1.5 border border-[#0e7490] text-[#22d3ee] text-[11px] font-semibold hover:border-[#22d3ee] hover:bg-[#22d3ee]/5 transition-all">
          Wake Agent
        </div>
      )}
    </div>
  );
}

function Bubble({ from, children }: { from: "user" | "agent"; children: React.ReactNode }) {
  const isUser = from === "user";
  return (
    <div className={`max-w-[85%] px-3 py-2 text-[11px] leading-4 ${
      isUser
        ? "self-end bg-[#0e7490] text-[#e4e4e7] border border-[#22d3ee]/30"
        : "self-start bg-[#111] text-[#e4e4e7] border border-[#1a1a1a]"
    }`}>
      {children}
    </div>
  );
}

function Review({ agent, branch, title, summary, previewUrl }: {
  agent: string; branch: string; title: string; summary: string; previewUrl?: string;
}) {
  return (
    <div className="bg-[#111] border border-[#1a1a1a] p-3.5">
      <div className="flex justify-between items-center mb-1">
        <span className="text-[#22d3ee] text-[11px] font-semibold">{agent}</span>
        <span className="text-[#71717a] text-[9px]">{branch}</span>
      </div>
      <p className="text-[#e4e4e7] text-[13px] font-medium mb-0.5">{title}</p>
      <p className="text-[#a1a1aa] text-[11px] mb-2">{summary}</p>
      {previewUrl && (
        <div className="border border-[#1a1a1a] px-3 py-2 mb-2 hover:border-[#0e7490] transition-all">
          <span className="text-[#71717a] text-[9px] block mb-0.5">Preview</span>
          <span className="text-[#22d3ee] text-[10px] truncate block">{previewUrl}</span>
        </div>
      )}
      <div className="flex gap-1.5">
        <div className="flex-1 py-1.5 border border-[#22c55e]/30 text-[#22c55e] text-[11px] font-semibold text-center">Approve</div>
        <div className="flex-1 py-1.5 border border-[#f59e0b]/30 text-[#f59e0b] text-[11px] font-semibold text-center">Changes</div>
        <div className="flex-1 py-1.5 border border-[#ef4444]/30 text-[#ef4444] text-[11px] font-semibold text-center">Reject</div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[#111] border border-[#1a1a1a] overflow-hidden mb-4">
      <h3 className="text-[#71717a] text-[10px] font-semibold tracking-widest uppercase px-4 pt-3 pb-2">{title}</h3>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center px-4 py-3 border-t border-[#1a1a1a]">
      <span className="text-[#71717a] text-[11px]">{label}</span>
      <span className="text-[#e4e4e7] text-[11px] text-right truncate ml-4 max-w-[60%]">{value}</span>
    </div>
  );
}

function TabBar({ active }: { active: string }) {
  const tabs = [
    { id: "dashboard", label: "Dashboard", icon: "⊞" },
    { id: "chat", label: "Chat", icon: "◈" },
    { id: "reviews", label: "Reviews", icon: "⎇" },
    { id: "settings", label: "Settings", icon: "⚙" },
  ];
  return (
    <nav className="flex border-t border-[#1a1a1a] bg-[#0a0a0a] shrink-0 px-2 pb-4">
      {tabs.map((t) => (
        <div key={t.id} className={`flex-1 flex flex-col items-center pt-2 gap-0.5 ${active === t.id ? "text-[#22d3ee]" : "text-[#71717a]"}`}>
          <span className="text-lg">{t.icon}</span>
          <span className="text-[10px]">{t.label}</span>
        </div>
      ))}
    </nav>
  );
}

function WorkspaceDrawer({ onClose }: { onClose: () => void }) {
  const workspaces = [
    { name: "K2SO", color: "#22d3ee", active: true, running: 2, status: "working" as const },
    { name: "Website", color: "#a78bfa", running: 0 },
    { name: "Alakazam", color: "#f97316", running: 1, status: "review" as const },
    { name: "Design System", color: "#22c55e", running: 0 },
    { name: "Pipeline", color: "#ec4899", running: 0, status: "permission" as const },
  ];
  const statusColor = (s?: string) => s === "working" ? "#22d3ee" : s === "permission" ? "#ef4444" : s === "review" ? "#22c55e" : undefined;

  return (
    <>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 z-40" onClick={onClose} />
      {/* Drawer */}
      <div className="absolute top-0 left-0 bottom-0 w-[260px] bg-[#0a0a0a] border-r border-[#1a1a1a] z-50 flex flex-col">
        <div className="px-4 pt-4 pb-2 flex items-center justify-between">
          <span className="text-[#71717a] text-[10px] font-semibold tracking-widest uppercase">Workspaces</span>
          <button onClick={onClose} className="text-[#71717a] text-[13px] hover:text-[#e4e4e7]">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto px-2">
          {workspaces.map((w) => {
            const sc = statusColor(w.status);
            return (
              <button
                key={w.name}
                onClick={onClose}
                className={`w-full flex items-center gap-2.5 px-3 py-3 transition-all duration-150 ${
                  w.active ? "bg-white/[0.08] text-[#e4e4e7]" : "text-[#a1a1aa] hover:bg-white/[0.04]"
                }`}
              >
                <span className="w-5 h-5 shrink-0 flex items-center justify-center text-[9px] font-bold text-black" style={{ background: w.color }}>
                  {w.name.charAt(0)}
                </span>
                <span className="text-[12px] font-medium flex-1 truncate text-left">{w.name}</span>
                {sc && <span className="w-2 h-2 rounded-full shrink-0" style={{ background: sc }} />}
                {w.running > 0 && <span className="text-[9px] text-[#22c55e] shrink-0">{w.running} running</span>}
              </button>
            );
          })}
        </div>
        <div className="px-4 py-3 border-t border-[#1a1a1a]">
          <span className="text-[#71717a] text-[10px]">Connected to abc123.ngrok-free.app</span>
        </div>
      </div>
    </>
  );
}
