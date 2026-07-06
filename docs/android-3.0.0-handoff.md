# Android 3.0.0 — build + push-notification test handoff (Jeremie)

Written 2026-07-06. iOS 3.0.0 is on TestFlight and **push notifications are
proven live end-to-end on iOS** (real banner on a real device through the
production pipeline). Android is fully wired but has never run on a physical
device — that device pass is this handoff. Companion for the full runbook:
`docs/playstore-build-runbook.md` (coordinates, icon trap, Play App Signing).

## What's already done (nothing to re-do)

- `src-tauri/gen/android/` exists (Tauri android init, AGP 8.11, Gradle 8.14.3)
  and builds — a debug APK was verified today with the FCM service, intent
  filters, `POST_NOTIFICATIONS`, and Firebase resources all correctly merged.
- Firebase project `k2-companion-x` registered for
  `com.alakazamlabs.k2so.companion`; `google-services.json` is committed at
  `src-tauri/gen/android/app/google-services.json` (public identifiers only).
- The relay's FCM lane is **deployed and verified against Google's live API**
  (server side needs nothing from you).
- Release signing config is wired: `app/build.gradle.kts` reads
  `gen/android/keystore.properties` (gitignored, see below). Without the file,
  release builds fall back to the DEBUG key — fine locally, useless for Play.

## Your setup (one-time, ~5 min)

1. `git pull` (this doc, the signing config, and the whole 3.0.0 app come
   with it), then `npm install`.
2. JDK 17 + Android SDK as usual. Heads-up: on the build Mac here, the brew
   `openjdk@17` formula isn't registered with `/usr/libexec/java_home`, so
   `scripts/build-android.sh`'s JDK check fails unless you
   `export JAVA_HOME=...` first. If your JDK came from Temurin/Studio you
   won't hit this. NDK pin: `26.3.11579264`.
3. Create `src-tauri/gen/android/keystore.properties` pointing at YOUR Play
   upload keystore (the same one that signed 2.0 — it is deliberately not in
   git):

   ```properties
   storeFile=/absolute/path/to/upload.jks
   storePassword=…
   keyAlias=…
   keyPassword=…
   ```

## Build the AAB

```sh
npx tauri android build --aab
# output: src-tauri/gen/android/app/build/outputs/bundle/universalRelease/
```

Gotchas:
- **Never invoke bare `./gradlew`** for anything that compiles rust — the
  rust gradle task needs the Tauri CLI orchestrating it and dies with a
  "failed to read CLI options / WebSocket" panic otherwise. Always go through
  `npx tauri android build`.
- versionCode/versionName derive from tauri.conf.json's `3.0.0`
  automatically (versionCode 3000000 > the 2.x codes, so Play accepts it).
- Launcher icon: verify the built app's icon is the K2 mark, not the Tauri
  default — the stale-icon trap and its force-copy fix are in the runbook §
  icon section (`scripts/build-android.sh` step 4 does it for you if you
  build through the script).

## Upload → Internal testing

Play Console → K2 Companion → Testing → **Internal testing** → new release →
upload the AAB. Don't promote to production until the push test below passes.

## THE TEST: push notifications on a real device

This mirrors the iOS verification done today. Install from the internal
track on a physical Android phone (13+ ideally — that's where the runtime
permission prompt exists), then:

1. **Sign in** to a reachable K2 server in the app (Rosson's
   `z3thon.k2.dev` is the one with the push-configured daemon — coordinate
   with him, or configure your own daemon's `pushGatewayUrl`/`pushGatewayToken`).
2. **Settings → Push notifications → toggle ON.** Expect the Android
   permission prompt ("Allow K2 to send notifications?") → Allow. If the row
   says "Not available in this build", Firebase didn't initialize — check
   `google-services.json` made it into the AAB and ping the desk.
3. **Tell Rosson/Claude the toggle is on** — they verify the token row landed
   in the daemon (`push_devices`, platform `fcm`) and fire a test dispatch
   through the live gateway at your token.
4. What must happen, in order of importance:
   - notification banner arrives with the app **backgrounded**
   - and with the app **fully killed** (swipe-removed from recents)
   - **tapping it opens the app to the right place** (feedback thread),
     including from cold start
   - toggle OFF unregisters (the daemon row disappears — desk verifies)
5. Note the device make/model in your report — aggressive OEM battery
   managers (Samsung/Xiaomi especially) are the usual suspect if delivery
   is delayed; that's diagnostic info, not a failure of the pipeline.

Everything server-side (relay lanes, daemon dispatch, token registry) is
already proven — if step 2's prompt appears and step 4's banners land, the
Android half of push is done and 3.0.0 can promote.
