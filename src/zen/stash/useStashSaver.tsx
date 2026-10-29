import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { StashFullDialog } from "./StashSheet";
import { useStashStore, type StashSaveInput } from "./stashStore";

/** How long the stash tab says "Saved" after a save. */
export const STASH_SAVED_FLASH_MS = 1400;

export type StashSaveOutcome = "saved" | "cancelled" | "empty" | "error";

/**
 * Save to the stash from any place in the Thread (composer, message hold
 * menu, an agent's offer card). At the cap it asks first (StashFullDialog)
 * and saves only on "Remove oldest". Resolves "saved" once the stash is
 * written: the composer clears only then.
 */

export function useStashSaver(): {
  save: (input: StashSaveInput) => Promise<StashSaveOutcome>;
  /** Shows "Saved" on the stash tab for a moment. */
  flash: boolean;
  dialog: ReactNode;
} {
  const [asking, setAsking] = useState<{ input: StashSaveInput; resolve: (r: StashSaveOutcome) => void } | null>(null);
  const [flash, setFlash] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const saved = useCallback(() => {
    setFlash(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setFlash(false), STASH_SAVED_FLASH_MS);
    return "saved" as const;
  }, []);

  const save = useCallback(
    async (input: StashSaveInput): Promise<StashSaveOutcome> => {
      const r = await useStashStore.getState().save(input);
      if (r === "saved") return saved();
      if (r !== "full") return r;
      return new Promise<StashSaveOutcome>((resolve) => setAsking({ input, resolve }));
    },
    [saved]
  );

  const dialog = asking ? (
    <StashFullDialog
      onCancel={() => {
        asking.resolve("cancelled");
        setAsking(null);
      }}
      onReplace={() => {
        const { input, resolve } = asking;
        setAsking(null);
        void useStashStore
          .getState()
          .save(input, { replaceOldest: true })
          .then((r) => resolve(r === "saved" ? saved() : r === "full" ? "error" : r));
      }}
    />
  ) : null;

  return { save, flash, dialog };
}
