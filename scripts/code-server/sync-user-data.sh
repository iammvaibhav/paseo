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
    rsync -az --delete "$SRC/extensions/" "$host:~/.local/share/code-server/extensions/"
  fi
  ssh "$host" 'systemctl --user restart paseo-code-server.service'
done

echo "Done."
