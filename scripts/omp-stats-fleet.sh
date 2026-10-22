#!/usr/bin/env bash
#
# omp-stats-fleet.sh — the real `omp stats` dashboard over ALL hosts at once.
#
# `omp stats` reads exactly one SQLite file and has no remote/merge support, but
# the path is profile-relative:
#
#   ~/.omp/stats.db                     <- your real DB, NEVER touched by this script
#   ~/.omp/profiles/fleet/stats.db      <- OMP_PROFILE=fleet reads this instead
#
# omp-stats-fleet.ts keeps the fleet profile's DB as an incrementally refreshed
# mirror of every host's stats.db and serves the stock dashboard on it. Only
# the first refresh copies everything; later ones move the changed rows.
#
# Usage:
#   scripts/omp-stats-fleet.sh                  # refresh + open dashboard
#   scripts/omp-stats-fleet.sh --serve          # open dashboard on the last refresh
#   scripts/omp-stats-fleet.sh --merge-only     # refresh, don't start the server
#   scripts/omp-stats-fleet.sh --summary        # refresh, then omp's text summary
#   scripts/omp-stats-fleet.sh --json           # refresh, then omp's JSON summary
#   scripts/omp-stats-fleet.sh --no-sync        # skip each host's own session sync
#
#   OMP_FLEET_HOSTS="local blrofc3"   # subset; "local" means this Mac
#   OMP_FLEET_PROFILE=fleet           # profile name (=> ~/.omp/profiles/<name>)
#   OMP_FLEET_PORT=3848               # dashboard port (default 3848, one above stock)
#
set -euo pipefail

# Same lookup the remote side uses; the desktop app's PATH may not include them.
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"

die() { printf '\033[31m[fleet] %s\033[0m\n' "$*" >&2; exit 1; }
command -v omp >/dev/null || die "omp not on PATH"
command -v bun >/dev/null || die "bun not on PATH"

exec bun "$(dirname "${BASH_SOURCE[0]}")/omp-stats-fleet.ts" "$@"
