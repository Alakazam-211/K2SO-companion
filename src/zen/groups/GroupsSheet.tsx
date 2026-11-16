// The Groups sheet (K2 0.46.13; the desktop's Groups dialog in its narrow
// drill-down layout, brief §1.4–§1.6): the list of groups → one group's
// page.
//
//   List: each group's glyph (the current one in the accent), name and row
//   count, a drag handle to reorder, "New group" at the foot (the next
//   "Group N", opened for editing). After a delete, "<Name> deleted." with
//   Undo stays at the foot until the sheet closes; Undo puts the group back
//   in its old place with the same id, rows, pins and icon.
//   Page: the name (saved as you type; emptied, it saves as the next unused
//   "Group N", shown as the placeholder; a failed save keeps the text, edges
//   the field and says so, with Try again), "Most recent at the top", the
//   icon picker (search, No icon, Recent, then all 244), and Delete group
//   (confirmed once; off on the last group, with the reason).
//
// Palette tokens only; the app's sheet tile and glass field.

import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useBackHandler } from "../../lib/androidBack";
import { emptyNameFallback, HOME_NAME_MAX, useHomesStore, type Home } from "../homes";
import { GripHandle, rearrangePadLeft } from "../RearrangeBits";
import { useRearrange } from "../useRearrange";
import { Switch } from "../ZenSettings";
import { GroupDot, GroupGlyph } from "./GroupGlyph";
import { groupIcon, searchGroupIcons } from "./groupIcons";
import { noteRecentIcon, readRecentIcons, useGroupsSheet, type GroupsSheetView } from "./groupsSheetStore";

/** What a failed rename says, beside the field (desktop copy). */
export const RENAME_FAILED_TEXT = "Couldn’t save the name. Your text is kept here.";
export const RECENT_FIRST_LABEL = "Most recent at the top";
export const RECENT_FIRST_HINT = "The agent you last messaged moves up, below the pins.";
export const LAST_GROUP_TEXT = "The last group can’t be deleted.";

const LIST_INSET = "16px";

type Deleted = { home: Home; index: number; wasCurrent: boolean };

function BackChevron() {
  return (
    <svg width="12" height="20" viewBox="0 0 12 20" fill="none" stroke="currentColor" strokeWidth="2.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 2 2 10l8 8" />
    </svg>
  );
}

export function GroupsSheet({ at }: { at: GroupsSheetView }) {
  const homes = useHomesStore((s) => s.homes);
  const currentId = useHomesStore((s) => s.selectedId);
  const show = useGroupsSheet((s) => s.show);
  const close = useGroupsSheet((s) => s.close);
  // The last delete, offered back until the sheet closes.
  const [deleted, setDeleted] = useState<Deleted | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const page = at.view === "group" ? homes.find((h) => h.id === at.groupId) ?? null : null;
  useBackHandler(true, () => (page ? show({ view: "list" }) : close()));

  const onDelete = (h: Home) => {
    const st = useHomesStore.getState();
    const index = st.homes.findIndex((x) => x.id === h.id);
    const wasCurrent = st.selectedId === h.id;
    if (!st.deleteHome(h.id)) return;
    setDeleted({ home: h, index, wasCurrent });
    setNotice(null);
    show({ view: "list" });
  };
  const onUndo = () => {
    if (!deleted) return;
    const st = useHomesStore.getState();
    if (!st.restoreHome(deleted.home, deleted.index)) return;
    if (deleted.wasCurrent) st.selectHome(deleted.home.id);
    setNotice(`${deleted.home.name} is back, with its agents.`);
    setDeleted(null);
  };

  return (
    <div
      className="absolute inset-0 flex items-end justify-center"
      style={{ background: "var(--color-scrim)", zIndex: 30 }}
      data-no-pin="1"
      data-no-group-swipe="1"
      data-testid="groups-sheet"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-label={page ? `Group ${page.name}` : "Groups"}
        className="w-full k2-tile k2-tile-sheet flex flex-col"
        style={{
          borderTopLeftRadius: 14,
          borderTopRightRadius: 14,
          padding: "12px 0 max(12px, var(--safe-bottom))",
          height: "85%",
          color: "var(--color-text-primary)",
        }}
      >
        <div className="grid items-center shrink-0" style={{ gridTemplateColumns: "1fr auto 1fr", padding: "0 12px 10px" }}>
          {page ? (
            <button
              type="button"
              className="justify-self-start flex items-center bg-transparent border-0 text-[17px]"
              style={{ gap: 6, color: "var(--color-accent-text)", minHeight: 44, padding: "0 6px" }}
              onClick={() => show({ view: "list" })}
              data-testid="groups-sheet-back"
            >
              <BackChevron />
              Groups
            </button>
          ) : (
            <span />
          )}
          <h2 className="text-[17px] font-semibold text-center truncate" style={{ maxWidth: 180 }}>
            {page ? page.name : "Groups"}
          </h2>
          <button
            type="button"
            className="justify-self-end bg-transparent border-0 text-[17px] font-semibold"
            style={{ color: "var(--color-accent-text)", minHeight: 44, padding: "0 6px" }}
            onClick={close}
            data-testid="groups-sheet-done"
          >
            Done
          </button>
        </div>
        {page ? (
          <GroupPage
            key={page.id}
            home={page}
            index={homes.findIndex((h) => h.id === page.id)}
            canDelete={homes.length > 1}
            onDelete={() => onDelete(page)}
          />
        ) : (
          <GroupList
            homes={homes}
            currentId={currentId}
            onOpen={(id) => show({ view: "group", groupId: id })}
            deleted={deleted}
            notice={notice}
            onUndo={onUndo}
            onCreate={() => {
              setNotice(null);
              const id = useHomesStore.getState().createGroup();
              show({ view: "group", groupId: id });
            }}
          />
        )}
      </div>
    </div>
  );
}

function GroupList({
  homes,
  currentId,
  onOpen,
  deleted,
  notice,
  onUndo,
  onCreate,
}: {
  homes: Home[];
  currentId: string;
  onOpen: (id: string) => void;
  deleted: Deleted | null;
  notice: string | null;
  onUndo: () => void;
  onCreate: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rearrange = useRearrange({
    keys: homes.map((h) => h.id),
    scrollRef,
    enabled: homes.length > 1,
    onCommit: (order) => useHomesStore.getState().reorderHomes(order),
  });
  return (
    <>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto" data-testid="groups-sheet-list">
        {homes.map((h, i) => {
          const current = h.id === currentId;
          const shift = rearrange.offsetFor(h.id);
          return (
            <div
              key={h.id}
              className="relative"
              data-rearrange-key={h.id}
              data-dragging={shift.dragging ? "1" : undefined}
              style={{
                transform: shift.y ? `translateY(${shift.y}px)` : undefined,
                transition: shift.transition,
                zIndex: shift.dragging ? 3 : undefined,
                background: shift.dragging ? "var(--color-bg-elevated)" : undefined,
                boxShadow: shift.dragging ? "0 10px 28px var(--color-shadow)" : undefined,
                borderRadius: shift.dragging ? 14 : undefined,
              }}
            >
              {homes.length > 1 ? <GripHandle name={h.name} inset={LIST_INSET} handlers={rearrange.handleProps(h.id)} /> : null}
              <button
                type="button"
                className="w-full flex items-center text-left bg-transparent border-0"
                style={{
                  gap: 12,
                  minHeight: 52,
                  paddingLeft: rearrangePadLeft(LIST_INSET, homes.length > 1),
                  paddingRight: 16,
                  color: "var(--color-text-primary)",
                }}
                onClick={() => onOpen(h.id)}
                aria-label={`${h.name}${current ? ", current group" : ""}, ${h.rows.length} in it`}
                data-testid={`groups-row-${i}`}
              >
                <span
                  className="shrink-0 flex items-center justify-center"
                  style={{ width: 24, color: current ? "var(--color-accent-text)" : "var(--color-text-muted)" }}
                >
                  <GroupGlyph icon={h.icon} n={i + 1} size={20} />
                </span>
                <span className={`flex-1 min-w-0 truncate text-[16px] ${current ? "font-semibold" : ""}`}>{h.name}</span>
                <span className="shrink-0 text-[14px]" style={{ color: "var(--color-text-muted)" }}>
                  {h.rows.length}
                </span>
                <span aria-hidden className="shrink-0" style={{ color: "var(--color-text-muted)", opacity: 0.6 }}>
                  <svg width="8" height="14" viewBox="0 0 8 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="m1 1 6 6-6 6" />
                  </svg>
                </span>
              </button>
              {i < homes.length - 1 && !shift.dragging ? (
                <div
                  aria-hidden
                  style={{ position: "absolute", bottom: 0, right: 0, left: `calc(${rearrangePadLeft(LIST_INSET, homes.length > 1)} + 36px)`, height: 0.5, background: "var(--color-wash-2)" }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="shrink-0 flex flex-col" style={{ padding: "6px 16px 0", gap: 4 }}>
        {deleted ? (
          <div role="status" className="flex items-center text-[15px]" style={{ gap: 8, minHeight: 44 }} data-testid="groups-undo">
            <span className="flex-1 min-w-0 truncate" style={{ color: "var(--color-text-secondary)" }}>
              {deleted.home.name} deleted.
            </span>
            <button
              type="button"
              className="shrink-0 bg-transparent border-0 font-semibold text-[15px]"
              style={{ color: "var(--color-accent-text)", minHeight: 44, padding: "0 6px" }}
              onClick={onUndo}
              data-testid="groups-undo-button"
            >
              Undo
            </button>
          </div>
        ) : notice ? (
          <p role="status" className="text-[15px] truncate" style={{ color: "var(--color-text-secondary)", minHeight: 44, lineHeight: "44px" }} data-testid="groups-notice">
            {notice}
          </p>
        ) : null}
        <button
          type="button"
          className="flex items-center bg-transparent border-0 text-[17px]"
          style={{ gap: 8, minHeight: 44, color: "var(--color-accent-text)", padding: 0 }}
          onClick={onCreate}
          data-testid="groups-new"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
            <path d="M12 5v14M5 12h14" />
          </svg>
          New group
        </button>
      </div>
    </>
  );
}

function GroupPage({
  home,
  index,
  canDelete,
  onDelete,
}: {
  home: Home;
  index: number;
  canDelete: boolean;
  onDelete: () => void;
}) {
  const uid = useId();
  const [name, setName] = useState(home.name);
  const [nameFailed, setNameFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [q, setQ] = useState("");
  const [recents, setRecents] = useState<string[]>(readRecentIcons);
  const fallback = emptyNameFallback(useHomesStore.getState().homes, home.id);
  const found = useMemo(() => searchGroupIcons(q), [q]);
  const recentDefs = recents.map((n) => groupIcon(n)).filter((d): d is NonNullable<typeof d> => !!d);

  const saveName = (text: string) => {
    let ok = false;
    try {
      ok = useHomesStore.getState().renameGroup(home.id, text) === "saved";
    } catch {
      ok = false;
    }
    setNameFailed(!ok);
  };
  const pick = (icon: string | null) => {
    useHomesStore.getState().setHomeIcon(home.id, icon);
    if (icon) setRecents(noteRecentIcon(icon));
  };

  const cell = (key: string, label: string, selected: boolean, onClick: () => void, glyph: ReactNode, testId: string) => (
    <button
      key={key}
      type="button"
      className="flex items-center justify-center bg-transparent border-0 p-0"
      style={{
        width: 44,
        height: 44,
        borderRadius: 12,
        color: selected ? "var(--color-accent-text)" : "var(--color-text-primary)",
        boxShadow: selected ? "inset 0 0 0 2px var(--color-accent)" : undefined,
        background: selected ? "var(--color-wash-1)" : undefined,
      }}
      aria-label={label}
      aria-pressed={selected}
      onClick={onClick}
      data-testid={testId}
    >
      {glyph}
    </button>
  );
  const grid = (children: ReactNode, testId: string) => (
    <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(44px, 1fr))", gap: 4, justifyItems: "center" }} data-testid={testId}>
      {children}
    </div>
  );
  const heading = (text: string) => (
    <h3 className="text-[13px] font-semibold uppercase" style={{ color: "var(--color-text-muted)", letterSpacing: "0.3px", margin: "14px 0 6px" }}>
      {text}
    </h3>
  );

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: "0 16px 12px" }} data-testid="group-page">
        <label htmlFor={`${uid}-name`} className="block text-[13px] font-semibold uppercase" style={{ color: "var(--color-text-muted)", letterSpacing: "0.3px", margin: "4px 0 6px" }}>
          Name
        </label>
        <input
          id={`${uid}-name`}
          value={name}
          maxLength={HOME_NAME_MAX}
          placeholder={fallback}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={nameFailed || undefined}
          aria-describedby={nameFailed ? `${uid}-name-error` : undefined}
          className="zen-glass zen-glass-field w-full outline-none text-[16px]"
          style={{
            height: 44,
            padding: "0 14px",
            color: "var(--color-text-primary)",
            boxShadow: nameFailed ? "inset 0 0 0 1.5px var(--color-status-error)" : undefined,
          }}
          onChange={(e) => {
            setName(e.target.value);
            saveName(e.target.value);
          }}
          data-testid="group-name-input"
        />
        {nameFailed ? (
          <div id={`${uid}-name-error`} role="alert" className="text-[14px]" style={{ marginTop: 6, color: "var(--color-status-error-text)" }} data-testid="group-name-error">
            {RENAME_FAILED_TEXT}{" "}
            <button
              type="button"
              className="bg-transparent border-0 p-0 font-semibold underline"
              style={{ color: "var(--color-text-primary)", minHeight: 32 }}
              onClick={() => saveName(name)}
              data-testid="group-name-retry"
            >
              Try again
            </button>
          </div>
        ) : null}

        <div className="flex items-center" style={{ gap: 12, marginTop: 14 }}>
          <div className="flex-1 min-w-0">
            <span id={`${uid}-recent`} className="block text-[16px]">
              {RECENT_FIRST_LABEL}
            </span>
            <span className="block text-[13px]" style={{ color: "var(--color-text-muted)", marginTop: 2 }}>
              {RECENT_FIRST_HINT}
            </span>
          </div>
          <span data-testid="group-recent-first" data-on={home.recentFirst ? "1" : undefined}>
            <Switch
              on={!!home.recentFirst}
              disabled={false}
              labelledBy={`${uid}-recent`}
              onToggle={() => useHomesStore.getState().setRecentFirst(home.id, !home.recentFirst)}
            />
          </span>
        </div>

        {heading("Icon")}
        <label className="zen-glass zen-glass-field flex items-center" style={{ padding: "8px 14px", marginBottom: 8 }}>
          <span className="sr-only">Search icons</span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search icons"
            aria-label="Search icons"
            className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[16px]"
            style={{ color: "var(--color-text-primary)" }}
            data-testid="group-icon-query"
          />
        </label>
        {q.trim() ? (
          found.length === 0 ? (
            <p className="text-[14px]" style={{ color: "var(--color-text-muted)", padding: "8px 0" }} data-testid="group-icon-none">
              No icons match “{q.trim()}”.
            </p>
          ) : (
            grid(
              found.map((d) =>
                cell(d.name, d.name, home.icon === d.name, () => pick(d.name), <GroupGlyph icon={d.name} n={index + 1} size={22} />, `group-icon-${d.name}`)
              ),
              "group-icon-results"
            )
          )
        ) : (
          <>
            {grid(
              [
                cell("none", "No icon", !home.icon, () => pick(null), <GroupDot n={index + 1} size={24} />, "group-icon-none-cell"),
                ...recentDefs.map((d) =>
                  cell(`recent-${d.name}`, d.name, home.icon === d.name, () => pick(d.name), <GroupGlyph icon={d.name} n={index + 1} size={22} />, `group-icon-recent-${d.name}`)
                ),
              ],
              "group-icon-recent"
            )}
            {heading("All icons")}
            {grid(
              found.map((d) =>
                cell(d.name, d.name, home.icon === d.name, () => pick(d.name), <GroupGlyph icon={d.name} n={index + 1} size={22} />, `group-icon-${d.name}`)
              ),
              "group-icon-grid"
            )}
          </>
        )}
      </div>

      <div className="shrink-0" style={{ padding: "8px 16px 0", borderTop: "0.5px solid var(--color-wash-2)" }} data-testid="group-delete-row">
        {confirming ? (
          <div className="flex flex-col" style={{ gap: 8 }} data-testid="group-delete-confirm">
            <span className="text-[14px]" style={{ color: "var(--color-text-secondary)" }}>
              Delete <b style={{ color: "var(--color-text-primary)" }}>{home.name}</b>? Its agents stay where they are. Only the group goes.
            </span>
            <span className="flex" style={{ gap: 8 }}>
              <button
                type="button"
                autoFocus
                className="flex-1 k2-tile k2-tile-raised border-0 text-[16px]"
                style={{ height: 44, borderRadius: 12, color: "var(--color-text-primary)" }}
                onClick={() => setConfirming(false)}
                data-testid="group-delete-keep"
              >
                Keep it
              </button>
              <button
                type="button"
                className="flex-1 border-0 text-[16px] font-semibold"
                style={{ height: 44, borderRadius: 12, background: "var(--color-danger)", color: "var(--color-on-danger)" }}
                onClick={() => {
                  setConfirming(false);
                  onDelete();
                }}
                data-testid="group-delete-yes"
              >
                Delete group
              </button>
            </span>
          </div>
        ) : (
          <div className="flex items-center" style={{ gap: 10 }}>
            <button
              type="button"
              disabled={!canDelete}
              aria-describedby={canDelete ? undefined : `${uid}-why`}
              className="bg-transparent border-0 p-0 text-[16px]"
              style={{ minHeight: 44, color: canDelete ? "var(--color-status-error-text)" : "var(--color-text-muted)" }}
              onClick={() => setConfirming(true)}
              data-testid="group-delete"
            >
              Delete group
            </button>
            {!canDelete ? (
              <span id={`${uid}-why`} className="text-[14px]" style={{ color: "var(--color-text-muted)" }} data-testid="group-delete-why">
                {LAST_GROUP_TEXT}
              </span>
            ) : null}
          </div>
        )}
      </div>
    </>
  );
}
