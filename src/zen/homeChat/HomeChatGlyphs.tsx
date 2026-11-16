// The pictures of Home chat (desktop `HomeChatGlyphs.tsx`):
//   - a person: their picture, else their initials on their colour (the
//     daemon's username hash, `personColor`), in the ink that reads better;
//     round, like the phone's agent avatars;
//   - a channel: `#` for an open channel, a lock for an invite-only one
//     (null: not known yet, drawn as `#`), in the app's line-icon stroke.

import { personColor, personInitials, personInk } from "./homeChatModel";

export function PersonAvatar({
  username,
  name,
  picture = null,
  size = 32,
  testId,
}: {
  /** Their username on that server (their colour comes from it). */
  username: string;
  /** Their shown name (the initials). */
  name: string;
  picture?: string | null;
  size?: number;
  testId?: string;
}) {
  const color = personColor(username || name);
  return (
    <span
      aria-hidden
      data-testid={testId}
      data-person-avatar={picture ? "picture" : "initials"}
      className="k2-avatar flex items-center justify-center shrink-0 font-bold overflow-hidden"
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        color: personInk(color),
        fontSize: Math.round(size * (size >= 20 ? 0.4 : 0.5)),
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
export function ChannelAvatar({ inviteOnly, size = 42 }: { inviteOnly: boolean | null | undefined; size?: number }) {
  return (
    <span
      aria-hidden
      data-testid="home-chat-channel-avatar"
      className="k2-avatar flex items-center justify-center shrink-0"
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "var(--color-bg-elevated)",
        color: "var(--color-text-primary)",
        position: "relative",
        zIndex: 0,
      }}
    >
      <ChannelGlyph inviteOnly={inviteOnly} size={Math.round(size * 0.45)} />
    </span>
  );
}
