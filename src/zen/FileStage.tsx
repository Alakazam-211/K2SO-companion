import { createPortal } from "react-dom";
import { FileViewer } from "./files/FileViewer";
import { useZenStore } from "./zenStore";

/** The open file, full screen. Zen still mounts this inside its old
 *  side-panel box; the viewer portals to <body> as a fixed overlay so it
 *  covers the chat header and the home bar area too. React events still
 *  bubble to that box, which stops them before the thread's tap-to-dismiss.
 *  The phone's old tab strip and two-pane split are gone: one file at a
 *  time, and the title menu switches between open files. Mounted only
 *  with a file to show (the viewer's swipe-back binds to its root once). */
export function FileStage() {
  const open = useZenStore(
    (s) => s.openFileIds.length > 0 && s.files.some((f) => f.id === s.focusId)
  );
  if (!open || typeof document === "undefined") return null;
  return createPortal(<FileViewer />, document.body);
}
