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
#   CODE_SERVER_SETTINGS_FILE=... # optional explicit settings.json to install
#   PASEO_SKIP_CODE_SERVER_EXTENSION=1 # skip installing the paseo-bridge extension
#
# Settings source (first match wins):
#   1. CODE_SERVER_SETTINGS_FILE
#   2. Live ~/.local/share/code-server/User/settings.json (if present)
#   3. Repo scripts/code-server/user-settings.json (bootstrap defaults)
#
# Safe to re-run: refreshes config/unit files and restarts the service.
# Live User settings are preserved when present (not overwritten by the repo).

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

resolve_settings_src() {
  local live_settings="${USER_DIR}/settings.json"
  local repo_settings="${SCRIPTS_DIR}/user-settings.json"

  if [[ -n "${CODE_SERVER_SETTINGS_FILE:-}" ]]; then
    [[ -f "$CODE_SERVER_SETTINGS_FILE" ]] || die "CODE_SERVER_SETTINGS_FILE not found: $CODE_SERVER_SETTINGS_FILE"
    printf '%s\n' "$CODE_SERVER_SETTINGS_FILE"
    return
  fi
  if [[ -f "$live_settings" ]]; then
    printf '%s\n' "$live_settings"
    return
  fi
  [[ -f "$repo_settings" ]] || die "Missing settings: $repo_settings"
  printf '%s\n' "$repo_settings"
}

deploy_files() {
  local config_src="${SCRIPTS_DIR}/config.${HOST_KIND}.yaml"
  local settings_src
  settings_src="$(resolve_settings_src)"

  [[ -f "$config_src" ]] || die "Missing config: $config_src"

  mkdir -p "$CONFIG_DIR" "$USER_DIR"
  cp "$config_src" "${CONFIG_DIR}/config.yaml"

  # Live settings already at the destination — keep them (don't clobber with repo).
  if [[ "$(cd "$(dirname "$settings_src")" && pwd)/$(basename "$settings_src")" == "${USER_DIR}/settings.json" ]]; then
    log "Keeping live settings at ${USER_DIR}/settings.json"
  else
    cp "$settings_src" "${USER_DIR}/settings.json"
    log "Wrote ${USER_DIR}/settings.json from ${settings_src}"
  fi
  log "Wrote ${CONFIG_DIR}/config.yaml"
}

deploy_extension() {
  if [[ "${PASEO_SKIP_CODE_SERVER_EXTENSION:-0}" == "1" ]]; then
    log "Skipping paseo-bridge extension (PASEO_SKIP_CODE_SERVER_EXTENSION=1)"
    return
  fi
  local ext_src="${SCRIPTS_DIR}/paseo-bridge"
  local ext_dst="${HOME}/.local/share/code-server/extensions/paseo-bridge"

  if [[ ! -f "${ext_src}/package.json" ]]; then
    log "Warning: paseo-bridge extension missing at ${ext_src}; skipping"
    return
  fi

  mkdir -p "$(dirname "$ext_dst")"
  rm -rf "$ext_dst"
  cp -R "$ext_src" "$ext_dst"
  log "Installed paseo-bridge extension to ${ext_dst}"
}

deploy_macos_service() {
  local plist_src="${SCRIPTS_DIR}/sh.paseo.code-server.plist"
  local plist_dst="${HOME}/Library/LaunchAgents/sh.paseo.code-server.plist"
  local uid domain service
  uid="$(id -u)"
  domain="gui/${uid}"
  service="sh.paseo.code-server"

  [[ -f "$plist_src" ]] || die "Missing LaunchAgent: $plist_src"
  mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs"
  cp "$plist_src" "$plist_dst"

  # Prefer label-form bootout. The "bootout domain plist" form often returns
  # EIO (errno 5) on modern macOS even when nothing is loaded, and can leave
  # the next bootstrap failing with the same error.
  if launchctl print "${domain}/${service}" >/dev/null 2>&1; then
    log "Stopping existing LaunchAgent ${domain}/${service}"
    launchctl bootout "${domain}/${service}" >/dev/null 2>&1 || true
    local i
    for i in 1 2 3 4 5 6 7 8; do
      if ! launchctl print "${domain}/${service}" >/dev/null 2>&1; then
        break
      fi
      sleep 0.25
    done
  fi

  if launchctl print "${domain}/${service}" >/dev/null 2>&1; then
    # Still registered (bootout raced with KeepAlive). Restart in place — the
    # ProgramArguments path is a symlink, so kickstart picks up a new binary.
    log "LaunchAgent still loaded; kickstarting in place"
    launchctl kickstart -k "${domain}/${service}"
  else
    if ! launchctl bootstrap "$domain" "$plist_dst"; then
      die "launchctl bootstrap failed for ${plist_dst}"
    fi
    launchctl enable "${domain}/${service}" >/dev/null 2>&1 || true
    launchctl kickstart -k "${domain}/${service}" >/dev/null 2>&1 || true
  fi

  log "Restarted LaunchAgent ${domain}/${service}"
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
  # Don't split on ':' — bind-addr is host:port (e.g. 127.0.0.1:8765).
  bind="$(
    awk '/^bind-addr:/ {
      sub(/^bind-addr:[[:space:]]*/, "")
      gsub(/[[:space:]]/, "")
      print
      exit
    }' "${CONFIG_DIR}/config.yaml"
  )"
  if [[ -z "$bind" ]]; then
    log "Skipping health check (no bind-addr in config)"
    return
  fi
  if command -v curl >/dev/null 2>&1; then
    local i
    for i in 1 2 3 4 5 6; do
      if curl -fsS -o /dev/null --max-time 3 "http://${bind}/"; then
        log "Healthy at http://${bind}/"
        return
      fi
      sleep 0.5
    done
    log "Warning: could not reach http://${bind}/ yet (service may still be starting)"
  fi
}

main() {
  require_host_kind
  ensure_binary
  deploy_files
  deploy_extension
  case "$(uname -s)" in
    Darwin) deploy_macos_service ;;
    Linux) deploy_linux_service ;;
    *) die "Unsupported OS: $(uname -s)" ;;
  esac
  verify_listening
  log "Done ($HOST_KIND)"
}

main "$@"
