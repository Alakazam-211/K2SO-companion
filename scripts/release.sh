#!/usr/bin/env bash
set -euo pipefail

# ─── K2 iOS Release Script ───
# Usage: ./scripts/release.sh <version>
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

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# App Store Connect API credentials (set via environment or .env.local)
if [ -f "$PROJECT_DIR/.env.local" ]; then
  source "$PROJECT_DIR/.env.local"
fi
API_KEY="${ASC_API_KEY:?Set ASC_API_KEY (App Store Connect API Key ID)}"
API_ISSUER="${ASC_API_ISSUER:?Set ASC_API_ISSUER (App Store Connect Issuer ID)}"
TEAM_ID="${ASC_TEAM_ID:?Set ASC_TEAM_ID (Apple Developer Team ID)}"
API_KEY_PATH="$HOME/private_keys/AuthKey_${API_KEY}.p8"

# Files that contain version numbers
TAURI_CONF="$PROJECT_DIR/src-tauri/tauri.conf.json"
PACKAGE_JSON="$PROJECT_DIR/package.json"
INFO_PLIST="$PROJECT_DIR/src-tauri/gen/apple/k2so-companion_iOS/Info.plist"
# Notification Service Extension (Communication Notifications). Its
# versions must equal the app's or App Store Connect flags the upload.
NSE_INFO_PLIST="$PROJECT_DIR/src-tauri/gen/apple/K2NotificationService/Info.plist"
ARCHIVE_PATH="$PROJECT_DIR/src-tauri/gen/apple/build/k2so-companion_iOS.xcarchive"
EXPORT_DIR="$PROJECT_DIR/src-tauri/gen/apple/build/appstore"
EXPORT_PLIST="$PROJECT_DIR/src-tauri/gen/apple/build/AppStoreExport.plist"

# ─── Validate ───

if [ $# -ne 1 ]; then
  echo "Usage: $0 <version>"
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
if [ ! -f "$API_KEY_PATH" ]; then
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

echo ""
echo "═══════════════════════════════════════"
echo "  K2 iOS Release"
echo "  Version: $VERSION"
echo "  Build:   $BUILD_NUMBER"
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

# Extension Info.plist — same values as the app (VERSION + BUILD_NUMBER);
# App Store Connect rejects an extension whose versions differ.
if [ -f "$NSE_INFO_PLIST" ]; then
  sed -i '' "/<key>CFBundleShortVersionString<\/key>/{ n; s/<string>[^<]*<\/string>/<string>$VERSION<\/string>/; }" "$NSE_INFO_PLIST"
  sed -i '' "/<key>CFBundleVersion<\/key>/{ n; s/<string>[^<]*<\/string>/<string>$BUILD_NUMBER<\/string>/; }" "$NSE_INFO_PLIST"
fi

# Cargo.toml (package version) and the XcodeGen spec, which regenerates
# Info.plist during `tauri ios build` and so must agree with it.
CARGO_TOML="$PROJECT_DIR/src-tauri/Cargo.toml"
PROJECT_YML="$PROJECT_DIR/src-tauri/gen/apple/project.yml"
sed -i '' "1,/^version = /s/^version = \"[^\"]*\"/version = \"$VERSION\"/" "$CARGO_TOML"
# Both targets (app + NSE) in one pass: same VERSION, same BUILD_NUMBER.
sed -i '' "s/CFBundleShortVersionString: .*/CFBundleShortVersionString: $VERSION/; s/CFBundleVersion: .*/CFBundleVersion: \"$BUILD_NUMBER\"/" "$PROJECT_YML"

echo "  ✓ package.json, tauri.conf.json, Info.plist (app + NSE), Cargo.toml, project.yml updated"

# ─── Step 2: Build ───

echo "→ Building frontend..."
cd "$PROJECT_DIR"
npm run build --silent

echo "→ Building iOS archive..."
# A failed build must not export the last run's archive.
rm -rf "$ARCHIVE_PATH"
# rustup's toolchain has the iOS targets; Homebrew's rust does not.
export PATH="$HOME/.cargo/bin:$PATH"
cargo tauri ios build 2>&1 | grep -E "Compiling|Finished|Exported|FAILED|error" || true

# Check archive exists
if [ ! -d "$ARCHIVE_PATH" ]; then
  echo "Error: Archive not found at $ARCHIVE_PATH"
  exit 1
fi
echo "  ✓ Archive built"

# ─── Step 3: Export for App Store ───

echo "→ Exporting for App Store..."

# Automatic "Team Store" cloud signing cannot add Push to the Xcode-managed
# profile (API key is not an Admin Apple ID). Use the ASC-created
# "K2 Companion App Store Push" profile + local Apple Distribution cert.
# The Notification Service Extension uses its own ASC-created profile,
# "K2 Companion NSE App Store" (App Group capability). The app profile
# must also carry the App Group + Communication Notifications
# capabilities. Only the APP entitlements hold aps-environment; the
# extension's entitlements (App Group only) are not touched here.
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
git add package.json src-tauri/tauri.conf.json src-tauri/gen/apple/k2so-companion_iOS/Info.plist \
  src-tauri/gen/apple/K2NotificationService/Info.plist \
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
