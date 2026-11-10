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
#   3. Builds frontend + iOS archive
#   4. Exports App Store IPA
#   5. Uploads to App Store Connect
#   6. Commits, tags, and pushes HEAD to origin/main + the tag
#
# --no-upload: dry run. Steps 1-4 up to the exported IPA, then stops: no
#   App Store Connect call at all (no validate, no upload), no commit, and
#   every file the run changed is put back (git checkout) on exit.
# --size-report: also export a thinned development build and keep Apple's
#   "App Thinning Size Report.txt" (download + install size per device).
# VOICE_CRYPTO=1: the voice build. See "Export compliance" in Step 2.
#   EXPORT_COMPLIANCE_CODE=<code> adds the code App Store Connect issues
#   once encryption documentation is approved (see there).
# Each archive's dSYMs are kept in ~/k2-builds/<version>-<build>/
# (K2_BUILDS_DIR overrides); the archive itself is replaced every run.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

NO_UPLOAD=""
SIZE_REPORT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-upload) NO_UPLOAD=1; shift ;;
    --size-report) SIZE_REPORT=1; shift ;;
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
  echo "Usage: $0 [--no-upload] [--size-report] <version>"
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
# Every target (app, NSE, Broadcast) in one pass: same VERSION, same BUILD_NUMBER.
sed -i '' "s/CFBundleShortVersionString: .*/CFBundleShortVersionString: $VERSION/; s/CFBundleVersion: .*/CFBundleVersion: \"$BUILD_NUMBER\"/" "$PROJECT_YML"

echo "  ✓ package.json, tauri.conf.json, Info.plist (app, NSE, Broadcast), Cargo.toml, project.yml updated"

# ─── Step 2: Build ───

echo "→ Building frontend..."
cd "$PROJECT_DIR"
node scripts/gen-acknowledgements.mjs
npm run build --silent

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
# algorithms. Rosson's answer (2026-11-05): the app uses encryption,
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
# 2026-11-05: K2 is off the French store (Rosson), and App Store Connect
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
elif (cd "$PROJECT_DIR/src-tauri" && cargo tree -e normal --target aarch64-apple-ios -i ring 2>/dev/null | grep -q '^ring '); then
  echo "Error: the iOS build links ring/rustls. Keep tauri-plugin-http on native-tls for iOS (src-tauri/Cargo.toml)."
  echo "       The voice build opts in with VOICE_CRYPTO=1 (declares encryption; see above)."
  exit 1
fi
cargo tauri ios build 2>&1 | grep -E "Compiling|Finished|Exported|FAILED|error" || true
if [ -n "${VOICE_CRYPTO:-}" ]; then
  restore_encryption_declaration
fi

# Check archive exists
if [ ! -d "$ARCHIVE_PATH" ]; then
  echo "Error: Archive not found at $ARCHIVE_PATH"
  exit 1
fi
echo "  ✓ Archive built"
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
# aps-environment; the extensions' entitlements (App Group only) are not
# touched here.
ENTITLEMENTS="$PROJECT_DIR/src-tauri/gen/apple/k2so-companion_iOS/k2so-companion_iOS.entitlements"
if [ -f "$ENTITLEMENTS" ]; then
  sed -i '' '/<key>aps-environment<\/key>/{ n; s/<string>development<\/string>/<string>production<\/string>/; }' "$ENTITLEMENTS"
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
if unzip -l "$IPA_PATH" | grep -qE '\.a$'; then
  echo "Error: the IPA contains a static library (stray libapp.a resource in project.pbxproj?)"
  exit 1
fi
echo "  ✓ IPA exported"
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
# This worktree may be on an execute-plan branch; land on GitHub main,
# or on RELEASE_BRANCH for a hotfix build cut from an older release.
git push origin "HEAD:refs/heads/${RELEASE_BRANCH:-main}"
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
  git push origin "$TAG"
fi

echo ""
echo "═══════════════════════════════════════"
echo "  ✓ K2 v${VERSION} released (App Store ${VERSION})!"
echo ""
echo "  App Store Connect: ${VERSION} build ${BUILD_NUMBER}"
echo "  GitHub: ${TAG} tag pushed, main updated"
echo "═══════════════════════════════════════"
echo ""
