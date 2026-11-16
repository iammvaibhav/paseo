#!/usr/bin/env bash
# Build the unsigned iOS app in this checkout (the current directory) and
# publish it to https://ios.thevm.space, where Vaibhav installs it with
# AltStore (which signs it with his free Apple ID). Run by
# scripts/deploy/main.ts on the desktop builder (MacBook).
#
# Env: SOURCE  branch + commit, shown on the page
#
# Needs Xcode with its iOS platform component, CocoaPods (brew), and the
# ios-apps skill from Flotilla (~/.agents/skills/ios-apps). Outputs stay in
# ~/paseo-ios-build: Paseo.ipa (latest), Paseo-previous.ipa, Paseo.xcarchive,
# pod-install.log, build.log.
set -euo pipefail

export PATH="/opt/homebrew/bin:$PATH" LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
OUT="$HOME/paseo-ios-build"
PUBLISH="$HOME/.agents/skills/ios-apps/scripts/publish-ipa"

[[ -f "$PUBLISH" ]] || { echo "missing $PUBLISH: apply Flotilla's skills bundle (ios-apps) to this host" >&2; exit 1; }
command -v pod >/dev/null || { echo "CocoaPods missing: brew install cocoapods" >&2; exit 1; }
mkdir -p "$OUT"
cd packages/app

# --clean: the generated ios/ project must follow app.config.js and native
# dependency changes; a stale one builds the wrong native modules.
echo "expo prebuild (ios, clean)"
APP_VARIANT=production CI=1 EXPO_NO_TELEMETRY=1 node_modules/.bin/expo prebuild --platform ios --clean --no-install
echo "export NODE_BINARY=$(command -v node)" > ios/.xcode.env.local

echo "pod install (log: $OUT/pod-install.log)"
if ! (cd ios && pod install) > "$OUT/pod-install.log" 2>&1; then
  tail -n 40 "$OUT/pod-install.log" >&2
  exit 1
fi

# Unsigned on purpose: AltStore re-signs on install.
echo "xcodebuild archive, unsigned Release (log: $OUT/build.log)"
archive="$OUT/Paseo-new.xcarchive"
rm -rf "$archive"
if ! xcodebuild -workspace ios/Paseo.xcworkspace -scheme Paseo -configuration Release \
  -sdk iphoneos -destination generic/platform=iOS -archivePath "$archive" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" archive \
  > "$OUT/build.log" 2>&1; then
  if grep -q "is not installed. Please download and install the platform" "$OUT/build.log"; then
    echo "Xcode's iOS platform is missing; run on the MacBook: xcodebuild -downloadPlatform iOS" >&2
  fi
  grep -E "error:|ARCHIVE FAILED" "$OUT/build.log" | head -n 20 >&2 || tail -n 40 "$OUT/build.log" >&2
  exit 1
fi

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir "$stage/Payload"
ditto "$archive/Products/Applications/Paseo.app" "$stage/Payload/Paseo.app"
(cd "$stage" && ditto -c -k --sequesterRsrc --keepParent Payload Paseo.ipa)
[[ -f "$OUT/Paseo.ipa" ]] && mv "$OUT/Paseo.ipa" "$OUT/Paseo-previous.ipa"
mv "$stage/Paseo.ipa" "$OUT/Paseo.ipa"
rm -rf "$OUT/Paseo.xcarchive"
mv "$archive" "$OUT/Paseo.xcarchive"
echo "built $OUT/Paseo.ipa ($(du -h "$OUT/Paseo.ipa" | cut -f1))"

bash "$PUBLISH" "$OUT/Paseo.ipa" --slug paseo --icon "$PWD/assets/images/icon.png" --source "$SOURCE"
