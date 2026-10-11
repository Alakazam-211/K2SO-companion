import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  assignFocusGroup,
  createWorkspace,
  ensurePinnedChat,
  getFsInfo,
  updateProjectLook,
} from "../api/client";
import {
  WORKSPACE_COLORS,
  createErrorText,
  defaultParentDir,
  newWorkspaceProblem,
  slugifyWorkspaceName,
  workspacePathFor,
} from "./newWorkspace";
import { posixNormalize } from "./workspacePath";
import { useZenStore } from "./zenStore";
import { zenScope } from "./zenScope";

type Stage = "idle" | "creating" | "starting" | "opening";

const STAGE_LABEL: Record<Stage, string> = {
  idle: "Create",
  creating: "Creating…",
  starting: "Starting agent…",
  opening: "Opening…",
};

/**
 * Agents `+`: make a new workspace on the server.
 * `POST /cli/workspace/create {path}` (Member) makes `<parent>/<slug>`,
 * registers it and seeds the wiki + AGENTS.md (desktop defaults). Then:
 * name / colour via `projects/update`, focus group via `focus-groups/assign`,
 * main chat via `workspace/ensure-pinned-chat`, list refresh, and land in
 * the new agent's thread. If the row is not chattable yet, `onListed`
 * hands its path back so the list can highlight it.
 */
export function NewWorkspaceSheet({
  onClose,
  onListed,
}: {
  onClose: () => void;
  onListed?: (path: string) => void;
}) {
  const agents = useZenStore((s) => s.agents);
  const serverProjects = useZenStore((s) => s.serverProjects);
  const focus = useZenStore((s) => s.focus);
  const existingPaths = useMemo(
    () => [...serverProjects.map((p) => p.path), ...agents.map((a) => a.path ?? null)],
    [serverProjects, agents]
  );
  const [home, setHome] = useState<string | null>(null);
  const suggested = defaultParentDir(existingPaths, home);
  const [name, setName] = useState("");
  const [parent, setParent] = useState<string | null>(null);
  const [color, setColor] = useState<string>(WORKSPACE_COLORS[0]);
  const groupsOn = focus.enabled && focus.groups.length > 0;
  const [groupId, setGroupId] = useState<string | null>(groupsOn ? focus.currentId : null);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  // No workspace to learn a parent from: ask the host for its home.
  const needHome = defaultParentDir(existingPaths, null) === null;
  useEffect(() => {
    if (!needHome) return;
    let live = true;
    void getFsInfo(zenScope()).then((r) => {
      if (live && r.ok && typeof r.data?.home === "string") setHome(r.data.home);
    });
    return () => {
      live = false;
    };
  }, [needHome]);

  const parentValue = parent ?? suggested ?? "";
  const slug = slugifyWorkspaceName(name);
  const path = workspacePathFor(parentValue, slug);
  const problem = newWorkspaceProblem(name, parentValue, existingPaths);
  const busy = stage !== "idle";

  const submit = async () => {
    setTouched(true);
    if (busy || problem || !path || !slug) return;
    setError(null);
    setStage("creating");
    // One server for the whole create → look → group → chat sequence.
    const scope = zenScope();
    const made = await createWorkspace(scope, path);
    if (!made.ok) {
      setStage("idle");
      setError(createErrorText(made.error, made.status));
      return;
    }
    const where = posixNormalize(made.data?.path || path) || path;
    const projectId = (made.data?.projectId || "").trim();
    if (projectId) {
      // The daemon names it after the folder and stamps the blue default.
      const look: { name?: string; color?: string } = {};
      const typed = name.trim();
      if (typed && typed !== slug) look.name = typed;
      if (color !== WORKSPACE_COLORS[0]) look.color = color;
      if (look.name || look.color) await updateProjectLook(scope, projectId, look);
      if (groupsOn && groupId) await assignFocusGroup(scope, projectId, groupId);
    }
    // Start the agent's main chat (desktop does this when the Chat tab
    // mounts). Best effort: the thread still opens without a live host.
    setStage("starting");
    await ensurePinnedChat(scope, where);
    setStage("opening");
    const store = useZenStore.getState();
    await store.hydrateAgents();
    const row = useZenStore
      .getState()
      .agents.find(
        (a) =>
          a.kind === "agent" &&
          !!a.path &&
          posixNormalize(a.path) === where &&
          !!(a.addr || "").trim() &&
          !(a.addr || "").includes("/") &&
          !a.joinMiss
      );
    onClose();
    if (row) useZenStore.getState().setAgent(row.id);
    else onListed?.(where);
  };

  const field: CSSProperties = {
    width: "100%",
    height: 40,
    padding: "0 12px",
    borderRadius: 10,
    color: "#fff",
    fontSize: 16,
  };
  const label = "text-[11px] uppercase tracking-wide";
  const shownProblem = touched || name.trim() ? problem : null;

  return (
    <div
      className="absolute inset-0 flex items-end justify-center"
      style={{ background: "rgba(0,0,0,.45)", zIndex: 30 }}
      data-no-pin="1"
      data-testid="new-workspace"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <form
        role="dialog"
        aria-label="New workspace"
        className="w-full k2-tile k2-tile-sheet flex flex-col overflow-y-auto"
        style={{
          borderTopLeftRadius: 14,
          borderTopRightRadius: 14,
          padding: "16px 16px max(12px, env(safe-area-inset-bottom))",
          maxHeight: "90%",
          gap: 14,
          color: "#fff",
        }}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 className="text-[17px] font-semibold text-center shrink-0">New Workspace</h2>

        <label className="flex flex-col" style={{ gap: 6 }}>
          <span className={label} style={{ color: "#8e8e93" }}>
            Name
          </span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My project"
            autoCapitalize="words"
            autoCorrect="off"
            spellCheck={false}
            maxLength={80}
            disabled={busy}
            className="k2-tile k2-tile-raised outline-none"
            style={field}
            data-testid="new-workspace-name"
          />
          <span className="text-[12px]" style={{ color: "#8e8e93" }} data-testid="new-workspace-slug">
            Folder: {slug ?? "—"}
          </span>
        </label>

        <label className="flex flex-col" style={{ gap: 6 }}>
          <span className={label} style={{ color: "#8e8e93" }}>
            Location on the server
          </span>
          <input
            value={parentValue}
            onChange={(e) => setParent(e.target.value)}
            placeholder="/Users/you/Projects"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={busy}
            className="k2-tile k2-tile-raised outline-none"
            style={{ ...field, fontSize: 14, fontFamily: "ui-monospace, Menlo, monospace" }}
            data-testid="new-workspace-parent"
          />
          <span
            className="text-[12px] break-all"
            style={{ color: path ? "#c7c7cc" : "#8e8e93", fontFamily: "ui-monospace, Menlo, monospace" }}
            data-testid="new-workspace-path"
          >
            {path ?? `${parentValue.replace(/\/+$/, "") || "…"}/${slug ?? "…"}`}
          </span>
        </label>

        <div className="flex flex-col" style={{ gap: 6 }}>
          <span className={label} style={{ color: "#8e8e93" }}>
            Colour
          </span>
          <div className="flex flex-wrap" style={{ gap: 10 }} role="radiogroup" aria-label="Colour">
            {WORKSPACE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={c}
                disabled={busy}
                onClick={() => setColor(c)}
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: "50%",
                  background: c,
                  boxShadow: color === c ? "0 0 0 2px #000, 0 0 0 4px #fff" : undefined,
                }}
                data-testid={`new-workspace-color-${c.slice(1)}`}
              />
            ))}
          </div>
        </div>

        {groupsOn ? (
          <div className="flex flex-col" style={{ gap: 6 }}>
            <span className={label} style={{ color: "#8e8e93" }}>
              Focus group
            </span>
            <div className="flex flex-wrap" style={{ gap: 8 }} role="radiogroup" aria-label="Focus group">
              {[...focus.groups.map((g) => ({ id: g.id as string | null, name: g.name })), { id: null, name: "No group" }].map(
                (g) => (
                  <button
                    key={g.id ?? "none"}
                    type="button"
                    role="radio"
                    aria-checked={groupId === g.id}
                    disabled={busy}
                    onClick={() => setGroupId(g.id)}
                    className="text-[14px] k2-tile k2-tile-raised"
                    style={{
                      minHeight: 32,
                      padding: "0 12px",
                      borderRadius: 16,
                      color: "#fff",
                      background: groupId === g.id ? "#0a84ff" : undefined,
                    }}
                    data-testid={`new-workspace-group-${g.id ?? "none"}`}
                  >
                    {g.name}
                  </button>
                )
              )}
            </div>
          </div>
        ) : null}

        {error || shownProblem ? (
          <p
            role="alert"
            className="text-[13px] text-center"
            style={{ color: "#ff453a" }}
            data-testid="new-workspace-error"
          >
            {error || shownProblem}
          </p>
        ) : null}

        <button
          type="submit"
          className="w-full font-semibold text-[17px] shrink-0"
          style={{
            minHeight: 44,
            borderRadius: 12,
            background: "#0a84ff",
            color: "#fff",
            opacity: busy || problem ? 0.4 : 1,
          }}
          disabled={busy}
          aria-disabled={!!problem || undefined}
          data-testid="new-workspace-create"
        >
          {STAGE_LABEL[stage]}
        </button>
        <button
          type="button"
          className="w-full text-[17px] bg-transparent border-0 shrink-0"
          style={{ minHeight: 40, color: "#8e8e93" }}
          disabled={busy}
          onClick={onClose}
          data-testid="new-workspace-cancel"
        >
          Cancel
        </button>
      </form>
    </div>
  );
}
