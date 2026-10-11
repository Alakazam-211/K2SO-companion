import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { asErrorText } from "../lib/apiError";
import { writeClipboard } from "../lib/oscClipboard";
import { createFsFolder, getFsReadDir, renameFsEntry, type ServerScope } from "../api/client";
import { loadGroupPoc } from "./groupPoc";
import { StubMark } from "./StubMark";
import { RESOURCES_EMPTY_LINE, RESOURCES_EMPTY_TITLE } from "./workspaceResources";
import { useZenStore, sourceWord } from "./zenStore";
import { useZenScope, zenScope } from "./zenScope";
import { usableFsPath } from "./workspacePath";
import { MiddleEllipsis } from "./MiddleEllipsis";
import { FileTree, inTree, useFileTree } from "./FileTree";
import { EntryIcon, FileIcon } from "./fileIcons/EntryIcon";
import {
  baseName,
  displayPathUnder,
  fileRefText,
  joinPath,
  parentDir,
  readResourcesCollapsed,
  readShowHidden,
  renameSelection,
  validateEntryName,
  writeResourcesCollapsed,
  writeShowHidden,
} from "./fileTreeModel";
import { useFileDrag } from "./fileDrag";
import { useFileHold, type FileMenu } from "./useFileHold";

/** Drawer width. The tree needs more room than the old resource list. */
export const FILE_PANE_PX = 224;

const ICON_BTN = { width: 28, height: 28, color: "#fff" } as const;

/** The workspace folder the tree is rooted at: the agent's own path, or
 *  for a project chat its PoC member's workspace (`project-group/show`).
 *  Read on the room's server (`scope`), never the active one. */
function useFilesRoot(scope: ServerScope): { root: string | null; note: string | null } {
  const agentId = useZenStore((s) => s.agentId);
  const agents = useZenStore((s) => s.agents);
  const agentSource = useZenStore((s) => s.agentSource);
  const groupRoot = useZenStore((s) => s.groupRoot);
  const row = agents.find((a) => a.id === agentId);
  const groupId = row?.kind === "group" ? row.groupId ?? null : null;
  const [groupNote, setGroupNote] = useState<string | null>(null);

  useEffect(() => {
    if (!groupId || agentSource !== "live" || groupRoot) return;
    let live = true;
    setGroupNote(null);
    void loadGroupPoc(scope, groupId).then((poc) => {
      if (!live || zenScope().id !== scope.id) return;
      if (poc.path) useZenStore.getState().setGroupRoot(poc.path);
      else setGroupNote(poc.note);
    });
    return () => {
      live = false;
    };
  }, [groupId, agentSource, groupRoot, scope.id]);

  if (agentSource === "stub") return { root: null, note: null };
  if (groupId) return { root: groupRoot, note: groupRoot ? null : groupNote ?? "loading" };
  const own = usableFsPath(row?.path ?? "");
  return { root: own, note: own ? null : "No workspace folder for this chat." };
}

async function copyText(text: string): Promise<boolean> {
  if ((await writeClipboard(text)) === "written") return true;
  // WKWebView without the async API: the old selection copy.
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = typeof document.execCommand === "function" && document.execCommand("copy");
    ta.remove();
    return Boolean(ok);
  } catch {
    return false;
  }
}

/** Fresh child names of `dir` on `scope`'s server, for a duplicate check. */
async function namesIn(scope: ServerScope, dir: string): Promise<string[] | null> {
  try {
    const r = await getFsReadDir(scope, dir, true);
    return r.ok && Array.isArray(r.data) ? r.data.map((e) => e.name) : null;
  } catch {
    return null;
  }
}

/** A name sheet keeps the scope it opened on: its reads and writes go to
 *  that server even if the room moves while it is up. */
type NameSheet =
  | { kind: "mkdir"; dir: string; scope: ServerScope }
  | {
      kind: "rename";
      path: string;
      isDirectory: boolean;
      section: FileMenu["section"];
      scope: ServerScope;
    };

export function FilePane() {
  const open = useZenStore((s) => s.filesOpen);
  if (!open) return null;
  return <FilePaneOpen />;
}

/** Files drawer: header (title, hidden-files eye, new folder, close), Workspace
 *  Resources, then the workspace folder tree. Hold a row still for its
 *  menu (Copy Path, Rename); hold and move to drag a file into the chat. */
function FilePaneOpen() {
  const openFileIds = useZenStore((s) => s.openFileIds);
  const openFile = useZenStore((s) => s.openFile);
  const openFileFromPath = useZenStore((s) => s.openFileFromPath);
  const toggleFiles = useZenStore((s) => s.toggleFiles);
  const allFiles = useZenStore((s) => s.files);
  const source = useZenStore((s) => s.fileSource);
  const fileError = useZenStore((s) => s.fileError);
  const files = allFiles.filter((f) => !f.linked);
  const heading =
    source === "live" ? "Workspace Resources" : `${sourceWord(source)} resources`;

  // Multi-server S3: the room's server. A drawer in a chat on server B
  // reads and writes B (tree, create, rename, resources), never the active one.
  const scope = useZenScope();
  const { root, note: rootNote } = useFilesRoot(scope);
  const [showHidden, setShowHidden] = useState(readShowHidden);
  const [resourcesCollapsed, setResourcesCollapsed] = useState(readResourcesCollapsed);
  const tree = useFileTree(scope, root);
  const [mkdirGap, setMkdirGap] = useState(false);
  const [renameGap, setRenameGap] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sheet, setSheet] = useState<NameSheet | null>(null);
  const drag = useFileDrag((s) => s.drag);

  // A project chat has several members' agents reading: the absolute
  // path, not one relative to the PoC's folder.
  const isGroup = useZenStore(
    (s) => s.agents.find((a) => a.id === s.agentId)?.kind === "group"
  );
  const hold = useFileHold({ refFor: (p) => fileRefText(p, isGroup ? null : root) });
  const { menu, closeMenu } = hold;

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      useFileDrag.getState().cancel();
    },
    []
  );

  const say = (text: string) => {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1600);
  };

  const mkdirTarget = tree.selected && inTree(tree.selected, root) ? tree.selected : root;

  const refreshResources = () => {
    const s = useZenStore.getState();
    if (s.agentSource !== "live") return;
    const row = s.agents.find((a) => a.id === s.agentId);
    if (row?.kind === "group") {
      if (row.groupId) void s.hydrateGroupFiles(row.groupId, { refresh: true });
    } else if (typeof row?.path === "string" && row.path.trim()) {
      void s.hydrateFiles(row.path.trim(), { refresh: true });
    }
  };

  const onCopyPath = async (m: FileMenu) => {
    closeMenu();
    say((await copyText(m.path)) ? "Copied" : "Could not copy");
  };

  const toggleResources = () => {
    const next = !resourcesCollapsed;
    setResourcesCollapsed(next);
    writeResourcesCollapsed(next);
  };
  // A count only once there is a list to count (not while loading or failed).
  const resourceCount = source === "live" || source === "stub" ? files.length : null;

  const toggleHidden = () => {
    const next = !showHidden;
    setShowHidden(next);
    writeShowHidden(next);
  };

  return (
    <aside
      className="flex flex-col h-full min-h-0 border-l border-[var(--border)] bg-[var(--surface)] shrink-0"
      style={{ width: FILE_PANE_PX }}
      aria-label="Files"
    >
      <div className="flex items-center gap-1.5 pl-3 pr-1.5 h-11 border-b border-[var(--border)]">
        <span className="flex-1 min-w-0 text-[15px] font-semibold text-[var(--text)]" data-testid="files-title">
          Files
        </span>
        <button
          type="button"
          onClick={toggleHidden}
          className="flex items-center justify-center shrink-0 zen-glass zen-glass-pill"
          style={ICON_BTN}
          aria-label={showHidden ? "Hide hidden files" : "Show hidden files"}
          aria-pressed={showHidden}
          data-testid="files-eye"
          data-state={showHidden ? "shown" : "hidden"}
        >
          {showHidden ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 19c-7 0-11-7-11-7a18.45 18.45 0 0 1 5.06-5.94" />
              <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19" />
              <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </svg>
          )}
        </button>
        {root && !mkdirGap ? (
          <button
            type="button"
            onClick={() => mkdirTarget && setSheet({ kind: "mkdir", dir: mkdirTarget, scope })}
            className="flex items-center justify-center shrink-0 zen-glass zen-glass-pill"
            style={ICON_BTN}
            aria-label="New folder"
            data-testid="files-new-folder"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <line x1="12" y1="11" x2="12" y2="17" />
              <line x1="9" y1="14" x2="15" y2="14" />
            </svg>
          </button>
        ) : null}
        {/* Close: a 44x44 hit target around the same 28px glass pill. The
         *  negative margins keep the visual spacing of the other buttons. */}
        <button
          type="button"
          onClick={toggleFiles}
          className="flex items-center justify-center shrink-0"
          style={{ width: 44, height: 44, marginLeft: -6, marginRight: -6, color: "#fff" }}
          aria-label="Close files"
          data-testid="files-close"
        >
          <span className="flex items-center justify-center zen-glass zen-glass-pill" style={ICON_BTN} aria-hidden>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </span>
        </button>
      </div>
      <div
        ref={hold.scrollerRef}
        className="flex-1 overflow-y-auto"
        style={{ overflowY: drag ? "hidden" : "auto", touchAction: drag ? "none" : undefined }}
        data-testid="files-scroll"
        onPointerDown={hold.onPointerDown}
        onPointerMove={hold.onPointerMove}
        onPointerUp={hold.onPointerUp}
        onPointerCancel={hold.onPointerCancel}
        onContextMenu={(e) => e.preventDefault()}
      >
        <button
          type="button"
          onClick={toggleResources}
          className={`w-full flex items-center gap-1.5 px-3 pt-2 pb-1.5 text-left text-[10px] text-[var(--text-muted)] tracking-widest bg-transparent border-0 ${source === "live" ? "" : "uppercase"}`}
          aria-expanded={!resourcesCollapsed}
          aria-controls="files-resources-body"
          data-testid="resources-toggle"
          data-state={resourcesCollapsed ? "collapsed" : "expanded"}
        >
          <svg
            width="9"
            height="9"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            className="shrink-0"
            style={{ transform: resourcesCollapsed ? undefined : "rotate(90deg)", transition: "transform 120ms" }}
          >
            <polyline points="9 6 15 12 9 18" />
          </svg>
          <span className="min-w-0 truncate">{heading}</span>
          {resourceCount !== null ? (
            <span className="shrink-0 tracking-normal tabular-nums opacity-70" data-testid="resources-count">
              · {resourceCount}
            </span>
          ) : null}
        </button>
        {resourcesCollapsed ? null : (
          <div id="files-resources-body" data-testid="resources-body" className="pb-1">
            {files.length === 0 && source === "live" ? (
              <div className="k2-tile rounded-[14px] mx-2 mb-2 px-3 py-3" data-testid="resources-empty">
                <div className="text-[12px] text-[var(--text)] font-medium">
                  {RESOURCES_EMPTY_TITLE}
                </div>
                <div className="mt-1 text-[11px] leading-4 text-[var(--text-muted)]">
                  {RESOURCES_EMPTY_LINE}
                </div>
              </div>
            ) : files.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-[var(--text-muted)]">
                {source === "loading" ? "loading" : asErrorText(fileError, "empty")}
              </div>
            ) : (
              files.map((f) => {
                const active = openFileIds.includes(f.id);
                const sub = f.missing ? "Unavailable" : f.hint;
                return (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => {
                      if (hold.consumeSkipClick()) return;
                      openFile(f.id);
                    }}
                    aria-disabled={f.missing || undefined}
                    data-missing={f.missing ? "1" : undefined}
                    title={f.missing ? `${f.name} is no longer on disk` : f.name}
                    data-file-path={source === "live" ? f.id : undefined}
                    data-file-name={f.name}
                    data-file-dir="0"
                    data-file-missing={f.missing ? "1" : "0"}
                    data-file-section="resources"
                    data-testid="resource-row"
                    aria-label={f.name}
                    className={`w-full flex items-start gap-1.5 text-left px-3 py-1.5 text-[12px] select-none ${
                      f.missing
                        ? "text-[var(--text-muted)]"
                        : active
                          ? "text-[var(--accent)]"
                          : "text-[var(--text)]"
                    }`}
                    style={{ WebkitTouchCallout: "none", WebkitUserSelect: "none", touchAction: "pan-y" }}
                  >
                    <span
                      className="shrink-0 flex items-center h-[18px]"
                      style={{ opacity: f.missing ? 0.45 : undefined }}
                    >
                      <FileIcon name={f.name} />
                    </span>
                    {source === "stub" ? (
                      <span className="shrink-0 flex items-center h-[18px]">
                        <StubMark />
                      </span>
                    ) : null}
                    <span className="flex flex-col min-w-0 flex-1 leading-[18px]">
                      <MiddleEllipsis
                        text={f.name}
                        title={f.missing ? `${f.name} is no longer on disk` : f.name}
                        className={f.missing ? "line-through" : ""}
                      />
                      {sub ? (
                        <span className="truncate text-[10px] leading-[14px] text-[var(--text-muted)]">{sub}</span>
                      ) : null}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        )}
        <div
          role="separator"
          className="mx-3 my-1 h-px"
          style={{ background: "var(--tile-edge, var(--border))" }}
          data-testid="resources-divider"
        />
        {root ? (
          <div className="pt-1 pb-6" data-testid="files-tree-section">
            <FileTree
              tree={tree}
              showHidden={showHidden}
              activeIds={openFileIds}
              onOpenFile={(p) => openFileFromPath(p)}
              consumeSkipClick={hold.consumeSkipClick}
            />
          </div>
        ) : rootNote && source !== "stub" ? (
          <div className="px-3 py-3 text-[11px] text-[var(--text-muted)]" data-testid="files-tree-note">
            {rootNote}
          </div>
        ) : null}
      </div>

      {menu
        ? createPortal(
            <FileRowMenu
              menu={menu}
              canRename={!renameGap && !menu.missing && inTree(menu.path, root) && menu.path !== root}
              onClose={closeMenu}
              onCopy={() => void onCopyPath(menu)}
              onRename={() => {
                closeMenu();
                setSheet({
                  kind: "rename",
                  path: menu.path,
                  isDirectory: menu.isDirectory,
                  section: menu.section,
                  scope,
                });
              }}
            />,
            document.body
          )
        : null}

      {sheet && root
        ? createPortal(
            <NameSheetView
              sheet={sheet}
              root={root}
              onClose={() => setSheet(null)}
              onMkdir={async (dir, name) => {
                const path = joinPath(dir, name);
                if (!inTree(path, root)) return "That folder is outside the workspace.";
                const r = await createFsFolder(sheet.scope, path);
                if (!r.ok) {
                  if (r.status === 404 && /route/i.test(r.error || "")) {
                    setMkdirGap(true);
                    setSheet(null);
                    say("This server cannot make folders");
                    return null;
                  }
                  return r.error || "Could not make the folder";
                }
                setSheet(null);
                say("Folder created");
                // The room moved while the sheet was up: B's tree is gone.
                if (zenScope().id !== sheet.scope.id) return null;
                if (dir !== root) tree.expand(dir);
                await tree.load(dir);
                return null;
              }}
              onRename={async (path, name, section) => {
                if (!inTree(path, root)) return "That item is outside the workspace.";
                const r = await renameFsEntry(sheet.scope, path, name);
                if (!r.ok) {
                  if (r.status === 404 && /route/i.test(r.error || "")) {
                    setRenameGap(true);
                    setSheet(null);
                    say("This server cannot rename");
                    return null;
                  }
                  return r.error || "Could not rename";
                }
                const next = r.data?.path || joinPath(parentDir(path), name);
                if (zenScope().id !== sheet.scope.id) {
                  setSheet(null);
                  say("Renamed");
                  return null;
                }
                useZenStore.getState().retargetFiles(path, next);
                if (tree.selected === path || tree.selected?.startsWith(`${path}/`)) {
                  tree.setSelected(null);
                }
                await tree.load(parentDir(path));
                const pinned = section === "resources" || useZenStore.getState().files.some(
                  (f) => !f.linked && (f.id === next || f.id.startsWith(`${next}/`))
                );
                if (pinned) refreshResources();
                setSheet(null);
                say("Renamed");
                return null;
              }}
            />,
            document.body
          )
        : null}

      {drag
        ? createPortal(
            <div
              className="fixed z-[80] pointer-events-none flex items-center gap-1.5 px-3 py-1.5 zen-glass zen-glass-pill text-[12px] text-white"
              style={{
                left: drag.x,
                top: drag.y,
                transform: "translate(-50%, -130%)",
                maxWidth: 220,
              }}
              data-testid="file-drag-ghost"
              aria-hidden
            >
              <span className="shrink-0 flex">
                <FileIcon name={drag.name} />
              </span>
              <span className="min-w-0 overflow-hidden whitespace-nowrap">{drag.name}</span>
            </div>,
            document.body
          )
        : null}

      {toast
        ? createPortal(
            <div
              role="status"
              className="fixed left-1/2 z-[90] px-3 py-1.5 zen-glass zen-glass-pill text-[13px] text-white pointer-events-none"
              style={{ top: "calc(env(safe-area-inset-top) + 56px)", transform: "translateX(-50%)" }}
              data-testid="files-toast"
            >
              {toast}
            </div>,
            document.body
          )
        : null}
    </aside>
  );
}

/** The press-and-hold menu: exactly Copy Path and Rename. */
function FileRowMenu({
  menu,
  canRename,
  onClose,
  onCopy,
  onRename,
}: {
  menu: FileMenu;
  canRename: boolean;
  onClose: () => void;
  onCopy: () => void;
  onRename: () => void;
}) {
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const below = !menu.rect || menu.rect.bottom + 110 < vh;
  const top = menu.rect ? (below ? menu.rect.bottom + 4 : menu.rect.top - 4) : vh / 2;
  const right = menu.rect && typeof window !== "undefined" ? Math.max(8, window.innerWidth - menu.rect.right + 8) : 8;
  const item = "w-full text-left px-4 py-2.5 text-[15px] text-white bg-transparent border-0";
  return (
    <div
      className="fixed inset-0 z-[70]"
      data-testid="file-menu-scrim"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="menu"
        aria-label={menu.name}
        data-testid="file-menu"
        className="absolute zen-glass zen-glass-round overflow-hidden"
        style={{
          top,
          right,
          minWidth: 168,
          transform: below ? undefined : "translateY(-100%)",
          background: "rgba(44,44,46,0.82)",
        }}
      >
        <div className="px-4 pt-2 pb-1 text-[11px] text-[var(--text-muted)] flex items-center gap-1.5">
          <span className="shrink-0 flex">
            <EntryIcon name={menu.name} isDirectory={menu.isDirectory} />
          </span>
          <MiddleEllipsis text={menu.name} className="flex-1" />
        </div>
        <button type="button" role="menuitem" className={item} onClick={onCopy} data-testid="file-menu-copy">
          Copy Path
        </button>
        {canRename ? (
          <button
            type="button"
            role="menuitem"
            className={`${item} border-t border-[rgba(255,255,255,0.12)]`}
            onClick={onRename}
            data-testid="file-menu-rename"
          >
            Rename
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** New-folder and rename: one glass sheet with the target shown. */
function NameSheetView({
  sheet,
  root,
  onClose,
  onMkdir,
  onRename,
}: {
  sheet: NameSheet;
  root: string;
  onClose: () => void;
  onMkdir: (dir: string, name: string) => Promise<string | null>;
  onRename: (path: string, name: string, section: FileMenu["section"]) => Promise<string | null>;
}) {
  const current = sheet.kind === "rename" ? baseName(sheet.path) : "";
  const dir = sheet.kind === "rename" ? parentDir(sheet.path) : sheet.dir;
  const [value, setValue] = useState(current);
  const [siblings, setSiblings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    void namesIn(sheet.scope, dir).then((n) => {
      if (live && n) setSiblings(n);
    });
    return () => {
      live = false;
    };
  }, [dir, sheet.scope]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (sheet.kind === "rename") {
      const [a, b] = renameSelection(current, sheet.isDirectory);
      try {
        el.setSelectionRange(a, b);
      } catch {
        /* not a text input in some test DOMs */
      }
    }
  }, [sheet, current]);

  const invalid = useMemo(
    () =>
      validateEntryName(value, siblings, sheet.kind === "rename" ? { current } : undefined),
    [value, siblings, sheet.kind, current]
  );
  const shownError = serverError || (touched ? invalid : null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (invalid || busy) return;
    setBusy(true);
    setServerError(null);
    const name = value.trim();
    const err =
      sheet.kind === "mkdir" ? await onMkdir(sheet.dir, name) : await onRename(sheet.path, name, sheet.section);
    setBusy(false);
    if (err) setServerError(err);
  };

  return (
    <div
      className="fixed inset-0 z-[75] flex items-end justify-center"
      style={{ background: "rgba(0,0,0,.5)" }}
      data-testid="files-name-sheet"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <form
        className="w-full px-4 pt-4 k2-tile k2-tile-sheet"
        style={{
          borderTopLeftRadius: 14,
          borderTopRightRadius: 14,
          paddingBottom: "calc(16px + env(safe-area-inset-bottom))",
        }}
        onSubmit={submit}
      >
        <div className="text-[15px] font-semibold text-[var(--text)]">
          {sheet.kind === "mkdir" ? "New folder" : "Rename"}
        </div>
        <div className="mt-0.5 mb-3 text-[12px] text-[var(--text-muted)] flex gap-1 min-w-0">
          <span className="shrink-0">in</span>
          <MiddleEllipsis text={displayPathUnder(dir, root)} title={dir} testId="files-sheet-target" />
        </div>
        <input
          ref={inputRef}
          data-testid="files-name-input"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setTouched(true);
            setServerError(null);
          }}
          placeholder={sheet.kind === "mkdir" ? "Folder name" : "Name"}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="w-full px-3 py-2 text-[16px] rounded-lg k2-tile k2-tile-raised text-[var(--text)]"
        />
        {shownError ? (
          <p className="mt-2 text-[12px]" style={{ color: "#ff453a" }} data-testid="files-name-error">
            {shownError}
          </p>
        ) : null}
        <div className="flex justify-end gap-2 mt-3">
          <button
            type="button"
            className="px-3 py-2 text-[14px] bg-transparent border-0 text-[var(--text-muted)]"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            data-testid="files-name-save"
            disabled={busy || Boolean(invalid)}
            className="px-3 py-2 text-[14px] bg-transparent border-0 disabled:opacity-40"
            style={{ color: "#0a84ff" }}
          >
            {sheet.kind === "mkdir" ? "Create" : "Rename"}
          </button>
        </div>
      </form>
    </div>
  );
}
