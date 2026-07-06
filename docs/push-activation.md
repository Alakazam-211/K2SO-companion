# Push notifications — activation runbook

The push pipeline shipped **dormant** across three repos (companion C6, K2
daemon C4, k2-connect relay C5). Nothing prompts, registers, or sends until
every step below is done — and each layer stays independently safe if you
stop halfway.

**Chain:** daemon (`push_routes.rs`, token registry + dispatch triggers) →
relay gateway (`k2-connect` `POST /push/dispatch`, `docs/push-gateway.md`) →
APNs / FCM → this app (`src-tauri/tauri-plugin-k2-push`).

**Payloads are content-free by contract:** generic title + `{kind,
feedbackId?|groupId?}` only. Question/message text never rides APNs/FCM; the
app pulls it over the authenticated K2 Connect channel on open.

## Bundle id reality (read first)

The **built iOS app is `com.alakazamlabs.k2so.companion`** — that's
`PRODUCT_BUNDLE_IDENTIFIER` in `src-tauri/gen/apple/project.yml` and what the
archive Info.plist carries. Two stale ids float around; do not use them:

- `project.yml`'s `bundleIdPrefix: dev.k2.companion` is overridden by the
  explicit setting — ignore it (flagged for cleanup before store submission,
  per the C6 PRD note).
- Older revival docs mention `dev.k2.companion` — stale.

Everything below (APNs topic, provisioning, Firebase app registration) keys
on **`com.alakazamlabs.k2so.companion`**.

## 1. Apple / APNs

1. **Auth key (one-time, ~15 min):** Apple Developer portal → Certificates,
   Identifiers & Profiles → Keys → create an **APNs Auth Key (`.p8`)**. One
   key serves the whole account; never expires. Record the **Key ID**
   (10 chars) and the **Team ID** (`36B8R93HXV`, already in `project.yml`).
   The `.p8` goes **on the relay only** (step 3) — never in the app or repo.
2. **App capability:** in `src-tauri/gen/apple`, add the **Push
   Notifications** capability to the `k2so-companion_iOS` target. Concretely,
   add to `k2so-companion_iOS/k2so-companion_iOS.entitlements`:

   ```xml
   <key>aps-environment</key>
   <string>development</string>   <!-- 'production' for App Store/TestFlight builds -->
   ```

   (If regenerating the project from `project.yml`, the entitlements file
   path is already wired under `targets.k2so-companion_iOS.entitlements`.)
3. **Re-provision:** the provisioning profile must include the push
   entitlement for `com.alakazamlabs.k2so.companion` — with automatic
   signing, enabling the capability in Xcode once (Signing & Capabilities →
   `+ Capability` → Push Notifications) regenerates it.
4. **What flips the app live:** with `aps-environment` present,
   `registerForRemoteNotifications` starts returning a device token instead
   of error 3000, so the plugin's `is_available()` probe answers true and the
   Settings toggle appears. No app-code change needed.
5. **Testing reality:** production APNs needs a real device; Apple-silicon
   simulators support **sandbox** pushes. Dev/debug builds register against
   sandbox APNs — the relay must run `K2C_APNS_SANDBOX=1` to reach them.

## 2. Google / FCM (Android)

There is no Google-free path for closed-app delivery on stock Android;
mitigation is the content-free payload (see the C6 PRD §4.5 invariants).

1. **Firebase project (one-time, ~30 min, $0):** console.firebase.google.com
   → create project → register an **Android app** with package
   `com.alakazamlabs.k2so.companion` (must match the tauri identifier used
   when `gen/android` is initialized). Download:
   - `google-services.json` → goes **in the app** at
     `src-tauri/gen/android/app/google-services.json`
   - a **service-account JSON** (Project settings → Service accounts →
     Generate new private key) → goes **on the relay only** (step 3).
2. **Note — `gen/android` does not exist yet** (no Android project has been
   generated in this repo). First run `npx tauri android init`, which
   scaffolds `src-tauri/gen/android` and auto-links the plugin's
   `android/` library. Then:
3. **Enable the google-services gradle plugin** (the ONE build change; keep
   it commented out until the json is in place):
   - `src-tauri/gen/android/build.gradle.kts` (project-level `plugins`
     block) — add:

     ```kotlin
     id("com.google.gms.google-services") version "4.4.2" apply false
     ```

   - `src-tauri/gen/android/app/build.gradle.kts` (app-level `plugins`
     block) — add:

     ```kotlin
     id("com.google.gms.google-services")
     ```

   The plugin crate itself needs **no change**: `firebase-messaging` is
   already a plain dependency of `tauri-plugin-k2-push/android/build.gradle.kts`
   and compiles without the google-services plugin. What flips Android live
   is the json + these two lines initializing the default `FirebaseApp` —
   the plugin's `FirebaseApp.getApps().isEmpty()` gate then passes.
4. **Dormancy guard boundary (don't break it):** removing the
   `firebase-messaging` dependency from the plugin's gradle file is the one
   thing that breaks compilation (`K2FirebaseMessagingService` extends its
   service class). Everything else — missing json, missing gradle plugin,
   missing Firebase project — only yields "unavailable" at runtime.

## 3. Relay gateway (k2-connect repo — full detail in its `docs/push-gateway.md`)

On the control-plane node (`/etc/k2-connect/k2c.env`):

| Env | Value |
|---|---|
| `K2C_PUSH_GATEWAY_TOKEN` | shared bearer, e.g. `openssl rand -hex 32` (unset ⇒ route 503s = dormant) |
| `K2C_APNS_KEY_PATH` | `/etc/k2-connect/apns-authkey.p8` (0600 root:root) |
| `K2C_APNS_KEY_ID` | the 10-char Key ID |
| `K2C_APNS_TEAM_ID` | `36B8R93HXV` |
| `K2C_APNS_TOPIC` | `com.alakazamlabs.k2so.companion` |
| `K2C_APNS_SANDBOX` | `1` while testing dev builds; **unset** for production |
| `K2C_FCM_SERVICE_ACCOUNT_PATH` | `/etc/k2-connect/fcm-service-account.json` (0600 root:root) |

Then: add the `push.k2.dev` Caddy block (sample in `docs/push-gateway.md`) +
the HAProxy `be_terminate` SNI entry, reload both, and
`systemctl restart k2-control-plane`. Journal should log `push gateway
ENABLED` + both lanes. Gateway URL for daemons:
**`https://push.k2.dev/push/dispatch`**.

## 4. K2 daemon(s)

Per daemon that should send pushes (env or app settings, then **restart** —
the target is resolved once at first dispatch):

- `K2_PUSH_GATEWAY_URL=https://push.k2.dev/push/dispatch` (or setting
  `pushGatewayUrl`)
- `K2_PUSH_GATEWAY_TOKEN=<the shared bearer>` (or setting `pushGatewayToken`)

Unset = the daemon's `K2Cloud` sender is a no-op (dormant); device
registrations still accumulate harmlessly.

## 5. End-to-end test plan (sandbox first)

1. **Relay dormancy lift:** `curl -X POST https://push.k2.dev/push/dispatch`
   with the bearer + a fake token → expect `200` with a per-token
   `dead:true`/error (proves the vendor round-trip). No bearer → `403`.
2. **iOS sandbox:** dev build on a device (or Apple-silicon simulator),
   relay with `K2C_APNS_SANDBOX=1`. In the app: Settings → Push
   notifications toggle appears (probe passed) → ON → permission prompt →
   check the daemon: `push_devices` table has one `apns` row.
3. **Trigger:** `k2 feedback ask` on that daemon (or have an agent file
   feedback) → notification arrives with the generic title. Tap →
   app opens on `/feedback/<id>`.
4. **Cold-start tap:** force-quit the app, send another feedback push, tap →
   app launches and deep-links (the `get_launch_tap` path).
5. **Android:** repeat 2-4 with an FCM build (`google-services.json` +
   gradle lines in place); also verify a foreground push renders (the
   service's local-notification path) and its tap deep-links.
6. **Toggle-off:** Settings → toggle OFF → `push_devices` row gone
   (`unregister-device`); no more pushes.
7. **Prod APNs:** TestFlight build (`aps-environment: production`), relay
   `K2C_APNS_SANDBOX` unset — repeat 3.

## App-side architecture (for whoever debugs this later)

- `src-tauri/tauri-plugin-k2-push/` — local Tauri v2 mobile plugin.
  Commands: `is_available`, `request_permission`, `get_token`,
  `get_launch_tap`; events: `tap`, `tokenRefresh`.
  - iOS availability = a prompt-free `registerForRemoteNotifications` probe
    (missing entitlement fails fast → `available:false`).
  - Android availability = `FirebaseApp.getApps()` non-empty.
- `src/lib/push.ts` — availability cache, stable `deviceId` (UUID persisted
  in plugin-store `push.json`), `ensureRegistered(server)` (gated:
  available AND toggle on → permission → token → `POST
  /cli/push/register-device`, re-sent every launch), `unregisterAll()`,
  tap→route mapping (`feedback`→`/feedback/<id>`,
  `project`→`/projects/<groupId>`; a foreign `subdomain` is ignored in V1 —
  navigation stays on the current server).
- `src/App.tsx` `PushBridge` — mounts tap navigation + token-refresh
  re-registration; `AppLayout` re-registers on launch/server switch.
- `src/pages/Settings.tsx` `PushRow` — the toggle; renders
  "Not available in this build" while dormant.
