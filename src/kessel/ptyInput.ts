// Direct-type + accessory-bar bytes (Esc, ⇧⏎, Ctrl+C, live keystrokes).
//
// Grid `{action:"input"}` is how the PTY gets raw bytes. Watch attach
// is viewer, and a viewer socket is `input_denied` — so the first
// keystroke must flip `set_mode:claimer`. That is NOT Drive: we never
// send `set_active` / `resize` here (Watch stays a size policy).
// SGR 64/65 stays on sgrInputActions (Drive-only).

export function ptyInputFrames(
  text: string,
  alreadyClaimer: boolean,
): ReadonlyArray<{ action: string; mode?: string; text?: string }> {
  if (!text) return [];
  if (alreadyClaimer) return [{ action: "input", text }];
  return [
    { action: "set_mode", mode: "claimer" },
    { action: "input", text },
  ];
}
