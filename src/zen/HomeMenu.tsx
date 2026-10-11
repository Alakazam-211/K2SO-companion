import { useState } from "react";
import { HOME_NAME_MAX, type Home } from "./homes";
import { CheckIcon } from "./icons";
import { useBackHandler } from "../lib/androidBack";

const ITEM = {
  gap: 10,
  padding: "10px 12px",
  minHeight: 44,
  borderRadius: 10,
  color: "#fff",
} as const;

type Mode = { kind: "list" } | { kind: "new" } | { kind: "rename" } | { kind: "delete" };

/**
 * The Home tab's title dropdown (HM4): the Homes on this device (check on
 * the current one), then New Home…, Rename… and Delete. Same glass menu
 * as the focus-group switcher. Delete is off on the last Home.
 */
export function HomeMenu({
  homes,
  currentId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onClose,
}: {
  homes: Home[];
  currentId: string;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const current = homes.find((h) => h.id === currentId) ?? homes[0];
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [name, setName] = useState("");
  const lastHome = homes.length <= 1;
  // Android Back: the name form's Cancel (back to the list), else the
  // backdrop tap that closes the menu.
  useBackHandler(true, () => {
    if (mode.kind === "new" || mode.kind === "rename") setMode({ kind: "list" });
    else onClose();
  });

  const submitName = () => {
    const clean = name.trim();
    if (!clean) return;
    if (mode.kind === "new") onCreate(clean);
    else onRename(clean);
    onClose();
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close Homes"
        className="fixed inset-0 bg-transparent border-0 p-0"
        style={{ zIndex: 29 }}
        data-no-pin="1"
        onClick={onClose}
        data-testid="home-title-backdrop"
      />
      <div
        role="menu"
        aria-label="Homes"
        className="zen-glass absolute"
        data-no-pin="1"
        data-testid="home-title-menu"
        style={{
          zIndex: 30,
          top: "calc(env(safe-area-inset-top) + 52px)",
          left: "50%",
          transform: "translateX(-50%)",
          width: "min(260px, calc(100vw - 32px))",
          maxHeight: "60vh",
          overflowY: "auto",
          borderRadius: 16,
          padding: 6,
          color: "#fff",
        }}
      >
        {mode.kind === "new" || mode.kind === "rename" ? (
          <form
            className="flex flex-col"
            style={{ gap: 8, padding: 6 }}
            onSubmit={(e) => {
              e.preventDefault();
              submitName();
            }}
          >
            <span className="text-[13px] font-semibold" style={{ color: "#8e8e93" }}>
              {mode.kind === "new" ? "New Home" : `Rename ${current.name}`}
            </span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Home name"
              aria-label="Home name"
              maxLength={HOME_NAME_MAX}
              className="k2-tile k2-tile-raised outline-none text-[16px]"
              style={{ height: 40, borderRadius: 10, padding: "0 12px", color: "#fff" }}
              data-testid="home-name-input"
            />
            <span className="flex" style={{ gap: 8 }}>
              <button
                type="button"
                className="flex-1 bg-transparent border-0 text-[16px]"
                style={{ height: 40, borderRadius: 10, color: "#8e8e93" }}
                onClick={() => setMode({ kind: "list" })}
                data-testid="home-name-cancel"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="flex-1 border-0 text-[16px] font-semibold disabled:opacity-40"
                style={{ height: 40, borderRadius: 10, background: "#0a84ff", color: "#fff" }}
                disabled={!name.trim()}
                data-testid="home-name-save"
              >
                {mode.kind === "new" ? "Create" : "Save"}
              </button>
            </span>
          </form>
        ) : (
          <>
            {homes.map((h) => {
              const on = h.id === current.id;
              return (
                <button
                  key={h.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  className="w-full flex items-center text-left bg-transparent border-0"
                  style={ITEM}
                  onClick={() => {
                    onSelect(h.id);
                    onClose();
                  }}
                  data-testid={`home-option-${h.id}`}
                >
                  <span className="flex-1 min-w-0 truncate text-[16px]">{h.name}</span>
                  <span className="shrink-0 text-[13px]" style={{ color: "#8e8e93" }}>
                    {h.rows.length}
                  </span>
                  <span aria-hidden className="shrink-0" style={{ width: 16, color: "#0a84ff" }}>
                    {on ? (
                      <CheckIcon size={16} strokeWidth={2.6} testId="home-check" />
                    ) : null}
                  </span>
                </button>
              );
            })}
            <div aria-hidden style={{ height: 1, margin: "4px 8px", background: "rgba(255,255,255,.12)" }} />
            <button
              type="button"
              role="menuitem"
              className="w-full flex items-center text-left bg-transparent border-0 text-[16px]"
              style={ITEM}
              onClick={() => {
                setName("");
                setMode({ kind: "new" });
              }}
              data-testid="home-menu-new"
            >
              New Home…
            </button>
            <button
              type="button"
              role="menuitem"
              className="w-full flex items-center text-left bg-transparent border-0 text-[16px]"
              style={ITEM}
              onClick={() => {
                setName(current.name);
                setMode({ kind: "rename" });
              }}
              data-testid="home-menu-rename"
            >
              Rename…
            </button>
            {mode.kind === "delete" ? (
              <button
                type="button"
                role="menuitem"
                className="w-full flex items-center text-left bg-transparent border-0 text-[16px] font-semibold"
                style={{ ...ITEM, color: "#ff453a" }}
                onClick={() => {
                  onDelete();
                  onClose();
                }}
                data-testid="home-menu-delete-confirm"
              >
                <span className="truncate">Delete “{current.name}”?</span>
              </button>
            ) : (
              <button
                type="button"
                role="menuitem"
                aria-disabled={lastHome || undefined}
                disabled={lastHome}
                title={lastHome ? "You need at least one Home" : undefined}
                className="w-full flex items-center text-left bg-transparent border-0 text-[16px] disabled:opacity-40"
                style={{ ...ITEM, color: "#ff453a" }}
                onClick={() => setMode({ kind: "delete" })}
                data-testid="home-menu-delete"
              >
                Delete
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}
