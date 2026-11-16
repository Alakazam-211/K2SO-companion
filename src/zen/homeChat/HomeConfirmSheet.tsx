// One confirm sheet for Home (the app's bottom-sheet confirm: the server
// update's and the Groups sheet's look): a title, a line, the choices, and
// Cancel. `askHome({...})` resolves the picked choice's id, or null for
// Cancel, Back, or a tap outside: a Cancel never does anything.
//
// Used by Remove from Home on a person or channel row and the "Same
// person?" question (§2.4: Same person / Different person + Cancel). A
// channel's Delete is the chat view's (`HomeChatConfirmSheet`, in the
// members sheet).

import { createPortal } from "react-dom";
import { create } from "zustand";
import { useBackHandler } from "../../lib/androidBack";

export interface HomeChoice {
  id: string;
  label: string;
  /** The accent's filled button (the safe or expected pick). */
  primary?: boolean;
  /** Red words (a removal). */
  danger?: boolean;
}

export interface HomeAsk {
  title: string;
  body?: string;
  choices: HomeChoice[];
  /** Cancel's words (default "Cancel"). */
  cancelLabel?: string;
  testId?: string;
}

interface AskState {
  ask: (HomeAsk & { resolve: (id: string | null) => void }) | null;
}

export const useHomeAsk = create<AskState>(() => ({ ask: null }));

/** Ask; resolves the choice's id, or null (Cancel). A second ask cancels
 *  the first. */
export function askHome(a: HomeAsk): Promise<string | null> {
  return new Promise((resolve) => {
    const prev = useHomeAsk.getState().ask;
    useHomeAsk.setState({ ask: { ...a, resolve } });
    prev?.resolve(null);
  });
}

function answer(id: string | null): void {
  const a = useHomeAsk.getState().ask;
  if (!a) return;
  useHomeAsk.setState({ ask: null });
  a.resolve(id);
}

/** Remove from <group>: a person's DM can't be left in Sew, so the row
 *  only hides; say so. */
export async function confirmRemoveChatRow(name: string, groupName: string, kind: "person" | "channel"): Promise<boolean> {
  const id = await askHome({
    title: `Remove ${name} from ${groupName}?`,
    body:
      kind === "person"
        ? "Your messages stay. Add them again from + to see this chat on Home."
        : "You stay in the channel. Add it again from + to see it on Home.",
    choices: [{ id: "remove", label: "Remove", danger: true }],
    testId: "home-remove-confirm",
  });
  return id === "remove";
}

/** The sheet; mount once where Home is. */
export function HomeConfirmHost() {
  const ask = useHomeAsk((s) => s.ask);
  if (!ask) return null;
  return <Sheet ask={ask} />;
}

function Sheet({ ask }: { ask: HomeAsk }) {
  // Android Back = Cancel.
  useBackHandler(true, () => answer(null));
  const testId = ask.testId ?? "home-confirm";
  return createPortal(
    <div
      className="fixed inset-0 flex items-end justify-center"
      style={{ background: "var(--color-scrim)", zIndex: 60, fontFamily: "var(--zen-font)" }}
      data-testid={testId}
      onClick={(e) => {
        if (e.target === e.currentTarget) answer(null);
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={ask.title}
        className="w-full k2-tile k2-tile-sheet flex flex-col"
        style={{
          borderTopLeftRadius: 14,
          borderTopRightRadius: 14,
          padding: "18px 16px max(12px, var(--safe-bottom))",
          gap: 12,
          color: "var(--color-text-primary)",
        }}
      >
        <h2 className="text-[17px] font-semibold text-center" style={{ lineHeight: 1.3 }} data-testid={`${testId}-title`}>
          {ask.title}
        </h2>
        {ask.body ? (
          <p className="text-[14px] text-center" style={{ color: "var(--color-text-secondary)", lineHeight: 1.4 }} data-testid={`${testId}-body`}>
            {ask.body}
          </p>
        ) : null}
        <div className="flex flex-col" style={{ gap: 8, marginTop: 2 }}>
          {ask.choices.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`w-full text-[17px] ${c.primary ? "font-semibold" : "k2-tile"}`}
              style={{
                minHeight: 48,
                borderRadius: 12,
                border: 0,
                background: c.primary ? "var(--color-accent-fill)" : undefined,
                color: c.primary ? "var(--color-on-accent)" : c.danger ? "var(--color-status-error-text)" : "var(--color-text-primary)",
              }}
              data-testid={`${testId}-${c.id}`}
              onClick={() => answer(c.id)}
            >
              {c.label}
            </button>
          ))}
          <button
            type="button"
            className="w-full text-[17px] bg-transparent"
            style={{ minHeight: 44, border: 0, color: "var(--color-accent-text)" }}
            data-testid={`${testId}-cancel`}
            onClick={() => answer(null)}
          >
            {ask.cancelLabel ?? "Cancel"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
