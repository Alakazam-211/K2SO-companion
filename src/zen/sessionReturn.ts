import { mainHandleOf, writeDrawerOrigin } from "./sessionDrawer";
import type { ZenTerminalReturn } from "./terminalJump";
import { useZenStore } from "./zenStore";

/** Shown (with "Open main chat") when a session's Thread can't be opened. */
export const SESSION_UNAVAILABLE = "K2 can't open this session's thread. It may have ended or moved.";

/** `/zen?addr=` (terminal Done): reopen one session's Thread without
 *  re-hydrating the main chat over it. The agent list is re-read, but the
 *  drawer origin (Done mode) is kept, and a row the list no longer has
 *  (`ws/N` tab, conversation id, History row) is rebuilt from `back.side`
 *  instead of falling through to "Not chattable". */
export async function resumeSessionThread(
  addr: string,
  back: ZenTerminalReturn | null
): Promise<void> {
  const want = addr.trim();
  if (!want) return;
  const z = useZenStore;
  // Done mode is the return's to restore; a bare `?addr=` is not in it.
  const origin = back?.drawerOrigin ?? null;
  writeDrawerOrigin(origin);
  z.setState({ drawerOrigin: origin });

  const samePath = (p?: string | null) =>
    !back?.side?.path || (p || "").trim() === back.side.path.trim();
  const rowFor = () => {
    const rows = z.getState().agents.filter((a) => (a.addr || "").trim() === want);
    return rows.find((a) => a.id === back?.agentId) ?? rows.find((a) => samePath(a.path)) ?? rows[0];
  };

  await z.getState().hydrateAgents({ resumeId: back?.agentId || rowFor()?.id || want });

  let row = rowFor();
  if (row) {
    if (z.getState().agentId !== row.id) z.getState().setAgent(row.id);
    return;
  }
  if (back?.side) {
    // openWorkspaceSession adds the row (parent colours, origin kept).
    z.getState().openWorkspaceSession({ addr: want, path: back.side.path, side: back.side });
    row = rowFor();
    if (row) {
      // Same id as before the re-read: setAgent was skipped there.
      z.getState().setAgent(row.id);
      return;
    }
  }
  // Nothing to open. Offer the workspace's main chat instead of a raw error.
  if (!origin) {
    const handle = mainHandleOf(want);
    const main = z
      .getState()
      .agents.find((a) => a.kind !== "group" && (a.addr || "").trim() === handle);
    if (main && main.addr !== want) {
      writeDrawerOrigin(main.id);
      z.setState({ drawerOrigin: main.id });
    }
  }
  z.setState({
    screen: "thread",
    agentId: back?.agentId || want,
    threadSource: "error",
    threadError: SESSION_UNAVAILABLE,
    thread: [],
    threadAddr: want,
    threadGroupId: null,
    threadConversationId: null,
  });
}
