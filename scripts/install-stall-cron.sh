#!/usr/bin/env bash
# Install or refresh this host's stall-check schedule: runs
# scripts/stall-check.mjs every minute, appending to $paseo_home/stall-check.log.
#
# Usage:
#   scripts/install-stall-cron.sh [repo_dir] [paseo_home] [node_bin]
#
#   repo_dir   checkout of the paseo repo (default: this script's repo)
#   paseo_home daemon home; the log lands at $paseo_home/stall-check.log
#              (default: ~/.paseo)
#   node_bin   absolute node binary baked into the scheduled command
#              (default: resolve via `command -v node`, falling back to the
#              newest nvm install)
#
# Scheduler detection, in order:
#   1. crontab — a managed entry (`# paseo-stall-check` marker + command line)
#      that replaces on re-run instead of duplicating, and works when no
#      crontab exists yet.
#   2. systemd user units — paseo-stall-check.service + paseo-stall-check.timer
#      under ~/.config/systemd/user/, OnCalendar=minutely, enabled and started.
#      Idempotent: rewriting the units and re-enabling never duplicates.
#   3. neither — warn and exit 0. The stall check is a SAFETY NET, not a
#      critical path: a missing scheduler must never fail a host's deploy job.
#
# Prints the installed schedule line on stdout so deploy can report it per host.
#
# Log rotation lives in the scheduled command itself (POSIX wc/tail/mv — no GNU
# tools): once the log passes 5 MiB (~2 weeks of minute-ly runs) it is trimmed
# to the last 5 MiB. Both schedulers share the SAME rotation+run string, so they
# cannot drift. cron provides HOME/PATH; systemd user units provide HOME but no
# shell — the absolute node path is required, so resolve it at install time and
# bake it in.
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
# 1 dormant) is what the scheduler sees. The log stays bounded to ~5 MiB + one
# run. Shared verbatim by the crontab entry and the systemd timer command.
rotate_cmd="[ \"\$(wc -c < $log_file 2>/dev/null || echo 0)\" -gt $max_bytes ] && tail -c $max_bytes $log_file > $log_file.tmp && mv $log_file.tmp $log_file"
run_cmd="$node_bin $repo_dir/scripts/stall-check.mjs >> $log_file 2>&1"
schedule_cmd="$rotate_cmd; $run_cmd"

mkdir -p "$paseo_home"

warn() {
  echo "install-stall-cron: WARNING: $*" >&2
}

# Scratch file for the crontab rewrite; global so the EXIT trap can reach it.
tmp=""

install_crontab() {
  local cron_line
  cron_line="* * * * * $schedule_cmd"
  tmp="$(mktemp)" || return 1
  trap 'rm -f "$tmp"' EXIT

  # Keep every existing line except the managed marker + command line. Empty when
  # crontab -l fails (no crontab yet) or when nothing survived the filter.
  if ! crontab -l 2>/dev/null | grep -vE 'paseo-stall-check|stall-check\.mjs' >"$tmp"; then
    :
  fi
  if ! { cat "$tmp"; printf '%s\n' "$marker"; printf '%s\n' "$cron_line"; } | crontab -; then
    warn "crontab write failed"
    return 1
  fi

  echo "$cron_line"
}

install_systemd() {
  local unit_dir service_unit timer_unit
  unit_dir="$HOME/.config/systemd/user"
  service_unit="$unit_dir/paseo-stall-check.service"
  timer_unit="$unit_dir/paseo-stall-check.timer"

  mkdir -p "$unit_dir" || return 1

  # systemd parses ExecStart quoting itself; the single quotes around
  # $schedule_cmd keep the embedded "$(...)" and ';' literal for bash -c.
  if ! cat >"$service_unit" <<EOF
[Unit]
Description=Paseo stall-check (every minute; runs scripts/stall-check.mjs)

[Service]
Type=oneshot
Environment=HOME=%h
ExecStart=/bin/bash -c '$schedule_cmd'
EOF
  then
    warn "could not write $service_unit"
    return 1
  fi

  if ! cat >"$timer_unit" <<EOF
[Unit]
Description=Paseo stall-check timer (every minute)

[Timer]
OnCalendar=minutely
Persistent=true

[Install]
WantedBy=timers.target
EOF
  then
    warn "could not write $timer_unit"
    return 1
  fi

  systemctl --user daemon-reload || { warn "systemctl --user daemon-reload failed"; return 1; }
  systemctl --user enable paseo-stall-check.timer >/dev/null 2>&1 \
    || { warn "systemctl --user enable paseo-stall-check.timer failed"; return 1; }
  if systemctl --user is-active paseo-stall-check.timer >/dev/null 2>&1; then
    # Already running: restart so an edited OnCalendar/command applies.
    systemctl --user restart paseo-stall-check.timer || { warn "systemctl --user restart paseo-stall-check.timer failed"; return 1; }
  else
    systemctl --user start paseo-stall-check.timer || { warn "systemctl --user start paseo-stall-check.timer failed"; return 1; }
  fi

  # A user timer only runs while the user manager is up. On headless hosts that
  # means the session must linger; report it if we cannot enable it.
  if command -v loginctl >/dev/null 2>&1; then
    if loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -qx 'Linger=yes'; then
      echo "install-stall-cron: systemd linger already enabled for $(id -un)" >&2
    elif sudo -n loginctl enable-linger "$(id -un)" >/dev/null 2>&1; then
      echo "install-stall-cron: enabled systemd linger for $(id -un)" >&2
    else
      warn "linger not enabled for $(id -un) (needs: sudo loginctl enable-linger $(id -un)); the timer only runs while a session is active"
    fi
  fi

  echo "systemd timer paseo-stall-check.timer (OnCalendar=minutely) -> $log_file"
}

install_scheduler() {
  if command -v crontab >/dev/null 2>&1; then
    install_crontab
  elif command -v systemctl >/dev/null 2>&1 \
    && systemctl --user show-environment >/dev/null 2>&1; then
    install_systemd
  else
    warn "no scheduler available (no crontab, systemd user units unavailable); skipping stall-check install — deploy continues"
    return 0
  fi
}

# Never fail a deploy over the schedule: the stall check is a safety net, not a
# critical path. Any scheduler failure degrades to a warning and exit 0.
if ! install_scheduler; then
  warn "could not install the stall-check schedule; deploy continues (the check is a safety net, not a critical path)"
  exit 0
fi
