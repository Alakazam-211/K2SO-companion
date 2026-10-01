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
  return (
    <span
      className="flex items-center justify-center shrink-0 font-bold overflow-hidden"
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: color || fallback,
        fontSize,
        color: "#fff",
        position: "relative",
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
    </span>
  );
}
