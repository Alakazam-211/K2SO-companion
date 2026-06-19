import type { GlobalSession } from "../api/client";

// Same chat icon the K2 desktop app uses on the chat tab (TabBar.tsx
// section === 'chat'): a speech-bubble outline with three dots.
const ChatIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
    <path d="M2 4 a1.5 1.5 0 0 1 1.5 -1.5 H12.5 a1.5 1.5 0 0 1 1.5 1.5 V10 a1.5 1.5 0 0 1 -1.5 1.5 H7.5 L4 14 V11.5 H3.5 a1.5 1.5 0 0 1 -1.5 -1.5 Z" />
    <circle cx="5.5" cy="7" r="0.6" fill="currentColor" />
    <circle cx="8" cy="7" r="0.6" fill="currentColor" />
    <circle cx="10.5" cy="7" r="0.6" fill="currentColor" />
  </svg>
);

/**
 * Two-part session identity: [workspace name] | [main-chat badge OR tab name].
 * Shown in the session list AND the open-session header so it's always clear
 * which workspace the user is talking to and which tab they're in.
 */
export function SessionTitle({
  session,
}: {
  session: Pick<GlobalSession, "workspaceName" | "isMainChat" | "label" | "agentName">;
}) {
  return (
    <div className="flex items-center gap-2 min-w-0 text-[13px]">
      <span className="text-[var(--text)] font-medium truncate">
        {session.workspaceName}
      </span>
      <span className="text-[var(--text-muted)] opacity-50 shrink-0">|</span>
      {session.isMainChat ? (
        <span className="flex items-center gap-1 text-[var(--accent)] shrink-0">
          <ChatIcon />
          main chat
        </span>
      ) : (
        <span className="text-[var(--text-muted)] truncate">
          {session.label || session.agentName}
        </span>
      )}
    </div>
  );
}
