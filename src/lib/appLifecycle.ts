// App background / foreground for room sockets (multi-server MS28).
//
// With the multi-server flag on, going to the background closes every room
// socket (sessions/events hubs, the overlay Thread socket, the terminal
// grid), and coming back re-checks the room's server and reopens them
// through the dial queue. With the flag off nothing here fires and every
// socket keeps today's behaviour (`setLifecycleEnabled(false)`, the
// default).

type Phase = "background" | "foreground";
type Listener = (phase: Phase) => void;

let enabled = false;
let installed = false;
let hidden = false;
const listeners = new Set<Listener>();

function onVisibility(): void {
  if (typeof document === "undefined") return;
  const nowHidden = document.visibilityState === "hidden";
  if (nowHidden === hidden) return;
  hidden = nowHidden;
  if (!enabled) return;
  const phase: Phase = nowHidden ? "background" : "foreground";
  for (const fn of [...listeners]) {
    try {
      fn(phase);
    } catch {
      /* one listener never blocks the rest */
    }
  }
}

function install(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  hidden = document.visibilityState === "hidden";
  document.addEventListener("visibilitychange", onVisibility);
}

/** On while the multi-server flag is on (App wires it). */
export function setLifecycleEnabled(on: boolean): void {
  enabled = on;
  install();
}

export function lifecycleEnabled(): boolean {
  return enabled;
}

/** True while the app is in the background AND the lifecycle is on: room
 *  sockets stay closed until the foreground. */
export function inBackground(): boolean {
  return enabled && hidden;
}

/** `fn("background")` / `fn("foreground")` while enabled. */
export function onAppLifecycle(fn: Listener): () => void {
  install();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Tests only: off, and re-read the visibility. Listeners stay (module
 *  ones, like the events hubs', subscribe once at load). */
export function __resetLifecycleForTests(): void {
  enabled = false;
  hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
}
