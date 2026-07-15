#!/usr/bin/env bash
# Sync the custom Paseo branch across local + remote dev hosts.
#
# Local workflow (fork-based):
#   1. Rebase the custom branch onto upstream/main (official getpaseo/paseo)
#   2. Push the branch to origin (iammvaibhav/paseo fork)
#   3. Build server + restart the production-style daemon (~/.paseo)
#   4. Update local code-server (binary + config + LaunchAgent)
#
# Remote workflow (blrofc3, iammvaibhav):
#   1. Ensure origin points at the fork and tracks the custom branch
#   2. Pull the branch from origin, install deps if needed, build, restart daemon
#   3. Update code-server (binary + config + systemd user unit)
#
# Usage:
#   ./scripts/sync-custom-branch.sh
#
# Overrides:
#   PASEO_CUSTOM_BRANCH=vaibhav/customizations
#   PASEO_NODE_VERSION=22
#   PASEO_LOCAL_HOME=$HOME/.paseo
#   PASEO_SKIP_REMOTES=1              # local only
#   PASEO_SKIP_LOCAL=1                # remotes only
#   PASEO_SKIP_DAEMON=1               # skip daemon build/restart; still sync git,
#                                     #   deploy code-server, and push settings
#   PASEO_SKIP_CODE_SERVER=1          # skip code-server deploy everywhere
#   PASEO_SYNC_CODE_SERVER_USER_DATA=1  # also rsync User/ + extensions/ local → remotes
#   CODE_SERVER_VERSION=4.127.0       # pin code-server; omit for latest
#
# code-server User settings: sync always pushes this Mac's live
# ~/.local/share/code-server/User/settings.json to remotes (not the repo template).
# Repo scripts/code-server/user-settings.json is only a bootstrap fallback when no
# live settings file exists yet.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${PASEO_CUSTOM_BRANCH:-vaibhav/customizations}"
UPSTREAM_REMOTE="${PASEO_UPSTREAM_REMOTE:-upstream}"
ORIGIN_REMOTE="${PASEO_ORIGIN_REMOTE:-origin}"
FORK_REPO="${PASEO_FORK_REPO:-git@github.com:iammvaibhav/paseo.git}"
LOCAL_PASEO_HOME="${PASEO_LOCAL_HOME:-$HOME/.paseo}"
REMOTE_REPO_DIR="${PASEO_REMOTE_REPO_DIR:-paseo}"
REMOTE_HOSTS=(blrofc3 iammvaibhav)

if [[ -z "${PASEO_NODE_VERSION:-}" ]]; then
  if [[ -f "$ROOT_DIR/.tool-versions" ]]; then
    PASEO_NODE_VERSION="$(awk '/^nodejs / { split($2, parts, "."); print parts[1] }' "$ROOT_DIR/.tool-versions")"
  else
    PASEO_NODE_VERSION="20"
  fi
fi
NODE_VERSION="$PASEO_NODE_VERSION"

log() {
  printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

ensure_node() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    die "nvm not found at $NVM_DIR/nvm.sh"
  fi
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  if ! nvm use "$NODE_VERSION" >/dev/null 2>&1; then
    log "Installing Node $NODE_VERSION via nvm"
    nvm install "$NODE_VERSION"
    nvm use "$NODE_VERSION" >/dev/null
  fi
  log "Using Node $(node -v) (npm $(npm -v))"
}

require_clean_tree() {
  if [[ -n "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=no)" ]]; then
    die "Working tree is not clean. Commit or stash changes before syncing."
  fi
}

ensure_fork_remotes() {
  if ! git -C "$ROOT_DIR" remote | grep -qx "$UPSTREAM_REMOTE"; then
    die "Missing git remote '$UPSTREAM_REMOTE'. Add getpaseo/paseo as upstream first."
  fi
  local origin_url
  origin_url="$(git -C "$ROOT_DIR" remote get-url "$ORIGIN_REMOTE")"
  if [[ "$origin_url" != *"iammvaibhav/paseo"* ]]; then
    die "Expected $ORIGIN_REMOTE to point at iammvaibhav/paseo, got: $origin_url"
  fi
}

sync_local_git() {
  log "Fetching $UPSTREAM_REMOTE and $ORIGIN_REMOTE"
  git -C "$ROOT_DIR" fetch "$UPSTREAM_REMOTE" --prune
  git -C "$ROOT_DIR" fetch "$ORIGIN_REMOTE" --prune

  if ! git -C "$ROOT_DIR" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    die "Local branch '$BRANCH' does not exist."
  fi

  git -C "$ROOT_DIR" checkout "$BRANCH"
  log "Rebasing $BRANCH onto $UPSTREAM_REMOTE/main"
  git -C "$ROOT_DIR" rebase "$UPSTREAM_REMOTE/main"
  log "Pushing $BRANCH to $ORIGIN_REMOTE (force-with-lease after rebase)"
  git -C "$ROOT_DIR" push --force-with-lease "$ORIGIN_REMOTE" "$BRANCH"
}

build_server() {
  log "Building server stack"
  (cd "$ROOT_DIR" && npm run build:server)
}

install_cli_wrapper() {
  local repo_dir="$1"
  local bin_dir="${HOME}/.local/bin"
  local wrapper_path="${bin_dir}/paseo"

  mkdir -p "$bin_dir"
  # Drop any existing entry first. If paseo is a symlink (e.g. the desktop app
  # points ~/.local/bin/paseo into /Applications/Paseo.app), `cat >` would
  # follow it and overwrite the link target, and `sed -i` refuses to edit a
  # symlink in place. Removing it guarantees we write a fresh regular file.
  rm -f "$wrapper_path"
  cat >"$wrapper_path" <<'WRAPPER_EOF'
#!/usr/bin/env bash
set -euo pipefail
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
exec node --disable-warning=DEP0040 "__REPO_DIR__/packages/cli/dist/index.js" "$@"
WRAPPER_EOF
  sed -i.bak "s|__REPO_DIR__|${repo_dir}|g" "$wrapper_path"
  rm -f "${wrapper_path}.bak"
  chmod +x "$wrapper_path"
  log "Installed CLI wrapper at $wrapper_path -> $repo_dir/packages/cli/dist/index.js"
}

daemon_path_env() {
  # Agent CLIs (claude, grok, codex, etc.) commonly live in ~/.local/bin.
  # Non-interactive sync shells often omit it, but the daemon inherits PATH at start.
  printf '%s' "${HOME}/.local/bin:${PATH}"
}

restart_local_daemon() {
  log "Restarting local daemon ($LOCAL_PASEO_HOME)"
  (
    cd "$ROOT_DIR"
    PATH="$(daemon_path_env)" npx tsx packages/cli/src/index.js daemon restart --home "$LOCAL_PASEO_HOME"
  )
}

deploy_local_code_server() {
  if [[ "${PASEO_SKIP_CODE_SERVER:-0}" == "1" ]]; then
    log "Skipping local code-server deploy (PASEO_SKIP_CODE_SERVER=1)"
    return
  fi
  log "Deploying local code-server"
  bash "$ROOT_DIR/scripts/code-server/deploy.sh" local
}

sync_code_server_settings_to_remotes() {
  if [[ "${PASEO_SKIP_CODE_SERVER:-0}" == "1" ]]; then
    return
  fi
  if [[ "${PASEO_SKIP_REMOTES:-0}" == "1" ]]; then
    return
  fi

  local src="${HOME}/.local/share/code-server/User/settings.json"
  if [[ ! -f "$src" ]]; then
    log "No live code-server settings at $src; remotes keep deploy defaults"
    return
  fi

  log "Pushing live code-server settings to remotes ($src)"
  local host
  for host in "${REMOTE_HOSTS[@]}"; do
    log "  → $host"
    ssh -o BatchMode=yes "$host" 'mkdir -p ~/.local/share/code-server/User'
    rsync -az "$src" "$host:~/.local/share/code-server/User/settings.json"
    ssh -o BatchMode=yes "$host" 'systemctl --user restart paseo-code-server.service'
  done
}

sync_code_server_user_data() {
  if [[ "${PASEO_SYNC_CODE_SERVER_USER_DATA:-0}" != "1" ]]; then
    return
  fi
  if [[ "${PASEO_SKIP_CODE_SERVER:-0}" == "1" ]]; then
    return
  fi
  if [[ "${PASEO_SKIP_REMOTES:-0}" == "1" ]]; then
    log "Skipping code-server user-data sync (no remotes)"
    return
  fi
  log "Syncing code-server User/ + extensions/ to remotes"
  bash "$ROOT_DIR/scripts/code-server/sync-user-data.sh"
}

remote_sync_body() {
  local host="$1"
  local remote_home="$2"
  cat <<EOF
set -euo pipefail
BRANCH='$BRANCH'
FORK_REPO='$FORK_REPO'
REMOTE_REPO_DIR='$REMOTE_REPO_DIR'
NODE_VERSION='$NODE_VERSION'
PASEO_HOME='$remote_home'

log() {
  printf '\n[%s:%s] %s\n' "\$(date '+%H:%M:%S')" '$host' "\$*"
}

ensure_node() {
  export NVM_DIR="\${NVM_DIR:-\$HOME/.nvm}"
  if [[ ! -s "\$NVM_DIR/nvm.sh" ]]; then
    echo "nvm not found on $host" >&2
    exit 1
  fi
  # shellcheck source=/dev/null
  . "\$NVM_DIR/nvm.sh"
  if ! nvm use "\$NODE_VERSION" >/dev/null 2>&1; then
    log "Installing Node \$NODE_VERSION via nvm"
    nvm install "\$NODE_VERSION"
    nvm use "\$NODE_VERSION" >/dev/null
  fi
  log "Using Node \$(node -v)"
}

ensure_fork_remotes() {
  cd "\$HOME/\$REMOTE_REPO_DIR"
  local origin_url
  origin_url="\$(git remote get-url origin)"
  if [[ "\$origin_url" == *"iammvaibhav/paseo"* ]]; then
    return
  fi
  if [[ "\$origin_url" == *"getpaseo/paseo"* ]]; then
    log "Pointing origin at fork and preserving upstream"
    if git remote | grep -qx upstream; then
      git remote set-url upstream "\$origin_url"
      git remote set-url origin "\$FORK_REPO"
    else
      git remote rename origin upstream
      git remote add origin "\$FORK_REPO"
    fi
    return
  fi
  echo "Unexpected origin remote on $host: \$origin_url" >&2
  exit 1
}

sync_git() {
  cd "\$HOME/\$REMOTE_REPO_DIR"
  log "Fetching origin/$BRANCH"
  git fetch origin --prune
  if ! git show-ref --verify --quiet "refs/remotes/origin/\$BRANCH"; then
    echo "Branch origin/\$BRANCH not found on $host" >&2
    exit 1
  fi
  git checkout -f -B "\$BRANCH" "origin/\$BRANCH"
  log "Checked out \$BRANCH at \$(git rev-parse --short HEAD)"
}

maybe_install_deps() {
  cd "\$HOME/\$REMOTE_REPO_DIR"
  local sync_ref_file="\$HOME/.paseo-sync-ref"
  local prev="" cur
  cur="\$(git rev-parse HEAD)"
  if [[ -f "\$sync_ref_file" ]]; then
    prev="\$(cat "\$sync_ref_file")"
  fi
  if [[ -z "\$prev" ]] || git diff "\$prev" "\$cur" --name-only | grep -Eq '^(package-lock\\.json|package\\.json)$'; then
    log "Installing npm dependencies"
    npm install
  fi
  echo "\$cur" > "\$sync_ref_file"
}

install_cli_wrapper() {
  local repo_dir="\$HOME/\$REMOTE_REPO_DIR"
  local bin_dir="\$HOME/.local/bin"
  local wrapper_path="\$bin_dir/paseo"

  mkdir -p "\$bin_dir"
  # See the local install_cli_wrapper: remove any symlink/file first so we never
  # write through a symlink or trip sed -i on one.
  rm -f "\$wrapper_path"
  cat >"\$wrapper_path" <<'WRAPPER_EOF'
#!/usr/bin/env bash
set -euo pipefail
export NVM_DIR="\${NVM_DIR:-\$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
exec node --disable-warning=DEP0040 "__REPO_DIR__/packages/cli/dist/index.js" "\$@"
WRAPPER_EOF
  sed -i.bak "s|__REPO_DIR__|\${repo_dir}|g" "\$wrapper_path"
  rm -f "\${wrapper_path}.bak"
  chmod +x "\$wrapper_path"
  log "Installed CLI wrapper at \$wrapper_path"
}

daemon_path_env() {
  printf '%s' "\$HOME/.local/bin:\$PATH"
}

build_and_restart() {
  cd "\$HOME/\$REMOTE_REPO_DIR"
  log "Building server"
  npm run build:server
  install_cli_wrapper
  log "Restarting daemon (\$PASEO_HOME)"
  PATH="\$(daemon_path_env)" npx tsx packages/cli/src/index.js daemon restart --home "\$PASEO_HOME"
}

deploy_code_server() {
  if [[ '${PASEO_SKIP_CODE_SERVER:-0}' == "1" ]]; then
    log "Skipping code-server deploy (PASEO_SKIP_CODE_SERVER=1)"
    return
  fi
  cd "\$HOME/\$REMOTE_REPO_DIR"
  log "Deploying code-server"
  CODE_SERVER_VERSION='${CODE_SERVER_VERSION:-}' bash scripts/code-server/deploy.sh '$host'
}

ensure_node
ensure_fork_remotes
sync_git
if [[ '${PASEO_SKIP_DAEMON:-0}' == "1" ]]; then
  log "Skipping daemon build/restart (PASEO_SKIP_DAEMON=1)"
else
  maybe_install_deps
  build_and_restart
fi
deploy_code_server
log "Done"
EOF
}

sync_remote_host() {
  local host="$1"
  local remote_home="$2"
  log "Syncing remote host $host"
  ssh -o BatchMode=yes "$host" "bash -s" < <(remote_sync_body "$host" "$remote_home")
}

remote_paseo_home() {
  local host="$1"
  case "$host" in
    blrofc3) echo "/home/vaibhav/.paseo" ;;
    iammvaibhav) echo "/home/ubuntu/.paseo" ;;
    *) die "Unknown remote host: $host" ;;
  esac
}

main() {
  cd "$ROOT_DIR"

  if [[ "${PASEO_SKIP_LOCAL:-0}" != "1" ]]; then
    require_clean_tree
    ensure_fork_remotes
    ensure_node
    sync_local_git
    if [[ "${PASEO_SKIP_DAEMON:-0}" != "1" ]]; then
      build_server
      install_cli_wrapper "$ROOT_DIR"
      restart_local_daemon
    else
      log "Skipping local daemon build/restart (PASEO_SKIP_DAEMON=1)"
    fi
    deploy_local_code_server
  fi

  if [[ "${PASEO_SKIP_REMOTES:-0}" != "1" ]]; then
    local host
    for host in "${REMOTE_HOSTS[@]}"; do
      sync_remote_host "$host" "$(remote_paseo_home "$host")"
    done
  fi

  sync_code_server_settings_to_remotes
  sync_code_server_user_data

  log "Sync complete"
}

main "$@"