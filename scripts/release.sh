#!/usr/bin/env bash
set -euo pipefail

# ─── K2 iOS Release Script ───
# Usage: ./scripts/release.sh <version>
# Example: ./scripts/release.sh 0.3.0
#
# What it does:
#   1. Bumps version in package.json, tauri.conf.json, Info.plist
#   2. Auto-increments build number (timestamp-based, always unique)
#   3. Builds frontend + iOS archive
#   4. Exports App Store IPA
#   5. Uploads to App Store Connect
#   6. Commits, tags, and pushes to GitHub

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
ARCHIVE_PATH="$PROJECT_DIR/src-tauri/gen/apple/build/k2so-companion_iOS.xcarchive"
EXPORT_DIR="$PROJECT_DIR/src-tauri/gen/apple/build/appstore"
EXPORT_PLIST="$PROJECT_DIR/src-tauri/gen/apple/build/AppStoreExport.plist"

# ─── Validate ───

if [ $# -lt 1 ]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 0.3.0"
  exit 1
fi

VERSION="$1"

# Validate version format
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Error: Version must be in format X.Y.Z (e.g., 0.3.0)"
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

# Info.plist — CFBundleShortVersionString
sed -i '' "/<key>CFBundleShortVersionString<\/key>/{ n; s/<string>[^<]*<\/string>/<string>$VERSION<\/string>/; }" "$INFO_PLIST"

# Info.plist — CFBundleVersion (build number)
sed -i '' "/<key>CFBundleVersion<\/key>/{ n; s/<string>[^<]*<\/string>/<string>$BUILD_NUMBER<\/string>/; }" "$INFO_PLIST"

echo "  ✓ package.json, tauri.conf.json, Info.plist updated"

# ─── Step 2: Build ───

echo "→ Building frontend..."
cd "$PROJECT_DIR"
npm run build --silent

echo "→ Building iOS archive..."
cargo tauri ios build 2>&1 | grep -E "Compiling|Finished|Exported|FAILED|error" || true

# Check archive exists
if [ ! -d "$ARCHIVE_PATH" ]; then
  echo "Error: Archive not found at $ARCHIVE_PATH"
  exit 1
fi
echo "  ✓ Archive built"

# ─── Step 3: Export for App Store ───

echo "→ Exporting for App Store..."

# Create export options plist
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
    <string>automatic</string>
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
  -allowProvisioningUpdates \
  -authenticationKeyPath "$API_KEY_PATH" \
  -authenticationKeyID "$API_KEY" \
  -authenticationKeyIssuerID "$API_ISSUER" \
  2>&1 | tail -3

IPA_PATH="$EXPORT_DIR/K2.ipa"
if [ ! -f "$IPA_PATH" ]; then
  echo "Error: IPA not found at $IPA_PATH"
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
git add package.json src-tauri/tauri.conf.json src-tauri/gen/apple/k2so-companion_iOS/Info.plist
git commit -m "v${VERSION} — release build ${BUILD_NUMBER}"
git tag -a "v${VERSION}" -m "v${VERSION}"
git push
git push origin "v${VERSION}"

echo ""
echo "═══════════════════════════════════════"
echo "  ✓ K2 v${VERSION} released!"
echo ""
echo "  App Store Connect: build ${BUILD_NUMBER}"
echo "  GitHub: v${VERSION} tag pushed"
echo "═══════════════════════════════════════"
echo ""
