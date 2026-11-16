// The pictures of Home chat on the phone (desktop `HomeChatGlyphs.tsx`):
//   - a person: their picture, else their initials on their person colour
//     (the daemon's username hash), in black or white, whichever reads
//     better; round, with the agent avatar's glass edge;
//   - a channel: `#` for open, a lock for invite-only (null, not known
//     yet, draws `#`), as Lucide `hash` / `lock`, in a round elevated tile
//     the size of an agent avatar.

import { Hash, Lock } from "lucide-react";
import { personColor, personInitials, personInk } from "./homeChatRows";
import "../workspaceAvatar.css";

/** The app's icon stroke (the group glyphs'). */
const STROKE = 1.75;

export function PersonAvatar({
  username,
  name,
  picture = null,
  size,
  fontSize,
}: {
  /** Their username on that server (their colour comes from it). */
  username: string;
  /** Their shown name (the initials). */
  name: string;
  picture?: string | null;
  size: number;
  fontSize?: number;
}) {
  const color = personColor(username || name);
  return (
    <span
      data-testid="person-avatar"
      data-home-chat-avatar={picture ? "picture" : "initials"}
      data-person-color={color}
      className={`k2-avatar${size <= 32 ? " k2-avatar-sm" : ""} flex items-center justify-center shrink-0 font-bold overflow-hidden`}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        color: personInk(color),
        fontSize: fontSize ?? Math.round(size * 0.38),
        position: "relative",
        zIndex: 0,
        letterSpacing: "0.2px",
      }}
    >
      {picture ? (
        <img src={picture} alt="" draggable={false} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
      ) : (
        personInitials(name)
      )}
      <span aria-hidden className="k2-avatar-glass" style={{ pointerEvents: "none", borderRadius: "inherit", zIndex: 1 }} />
    </span>
  );
}

/** `#` open, a lock invite-only. */
export function ChannelGlyph({ inviteOnly, size }: { inviteOnly: boolean | null; size: number }) {
  const Icon = inviteOnly ? Lock : Hash;
  return (
    <Icon
      size={size}
      strokeWidth={STROKE}
      aria-hidden="true"
      focusable="false"
      data-channel-glyph={inviteOnly ? "lock" : "hash"}
      className="block shrink-0"
    />
  );
}

/** A channel's avatar: its glyph in a round elevated tile. */
export function ChannelAvatar({ inviteOnly, size }: { inviteOnly: boolean | null; size: number }) {
  return (
    <span
      data-testid="channel-avatar"
      data-invite-only={inviteOnly === null ? undefined : String(inviteOnly)}
      className={`k2-avatar${size <= 32 ? " k2-avatar-sm" : ""} flex items-center justify-center shrink-0 overflow-hidden`}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "var(--color-bg-elevated)",
        color: "var(--color-text-secondary)",
        boxShadow: "inset 0 0 0 1px var(--color-control-edge)",
        position: "relative",
        zIndex: 0,
      }}
    >
      <ChannelGlyph inviteOnly={inviteOnly} size={Math.round(size * 0.42)} />
      <span aria-hidden className="k2-avatar-glass" style={{ pointerEvents: "none", borderRadius: "inherit", zIndex: 1 }} />
    </span>
  );
}

/** lucide "phone": the hold menu's Call. */
export function CallGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden data-testid="call-glyph">
      <path d="M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384" />
    </svg>
  );
}
