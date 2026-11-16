#!/usr/bin/env bash
set -euo pipefail

# ─── K2 iOS archive build, on a K2 compute Mac ───
#
# The heavy half of `scripts/release.sh --remote-build`: it runs ON the
# compute node (k2 compute run … -- bash scripts/ios-remote-build.sh), never
# on the release Mac. release.sh stamps the versions and sends the stamped
# tree with --dirty; this builds the release .xcarchive from it UNSIGNED (the
# node has no Apple certificates or profiles) and packs
#   k2-ios-build.tgz = k2so-companion_iOS.xcarchive + acknowledgements.txt
# at the repo root, kept as the job's artifact. release.sh fetches it, then
# signs and exports on the release Mac (xcodebuild -exportArchive, manual
# signing), where the certificate and profiles live.
#
# What it needs on the node: Xcode, rustup with the iOS target for the
# rust-toolchain.toml channel, node (--needs node@22), and the network (npm,
# crates.io, GitHub: Sew's dfn3 release, XcodeGen's release, git deps).
#
# Env: VOICE_CRYPTO=1 skips the ring/rustls guard (the voice build; see
# release.sh "Export compliance").

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
ARCHIVE_DIR="$ROOT/src-tauri/gen/apple/build"
ARCHIVE_PATH="$ARCHIVE_DIR/k2so-companion_iOS.xcarchive"
OUT="$ROOT/k2-ios-build.tgz"
BUILD_LOG="$ROOT/k2-ios-build.log"   # the full tauri/xcodebuild log, a job artifact too
T0=$SECONDS
step() { echo "→ [$((SECONDS - T0))s] $*"; }

step "Tools"
xcodebuild -version | head -2
(cd src-tauri && rustc --version && rustup target list --installed | grep '^aarch64-apple-ios$' >/dev/null) || {
  echo "Error: rustup's toolchain for src-tauri/rust-toolchain.toml lacks aarch64-apple-ios"; exit 3; }
node --version
# xcodegen: tauri ios build regenerates the Xcode project with it. Not a
# k2 compute --needs tool on Macs yet (and mise's aqua registry has no
# yonaskolb/xcodegen), so: the pinned release zip, sha256-checked, kept in
# the job's --cache (else this job's TMPDIR). share/ must stay beside bin/
# (its SettingPresets).
XCODEGEN_VERSION="2.45.3"
XCODEGEN_SHA256="0c90f4d28ca57335f9fa78cf5bf6dabfe20a232036dabe36de2eef79cb7c0878"
if ! command -v xcodegen >/dev/null 2>&1; then
  XG_HOME="${K2_JOB_CACHE:-${TMPDIR:-/tmp}}/xcodegen-$XCODEGEN_VERSION"
  if [ ! -x "$XG_HOME/xcodegen/bin/xcodegen" ]; then
    rm -rf "$XG_HOME" && mkdir -p "$XG_HOME"
    curl -fsSL --retry 3 -o "$XG_HOME/xcodegen.zip" \
      "https://github.com/yonaskolb/XcodeGen/releases/download/$XCODEGEN_VERSION/xcodegen.zip"
    GOT="$(shasum -a 256 "$XG_HOME/xcodegen.zip" | awk '{print $1}')"
    if [ "$GOT" != "$XCODEGEN_SHA256" ]; then
      echo "Error: xcodegen.zip sha256 $GOT, expected $XCODEGEN_SHA256"; rm -rf "$XG_HOME"; exit 3
    fi
    (cd "$XG_HOME" && unzip -q xcodegen.zip && rm xcodegen.zip)
  fi
  export PATH="$XG_HOME/xcodegen/bin:$PATH"
fi
xcodegen --version

step "npm ci"
npm ci --no-audit --no-fund --loglevel=error

step "DeepFilterNet3 weights"
scripts/fetch-dfn3.sh

# gen-acknowledgements reads `cargo metadata --offline` (every target, iOS and
# Android): the crates must be in CARGO_HOME first. A dev Mac always has them.
step "cargo fetch"
(cd src-tauri && cargo fetch --locked --quiet)

step "Acknowledgements"
node scripts/gen-acknowledgements.mjs

if [ -z "${VOICE_CRYPTO:-}" ]; then
  if (cd src-tauri && cargo tree -e normal --target aarch64-apple-ios -i ring 2>/dev/null | grep '^ring ' >/dev/null); then
    echo "Error: the iOS build links ring/rustls. Keep tauri-plugin-http on native-tls for iOS (src-tauri/Cargo.toml)."
    echo "       The voice build opts in with VOICE_CRYPTO=1 (declares encryption; see release.sh)."
    exit 1
  fi
fi

# No signing here: the node has no certificate or profile, so every target
# builds unsigned and the release Mac signs at export. tauri runs xcodebuild
# with its own environment and settings (XCODE_XCCONFIG_FILE never reaches
# it), so the job's own copy of project.pbxproj is edited: no profile, no
# identity, CODE_SIGNING_ALLOWED = NO in every build configuration. This
# checkout is the job's; nothing here goes back into git.
PBXPROJ="src-tauri/gen/apple/k2so-companion.xcodeproj/project.pbxproj"
perl -pi -e '
  s/^(\s*"?PROVISIONING_PROFILE_SPECIFIER(\[[^\]]*\])?"?) = [^;]*;/$1 = "";/;
  s/^(\s*"?CODE_SIGN_IDENTITY(\[[^\]]*\])?"?) = [^;]*;/$1 = "";/;
  s/^(\s*)buildSettings = \{\n/$1buildSettings = {\n$1\tCODE_SIGNING_ALLOWED = NO;\n$1\tCODE_SIGNING_REQUIRED = NO;\n/;
' "$PBXPROJ"
if grep -E 'PROVISIONING_PROFILE_SPECIFIER.* = "[^"]+";|CODE_SIGN_IDENTITY.* = "[^"-]+";' "$PBXPROJ"; then
  echo "Error: signing settings left in $PBXPROJ (above)"; exit 1
fi
echo "  unsigned: $(grep -c 'CODE_SIGNING_ALLOWED = NO;' "$PBXPROJ") build configurations"

# SwiftPM's own sandbox can't start inside the job's (scripts/ios-remote/
# swift-shim.sh says why): tauri's and the plugins' build scripts must find
# the shim as `swift`. Xcode puts its toolchain first on the PATH of the
# "Build Rust Code" phase, so a PATH entry alone loses; cargo's [env] (forced)
# sets the PATH its build scripts get. The file is the job's, at the repo
# root (cargo finds it from src-tauri/ too); the shim's folder is in the
# cache so the PATH (and so cargo's fingerprints) stays the same run to run.
SHIM_DIR="${K2_JOB_CACHE:-${TMPDIR:-/tmp}}/swift-shim"
mkdir -p "$SHIM_DIR"
cp scripts/ios-remote/swift-shim.sh "$SHIM_DIR/swift"
chmod 755 "$SHIM_DIR/swift"
DEV_DIR="$(xcode-select -p)"
mkdir -p .cargo
cat > .cargo/config.toml <<TOML
# Written by scripts/ios-remote-build.sh in this job's checkout only.
[env]
PATH = { value = "$SHIM_DIR:$DEV_DIR/Toolchains/XcodeDefault.xctoolchain/usr/bin:$DEV_DIR/usr/bin:$PATH", force = true }
TOML
echo "  swift for build scripts: $SHIM_DIR/swift (--disable-sandbox)"

step "tauri ios build (archive, unsigned)"
rm -rf "$ARCHIVE_PATH" "$OUT"
# tauri archives, then exports; the export can't sign here and fails, so
# its exit code says nothing: the archive is checked instead.
set +e
npx --no-install tauri ios build --ci -v 2>&1 | tee "$BUILD_LOG" \
  | grep -E "Compiling k2|Finished|ARCHIVE|EXPORT|error|warning: unused|Error" | grep -v '^\s*$' | tail -60
TAURI_EXIT=${PIPESTATUS[0]}
set -e
echo "  tauri ios build exit $TAURI_EXIT (an export failure is expected unsigned)"

# tauri runs the archive quietly (no "ARCHIVE SUCCEEDED" line). xcodebuild
# writes the .xcarchive (its Info.plist last) only when the archive worked,
# and it was removed above, so a complete one is this run's.
APP="$ARCHIVE_PATH/Products/Applications/K2.app"
if [ ! -f "$ARCHIVE_PATH/Info.plist" ] || [ ! -x "$APP/K2" ] \
  || [ ! -x "$APP/PlugIns/K2NotificationService.appex/K2NotificationService" ] \
  || [ ! -x "$APP/PlugIns/K2Broadcast.appex/K2Broadcast" ]; then
  echo "Error: no complete archive at $ARCHIVE_PATH. The build log's tail:"
  tail -80 "$BUILD_LOG"
  exit 1
fi
grep -q "EXPORT FAILED" "$BUILD_LOG" || [ "$TAURI_EXIT" -eq 0 ] || {
  echo "Error: tauri ios build failed before its export (exit $TAURI_EXIT)"; tail -80 "$BUILD_LOG"; exit 1; }
scripts/fetch-dfn3.sh --verify "$APP/assets/dfn3"
echo "  CFBundleVersion $(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Info.plist"), version $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Info.plist")"

step "Pack"
tar -czf "$OUT" -C "$ARCHIVE_DIR" k2so-companion_iOS.xcarchive -C "$ROOT/public" acknowledgements.txt
ls -l "$OUT"
shasum -a 256 "$OUT"
step "Done"
