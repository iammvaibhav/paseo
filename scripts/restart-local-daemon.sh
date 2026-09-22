#!/usr/bin/env bash
# Reliable local host-daemon restart for agents / humans.
#
# Why this exists:
# - `daemon restart` = stop then start. If the caller dies between stop and start
#   (agent under the daemon, or a cancelled tool process group), the host stays down.
# - macOS has no `setsid`. Plain `nohup … &` stays in the tool's process group and
#   still dies on SIGTERM to that group.
# - Health alone is not enough: an old daemon can still answer /api/health while
#   a broken restart is in flight.
#
# This script:
# 1. Uses the built CLI (~/.local/bin/paseo or packages/cli/dist), never npx tsx.
# 2. Launches restart in a NEW session (python start_new_session=True).
# 3. Requires a NEW pid + /api/health.
# 4. On failure, detached `daemon start` recovery.
#
# Usage (from repo root, after build:server):
#   ./scripts/restart-local-daemon.sh
#   PASEO_LOCAL_HOME=~/.paseo ./scripts/restart-local-daemon.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="${PASEO_LOCAL_HOME:-$HOME/.paseo}"
LOGF="${PASEO_DAEMON_RESTART_LOG:-/tmp/paseo-daemon-restart-local.log}"

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

daemon_path_env() {
  printf '%s' "${HOME}/.local/bin:${PATH}"
}

read_daemon_pid() {
  local pid_file="$1/paseo.pid"
  [[ -f "$pid_file" ]] || return 1
  node -e '
try {
  const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (typeof p.pid === "number" && p.pid > 0) process.stdout.write(String(p.pid));
} catch {}
' "$pid_file" 2>/dev/null
}

daemon_health_ok() {
  local home="$1"
  local listen="127.0.0.1:6767" port primary secondary
  if [[ -f "$home/config.json" ]]; then
    listen="$(
      node -e '
try {
  const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const l = c && c.daemon && c.daemon.listen;
  if (typeof l === "string" && l.trim()) process.stdout.write(l.trim());
} catch {}
' "$home/config.json" 2>/dev/null || true
    )"
    [[ -z "$listen" ]] && listen="127.0.0.1:6767"
  fi
  port="${listen##*:}"
  case "$listen" in
    0.0.0.0:* | \[::\]:*) primary="http://127.0.0.1:${port}/api/health" ;;
    *) primary="http://${listen}/api/health" ;;
  esac
  secondary="http://127.0.0.1:${port}/api/health"
  curl -fsS --max-time 2 "$primary" >/dev/null 2>&1 \
    || curl -fsS --max-time 2 "$secondary" >/dev/null 2>&1
}

cli_cmd() {
  if [[ -x "${HOME}/.local/bin/paseo" ]]; then
    printf '%s' "${HOME}/.local/bin/paseo"
    return
  fi
  if [[ -f "$ROOT_DIR/packages/cli/dist/index.js" ]]; then
    printf 'node %s' "$(printf %q "$ROOT_DIR/packages/cli/dist/index.js")"
    return
  fi
  die "No built CLI. Run: npm run build:server && install wrapper, or use deploy.sh"
}

require_dist() {
  [[ -f "$ROOT_DIR/packages/cli/dist/index.js" ]] \
    || die "packages/cli/dist missing — run npm run build:server first"
  [[ -f "$ROOT_DIR/packages/highlight/dist/index.js" ]] \
    || die "packages/highlight/dist missing — run npm run build:server first"
  [[ -f "$ROOT_DIR/packages/server/dist/scripts/supervisor-entrypoint.js" ]] \
    || die "packages/server dist incomplete — run npm run build:server first"
}

launch_detached() {
  local script="$1"
  python3 - "$LOGF" "$script" <<'PY'
import os, sys, subprocess
logf, script = sys.argv[1], sys.argv[2]
log = open(logf, "ab", buffering=0)
subprocess.Popen(
    ["bash", "-c", script],
    stdin=subprocess.DEVNULL,
    stdout=log,
    stderr=subprocess.STDOUT,
    start_new_session=True,
    close_fds=True,
    env=os.environ.copy(),
)
PY
}

wait_new() {
  local old_pid="${1:-}"
  local timeout_s="${2:-90}"
  local i new_pid
  for ((i = 1; i <= timeout_s; i++)); do
    new_pid="$(read_daemon_pid "$HOME_DIR" || true)"
    if [[ -n "$new_pid" && "$new_pid" != "${old_pid:-}" ]] && daemon_health_ok "$HOME_DIR"; then
      log "healthy after ${i}s (pid ${old_pid:-none} -> $new_pid)"
      return 0
    fi
    sleep 1
  done
  return 1
}

require_dist
CLI="$(cli_cmd)"
PATH_ENV="$(daemon_path_env)"
OLD_PID="$(read_daemon_pid "$HOME_DIR" || true)"
: >"$LOGF"
log "Restarting local daemon home=$HOME_DIR old_pid=${OLD_PID:-none} cli=$CLI log=$LOGF"

RESTART_SCRIPT="$(
  cat <<EOF
set -euo pipefail
cd $(printf %q "$ROOT_DIR")
export PATH=$(printf %q "$PATH_ENV")
export NVM_DIR="\${NVM_DIR:-\$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
exec $CLI daemon restart --home $(printf %q "$HOME_DIR")
EOF
)"

launch_detached "$RESTART_SCRIPT"

if wait_new "$OLD_PID" 90; then
  log "restart complete"
  cat "$HOME_DIR/paseo.pid"
  exit 0
fi

log "restart did not yield new healthy pid; detached start recovery"
{
  echo "---- recovery start $(date -u +%Y-%m-%dT%H:%M:%SZ) ----"
} >>"$LOGF"

START_SCRIPT="$(
  cat <<EOF
set -euo pipefail
cd $(printf %q "$ROOT_DIR")
export PATH=$(printf %q "$PATH_ENV")
export NVM_DIR="\${NVM_DIR:-\$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
exec $CLI daemon start --home $(printf %q "$HOME_DIR")
EOF
)"

launch_detached "$START_SCRIPT"

if wait_new "" 60; then
  log "recovered via start"
  cat "$HOME_DIR/paseo.pid"
  exit 0
fi

log "FAILED — log:"
tail -n 80 "$LOGF" || true
die "daemon not healthy. Recover: PATH=\"\$HOME/.local/bin:\$PATH\" paseo daemon start --home $HOME_DIR"
