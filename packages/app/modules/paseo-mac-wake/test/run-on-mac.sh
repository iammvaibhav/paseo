#!/usr/bin/env bash
# Tests the Wake Mac Swift core (ios/MacWake.swift) on macOS: protocol units, the full wake
# sequence against mock_lidwake.py (asleep until the magic packet), and optionally the real
# lidwake. Run on a Mac with Xcode:
#
#   bash packages/app/modules/paseo-mac-wake/test/run-on-mac.sh
#   LIVE_HOST=192.168.1.6 LIVE_TOKEN_FILE=~/.config/lidwake/token [LIVE_HOLD=1] bash …/run-on-mac.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'kill "${mock:-}" 2>/dev/null || true; rm -rf "$work"' EXIT

# Top-level test code must sit in main.swift.
cp "$here/MacWakeTests.swift" "$work/main.swift"
xcrun swiftc -target "$(uname -m)-apple-macos13" -O -o "$work/mac-wake-tests" \
  "$here/../ios/MacWake.swift" "$work/main.swift"

export MOCK_HTTP_PORT=47011 MOCK_UDP_PORT=47019
/usr/bin/python3 "$here/mock_lidwake.py" "$MOCK_HTTP_PORT" "$MOCK_UDP_PORT" ce:13:8b:1e:5b:10 tok \
  > "$work/mock.log" 2>&1 &
mock=$!
sleep 0.5
status=0
"$work/mac-wake-tests" || status=$?
echo "--- mock log"
cat "$work/mock.log"
exit "$status"
