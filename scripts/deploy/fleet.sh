# shellcheck shell=bash
# Inventory-driven fleet steps for scripts/deploy.sh (sourced, not executed).
# Relies on deploy.sh's log/die, ROOT_DIR, LOCAL_PASEO_HOME, NODE_VERSION,
# REMOTE_REPO_DIR and MACBOOK_REPO_DIR.
#
# Inventory: ~/.paseo/fleet-hosts.json (PASEO_FLEET_INVENTORY overrides), format
# in scripts/deploy/fleet-hosts.example.json, parsed by scripts/deploy/fleet.mjs.
#
#   builder  checks out the repo and builds; Linux builders then package the
#            runtime and run their own daemon from that package
#   target   no checkout, no build: receives its builder's package (same
#            platform), runs it as the systemd user unit paseo-daemon.service
#
# Secrets: every host's daemon password lives in this host's deploy.env as
# PASEO_HOST_PASSWORD_<NAME> (chmod 600). Missing target passwords are generated
# here; a target's own ~/.paseo/deploy.env gets PASEO_PASSWORD for its CLI and
# the snapshot/nudge. Passwords travel over ssh stdin only and are never logged.

FLEET_DIR="$ROOT_DIR/scripts/deploy"
FLEET_SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)
FLEET_SELF=""

# Node for one-off config patches on a host: the packaged runtime when present,
# else nvm (builders that are not cut over yet, the MacBook).
# shellcheck disable=SC2016
FLEET_REMOTE_NODE='export PATH="$HOME/.local/bin:$PATH"; if [ -x "$HOME/.local/share/paseo/current/bin/node" ]; then NODE="$HOME/.local/share/paseo/current/bin/node"; else export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; NODE=node; fi'

fleet() {
  if ! command -v node >/dev/null 2>&1; then
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    # shellcheck disable=SC1091
    [[ -s "$NVM_DIR/nvm.sh" ]] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
  fi
  node "$FLEET_DIR/fleet.mjs" "$@"
}

fleet_field() { fleet field "$1" "$2"; }

# Run a shell command on an inventory host; stdin is forwarded. The host this
# deploy runs on executes locally (no ssh to itself).
fleet_on() {
  local host="$1" cmd="$2"
  if [[ -n "$FLEET_SELF" && "$host" == "$FLEET_SELF" ]]; then
    bash -c "$cmd"
  else
    ssh "${FLEET_SSH_OPTS[@]}" "$(fleet_field "$host" ssh)" "$cmd"
  fi
}

fleet_reachable() { fleet_on "$1" true </dev/null >/dev/null 2>&1; }

# Inventory path with a leading ~ turned into $HOME for the remote shell.
fleet_remote_dir() {
  local dir
  dir="$(fleet_field "$1" "$2")"
  if [[ "$dir" == "~" || "$dir" == "~/"* ]]; then
    dir="\$HOME${dir#\~}"
  fi
  printf '%s' "$dir"
}

# Load the inventory and derive the legacy deploy.sh host variables from it.
fleet_init() {
  fleet validate >/dev/null || die "fleet inventory invalid (${PASEO_FLEET_INVENTORY:-~/.paseo/fleet-hosts.json})"
  FLEET_SELF="$(fleet self)"
  if [[ -z "${PASEO_REMOTE_HOSTS:-}" ]]; then
    REMOTE_HOSTS=()
    local host
    for host in $(fleet list --role builder --daemon systemd); do
      [[ "$host" == "$FLEET_SELF" ]] || REMOTE_HOSTS+=("$host")
    done
  fi
  if [[ -z "${PASEO_MACBOOK_HOST:-}" ]]; then
    local desktop
    for desktop in $(fleet list --role builder --daemon desktop); do
      if [[ "$desktop" != "$FLEET_SELF" ]]; then
        MACBOOK_HOST="$(fleet_field "$desktop" ssh)"
        break
      fi
    done
  fi
}

fleet_targets() {
  if [[ -n "${PASEO_TARGET_HOSTS:-}" ]]; then
    printf '%s\n' ${PASEO_TARGET_HOSTS}
  else
    fleet list --role target
  fi
}

fleet_password() {
  local var
  var="$(fleet password-var "$1")"
  printf '%s' "${!var:-}"
}

# Every host needs a password entry before peers can be written. Targets get a
# fresh one when missing; a builder without one is a setup error (its daemon
# already has a password this host does not know).
ensure_fleet_passwords() {
  local file="${PASEO_DEPLOY_ENV_FILE:-${LOCAL_PASEO_HOME}/deploy.env}"
  local host var role pw
  for host in $(fleet list); do
    var="$(fleet password-var "$host")"
    [[ -n "${!var:-}" ]] && continue
    role="$(fleet_field "$host" role)"
    if [[ "$role" != "target" ]]; then
      die "$var is not set: add ${host}'s daemon password to $file (chmod 600)"
    fi
    pw="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(18).toString("base64url"))')"
    (umask 077 && touch "$file")
    printf '%s=%s\n' "$var" "$pw" >>"$file"
    chmod 600 "$file"
    export "$var=$pw"
    log "Generated a daemon password for $host (stored as $var in $file)"
  done
}

fleet_hash_password() {
  PASEO_FLEET_PW="$1" node --input-type=module -e '
const { hashDaemonPassword } = await import(process.argv[1]);
process.stdout.write(hashDaemonPassword(process.env.PASEO_FLEET_PW));
' "$ROOT_DIR/packages/server/dist/server/server/auth.js"
}

# Patch a host's config.json: full-mesh peers, its NetBird name in
# daemon.hostnames, plus optional extra payload fields (JSON members).
fleet_push_host_config() {
  local host="$1" extra="${2:-}" peers dns hostnames payload
  peers="$(fleet peers "$host")" || return 1
  dns="$(fleet_field "$host" dns)"
  hostnames="[]"
  [[ -n "$dns" ]] && hostnames="[\"$dns\"]"
  payload="{\"peers\":$peers,\"hostnames\":$hostnames${extra:+,$extra}}"
  {
    printf 'globalThis.PASEO_HOST_CONFIG = %s;\n' "$payload"
    cat "$FLEET_DIR/host-config.cjs"
  } | fleet_on "$host" "$FLEET_REMOTE_NODE; \"\$NODE\" -" | sed "s/^/  [$host] /"
  return "${PIPESTATUS[1]}"
}

# `paseo daemon reload` on a host: applies reloadable config without a restart.
# Calls the deployed wrapper by path: nvm's bin dir (prepended by nvm.sh) can
# hold a stale global @getpaseo/cli that shadows ~/.local/bin/paseo.
fleet_reload_daemon() {
  local host="$1" out
  # shellcheck disable=SC2016
  if ! out="$(fleet_on "$host" "$FLEET_REMOTE_NODE"'; if [ -f "$HOME/.paseo/deploy.env" ]; then set -a; . "$HOME/.paseo/deploy.env"; set +a; fi; cli="$HOME/.local/bin/paseo"; [ -x "$cli" ] || cli=paseo; "$cli" daemon reload --json --home "$HOME/.paseo"' </dev/null 2>&1)"; then
    log "  [$host] reload failed: $(printf '%s' "$out" | tail -n 3 | tr '\n' ' ')"
    return 1
  fi
  printf '%s' "$out" | node -e '
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const host = process.argv[1];
  try {
    const r = JSON.parse(raw);
    const d = r.data ?? r;
    const applied = d.appliedPaths ?? [];
    const restart = d.restartRequiredPaths ?? [];
    const peersPending = restart.some((p) => p === "peers" || p.startsWith("peers."));
    console.log(`  [${host}] reloaded; applied: ${applied.join(", ") || "none"}`);
    if (peersPending) {
      console.log(`  [${host}] peers need a daemon restart (this build predates live peer reload)`);
    }
    const other = restart.filter((p) => p !== "peers" && !p.startsWith("peers.")).length;
    if (other > 0) console.log(`  [${host}] ${other} other config path(s) differ from boot (restart applies them)`);
  } catch {
    console.log(`  [${host}] reloaded (unparsed output)`);
  }
});
' "$host"
}

# Write the full mesh to every reachable daemon and reload it. Hosts whose
# runtime is not installed yet are skipped (their target job writes peers
# before the first start).
sync_fleet_peers() {
  if [[ "${PASEO_SKIP_PEERS:-0}" == "1" ]]; then
    log "Skipping fleet peering (PASEO_SKIP_PEERS=1)"
    return
  fi
  log "Syncing full-mesh peers from the inventory"
  local host
  for host in $(fleet list); do
    if ! fleet_reachable "$host"; then
      log "  [$host] unreachable — peers not updated"
      continue
    fi
    if [[ "$(fleet_field "$host" role)" == "target" ]] \
      && ! fleet_on "$host" 'test -x "$HOME/.local/share/paseo/current/bin/node"' </dev/null; then
      log "  [$host] no runtime installed yet — skipped"
      continue
    fi
    fleet_push_host_config "$host" || {
      log "  [$host] config patch failed"
      continue
    }
    fleet_reload_daemon "$host" || true
  done
}

# Package the runtime on a builder and print the tarball path ON THE BUILDER.
# Uses the builder's checkout as built; the packager is piped in, so a checkout
# that predates scripts/deploy still packages. Node = PASEO_NODE_VERSION.
fleet_package_on_builder() {
  local builder="$1" repo dir
  dir="$(fleet_remote_dir "$builder" artifactDir)"
  if [[ "$builder" == "$FLEET_SELF" ]]; then
    repo="$ROOT_DIR"
  elif [[ "$(fleet_field "$builder" daemon)" == "desktop" ]]; then
    repo="\$HOME/$MACBOOK_REPO_DIR"
  else
    repo="\$HOME/$REMOTE_REPO_DIR"
  fi
  fleet_on "$builder" "set -e; export NVM_DIR=\"\${NVM_DIR:-\$HOME/.nvm}\"; . \"\$NVM_DIR/nvm.sh\" >/dev/null; nvm use '$NODE_VERSION' >/dev/null; mkdir -p \"$dir\"; PASEO_REPO_DIR=\"$repo\" PASEO_ARTIFACT_DIR=\"$dir\" node --input-type=module -" \
    <"$FLEET_DIR/package-runtime.mjs"
}

# The tarball a builder's own daemon runs (after its cutover), else a fresh
# package of its checkout. PASEO_TARGETS_ONLY=1 always packages fresh.
fleet_builder_tarball() {
  local builder="$1" dir path=""
  dir="$(fleet_remote_dir "$builder" artifactDir)"
  if [[ "${PASEO_TARGETS_ONLY:-0}" != "1" ]]; then
    path="$(fleet_on "$builder" "r=\"\$(readlink \"\$HOME/.local/share/paseo/current\" 2>/dev/null || true)\"; p=\"$dir/\${r##*/}.tar.gz\"; if [ -n \"\$r\" ] && [ -f \"\$p\" ]; then printf %s \"\$p\"; fi" </dev/null)"
  fi
  if [[ -z "$path" ]]; then
    log "Packaging runtime on $builder" >&2
    path="$(fleet_package_on_builder "$builder" | tail -n 1)"
  fi
  [[ -n "$path" ]] || die "no runtime tarball from $builder"
  printf '%s' "$path"
}

# Stream builder → (this host) → target and verify the checksum. Prints the
# path on the target. Builders never need ssh access to their targets.
fleet_ship_runtime() {
  local builder="$1" src="$2" target="$3" name sum got
  name="${src##*/}"
  local dest="\$HOME/.paseo/artifacts/$name"
  local sha='if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi'
  sum="$(fleet_on "$builder" "$sha < \"$src\"" </dev/null | cut -d' ' -f1)"
  got="$(fleet_on "$target" "[ -f \"$dest\" ] && ($sha < \"$dest\") || true" </dev/null | cut -d' ' -f1)"
  if [[ -n "$sum" && "$got" == "$sum" ]]; then
    log "  [$target] $name already present" >&2
  else
    log "  [$target] shipping $name from $builder" >&2
    fleet_on "$builder" "cat \"$src\"" </dev/null \
      | fleet_on "$target" "mkdir -p \"\$HOME/.paseo/artifacts\" && cat > \"$dest.partial\""
    got="$(fleet_on "$target" "$sha < \"$dest.partial\"" </dev/null | cut -d' ' -f1)"
    [[ -n "$sum" && "$got" == "$sum" ]] || die "checksum mismatch shipping $name to $target"
    fleet_on "$target" "mv \"$dest.partial\" \"$dest\"" </dev/null
  fi
  fleet_on "$target" "printf %s \"$dest\"" </dev/null
}

# A target's own deploy.env: PASEO_PASSWORD for its CLI + snapshot/nudge.
fleet_write_target_deploy_env() {
  local target="$1"
  # shellcheck disable=SC2016
  { fleet_password "$target"; printf '\n'; } | fleet_on "$target" 'set -e; umask 077; mkdir -p "$HOME/.paseo"; f="$HOME/.paseo/deploy.env"; IFS= read -r pw; touch "$f"; grep -v "^PASEO_PASSWORD=" "$f" > "$f.tmp" || true; printf "PASEO_PASSWORD=%s\n" "$pw" >> "$f.tmp"; chmod 600 "$f.tmp"; mv "$f.tmp" "$f"'
}

# Run activate-runtime.sh on a host from a temp file: with `bash -s` any step
# that reads stdin would swallow the rest of the script.
fleet_run_activation() {
  local host="$1" mode="$2" artifact="$3"
  fleet_on "$host" "f=\"\$(mktemp)\"; cat > \"\$f\"; bash \"\$f\" $mode \"$artifact\" </dev/null; rc=\$?; rm -f \"\$f\"; exit \$rc" \
    <"$FLEET_DIR/activate-runtime.sh"
}

# One target end to end: ship → install → secrets + config → activate (unit,
# fleet settings, linger, restart with snapshot/nudge).
fleet_target_job() {
  local target="$1" builder="$2" src="$3" remote hash listen
  fleet_reachable "$target" || die "$target unreachable over ssh"
  remote="$(fleet_ship_runtime "$builder" "$src" "$target")"
  [[ -n "$remote" ]] || die "shipping to $target failed"
  fleet_run_activation "$target" install "$remote"
  log "  [$target] writing deploy.env (PASEO_PASSWORD) and config (listen, password hash, peers)"
  fleet_write_target_deploy_env "$target"
  hash="$(fleet_hash_password "$(fleet_password "$target")")"
  # Bind the NetBird address only: targets can sit on public or home networks.
  listen="$(fleet_field "$target" address):$(fleet_field "$target" port)"
  fleet_push_host_config "$target" "\"initListen\":\"$listen\",\"initPasswordHash\":\"$hash\""
  log "  [$target] activating"
  fleet_run_activation "$target" activate "$remote"
}

# Ship each builder's runtime to its targets, in parallel per target. One
# package per builder, shared by all of its targets.
deploy_fleet_targets() {
  if [[ "${PASEO_SKIP_TARGETS:-0}" == "1" ]]; then
    log "Skipping fleet targets (PASEO_SKIP_TARGETS=1)"
    return
  fi
  local wanted builder target src
  wanted=" $(fleet_targets | tr '\n' ' ') "
  PARALLEL_PIDS=()
  PARALLEL_NAMES=()
  PARALLEL_LOGS=()
  for builder in $(fleet list --role builder); do
    src=""
    for target in $(fleet targets "$builder"); do
      [[ "$wanted" == *" $target "* ]] || continue
      if [[ -z "$src" ]]; then
        src="$(fleet_builder_tarball "$builder")" || die "could not get a runtime package from $builder"
        log "Runtime from $builder: $src"
      fi
      start_parallel_job "target-${target}" fleet_target_job "$target" "$builder" "$src"
    done
  done
  if [[ ${#PARALLEL_PIDS[@]} -eq 0 ]]; then
    log "No fleet targets to deploy"
    return
  fi
  wait_for_parallel_jobs
}

# Linux builder (this host): package the freshly built checkout and run the
# daemon from that package under the systemd user unit.
activate_local_runtime() {
  local dir tarball
  dir="$(fleet_field "$FLEET_SELF" artifactDir)"
  dir="${dir/#\~/$HOME}"
  mkdir -p "$dir"
  tarball="$(PASEO_ARTIFACT_DIR="$dir" node "$FLEET_DIR/package-runtime.mjs")"
  PASEO_HOME="$LOCAL_PASEO_HOME" bash "$FLEET_DIR/activate-runtime.sh" activate "$tarball"
}
