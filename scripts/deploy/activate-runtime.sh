#!/usr/bin/env bash
# Activate a packaged Paseo runtime on THIS Linux host and (re)start the daemon
# as the systemd user unit paseo-daemon.service. Runs on the host itself;
# deploy.sh ships the tarball first, then pipes this script over ssh:
#
#   ssh host "bash -s -- install  ~/.paseo/artifacts/<release>.tar.gz" < activate-runtime.sh
#   ssh host "bash -s -- activate ~/.paseo/artifacts/<release>.tar.gz" < activate-runtime.sh
#   ssh host "bash -s -- rollback" < activate-runtime.sh
#
# install  = unpack + verify + switch `current` (no unit, no restart), so deploy
#            can patch config.json with the release's node before the first start
# activate = install + unit + fleet settings + linger + restart
#
# Layout (all per user, no root needed except enabling linger):
#   ~/.local/share/paseo/releases/<release>/   unpacked runtime (bin/node, bin/paseo, lib/)
#   ~/.local/share/paseo/current  -> releases/<release>   (swapped atomically)
#   ~/.local/share/paseo/previous -> releases/<older>     (rollback target)
#   ~/.local/bin/paseo            -> ~/.local/share/paseo/current/bin/paseo
#   ~/.config/systemd/user/paseo-daemon.service  ExecStart=current/bin/paseo daemon run
#   ~/.config/paseo/daemon.env    PATH for the daemon (login PATH + runtime bin)
#
# Restart contract (same as the old detached restart): snapshot running agents,
# restart, require a NEW main pid that answers /api/health, then nudge the
# snapshot so agents resume. A daemon still running outside the unit (the old
# detached "Paseo Supervisor") is stopped once and replaced by the unit.
#
# Fleet settings: the release carries the repo's scripts/paseo-system-prompt.md
# plus the set-append-system-prompt.mjs / set-web-ui-config.mjs patchers.
# Activation writes them into config.json BEFORE the restart (the config store
# reads config.json at boot and writes its in-memory value back on later
# patches). PASEO_SKIP_SYSTEM_PROMPT=1 / PASEO_SKIP_WEB_UI=1 skip each one.
#
# Env: PASEO_HOME (default ~/.paseo), PASEO_RUNTIME_ROOT (default
# ~/.local/share/paseo), PASEO_RUNTIME_KEEP (releases kept, default 5),
# PASEO_ACTIVATE_RESTART=0 (install + switch only, no restart),
# PASEO_DEPLOY_NUDGE=0 (skip snapshot/nudge).
set -euo pipefail

MODE="${1:-}"
ARTIFACT="${2:-}"
PASEO_HOME="${PASEO_HOME:-$HOME/.paseo}"
ROOT="${PASEO_RUNTIME_ROOT:-$HOME/.local/share/paseo}"
KEEP="${PASEO_RUNTIME_KEEP:-5}"
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
    if [[ -n "$old" ]]; then
      switch_link "$old" "$ROOT/previous"
    fi
    log "current -> $rel${old:+ (previous -> $old)}"
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

write_unit() {
  mkdir -p "$UNIT_DIR" "$(dirname "$ENV_FILE")"
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

legacy_daemon_pid() {
  # A daemon holding the home's pid lock that the unit does not own.
  [[ -f "$PASEO_HOME/paseo.pid" ]] || return 0
  local pid
  pid="$("$ROOT/current/bin/node" -e '
try {
  const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (typeof p.pid === "number") process.stdout.write(String(p.pid));
} catch {}
' "$PASEO_HOME/paseo.pid" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null || return 0
  local unit_cgroup
  unit_cgroup="$(systemctl --user show "$UNIT" -p ControlGroup --value 2>/dev/null || true)"
  if [[ -n "$unit_cgroup" ]] && grep -qF "$unit_cgroup" "/proc/$pid/cgroup" 2>/dev/null; then
    return 0
  fi
  printf '%s' "$pid"
}

apply_fleet_settings() {
  local dir="$ROOT/current/lib/deploy" node="$ROOT/current/bin/node"
  if [[ "${PASEO_SKIP_SYSTEM_PROMPT:-0}" == "1" ]]; then
    log "Skipping system prompt (PASEO_SKIP_SYSTEM_PROMPT=1)"
  else
    [[ -f "$dir/paseo-system-prompt.md" ]] || die "release has no paseo-system-prompt.md"
    "$node" "$dir/set-append-system-prompt.mjs" \
      "$(base64 -w0 <"$dir/paseo-system-prompt.md")" "$PASEO_HOME/config.json" \
      | sed 's/^/  system prompt: /'
  fi
  if [[ "${PASEO_SKIP_WEB_UI:-0}" == "1" ]]; then
    log "Skipping web UI setting (PASEO_SKIP_WEB_UI=1)"
  else
    "$node" "$dir/set-web-ui-config.mjs" true "$PASEO_HOME/config.json" | sed 's/^/  web UI: /'
  fi
}

nudge() {
  [[ "${PASEO_DEPLOY_NUDGE:-1}" != "0" ]] || return 0
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
      if [[ -f "$nudge_file" ]]; then
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
      fi
      return 0
    fi
    sleep 1
  done
  systemctl --user status "$UNIT" --no-pager -n 40 >&2 || true
  die "daemon did not become healthy under $UNIT (logs: journalctl --user -u $UNIT, $PASEO_HOME/daemon.log)"
}

prune_releases() {
  local current previous dir name kept=0
  current="$(basename "$(readlink "$ROOT/current" 2>/dev/null || echo none)")"
  previous="$(basename "$(readlink "$ROOT/previous" 2>/dev/null || echo none)")"
  # Newest first by mtime; always keep current + previous.
  while IFS= read -r dir; do
    name="$(basename "$dir")"
    if [[ "$name" == "$current" || "$name" == "$previous" ]]; then
      continue
    fi
    kept=$((kept + 1))
    if ((kept > KEEP - 2)); then
      rm -rf "$dir"
      log "Pruned release $name"
    fi
  done < <(ls -1dt "$ROOT"/releases/*/ 2>/dev/null | sed 's:/$::')
  # Shipped tarballs are only needed until unpacked.
  find "$PASEO_HOME/artifacts" -maxdepth 1 -name 'paseo-runtime-*.tar.gz' -mtime +7 -delete 2>/dev/null || true
}

case "$MODE" in
  install)
    install_release
    point_current_at "$RELEASE_DIR"
    ;;
  activate)
    install_release
    point_current_at "$RELEASE_DIR"
    write_unit
    apply_fleet_settings
    ensure_linger
    if [[ "${PASEO_ACTIVATE_RESTART:-1}" == "1" ]]; then
      restart_daemon
    else
      log "PASEO_ACTIVATE_RESTART=0 — release switched; daemon not restarted"
    fi
    prune_releases
    ;;
  rollback)
    [[ -L "$ROOT/previous" ]] || die "no previous release to roll back to"
    target="$ROOT/$(readlink "$ROOT/previous")"
    [[ -d "$target" ]] || die "previous release missing: $target"
    log "Rolling back to $(basename "$target")"
    point_current_at "$target"
    restart_daemon
    ;;
  *)
    die "usage: activate-runtime.sh install|activate <artifact.tar.gz> | rollback"
    ;;
esac
log "Done ($(readlink "$ROOT/current"))"
