#!/usr/bin/env bash
# Install or refresh this host's MacBook redeploy watch: runs
# scripts/macbook-redeploy-watch.mjs every 2 minutes, appending to
# $paseo_home/macbook-redeploy-watch.log.
#
# Usage:
#   scripts/install-macbook-redeploy-watch.sh [repo_dir] [paseo_home] [node_bin]
#
# Why a separate installer from install-stall-cron.sh: the stall check runs on
# EVERY host, so that script carries a crontab path and its macOS TCC wedge
# guards. This watch runs on exactly ONE host — the orchestrator that can ssh to
# the MacBook — and only where a systemd user manager exists, which is the
# scheduler this host already uses for paseo-stall-check.timer. Generalizing the
# other installer to cover both would drag its crontab hazards into a job that
# never needs them.
#
# Idempotent: rewriting the units and re-enabling never duplicates.
# Never fails a deploy: this is a convenience, not a critical path.
#
# Deploy opt-out is PASEO_SKIP_MACBOOK_WATCH=1 (deploy.sh's concern); this
# script installs whenever it is invoked.

set -euo pipefail

repo_dir="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
paseo_home="${2:-$HOME/.paseo}"
node_bin="${3:-}"

if [[ -z "$node_bin" ]]; then
  node_bin="$(command -v node || ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1)"
fi
if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
  echo "install-macbook-redeploy-watch: no node binary found (pass one as the third argument)" >&2
  exit 0
fi

log_file="$paseo_home/macbook-redeploy-watch.log"
max_bytes=5242880
# Rotation first, so the watch is the last command and its exit code is what the
# scheduler sees. POSIX wc/tail/mv only — same shape as install-stall-cron.sh.
rotate_cmd="[ \"\$(wc -c < $log_file 2>/dev/null || echo 0)\" -gt $max_bytes ] && tail -c $max_bytes $log_file > $log_file.tmp && mv $log_file.tmp $log_file"
run_cmd="$node_bin $repo_dir/scripts/macbook-redeploy-watch.mjs >> $log_file 2>&1"
schedule_cmd="$rotate_cmd; $run_cmd"

mkdir -p "$paseo_home"

warn() { echo "install-macbook-redeploy-watch: WARNING: $*" >&2; }

if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user show-environment >/dev/null 2>&1; then
  warn "no systemd user manager; skipping the MacBook redeploy watch (deploy continues)"
  exit 0
fi

unit_dir="$HOME/.config/systemd/user"
mkdir -p "$unit_dir"

# systemd parses ExecStart quoting itself; single quotes keep the embedded
# "$(...)" and ';' literal for bash -c.
cat >"$unit_dir/paseo-macbook-redeploy-watch.service" <<EOF
[Unit]
Description=Paseo MacBook redeploy watch (deploys to the MacBook when it returns with a stale checkout)

[Service]
Type=oneshot
Environment=HOME=%h
ExecStart=/bin/bash -c '$schedule_cmd'
EOF

cat >"$unit_dir/paseo-macbook-redeploy-watch.timer" <<'EOF'
[Unit]
Description=Paseo MacBook redeploy watch timer (every 2 minutes)

[Timer]
OnCalendar=*:0/2
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload || { warn "daemon-reload failed"; exit 0; }
systemctl --user enable paseo-macbook-redeploy-watch.timer >/dev/null 2>&1 \
  || { warn "enable failed"; exit 0; }
if systemctl --user is-active paseo-macbook-redeploy-watch.timer >/dev/null 2>&1; then
  systemctl --user restart paseo-macbook-redeploy-watch.timer || { warn "restart failed"; exit 0; }
else
  systemctl --user start paseo-macbook-redeploy-watch.timer || { warn "start failed"; exit 0; }
fi

echo "systemd timer paseo-macbook-redeploy-watch.timer (OnCalendar=*:0/2) -> $log_file"
