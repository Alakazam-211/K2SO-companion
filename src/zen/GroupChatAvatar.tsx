import { useEffect } from "react";
import { groupAvatarColor, groupInitial, iconCacheKey } from "../lib/projectChat";
import { useProjectGroupsStore } from "../stores/projectGroups";
import { useServersStore } from "../stores/servers";
import { WorkspaceAvatar } from "./WorkspaceAvatar";

/** A project group's avatar in Zen (Projects sheet rows, the project
 *  chat header): the image from the group's settings
 *  (`GET /cli/project-group/icon`, cached per server:group in the
 *  project-groups store), else its initial on the group's colour, else
 *  on the stable palette pick, as `GroupAvatar`. Glass edge from
 *  `WorkspaceAvatar`. */
export function GroupChatAvatar({
  groupId,
  name,
  color,
  size,
  fontSize,
}: {
  groupId: string;
  name: string;
  /** The group's canonical `color`; null → hashed palette. */
  color?: string | null;
  size: number;
  fontSize: number;
}) {
  const serverId = useServersStore((s) => s.activeServerId);
  const entry = useProjectGroupsStore((s) =>
    serverId ? s.icons[iconCacheKey(serverId, groupId)] : undefined
  );
  // groups-changed drops the cache entry then bumps revision: re-run so a
  // fresh upload shows live.
  const revision = useProjectGroupsStore((s) => s.revision);
  const ensureIcon = useProjectGroupsStore((s) => s.ensureIcon);
  useEffect(() => {
    ensureIcon(groupId);
  }, [groupId, serverId, revision, ensureIcon]);
  return (
    <WorkspaceAvatar
      initial={groupInitial(name)}
      color={color || groupAvatarColor(groupId)}
      iconUrl={entry?.found ? entry.dataUrl : null}
      size={size}
      fontSize={fontSize}
    />
  );
}
