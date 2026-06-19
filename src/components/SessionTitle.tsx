import type { GlobalSession } from "../api/client";

const PinIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
    <path d="M12 17v5" />
    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
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
          <PinIcon />
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
