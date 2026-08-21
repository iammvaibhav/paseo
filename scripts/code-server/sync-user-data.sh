#!/usr/bin/env bash
# Push local code-server User/ + extensions/ to blrofc3 and iammvaibhav.
set -euo pipefail

SRC="${CODE_SERVER_DATA:-$HOME/.local/share/code-server}"
HOSTS=(blrofc3 iammvaibhav)

if [[ ! -d "$SRC/User" ]]; then
  echo "No code-server user data at $SRC/User" >&2
  exit 1
fi

for host in "${HOSTS[@]}"; do
  echo "==> $host"
  ssh "$host" 'mkdir -p ~/.local/share/code-server'
  rsync -az --delete "$SRC/User/" "$host:~/.local/share/code-server/User/"
  if [[ -d "$SRC/extensions" ]]; then
    # python-env-tools/pet is a NATIVE binary, backfilled per host by
    # scripts/code-server/install.sh because Open VSX only publishes
    # ms-python.python as `universal` (no pet). Never push this Mac's Mach-O
    # copy to a Linux host, and — since excluded paths are also protected from
    # --delete — never wipe the host's correct one either.
    rsync -az --delete --exclude 'ms-python.python-*/python-env-tools/' \
      "$SRC/extensions/" "$host:~/.local/share/code-server/extensions/"
  fi
  ssh "$host" 'systemctl --user restart paseo-code-server.service'
done

echo "Done."
