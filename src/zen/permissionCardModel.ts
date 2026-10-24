// Permission cards (K2 0.46.3 `permission-cards-v1`, phone contract v1):
// the rich card doc a person gets with `cards=2`. Pure (no React), so the
// view rules test on their own; `PermissionCard.tsx` draws them.
//
// The daemon writes `choice.action.view` FOR THIS VIEWER: the same card
// reads `mode:"approve"` (Allow / Deny) for an owner/admin and
// `mode:"wait"` (waiting text, a note box) for the person who asked. Every
// state change rewrites the same doc at the same seq (frame or
// `changed[]`), so the message just re-renders. Without `cards=2` (or for
// a viewer the daemon won't serve it to) the doc is a plain choice or text
// card and none of this applies. A closed card keeps its options for an
// approver, so draw from `view.state` / `choice.status`, never the options.
// Golden samples: src/test/fixtures/permission-cards-0463/ (K2's README
// there lists where the wire differs from the phone contract).

export type PermissionState =
  | "pending"
  | "already_done"
  | "applying"
  | "approved"
  | "denied"
  | "expired"
  | "stale"
  | "failed"
  | "cancelled"
  | "closed";

export type PermissionProof = { kind: "click" } | { kind: "confirm"; action: string; secretId: string };

export type PermissionViewer = {
  login: string;
  role: string;
  mode: "approve" | "wait";
  canAnswer: boolean;
  canAnswerAll: boolean;
  isAsker: boolean;
};

export type PermissionItem = {
  requestId: string;
  state: PermissionState;
  action: string;
  setting: string;
  whatChanges: string;
  direction: "loosen" | "tighten" | null;
  grant: string;
  scope: string;
  duration: string;
  consequences: string;
  values: { key: string; value: string }[];
  why: { by: string; text: string } | null;
  notes: { by: string; role: string; text: string; at: number | null }[];
  askedFor: string | null;
  askers: { count: number; today: number } | null;
  proof: PermissionProof;
  answer: { decision: string; by: string; via: string; at: number | null; reason: string | null } | null;
  undo: { label: string; until: number | null } | null;
};

export type PermissionCardModel =
  | {
      kind: "permission";
      state: PermissionState;
      viewer: PermissionViewer;
      item: PermissionItem;
      approvers: { floor: string; label: string; names: string[] };
      noteBox: { allowed: boolean; max: number; mine: string | null };
      expiresAt: number | null;
      resultMessage: string | null;
      /** The card's option labels (exact), e.g. `Allow`/`Deny` or `Close`. */
      options: string[];
      /** Still waiting on an answer (`choice.status` pending). */
      open: boolean;
    }
  | {
      kind: "batch";
      state: "pending" | "done";
      viewer: PermissionViewer;
      items: PermissionItem[];
      approvers: { floor: string; label: string; names: string[] };
      expiresAt: number | null;
      options: string[];
      open: boolean;
    };

/** Exact answer labels (the daemon matches them character for character). */
export const ALLOW = "Allow";
export const DENY = "Deny";
export const ALLOW_ALL = "Allow all";
export const DENY_ALL = "Deny all";
export const CLOSE = "Close";
export const UNDO_LABEL = "Turn off again";
/** Deny reasons are cut at this length. */
export const DENY_REASON_MAX = 200;

const STATES = new Set<PermissionState>([
  "pending",
  "already_done",
  "applying",
  "approved",
  "denied",
  "expired",
  "stale",
  "failed",
  "cancelled",
  "closed",
]);

type O = Record<string, unknown>;
const obj = (v: unknown): O | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as O) : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function state(v: unknown): PermissionState {
  return STATES.has(v as PermissionState) ? (v as PermissionState) : "pending";
}

function viewer(v: unknown): PermissionViewer {
  const o = obj(v) ?? {};
  return {
    login: str(o.login),
    role: str(o.role),
    mode: o.mode === "approve" ? "approve" : "wait",
    canAnswer: o.canAnswer === true,
    canAnswerAll: o.canAnswerAll === true,
    isAsker: o.isAsker === true,
  };
}

function proof(v: unknown): PermissionProof {
  const o = obj(v);
  if (o?.kind === "confirm" && str(o.action) && str(o.secretId)) {
    return { kind: "confirm", action: str(o.action), secretId: str(o.secretId) };
  }
  return { kind: "click" };
}

function item(o: O): PermissionItem {
  const why = obj(o.why);
  const ans = obj(o.answer);
  const undo = obj(o.undo);
  const askers = obj(o.askers);
  return {
    requestId: str(o.requestId),
    state: state(o.state),
    action: str(o.action),
    setting: str(o.setting),
    whatChanges: str(o.whatChanges),
    direction: o.direction === "loosen" || o.direction === "tighten" ? o.direction : null,
    grant: str(o.grant),
    scope: str(o.scope),
    duration: str(o.duration),
    consequences: str(o.consequences),
    values: (Array.isArray(o.values) ? o.values : [])
      .map((x) => obj(x))
      .filter((x): x is O => !!x)
      .map((x) => ({ key: str(x.key), value: str(x.value) })),
    why: why && str(why.text) ? { by: str(why.by), text: str(why.text) } : null,
    notes: (Array.isArray(o.notes) ? o.notes : [])
      .map((x) => obj(x))
      .filter((x): x is O => !!x && !!str(x.text))
      .map((x) => ({ by: str(x.by), role: str(x.role), text: str(x.text), at: num(x.at) })),
    askedFor: str(o.askedFor) || null,
    askers: askers ? { count: num(askers.count) ?? 0, today: num(askers.today) ?? 0 } : null,
    proof: proof(o.proof),
    answer: ans
      ? { decision: str(ans.decision), by: str(ans.by), via: str(ans.via), at: num(ans.at), reason: str(ans.reason) || null }
      : null,
    undo: undo && str(undo.label) ? { label: str(undo.label), until: num(undo.until) } : null,
  };
}

function approvers(v: unknown) {
  const o = obj(v) ?? {};
  return {
    floor: str(o.floor) || "admin",
    label: str(o.label) || "owner or admin",
    names: (Array.isArray(o.names) ? o.names : []).filter((n): n is string => typeof n === "string"),
  };
}

/** The rich card in a Thread doc's `choice`, or null (an ordinary card, a
 *  fallback doc, or a view version this build doesn't know). */
export function parsePermissionCard(choice: unknown): PermissionCardModel | null {
  const c = obj(choice);
  const action = obj(c?.action);
  const view = obj(action?.view);
  if (!c || !action || !view || view.v !== 1) return null;
  const options = (Array.isArray(c.options) ? c.options : [])
    .map((o) => (typeof o === "string" ? o : str(obj(o)?.label)))
    .filter(Boolean);
  const st = view.state;
  const open = typeof c.status === "string" ? c.status === "pending" : st === "pending" || st === "applying";
  if (action.id === "permission.batch" && view.kind === "batch") {
    return {
      kind: "batch",
      state: view.state === "done" ? "done" : "pending",
      viewer: viewer(view.viewer),
      items: (Array.isArray(view.items) ? view.items : [])
        .map((x) => obj(x))
        .filter((x): x is O => !!x && !!str(x.requestId))
        .map(item),
      approvers: approvers(view.approvers),
      expiresAt: num(view.expiresAt),
      options,
      open,
    };
  }
  if (action.id !== "permission" || view.kind !== "permission") return null;
  const nb = obj(view.noteBox) ?? {};
  const result = obj(action.result);
  return {
    kind: "permission",
    state: state(view.state),
    viewer: viewer(view.viewer),
    item: item(view),
    approvers: approvers(view.approvers),
    noteBox: { allowed: nb.allowed === true, max: num(nb.max) ?? 500, mine: str(nb.mine) || null },
    expiresAt: num(view.expiresAt),
    resultMessage: str(result?.message).trim() || null,
    options,
    open,
  };
}

// ─── Words ───

/** "an owner" / "an admin" for the waiting text. */
function approverNoun(floor: string): string {
  return floor === "owner" ? "an owner" : "an admin";
}

/** The waiting text for a `wait` viewer (contract §2.3). */
export function waitingText(card: Extract<PermissionCardModel, { kind: "permission" }>): string {
  const by = card.item.why?.by || "The agent";
  const who = approverNoun(card.approvers.floor);
  // A card that tightens access turns its setting off (live test
  // 2026-10-24, "Stop k2 creating new databases").
  const verb = card.item.direction === "tighten" ? "turn off" : "turn on";
  return card.viewer.isAsker
    ? `Asked ${who} to ${verb} ${card.item.setting} for you. You can keep working with ${by} meanwhile.`
    : `${by} asked ${who} to ${verb} ${card.item.setting}.`;
}

/** One line for a settled state (contract §2.4); null while pending. */
export function stateLine(card: Extract<PermissionCardModel, { kind: "permission" }>, at: (s: number | null) => string): string | null {
  const a = card.item.answer;
  switch (card.state) {
    case "already_done":
      return "Already on";
    case "applying":
      return "Applying…";
    case "approved":
      return `Allowed by ${a?.by || "someone"}${a?.at ? `, ${at(a.at)}` : ""}`;
    case "denied":
      return `Denied by ${a?.by || "someone"}`;
    case "failed":
      return `Couldn't apply${card.resultMessage ? `: ${card.resultMessage}` : ""}`;
    case "stale":
      return card.resultMessage || "Already changed; nothing applied";
    case "expired":
      return "Expired unanswered";
    case "cancelled":
      return `Withdrawn by ${card.item.why?.by || "the agent"}`;
    case "closed":
      return "Closed: permission cards were turned off";
    default:
      return null;
  }
}

/** A note the daemon will take (contract §5): one paragraph, no links,
 *  within `max`. Null when fine, else what to fix. */
export function noteProblem(text: string, max: number): string | null {
  if (text.length > max) return `Keep it under ${max} characters.`;
  if (/[\r\n]/.test(text)) return "Keep it to one paragraph.";
  if (/https?:|www\./i.test(text)) return "Notes can't contain links.";
  return null;
}

/** Pending items of a batch. */
export function pendingItems(card: Extract<PermissionCardModel, { kind: "batch" }>): PermissionItem[] {
  return card.items.filter((i) => i.state === "pending");
}
