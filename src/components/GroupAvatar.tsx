// Slice C2 — the project-group avatar (mobile port of the desktop's
// ProjectGroupAvatar anatomy): the group's ICON when one is set (store-
// cached per server:group), else the group initial on the canonical
// `color`, else the initial on the stable hashed palette pick — so a
// group looks the same on desktop and phone.

import { useEffect } from "react";
import { useProjectGroupsStore } from "../stores/projectGroups";
import { useServersStore } from "../stores/servers";
import { groupAvatarColor, groupInitial, iconCacheKey } from "../lib/projectChat";

export function GroupAvatar({
  groupId,
  name,
  color,
  size = 36,
}: {
  groupId: string;
  name: string;
  /** The group's canonical `color`; null → hashed palette. */
  color: string | null;
  size?: number;
}) {
  const serverId = useServersStore((s) => s.activeServerId);
  const entry = useProjectGroupsStore((s) =>
    serverId ? s.icons[iconCacheKey(serverId, groupId)] : undefined
  );
  const revision = useProjectGroupsStore((s) => s.revision);
  const ensureIcon = useProjectGroupsStore((s) => s.ensureIcon);

  // groups-changed drops the cache entry THEN bumps revision — re-run so
  // mounted avatars pick a fresh upload up live.
  useEffect(() => {
    ensureIcon(groupId);
  }, [groupId, serverId, revision, ensureIcon]);

  const fallbackColor = color ?? groupAvatarColor(groupId);

  if (entry?.found && entry.dataUrl) {
    return (
      <span
        className="shrink-0 block overflow-hidden"
        style={{ width: size, height: size, border: `2px solid ${fallbackColor}` }}
      >
        <img
          src={entry.dataUrl}
          alt={name}
          className="block w-full h-full object-cover object-center"
        />
      </span>
    );
  }

  return (
    <span
      className="flex items-center justify-center shrink-0 font-bold"
      style={{
        width: size,
        height: size,
        backgroundColor: fallbackColor,
        color: "#ffffff",
        fontSize: size * 0.45,
        lineHeight: 1,
      }}
    >
      {groupInitial(name)}
    </span>
  );
}
