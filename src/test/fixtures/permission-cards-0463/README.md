# Permission cards: golden samples for K2 Companion (K2 0.46.3, `cards=2`, `view.v = 1`)

**97 sample files + `index.json`.** They were written by K2's own daemon code (lane F,
branch `hold/permission-cards-f-push-0463` @ `62ae4bad3`, which is F on A3 `27508ecfe` / A1 `4b76c670a`,
plus lane A2 `73d72281e` for the push). Update 2: the two push samples were added; no other
sample changed when A2's code came in.
The code built the request rows, posted the card, ran the real answer route
(`POST /cli/thread/answer`, `client:"phone"`), the expiry sweep, the cancel route and the
switch-off close, and then ran A3's per-viewer projection. The test
`cargo test -p k2-daemon permission_samples` fails if the code and these files differ.
**Where the phone contract's text and a sample disagree, the sample is right.** The
differences are listed below.

## Files

`<view>__<state>__<form>.json`; `index.json` lists each file with its view, state, form,
transport and sha256.

| form | what it is |
|---|---|
| `cards2` | the Thread doc a person gets with `cards=2` |
| `fallback` | the same viewer's doc without `cards=2` (today's Companion); agents always get this |
| `item` | a `GET /cli/thread?cards=2` item `{collection, seq, id, doc, conversation_id}`; delta `items`/`changed[]` and catchup items have the same shape |
| `ws` | a `WS /cli/overlay/events?cards=2` frame `{collection, seq, id, doc, rev}` (`/cli/thread/stream` wraps the same doc) |
| `response` | `POST /cli/thread/answer` → `{status, body}` |
| `hidden` | App guests: no doc at all |
| `legacy` | `push__permission__legacy.json`: the relay payload for rosson's phone when the card is posted: `{title, body, data, sound, threadId, collapseId}` |
| `sealed-plaintext` | `push__permission__sealed-plaintext.json`: the E2E alert plaintext before sealing and padding: `{v, kid, ctr, ts, kind, srv, bk, title, body, group, data}` |

| view | who |
|---|---|
| `approver-click` | rosson, an **Owner** login, on the `compute.use` card (Admin floor, click) |
| `approver-admin` | maya, an **Admin** login, on the same card (at the floor: approve view) |
| `owner-token` | the owner token (desktop) |
| `asker` | dana, a Member, the login the agent was working with (`askedFor`) |
| `member` | lee, a Member who isn't the asker |
| `agent` | the asking agent's passport (fallback only, whatever it sends) |
| `approver-confirm` | rosson on `apps.approve` (Owner floor, confirm `app-approve`, held request `ar_22`) |
| `admin-wait-confirm` | maya on that card: below the Owner floor, so `mode:"wait"` and no confirm sheet |
| `batch-approver` / `batch-admin` | rosson / maya on a batch: `apps.build`, `apps.core`, and `apps.approve` (`ar_23`, a confirm item) |
| `guest` | an App guest: never receives a permission card |
| `answer` | answer responses and errors |

**States:**
- single card: `pending`, `applying`, `approved`, `already_done` (`[Close]`), `already_done-closed`, `denied`, `expired`, `stale`, `failed`, `cancelled`, `closed`;
- batch: `pending`, `partial` (the click items were allowed, the confirm item is still waiting), `done`.

**Answer responses:** `allow`, `allow-confirmed`, `allow-stale`, `allow-failed`, `deny`, `close`, `batch-allow-all`, `batch-item-confirmed`, `below-floor` (403), `admin-below-owner-floor` (403), `confirm-required` (403), `not-an-option` (400), `answered-already` (409).

**Fixed clock:**
- asked `1761060000`;
- note `1761060300`;
- answered `1761061200`;
- expires `1761319200`.

Workspaces are `billing` and `shopdev`.

## Differences from `permission-cards-phone-contract-v1.md` (the real wire)

1. **Doc ids are UUIDs** (`7f3a2c90-4f1e-…`), not `tc_…`. Treat them as opaque and upsert by `id`.
2. **Send `client:"phone"` in the answer body.** `view.answer.via` comes from it. Without it, a login's answer reads `via:"web"` and the owner token's reads `"desktop"`. Allowed values: `desktop`, `phone`, `web`, `terminal`. (The contract's §3 bodies don't mention `client`.)
3. **Choice docs also carry `body`**, a copy of the prompt (today's field). Ignore it on `kind:"choice"`.
4. **`choice.action.result` is absent while pending**, not `null`. `view.answer` and `view.undo` are `null`.
5. **A closed card keeps its options for approvers.** `[Allow, Deny]` stays on approved, denied, stale, failed, expired, cancelled and closed cards (as in §11.2); a batch keeps `[Allow all, Deny all]`. Draw from `view.state` / `choice.status`, never from the options. Wait viewers always get `options: []`.
6. **`approvers.names` is sorted by login** (`["maya","rosson"]`, not `["rosson","maya"]`). The owner token is never listed, because it isn't a login.
7. **The answer's 200 body has extra fields:**
   - `decided: [{id, state}]`, `conversation_id` and `addr`;
   - after a batch's "Allow all" with a confirm item left, `status` is `"pending"` and `action.result` is `null`;
   - when the batch finishes, `result` is `{message:"3 of 3 answered.", outcome:"done"}`.
8. **Answering a card that is already closed gives 409 `card_not_pending`** (hint "this card was already answered or dismissed"). The card check comes first. You get `request_not_pending` only when two answers race.
9. **`choice.answeredAt` on an expired card** is the expiry time. On `cancelled` / `closed` (voided) cards, `choice.answeredBy` is absent and `view.answer` is `null`.
10. **A batch view has no top-level `noteBox`, `askedFor` or `undo`.** Each item carries its own `state`, `answer`, `approvers`, `noteBox` and `proof`. After the batch is done, `choice.answer` is the last label used (e.g. `"Allow"`).
11. **There is a `partial` batch state.** The batch stays `view.state:"pending"` with some items `approved` while a confirm item waits (`viewer.canAnswerAll:false`).
12. **Request ids are `pr_` plus 6–32 hex characters**, or the held id. §11.12's `pr_a1` / `pr_a2` aren't valid ids, so the samples use `pr_a1a1a1` / `pr_a2a2a2`.
13. **Guests:** App guests never receive a permission card, not even as text (Rosson, 2026-10-21). This replaces:
    - §1's "guests get the fallback";
    - §5's guest notes (guests write none in v1);
    - §6's App-guest row;
    - §10 #8 (the samples are `guest__*__hidden.json`).

    `view.askers` is always `null`.
14. **Fallback texts** (no `cards=2`) are written out in full in the `*__fallback.json` files. Some examples:
    - "Withdrawn by billing: Allow compute nodes."
    - "Closed: permission cards were turned off. Allow compute nodes for billing was not applied."
    - "Couldn't apply Allow compute nodes for billing: <message>"
    - "Denied by rosson: … Reason: …"

    A batch's fallback is one header line plus one `- <setting>: waiting` / state line per item.
15. **The old-build approver's fallback prompt** is K2's line, then `billing says: "<why>"`, then one line per note, `dana (member): "<text>"`, separated by `\n`.
16. **The 403 below the floor** has the body `{ok:false, error:{code:"action_card_person_only", hint:"only a person with the admin role answers this card", required:"admin"}}`.
17. **`rev` is on every WS frame** for people. GET items carry `conversation_id`.
18. **Push (§7).** The `data` keys are as §7 says. The relay payload also has:
    - `sound: "default"`;
    - `threadId` and `collapseId`, both `thread:<conversationId>`. There is no `group` key on the legacy lane; `group` is only on the sealed plaintext.

    Other differences:
    - In the sealed plaintext, the server stamp sits in `srv` (`sub`, `iid`) and `bk`, not in `data` (`subdomain`, `instanceId` and `badgeKey` are legacy-only).
    - `avatarRev` is `""` when the agent has no picture.
    - The samples' `agentColor` is the default `#3b82f6`.

## Not in this drop yet

- **Real catalog words.** Lanes E1/E2 haven't registered `compute.use` / `apps.*` yet, so these cards use stand-in specs with the PRD's words. That's why `apps.approve` lists only `workspace` and `request` in `values`, with no command or port. When E1/E2 land, the words and values come from the real specs. **The shapes don't change.**
- **Note, undo and "Waiting on you" responses.** Lane A2 has built `/cli/thread/permission-note`, `/cli/thread/permission-undo` and `GET /cli/permission/pending`, but there are no samples of their responses yet. Their shapes are in A2's notes and match §5, §3 and §8.
