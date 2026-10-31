// HTTP cap per server (multi-server MS26, MA26): at most 4 requests in
// flight per saved server id (desktop `daemon-cli.ts`
// `REMOTE_CLI_MAX_INFLIGHT = 4`, per hostKey). The phone's HTTP is reqwest
// through `@tauri-apps/plugin-http`, not WebKit, so the risk this bounds is
// pool churn and tunnel rate limits on a slow server — a busy B queues
// behind B only, never behind A.
//
// Speed PRD A4: what the person is waiting on (the open chat's read, a
// send, a card answer, a file preview) jumps the queue (`"user"`), behind
// earlier user requests only; background reads keep their order.

export type HttpPriority = "user" | "background";

export const HTTP_MAX_INFLIGHT_PER_SERVER = 4;

interface Lane {
  inflight: number;
  waiting: Array<{ start: () => void; user: boolean }>;
}

const lanes = new Map<string, Lane>();

function laneOf(key: string): Lane {
  let lane = lanes.get(key);
  if (!lane) {
    lane = { inflight: 0, waiting: [] };
    lanes.set(key, lane);
  }
  return lane;
}

function release(key: string): void {
  const lane = laneOf(key);
  lane.inflight = Math.max(0, lane.inflight - 1);
  const next = lane.waiting.shift();
  if (next) next.start();
  else if (lane.inflight === 0) lanes.delete(key);
}

function run<T>(key: string, fn: () => Promise<T>): Promise<T> {
  let p: Promise<T>;
  try {
    p = fn();
  } catch (e) {
    release(key);
    return Promise.reject(e);
  }
  return p.finally(() => release(key));
}

/** Run `fn` holding one of `serverId`'s HTTP slots. With a free slot `fn`
 *  starts synchronously (no extra tick), exactly as without the cap. */
export function withHttpSlot<T>(
  serverId: string,
  fn: () => Promise<T>,
  priority: HttpPriority = "background"
): Promise<T> {
  const key = serverId || "";
  const lane = laneOf(key);
  if (lane.inflight < HTTP_MAX_INFLIGHT_PER_SERVER) {
    lane.inflight += 1;
    return run(key, fn);
  }
  return new Promise<T>((resolve, reject) => {
    const item = {
      user: priority === "user",
      start: () => {
        lane.inflight += 1;
        run(key, fn).then(resolve, reject);
      },
    };
    if (!item.user) {
      lane.waiting.push(item);
      return;
    }
    // After the user requests already waiting, ahead of everything else.
    const at = lane.waiting.findIndex((w) => !w.user);
    if (at < 0) lane.waiting.push(item);
    else lane.waiting.splice(at, 0, item);
  });
}

/** Tests: requests in flight on one server. */
export function httpInFlight(serverId: string): number {
  return lanes.get(serverId || "")?.inflight ?? 0;
}

/** Tests only. */
export function __resetHttpCapForTests(): void {
  lanes.clear();
}
