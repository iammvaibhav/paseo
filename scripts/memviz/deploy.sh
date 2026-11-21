#!/usr/bin/env bash
# Deploy memviz (read-only fleet-memory viewer) to blrofc3 as the `memviz` systemd
# --user unit, serving https://memory.thevm.space through prod's Caddy.
# Never touches the fleet-memory service, its database or its vault.
#
#   scripts/memviz/deploy.sh            # from any Paseo checkout
#   MEMVIZ_HOST=blrofc3 scripts/memviz/deploy.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
host="${MEMVIZ_HOST:-blrofc3}"
url="http://100.123.36.124:8896"

ssh "$host" 'mkdir -p ~/memviz ~/.config/systemd/user'
scp -q "$here/server.py" "$here/index.html" "$here/pyproject.toml" "$here/uv.lock" "$host:memviz/"
# The architecture page is docs/fleet-memory.md, served as-is.
scp -q "$repo/docs/fleet-memory.md" "$host:memviz/architecture.md"
scp -q "$here/memviz.service" "$host:.config/systemd/user/memviz.service"

ssh "$host" bash -s <<'REMOTE'
set -euo pipefail
cd ~/memviz
~/.local/bin/uv sync --frozen --quiet
systemctl --user daemon-reload
systemctl --user enable --quiet memviz.service
systemctl --user restart memviz.service
REMOTE

for _ in $(seq 1 30); do
  if ssh "$host" "curl -fsS -o /dev/null $url/api/facets"; then
    echo "memviz is up on $host ($url); public name https://memory.thevm.space (NetBird only)"
    exit 0
  fi
  sleep 1
done
echo "memviz did not answer on $url; see: ssh $host journalctl --user -u memviz -n 50" >&2
exit 1
