import { useNavigate } from "react-router-dom";
import { readZenThread, zenThreadPath } from "./terminalJump";

/** Original-UI door back to the overlay thread. */
export function ZenReturnButton({ className }: { className?: string }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      aria-label="Chat"
      title="Chat"
      onClick={() => navigate(zenThreadPath(readZenThread()))}
      className={
        className ??
        "w-8 h-8 flex items-center justify-center shrink-0 border border-[var(--accent-dim)] text-[var(--accent)]"
      }
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    </button>
  );
}
