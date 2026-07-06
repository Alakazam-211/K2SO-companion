# K2 Companion — Play Store Build Runbook

Audience: the agent that builds & ships the Android app to Google Play.
Goal: produce a signed AAB whose **launcher icon matches the store listing** so
Google stops flagging *"Your app's installed icon or name differs from its store
listing."*

---

## 0. TL;DR

```bash
cd <K2SO-companion repo>
./scripts/build-android.sh          # bakes the CURRENT K2 icon into the AAB
# → bump versionCode, sign with the UPLOAD key, upload the AAB
# → also upload playstore-icon-512.png as the 512px store-listing icon
```

Two things must BOTH be the current K2 icon and match each other:
1. the **launcher icon inside the AAB** (fixed by `build-android.sh`), and
2. the **512×512 store-listing icon** in Play Console (uploaded manually).

---

## 1. Why this keeps breaking (read once)

This is a **Tauri** app (`src-tauri/`), not Expo/React-Native. The launcher icon
lives in `src-tauri/icons/android/mipmap-*` and is generated from `app-icon.png`.

The trap: `cargo tauri android build` copies icons into `src-tauri/gen/android`
**only at `android init` time, never on a plain build.** `gen/android` (tracked
in git since the Firebase wiring, 2026-07) silently caches whatever
icon was current when it was first created. After a rebrand, every rebuild keeps
shipping the **old** icon → Play's consistency warning.

`scripts/build-android.sh` fixes this by force-copying the fresh mipmaps into
`gen/android/app/src/main/res/` before each build. Use it; don't call
`cargo tauri android build` directly.

> The Expo-looking files under `assets/` (`icon.png`, `adaptive-icon.png`,
> `favicon.png`, `splash-icon.png`) are dead scaffolding placeholders. Tauri
> does NOT use them. Ignore them.

---

## 2. Prerequisites (one-time per build machine)

- **JDK 17** — `brew install --cask temurin@17` (any JDK 17 works)
- **Android SDK** — typically `~/Library/Android/sdk`
- **Android NDK** — `sdkmanager --install "ndk;26.3.11579264"` (any installed NDK; the script auto-picks the newest)
- **Rust android targets** — the script adds these automatically:
  `aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`
- **Tauri CLI v2** — `cargo install tauri-cli --version '^2'` (repo confirmed on 2.10.x)
- **The Play UPLOAD keystore** — Jeremie's `.jks`/`.keystore` used for this app.
  It is NOT in the repo. Keep it off-repo; reference it from `gen/android` signing
  config (see §4). With Play App Signing, you sign with the *upload* key and
  Google re-signs with the app-signing key.

App coordinates (do **not** change — changing the identifier creates a NEW Play listing):
- applicationId / identifier: `com.alakazamlabs.k2so.companion`
- app name (productName): `K2`

---

## 3. Build the AAB

```bash
cd <K2SO-companion repo>
git pull                       # make sure app-icon.png is the current K2 icon
./scripts/build-android.sh
```

What the script does, in order:
1. Validates toolchain (JDK / SDK / NDK / rust targets) — fails loud with the fix if anything's missing.
2. `cargo tauri icon app-icon.png` — regenerates `src-tauri/icons/**` from source.
3. `cargo tauri android init` if `gen/android` is missing.
4. **Force-copies** `src-tauri/icons/android/mipmap-*` + the adaptive background into `gen/android/.../res/` (the actual fix).
5. `cargo tauri android build --aab`.

Output AAB:
`src-tauri/gen/android/app/build/outputs/bundle/universalRelease/*.aab`

---

## 4. Signing

`gen/android` is regenerated/refreshed, but the script only touches icon
resources, so a persistent signing config in `gen/android` survives. Configure
Tauri/Gradle signing once per machine (Tauri v2 Android signing guide):

- Create `src-tauri/gen/android/keystore.properties` (git-ignored via
  `gen/android/.gitignore` AND the repo root `.gitignore` — keep it that way) with:
  ```
  storeFile=/absolute/path/to/upload-keystore.jks
  storePassword=********
  keyAlias=upload
  keyPassword=********
  ```
- Ensure `app/build.gradle.kts` reads it into a `release` `signingConfig`.

Verify the AAB is signed with the **upload** key (not debug):
```bash
jarsigner -verify -verbose -certs <path-to>.aab | head
```

---

## 5. Version bump

Play rejects a re-used `versionCode`. Bump it every upload.
- `versionName` follows `tauri.conf.json` `version` (currently `2.0.0`).
- `versionCode` must strictly increase. Use a monotonic scheme (e.g. timestamp
  `yymmddHHMM`, or +1 each release). Set it in `tauri.conf.json` →
  `bundle.android.versionCode` (preferred) or the generated Gradle if you manage
  it there.

---

## 6. Upload + clear the warning

In **Play Console**:
1. **Store listing icon** — *Grow → Store presence → Main store listing → App icon* →
   upload `playstore-icon-512.png` (512×512, repo root). This is a manual asset;
   no build touches it.
2. **New release** — *Release → Production* (or Internal testing first) → upload the
   signed AAB → bump rollout.
3. After processing, the *"installed icon differs from your store listing"*
   warning clears once both icons are the new K2 mark and match.

---

## 7. Verify before you ship

- [ ] `build-android.sh` ran clean; AAB produced.
- [ ] Unzip the AAB and confirm the launcher PNGs are the K2 icon:
      `unzip -o app.aab -d /tmp/aab && open /tmp/aab/base/res/mipmap-xxxhdpi*/ic_launcher*.png`
- [ ] AAB signed with the upload key (`jarsigner -verify`).
- [ ] `versionCode` strictly greater than the last upload.
- [ ] 512px store icon uploaded in Play Console.
- [ ] On a test device (Internal testing track), the home-screen icon is the new K2.

---

## 8. Toolchain + Firebase notes (added 2026-07-06, gen/android init)

- **`gen/android` is now TRACKED in git** (build outputs + `keystore.properties`
  excluded via its `.gitignore`). Don't delete/re-init it casually — it carries
  the Firebase wiring below. `tauri.settings.gradle`, `tauri.properties`, and
  `/.tauri` are generated per-build and stay ignored.
- **JDK**: this machine uses Homebrew OpenJDK 17 (formula, no sudo — the
  `temurin@17` cask needs sudo). It is NOT registered with `/usr/libexec/java_home`,
  so export explicitly before building:
  ```bash
  export JAVA_HOME="$(brew --prefix openjdk@17)/libexec/openjdk.jdk/Contents/Home"
  export ANDROID_HOME="$HOME/Library/Android/sdk"
  export NDK_HOME="$ANDROID_HOME/ndk/26.3.11579264"
  ```
  (`build-android.sh` uses `/usr/libexec/java_home`, which fails for a
  brew-formula JDK — pre-export `JAVA_HOME` or symlink the JDK system-wide.)
- **Firebase push wiring** (package `com.alakazamlabs.k2so.companion`, Firebase
  project `k2-companion-x`):
  - `gen/android/app/google-services.json` — committed (public identifiers only);
    source of truth staged at `~/private_keys/firebase/google-services.json`.
  - `gen/android/settings.gradle` — `pluginManagement { google(); mavenCentral(); gradlePluginPortal() }`
    (required for the plugins-DSL resolution below; Tauri's generated settings has none).
  - `gen/android/build.gradle.kts` — `plugins { id("com.google.gms.google-services") version "4.5.0" apply false }`.
  - `gen/android/app/build.gradle.kts` — `id("com.google.gms.google-services")` in the plugins block.
  - Do NOT add firebase-bom/analytics deps — `tauri-plugin-k2-push/android`
    already declares `firebase-messaging`.
- A **debug** build (`tauri android build --debug --apk`) is the no-keystore gate;
  release AABs still need the upload keystore per §4.

---

## Reference

- Build script: `scripts/build-android.sh`
- Store icon: `playstore-icon-512.png` (generated from `app-icon.png` @ 512²)
- Icon source of truth: `app-icon.png` → `src-tauri/icons/android/`
- App id: `com.alakazamlabs.k2so.companion` · name: `K2`
- The desktop/iOS side is unaffected; `scripts/release.sh` remains iOS-only.
