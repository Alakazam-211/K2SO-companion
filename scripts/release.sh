#!/usr/bin/env bash
set -euo pipefail

# ─── K2 iOS Release Script ───
# Usage: ./scripts/release.sh [--no-upload] [--size-report] <version>
# Example: ./scripts/release.sh 3.1.0
#
# One marketing version. package.json, tauri.conf.json, Info.plist
# CFBundleShortVersionString, the git tag (vX.Y.Z), and the App Store
# Connect version string are the same number. CFBundleVersion is a
# timestamp build id only (so a marketing version can be re-uploaded).
# Do not pass a second "internal" tag version.
#
# What it does:
#   1. Bumps version in package.json, tauri.conf.json, Info.plist,
#      Cargo.toml and project.yml
#   2. Stamps a unique timestamp build number
#   3. Builds frontend + iOS archive (after scripts/fetch-dfn3.sh has
#      fetched and verified the noise removal weights; the archive's
#      copy is verified too)
#   4. Exports App Store IPA
#   5. Uploads to App Store Connect
#   6. Commits, tags, and pushes HEAD to origin/main + the tag
#      (NO_PUSH=1: commits and tags locally, pushes nothing)
#
# --no-upload: dry run. Steps 1-4 up to the exported IPA, then stops: no
#   App Store Connect call at all (no validate, no upload), no commit, and
#   every file the run changed is put back (git checkout) on exit.
# --size-report: also export a thinned development build and keep Apple's
#   "App Thinning Size Report.txt" (download + install size per device).
# --remote-build: the heavy half (npm ci, the frontend, the Rust + Xcode
#   archive) runs on a K2 compute Mac, not here (the owner's rule: no heavy
#   Rust/Xcode builds on the release Mac). This Mac stamps the versions,
#   sends the stamped tree (k2 compute run --dirty), and then only signs,
#   exports and uploads. The node builds the archive UNSIGNED
#   (scripts/ios-remote-build.sh); it comes back as the job's artifact and
#   exportArchive signs it here with the entitlements files. Node:
#   K2_IOS_BUILD_NODE=<k2 compute node> (required with --remote-build; no
#   default). Same checks as a local build, plus the exported IPA's
#   entitlements.
# Where it lands: an upload pushes HEAD to origin/main and tags v<version>,
#   so it must run from main or release-<version>. A test-track TestFlight
#   build from any other branch: RELEASE_BRANCH=<branch> NO_TAG=1 (the
#   script refuses otherwise, and refuses a "never merge" commit on main
#   or a tag). A hotfix from an older line: RELEASE_BRANCH=release-<x>.
# NO_PUSH=1: build, upload and commit (and tag, unless NO_TAG=1) as usual,
#   but locally only: no `git push` of the branch or the tag. The closing
#   banner prints the push commands to run once the commit is reviewed.
#   The guards above still apply: they check where the commit will land.
# VOICE_CRYPTO=1: the voice build. See "Export compliance" in Step 2.
#   EXPORT_COMPLIANCE_CODE=<code> adds the code App Store Connect issues
#   once encryption documentation is approved (see there).
# Each archive's dSYMs are kept in ~/k2-builds/<version>-<build>/
# (K2_BUILDS_DIR overrides); the archive itself is replaced every run.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

ORIG_ARGS="$*"
NO_UPLOAD=""
SIZE_REPORT=""
REMOTE_BUILD=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-upload) NO_UPLOAD=1; shift ;;
    --size-report) SIZE_REPORT=1; shift ;;
    --remote-build) REMOTE_BUILD=1; shift ;;
    *) break ;;
  esac
done

# App Store Connect API credentials (set via environment or .env.local).
# A --no-upload run needs only the team id (export signing).
if [ -f "$PROJECT_DIR/.env.local" ]; then
  source "$PROJECT_DIR/.env.local"
fi
TEAM_ID="${ASC_TEAM_ID:?Set ASC_TEAM_ID (Apple Developer Team ID)}"
if [ -z "$NO_UPLOAD" ]; then
  API_KEY="${ASC_API_KEY:?Set ASC_API_KEY (App Store Connect API Key ID)}"
  API_ISSUER="${ASC_API_ISSUER:?Set ASC_API_ISSUER (App Store Connect Issuer ID)}"
  API_KEY_PATH="$HOME/private_keys/AuthKey_${API_KEY}.p8"
fi

# Files that contain version numbers
TAURI_CONF="$PROJECT_DIR/src-tauri/tauri.conf.json"
PACKAGE_JSON="$PROJECT_DIR/package.json"
INFO_PLIST="$PROJECT_DIR/src-tauri/gen/apple/k2so-companion_iOS/Info.plist"
# Notification Service Extension (Communication Notifications). Its
# versions must equal the app's or App Store Connect flags the upload.
NSE_INFO_PLIST="$PROJECT_DIR/src-tauri/gen/apple/K2NotificationService/Info.plist"
# Broadcast Upload Extension (the iPhone screen share). Same rule.
BROADCAST_INFO_PLIST="$PROJECT_DIR/src-tauri/gen/apple/K2Broadcast/Info.plist"
ARCHIVE_PATH="$PROJECT_DIR/src-tauri/gen/apple/build/k2so-companion_iOS.xcarchive"
EXPORT_DIR="$PROJECT_DIR/src-tauri/gen/apple/build/appstore"
EXPORT_PLIST="$PROJECT_DIR/src-tauri/gen/apple/build/AppStoreExport.plist"
# The export-compliance declaration lives in three files: the XcodeGen
# spec, the generated Info.plist, and Info.ios.plist (merged on build).
IOS_PLIST="$PROJECT_DIR/src-tauri/Info.ios.plist"

# ─── Validate ───

if [ $# -ne 1 ]; then
  echo "Usage: $0 [--no-upload] [--size-report] [--remote-build] <version>"
  echo "Example: $0 3.1.0"
  echo "One marketing version only — git tag, store version, and plist match."
  exit 1
fi

# Marketing version (CFBundleShortVersionString). Apple rejects 0.x on
# new submissions and rejects going backwards vs the highest train already
# in App Store Connect (store or TestFlight). Floor as of 2026-08 is 3.0.1.
VERSION="$1"

if ! echo "$VERSION" | grep -qE '^[1-9][0-9]*\.[0-9]+\.[0-9]+$'; then
  echo "Error: version must be X.Y.Z with X >= 1 (e.g., 3.1.0). Apple rejects 0.x."
  exit 1
fi

# Check API key exists
if [ -z "$NO_UPLOAD" ] && [ ! -f "$API_KEY_PATH" ]; then
  echo "Error: API key not found at $API_KEY_PATH"
  echo "Place your AuthKey_${API_KEY}.p8 file in ~/private_keys/"
  exit 1
fi

# Check clean working tree (allow icon changes)
if ! git -C "$PROJECT_DIR" diff --quiet -- ':!src-tauri/icons' ':!src-tauri/gen/apple/Assets.xcassets'; then
  echo "Error: Working tree has uncommitted changes. Commit or stash first."
  git -C "$PROJECT_DIR" status --short
  exit 1
fi

# Where this run lands (a guard, not a reminder: K2, 2026-11-16, after a
# test-track session build was pushed to main and tagged). An upload ends
# by pushing HEAD to origin/${RELEASE_BRANCH:-main} and tagging v<version>
# (unless NO_TAG=1). So, before anything is changed:
#   - Landing on main: only from main itself or release-<version> (the
#     shipping line). Any other branch is a test-track build: run it with
#     RELEASE_BRANCH=<its branch> NO_TAG=1.
#   - Tagging: only main or a release-* line takes the version's tag.
#   - Never anything carrying a "never merge" commit onto main or a tag.
if [ -z "$NO_UPLOAD" ]; then
  CUR_BRANCH="$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD)"
  TARGET_BRANCH="${RELEASE_BRANCH:-main}"
  if [ "$TARGET_BRANCH" = "main" ] && [ "$CUR_BRANCH" != "main" ] && [ "$CUR_BRANCH" != "release-$VERSION" ]; then
    if [ -n "${NO_TAG:-}" ]; then
      echo "Error: this run would land $CUR_BRANCH on GitHub main."
    else
      echo "Error: this run would land $CUR_BRANCH on GitHub main and tag v$VERSION."
    fi
    echo "  Shipping $VERSION: run it from main or release-$VERSION."
    echo "  A TestFlight-only (test-track) build: RELEASE_BRANCH=$CUR_BRANCH NO_TAG=1 $0 $ORIG_ARGS"
    exit 1
  fi
  if [ -z "${NO_TAG:-}" ] && [ "$TARGET_BRANCH" != "main" ] && [ "${TARGET_BRANCH#release-}" = "$TARGET_BRANCH" ]; then
    echo "Error: only main or a release-* line takes the v$VERSION tag; $TARGET_BRANCH is a test track."
    echo "  Run it with NO_TAG=1: RELEASE_BRANCH=$TARGET_BRANCH NO_TAG=1 $0 $ORIG_ARGS"
    exit 1
  fi
  if [ "$TARGET_BRANCH" = "main" ] || [ -z "${NO_TAG:-}" ]; then
    git -C "$PROJECT_DIR" fetch -q origin main 2>/dev/null || true
    NEVER="$(git -C "$PROJECT_DIR" log --format='%h %s' -i --grep='never merge' origin/main..HEAD 2>/dev/null || true)"
    if [ -n "$NEVER" ]; then
      echo "Error: HEAD carries a never-merge commit, so it can't land on $TARGET_BRANCH or take a tag:"
      echo "$NEVER" | sed 's/^/  /'
      echo "  A test-track build: RELEASE_BRANCH=$CUR_BRANCH NO_TAG=1 $0 $ORIG_ARGS"
      exit 1
    fi
  fi
fi

# Noise removal's DeepFilterNet3 weights (39 MB, not in git): downloaded
# from Sew's release and checked against their pinned sha256s, before
# anything is changed. A mismatch stops the release here; the archive is
# checked again after the build. A remote build fetches them on the node
# (they're not in git, so --dirty doesn't carry them); the archive's copy is
# checked here all the same.
if [ -z "$REMOTE_BUILD" ]; then
  "$SCRIPT_DIR/fetch-dfn3.sh"
else
  command -v k2 >/dev/null 2>&1 || { echo "Error: --remote-build needs the k2 CLI"; exit 1; }
  if [ -z "${K2_IOS_BUILD_NODE:-}" ]; then
    echo "Error: --remote-build needs K2_IOS_BUILD_NODE=<k2 compute Mac node> (there is no default)."
    echo "  e.g. K2_IOS_BUILD_NODE=<node> $0 $ORIG_ARGS   (or drop --remote-build to build here)"
    exit 1
  fi
fi

# Generate unique build number (YYYYMMDDHHmm)
BUILD_NUMBER="$(date +%Y%m%d%H%M)"
# Durable per-build folder outside the repo: dSYMs, size report, commit.
KEEP_DIR="${K2_BUILDS_DIR:-$HOME/k2-builds}/${VERSION}-${BUILD_NUMBER}"

# Put the committed declaration back: ITSAppUsesNonExemptEncryption false,
# no ITSEncryptionExportComplianceCode.
restore_encryption_declaration() {
  sed -i '' '/<key>ITSAppUsesNonExemptEncryption<\/key>/{ n; s/<true\/>/<false\/>/; }' "$INFO_PLIST" "$IOS_PLIST"
  perl -0pi -e 's|\s*<key>ITSEncryptionExportComplianceCode</key>\s*<string>[^<]*</string>||' "$INFO_PLIST" "$IOS_PLIST"
  sed -i '' 's/ITSAppUsesNonExemptEncryption: true/ITSAppUsesNonExemptEncryption: false/; /ITSEncryptionExportComplianceCode:/d' "$PROJECT_DIR/src-tauri/gen/apple/project.yml"
}

# The tree was clean when we started (checked above), so every tracked
# change at exit is this run's: versions, Cargo.lock, the encryption
# declaration, the entitlements flip, and anything `tauri ios build`
# rewrote (project.pbxproj). A dry run puts all of it back.
on_exit() {
  if [ -n "$NO_UPLOAD" ]; then
    local touched
    touched="$(git -C "$PROJECT_DIR" diff --name-only -- ':!src-tauri/icons' ':!src-tauri/gen/apple/Assets.xcassets')"
    if [ -n "$touched" ]; then
      echo "→ Dry run: restoring files this run changed:"
      echo "$touched" | sed 's/^/    /'
      echo "$touched" | (cd "$PROJECT_DIR" && xargs git checkout --)
    fi
  elif [ -n "${VOICE_CRYPTO:-}" ]; then
    restore_encryption_declaration
  fi
}
trap on_exit EXIT

echo ""
echo "═══════════════════════════════════════"
echo "  K2 iOS Release"
echo "  Version: $VERSION"
echo "  Build:   $BUILD_NUMBER"
[ -n "$NO_UPLOAD" ] && echo "  Mode:    dry run (--no-upload)"
[ -z "$NO_UPLOAD" ] && [ -n "${NO_PUSH:-}" ] && echo "  Git:     NO_PUSH=1 (commit$([ -z "${NO_TAG:-}" ] && echo ' and tag') locally; nothing pushed)"
[ -n "${VOICE_CRYPTO:-}" ] && echo "  Crypto:  VOICE_CRYPTO=1 (standard algorithms, mass market; not on the French store)"
echo "═══════════════════════════════════════"
echo ""

# ─── Step 1: Bump versions ───

echo "→ Bumping version to $VERSION (build $BUILD_NUMBER)..."

# package.json
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$PACKAGE_JSON"

# tauri.conf.json
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$TAURI_CONF"
# tauri.conf.json bundle.iOS.bundleVersion = the build number. `tauri ios
# build` rewrites the app Info.plist CFBundleVersion from this (default:
# the marketing version), so this is what actually reaches the binary.
node -e '
  const fs = require("fs");
  const [file, build] = process.argv.slice(1);
  const conf = JSON.parse(fs.readFileSync(file, "utf8"));
  conf.bundle = conf.bundle || {};
  conf.bundle.iOS = conf.bundle.iOS || {};
  conf.bundle.iOS.bundleVersion = build;
  fs.writeFileSync(file, JSON.stringify(conf, null, 2) + "\n");
' "$TAURI_CONF" "$BUILD_NUMBER"

# Info.plist — CFBundleShortVersionString
sed -i '' "/<key>CFBundleShortVersionString<\/key>/{ n; s/<string>[^<]*<\/string>/<string>$VERSION<\/string>/; }" "$INFO_PLIST"

# Info.plist — CFBundleVersion (build number)
sed -i '' "/<key>CFBundleVersion<\/key>/{ n; s/<string>[^<]*<\/string>/<string>$BUILD_NUMBER<\/string>/; }" "$INFO_PLIST"

# Extension Info.plists — same values as the app (VERSION + BUILD_NUMBER);
# App Store Connect rejects an extension whose versions differ.
for EXT_INFO_PLIST in "$NSE_INFO_PLIST" "$BROADCAST_INFO_PLIST"; do
  if [ -f "$EXT_INFO_PLIST" ]; then
    sed -i '' "/<key>CFBundleShortVersionString<\/key>/{ n; s/<string>[^<]*<\/string>/<string>$VERSION<\/string>/; }" "$EXT_INFO_PLIST"
    sed -i '' "/<key>CFBundleVersion<\/key>/{ n; s/<string>[^<]*<\/string>/<string>$BUILD_NUMBER<\/string>/; }" "$EXT_INFO_PLIST"
  fi
done

# Cargo.toml (package version) and the XcodeGen spec, which regenerates
# Info.plist during `tauri ios build` and so must agree with it.
CARGO_TOML="$PROJECT_DIR/src-tauri/Cargo.toml"
PROJECT_YML="$PROJECT_DIR/src-tauri/gen/apple/project.yml"
sed -i '' "1,/^version = /s/^version = \"[^\"]*\"/version = \"$VERSION\"/" "$CARGO_TOML"
# Cargo.lock's own entry too: --remote-build runs `cargo fetch --locked`,
# which refuses a lock whose root package version is stale.
sed -i '' "/^name = \"k2so-companion\"$/{n;s/^version = \"[^\"]*\"/version = \"$VERSION\"/;}" "$PROJECT_DIR/src-tauri/Cargo.lock"
# Every target (app, NSE, Broadcast) in one pass: same VERSION, same BUILD_NUMBER.
sed -i '' "s/CFBundleShortVersionString: .*/CFBundleShortVersionString: $VERSION/; s/CFBundleVersion: .*/CFBundleVersion: \"$BUILD_NUMBER\"/" "$PROJECT_YML"

echo "  ✓ package.json, tauri.conf.json, Info.plist (app, NSE, Broadcast), Cargo.toml, project.yml updated"

# ─── Step 2: Build ───

cd "$PROJECT_DIR"
# --remote-build: the node runs these (scripts/ios-remote-build.sh) and
# sends acknowledgements.txt back with the archive.
if [ -z "$REMOTE_BUILD" ]; then
  echo "→ Building frontend..."
  node scripts/gen-acknowledgements.mjs
  npm run build --silent
fi

# --remote-build: build the archive on a K2 compute Mac, unsigned, from
# this tree as it stands now (HEAD + the stamped files, sent with --dirty:
# nothing is committed or pushed), then put the archive where a local
# build leaves it, and the node's acknowledgements.txt in public/.
remote_build() {
  local node="${K2_IOS_BUILD_NODE:?--remote-build needs K2_IOS_BUILD_NODE}"
  local work job_json job rc
  work="$(mktemp -d "${TMPDIR:-/tmp}/k2-ios-remote.XXXXXX")"
  echo "→ Building the iOS archive on $node (k2 compute; this Mac only signs, exports and uploads)..."
  # 8G is the node's cap; --stall-timeout off: LTO's link prints nothing
  # for minutes. --cache ios-tools keeps the pinned xcodegen (the script
  # fetches it: not a --needs tool on Macs yet) between builds.
  job_json="$(k2 compute run "$node" --dirty --detach --json \
    --mem 8G --cpus 7 --needs node@22 --cache ios-tools --stall-timeout off \
    --tag "ios-build:${VERSION}-${BUILD_NUMBER}" \
    --artifact k2-ios-build.tgz --artifact k2-ios-build.log \
    ${VOICE_CRYPTO:+--env VOICE_CRYPTO=1} \
    -- bash scripts/ios-remote-build.sh)" || {
    echo "Error: k2 compute run refused the job:"; echo "$job_json"; return 1; }
  job="$(printf '%s' "$job_json" | plutil -extract job raw -o - - 2>/dev/null || true)"
  if [ -z "$job" ]; then
    echo "Error: no job id from k2 compute run:"; echo "$job_json"; return 1
  fi
  echo "  job $job (k2 compute logs $job · k2 compute get $job)"
  echo "$job" > "$work/job"
  # Streams the job's log here and exits with its exit code.
  set +e
  k2 compute wait "$job" --follow
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    echo "Error: the remote build failed (exit $rc). Full log: k2 compute fetch $job k2-ios-build.log"
    return 1
  fi
  echo "→ Fetching the archive from $node..."
  k2 compute fetch "$job" k2-ios-build.tgz --out "$work" >/dev/null \
    || k2 compute fetch "$job" k2-ios-build.tgz --out "$work" --over-relay >/dev/null \
    || { echo "Error: k2 compute fetch $job failed"; return 1; }
  [ -f "$work/k2-ios-build.tgz" ] || { echo "Error: no k2-ios-build.tgz from job $job"; return 1; }
  # Only the two expected entries, nothing outside them.
  if tar -tzf "$work/k2-ios-build.tgz" | grep -v -E '^(k2so-companion_iOS\.xcarchive(/.*)?|acknowledgements\.txt)$' | grep . >/dev/null; then
    echo "Error: unexpected paths in k2-ios-build.tgz"; return 1
  fi
  mkdir -p "$work/x" "$(dirname "$ARCHIVE_PATH")"
  tar -xzf "$work/k2-ios-build.tgz" -C "$work/x"
  mv "$work/x/k2so-companion_iOS.xcarchive" "$ARCHIVE_PATH"
  cp "$work/x/acknowledgements.txt" "$PROJECT_DIR/public/acknowledgements.txt"
  echo "$job" > "$ARCHIVE_PATH/../remote-build-job.txt"
  rm -rf "$work"
  echo "  ✓ Archive from $node (job $job)"
}

echo "→ Building iOS archive..."
# A failed build must not export the last run's archive.
rm -rf "$ARCHIVE_PATH"
# rustup's toolchain has the iOS targets; Homebrew's rust does not.
export PATH="$HOME/.cargo/bin:$PATH"
# Export compliance. Default: the iOS app uses only Apple's own encryption
# (Security.framework TLS, CryptoKit), so ITSAppUsesNonExemptEncryption is
# false. A bundled TLS stack (rustls / ring) would make that untrue:
# refuse the build (see src-tauri/Cargo.toml, tauri-plugin-http per platform).
#
# VOICE_CRYPTO=1 (the voice build): native end-to-end encrypted voice
# through Sew's tauri-plugin-sew-voice brings its own crypto: rustls/ring
# (TLS), DTLS-SRTP (media) and MLS (group keys), all standard (IETF)
# algorithms. The owner's answer (2026-11-05): the app uses encryption,
# standard algorithms only, mass market (5D992.c). So the build declares
# ITSAppUsesNonExemptEncryption true and the ring guard is skipped. The
# committed files keep false; the flip is per run, put back after the
# archive.
# With true and no ITSEncryptionExportComplianceCode, App Store Connect
# marks each build "Missing Compliance" until someone with the Account
# Holder, Admin or App Manager role answers (TestFlight > build > Manage):
#   uses encryption? yes; qualifies for a Category 5 Part 2 exemption?
#   (its list: medical, copyright, authentication only, banking,
#   compression; OS-only / HTTPS-only / US+Canada-only); proprietary
#   algorithms? no; standard algorithms beyond Apple's OS? yes; available
#   in France? Standard algorithms + France = upload the French (ANSSI)
#   encryption declaration; Apple reviews it and issues a code. Pass that
#   code as EXPORT_COMPLIANCE_CODE so later builds skip the questions.
#
# 2026-11-05: K2 is off the French store (the owner's call), and App Store Connect
# then needs no documentation: its API refuses an encryption declaration
# for standard algorithms outside France, and a build declaring true with
# no code fails validation (90592). So without EXPORT_COMPLIANCE_CODE the
# voice build keeps ITSAppUsesNonExemptEncryption false (no documentation
# required) and only skips the ring guard. Back on the French store, the
# ANSSI declaration's code goes in EXPORT_COMPLIANCE_CODE and the flag
# turns true.
if [ -n "${VOICE_CRYPTO:-}" ] && [ -z "${EXPORT_COMPLIANCE_CODE:-}" ]; then
  echo "→ Voice build (VOICE_CRYPTO=1): standard algorithms, not on the French store, no documentation required"
elif [ -n "${VOICE_CRYPTO:-}" ]; then
  echo "→ Declaring encryption (VOICE_CRYPTO=1): ITSAppUsesNonExemptEncryption true"
  sed -i '' '/<key>ITSAppUsesNonExemptEncryption<\/key>/{ n; s/<false\/>/<true\/>/; }' "$INFO_PLIST" "$IOS_PLIST"
  sed -i '' 's/ITSAppUsesNonExemptEncryption: false/ITSAppUsesNonExemptEncryption: true/' "$PROJECT_YML"
  if [ -n "${EXPORT_COMPLIANCE_CODE:-}" ]; then
    echo "  + ITSEncryptionExportComplianceCode $EXPORT_COMPLIANCE_CODE"
    export EXPORT_COMPLIANCE_CODE  # perl reads it from the environment
    perl -0pi -e 's|(<key>ITSAppUsesNonExemptEncryption</key>\n(\s*)<true/>\n)|$1$2<key>ITSEncryptionExportComplianceCode</key>\n$2<string>$ENV{EXPORT_COMPLIANCE_CODE}</string>\n|' "$INFO_PLIST" "$IOS_PLIST"
    perl -pi -e 's|^(\s*)ITSAppUsesNonExemptEncryption: true\n|$&$1ITSEncryptionExportComplianceCode: "$ENV{EXPORT_COMPLIANCE_CODE}"\n|' "$PROJECT_YML"
  fi
elif [ -z "$REMOTE_BUILD" ] && (cd "$PROJECT_DIR/src-tauri" && cargo tree -e normal --target aarch64-apple-ios -i ring 2>/dev/null | grep '^ring ' >/dev/null); then
  # (--remote-build: the node runs this guard.)
  echo "Error: the iOS build links ring/rustls. Keep tauri-plugin-http on native-tls for iOS (src-tauri/Cargo.toml)."
  echo "       The voice build opts in with VOICE_CRYPTO=1 (declares encryption; see above)."
  exit 1
fi
if [ -n "$REMOTE_BUILD" ]; then
  remote_build
else
  cargo tauri ios build 2>&1 | grep -E "Compiling|Finished|Exported|FAILED|error" || true
fi
if [ -n "${VOICE_CRYPTO:-}" ]; then
  restore_encryption_declaration
fi

# Check archive exists
if [ ! -d "$ARCHIVE_PATH" ]; then
  echo "Error: Archive not found at $ARCHIVE_PATH"
  exit 1
fi
echo "  ✓ Archive built"
# The weights must be in the app, unaltered (tauri.ios.conf.json bundles
# src-tauri/resources/dfn3/ as assets/dfn3/, the plugin's default place).
if ! "$SCRIPT_DIR/fetch-dfn3.sh" --verify "$ARCHIVE_PATH/Products/Applications/K2.app/assets/dfn3"; then
  echo "Error: the archived app lacks verified DeepFilterNet3 weights (assets/dfn3)."
  exit 1
fi
if [ -n "${VOICE_CRYPTO:-}" ] && [ -n "${EXPORT_COMPLIANCE_CODE:-}" ]; then
  # The flag must reach the binary: tauri merges Info.ios.plist on build.
  ARCHIVED_ITS="$(/usr/libexec/PlistBuddy -c 'Print :ITSAppUsesNonExemptEncryption' "$ARCHIVE_PATH/Products/Applications/K2.app/Info.plist" 2>/dev/null || true)"
  if [ "$ARCHIVED_ITS" != "true" ]; then
    echo "Error: VOICE_CRYPTO=1 but the archived Info.plist says ITSAppUsesNonExemptEncryption=${ARCHIVED_ITS:-missing}"
    exit 1
  fi
  echo "  ✓ Archive declares ITSAppUsesNonExemptEncryption true"
  if [ -n "${EXPORT_COMPLIANCE_CODE:-}" ]; then
    ARCHIVED_CODE="$(/usr/libexec/PlistBuddy -c 'Print :ITSEncryptionExportComplianceCode' "$ARCHIVE_PATH/Products/Applications/K2.app/Info.plist" 2>/dev/null || true)"
    if [ "$ARCHIVED_CODE" != "$EXPORT_COMPLIANCE_CODE" ]; then
      echo "Error: the archived Info.plist has no ITSEncryptionExportComplianceCode $EXPORT_COMPLIANCE_CODE"
      exit 1
    fi
  fi
fi

# Keep the dSYMs: the archive is deleted on the next run. uploadSymbols
# (below) sends symbols to Apple, which symbolicates TestFlight/App Store
# crash reports; Apple never hands dSYMs back, so this copy is what local
# symbolication (atos, Xcode Organizer via Spotlight) of a device or
# tester crash log needs.
mkdir -p "$KEEP_DIR"
ditto "$ARCHIVE_PATH/dSYMs" "$KEEP_DIR/dSYMs"
git -C "$PROJECT_DIR" rev-parse HEAD > "$KEEP_DIR/commit.txt"
echo "  ✓ dSYMs kept in $KEEP_DIR/dSYMs"

# ─── Step 3: Export for App Store ───

echo "→ Exporting for App Store..."

# Automatic "Team Store" cloud signing cannot add Push to the Xcode-managed
# profile (API key is not an Admin Apple ID). Use the ASC-created
# "K2 Companion App Store Push" profile + local Apple Distribution cert.
# The Notification Service Extension uses its own ASC-created profile,
# "K2 Companion NSE App Store" (App Group capability), and the Broadcast
# Upload Extension (screen share) its own, "K2 Companion Broadcast App
# Store" (App ID com.alakazamlabs.k2so.companion.Broadcast, App Group).
# The app profile must also carry the App Group + Communication
# Notifications capabilities. Only the APP entitlements hold
# aps-environment; the extensions' entitlements (App Group; the NSE also
# time-sensitive notifications, so its profiles need that capability) are
# not touched here.
ENTITLEMENTS="$PROJECT_DIR/src-tauri/gen/apple/k2so-companion_iOS/k2so-companion_iOS.entitlements"
if [ -f "$ENTITLEMENTS" ]; then
  sed -i '' '/<key>aps-environment<\/key>/{ n; s/<string>development<\/string>/<string>production<\/string>/; }' "$ENTITLEMENTS"
fi

# --remote-build: the archive came back unsigned, and exportArchive takes
# each bundle's entitlements from its existing signature (an unsigned one
# exports with only the profile's application-identifier and team: no push,
# no App Group). So sign it here first, ad hoc, with the same committed
# entitlements files Xcode signs a local archive with (extensions first,
# then the app); the export then re-signs with Apple Distribution and keeps
# them. Light: codesign only.
if [ -n "$REMOTE_BUILD" ]; then
  echo "→ Signing the remote archive ad hoc with the entitlements files..."
  ARCHIVED_APP="$ARCHIVE_PATH/Products/Applications/K2.app"
  APPLE_DIR="$PROJECT_DIR/src-tauri/gen/apple"
  for PAIR in \
    "PlugIns/K2NotificationService.appex|$APPLE_DIR/K2NotificationService/K2NotificationService.entitlements" \
    "PlugIns/K2Broadcast.appex|$APPLE_DIR/K2Broadcast/K2Broadcast.entitlements" \
    ".|$ENTITLEMENTS"; do
    BUNDLE="$ARCHIVED_APP/${PAIR%%|*}"
    codesign --force --sign - --timestamp=none --generate-entitlement-der \
      --entitlements "${PAIR#*|}" "$BUNDLE"
  done
  echo "  ✓ app, NSE and Broadcast carry their entitlements"
fi

cat > "$EXPORT_PLIST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>app-store-connect</string>
    <key>teamID</key>
    <string>${TEAM_ID}</string>
    <key>signingStyle</key>
    <string>manual</string>
    <key>signingCertificate</key>
    <string>Apple Distribution</string>
    <key>provisioningProfiles</key>
    <dict>
        <key>com.alakazamlabs.k2so.companion</key>
        <string>K2 Companion App Store Push</string>
        <key>com.alakazamlabs.k2so.companion.NotificationService</key>
        <string>K2 Companion NSE App Store</string>
        <key>com.alakazamlabs.k2so.companion.Broadcast</key>
        <string>K2 Companion Broadcast App Store</string>
    </dict>
    <key>uploadSymbols</key>
    <true/>
</dict>
</plist>
PLIST

rm -rf "$EXPORT_DIR"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportOptionsPlist "$EXPORT_PLIST" \
  -exportPath "$EXPORT_DIR" \
  2>&1 | tee /tmp/k2-export.log | tail -8
# Full export output (incl. signing/provisioning errors) is in /tmp/k2-export.log

IPA_PATH="$EXPORT_DIR/K2.ipa"
if [ ! -f "$IPA_PATH" ]; then
  echo "Error: IPA not found at $IPA_PATH"
  exit 1
fi
# xcodegen run while Externals/ holds a built libapp.a copies it in as a
# resource; Apple rejects the upload (90171).
if unzip -l "$IPA_PATH" | grep -E '\.a$' >/dev/null; then
  echo "Error: the IPA contains a static library (stray libapp.a resource in project.pbxproj?)"
  exit 1
fi
echo "  ✓ IPA exported"
# The signed entitlements, as the device and App Store Connect see them:
# every bundle signed by Apple Distribution with this build number, and
# each carries its capabilities. (An archive built unsigned, --remote-build,
# gets its signature only from the export; this is the check that it did.)
ENT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/k2-ipa-ents.XXXXXX")"
unzip -q "$IPA_PATH" -d "$ENT_DIR"
ent_of() { codesign -d --entitlements - --xml "$1" 2>/dev/null | plutil -convert json -o - - 2>/dev/null; }
ent_get() { printf '%s' "$1" | plutil -extract "$2" raw -o - - 2>/dev/null || true; }
ENT_FAIL=""
for BUNDLE in "K2.app" "K2.app/PlugIns/K2NotificationService.appex" "K2.app/PlugIns/K2Broadcast.appex"; do
  B="$ENT_DIR/Payload/$BUNDLE"
  SIGNER="$(codesign -dvv "$B" 2>&1 || true)"
  if ! printf '%s\n' "$SIGNER" | grep '^Authority=Apple Distribution: ' >/dev/null; then
    echo "  ✗ $BUNDLE is not signed by Apple Distribution"; ENT_FAIL=1
  fi
  if [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$B/Info.plist")" != "$BUILD_NUMBER" ]; then
    echo "  ✗ $BUNDLE CFBundleVersion is not $BUILD_NUMBER"; ENT_FAIL=1
  fi
  E="$(ent_of "$B")"
  [ "$(ent_get "$E" 'com\.apple\.security\.application-groups.0')" = "group.com.alakazamlabs.k2so.companion" ] \
    || { echo "  ✗ $BUNDLE lacks the App Group"; ENT_FAIL=1; }
  [ "$(ent_get "$E" get-task-allow)" = "false" ] || { echo "  ✗ $BUNDLE get-task-allow is not false"; ENT_FAIL=1; }
done
E="$(ent_of "$ENT_DIR/Payload/K2.app")"
[ "$(ent_get "$E" aps-environment)" = "production" ] || { echo "  ✗ K2.app aps-environment is not production"; ENT_FAIL=1; }
[ "$(ent_get "$E" 'com\.apple\.developer\.usernotifications\.communication')" = "true" ] \
  || { echo "  ✗ K2.app lacks Communication Notifications"; ENT_FAIL=1; }
[ "$(ent_get "$E" 'com\.apple\.developer\.usernotifications\.time-sensitive')" = "true" ] \
  || { echo "  ✗ K2.app lacks Time Sensitive notifications"; ENT_FAIL=1; }
[ "$(ent_get "$E" 'com\.apple\.developer\.associated-domains.0')" = "applinks:*.k2.dev" ] \
  || { echo "  ✗ K2.app lacks Associated Domains applinks:*.k2.dev"; ENT_FAIL=1; }
rm -rf "$ENT_DIR"
if [ -n "$ENT_FAIL" ]; then
  echo "Error: the exported IPA's signing or entitlements are wrong (above)."
  exit 1
fi
echo "  ✓ Signed (Apple Distribution, build $BUILD_NUMBER): aps production, App Group, communication + time-sensitive notifications, associated domains"
APP_ZIP_BYTES="$(stat -f %z "$IPA_PATH")"
APP_RAW_KB="$(unzip -Z -t "$IPA_PATH" | sed -E 's/^[0-9]+ files, ([0-9]+) bytes uncompressed.*/\1/' | awk '{ printf "%d", $1 / 1024 }')"
echo "  IPA (universal, before App Store thinning): $((APP_ZIP_BYTES / 1024)) KB zipped, ${APP_RAW_KB} KB unzipped"

# ─── Step 3b: Size report (--size-report) ───

# App Store exports cannot thin, so export the same archive once more as a
# development build thinned for every device. Apple's report gives each
# variant's compressed (≈ download) and uncompressed (≈ install) size.
if [ -n "$SIZE_REPORT" ]; then
  echo "→ Exporting a thinned build for the size report..."
  SIZE_DIR="$PROJECT_DIR/src-tauri/gen/apple/build/thinning"
  SIZE_PLIST="$PROJECT_DIR/src-tauri/gen/apple/build/ThinningExport.plist"
  cat > "$SIZE_PLIST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>debugging</string>
    <key>teamID</key>
    <string>${TEAM_ID}</string>
    <key>signingStyle</key>
    <string>manual</string>
    <key>signingCertificate</key>
    <string>Apple Development</string>
    <key>provisioningProfiles</key>
    <dict>
        <key>com.alakazamlabs.k2so.companion</key>
        <string>K2 Companion Dev</string>
        <key>com.alakazamlabs.k2so.companion.NotificationService</key>
        <string>K2 Companion NSE Dev</string>
        <key>com.alakazamlabs.k2so.companion.Broadcast</key>
        <string>K2 Companion Broadcast Dev</string>
    </dict>
    <key>thinning</key>
    <string>&lt;thin-for-all-variants&gt;</string>
</dict>
</plist>
PLIST
  rm -rf "$SIZE_DIR"
  xcodebuild -exportArchive \
    -archivePath "$ARCHIVE_PATH" \
    -exportOptionsPlist "$SIZE_PLIST" \
    -exportPath "$SIZE_DIR" \
    > /tmp/k2-thinning.log 2>&1 || true
  if [ -f "$SIZE_DIR/App Thinning Size Report.txt" ]; then
    cp "$SIZE_DIR/App Thinning Size Report.txt" "$KEEP_DIR/"
    echo "  ✓ Size report: $KEEP_DIR/App Thinning Size Report.txt"
    # One line per distinct size: count of variants, compressed, uncompressed.
    grep "^App size:" "$SIZE_DIR/App Thinning Size Report.txt" | sort | uniq -c | sed 's/^ */    /'
  else
    echo "  ! No size report (see /tmp/k2-thinning.log); the release goes on."
  fi
fi

if [ -n "$NO_UPLOAD" ]; then
  echo ""
  echo "═══════════════════════════════════════"
  echo "  ✓ Dry run done: K2 ${VERSION} build ${BUILD_NUMBER}"
  echo "  IPA:   $IPA_PATH"
  echo "  Kept:  $KEEP_DIR"
  echo "  Not validated, not uploaded, not committed."
  echo "═══════════════════════════════════════"
  echo ""
  exit 0
fi

# ─── Step 4: Upload to App Store Connect ───

echo "→ Validating with App Store Connect..."
xcrun altool --validate-app \
  --type ios \
  --file "$IPA_PATH" \
  --apiKey "$API_KEY" \
  --apiIssuer "$API_ISSUER" \
  2>&1 | tail -3

echo "→ Uploading to App Store Connect..."
xcrun altool --upload-app \
  --type ios \
  --file "$IPA_PATH" \
  --apiKey "$API_KEY" \
  --apiIssuer "$API_ISSUER" \
  2>&1 | tail -5

echo "  ✓ Uploaded to App Store Connect"

# ─── Step 5: Git commit, tag, push ───

echo "→ Committing and tagging..."
cd "$PROJECT_DIR"
git add public/acknowledgements.txt package.json src-tauri/tauri.conf.json src-tauri/gen/apple/k2so-companion_iOS/Info.plist \
  src-tauri/gen/apple/K2NotificationService/Info.plist \
  src-tauri/gen/apple/K2Broadcast/Info.plist \
  src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/gen/apple/project.yml
git commit -m "v${VERSION} — App Store ${VERSION}, release build ${BUILD_NUMBER}"
COMMIT_SHA="$(git rev-parse --short HEAD)"
LAND_BRANCH="${RELEASE_BRANCH:-main}"
# This worktree may be on an execute-plan branch; land on GitHub main,
# or on RELEASE_BRANCH for a hotfix build cut from an older release.
# NO_PUSH=1: nothing leaves this machine; the banner prints the commands.
if [ -z "${NO_PUSH:-}" ]; then
  git push origin "HEAD:refs/heads/${LAND_BRANCH}"
fi
# A replacement build under the same marketing version keeps the first
# build's tag (Android may already ship from it); tag the build instead.
# A test-track TestFlight build (RELEASE_BRANCH=<branch> NO_TAG=1) takes no
# tag: the version's tag belongs to the build that ships.
if [ -n "${NO_TAG:-}" ]; then
  TAG=""
elif git rev-parse -q --verify "refs/tags/v${VERSION}" >/dev/null; then
  TAG="v${VERSION}+${BUILD_NUMBER}"
else
  TAG="v${VERSION}"
fi
if [ -n "$TAG" ]; then
  git tag -a "$TAG" -m "$TAG (App Store ${VERSION}, build ${BUILD_NUMBER})"
  if [ -z "${NO_PUSH:-}" ]; then
    git push origin "$TAG"
  fi
fi

echo ""
echo "═══════════════════════════════════════"
echo "  ✓ K2 v${VERSION} uploaded (App Store ${VERSION})!"
echo ""
echo "  App Store Connect: ${VERSION} build ${BUILD_NUMBER}"
echo "  Commit:  ${COMMIT_SHA} (on $(git rev-parse --abbrev-ref HEAD) locally)"
if [ -n "${NO_PUSH:-}" ]; then
  echo "  Branch:  NOT pushed (NO_PUSH=1); it would land on origin/${LAND_BRANCH}"
  if [ -n "$TAG" ]; then
    echo "  Tag:     ${TAG} created locally, NOT pushed"
  else
    echo "  Tag:     none (NO_TAG=1)"
  fi
  echo ""
  echo "  Nothing was pushed. After review, push with:"
  echo "    git push origin ${COMMIT_SHA}:refs/heads/${LAND_BRANCH}"
  if [ -n "$TAG" ]; then echo "    git push origin ${TAG}"; fi
else
  echo "  Branch:  pushed to origin/${LAND_BRANCH}"
  if [ -n "$TAG" ]; then
    echo "  Tag:     ${TAG} pushed"
  else
    echo "  Tag:     none (NO_TAG=1)"
  fi
fi
echo "═══════════════════════════════════════"
echo ""
