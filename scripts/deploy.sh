#!/usr/bin/env bash
# Sync the custom Paseo branch across local + remote dev hosts.
#
# Local workflow (fork-based):
#   1. Auto-commit any uncommitted changes (claude message; on pre-commit failure,
#      grok fixes checks and commits)
#   2. Fetch upstream, mirror origin/main ← upstream/main (fast-forward)
#   3. Merge upstream/main into the custom branch; on conflict, grok resolves,
#      stages, fixes pre-commit checks, and completes the merge commit
#   4. Push the branch to origin (iammvaibhav/paseo fork)
#   5. Build server + restart the production-style daemon (~/.paseo)
#   6. Update local code-server (binary + config + LaunchAgent + bridge extension)
#   7. Build the desktop app (unsigned) and install it as "Paseo Test.app"
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
#   PASEO_BUILD_DESKTOP=0             # skip building the desktop app (built by default)
#   PASEO_DESKTOP_TEST_APP=...        # install path for the desktop build (default /Applications/Paseo Test.app)
#   PASEO_SYNC_CODE_SERVER_USER_DATA=1  # also rsync User/ + extensions/ local → remotes
#   CODE_SERVER_VERSION=4.127.0       # pin code-server; omit for latest
#   PASEO_COMMIT_MSG_MODEL=...        # claude model for auto-commit messages (default Haiku 4.5)
#   PASEO_CONFLICT_MODEL=...          # grok model for conflict/commit fix (default grok-4.5)
#   PASEO_CONFLICT_EFFORT=high        # effort for conflict/commit fix (low|medium|high|xhigh|max)
#   PASEO_CONFLICT_MAX_TURNS=80       # max agent turns for conflict/commit fix
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

# Commit messages stay on claude (Haiku). Conflict resolution + pre-commit repair
# use the grok CLI at high reasoning effort (Grok 4.5 High).
COMMIT_MSG_MODEL="${PASEO_COMMIT_MSG_MODEL:-claude-haiku-4-5-20251001}"
CONFLICT_MODEL="${PASEO_CONFLICT_MODEL:-grok-4.5}"
CONFLICT_EFFORT="${PASEO_CONFLICT_EFFORT:-high}"
CONFLICT_MAX_TURNS="${PASEO_CONFLICT_MAX_TURNS:-80}"

# Where the unsigned desktop test build is installed (local Mac only).
DESKTOP_TEST_APP="${PASEO_DESKTOP_TEST_APP:-/Applications/Paseo Test.app}"

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

# Run a headless grok agent with streaming NDJSON → human output.
# Args: log_path, prompt
run_grok_agent() {
  local log_path="$1"
  local prompt="$2"
  if ! command -v grok >/dev/null 2>&1; then
    die "grok CLI was not found (needed for automated fix/commit)."
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    die "python3 was not found (needed to stream grok output)."
  fi
  local stream_filter="$ROOT_DIR/scripts/stream-grok-ndjson.py"
  if [[ ! -f "$stream_filter" ]]; then
    die "Missing $stream_filter (needed to stream grok output)."
  fi
  log "Streaming agent output (raw NDJSON also saved to $log_path):"
  (
    cd "$ROOT_DIR" || exit 1
    set -o pipefail
    grok \
      --model "$CONFLICT_MODEL" \
      --effort "$CONFLICT_EFFORT" \
      --always-approve \
      --max-turns "$CONFLICT_MAX_TURNS" \
      --output-format streaming-json \
      -p "$prompt" 2>&1 \
      | python3 -u "$stream_filter" "$log_path"
  )
}

# True when a merge is in progress (MERGE_HEAD exists).
merge_in_progress() {
  [[ -f "$ROOT_DIR/.git/MERGE_HEAD" ]]
}

# Stage everything and ensure no conflict markers / unmerged paths remain.
stage_and_verify_no_conflicts() {
  git -C "$ROOT_DIR" add -A
  if git -C "$ROOT_DIR" diff --cached --check 2>/dev/null | grep -qi "conflict marker"; then
    return 1
  fi
  if [[ -n "$(git -C "$ROOT_DIR" diff --name-only --diff-filter=U)" ]]; then
    return 1
  fi
  return 0
}

# When a plain `git commit` fails (almost always pre-commit lint/format/typecheck),
# hand the tree to grok to fix and complete the commit.
fix_precommit_and_commit() {
  local mode="$1" # "autocommit" | "merge"
  local commit_msg="${2:-}"
  local log_path="/tmp/paseo-${mode}-fix.log"
  local prompt

  if [[ "$mode" == "merge" ]]; then
    prompt="You are finishing an in-progress git merge of ${UPSTREAM_REMOTE}/main into branch '${BRANCH}' in ${ROOT_DIR}.

Conflicts should already be resolved (or nearly so). Your job:
1. Ensure every conflict marker (<<<<<<<, =======, >>>>>>>) is gone.
2. Stage all resolved files: git add -A
3. Run pre-commit quality checks and FIX any failures:
   - npm run format   (or npm run format:files -- <paths>)
   - npm run lint -- <paths> when needed
   - npm run typecheck (or package-scoped typecheck)
4. Complete the merge with: git commit --no-edit
   (uses the existing MERGE_MSG; do not invent a new subject)
5. Keep iterating until git commit succeeds and MERGE_HEAD is gone.

Rules:
- Do NOT git merge --abort, force-push, reset --hard, or rewrite history.
- Preserve this fork's customizations while keeping upstream changes.
- Prefer targeted format/lint on changed files over full-repo rewrites.
- When done, the repo must no longer be in a merging state."
  else
    prompt="You are finishing an auto-commit of local changes on branch '${BRANCH}' in ${ROOT_DIR}.

Desired commit subject (use exactly this message):
${commit_msg}

Your job:
1. Stage relevant changes: git add -A (or a sensible subset if something must stay untracked)
2. Run pre-commit quality checks and FIX any failures:
   - npm run format / format:files
   - npm run lint
   - npm run typecheck
3. Commit with: git commit -m $(printf '%q' "$commit_msg")
4. Keep iterating until the commit succeeds.

Rules:
- Do NOT force-push, reset --hard, or rewrite history.
- Prefer targeted fixes over broad refactors.
- When done, git status should show a clean worktree (or only intentional leftovers)."
  fi

  log "Pre-commit/commit failed; asking grok ($CONFLICT_MODEL, effort=$CONFLICT_EFFORT) to fix checks and complete the ${mode} commit"
  if ! run_grok_agent "$log_path" "$prompt"; then
    die "grok ${mode} fix failed; resolve manually. Log: $log_path"
  fi

  if [[ "$mode" == "merge" ]]; then
    if merge_in_progress; then
      # Agent may have fixed files but not committed — try once more.
      if stage_and_verify_no_conflicts && git -C "$ROOT_DIR" commit --no-edit; then
        log "Merge commit created after agent fix"
        return
      fi
      die "Still merging after agent fix; resolve manually (git status). Log: $log_path"
    fi
    log "Merge commit completed by agent"
    return
  fi

  # autocommit: ensure something was committed or tree is clean enough
  if [[ -n "$(git -C "$ROOT_DIR" status --porcelain)" ]]; then
    # One script-side retry if agent fixed hooks but didn't commit.
    if [[ -n "$(git -C "$ROOT_DIR" diff --cached --name-only)" ]] \
      && git -C "$ROOT_DIR" commit -m "$commit_msg"; then
      log "Auto-commit created after agent fix"
      return
    fi
    die "Uncommitted changes remain after agent fix; resolve manually. Log: $log_path"
  fi
  log "Auto-commit completed by agent"
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
  # Runs the pre-commit hook (lint/format/typecheck). On failure, grok fixes and commits.
  if git -C "$ROOT_DIR" commit -m "$msg"; then
    return
  fi
  fix_precommit_and_commit "autocommit" "$msg"
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
  local files
  files="$(git -C "$ROOT_DIR" diff --name-only --diff-filter=U)"
  local count
  count="$(printf '%s\n' "$files" | grep -c . || true)"
  local log_path="/tmp/paseo-merge-resolve.log"
  log "Resolving $count conflicted file(s) with grok $CONFLICT_MODEL (effort=$CONFLICT_EFFORT) in one pass:"
  printf '  - %s\n' $files

  # Agent resolves markers, stages, fixes pre-commit hooks, and completes the merge commit.
  local prompt
  prompt="You are resolving the conflicts from 'git merge ${UPSTREAM_REMOTE}/main' into the custom fork branch '${BRANCH}' in ${ROOT_DIR}.

Do ALL of the following in one session:
1. Edit EVERY conflicted file to remove ALL conflict markers (<<<<<<<, =======, >>>>>>>) and produce a correct merge that keeps upstream's changes while preserving this fork's customizations.
2. Stage everything: git add -A
3. Run pre-commit quality checks and FIX failures (npm run format / lint / typecheck as needed; use targeted paths when possible).
4. Complete the merge with: git commit --no-edit
5. Iterate until the merge commit succeeds and MERGE_HEAD is gone.

Conflicted files:$(printf ' %s' $files)

Rules:
- Do NOT git merge --abort, force-push, reset --hard, or rewrite published history.
- Leave no conflict markers behind.
- Prefer targeted format/lint over full-repo thrash."

  if ! run_grok_agent "$log_path" "$prompt"; then
    die "grok conflict resolution failed; resolve manually (git merge --abort to bail). Log: $log_path"
  fi
}

merge_upstream() {
  log "Merging $UPSTREAM_REMOTE/main into $BRANCH"
  if git -C "$ROOT_DIR" merge --no-edit "$UPSTREAM_REMOTE/main"; then
    log "Clean merge (or already up to date)"
    return
  fi

  # Conflicts: agent resolves, stages, fixes checks, and should create the merge commit.
  resolve_conflicts_with_agent

  if ! merge_in_progress; then
    log "Merge commit created by agent"
    return
  fi

  # Agent may have fixed files without committing — finish on the script side first.
  if ! stage_and_verify_no_conflicts; then
    log "Conflicts or markers remain; asking agent to finish"
    fix_precommit_and_commit "merge"
    return
  fi

  if git -C "$ROOT_DIR" commit --no-edit; then
    log "Merge commit created"
    return
  fi

  # Pre-commit hook failed after a clean stage — agent fixes checks and commits.
  fix_precommit_and_commit "merge"
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
  merge_upstream
  log "Pushing $BRANCH to $ORIGIN_REMOTE (force-with-lease)"
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

build_desktop_app() {
  if [[ "${PASEO_BUILD_DESKTOP:-1}" == "0" ]]; then
    log "Skipping desktop app build (PASEO_BUILD_DESKTOP=0)"
    return
  fi
  # Unsigned local test build. Bare `build:desktop` hangs on notarization and an
  # ad-hoc hardened build crashes at launch (dyld team-ID mismatch), so disable
  # both — see docs/development.md § Local desktop builds.
  log "Building desktop app (unsigned test build) — this takes a few minutes"
  (
    cd "$ROOT_DIR"
    CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:desktop -- \
      -c.mac.notarize=false -c.mac.hardenedRuntime=false
  )
  # electron-builder writes Paseo.app under packages/desktop/release/mac*/.
  local built
  built="$(find "$ROOT_DIR/packages/desktop/release" -maxdepth 2 -name 'Paseo.app' -type d 2>/dev/null | head -1)"
  if [[ -z "$built" ]]; then
    die "Desktop build finished but no Paseo.app found under packages/desktop/release"
  fi
  log "Installing $built → $DESKTOP_TEST_APP"
  rm -rf "$DESKTOP_TEST_APP"
  cp -R "$built" "$DESKTOP_TEST_APP"
  log "Desktop test app installed at $DESKTOP_TEST_APP"
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
  local tunnel_provider="$3"
  cat <<EOF
set -euo pipefail
BRANCH='$BRANCH'
FORK_REPO='$FORK_REPO'
REMOTE_REPO_DIR='$REMOTE_REPO_DIR'
NODE_VERSION='$NODE_VERSION'
PASEO_HOME='$remote_home'
TUNNEL_PROVIDER='$tunnel_provider'

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
  # Drive the webhook tunnel via env (not config.json) so an older daemon's strict
  # config schema is never at risk; the new daemon reads PASEO_TUNNEL_PROVIDER and
  # resolves its own public base URL (e.g. the Tailscale MagicDNS name). Export the
  # vars (rather than an inline env-prefix) so the spawned daemon inherits them —
  # a quoted array expansion as an env-prefix is parsed as a command, not assignments.
  if [[ -n "\$TUNNEL_PROVIDER" ]]; then
    export PASEO_TUNNEL_PROVIDER="\$TUNNEL_PROVIDER"
    # cloudflared quick tunnels are run by the daemon itself; tailscale-funnel is
    # managed out-of-band (tailscaled + ensure_remote_funnel), so no autostart.
    if [[ "\$TUNNEL_PROVIDER" == "cloudflared" ]]; then
      export PASEO_TUNNEL_AUTOSTART=1
    fi
    log "Tunnel provider: \$TUNNEL_PROVIDER"
  fi
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
  local tunnel_provider="$3"
  log "Syncing remote host $host"
  ssh -o BatchMode=yes "$host" "bash -s" < <(remote_sync_body "$host" "$remote_home" "$tunnel_provider")
}

remote_paseo_home() {
  local host="$1"
  case "$host" in
    blrofc3) echo "/home/vaibhav/.paseo" ;;
    iammvaibhav) echo "/home/ubuntu/.paseo" ;;
    *) die "Unknown remote host: $host" ;;
  esac
}

# Which webhook tunnel provider a host uses. Empty = none (webhooks still work if
# the host is exposed some other way). blrofc3 uses Tailscale Funnel.
remote_tunnel_provider() {
  local host="$1"
  case "$host" in
    blrofc3) echo "tailscale-funnel" ;;
    iammvaibhav) echo "cloudflared" ;;
    *) echo "" ;;
  esac
}

# Ensure cloudflared is installed on hosts that use it. Quick tunnels need no
# account or domain; the daemon runs `cloudflared tunnel --url` itself.
ensure_remote_cloudflared() {
  local host="$1"
  local tunnel_provider="$2"
  if [[ "$tunnel_provider" != "cloudflared" ]]; then
    return
  fi
  log "Ensuring cloudflared on $host"
  ssh -o BatchMode=yes "$host" "bash -s" <<'REMOTE'
set -uo pipefail
say() { printf '  [cloudflared] %s\n' "$*"; }
if command -v cloudflared >/dev/null 2>&1; then
  say "already installed ($(command -v cloudflared))"
  exit 0
fi
case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) say "unsupported arch $(uname -m); install cloudflared manually"; exit 0 ;;
esac
url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}"
tmp="$(mktemp)"
say "downloading ${arch} binary"
if ! curl -fsSL "$url" -o "$tmp"; then
  say "download failed; install cloudflared manually"
  rm -f "$tmp"
  exit 0
fi
chmod +x "$tmp"
if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  sudo mv "$tmp" /usr/local/bin/cloudflared && say "installed to /usr/local/bin/cloudflared"
else
  mkdir -p "$HOME/.local/bin"
  mv "$tmp" "$HOME/.local/bin/cloudflared" && say "installed to ~/.local/bin/cloudflared"
fi
cloudflared --version 2>/dev/null | head -1 | sed 's/^/  [cloudflared] /' || true
REMOTE
}

# Ensure a Tailscale Funnel is up on the host, forwarding public HTTPS to the
# daemon's listen address so /hooks/* is reachable from the internet. Idempotent:
# skips when a funnel to the same target already exists. Only runs for hosts whose
# provider is tailscale-funnel. Reads the daemon's listen address from config.json.
ensure_remote_funnel() {
  local host="$1"
  local remote_home="$2"
  local tunnel_provider="$3"
  if [[ "$tunnel_provider" != "tailscale-funnel" ]]; then
    return
  fi
  if [[ "${PASEO_SKIP_FUNNEL:-0}" == "1" ]]; then
    log "Skipping Tailscale Funnel setup on $host (PASEO_SKIP_FUNNEL=1)"
    return
  fi
  log "Ensuring Tailscale Funnel on $host"
  ssh -o BatchMode=yes "$host" "PASEO_HOME='$remote_home' bash -s" <<'REMOTE'
set -uo pipefail
say() { printf '  [funnel] %s\n' "$*"; }
cfg="$PASEO_HOME/config.json"
if ! command -v tailscale >/dev/null 2>&1; then
  say "tailscale not found; skipping"
  exit 0
fi
listen="$(grep -oE '"listen"[[:space:]]*:[[:space:]]*"[^"]+"' "$cfg" 2>/dev/null | head -1 | grep -oE '"[^"]+"' | tail -1 | tr -d '"')"
listen="${listen:-127.0.0.1:6767}"
target="http://${listen/0.0.0.0/127.0.0.1}"
if tailscale funnel status 2>/dev/null | grep -qF "$target"; then
  say "already proxying to $target"
  exit 0
fi
if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  if sudo tailscale set --operator="$USER" 2>/dev/null; then
    say "operator set to $USER"
  else
    say "could not set operator (continuing)"
  fi
fi
if tailscale funnel --bg "$target" >/dev/null 2>&1; then
  say "funnel up -> $target"
  tailscale funnel status 2>/dev/null | grep -E "Funnel on|proxy" | sed 's/^/  [funnel] /' || true
else
  say "failed to start; run manually: sudo tailscale set --operator=$USER && tailscale funnel --bg $target"
fi
REMOTE
}

print_help() {
  cat <<EOF
Paseo deploy — sync the custom fork branch and deploy across local + remote hosts.

Usage:
  ./scripts/deploy.sh                 Full run: auto-commit, merge upstream,
                                      push, build + restart daemon, deploy code-server.
  ./scripts/deploy.sh -h | --help     Show this help.

Takes no positional arguments; behavior is controlled by env variables.

What a full run does (local Mac):
  1. Auto-commit uncommitted changes (message via claude; on pre-commit failure,
     grok fixes checks and commits)
  2. Fetch upstream, fast-forward origin/main to upstream/main
  3. Merge $UPSTREAM_REMOTE/main into '$BRANCH' (on conflict, grok resolves, stages,
     fixes pre-commit checks, and completes the merge commit — streaming output)
  4. Push branch to $ORIGIN_REMOTE, build server, restart daemon ($LOCAL_PASEO_HOME)
  5. Deploy code-server (binary + config + paseo-bridge extension)
  6. Build the desktop app (unsigned) and install it as "$DESKTOP_TEST_APP"
Then repeats git sync + code-server deploy on: ${REMOTE_HOSTS[*]}.

Scope flags (set to 1 unless noted):
  PASEO_SKIP_LOCAL                 Skip the local Mac entirely (remotes only)
  PASEO_SKIP_REMOTES              Skip all remote hosts (local only)
  PASEO_SKIP_DAEMON              Skip daemon build/restart (git + code-server only)
  PASEO_SKIP_CODE_SERVER         Skip code-server deploy everywhere
  PASEO_SKIP_CODE_SERVER_EXTENSION  Skip installing the paseo-bridge extension
  PASEO_BUILD_DESKTOP=0            Skip the desktop app build (built by default)
  PASEO_DESKTOP_TEST_APP=<path>    Desktop install path (default: $DESKTOP_TEST_APP)
  PASEO_SYNC_CODE_SERVER_USER_DATA  Also rsync code-server User/ + extensions/ to remotes
  PASEO_SKIP_FUNNEL               Skip ensuring the Tailscale Funnel on funnel hosts (blrofc3)

Model selection:
  PASEO_COMMIT_MSG_MODEL          claude model for auto-commit messages (default: $COMMIT_MSG_MODEL)
  PASEO_CONFLICT_MODEL           grok model for conflict/commit fix (default: $CONFLICT_MODEL)
  PASEO_CONFLICT_EFFORT          Reasoning effort for conflict/commit fix (default: $CONFLICT_EFFORT)
  PASEO_CONFLICT_MAX_TURNS       Max agent turns for conflict/commit fix (default: $CONFLICT_MAX_TURNS)

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
    build_desktop_app
  fi

  if [[ "${PASEO_SKIP_REMOTES:-0}" != "1" ]]; then
    local host
    for host in "${REMOTE_HOSTS[@]}"; do
      local rhome rprovider
      rhome="$(remote_paseo_home "$host")"
      rprovider="$(remote_tunnel_provider "$host")"
      ensure_remote_cloudflared "$host" "$rprovider"
      sync_remote_host "$host" "$rhome" "$rprovider"
      ensure_remote_funnel "$host" "$rhome" "$rprovider"
    done
  fi

  sync_code_server_settings_to_remotes
  sync_code_server_user_data

  log "Sync complete"
}

main "$@"