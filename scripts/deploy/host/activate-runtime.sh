#!/usr/bin/env bash
# Activate a packaged Paseo runtime on THIS Linux host and (re)start the daemon
# as the systemd user unit paseo-daemon.service. scripts/deploy/main.ts ships
# the tarball, then runs this script on the host:
#
#   activate-runtime.sh install  <artifact.tar.gz>   unpack + verify + switch `current`
#   activate-runtime.sh activate <artifact.tar.gz>   install + unit + linger + restart,
#                                                    then delete other releases + tarball
#
# `install` lets deploy write config.json with the release's node before a new
# host's first start. Only the running release stays on disk; to go back,
# deploy the older commit.
#
# Layout (per user; root only to enable linger):
#   ~/.local/share/paseo/releases/<release>/   unpacked runtime (bin/node, bin/paseo, lib/)
#   ~/.local/share/paseo/current  -> releases/<release>   (swapped atomically)
#   ~/.local/bin/paseo            -> ~/.local/share/paseo/current/bin/paseo
#   ~/.config/systemd/user/paseo-daemon.service  ExecStart=current/bin/paseo daemon run
#   ~/.config/paseo/daemon.env    PATH (login PATH + runtime bin) + tunnel overrides
#
# Restart: snapshot running agents, restart, require a NEW main pid that answers
# /api/health, then nudge the snapshot so agents resume. A daemon running
# outside the unit (old detached "Paseo Supervisor") is stopped once and
# replaced by the unit.
#
# Hosts without a systemd user manager (containers whose PID 1 is not systemd,
# e.g. grok-bot) get no unit and no linger: the daemon runs detached under
# Paseo's own supervisor (`paseo daemon start`, which restarts a crashed
# worker) with the same daemon.env. Nothing starts it at boot; such a host
# runs ~/.local/share/paseo/start-detached.sh from its own boot hook.
#
# Env (set by deploy): PASEO_KEEP_ARTIFACT=1 keeps the tarball (builders ship it
# on to their targets); PASEO_TUNNEL_PROVIDER / PASEO_TUNNEL_AUTOSTART go into
# daemon.env.
set -euo pipefail

MODE="${1:-}"
ARTIFACT="${2:-}"
ARTIFACT="${ARTIFACT/#\~\//$HOME/}"
PASEO_HOME="${PASEO_HOME:-$HOME/.paseo}"
ROOT="$HOME/.local/share/paseo"
UNIT="paseo-daemon.service"
UNIT_DIR="$HOME/.config/systemd/user"
ENV_FILE="$HOME/.config/paseo/daemon.env"
HOST_LABEL="$(hostname -s)"

log() { printf '[%s:%s] %s\n' "$(date '+%H:%M:%S')" "$HOST_LABEL" "$*"; }
die() {
  printf '[%s:%s] error: %s\n' "$(date '+%H:%M:%S')" "$HOST_LABEL" "$*" >&2
  exit 1
}

# systemctl --user from a non-login ssh shell needs the user bus address.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"

# Host-local secrets (PASEO_PASSWORD for snapshot/nudge + CLI). Never echoed.
if [[ -f "$PASEO_HOME/deploy.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$PASEO_HOME/deploy.env"
  set +a
fi

switch_link() {
  # Atomic symlink swap: create beside, then rename over the old link.
  local target="$1" link="$2"
  ln -sfn "$target" "$link.tmp.$$"
  mv -T "$link.tmp.$$" "$link"
}

install_release() {
  [[ -f "$ARTIFACT" ]] || die "artifact not found: $ARTIFACT"
  local release
  # head closes the pipe after one line; tar's SIGPIPE must not trip pipefail.
  release="$({ tar -tzf "$ARTIFACT" 2>/dev/null || true; } | head -n 1 | cut -d/ -f1)"
  [[ -n "$release" && "$release" != "." ]] || die "cannot read release name from $ARTIFACT"
  RELEASE="$release"
  RELEASE_DIR="$ROOT/releases/$release"
  mkdir -p "$ROOT/releases"
  if [[ -d "$RELEASE_DIR" ]]; then
    log "Release $release already unpacked"
  else
    local staging="$ROOT/releases/.staging-$$"
    rm -rf "$staging"
    mkdir -p "$staging"
    tar -xzf "$ARTIFACT" -C "$staging"
    mv "$staging/$release" "$RELEASE_DIR"
    rm -rf "$staging"
    log "Unpacked $release"
  fi
  local node_version cli_version
  node_version="$("$RELEASE_DIR/bin/node" --version)" || die "bundled node does not run on this host"
  cli_version="$("$RELEASE_DIR/bin/paseo" --version)" || die "bundled paseo CLI does not run on this host"
  log "Release $release verified (node $node_version, paseo $cli_version)"
}

point_current_at() {
  local release_dir="$1"
  local old=""
  if [[ -L "$ROOT/current" ]]; then
    old="$(readlink "$ROOT/current")"
  fi
  local rel="releases/$(basename "$release_dir")"
  if [[ "$old" == "$rel" ]]; then
    log "current already -> $rel"
  else
    switch_link "$rel" "$ROOT/current"
    log "current -> $rel"
  fi
  mkdir -p "$HOME/.local/bin"
  # Replace whatever was there (old nvm wrapper script, desktop symlink, ...).
  rm -f "$HOME/.local/bin/paseo"
  ln -s "$ROOT/current/bin/paseo" "$HOME/.local/bin/paseo"
}

login_path() {
  # The daemon hands PATH to every agent it spawns; agents expect the user's
  # interactive PATH (nvm, ~/.local/bin, bun, ...). Capture it once per deploy.
  local captured
  captured="$(bash -ic 'printf "\n__PASEO_PATH__=%s\n" "$PATH"' 2>/dev/null </dev/null \
    | sed -n 's/^__PASEO_PATH__=//p' | tail -n 1 || true)"
  if [[ -z "$captured" ]]; then
    captured="$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  fi
  # Runtime bin last: the user's own node/paseo win; hosts without node still
  # get the bundled one.
  printf '%s:%s' "$captured" "$ROOT/current/bin"
}

write_env() {
  mkdir -p "$(dirname "$ENV_FILE")"
  local env_tmp="$ENV_FILE.tmp.$$"
  {
    printf 'PATH=%s\n' "$(login_path)"
    # Webhook tunnel overrides handed in by deploy (inventory `tunnel`).
    local key
    for key in PASEO_TUNNEL_PROVIDER PASEO_TUNNEL_AUTOSTART; do
      if [[ -n "${!key:-}" ]]; then
        printf '%s=%s\n' "$key" "${!key}"
      fi
    done
  } >"$env_tmp"
  chmod 600 "$env_tmp"
  mv "$env_tmp" "$ENV_FILE"
}

write_unit() {
  write_env
  mkdir -p "$UNIT_DIR"
  local unit_tmp="$UNIT_DIR/$UNIT.tmp.$$"
  cat >"$unit_tmp" <<EOF
# Managed by paseo scripts/deploy/activate-runtime.sh — edits are overwritten.
[Unit]
Description=Paseo daemon ($PASEO_HOME)
StartLimitIntervalSec=0

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
Environment=PASEO_HOME=$PASEO_HOME
ExecStart=$ROOT/current/bin/paseo daemon run --home $PASEO_HOME
Restart=always
RestartSec=5
# SIGTERM goes to the CLI only; it stops the supervisor, which stops the worker
# and its agents. KillMode=process leaves other cgroup members alone: a deploy
# launched from an agent shell lives in this cgroup and must survive the
# restart it triggered (setsid does not leave a cgroup).
KillMode=process
TimeoutStopSec=90

[Install]
WantedBy=default.target
EOF
  if [[ -f "$UNIT_DIR/$UNIT" ]] && cmp -s "$unit_tmp" "$UNIT_DIR/$UNIT"; then
    rm -f "$unit_tmp"
  else
    mv "$unit_tmp" "$UNIT_DIR/$UNIT"
    log "Wrote $UNIT_DIR/$UNIT"
  fi
  systemctl --user daemon-reload
  systemctl --user enable "$UNIT" >/dev/null 2>&1
}

ensure_linger() {
  if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)" == "yes" ]]; then
    return
  fi
  if loginctl enable-linger "$USER" 2>/dev/null || sudo -n loginctl enable-linger "$USER"; then
    log "Enabled linger for $USER (user units start at boot)"
  else
    die "could not enable linger for $USER; run: sudo loginctl enable-linger $USER"
  fi
}

listen_addr() {
  "$ROOT/current/bin/node" -e '
try {
  const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const l = c && c.daemon && c.daemon.listen;
  if (typeof l === "string" && l.trim()) process.stdout.write(l.trim());
} catch {}
' "$PASEO_HOME/config.json" 2>/dev/null || true
}

health_ok() {
  local listen port
  listen="$(listen_addr)"
  listen="${listen:-127.0.0.1:6767}"
  port="${listen##*:}"
  curl -fsS --max-time 2 "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1 \
    || curl -fsS --max-time 2 "http://${listen/0.0.0.0/127.0.0.1}/api/health" >/dev/null 2>&1
}

main_pid() { systemctl --user show "$UNIT" -p MainPID --value 2>/dev/null || echo 0; }

systemd_booted() {
  # sd_booted(): PID 1 is systemd. ensure_linger brings the user manager up.
  [[ -d /run/systemd/system ]]
}

pid_file_pid() {
  # The live daemon holding the home's pid lock, if any.
  [[ -f "$PASEO_HOME/paseo.pid" ]] || return 0
  local pid
  pid="$("$ROOT/current/bin/node" -e '
try {
  const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (typeof p.pid === "number") process.stdout.write(String(p.pid));
} catch {}
' "$PASEO_HOME/paseo.pid" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null || return 0
  printf '%s' "$pid"
}

legacy_daemon_pid() {
  # A daemon holding the home's pid lock that the unit does not own.
  local pid
  pid="$(pid_file_pid)"
  [[ -n "$pid" ]] || return 0
  local unit_cgroup
  unit_cgroup="$(systemctl --user show "$UNIT" -p ControlGroup --value 2>/dev/null || true)"
  if [[ -n "$unit_cgroup" ]] && grep -qF "$unit_cgroup" "/proc/$pid/cgroup" 2>/dev/null; then
    return 0
  fi
  printf '%s' "$pid"
}

nudge() {
  # deploy-nudge defaults to 127.0.0.1:6767; hosts bound to their NetBird IP
  # only answer there.
  local listen
  listen="$(listen_addr)"
  listen="${listen:-127.0.0.1:6767}"
  PASEO_NUDGE_URL="${PASEO_NUDGE_URL:-${listen/0.0.0.0/127.0.0.1}}" \
    PASEO_NUDGE_PASSWORD="${PASEO_NUDGE_PASSWORD:-${PASEO_PASSWORD:-}}" \
    "$ROOT/current/bin/node" "$ROOT/current/lib/deploy/deploy-nudge.mjs" "$@" || true
}

restart_daemon() {
  local nudge_file="$PASEO_HOME/deploy-nudge-activate.json"
  local legacy old_main
  legacy="$(legacy_daemon_pid)"
  old_main="$(main_pid)"
  if [[ -n "$legacy" || "$old_main" != "0" ]]; then
    log "Snapshotting running agents before restart"
    nudge --snapshot "$nudge_file"
  else
    rm -f "$nudge_file"
  fi

  if [[ -n "$legacy" ]]; then
    log "Stopping daemon running outside $UNIT (pid $legacy) — cutting over to the unit"
    "$ROOT/current/bin/paseo" daemon stop --home "$PASEO_HOME" || die "could not stop legacy daemon pid $legacy"
  fi

  if [[ "$old_main" != "0" ]]; then
    log "systemctl --user restart $UNIT (old main pid $old_main)"
    systemctl --user restart "$UNIT"
  else
    log "systemctl --user start $UNIT"
    systemctl --user start "$UNIT"
  fi

  local i new_main
  for ((i = 1; i <= 120; i++)); do
    new_main="$(main_pid)"
    if [[ "$new_main" != "0" && "$new_main" != "$old_main" ]] && health_ok; then
      log "Daemon healthy after ${i}s (main pid $old_main -> $new_main)"
      nudge_snapshot "$nudge_file"
      return 0
    fi
    sleep 1
  done
  systemctl --user status "$UNIT" --no-pager -n 40 >&2 || true
  die "daemon did not become healthy under $UNIT (logs: journalctl --user -u $UNIT, $PASEO_HOME/daemon.log)"
}

nudge_snapshot() {
  local nudge_file="$1"
  [[ -f "$nudge_file" ]] || return 0
  log "Nudging agents from the snapshot"
  # /api/health answers before the WebSocket accepts sessions (503), and
  # deploy-nudge exits 0 on every failure: retry while it cannot connect.
  local attempt out
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    out="$(nudge --nudge "$nudge_file" 2>&1)"
    printf '%s\n' "$out"
    [[ "$out" == *"cannot connect"* ]] || break
    sleep 3
  done
}

write_start_script() {
  # Boot hook entry for hosts without systemd: start the daemon if it is not
  # running (`paseo daemon start` is a no-op then), with the unit's env.
  local script="$ROOT/start-detached.sh"
  cat >"$script.tmp.$$" <<EOF
#!/usr/bin/env bash
# Managed by paseo scripts/deploy/activate-runtime.sh — edits are overwritten.
# Starts the Paseo daemon detached on a host without systemd. Safe to rerun.
set -a
. "$ENV_FILE"
[ -f "$PASEO_HOME/deploy.env" ] && . "$PASEO_HOME/deploy.env"
set +a
exec "$ROOT/current/bin/paseo" daemon start --home "$PASEO_HOME"
EOF
  chmod 755 "$script.tmp.$$"
  mv "$script.tmp.$$" "$script"
}

restart_detached() {
  local nudge_file="$PASEO_HOME/deploy-nudge-activate.json"
  local old_pid new_pid
  old_pid="$(pid_file_pid)"
  if [[ -n "$old_pid" ]]; then
    log "Snapshotting running agents before restart"
    nudge --snapshot "$nudge_file"
    log "Stopping detached daemon (pid $old_pid)"
    "$ROOT/current/bin/paseo" daemon stop --home "$PASEO_HOME" || die "could not stop daemon pid $old_pid"
  else
    rm -f "$nudge_file"
  fi
  log "No systemd user manager: starting the daemon detached (paseo daemon start)"
  "$ROOT/start-detached.sh" || die "paseo daemon start failed (logs: $PASEO_HOME/daemon.log)"
  new_pid="$(pid_file_pid)"
  if [[ -z "$new_pid" || "$new_pid" == "$old_pid" ]] || ! health_ok; then
    die "daemon did not come up detached (logs: $PASEO_HOME/daemon.log)"
  fi
  log "Daemon healthy (pid ${old_pid:-none} -> $new_pid)"
  nudge_snapshot "$nudge_file"
}

# Free disk: only the running release stays. Runs after the restart, so the
# old release is no longer in use when it is deleted.
prune_releases() {
  local current dir
  current="$(basename "$(readlink "$ROOT/current" 2>/dev/null || echo none)")"
  rm -f "$ROOT/previous"
  for dir in "$ROOT"/releases/*/ "$ROOT"/releases/.staging-*; do
    [[ -e "$dir" ]] || continue
    dir="${dir%/}"
    [[ "$(basename "$dir")" == "$current" ]] && continue
    rm -rf "$dir"
    log "Removed old release $(basename "$dir")"
  done
  # Targets: the tarball is only needed until unpacked (also clears leftovers
  # from failed runs). Builders keep their newest one to ship on.
  if [[ "${PASEO_KEEP_ARTIFACT:-0}" != "1" ]]; then
    rm -f "$PASEO_HOME"/artifacts/paseo-runtime-*.tar.gz "$PASEO_HOME"/artifacts/paseo-runtime-*.tar.gz.partial
    log "Removed shipped tarballs (unpacked)"
  fi
}

case "$MODE" in
  install)
    install_release
    point_current_at "$RELEASE_DIR"
    ;;
  activate)
    install_release
    point_current_at "$RELEASE_DIR"
    if systemd_booted; then
      write_unit
      ensure_linger
      restart_daemon
    else
      write_env
      write_start_script
      restart_detached
    fi
    prune_releases
    ;;
  *)
    die "usage: activate-runtime.sh install|activate <artifact.tar.gz>"
    ;;
esac
log "Done ($(readlink "$ROOT/current"))"
