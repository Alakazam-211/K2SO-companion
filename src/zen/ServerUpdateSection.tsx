import { useEffect, useState } from "react";
import { bootInfoFor, ensureBootStatus, type ServerScope } from "../api/scope";

const MUTED = "#8e8e93";

export interface ServerUpdateSectionProps {
  serverId: string;
  scope: ServerScope;
  /** whoami role: "owner" | "admin" | "member", or null while unknown.
   *  Only owner / admin will get update controls. */
  role: string | null;
}

/** Server settings → K2 version. Today it only says which K2 the server
 *  runs (`/boot-status` version). The server-update controls (check,
 *  install, progress; owner / admin only) land here once the daemon
 *  contract exists. */
export function ServerUpdateSection({ serverId, scope }: ServerUpdateSectionProps) {
  const [version, setVersion] = useState<string | null>(
    () => bootInfoFor(serverId)?.version ?? null
  );
  const [checked, setChecked] = useState(() => bootInfoFor(serverId) !== null);

  useEffect(() => {
    let live = true;
    setVersion(bootInfoFor(serverId)?.version ?? null);
    void ensureBootStatus(scope).then((info) => {
      if (!live) return;
      setVersion(info?.version ?? null);
      setChecked(true);
    });
    return () => {
      live = false;
    };
  }, [serverId, scope]);

  return (
    <div
      className="flex items-center justify-between text-[17px]"
      style={{ minHeight: 44, padding: "11px 16px", gap: 12 }}
      data-testid="server-update-section"
    >
      <span data-testid="server-version">
        {version ? `K2 ${version}` : checked ? "K2" : "K2 …"}
      </span>
      {!version && checked ? (
        <span className="text-[15px]" style={{ color: MUTED }}>
          Version unknown
        </span>
      ) : null}
    </div>
  );
}
