#!/usr/bin/env bash
# Trial of instant project switching in VS Code Web.
#
# Today the app re-roots the one code-server window per host with a new
# `?folder=`, which reloads the workbench and starts a new extension host and
# language servers for every workspace switch. This trial opens one multi-root
# `.code-workspace` window instead: folder 0 is a fixed, empty root and the
# project is folder 1, swapped in place by the paseo-bridge `/switch` route
# (no reload, same extension host). See docs/code-server.md.
#
# It runs a separate code-server (own port, user data, extensions and bridge
# broker port) as a transient user unit. The live code-server is not touched.
#
# Usage:
#   scripts/code-server/multiroot-trial.sh up [project-dir]   start, print the URL
#   scripts/code-server/multiroot-trial.sh switch <dir>       switch the window's project
#   scripts/code-server/multiroot-trial.sh status             unit state + window folders
#   scripts/code-server/multiroot-trial.sh down               stop the trial instance
#
# Env: PASEO_VSCODE_TRIAL_HOME (~/.paseo/vscode-trial), PASEO_VSCODE_TRIAL_PORT
# (8775), PASEO_VSCODE_TRIAL_BROKER_PORT (8776), PASEO_VSCODE_TRIAL_HOST (the
# live code-server's bind host, else 127.0.0.1).
set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="${HOME}/.local/bin/code-server"
LIVE_DATA="${HOME}/.local/share/code-server"
TRIAL_HOME="${PASEO_VSCODE_TRIAL_HOME:-${HOME}/.paseo/vscode-trial}"
PORT="${PASEO_VSCODE_TRIAL_PORT:-8775}"
BROKER_PORT="${PASEO_VSCODE_TRIAL_BROKER_PORT:-8776}"
UNIT="paseo-vscode-trial"
WORKSPACE_FILE="${TRIAL_HOME}/paseo.code-workspace"
ROOT_DIR="${TRIAL_HOME}/root"

live_bind_host() {
  local config="${HOME}/.config/code-server/config.yaml"
  if [[ -f "$config" ]]; then
    sed -n 's/^bind-addr: *\([^:]*\):.*/\1/p' "$config" | head -n 1
  fi
}
HOST="${PASEO_VSCODE_TRIAL_HOST:-$(live_bind_host)}"
HOST="${HOST:-127.0.0.1}"

log() { printf '[vscode-trial] %s\n' "$*"; }
die() { log "$*" >&2; exit 1; }

install_bridge() {
  local build_dir vsix
  build_dir="$(mktemp -d)"
  cp -R "${SCRIPTS_DIR}/paseo-bridge/." "$build_dir/"
  # A fresh version every time: code-server refuses to reinstall a loaded one.
  sed 's/"version": *"[^"]*"/"version": "0.1.'"$(date +%s)"'"/' \
    "${SCRIPTS_DIR}/paseo-bridge/package.json" >"$build_dir/package.json"
  vsix="${build_dir}/paseo-bridge.vsix"
  (cd "$build_dir" && npx --yes @vscode/vsce package --skip-license --no-dependencies \
    --allow-missing-repository --out "$vsix" >/dev/null 2>&1) || die "vsce packaging failed"
  "$BIN" --user-data-dir "${TRIAL_HOME}/user-data" --extensions-dir "${TRIAL_HOME}/extensions" \
    --install-extension "$vsix" --force >/dev/null
  rm -rf "$build_dir"
}

seed_user_data() {
  mkdir -p "${TRIAL_HOME}/user-data/User" "${TRIAL_HOME}/extensions" "$ROOT_DIR"
  for file in settings.json keybindings.json; do
    if [[ -f "${LIVE_DATA}/User/${file}" && ! -f "${TRIAL_HOME}/user-data/User/${file}" ]]; then
      cp "${LIVE_DATA}/User/${file}" "${TRIAL_HOME}/user-data/User/${file}"
    fi
  done
  # Same language extensions as the live instance, minus its bridge.
  if [[ -d "${LIVE_DATA}/extensions" && ! -f "${TRIAL_HOME}/extensions/.seeded" ]]; then
    find "${LIVE_DATA}/extensions" -mindepth 1 -maxdepth 1 -type d ! -name 'paseo.paseo-bridge-*' \
      -exec cp -R {} "${TRIAL_HOME}/extensions/" \;
    touch "${TRIAL_HOME}/extensions/.seeded"
  fi
  cat >"${ROOT_DIR}/README.md" <<'EOF'
Fixed first folder of the Paseo VS Code trial window. It stays put so that
switching the project (the second folder) never restarts the extension host.
EOF
}

write_workspace_file() {
  local project="$1"
  # Only on first start: after that the bridge owns the folder list.
  if [[ -f "$WORKSPACE_FILE" ]]; then
    return
  fi
  cat >"$WORKSPACE_FILE" <<EOF
{
  "folders": [
    { "path": "${ROOT_DIR}", "name": "paseo" },
    { "path": "${project}" }
  ],
  "settings": {}
}
EOF
}

cmd_up() {
  local project
  project="$(cd "${1:-$PWD}" && pwd)" || die "no such project dir: ${1:-}"
  [[ -x "$BIN" ]] || die "code-server not found at $BIN"
  if systemctl --user is-active --quiet "$UNIT"; then
    log "already running"
  else
    seed_user_data
    write_workspace_file "$project"
    log "installing paseo-bridge from this checkout"
    install_bridge
    systemd-run --user --quiet --unit "$UNIT" --collect \
      --setenv=PASEO_BRIDGE_BROKER_PORT="$BROKER_PORT" \
      "$BIN" --bind-addr "${HOST}:${PORT}" --auth none --disable-telemetry \
      --disable-workspace-trust \
      --user-data-dir "${TRIAL_HOME}/user-data" --extensions-dir "${TRIAL_HOME}/extensions"
    for _ in $(seq 1 60); do
      curl -fs -o /dev/null "http://${HOST}:${PORT}/healthz" && break
      sleep 0.5
    done
  fi
  curl -fsS -o /dev/null "http://${HOST}:${PORT}/healthz" || die "trial code-server did not come up"
  log "open: http://${HOST}:${PORT}/?workspace=${WORKSPACE_FILE}"
  log "then: $0 switch <another-project-dir>"
}

cmd_switch() {
  local folder="${1:-}"
  [[ -n "$folder" ]] || die "usage: $0 switch <dir>"
  if [[ "$folder" != "~"* ]]; then
    folder="$(cd "$folder" && pwd)" || die "no such dir: $1"
  fi
  local started response
  started="$(date +%s%3N)"
  response="$(curl -sS -X POST "http://127.0.0.1:${BROKER_PORT}/broker/switch" \
    -H 'content-type: application/json' \
    -d "{\"folder\":\"${folder}\",\"workspaceFile\":\"${WORKSPACE_FILE}\"}")" ||
    die "bridge unreachable on :${BROKER_PORT} (is the trial window open in a browser?)"
  log "switch -> ${folder}: ${response} (round trip $(($(date +%s%3N) - started)) ms)"
}

cmd_status() {
  systemctl --user --no-pager status "$UNIT" | head -n 5 || true
  curl -sS "http://127.0.0.1:${BROKER_PORT}/health" || log "bridge broker not up (no window open yet)"
  echo
  [[ -f "$WORKSPACE_FILE" ]] && cat "$WORKSPACE_FILE"
}

cmd_down() {
  systemctl --user stop "$UNIT" 2>/dev/null || true
  log "stopped (data kept in ${TRIAL_HOME}; delete it to start clean)"
}

case "${1:-}" in
  up) shift; cmd_up "$@" ;;
  switch) shift; cmd_switch "$@" ;;
  status) cmd_status ;;
  down) cmd_down ;;
  *) sed -n '2,24p' "$0"; exit 1 ;;
esac
