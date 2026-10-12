#!/usr/bin/env bash
# Install/update the Plannotator binary only (no agent hooks/skills).
#
# Usage (run on the machine being configured):
#   ./scripts/plannotator/install.sh
#
# Env:
#   PLANNOTATOR_VERSION=0.22.0   # pin; omit for latest
#   PLANNOTATOR_BIN=...          # override install path (default: ~/.local/bin/plannotator)
#
# Binary-only by design: Paseo spawns sessions itself. The full upstream installer
# wires Stop/PostToolUse hooks into Claude/Codex configs — we must not install those.

set -euo pipefail

BIN="${PLANNOTATOR_BIN:-${HOME}/.local/bin/plannotator}"
INSTALL_URL="${PLANNOTATOR_INSTALL_URL:-https://plannotator.ai/install.sh}"

log() {
  printf '[plannotator] %s\n' "$*"
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
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

  # Download first: piping into bash lets the installer exit before curl has
  # written everything, and pipefail then reports curl's write error (exit 23)
  # for an install that succeeded.
  local installer
  installer="$(mktemp)"
  curl -fsSL "$INSTALL_URL" -o "$installer"
  bash "$installer" "${args[@]}"
  rm -f "$installer"

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
  ensure_binary
  log "Done (binary only — no agent hooks installed)"
}

main
