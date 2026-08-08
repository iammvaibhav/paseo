#!/usr/bin/env bash
# Install or refresh this host's stall-check cron entry: runs
# scripts/stall-check.mjs every minute, appending to $paseo_home/stall-check.log.
#
# Usage:
#   scripts/install-stall-cron.sh [repo_dir] [paseo_home] [node_bin]
#
#   repo_dir   checkout of the paseo repo (default: this script's repo)
#   paseo_home daemon home; the log lands at $paseo_home/stall-check.log
#              (default: ~/.paseo)
#   node_bin   absolute node binary baked into the crontab line (default: resolve
#              via `command -v node`, falling back to the newest nvm install)
#
# The managed entry is a marker comment (`# paseo-stall-check`) followed by the
# command line. Re-running replaces the entry instead of duplicating it, and
# works when no crontab exists yet. Prints the installed command line on stdout
# so deploy can report it per host.
#
# Log rotation lives in the cron line itself (POSIX wc/tail/mv — no GNU tools):
# once the log passes 5 MiB (~2 weeks of minute-ly runs) it is trimmed to the
# last 5 MiB. cron provides HOME/PATH, so the absolute node path is required —
# resolve it at install time and bake it in.
#
# Deploy opt-out is PASEO_SKIP_STALL_CRON=1 (deploy.sh's concern); this script
# installs whenever it is invoked.

set -euo pipefail

repo_dir="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
paseo_home="${2:-$HOME/.paseo}"
node_bin="${3:-}"

if [[ -z "$node_bin" ]]; then
  node_bin="$(command -v node || ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1)"
fi
if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
  echo "install-stall-cron: no node binary found (pass one as the third argument)" >&2
  exit 1
fi

marker="# paseo-stall-check"
log_file="$paseo_home/stall-check.log"
max_bytes=5242880
# Rotation runs FIRST so the check is the last command and its exit code (0 ok /
# 1 dormant) is what cron sees. The log stays bounded to ~5 MiB + one run.
cron_line="* * * * * [ \"\$(wc -c < $log_file 2>/dev/null || echo 0)\" -gt $max_bytes ] && tail -c $max_bytes $log_file > $log_file.tmp && mv $log_file.tmp $log_file; $node_bin $repo_dir/scripts/stall-check.mjs >> $log_file 2>&1"

mkdir -p "$paseo_home"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

# Keep every existing line except the managed marker + command line. Empty when
# crontab -l fails (no crontab yet) or when nothing survived the filter.
if ! crontab -l 2>/dev/null | grep -vE 'paseo-stall-check|stall-check\.mjs' >"$tmp"; then
  :
fi
{
  cat "$tmp"
  printf '%s\n' "$marker"
  printf '%s\n' "$cron_line"
} | crontab -

echo "$cron_line"
