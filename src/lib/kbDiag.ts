// Keyboard event diagnostics (iOS; Server settings → Diagnostics →
// "Keyboard events"). The native shell keeps a short, content-free log of
// the app / keyboard lifecycle and WebKit's focus-hold state
// (src-tauri/src/lib.rs `ios_keyboard_diag`); the page adds marks (a
// swipe's start and release, DOM focus changes) so one log shows both
// sides. Also the switch for the native "keep the keyboard on return"
// hold (on by default, remembered on this device).
//
// Everything is best effort: off iOS (or in tests) the calls do nothing.

const HOLD_KEY = "k2.kb.returnHold";

function inShell(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

async function call(args: { action: string; label?: string; on?: boolean }): Promise<string> {
  if (!inShell()) return "";
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke<string>("ios_keyboard_diag", args)) ?? "";
  } catch {
    return "";
  }
}

/** Add a line to the native log (fire and forget). */
export function kbMark(label: string): void {
  void call({ action: "mark", label });
}

/** The log with the current state on top ("" off iOS). */
export function kbReport(): Promise<string> {
  return call({ action: "report" });
}

export function kbClear(): Promise<string> {
  return call({ action: "clear" });
}

/** The return hold switch as remembered here (default on). */
export function returnHoldOn(): boolean {
  try {
    return typeof localStorage === "undefined" || localStorage.getItem(HOLD_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setReturnHoldOn(on: boolean): void {
  try {
    localStorage.setItem(HOLD_KEY, on ? "1" : "0");
  } catch {
    /* session only */
  }
  void call({ action: "hold", on });
}

function describe(t: EventTarget | null): string {
  if (!(t instanceof Element)) return "none";
  const id = t.getAttribute("data-testid");
  return `${t.tagName.toLowerCase()}${id ? `[${id}]` : ""}`;
}

let installed = false;

/** Once at startup: push the remembered switch to native and mark DOM
 *  focus changes and page visibility in the log. */
export function initKbDiag(): void {
  if (installed || !inShell() || typeof document === "undefined") return;
  installed = true;
  if (!returnHoldOn()) void call({ action: "hold", on: false });
  document.addEventListener("focusin", (e) => kbMark(`focusin ${describe(e.target)}`), true);
  document.addEventListener("focusout", (e) => kbMark(`focusout ${describe(e.target)}`), true);
  document.addEventListener("visibilitychange", () => kbMark(`visibility ${document.visibilityState}`));
}
