// The pictures of Home chat (desktop `HomeChatGlyphs.tsx`):
//   - a person: their picture, else their initials on their colour (the
//     daemon's username hash, `personColor`), in the ink that reads better;
//     round, like the phone's agent avatars;
//   - a channel: `#` for an open channel, a lock for an invite-only one
//     (null: not known yet, drawn as `#`), in the app's line-icon stroke.
// Shared by the chat view and Home's person / channel rows (`glass` gives
// a row's avatar the agent avatars' glass edge).

import { personColor, personInitials, personInk } from "./homeChatModel";
import "../workspaceAvatar.css";

/** The agent avatars' glass edge (rim + top sheen), over the picture. */
function GlassEdge() {
  return <span aria-hidden className="k2-avatar-glass" style={{ pointerEvents: "none", borderRadius: "inherit", zIndex: 1 }} />;
}

export function PersonAvatar({
  username,
  name,
  picture = null,
  size = 32,
  testId,
  fontSize,
  glass = false,
}: {
  /** Their username on that server (their colour comes from it). */
  username: string;
  /** Their shown name (the initials). */
  name: string;
  picture?: string | null;
  size?: number;
  testId?: string;
  /** The initials' size (default: from `size`). */
  fontSize?: number;
  /** The glass edge (Home rows, beside agent avatars). */
  glass?: boolean;
}) {
  const color = personColor(username || name);
  return (
    <span
      aria-hidden
      data-testid={testId}
      data-person-avatar={picture ? "picture" : "initials"}
      data-person-color={color}
      className={`k2-avatar${glass && size <= 32 ? " k2-avatar-sm" : ""} flex items-center justify-center shrink-0 font-bold overflow-hidden`}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        color: personInk(color),
        fontSize: fontSize ?? Math.round(size * (size >= 20 ? 0.4 : 0.5)),
        lineHeight: 1,
        position: "relative",
        zIndex: 0,
      }}
    >
      {picture ? (
        <img src={picture} alt="" draggable={false} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
      ) : (
        personInitials(name, size)
      )}
      {glass ? <GlassEdge /> : null}
    </span>
  );
}

/** A channel's glyph: `#` open, a lock invite-only (lucide hash / lock). */
export function ChannelGlyph({ inviteOnly, size = 16 }: { inviteOnly: boolean | null | undefined; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      data-channel-glyph={inviteOnly ? "lock" : "hash"}
      className="shrink-0"
    >
      {inviteOnly ? (
        <>
          <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </>
      ) : (
        <>
          <line x1="4" x2="20" y1="9" y2="9" />
          <line x1="4" x2="20" y1="15" y2="15" />
          <line x1="10" x2="8" y1="3" y2="21" />
          <line x1="16" x2="14" y1="3" y2="21" />
        </>
      )}
    </svg>
  );
}

/** A channel avatar for the header: the glyph on a soft round tile. */
export function ChannelAvatar({
  inviteOnly,
  size = 42,
  testId = "home-chat-channel-avatar",
  glass = false,
}: {
  inviteOnly: boolean | null | undefined;
  size?: number;
  testId?: string;
  /** The glass edge and a hairline ring (Home rows). */
  glass?: boolean;
}) {
  return (
    <span
      aria-hidden
      data-testid={testId}
      data-invite-only={inviteOnly === null || inviteOnly === undefined ? undefined : String(inviteOnly)}
      className={`k2-avatar${glass && size <= 32 ? " k2-avatar-sm" : ""} flex items-center justify-center shrink-0 overflow-hidden`}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "var(--color-bg-elevated)",
        color: glass ? "var(--color-text-secondary)" : "var(--color-text-primary)",
        boxShadow: glass ? "inset 0 0 0 1px var(--color-control-edge)" : undefined,
        position: "relative",
        zIndex: 0,
      }}
    >
      <ChannelGlyph inviteOnly={inviteOnly} size={Math.round(size * (glass ? 0.42 : 0.45))} />
      {glass ? <GlassEdge /> : null}
    </span>
  );
}

/** lucide "phone": a person row's hold-menu Call. */
export function CallGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden data-testid="call-glyph">
      <path d="M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384" />
    </svg>
  );
}
