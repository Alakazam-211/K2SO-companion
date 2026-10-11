import { useRef, useState, type ChangeEvent } from "react";
import { WORKSPACE_COLORS } from "./newWorkspace";
import type { StubAgent } from "./stubData";
import { WorkspaceAvatar } from "./WorkspaceAvatar";
import { iconFromFile, workspaceLookOf, type IconTarget, type WorkspaceLook } from "./workspaceIcon";
import { saveWorkspaceLook } from "./workspaceLookSave";
import { useZenStore } from "./zenStore";
import { useBackHandler } from "../lib/androidBack";

const PREVIEW_PX = 96;

/**
 * Zen chat header avatar → "Change icon". Edits the workspace's icon and
 * colour (sidecar chats share their workspace's), the way desktop's
 * Settings → Workspaces does: photo (centre-cropped square, resized here),
 * Remove (back to the coloured initial), colour swatches. Save writes
 * `POST /cli/projects/update` and patches every avatar optimistically.
 */
export function AgentIconSheet({
  agent,
  target,
  onClose,
}: {
  agent: StubAgent;
  target: IconTarget;
  onClose: () => void;
}) {
  const [before] = useState<WorkspaceLook>(() =>
    workspaceLookOf(useZenStore.getState().agents, target.path, agent)
  );
  const [draft, setDraft] = useState<WorkspaceLook>(before);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const busy = reading || saving;
  const dirty = draft.iconUrl !== before.iconUrl || draft.color !== before.color;
  const initial = (target.name || agent.name || "?").slice(0, 1).toUpperCase();
  // Android Back = Cancel (held while a save is in flight).
  useBackHandler(true, () => {
    if (!saving) onClose();
  });

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setReading(true);
    setError(null);
    iconFromFile(file)
      .then((iconUrl) => setDraft((d) => ({ ...d, iconUrl })))
      .catch((err: unknown) =>
        setError(err instanceof Error && err.message ? err.message : "Could not use that image")
      )
      .finally(() => setReading(false));
  };

  const save = async () => {
    if (busy || !dirty) return;
    setSaving(true);
    setError(null);
    const r = await saveWorkspaceLook(target, before, draft);
    setSaving(false);
    if (r.ok) onClose();
    else setError(r.error);
  };

  const pill = "text-[15px] k2-tile k2-tile-raised";
  const pillStyle = { minHeight: 36, padding: "0 14px", borderRadius: 18, color: "#fff" };

  return (
    <div
      className="absolute inset-0 flex items-end justify-center"
      style={{ background: "rgba(0,0,0,.45)", zIndex: 30 }}
      data-testid="agent-icon-sheet"
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Change icon"
        className="w-full k2-tile k2-tile-sheet flex flex-col items-center overflow-y-auto"
        style={{
          borderTopLeftRadius: 14,
          borderTopRightRadius: 14,
          padding: "16px 16px max(12px, var(--safe-bottom))",
          maxHeight: "90%",
          gap: 14,
          color: "#fff",
        }}
      >
        <div className="flex flex-col items-center" style={{ gap: 2 }}>
          <h2 className="text-[17px] font-semibold text-center">Change icon</h2>
          <p className="text-[12px] text-center" style={{ color: "#8e8e93" }} data-testid="agent-icon-subtitle">
            Icon for {target.name}
          </p>
        </div>

        <span data-testid="agent-icon-preview" data-icon={draft.iconUrl ?? ""} className="flex">
          <WorkspaceAvatar
            initial={initial}
            color={draft.color}
            iconUrl={draft.iconUrl}
            size={PREVIEW_PX}
            fontSize={38}
            fallback="#2c2c2e"
          />
        </span>

        <div className="flex flex-wrap justify-center" style={{ gap: 8 }}>
          <button
            type="button"
            className={pill}
            style={pillStyle}
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            data-testid="agent-icon-choose"
          >
            {reading ? "Reading…" : "Choose Photo"}
          </button>
          {draft.iconUrl ? (
            <button
              type="button"
              className={pill}
              style={{ ...pillStyle, color: "#ff453a" }}
              disabled={busy}
              onClick={() => setDraft((d) => ({ ...d, iconUrl: null }))}
              data-testid="agent-icon-remove"
            >
              Remove icon
            </button>
          ) : null}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={onFile}
            data-testid="agent-icon-file"
          />
        </div>

        <div className="flex flex-col items-center w-full" style={{ gap: 6 }}>
          <span className="text-[13px]" style={{ color: "#8e8e93" }}>
            Colour (shown without a photo)
          </span>
          <div className="flex flex-wrap justify-center" style={{ gap: 10 }} role="radiogroup" aria-label="Colour">
            {WORKSPACE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={draft.color === c}
                aria-label={c}
                disabled={busy}
                onClick={() => setDraft((d) => ({ ...d, color: c }))}
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: "50%",
                  background: c,
                  boxShadow: draft.color === c ? "0 0 0 2px #000, 0 0 0 4px #fff" : undefined,
                }}
                data-testid={`agent-icon-color-${c.slice(1)}`}
              />
            ))}
          </div>
        </div>

        {error ? (
          <p role="alert" className="text-[13px] text-center" style={{ color: "#ff453a" }} data-testid="agent-icon-error">
            {error}
          </p>
        ) : null}

        <button
          type="button"
          className="w-full font-semibold text-[17px] shrink-0"
          style={{
            minHeight: 44,
            borderRadius: 12,
            background: "#0a84ff",
            color: "#fff",
            opacity: busy || !dirty ? 0.4 : 1,
          }}
          disabled={busy || !dirty}
          onClick={() => void save()}
          data-testid="agent-icon-save"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="w-full text-[17px] bg-transparent border-0 shrink-0"
          style={{ minHeight: 40, color: "#8e8e93" }}
          disabled={saving}
          onClick={onClose}
          data-testid="agent-icon-cancel"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
