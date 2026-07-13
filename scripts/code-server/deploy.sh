#!/usr/bin/env bash
# Install/update standalone code-server and deploy Paseo configs + service units.
#
# Usage (run on the machine being configured):
#   ./scripts/code-server/deploy.sh local
#   ./scripts/code-server/deploy.sh blrofc3
#   ./scripts/code-server/deploy.sh iammvaibhav
#
# Env:
#   CODE_SERVER_VERSION=4.127.0   # pin; omit for latest
#   CODE_SERVER_SCRIPTS_DIR=...   # defaults to this script's directory
#
# Safe to re-run: refreshes config/settings/unit files and restarts the service.

set -euo pipefail

HOST_KIND="${1:-}"
SCRIPTS_DIR="${CODE_SERVER_SCRIPTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
BIN="${HOME}/.local/bin/code-server"
CONFIG_DIR="${HOME}/.config/code-server"
USER_DIR="${HOME}/.local/share/code-server/User"

log() {
  printf '[code-server] %s\n' "$*"
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage: deploy.sh <local|blrofc3|iammvaibhav>
EOF
  exit 2
}

require_host_kind() {
  case "$HOST_KIND" in
    local | blrofc3 | iammvaibhav) ;;
    *) usage ;;
  esac
}

ensure_binary() {
  mkdir -p "${HOME}/.local/bin" "${HOME}/.local/lib"
  local args=(--method=standalone)
  if [[ -n "${CODE_SERVER_VERSION:-}" ]]; then
    args+=(--version="$CODE_SERVER_VERSION")
  fi

  local before="" after=""
  if [[ -x "$BIN" ]]; then
    before="$("$BIN" --version 2>/dev/null | head -n1 || true)"
  fi

  log "Installing/updating standalone code-server${CODE_SERVER_VERSION:+ (v$CODE_SERVER_VERSION)}"
  curl -fsSL https://code-server.dev/install.sh | sh -s -- "${args[@]}"

  if [[ ! -x "$BIN" ]]; then
    die "code-server binary missing at $BIN after install"
  fi
  after="$("$BIN" --version 2>/dev/null | head -n1 || true)"
  if [[ -n "$before" && -n "$after" && "$before" == "$after" ]]; then
    log "Binary unchanged: $after"
  else
    log "Binary ready: ${after:-unknown}"
  fi
}

deploy_files() {
  local config_src="${SCRIPTS_DIR}/config.${HOST_KIND}.yaml"
  local settings_src="${SCRIPTS_DIR}/user-settings.json"

  [[ -f "$config_src" ]] || die "Missing config: $config_src"
  [[ -f "$settings_src" ]] || die "Missing settings: $settings_src"

  mkdir -p "$CONFIG_DIR" "$USER_DIR"
  cp "$config_src" "${CONFIG_DIR}/config.yaml"
  cp "$settings_src" "${USER_DIR}/settings.json"
  log "Wrote ${CONFIG_DIR}/config.yaml and ${USER_DIR}/settings.json"
}

deploy_macos_service() {
  local plist_src="${SCRIPTS_DIR}/sh.paseo.code-server.plist"
  local plist_dst="${HOME}/Library/LaunchAgents/sh.paseo.code-server.plist"
  local label="gui/$(id -u)/sh.paseo.code-server"

  [[ -f "$plist_src" ]] || die "Missing LaunchAgent: $plist_src"
  mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs"
  cp "$plist_src" "$plist_dst"

  # bootout is best-effort when the service was never loaded
  launchctl bootout "$label" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$plist_dst"
  launchctl enable "$label" >/dev/null 2>&1 || true
  launchctl kickstart -k "$label"
  log "Restarted LaunchAgent $label"
}

deploy_linux_service() {
  local unit_src="${SCRIPTS_DIR}/paseo-code-server.service"
  local unit_dst="${HOME}/.config/systemd/user/paseo-code-server.service"

  [[ -f "$unit_src" ]] || die "Missing systemd unit: $unit_src"
  mkdir -p "${HOME}/.config/systemd/user"
  cp "$unit_src" "$unit_dst"

  systemctl --user daemon-reload
  systemctl --user enable paseo-code-server.service >/dev/null
  systemctl --user restart paseo-code-server.service

  # Keep the user session (and code-server) alive after SSH logout.
  if command -v loginctl >/dev/null 2>&1; then
    if ! loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -qx 'Linger=yes'; then
      if sudo -n loginctl enable-linger "$(id -un)" >/dev/null 2>&1; then
        log "Enabled systemd linger for $(id -un)"
      else
        log "Linger not enabled (needs: sudo loginctl enable-linger $(id -un))"
      fi
    fi
  fi

  log "Restarted systemd user unit paseo-code-server.service"
}

verify_listening() {
  # Give the process a moment to bind before probing.
  sleep 1
  local bind
  bind="$(awk -F': *' '/^bind-addr:/ { print $2; exit }' "${CONFIG_DIR}/config.yaml" | tr -d '[:space:]')"
  if [[ -z "$bind" ]]; then
    log "Skipping health check (no bind-addr in config)"
    return
  fi
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS -o /dev/null --max-time 5 "http://${bind}/"; then
      log "Healthy at http://${bind}/"
    else
      log "Warning: could not reach http://${bind}/ yet (service may still be starting)"
    fi
  fi
}

main() {
  require_host_kind
  ensure_binary
  deploy_files
  case "$(uname -s)" in
    Darwin) deploy_macos_service ;;
    Linux) deploy_linux_service ;;
    *) die "Unsupported OS: $(uname -s)" ;;
  esac
  verify_listening
  log "Done ($HOST_KIND)"
}

main "$@"
