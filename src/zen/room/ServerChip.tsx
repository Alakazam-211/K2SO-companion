import { hostLabel, useServersStore } from "../../stores/servers";
import { showServerChips } from "../multi/merge";

/** MS37: the room's server under a header name (chat, terminal, Sessions
 *  drawer), only when more than one server is saved (Q2). */
export function ServerChip({
  serverId,
  testId = "server-chip",
  align = "center",
}: {
  serverId: string | null | undefined;
  testId?: string;
  align?: "center" | "left" | "right";
}) {
  const count = useServersStore((s) => s.servers.length);
  const label = useServersStore((s) => {
    const e = s.servers.find((x) => x.id === serverId);
    return e ? e.nickname || hostLabel(e.url) : "";
  });
  if (!serverId || !label || !showServerChips(count)) return null;
  return (
    <span
      data-testid={testId}
      data-server-id={serverId}
      className="block truncate text-[11px] leading-tight"
      style={{ color: "#8e8e93", textAlign: align, maxWidth: "100%" }}
    >
      {label}
    </span>
  );
}
