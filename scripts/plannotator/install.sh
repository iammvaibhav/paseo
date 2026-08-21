#!/usr/bin/env bash
# Install/update the Plannotator binary only (no agent hooks/skills).
#
# Usage (run on the machine being configured):
#   ./scripts/plannotator/install.sh local
#   ./scripts/plannotator/install.sh blrofc3
#   ./scripts/plannotator/install.sh iammvaibhav
#
# Env:
#   PLANNOTATOR_VERSION=0.22.0   # pin; omit for latest
#   PLANNOTATOR_BIN=...          # override install path (default: ~/.local/bin/plannotator)
#
# Binary-only by design: Paseo spawns sessions itself. The full upstream installer
# wires Stop/PostToolUse hooks into Claude/Codex configs — we must not install those.

set -euo pipefail

HOST_KIND="${1:-}"
BIN="${PLANNOTATOR_BIN:-${HOME}/.local/bin/plannotator}"
INSTALL_URL="${PLANNOTATOR_INSTALL_URL:-https://plannotator.ai/install.sh}"

log() {
  printf '[plannotator] %s\n' "$*"
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

ensure_binary() {
  mkdir -p "$(dirname "$BIN")"

  local before="" after=""
  if [[ -x "$BIN" ]]; then
    before="$("$BIN" --version 2>/dev/null | head -n1 || true)"
  fi

  log "Installing/updating plannotator binary only${PLANNOTATOR_VERSION:+ (v$PLANNOTATOR_VERSION)}"

  # PLANNOTATOR_MINIMAL / --minimal skips hooks, skills, agent-terminal runtime, and sem.
  # See plannotator AGENTS.md environment variables.
  export PLANNOTATOR_MINIMAL=1
  local args=(--minimal)
  if [[ -n "${PLANNOTATOR_VERSION:-}" ]]; then
    args+=(--version="$PLANNOTATOR_VERSION")
  fi

  curl -fsSL "$INSTALL_URL" | bash -s -- "${args[@]}"

  if [[ ! -x "$BIN" ]]; then
    # Upstream may install elsewhere on PATH; try to locate and copy.
    local found
    found="$(command -v plannotator 2>/dev/null || true)"
    if [[ -n "$found" && -x "$found" ]]; then
      cp "$found" "$BIN"
      chmod +x "$BIN"
    fi
  fi

  if [[ ! -x "$BIN" ]]; then
    die "plannotator binary missing at $BIN after install"
  fi

  after="$("$BIN" --version 2>/dev/null | head -n1 || true)"
  if [[ -n "$before" && -n "$after" && "$before" == "$after" ]]; then
    log "Binary unchanged: $after"
  else
    log "Binary ready: ${after:-unknown} at $BIN"
  fi
}

main() {
  require_host_kind
  log "Host kind: $HOST_KIND"
  ensure_binary
  log "Done (binary only — no agent hooks installed)"
}

main
