#!/usr/bin/env bash
# Build the unsigned desktop app in this checkout (the current directory) and
# install it as /Applications/Paseo.app. Run by scripts/deploy/main.ts on the
# desktop builder.
#
#   1. build unsigned (bare build:desktop hangs on notarization; an ad-hoc
#      hardened build crashes at launch with a dyld Team ID mismatch)
#   2. copy the installed app to "Paseo (Orig).app" (fallback = previous build)
#   3. quit → rm -rf → cp -R → open. Never cp -R onto an existing bundle: it
#      merges files and mixes signatures.
set -euo pipefail

APP="/Applications/Paseo.app"
ORIG="/Applications/Paseo (Orig).app"

echo "building desktop app (unsigned)"
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm run build:desktop
built="$(find packages/desktop/release -maxdepth 2 -name 'Paseo.app' -type d | head -n 1)"
[[ -n "$built" ]] || { echo "build finished but no Paseo.app under packages/desktop/release" >&2; exit 1; }

if [[ -d "$APP" ]]; then
  rm -rf "$ORIG"
  cp -R "$APP" "$ORIG"
  echo "previous build saved as $ORIG"
fi

if pgrep -f "$APP/Contents/MacOS/" >/dev/null; then
  osascript -e 'tell application "Paseo" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do
    pgrep -f "$APP/Contents/MacOS/" >/dev/null || break
    sleep 0.5
  done
  pkill -f "$APP/Contents/MacOS/" >/dev/null 2>&1 || true
  sleep 1
fi
rm -rf "$APP"
cp -R "$built" "$APP"
open "$APP" || echo "warning: could not open $APP; open it manually"
echo "installed $APP"

# build:desktop cleans packages/*/dist, which deletes the daemon's web UI
# bundle; the daemon reads it per request, so putting it back is enough.
if [[ ! -f packages/server/dist/server/web-ui/index.html ]]; then
  pnpm run build:daemon-web-ui || echo "warning: daemon web UI rebuild failed"
fi
