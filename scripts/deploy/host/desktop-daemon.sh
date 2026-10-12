#!/usr/bin/env bash
# Restart the desktop-managed daemon on this Mac (the current directory is its
# checkout) with the deploy contract: snapshot running agents, restart, require
# a new healthy worker, nudge the snapshot. Run by scripts/deploy/main.ts after
# the app install: the supervisor runs the worker out of Paseo.app, so
# restarting first would relaunch the previous build.
set -euo pipefail

if [[ -f "$HOME/.paseo/deploy.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$HOME/.paseo/deploy.env"
  set +a
fi
export PASEO_NUDGE_PASSWORD="${PASEO_PASSWORD:-}"
snapshot="$HOME/.paseo/deploy-nudge-desktop.json"

node scripts/deploy-nudge.mjs --snapshot "$snapshot" || true
./scripts/restart-local-daemon.sh
# /api/health answers before the WebSocket accepts sessions; retry the nudge
# while it cannot connect (deploy-nudge exits 0 on every failure).
for _ in $(seq 1 10); do
  out="$(node scripts/deploy-nudge.mjs --nudge "$snapshot" 2>&1 || true)"
  printf '%s\n' "$out"
  [[ "$out" == *"cannot connect"* ]] || break
  sleep 3
done
