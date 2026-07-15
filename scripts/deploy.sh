#!/usr/bin/env bash
# Sync the custom Paseo branch across local + remote dev hosts.
#
# Local workflow (fork-based):
#   1. Auto-commit any uncommitted changes (claude-written message, else timestamp)
#   2. Fetch upstream, mirror origin/main ← upstream/main (fast-forward)
#   3. Rebase the custom branch onto upstream/main; on conflict, an agent (claude)
#      resolves them and the rebase continues automatically
#   4. Push the branch to origin (iammvaibhav/paseo fork)
#   5. Build server + restart the production-style daemon (~/.paseo)
#   6. Update local code-server (binary + config + LaunchAgent + bridge extension)
#
# Remote workflow (blrofc3, iammvaibhav):
#   1. Ensure origin points at the fork and tracks the custom branch
#   2. Pull the branch from origin, install deps if needed, build, restart daemon
#   3. Update code-server (binary + config + systemd user unit)
#
# Usage:
#   ./scripts/deploy.sh            # full sync + deploy (local + remotes)
#   ./scripts/deploy.sh --help     # show arguments and env variables
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
#   PASEO_COMMIT_MSG_MODEL=...        # claude model for auto-commit messages (default Haiku 4.5)
#   PASEO_CONFLICT_MODEL=...          # claude model for conflict resolution (default Opus 4.8)
#   PASEO_CONFLICT_EFFORT=xhigh       # effort for conflict resolution (low|medium|high|xhigh|max)
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

# Models for the claude-driven steps. Commit messages are a light task (Haiku);
# conflict resolution is hard and gets Opus at extra-high effort.
COMMIT_MSG_MODEL="${PASEO_COMMIT_MSG_MODEL:-claude-haiku-4-5-20251001}"
CONFLICT_MODEL="${PASEO_CONFLICT_MODEL:-claude-opus-4-8}"
CONFLICT_EFFORT="${PASEO_CONFLICT_EFFORT:-xhigh}"

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

generate_commit_message() {
  # A claude-written subject line from the staged diff, falling back to a
  # timestamped message when the claude CLI is unavailable or errors.
  local fallback
  fallback="chore: sync $(date '+%Y-%m-%d %H:%M:%S')"
  if ! command -v claude >/dev/null 2>&1; then
    printf '%s\n' "$fallback"
    return
  fi
  local msg
  msg="$(
    {
      git -C "$ROOT_DIR" diff --cached --stat
      echo
      git -C "$ROOT_DIR" diff --cached | head -c 12000
    } | claude -p --model "$COMMIT_MSG_MODEL" 'Write a single concise git commit subject line (imperative mood, under 72 chars, no body, no surrounding quotes or backticks) summarizing this staged diff. Output only the subject line.' 2>/dev/null | head -n1)"
  msg="${msg#\"}"
  msg="${msg%\"}"
  msg="${msg#\`}"
  msg="${msg%\`}"
  if [[ -n "$msg" ]]; then
    printf '%s\n' "$msg"
  else
    printf '%s\n' "$fallback"
  fi
}

autocommit_local_changes() {
  if [[ -z "$(git -C "$ROOT_DIR" status --porcelain)" ]]; then
    return
  fi
  log "Uncommitted changes found; committing before sync"
  git -C "$ROOT_DIR" add -A
  local msg
  msg="$(generate_commit_message)"
  log "Commit message: $msg"
  # Runs the pre-commit hook (lint/format/typecheck); a failure aborts the sync
  # so we never push broken code.
  git -C "$ROOT_DIR" commit -m "$msg"
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

update_origin_main() {
  # Mirror the fork's main to the freshly-fetched upstream/main (fast-forward
  # only; if the fork's main diverged we warn and carry on).
  log "Updating $ORIGIN_REMOTE/main from $UPSTREAM_REMOTE/main"
  if ! git -C "$ROOT_DIR" push "$ORIGIN_REMOTE" \
    "refs/remotes/$UPSTREAM_REMOTE/main:refs/heads/main"; then
    log "Warning: could not fast-forward $ORIGIN_REMOTE/main (diverged?); continuing"
  fi
}

resolve_conflicts_with_agent() {
  if ! command -v claude >/dev/null 2>&1; then
    die "Rebase conflict but the claude CLI was not found; resolve manually (git rebase --abort to bail)."
  fi
  local files
  files="$(git -C "$ROOT_DIR" diff --name-only --diff-filter=U)"
  log "Resolving conflicts with claude:$(printf ' %s' $files)"
  if ! (
    cd "$ROOT_DIR" && claude -p --model "$CONFLICT_MODEL" --effort "$CONFLICT_EFFORT" "You are resolving Git rebase conflicts while rebasing the custom fork branch '$BRANCH' onto '$UPSTREAM_REMOTE/main'. Edit each conflicted file to remove ALL conflict markers (<<<<<<<, =======, >>>>>>>) and produce a correct merge that keeps upstream's changes while preserving this fork's customizations. Do not run any git commands. Conflicted files:$(printf ' %s' $files)" --dangerously-skip-permissions >/dev/null 2>&1
  ); then
    die "claude conflict resolution failed; resolve manually (git rebase --abort to bail)."
  fi
}

rebase_onto_upstream() {
  log "Rebasing $BRANCH onto $UPSTREAM_REMOTE/main"
  if git -C "$ROOT_DIR" rebase "$UPSTREAM_REMOTE/main"; then
    return
  fi
  # Conflicts: let the agent resolve, stage, and continue — repeating for each
  # conflicting commit — then auto-push happens back in sync_local_git.
  local step=0
  while [[ -d "$ROOT_DIR/.git/rebase-merge" || -d "$ROOT_DIR/.git/rebase-apply" ]]; do
    step=$((step + 1))
    if [[ $step -gt 30 ]]; then
      die "Rebase still unresolved after $step steps; bail with: git -C '$ROOT_DIR' rebase --abort"
    fi
    if [[ -n "$(git -C "$ROOT_DIR" diff --name-only --diff-filter=U)" ]]; then
      resolve_conflicts_with_agent
      git -C "$ROOT_DIR" add -A
      # Never proceed with leftover markers.
      if git -C "$ROOT_DIR" diff --cached --check 2>/dev/null | grep -q "conflict marker"; then
        die "Conflict markers remain after agent resolution; resolve manually (git rebase --abort to bail)."
      fi
    fi
    if ! GIT_EDITOR=true git -C "$ROOT_DIR" rebase --continue >/tmp/paseo-rebase.log 2>&1; then
      if grep -qi "no changes" /tmp/paseo-rebase.log; then
        GIT_EDITOR=true git -C "$ROOT_DIR" rebase --skip >/dev/null 2>&1 || true
      fi
    fi
  done
}

sync_local_git() {
  log "Fetching $UPSTREAM_REMOTE and $ORIGIN_REMOTE"
  git -C "$ROOT_DIR" fetch "$UPSTREAM_REMOTE" --prune
  git -C "$ROOT_DIR" fetch "$ORIGIN_REMOTE" --prune

  if ! git -C "$ROOT_DIR" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    die "Local branch '$BRANCH' does not exist."
  fi

  git -C "$ROOT_DIR" checkout "$BRANCH"
  update_origin_main
  rebase_onto_upstream
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
  bash "$ROOT_DIR/scripts/code-server/install.sh" local
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
  CODE_SERVER_VERSION='${CODE_SERVER_VERSION:-}' bash scripts/code-server/install.sh '$host'
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

print_help() {
  cat <<EOF
Paseo deploy — sync the custom fork branch and deploy across local + remote hosts.

Usage:
  ./scripts/deploy.sh                 Full run: auto-commit, rebase onto upstream,
                                      push, build + restart daemon, deploy code-server.
  ./scripts/deploy.sh -h | --help     Show this help.

Takes no positional arguments; behavior is controlled by env variables.

What a full run does (local Mac):
  1. Auto-commit uncommitted changes (message via claude, else timestamp)
  2. Fetch upstream, fast-forward origin/main to upstream/main
  3. Rebase '$BRANCH' onto $UPSTREAM_REMOTE/main (agent resolves conflicts)
  4. Push branch to $ORIGIN_REMOTE, build server, restart daemon ($LOCAL_PASEO_HOME)
  5. Deploy code-server (binary + config + paseo-bridge extension)
Then repeats git sync + code-server deploy on: ${REMOTE_HOSTS[*]}.

Scope flags (set to 1):
  PASEO_SKIP_LOCAL                 Skip the local Mac entirely (remotes only)
  PASEO_SKIP_REMOTES              Skip all remote hosts (local only)
  PASEO_SKIP_DAEMON              Skip daemon build/restart (git + code-server only)
  PASEO_SKIP_CODE_SERVER         Skip code-server deploy everywhere
  PASEO_SKIP_CODE_SERVER_EXTENSION  Skip installing the paseo-bridge extension
  PASEO_SYNC_CODE_SERVER_USER_DATA  Also rsync code-server User/ + extensions/ to remotes

Model selection (claude-driven steps):
  PASEO_COMMIT_MSG_MODEL          Model for auto-commit messages (default: $COMMIT_MSG_MODEL)
  PASEO_CONFLICT_MODEL           Model for rebase conflict resolution (default: $CONFLICT_MODEL)
  PASEO_CONFLICT_EFFORT          Effort for conflict resolution (default: $CONFLICT_EFFORT)

Other:
  CODE_SERVER_VERSION            Pin code-server version (omit for latest)
  PASEO_NODE_VERSION             Node version via nvm (default from .tool-versions: $NODE_VERSION)
  PASEO_CUSTOM_BRANCH            Custom branch (default: $BRANCH)
  PASEO_UPSTREAM_REMOTE          Upstream remote (default: $UPSTREAM_REMOTE)
  PASEO_ORIGIN_REMOTE            Fork remote (default: $ORIGIN_REMOTE)
  PASEO_LOCAL_HOME               Local daemon home (default: $LOCAL_PASEO_HOME)

Per-host code-server install (run on a single machine):
  ./scripts/code-server/install.sh <local|${REMOTE_HOSTS[0]}|${REMOTE_HOSTS[1]}>

Examples:
  PASEO_SKIP_REMOTES=1 ./scripts/deploy.sh          # local only
  PASEO_SKIP_DAEMON=1  ./scripts/deploy.sh          # code-server + settings, no daemon
EOF
}

main() {
  case "${1:-}" in
    -h | --help | help)
      print_help
      exit 0
      ;;
  esac

  cd "$ROOT_DIR"

  if [[ "${PASEO_SKIP_LOCAL:-0}" != "1" ]]; then
    ensure_fork_remotes
    ensure_node
    autocommit_local_changes
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