#!/usr/bin/env bash
# Build x-search and install it on prod as the systemd user unit `x-search`.
# Run by hand from the linux-arm64 dev host. Idempotent: swaps the binary
# (previous kept as x-search.prev), installs the unit, restarts, checks /healthz.
# Prerequisite on prod: ~/.config/x-search/env (see README.md).
set -euo pipefail

PROD_HOST="${PASEO_PROD_HOST:-prod}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH=(ssh -o BatchMode=yes)

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "aarch64" ]]; then
  echo "x-search: build on a linux-arm64 host (prod is aarch64)" >&2
  exit 1
fi

export PATH="$HOME/.bun/bin:$PATH"
(cd "$DIR" && bun install --frozen-lockfile && bun run typecheck && bun run build)

"${SSH[@]}" "$PROD_HOST" 'test -s ~/.config/x-search/env' ||
  { echo "x-search: $PROD_HOST:~/.config/x-search/env is missing; see README.md" >&2; exit 1; }

scp -o BatchMode=yes "$DIR/dist/x-search" "$PROD_HOST:.local/bin/x-search.new"
scp -o BatchMode=yes "$DIR/deploy/x-search.service" "$PROD_HOST:.config/systemd/user/x-search.service.new"

"${SSH[@]}" "$PROD_HOST" bash -s <<'REMOTE'
set -euo pipefail
cd ~/.config/systemd/user
if ! cmp -s x-search.service.new x-search.service 2>/dev/null; then
  mv -f x-search.service.new x-search.service
  systemctl --user daemon-reload
else
  rm -f x-search.service.new
fi
cd ~/.local/bin
[[ -f x-search ]] && cp -f x-search x-search.prev
chmod +x x-search.new
mv -f x-search.new x-search
systemctl --user enable x-search >/dev/null 2>&1
systemctl --user restart x-search
bind="$(sed -n 's/^X_SEARCH_BIND=//p' ~/.config/x-search/env)"
bind="${bind:-127.0.0.1:8792}"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://$bind/healthz"; then
    echo
    echo "x-search: healthy on http://$bind/mcp"
    exit 0
  fi
  sleep 1
done
systemctl --user status x-search --no-pager || true
journalctl --user -u x-search -n 30 --no-pager || true
exit 1
REMOTE
