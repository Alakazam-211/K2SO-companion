import { useRef, useState, type ChangeEvent } from "react";
import { uploadFsBinary } from "../api/client";
import type { ServerScope } from "../api/scope";
import { useBackHandler } from "../lib/androidBack";
import { isUnsupportedPick, nativePick, nativePickerAvailable, skippedMessage, type PickKind } from "../lib/nativePicker";
import { fileToBase64, uploadFilename } from "./composerAttach";
import { displayPathUnder } from "./fileTreeModel";
import { FolderPicker } from "./FolderPicker";
import { MiddleEllipsis } from "./MiddleEllipsis";

/** "+ New File" in the Files drawer (Rosson 2026-11-09): choose a folder in
 *  the workspace, then a photo or file from this phone to put there. The
 *  server never overwrites: a name already there becomes `name (1).ext`.
 *  Keeps the scope it opened on, like the drawer's other sheets. */
export function NewFileSheet({
  scope,
  root,
  workspace,
  startDir,
  showHidden,
  onClose,
  onAdded,
}: {
  scope: ServerScope;
  root: string;
  workspace: string;
  startDir: string;
  showHidden: boolean;
  onClose: () => void;
  /** `problem`: a file left out, or the one that failed part-way. */
  onAdded: (dir: string, names: string[], problem: string | null) => void;
}) {
  const [dir, setDir] = useState(startDir);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  useBackHandler(!busy, onClose);

  const upload = async (files: File[], skipped: string | null) => {
    if (!files.length) {
      if (skipped) setError(skipped);
      return;
    }
    setBusy(true);
    setError(null);
    const names: string[] = [];
    for (const f of files) {
      const name = uploadFilename(f);
      let failure: string | null = null;
      try {
        const r = await uploadFsBinary(scope, workspace, dir, name, await fileToBase64(f));
        if (r.ok) names.push(name);
        else failure = r.error || `Could not add ${name}`;
      } catch (e) {
        failure = e instanceof Error ? e.message : `Could not add ${name}`;
      }
      if (failure) {
        setBusy(false);
        // What did go up is in the folder; the tree should show it.
        if (names.length) onAdded(dir, names, failure);
        else setError(failure);
        return;
      }
    }
    setBusy(false);
    onAdded(dir, names, skipped);
  };

  const pick = (kind: PickKind) => {
    setError(null);
    const input = () => (kind === "media" ? photoRef : fileRef).current?.click();
    if (!nativePickerAvailable()) {
      input();
      return;
    }
    nativePick(kind)
      .then((out) => void upload(out.files, skippedMessage(out.skipped)))
      .catch((e) => {
        if (isUnsupportedPick(e)) input();
        else setError("Could not open the picker.");
      });
  };

  const onInput = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = "";
    void upload(picked, null);
  };

  const pickClass = "flex-1 text-[15px] k2-tile k2-tile-raised text-[var(--text)] disabled:opacity-50";

  return (
    <div
      className="fixed inset-0 z-[75] flex items-end justify-center"
      style={{ background: "rgba(0,0,0,.5)" }}
      data-testid="files-new-sheet"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="w-full px-4 pt-4 k2-tile k2-tile-sheet"
        style={{ borderTopLeftRadius: 14, borderTopRightRadius: 14, paddingBottom: "calc(16px + var(--safe-bottom))" }}
      >
        <div className="text-[15px] font-semibold text-[var(--text)]">New file</div>
        <div className="mt-0.5 mb-3 text-[12px] text-[var(--text-muted)] flex gap-1 min-w-0">
          <span className="shrink-0">Save in</span>
          <MiddleEllipsis text={displayPathUnder(dir, root)} title={dir} testId="files-new-target" />
        </div>
        <FolderPicker scope={scope} root={root} dir={dir} onDir={setDir} showHidden={showHidden} disabled={busy} maxHeight="38vh" />
        {error ? (
          <p className="mt-2 text-[12px]" style={{ color: "#ff453a" }} data-testid="files-new-error">
            {error}
          </p>
        ) : null}
        <input ref={fileRef} type="file" multiple className="hidden" data-testid="files-new-file-input" onChange={onInput} />
        <input ref={photoRef} type="file" multiple accept="image/*,video/*" className="hidden" data-testid="files-new-photo-input" onChange={onInput} />
        <div className="flex gap-2 mt-3">
          <button type="button" className={pickClass} style={{ minHeight: 44, borderRadius: 12 }} disabled={busy} data-testid="files-new-photos" onClick={() => pick("media")}>
            Photo Library
          </button>
          <button type="button" className={pickClass} style={{ minHeight: 44, borderRadius: 12 }} disabled={busy} data-testid="files-new-files" onClick={() => pick("documents")}>
            Choose File
          </button>
        </div>
        <div className="flex justify-end mt-2">
          <button
            type="button"
            className="px-3 py-2 text-[14px] bg-transparent border-0 text-[var(--text-muted)]"
            disabled={busy}
            data-testid="files-new-cancel"
            onClick={onClose}
          >
            {busy ? "Adding…" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}
