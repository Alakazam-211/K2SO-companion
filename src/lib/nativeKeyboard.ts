// The keyboard for a focus the page itself makes (iOS). WebKit raises the
// keyboard only for a focus during a user interaction (a tap); a
// script's focus() otherwise gets the caret and no keyboard. When the page
// must give the keyboard back on its own (a swipe-back that springs home
// refocuses the field it blurred), it arms a one-shot allowance in the
// shell first (src-tauri/src/lib.rs `ios_keyboard_allow_focus`), then
// focuses. Off iOS this resolves false and a plain focus is used.

function inShell(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

/** Focus `el` with its keyboard. The plain focus runs at once (enough
 *  inside a touch handler); on iOS the allowance is armed and the field
 *  focused again, which WebKit treats as a fresh focus while no keyboard
 *  is showing for it. Skipped if focus moved elsewhere meanwhile. */
export function focusWithKeyboard(el: HTMLElement): void {
  el.focus({ preventScroll: true });
  if (!inShell()) return;
  void (async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      if (!(await invoke<boolean>("ios_keyboard_allow_focus"))) return;
    } catch {
      return;
    }
    const a = document.activeElement;
    if (!el.isConnected || (a !== el && a !== document.body && a !== null)) return;
    el.focus({ preventScroll: true });
  })();
}
