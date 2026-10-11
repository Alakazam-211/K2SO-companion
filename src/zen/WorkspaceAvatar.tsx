import "./workspaceAvatar.css";

/** At or below this size the glass sheen is softened (28px headers). */
export const AVATAR_SMALL_PX = 32;

type Props = {
  initial: string;
  color?: string | null;
  iconUrl?: string | null;
  size: number;
  fontSize: number;
  fallback?: string;
};

export function WorkspaceAvatar({
  initial,
  color,
  iconUrl,
  size,
  fontSize,
  fallback = "#3a3a3c",
}: Props) {
  const small = size <= AVATAR_SMALL_PX;
  return (
    <span
      data-testid="workspace-avatar"
      className={`k2-avatar${small ? " k2-avatar-sm" : ""} flex items-center justify-center shrink-0 font-bold overflow-hidden`}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: color || fallback,
        fontSize,
        color: "#fff",
        position: "relative",
        // Own stacking context: the glass layer stays inside the avatar,
        // so a sibling activity dot (later in the DOM) paints above it.
        zIndex: 0,
      }}
    >
      {iconUrl ? (
        <img
          src={iconUrl}
          alt=""
          draggable={false}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: "center",
          }}
        />
      ) : (
        initial
      )}
      {/* Glass edge (rim + top sheen), over the image or the initial. */}
      <span
        aria-hidden
        data-testid="workspace-avatar-glass"
        className="k2-avatar-glass"
        style={{ pointerEvents: "none", borderRadius: "inherit", zIndex: 1 }}
      />
    </span>
  );
}
