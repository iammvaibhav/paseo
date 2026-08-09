#!/usr/bin/env bash
# Install/update the Commander Voice node as a managed service
# (scripts/commander-voice/server.js: browser audio <-> Gemini Live <-> the
# local Paseo daemon). Mirrors scripts/code-server/install.sh: idempotent,
# per-host config, launchd (macOS) / systemd user unit (Linux), restart-safe.
#
# Usage (run on the machine being configured):
#   ./scripts/commander-voice/install.sh local
#   ./scripts/commander-voice/install.sh blrofc3
#   ./scripts/commander-voice/install.sh iammvaibhav
#
# The service targets its LOCAL daemon: ws://127.0.0.1:6767/ws by default,
# derived from the host's daemon listen address (paseo.pid / config.json)
# when available. It needs the daemon password in PLAINTEXT — the daemon
# config stores only a hash, and the voice node authenticates over WS — so
# secrets live in a root-only env file written by deploy from user-set env
# vars. Nothing secret is ever committed:
#   ~/.config/commander-voice/env        (chmod 600, written once)
#   ~/.local/bin/commander-voice-run.sh  (generated wrapper, no secrets)
#
# Env:
#   PASEO_COMMANDER_VOICE_PASSWORD  daemon password to write into the env file
#                                   (unset = keep the existing value)
#   GEMINI_API_KEY                  Gemini Live API key (unset = keep existing;
#                                   the node also resolves it over ssh at launch)
#   COMMANDER_VOICE_PORT            listen port (default 8787)
#   COMMANDER_VOICE_HOST            listen host (default 0.0.0.0)
#   COMMANDER_VOICE_TLS_KEY_PATH    optional TLS key path (passed to the node)
#   COMMANDER_VOICE_TLS_CERT_PATH   optional TLS cert path
#   PASEO_HOME                      daemon home used to derive the WS URL
#                                   (default ~/.paseo)
#   COMMANDER_VOICE_SKIP_NPM=1      skip `npm install` (deps already present)
#
# Safe to re-run: refreshes the wrapper/unit files and restarts the service.

set -euo pipefail

HOST_KIND="${1:-}"
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPTS_DIR}/../.." && pwd)"
ENV_DIR="${HOME}/.config/commander-voice"
ENV_FILE="${ENV_DIR}/env"
WRAPPER="${HOME}/.local/bin/commander-voice-run.sh"
PASEO_HOME="${PASEO_HOME:-$HOME/.paseo}"

log() {
  printf '[commander-voice] %s\n' "$*"
}

warn() {
  printf '[commander-voice] WARNING: %s\n' "$*" >&2
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage: install.sh <local|blrofc3|iammvaibhav>
EOF
  exit 2
}

require_host_kind() {
  case "$HOST_KIND" in
    local | blrofc3 | iammvaibhav) ;;
    *) usage ;;
  esac
}

# Resolve the daemon's listen address from the live pid file or config.json;
# the voice node must reach the LOCAL daemon, whatever it binds.
read_daemon_listen() {
  local home="$1" out=""
  if command -v python3 >/dev/null 2>&1; then
    out="$(python3 -c 'import json,sys,os
try:
 p=json.load(open(os.path.join(sys.argv[1],"paseo.pid"))); print((p.get("listen") or "").strip(), end="")
except Exception:
 pass' "$home" 2>/dev/null || true)"
  fi
  if [[ -z "$out" ]] && command -v python3 >/dev/null 2>&1; then
    out="$(python3 -c 'import json,sys,os
try:
 c=json.load(open(os.path.join(sys.argv[1],"config.json"))); d=c.get("daemon") or {}; print((d.get("listen") or "").strip(), end="")
except Exception:
 pass' "$home" 2>/dev/null || true)"
  fi
  printf '%s' "$out"
}

install_deps() {
  if [[ "${COMMANDER_VOICE_SKIP_NPM:-0}" == "1" ]]; then
    return
  fi
  log "Installing commander-voice npm deps (ws)"
  (cd "$SCRIPTS_DIR" && npm install --no-audit --no-fund)
}

# Write ~/.config/commander-voice/env (chmod 600). The daemon password and the
# Gemini key are only replaced when the deploy explicitly provides them — the
# file is written once and preserved on re-runs.
write_env_file() {
  mkdir -p "$ENV_DIR"
  local port="${COMMANDER_VOICE_PORT:-8787}"
  local host="${COMMANDER_VOICE_HOST:-0.0.0.0}"
  local listen ws_url
  listen="$(read_daemon_listen "$PASEO_HOME")"
  if [[ -n "$listen" ]]; then
    ws_url="ws://${listen}/ws"
  else
    ws_url="ws://127.0.0.1:6767/ws"
  fi

  # Preserve previously written secrets unless this run overrides them.
  local prev_password="" prev_gemini="" prev_tls_key="" prev_tls_cert=""
  if [[ -f "$ENV_FILE" ]]; then
    # shellcheck disable=SC1090
    . "$ENV_FILE" || true
    prev_password="${PASEO_PASSWORD:-}"
    prev_gemini="${GEMINI_API_KEY:-}"
    prev_tls_key="${TLS_KEY_PATH:-}"
    prev_tls_cert="${TLS_CERT_PATH:-}"
  fi

  local password="${PASEO_COMMANDER_VOICE_PASSWORD:-$prev_password}"
  local gemini="${GEMINI_API_KEY:-$prev_gemini}"
  local tls_key="${COMMANDER_VOICE_TLS_KEY_PATH:-$prev_tls_key}"
  local tls_cert="${COMMANDER_VOICE_TLS_CERT_PATH:-$prev_tls_cert}"

  if [[ -z "$password" ]]; then
    warn "No daemon password available (set PASEO_COMMANDER_VOICE_PASSWORD on deploy);"
    warn "the voice node will start but cannot authenticate to the daemon."
  fi

  # Single-quote values so the env file survives dotenv-style sourcing.
  local q
  q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

  {
    printf 'PORT=%s\n' "$port"
    printf 'HOST=%s\n' "$host"
    printf 'PASEO_WS_URL=%s\n' "$(q "$ws_url")"
    if [[ -n "$password" ]]; then
      printf 'PASEO_PASSWORD=%s\n' "$(q "$password")"
    fi
    if [[ -n "$gemini" ]]; then
      printf 'GEMINI_API_KEY=%s\n' "$(q "$gemini")"
    fi
    if [[ -n "$tls_key" ]]; then
      printf 'TLS_KEY_PATH=%s\n' "$(q "$tls_key")"
    fi
    if [[ -n "$tls_cert" ]]; then
      printf 'TLS_CERT_PATH=%s\n' "$(q "$tls_cert")"
    fi
  } > "${ENV_FILE}.tmp"
  mv "${ENV_FILE}.tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  # Never let the deploy-provided secret linger in this shell's environment.
  unset PASEO_COMMANDER_VOICE_PASSWORD
  log "Wrote ${ENV_FILE} (mode 600)"
}

# Generated launcher: source nvm + the env file, then exec the node. One
# wrapper serves both launchd (no env-file support) and systemd.
write_wrapper() {
  mkdir -p "${HOME}/.local/bin"
  local wrapper_tmp="${WRAPPER}.tmp"
  cat >"$wrapper_tmp" <<'WRAPPER_EOF'
#!/usr/bin/env bash
set -euo pipefail
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
set -a
# shellcheck disable=SC1091
. "$HOME/.config/commander-voice/env"
set +a
exec node "__REPO_DIR__/scripts/commander-voice/server.js"
WRAPPER_EOF
  sed -i.bak "s|__REPO_DIR__|${REPO_DIR}|g" "$wrapper_tmp"
  rm -f "${wrapper_tmp}.bak"
  mv "$wrapper_tmp" "$WRAPPER"
  chmod +x "$WRAPPER"
  log "Wrote launcher ${WRAPPER}"
}

deploy_macos_service() {
  local plist_src="${SCRIPTS_DIR}/sh.paseo.commander-voice.plist"
  local plist_dst="${HOME}/Library/LaunchAgents/sh.paseo.commander-voice.plist"
  local uid domain service
  uid="$(id -u)"
  domain="gui/${uid}"
  service="sh.paseo.commander-voice"

  [[ -f "$plist_src" ]] || die "Missing LaunchAgent: $plist_src"
  mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs"
  cp "$plist_src" "$plist_dst"

  if launchctl print "${domain}/${service}" >/dev/null 2>&1; then
    log "Stopping existing LaunchAgent ${domain}/${service}"
    launchctl bootout "${domain}/${service}" >/dev/null 2>&1 || true
    # Teardown is asynchronous (same as code-server): wait until the service is
    # really gone before deciding what to do next.
    local i
    for i in $(seq 1 30); do
      if ! launchctl print "${domain}/${service}" >/dev/null 2>&1; then
        break
      fi
      sleep 0.5
    done
  fi

  if launchctl print "${domain}/${service}" >/dev/null 2>&1; then
    log "LaunchAgent still loaded; kickstarting in place"
    if ! launchctl kickstart -k "${domain}/${service}"; then
      log "Kickstart failed; bootstrapping from plist"
      launchctl bootstrap "$domain" "$plist_dst"
      launchctl enable "${domain}/${service}" >/dev/null 2>&1 || true
      launchctl kickstart -k "${domain}/${service}" >/dev/null 2>&1 || true
    fi
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
  local unit_src="${SCRIPTS_DIR}/paseo-commander-voice.service"
  local unit_dst="${HOME}/.config/systemd/user/paseo-commander-voice.service"

  [[ -f "$unit_src" ]] || die "Missing systemd unit: $unit_src"
  mkdir -p "${HOME}/.config/systemd/user"
  cp "$unit_src" "$unit_dst"

  systemctl --user daemon-reload
  systemctl --user enable paseo-commander-voice.service >/dev/null
  systemctl --user restart paseo-commander-voice.service

  # Keep the user session (and the voice node) alive after SSH logout.
  if command -v loginctl >/dev/null 2>&1; then
    if ! loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -qx 'Linger=yes'; then
      if sudo -n loginctl enable-linger "$(id -un)" >/dev/null 2>&1; then
        log "Enabled systemd linger for $(id -un)"
      else
        log "Linger not enabled (needs: sudo loginctl enable-linger $(id -un))"
      fi
    fi
  fi

  log "Restarted systemd user unit paseo-commander-voice.service"
}

verify_listening() {
  sleep 1
  local port="${COMMANDER_VOICE_PORT:-8787}"
  local host="${COMMANDER_VOICE_HOST:-0.0.0.0}"
  if [[ "$host" == "0.0.0.0" ]]; then
    host="127.0.0.1"
  fi
  if command -v curl >/dev/null 2>&1; then
    local i
    for i in 1 2 3 4 5 6; do
      if curl -fsS -o /dev/null --max-time 3 "http://${host}:${port}/" 2>/dev/null; then
        log "Healthy at http://${host}:${port}/"
        return
      fi
      sleep 0.5
    done
    log "Warning: could not reach http://${host}:${port}/ yet (service may still be starting)"
  fi
}

main() {
  require_host_kind
  install_deps
  write_env_file
  write_wrapper
  case "$(uname -s)" in
    Darwin) deploy_macos_service ;;
    Linux) deploy_linux_service ;;
    *) die "Unsupported OS: $(uname -s)" ;;
  esac
  verify_listening
  log "Done ($HOST_KIND)"
}

main "$@"
