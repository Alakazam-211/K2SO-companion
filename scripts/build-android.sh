#!/usr/bin/env bash
set -euo pipefail

# ─── K2 Companion — Android (Play Store) Build ───
# Usage: ./scripts/build-android.sh
#
# Why this exists:
#   `cargo tauri android build` copies launcher icons into gen/android ONLY at
#   `android init` time, never on subsequent builds. So once gen/android exists,
#   a rebranded icon in src-tauri/icons/android/ NEVER reaches the AAB — the old
#   icon stays baked in. That triggers Play's "installed icon differs from your
#   store listing" warning. This script force-refreshes the icons into the
#   Android project before every build, so the AAB always carries the current
#   icon WITHOUT wiping gen/android (and your signing config).
#
# What it does:
#   1. Validates the Android toolchain (JDK, SDK, NDK, rust targets).
#   2. Regenerates all icons from app-icon.png (cargo tauri icon).
#   3. Ensures gen/android exists (inits if missing).
#   4. Force-copies the fresh mipmaps over gen/android's res/ (the actual fix).
#   5. Builds the release AAB.
#
# Signing: configure your Play UPLOAD keystore in src-tauri/gen/android per the
# Tauri Android signing guide (key.properties + signingConfigs). gen/android is
# git-ignored, so that config persists across rebuilds — only the icons are
# refreshed here.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

[ -f "$PROJECT_DIR/.env.local" ] && source "$PROJECT_DIR/.env.local"

ICON_SRC="$PROJECT_DIR/app-icon.png"
ANDROID_ICONS="$PROJECT_DIR/src-tauri/icons/android"
GEN_RES="$PROJECT_DIR/src-tauri/gen/android/app/src/main/res"

echo "─── Android build preflight ───"

# ─── 1. Toolchain ───
: "${ANDROID_HOME:=${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
export ANDROID_HOME
[ -d "$ANDROID_HOME" ] || { echo "✗ ANDROID_HOME not found ($ANDROID_HOME). Install Android SDK."; exit 1; }

if ! /usr/libexec/java_home >/dev/null 2>&1; then
  echo "✗ No JDK. Install one (e.g. 'brew install --cask temurin@17') and re-run."; exit 1
fi
export JAVA_HOME="$(/usr/libexec/java_home)"

NDK_DIR="$(ls -d "$ANDROID_HOME"/ndk/* 2>/dev/null | sort -V | tail -1 || true)"
[ -n "$NDK_DIR" ] || { echo "✗ No NDK under $ANDROID_HOME/ndk. Install via 'sdkmanager --install \"ndk;26.3.11579264\"'."; exit 1; }
export NDK_HOME="$NDK_DIR"

for t in aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android; do
  rustup target list --installed 2>/dev/null | grep -q "^$t\$" || {
    echo "  + adding rust target $t"; rustup target add "$t"; }
done
echo "✓ toolchain: SDK=$ANDROID_HOME  NDK=$(basename "$NDK_HOME")  JDK=$JAVA_HOME"

# ─── 2. Regenerate icons from the source of truth ───
[ -f "$ICON_SRC" ] || { echo "✗ $ICON_SRC missing"; exit 1; }
echo "─── Regenerating icons from app-icon.png ───"
cargo tauri icon "$ICON_SRC" >/dev/null
echo "✓ src-tauri/icons refreshed"

# ─── 3. Ensure the Android project exists ───
if [ ! -d "$PROJECT_DIR/src-tauri/gen/android" ]; then
  echo "─── gen/android missing — initializing ───"
  cargo tauri android init
fi

# ─── 4. THE FIX: force-copy fresh launcher icons into the Android project ───
echo "─── Force-refreshing launcher icons in gen/android ───"
for d in "$ANDROID_ICONS"/mipmap-*; do
  name="$(basename "$d")"
  mkdir -p "$GEN_RES/$name"
  cp -f "$d"/* "$GEN_RES/$name/"
done
# adaptive-icon background color lives under values/
if [ -f "$ANDROID_ICONS/values/ic_launcher_background.xml" ]; then
  mkdir -p "$GEN_RES/values"
  cp -f "$ANDROID_ICONS/values/ic_launcher_background.xml" "$GEN_RES/values/"
fi
echo "✓ launcher icons in the AAB will match src-tauri/icons/android (current K2 icon)"

# ─── 5. Build the release AAB ───
echo "─── Building release AAB ───"
cargo tauri android build --aab

AAB="$(ls -t "$PROJECT_DIR"/src-tauri/gen/android/app/build/outputs/bundle/universalRelease/*.aab 2>/dev/null | head -1 || true)"
echo ""
echo "═══════════════════════════════════════════════════"
echo "  Android build done."
[ -n "$AAB" ] && echo "  AAB: $AAB"
echo ""
echo "  Before uploading to Play Console:"
echo "   • Bump versionCode (Play rejects a re-used code)."
echo "   • Confirm the AAB is signed with your UPLOAD key."
echo "   • Also upload playstore-icon-512.png as the 512px store-listing icon"
echo "     so the listing matches the installed launcher icon."
echo "═══════════════════════════════════════════════════"
