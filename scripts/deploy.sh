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
#   5. In parallel (after the push):
#        - each remote host (git pull + build + daemon + code-server)
#        - local daemon (build server first, then restart) + local code-server
#        - desktop app build/install
#      Local server build runs before desktop so they don't race on packages/*/dist.
#
# Remote workflow (blrofc3, iammvaibhav):
#   1. Ensure origin points at the fork and tracks the custom branch
#   2. Pull the branch from origin, install deps if needed, build, restart daemon
#   3. Update code-server (binary + config + systemd user unit)
#   4. Update the Commander Voice node (npm deps + env file + launchd/systemd unit)
#
# Usage:
#   ./scripts/deploy.sh            # full sync + deploy (local + remotes)
#   ./scripts/deploy.sh --help     # show arguments and env variables
#
# Orchestrator modes (auto-detected by `uname -s`):
#   macOS (MacBook)   — as before: local = MacBook (daemon + desktop build/install),
#                       remotes = blrofc3 + iammvaibhav.
#   Linux (iammvaibhav) — local = iammvaibhav (daemon restart + nudge + services),
#                       remotes = blrofc3 (WireGuard). The MacBook is a desktop-only
#                       target: the job ssh's in (PASEO_MACBOOK_HOST, default
#                       "macbook" = 10.7.0.2), git-syncs the checkout, and runs
#                       PASEO_DESKTOP_ONLY=1 to build/quit/replace/relaunch Paseo.app.
#                       The MacBook job is reachability-gated and NEVER fatal — if
#                       the MacBook is down or its checkout is dirty/diverged,
#                       iammvaibhav + remotes still deploy. The MacBook daemon is
#                       deliberately NOT restarted (paseo-dev agents stay untouched
#                       until the migration is complete).
#
# Overrides:
#   PASEO_CUSTOM_BRANCH=vaibhav/customizations
#   PASEO_NODE_VERSION=22
#   PASEO_LOCAL_HOME=$HOME/.paseo
#   PASEO_SKIP_REMOTES=1              # local only
#   PASEO_SKIP_LOCAL=1                # remotes only
#   PASEO_REMOTE_HOSTS="blrofc3"      # subset of remotes (space-separated); default all
#   PASEO_SKIP_DAEMON=1               # skip daemon build/restart; still sync git,
#                                     #   deploy code-server, and push settings
#   PASEO_DEPLOY_NUDGE=0              # disable the self-wake nudge (default ON):
#                                     #   running agents are snapshotted before each
#                                     #   daemon restart and nudged after it comes
#                                     #   back healthy, so they resurrect and resume
#                                     #   without a human (never fails the deploy)
#   PASEO_SKIP_CODE_SERVER=1          # skip code-server deploy everywhere
#   PASEO_SKIP_STALL_CRON=1           # skip installing the stall-check cron on every host
#   PASEO_SKIP_COMMANDER_VOICE=1      # skip Commander Voice node deploy everywhere
#   PASEO_COMMANDER_VOICE_PASSWORD=... # daemon password for the voice node env file
#                                     #   (write-once secret; NEVER commit — deploy
#                                     #   writes it into ~/.config/commander-voice/env
#                                     #   chmod 600 on each host, unset = keep existing)
#   GEMINI_API_KEY=...                # Gemini Live key for the voice node env file
#   PASEO_BUILD_DESKTOP=0             # skip building the desktop app (built by default)
#   PASEO_DESKTOP_ONLY=1              # ONLY build/install/relaunch desktop (no git/remotes/daemon)
#   PASEO_DESKTOP_APP=...             # install path (default /Applications/Paseo.app)
#   PASEO_DESKTOP_TEST_APP=...        # COMPAT alias for PASEO_DESKTOP_APP
#   PASEO_DEPLOY_FOREGROUND=1         # do not self-detach (interactive / debug)
#   PASEO_DEPLOY_LOG_DIR=...          # durable log root (default ~/.paseo/deploy-logs)
#   PASEO_SYNC_CODE_SERVER_USER_DATA=1  # also rsync User/ + extensions/ local → remotes
#   CODE_SERVER_VERSION=4.127.0       # pin code-server; omit for latest
#   PASEO_COMMIT_MSG_MODEL=...        # claude model for auto-commit messages (default Haiku 4.5)
#   PASEO_CONFLICT_MODEL=...          # grok model for conflict/commit fix (default grok-4.5)
#   PASEO_CONFLICT_EFFORT=high        # effort for conflict/commit fix (low|medium|high|xhigh|max)
#   PASEO_CONFLICT_MAX_TURNS=80       # max agent turns for conflict/commit fix
#
# Detach + logs:
#   By default deploy re-launches itself in a NEW session (start_new_session) so an
#   agent tool cancel (SIGTERM on the process group) cannot kill mid-deploy. Daemon
#   restarts were already detached; the parent wait/desktop/remotes were not — that
#   is what this fixes. Follow progress at ~/.paseo/deploy-logs/latest.log (and the
#   per-run directory it points at). Set PASEO_DEPLOY_FOREGROUND=1 to stay attached.
#
#   PASEO_DEPLOY_DETACHED is INTERNAL. Never set it by hand. Inherited stale
#   PASEO_DEPLOY_DETACHED / PASEO_DEPLOY_RUN_DIR / PASEO_DEPLOY_LOG from a previous
#   agent shell are ignored unless this process holds the matching detach token
#   written for its run dir. That is what prevents tool-cancel from killing deploy.
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
# Orchestrator mode: macOS = MacBook (desktop local), Linux = iammvaibhav (desktop
# driven over ssh). Everything else falls back to the Darwin path.
ORCHESTRATOR_OS="$(uname -s)"
IS_MAC_ORCHESTRATOR=0
if [[ "$ORCHESTRATOR_OS" == "Darwin" ]]; then
  IS_MAC_ORCHESTRATOR=1
fi

# Allow a space-separated subset, e.g. PASEO_REMOTE_HOSTS="blrofc3"
if [[ -n "${PASEO_REMOTE_HOSTS:-}" ]]; then
  # shellcheck disable=SC2206
  REMOTE_HOSTS=(${PASEO_REMOTE_HOSTS})
elif [[ "$IS_MAC_ORCHESTRATOR" == "1" ]]; then
  REMOTE_HOSTS=(blrofc3 iammvaibhav)
else
  # iammvaibhav orchestrator: blrofc3 is the only full remote; the MacBook is a
  # desktop-only job (macbook_desktop_job), reachability-gated and non-fatal.
  REMOTE_HOSTS=(blrofc3)
fi

# MacBook desktop host (used only when deploy runs on iammvaibhav).
MACBOOK_HOST="${PASEO_MACBOOK_HOST:-macbook}"
MACBOOK_REPO_DIR="${PASEO_MACBOOK_REPO_DIR:-paseo}"

# Commit messages stay on claude (Haiku). Conflict resolution + pre-commit repair
# use the grok CLI at high reasoning effort (Grok 4.5 High).
COMMIT_MSG_MODEL="${PASEO_COMMIT_MSG_MODEL:-claude-haiku-4-5-20251001}"
CONFLICT_MODEL="${PASEO_CONFLICT_MODEL:-grok-4.5}"
CONFLICT_EFFORT="${PASEO_CONFLICT_EFFORT:-high}"
CONFLICT_MAX_TURNS="${PASEO_CONFLICT_MAX_TURNS:-80}"

# Desktop install target for this personal fork.
# Default: /Applications/Paseo.app — we do NOT use "Paseo Test.app". Dock/Spotlight
# stay on the same name; the installed app is already an ad-hoc custom build, not a
# signed production binary we need to preserve side-by-side.
# COMPAT(PASEO_DESKTOP_TEST_APP): old override name; prefer PASEO_DESKTOP_APP.
DESKTOP_APP="${PASEO_DESKTOP_APP:-${PASEO_DESKTOP_TEST_APP:-/Applications/Paseo.app}}"
# Durable deploy logs (survive agent tool cancel; agents should tail these).
DEPLOY_LOG_ROOT="${PASEO_DEPLOY_LOG_DIR:-$HOME/.paseo/deploy-logs}"

# Desktop-only mode: skip git sync, remotes, daemon, code-server, plannotator, settings.
# Just ensure_node → build unsigned desktop → quit → rm -rf → cp -R → open.
if [[ "${PASEO_DESKTOP_ONLY:-0}" == "1" ]]; then
  export PASEO_SKIP_REMOTES=1
  export PASEO_SKIP_DAEMON=1
  export PASEO_SKIP_CODE_SERVER=1
  export PASEO_SKIP_PLANNOTATOR=1
  export PASEO_SKIP_FUNNEL=1
  export PASEO_SKIP_COMMANDER_VOICE=1
  export PASEO_SYNC_CODE_SERVER_USER_DATA=0
  # Keep PASEO_SKIP_LOCAL unset so local desktop still runs.
fi

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

# Create ~/.paseo/deploy-logs/run-<ts>/ and export paths used by this process.
# Also keep a /tmp/paseo-deploy-* mirror for older greps during a transition.
init_deploy_log_dir() {
  local stamp run_dir
  stamp="$(date '+%Y%m%d-%H%M%S')"
  run_dir="${DEPLOY_LOG_ROOT}/run-${stamp}"
  mkdir -p "$run_dir"
  # Symlinks for "where do I look?" without knowing the stamp.
  ln -sfn "$run_dir" "${DEPLOY_LOG_ROOT}/latest-run"
  export PASEO_DEPLOY_RUN_DIR="$run_dir"
  export PASEO_DEPLOY_LOG="${run_dir}/deploy.log"
  : >"$PASEO_DEPLOY_LOG"
  ln -sfn "$PASEO_DEPLOY_LOG" "${DEPLOY_LOG_ROOT}/latest.log"
  # Convenience mirrors under /tmp for existing muscle memory.
  ln -sfn "$PASEO_DEPLOY_LOG" /tmp/paseo-deploy-run.log
  ln -sfn "$run_dir" /tmp/paseo-deploy-latest-run
  printf '%s\n' "$$" >"${run_dir}/pid"
  log "Deploy logs: $PASEO_DEPLOY_LOG (run dir: $run_dir)"
}
# Re-exec this script in a NEW process session so SIGTERM on an agent tool's
# process group cannot kill git/build/desktop mid-flight. Daemon restarts were
# already new-session detached; the parent deploy wait was not — cancelled tools
# left remotes/desktop half-done. Opt out with PASEO_DEPLOY_FOREGROUND=1.
#
# Do NOT trust PASEO_DEPLOY_DETACHED alone. Agent tool shells can be session
# leaders and can inherit a leaked DETACHED=1 from a previous child, which used
# to skip re-fork and leave deploy killable by [Command cancelled]. The only
# trusted "already detached" proof is a per-run token file matching the env.
is_trusted_detached_child() {
  [[ "${PASEO_DEPLOY_DETACHED:-0}" == "1" ]] || return 1
  [[ -n "${PASEO_DEPLOY_RUN_DIR:-}" && -n "${PASEO_DEPLOY_LOG:-}" ]] || return 1
  [[ -n "${PASEO_DEPLOY_DETACH_TOKEN:-}" ]] || return 1
  local token_file expected actual
  token_file="${PASEO_DEPLOY_RUN_DIR}/detach.token"
  [[ -f "$token_file" ]] || return 1
  expected="$(tr -d '[:space:]' <"$token_file" 2>/dev/null || true)"
  actual="$(printf '%s' "${PASEO_DEPLOY_DETACH_TOKEN}" | tr -d '[:space:]')"
  [[ -n "$expected" && "$expected" == "$actual" ]] || return 1
  # Also require we are a session leader (start_new_session child).
  local pid pgid
  pid="$(ps -o pid= -p "$$" 2>/dev/null | tr -d '[:space:]')"
  pgid="$(ps -o pgid= -p "$$" 2>/dev/null | tr -d '[:space:]')"
  [[ -n "$pid" && -n "$pgid" && "$pid" -eq "$pgid" ]]
}

maybe_detach_self() {
  case "${1:-}" in
    -h | --help | help) return 0 ;;
  esac
  if [[ "${PASEO_DEPLOY_FOREGROUND:-0}" == "1" ]]; then
    return 0
  fi

  if is_trusted_detached_child; then
    return 0
  fi

  if [[ "${PASEO_DEPLOY_DETACHED:-0}" == "1" || -n "${PASEO_DEPLOY_RUN_DIR:-}" || -n "${PASEO_DEPLOY_LOG:-}" ]]; then
    # Stale env from a previous detached child leaked into this shell.
    printf '[%s] Ignoring inherited deploy detach env outside a trusted child; re-detaching.\n' \
      "$(date '+%H:%M:%S')" >&2
    unset PASEO_DEPLOY_DETACHED PASEO_DEPLOY_RUN_DIR PASEO_DEPLOY_LOG PASEO_DEPLOY_DETACH_TOKEN
  fi

  mkdir -p "$DEPLOY_LOG_ROOT"
  local stamp run_dir main_log detach_token
  stamp="$(date '+%Y%m%d-%H%M%S')"
  run_dir="${DEPLOY_LOG_ROOT}/run-${stamp}"
  mkdir -p "$run_dir"
  main_log="${run_dir}/deploy.log"
  : >"$main_log"
  # Per-run secret: only the child we spawn with this token is "already detached".
  detach_token="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
  printf '%s\n' "$detach_token" >"${run_dir}/detach.token"
  ln -sfn "$run_dir" "${DEPLOY_LOG_ROOT}/latest-run"
  ln -sfn "$main_log" "${DEPLOY_LOG_ROOT}/latest.log"
  ln -sfn "$main_log" /tmp/paseo-deploy-run.log
  ln -sfn "$run_dir" /tmp/paseo-deploy-latest-run

  # Force child into "already detached" mode with fixed log paths + token.
  python3 - "$main_log" "$run_dir" "$ROOT_DIR" "$detach_token" <<'PY'
import os, subprocess, sys
main_log, run_dir, root, detach_token = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
log = open(main_log, "ab", buffering=0)
env = os.environ.copy()
env["PASEO_DEPLOY_DETACHED"] = "1"
env["PASEO_DEPLOY_RUN_DIR"] = run_dir
env["PASEO_DEPLOY_LOG"] = main_log
env["PASEO_DEPLOY_DETACH_TOKEN"] = detach_token
# Never keep a parent FOREGROUND opt-in on the child.
env.pop("PASEO_DEPLOY_FOREGROUND", None)
script = f'''
set -euo pipefail
cd {root!r}
export PATH="$HOME/.local/bin:$PATH"
export NVM_DIR="${{NVM_DIR:-$HOME/.nvm}}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PASEO_DEPLOY_DETACHED=1
export PASEO_DEPLOY_RUN_DIR={run_dir!r}
export PASEO_DEPLOY_LOG={main_log!r}
export PASEO_DEPLOY_DETACH_TOKEN={detach_token!r}
unset PASEO_DEPLOY_FOREGROUND || true
echo "[$(date '+%H:%M:%S')] DETACHED deploy starting (pid $$ ppid $PPID) log=$PASEO_DEPLOY_LOG"
exec bash {root!r}/scripts/deploy.sh
'''
p = subprocess.Popen(
    ["bash", "-c", script],
    stdin=subprocess.DEVNULL,
    stdout=log,
    stderr=subprocess.STDOUT,
    start_new_session=True,
    close_fds=True,
    cwd=root,
    env=env,
)
open(os.path.join(run_dir, "pid"), "w", encoding="utf-8").write(str(p.pid) + "\n")
open("/tmp/paseo-deploy-pid", "w", encoding="utf-8").write(str(p.pid) + "\n")
print(f"Detached deploy started pid={p.pid}")
print(f"  log:     {main_log}")
print(f"  run dir: {run_dir}")
print(f"  tail:    tail -f {main_log}")
print(f"  latest:  {os.path.expanduser('~')}/.paseo/deploy-logs/latest.log")
print("Parent exits immediately so agent tool cancel cannot kill deploy.")
PY

  exit 0
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

  # Fast-forward to whatever the fork already has (e.g. commits pushed from the
  # MacBook) so this deploy never force-reverts work done on another host.
  if ! git -C "$ROOT_DIR" merge --ff-only "refs/remotes/$ORIGIN_REMOTE/$BRANCH" >/dev/null 2>&1; then
    if ! git -C "$ROOT_DIR" merge-base --is-ancestor "$BRANCH" "refs/remotes/$ORIGIN_REMOTE/$BRANCH" >/dev/null 2>&1; then
      die "Local $BRANCH diverged from $ORIGIN_REMOTE/$BRANCH — resolve manually (git merge $ORIGIN_REMOTE/$BRANCH) before deploying"
    fi
    log "Local $BRANCH already up to date with $ORIGIN_REMOTE/$BRANCH"
  fi
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

# Read configured daemon listen (e.g. 127.0.0.1:6767 or a Tailscale IP).
daemon_listen_from_home() {
  local home="$1"
  local listen=""
  if [[ -f "$home/config.json" ]]; then
    listen="$(
      node -e '
const fs = require("fs");
try {
  const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const l = c && c.daemon && c.daemon.listen;
  if (typeof l === "string" && l.trim()) process.stdout.write(l.trim());
} catch {}
' "$home/config.json" 2>/dev/null || true
    )"
  fi
  if [[ -z "$listen" ]]; then
    listen="127.0.0.1:6767"
  fi
  printf '%s' "$listen"
}

# Health probe URLs for a home: configured listen + loopback:port.
# blrofc3 binds Tailscale only — loopback alone falsely fails.
daemon_health_urls() {
  local home="$1"
  local listen port primary secondary
  listen="$(daemon_listen_from_home "$home")"
  port="${listen##*:}"
  case "$listen" in
    0.0.0.0:* | \[::\]:*)
      primary="http://127.0.0.1:${port}/api/health"
      secondary="$primary"
      ;;
    *)
      primary="http://${listen}/api/health"
      secondary="http://127.0.0.1:${port}/api/health"
      ;;
  esac
  printf '%s %s' "$primary" "$secondary"
}

daemon_health_ok() {
  local home="$1"
  local urls url
  # shellcheck disable=SC2207
  urls=($(daemon_health_urls "$home"))
  for url in "${urls[@]}"; do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      return 0
    fi
  done
  return 1
}

read_daemon_pid() {
  local home="$1"
  local pid_file="$home/paseo.pid"
  if [[ ! -f "$pid_file" ]]; then
    return 1
  fi
  node -e '
try {
  const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (typeof p.pid === "number" && p.pid > 0) process.stdout.write(String(p.pid));
} catch {}
' "$pid_file" 2>/dev/null
}

# Built CLI only — never npx tsx for host restarts. Source+tsx races desktop
# build:server:clean and missing workspace dist (highlight) and leaves the host
# stopped after stop succeeds and start fails.
daemon_cli_cmd() {
  local cwd="${1:-$ROOT_DIR}"
  local wrapper="${HOME}/.local/bin/paseo"
  local dist_cli="$cwd/packages/cli/dist/index.js"
  if [[ -x "$wrapper" ]]; then
    printf '%s' "$wrapper"
    return
  fi
  if [[ -f "$dist_cli" ]]; then
    printf 'node %s' "$(printf %q "$dist_cli")"
    return
  fi
  die "No built CLI for daemon restart (expected $wrapper or $dist_cli). Run build:server + install_cli_wrapper first."
}

# Launch a bash script in a NEW session (survives SIGTERM to the agent/deploy
# process group). macOS has no setsid; plain `nohup … &` is still in the same
# process group and dies mid-restart when the tool is cancelled — stop finishes,
# start never runs, host stays down.
launch_detached_bash() {
  local logf="$1"
  local script="$2"
  python3 - "$logf" "$script" <<'PY'
import os, sys, subprocess
logf, script = sys.argv[1], sys.argv[2]
log = open(logf, "ab", buffering=0)
subprocess.Popen(
    ["bash", "-c", script],
    stdin=subprocess.DEVNULL,
    stdout=log,
    stderr=subprocess.STDOUT,
    start_new_session=True,
    close_fds=True,
    env=os.environ.copy(),
)
PY
}

wait_for_new_daemon() {
  local home="$1"
  local label="$2"
  local old_pid="${3:-}"
  local logf="$4"
  local timeout_s="${5:-90}"
  local i new_pid
  # shellcheck disable=SC2207
  local urls
  urls=($(daemon_health_urls "$home"))
  log "Waiting for $label daemon NEW pid + health (${urls[*]}; up to ${timeout_s}s; old_pid=${old_pid:-none})"
  for ((i = 1; i <= timeout_s; i++)); do
    new_pid="$(read_daemon_pid "$home" || true)"
    if [[ -n "$new_pid" && "$new_pid" != "${old_pid:-}" ]] && daemon_health_ok "$home"; then
      log "$label daemon healthy after ${i}s (pid ${old_pid:-none} -> $new_pid)"
      return 0
    fi
    if [[ $i -ge 8 ]] && grep -Eiq 'ERR_MODULE_NOT_FOUND|Failed to restart|Cannot find module|RESTART_FAILED' "$logf" 2>/dev/null; then
      if [[ -z "$new_pid" || "$new_pid" == "${old_pid:-}" ]]; then
        log "$label restart log shows failure and no new pid"
        return 1
      fi
    fi
    sleep 1
  done
  return 1
}

# Detached restart: stop+start outside this process tree, then require a NEW pid
# that answers /api/health. Plain health is wrong — the old daemon can still
# answer while restart has not finished. On failure, attempt `daemon start`.
restart_daemon_detached() {
  local home="$1"
  local label="$2"
  local cwd="${3:-$ROOT_DIR}"
  local logf="/tmp/paseo-daemon-restart-${label}.log"
  local path_env cli_cmd old_pid restart_script start_script
  path_env="$(daemon_path_env)"
  cli_cmd="$(daemon_cli_cmd "$cwd")"
  old_pid="$(read_daemon_pid "$home" || true)"
  : >"$logf"
  log "Restarting $label daemon ($home) [new-session detached; log $logf] old_pid=${old_pid:-none} cli=$cli_cmd"

  restart_script="$(
    cat <<EOF
set -euo pipefail
cd $(printf %q "$cwd")
export PATH=$(printf %q "$path_env")
export NVM_DIR="\${NVM_DIR:-\$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
exec $cli_cmd daemon restart --web-ui --home $(printf %q "$home")
EOF
  )"

  launch_detached_bash "$logf" "$restart_script"

  if wait_for_new_daemon "$home" "$label" "$old_pid" "$logf" 90; then
    log "$label daemon restart complete (log: $logf)"
    return 0
  fi

  # Recovery: stop may have succeeded and start failed (or the first job was
  # killed before start). Always try a detached start before giving up.
  log "$label restart did not yield a new healthy pid; attempting detached start recovery"
  {
    echo "---- recovery start $(date -u +%Y-%m-%dT%H:%M:%SZ) ----"
  } >>"$logf"
  start_script="$(
    cat <<EOF
set -euo pipefail
cd $(printf %q "$cwd")
export PATH=$(printf %q "$path_env")
export NVM_DIR="\${NVM_DIR:-\$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
exec $cli_cmd daemon start --web-ui --home $(printf %q "$home")
EOF
  )"
  # After a failed restart, old_pid may already be dead; accept any healthy pid.
  launch_detached_bash "$logf" "$start_script"
  if wait_for_new_daemon "$home" "$label" "" "$logf" 60; then
    log "$label daemon recovered via detached start (log: $logf)"
    return 0
  fi

  log "$label daemon restart failed; last log lines from $logf:"
  tail -n 80 "$logf" 2>/dev/null || true
  die "$label daemon failed to come back after restart (see $logf). Recover with: PATH=\"\$HOME/.local/bin:\$PATH\" paseo daemon start --home $(printf %q "$home")"
}

# Self-wake nudge (opt out: PASEO_DEPLOY_NUDGE=0). A detached daemon restart
# kills in-flight agent provider processes; the daemon respawns an agent's
# provider process when a message is delivered to it, so nudging each agent
# that was running before the restart resurrects it and lets the orchestrating
# agent resume without a human. The nudge must NEVER fail the deploy:
# scripts/deploy-nudge.mjs exits 0 on every failure and we add `|| true` here
# as belt-and-braces.
deploy_nudge_enabled() {
  [[ "${PASEO_DEPLOY_NUDGE:-1}" != "0" ]]
}

# Run the nudge script against the LOCAL daemon. The password comes from the
# same channel the CLI uses (PASEO_PASSWORD, overridable via PASEO_NUDGE_URL /
# PASEO_NUDGE_PASSWORD). node is on PATH here: restart runs after ensure_node.
deploy_nudge_run() {
  PASEO_NUDGE_URL="${PASEO_NUDGE_URL:-}" \
  PASEO_NUDGE_PASSWORD="${PASEO_NUDGE_PASSWORD:-${PASEO_PASSWORD:-}}" \
    node "$ROOT_DIR/scripts/deploy-nudge.mjs" "$@"
}

restart_local_daemon() {
  # Require built artifacts so start does not race a half-written dist/.
  if [[ ! -f "$ROOT_DIR/packages/cli/dist/index.js" ]]; then
    die "packages/cli/dist missing before local daemon restart — build:server did not complete"
  fi
  if [[ ! -f "$ROOT_DIR/packages/highlight/dist/index.js" ]]; then
    die "packages/highlight/dist missing before local daemon restart — build:server incomplete"
  fi
  if [[ ! -f "$ROOT_DIR/packages/server/dist/scripts/supervisor-entrypoint.js" ]]; then
    die "packages/server/dist/scripts/supervisor-entrypoint.js missing — build:server incomplete"
  fi

  # Self-wake nudge: snapshot running agents BEFORE the daemon stops, then nudge
  # them after the health check passes (only reached when restart succeeded).
  local nudge_file=""
  if deploy_nudge_enabled; then
    nudge_file="${PASEO_DEPLOY_RUN_DIR:-/tmp}/deploy-nudge-local.json"
    log "Snapshotting running agents before local daemon restart (nudge: $nudge_file)"
    deploy_nudge_run --snapshot "$nudge_file" || true
  fi

  restart_daemon_detached "$LOCAL_PASEO_HOME" "local" "$ROOT_DIR"

  if [[ -n "$nudge_file" ]]; then
    log "Nudging resurrected agents after local daemon restart"
    deploy_nudge_run --nudge "$nudge_file" || true
  fi
}

deploy_local_code_server() {
  if [[ "${PASEO_SKIP_CODE_SERVER:-0}" == "1" ]]; then
    log "Skipping local code-server deploy (PASEO_SKIP_CODE_SERVER=1)"
    return
  fi
  log "Deploying local code-server"
  bash "$ROOT_DIR/scripts/code-server/install.sh" local
}

deploy_local_plannotator() {
  if [[ "${PASEO_SKIP_PLANNOTATOR:-0}" == "1" ]]; then
    log "Skipping local plannotator deploy (PASEO_SKIP_PLANNOTATOR=1)"
    return
  fi
  log "Deploying local plannotator (binary only)"
  PLANNOTATOR_VERSION="${PLANNOTATOR_VERSION:-}" bash "$ROOT_DIR/scripts/plannotator/install.sh" local
}

# Commander Voice node (M9): managed service on the commander host. The daemon
# password + Gemini key are written once into ~/.config/commander-voice/env
# (chmod 600) from deploy env vars — never committed. Unset vars preserve the
# existing env file, so re-deploys rotate nothing by accident.
deploy_local_commander_voice() {
  if [[ "${PASEO_SKIP_COMMANDER_VOICE:-0}" == "1" ]]; then
    log "Skipping local Commander Voice deploy (PASEO_SKIP_COMMANDER_VOICE=1)"
    return
  fi
  log "Deploying local Commander Voice node"
  PASEO_HOME="$LOCAL_PASEO_HOME" \
    PASEO_PASSWORD="${PASEO_PASSWORD:-}" \
    PASEO_COMMANDER_VOICE_PASSWORD="${PASEO_COMMANDER_VOICE_PASSWORD:-}" \
    GEMINI_API_KEY="${GEMINI_API_KEY:-}" \
    bash "$ROOT_DIR/scripts/commander-voice/install.sh" local
}

# Install/refresh this host's stall-check schedule (runs scripts/stall-check.mjs
# every minute via crontab, or systemd user timer when no crontab exists; the
# script warns and exits 0 when neither scheduler is available, so a missing
# schedule never fails the deploy). ensure_node already put the nvm node on
# PATH, so the absolute path baked into the scheduled command survives the
# scheduler's minimal environment. Log: $LOCAL_PASEO_HOME/stall-check.log.
# Opt out: PASEO_SKIP_STALL_CRON=1.
install_stall_cron() {
  if [[ "${PASEO_SKIP_STALL_CRON:-0}" == "1" ]]; then
    log "Skipping stall-check schedule install (PASEO_SKIP_STALL_CRON=1)"
    return
  fi
  local line
  line="$(bash "$ROOT_DIR/scripts/install-stall-cron.sh" "$ROOT_DIR" "$LOCAL_PASEO_HOME")"
  log "Stall-check schedule installed (every minute, log $LOCAL_PASEO_HOME/stall-check.log): $line"
}

# ---------------------------------------------------------------------------
# Desktop install contract (this fork — formal, do not invent a second path)
#
# Target: /Applications/Paseo.app (NOT "Paseo Test.app").
#   Our dock/Spotlight app is already an ad-hoc custom build. We do not keep a
#   signed production binary side-by-side. Paseo Test only matters if someone
#   still has an official signed app to preserve.
#
# Can you replace while the window is open?
#   • On disk: macOS can replace the .app while the process runs (old inodes).
#   • In memory: open windows keep old JS/asar until quit — Electron does not
#     hot-reload a packaged install.
#   • Dangerous: `cp -R` *onto* an existing bundle (merge) mixes signatures/files
#     → dyld Team ID crashes. Always `rm -rf` then `cp -R`.
#
# Canonical loop (what deploy does every time):
#   1. build unsigned (~2 min)
#   2. quit running app
#   3. rm -rf /Applications/Paseo.app
#   4. cp -R packages/desktop/release/mac-*/Paseo.app /Applications/Paseo.app
#   5. open /Applications/Paseo.app
# ---------------------------------------------------------------------------

quit_desktop_app() {
  local app_path="$1"
  local app_name
  app_name="$(basename "$app_path" .app)"

  # Prefer AppleScript quit so Electron shuts down cleanly; fall back to killall
  # by app name, then path-scoped pkill if still alive.
  if pgrep -x "$app_name" >/dev/null 2>&1 || pgrep -f "${app_path}/Contents/MacOS/" >/dev/null 2>&1; then
    log "Quitting ${app_name} before bundle replace"
    osascript -e "tell application \"${app_name}\" to quit" >/dev/null 2>&1 || true
    local i
    for ((i = 1; i <= 20; i++)); do
      if ! pgrep -x "$app_name" >/dev/null 2>&1 && ! pgrep -f "${app_path}/Contents/MacOS/" >/dev/null 2>&1; then
        return 0
      fi
      sleep 0.5
    done
    killall "$app_name" >/dev/null 2>&1 || true
    sleep 1
    if pgrep -f "${app_path}/Contents/MacOS/" >/dev/null 2>&1; then
      pkill -f "${app_path}/Contents/MacOS/" >/dev/null 2>&1 || true
      sleep 1
    fi
  fi
}

# Install a built .app bundle over $DESKTOP_APP: quit → rm -rf → cp -R → open.
# Never merge onto an existing bundle.
install_desktop_app() {
  local built="$1"
  local dest="${2:-$DESKTOP_APP}"

  if [[ ! -d "$built" ]]; then
    die "install_desktop_app: built app missing: $built"
  fi

  log "Desktop install: quit → rm -rf → cp -R → open ($built → $dest)"
  quit_desktop_app "$dest"

  # ALWAYS delete first. `cp -R src dest` when dest exists merges into dest and
  # can leave mixed signatures (dyld "different Team IDs" crash).
  rm -rf "$dest"
  cp -R "$built" "$dest"
  log "Desktop app installed at $dest"

  open "$dest" || open -a "$(basename "$dest" .app)" || {
    log "Warning: could not open $dest — open it manually"
    return 0
  }
  log "Desktop app relaunched: $dest"
}

build_desktop_app() {
  if [[ "${PASEO_BUILD_DESKTOP:-1}" == "0" ]]; then
    log "Skipping desktop app build (PASEO_BUILD_DESKTOP=0)"
    return
  fi
  # Unsigned local build. Bare `build:desktop` hangs on notarization and an
  # ad-hoc hardened build crashes at launch (dyld team-ID mismatch), so disable
  # both — see CLAUDE.md § Local desktop builds.
  log "Building desktop app (unsigned) → install $DESKTOP_APP — this takes a few minutes"
  (
    cd "$ROOT_DIR"
    # -p never: unsigned local builds must not attempt GitHub publish (needs GH_TOKEN).
    CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:desktop -- \
      -c.mac.notarize=false -c.mac.hardenedRuntime=false -p never
  )
  # electron-builder writes Paseo.app under packages/desktop/release/mac*/.
  local built
  built="$(find "$ROOT_DIR/packages/desktop/release" -maxdepth 2 -name 'Paseo.app' -type d 2>/dev/null | head -1)"
  if [[ -z "$built" ]]; then
    die "Desktop build finished but no Paseo.app found under packages/desktop/release"
  fi
  install_desktop_app "$built" "$DESKTOP_APP"
}

# --- MacBook desktop job (iammvaibhav orchestrator) ----------------------------
# The desktop app builds only on macOS, so when deploy runs from iammvaibhav the
# MacBook is driven over ssh (WireGuard 10.7.0.2; ssh alias "macbook"). The job is
# reachability-gated and NEVER fails the deploy: if the MacBook is down, or its
# checkout is dirty/diverged, iammvaibhav + remotes still deploy. The MacBook
# daemon is deliberately left alone here — paseo-dev agents stay untouched until
# the migration to iammvaibhav is complete (opt in later by running deploy on the
# MacBook itself, which restarts its own daemon as before).

# Remote script body: safe git sync + nested desktop-only deploy (foreground so the
# exit code propagates; PASEO_DESKTOP_ONLY=1 already does build → quit → rm → cp → open).
macbook_desktop_body() {
  cat <<EOF
set -euo pipefail
BRANCH='$BRANCH'
NODE_VERSION='$NODE_VERSION'
REPO_DIR="\$HOME/$MACBOOK_REPO_DIR"

log() { printf '\n[%s:macbook] %s\n' "\$(date '+%H:%M:%S')" "\$*"; }

# Non-interactive ssh shell has no node on PATH; source nvm before any npm step.
export NVM_DIR="\${NVM_DIR:-\$HOME/.nvm}"
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
nvm use "\$NODE_VERSION" >/dev/null 2>&1 || nvm install "\$NODE_VERSION" >/dev/null

cd "\$REPO_DIR"
log "git sync to origin/\$BRANCH"
git fetch origin --prune
if ! git show-ref --verify --quiet "refs/remotes/origin/\$BRANCH"; then
  log "origin/\$BRANCH not found on MacBook — skipping desktop build"
  exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  log "MacBook checkout has uncommitted changes — skipping desktop build (commit or stash, then run: PASEO_DESKTOP_ONLY=1 ./scripts/deploy.sh)"
  exit 1
fi
git checkout -q "\$BRANCH" 2>/dev/null || git checkout -q -B "\$BRANCH" "origin/\$BRANCH"
if ! git merge --ff-only "origin/\$BRANCH" >/dev/null 2>&1; then
  log "MacBook checkout diverged from origin/\$BRANCH — skipping desktop build (run: git merge origin/\$BRANCH, then PASEO_DESKTOP_ONLY=1 ./scripts/deploy.sh)"
  exit 1
fi
log "MacBook checkout at \$(git rev-parse --short HEAD)"

# Reinstall deps when the lockfile changed since the last sync.
sync_ref_file="$HOME/.paseo-sync-ref"
prev=""
cur="$(git rev-parse HEAD)"
if [[ -f "\$sync_ref_file" ]]; then
  prev="\$(cat "\$sync_ref_file")"
fi
if [[ -z "\$prev" ]] || git diff "\$prev" "\$cur" --name-only | grep -Eq '^(package-lock\\.json|package\\.json)$'; then
  log "Installing npm dependencies"
  npm install
fi
echo "\$cur" > "\$sync_ref_file"

log "Building + installing desktop app (PASEO_DESKTOP_ONLY=1, foreground)"
export PASEO_DESKTOP_ONLY=1
export PASEO_DEPLOY_FOREGROUND=1
./scripts/deploy.sh
EOF
}

macbook_desktop_job() {
  if [[ "${PASEO_SKIP_MACBOOK:-0}" == "1" ]]; then
    log "Skipping MacBook desktop job (PASEO_SKIP_MACBOOK=1)"
    return 0
  fi
  if [[ "${PASEO_BUILD_DESKTOP:-1}" == "0" ]]; then
    log "Skipping MacBook desktop build (PASEO_BUILD_DESKTOP=0)"
    return 0
  fi
  if ! ssh -o BatchMode=yes -o ConnectTimeout=8 "$MACBOOK_HOST" 'true' 2>/dev/null; then
    log "MacBook ($MACBOOK_HOST) unreachable — skipping desktop build/install; iammvaibhav + remotes still deploy"
    return 0
  fi
  log "MacBook reachable — git sync + desktop build/install via PASEO_DESKTOP_ONLY=1"
  if ssh -o BatchMode=yes "$MACBOOK_HOST" "bash -s" < <(macbook_desktop_body); then
    log "MacBook desktop build/install complete"
  else
    log "MacBook desktop job FAILED — deploy continues (see job log); rebuild manually on the MacBook with PASEO_DESKTOP_ONLY=1"
  fi
}

# --- Parallel post-push deploy jobs ------------------------------------------------
# After git is pushed, local daemon work, desktop build, and each remote host are
# independent enough to overlap. Jobs log to /tmp/paseo-deploy-<name>.log so their
# output does not interleave. Local `build:server` is NOT run in parallel with the
# desktop build: both write packages/*/dist and would race.

PARALLEL_PIDS=()
PARALLEL_NAMES=()
PARALLEL_LOGS=()

start_parallel_job() {
  local name="$1"
  shift
  local run_dir="${PASEO_DEPLOY_RUN_DIR:-/tmp}"
  local logf="${run_dir}/job-${name}.log"
  : >"$logf"
  # Keep /tmp mirrors for quick tail during a run.
  ln -sfn "$logf" "/tmp/paseo-deploy-${name}.log" 2>/dev/null || true
  log "→ starting job '$name' (log: $logf)"
  (
    set -euo pipefail
    # Close every inherited descriptor above stdio (agent pipes, stray sockets,
    # a sibling job's command-substitution pipe, ...) so a job can never hold
    # a pipe write-end open that another job's reader is waiting on — that
    # keeps EOF semantics local to each job. fd 255 is bash's own script fd,
    # leave it alone.
    local _fd
    for _fd in {3..254}; do
      eval "exec ${_fd}>&-"
    done
    "$@"
  ) >>"$logf" 2>&1 &
  PARALLEL_PIDS+=("$!")
  PARALLEL_NAMES+=("$name")
  PARALLEL_LOGS+=("$logf")
}

wait_for_parallel_jobs() {
  local fail=0
  local i pid name logf status
  # Belt: a background reporter logs every 60s which jobs are STILL pending.
  # A future wedge is then visible in the log (who is stuck, since when)
  # instead of a silent hang. Runs in the background so the sequential waits
  # below keep their exact original semantics (no artificial delay when jobs
  # finish quickly). Liveness is `ps` process state, NOT `kill -0`: finished
  # children sit as unreaped zombies while this shell is blocked inside wait,
  # and `kill -0` would report them as still pending. The list is recomputed
  # at log time, so the report only ever names jobs that are still alive.
  # The reporter is killed and reaped once the last wait returns.
  local heart
  (
    local hnames
    while :; do
      sleep 60
      hnames=""
      for i in "${!PARALLEL_PIDS[@]}"; do
        pid="${PARALLEL_PIDS[$i]}"
        # shellcheck disable=SC2009
        st="$(ps -o stat= -p "$pid" 2>/dev/null || true)"
        if [[ -n "$st" && "$st" != *Z* ]]; then
          hnames+=" ${PARALLEL_NAMES[$i]}"
        fi
      done
      if [[ -n "$hnames" ]]; then
        log "still waiting for job(s):${hnames}"
      fi
    done
  ) &
  heart=$!
  for i in "${!PARALLEL_PIDS[@]}"; do
    pid="${PARALLEL_PIDS[$i]}"
    name="${PARALLEL_NAMES[$i]}"
    logf="${PARALLEL_LOGS[$i]}"
    status=0
    wait "$pid" || status=$?
    if [[ "$status" -eq 0 ]]; then
      log "✓ job '$name' finished"
    else
      fail=1
      log "✗ job '$name' failed (exit $status) — last lines of $logf:"
      tail -n 50 "$logf" 2>/dev/null || true
    fi
  done
  kill "$heart" 2>/dev/null || true
  wait "$heart" 2>/dev/null || true
  PARALLEL_PIDS=()
  PARALLEL_NAMES=()
  PARALLEL_LOGS=()
  if [[ "$fail" -ne 0 ]]; then
    die "One or more parallel deploy jobs failed (see ${PASEO_DEPLOY_RUN_DIR:-/tmp}/job-*.log and ${DEPLOY_LOG_ROOT}/latest.log)"
  fi
}

# Local daemon path after packages are built: install wrapper + restart.
local_daemon_restart_job() {
  install_cli_wrapper "$ROOT_DIR"
  restart_local_daemon
}

# One remote host end-to-end (runs on this Mac as an ssh driver; build happens on the host).
remote_host_job() {
  local host="$1"
  local rhome="$2"
  local rprovider="$3"
  ensure_remote_cloudflared "$host" "$rprovider"
  sync_remote_host "$host" "$rhome" "$rprovider"
  ensure_remote_funnel "$host" "$rhome" "$rprovider"
}

# After branch is pushed:
#   - remotes + local code-server start immediately (own machines / independent)
#   - local daemon: build:server → install wrapper → restart (must finish before desktop)
#   - desktop build starts only after local daemon restart, because build:desktop runs
#     build:server:clean and would delete packages/*/dist mid-restart
run_parallel_post_push_deploy() {
  PARALLEL_PIDS=()
  PARALLEL_NAMES=()
  PARALLEL_LOGS=()

  log "Starting post-push deploy phase (parallel where safe)"

  # Remotes can start immediately — they build on their own machines.
  if [[ "${PASEO_SKIP_REMOTES:-0}" != "1" ]]; then
    local host rhome rprovider
    for host in "${REMOTE_HOSTS[@]}"; do
      rhome="$(remote_paseo_home "$host")"
      rprovider="$(remote_tunnel_provider "$host")"
      start_parallel_job "remote-${host}" remote_host_job "$host" "$rhome" "$rprovider"
    done
    # iammvaibhav orchestrator: the MacBook is a desktop-only target (build +
    # install of Paseo.app), gated on reachability and never fatal.
    if [[ "$IS_MAC_ORCHESTRATOR" != "1" ]]; then
      start_parallel_job "macbook-desktop" macbook_desktop_job
    fi
  else
    log "Skipping remotes (PASEO_SKIP_REMOTES=1)"
  fi

  if [[ "${PASEO_SKIP_LOCAL:-0}" != "1" ]]; then
    # Independent of dist/ — fine alongside remotes and the daemon build.
    start_parallel_job "local-code-server" deploy_local_code_server
    start_parallel_job "local-plannotator" deploy_local_plannotator
    start_parallel_job "local-stall-cron" install_stall_cron
    start_parallel_job "local-commander-voice" deploy_local_commander_voice

    # Local daemon must use a stable dist/ through restart. Desktop's
    # build:server:clean races that path, so keep this sequential first.
    if [[ "${PASEO_SKIP_DAEMON:-0}" != "1" ]]; then
      build_server
      install_cli_wrapper "$ROOT_DIR"
      restart_local_daemon
      log "Local daemon ready; starting desktop build (may rebuild dist/)"
    else
      log "Skipping local daemon build/restart (PASEO_SKIP_DAEMON=1)"
    fi

    # Safe now: daemon process is up (modules already loaded). Desktop can clean+rebuild.
    # Only on the MacBook orchestrator — on iammvaibhav the desktop is a remote job.
    if [[ "$IS_MAC_ORCHESTRATOR" == "1" ]]; then
      start_parallel_job "desktop" build_desktop_app
    fi
  else
    log "Skipping local post-push jobs (PASEO_SKIP_LOCAL=1)"
  fi

  if [[ ${#PARALLEL_PIDS[@]} -eq 0 ]]; then
    log "No parallel post-push jobs to run"
    return
  fi

  log "Waiting for ${#PARALLEL_PIDS[@]} parallel job(s): ${PARALLEL_NAMES[*]}"
  wait_for_parallel_jobs
  log "Parallel post-push deploy phase complete"
}

sync_system_prompt() {
  if [[ "${PASEO_SKIP_SYSTEM_PROMPT:-0}" == "1" ]]; then
    return
  fi

  local prompt_file="$ROOT_DIR/scripts/paseo-system-prompt.md"
  local patcher="$ROOT_DIR/scripts/set-append-system-prompt.mjs"
  if [[ ! -f "$prompt_file" || ! -f "$patcher" ]]; then
    log "No canonical system prompt on disk; leaving daemon.appendSystemPrompt alone"
    return
  fi

  # base64 so the prompt survives argv and shell quoting on the way to each host.
  local b64
  b64="$(base64 < "$prompt_file" | tr -d '\n')"

  # Must run BEFORE the daemon restarts: the config store only re-reads
  # config.json at boot, and it writes its in-memory value back on any later
  # patch, so a prompt written after the restart would be reverted.
  if [[ "${PASEO_SKIP_LOCAL:-0}" != "1" ]]; then
    log "Syncing daemon system prompt (local)"
    node "$patcher" "$b64" | while read -r line; do log "  $line"; done
  fi

  if [[ "${PASEO_SKIP_REMOTES:-0}" == "1" ]]; then
    return
  fi

  local host
  for host in "${REMOTE_HOSTS[@]}"; do
    log "Syncing daemon system prompt → $host"
    # Remote PATH has no node for non-login shells; nvm is how deploy gets it there.
    if ssh -o BatchMode=yes "$host" \
        "export NVM_DIR=\"\$HOME/.nvm\"; . \"\$NVM_DIR/nvm.sh\" >/dev/null 2>&1; node - '$b64'" \
        < "$patcher" 2>&1 | while read -r line; do log "  $line"; done; then
      :
    else
      log "  Warning: system prompt sync failed on $host"
    fi
  done
}

# Mission Control verifier: sync the omp agent definition
# (packages/server/resources/verifier-agent.md → ~/.omp/agent/agents/verifier.md)
# and modelRoles.verifier (copy of modelRoles.task) into ~/.omp/agent/config.yml
# on every host. The daemon spawns the verifier as an omp agent and resolves
# its model @verifier → @task → host default; deploy keeps the role defined so
# @verifier resolves before the fallback chain is needed. Kept deliberately
# small: one patcher, one definition file, no other omp-config keys touched.
sync_omp_verifier_config() {
  if [[ "${PASEO_SKIP_OMP_VERIFIER:-0}" == "1" ]]; then
    return
  fi

  local agent_md="$ROOT_DIR/packages/server/resources/verifier-agent.md"
  local patcher="$ROOT_DIR/scripts/set-omp-verifier-role.mjs"
  if [[ ! -f "$agent_md" || ! -f "$patcher" ]]; then
    log "No verifier agent definition on disk; leaving ~/.omp/agent alone"
    return
  fi

  # base64 so the definition survives argv and shell quoting on the way to each host.
  local b64
  b64="$(base64 < "$agent_md" | tr -d '\n')"

  if [[ "${PASEO_SKIP_LOCAL:-0}" != "1" ]]; then
    log "Syncing omp verifier agent (local)"
    if node "$patcher" "$b64" | while read -r line; do log "  $line"; done; then
      :
    else
      log "  Warning: omp verifier sync failed locally"
    fi
  fi

  if [[ "${PASEO_SKIP_REMOTES:-0}" == "1" ]]; then
    return
  fi

  local host
  for host in "${REMOTE_HOSTS[@]}"; do
    log "Syncing omp verifier agent → $host"
    # Remote PATH has no node for non-login shells; nvm is how deploy gets it there.
    if ssh -o BatchMode=yes "$host" \
        "export NVM_DIR=\"\$HOME/.nvm\"; . \"\$NVM_DIR/nvm.sh\" >/dev/null 2>&1; node - '$b64'" \
        < "$patcher" 2>&1 | while read -r line; do log "  $line"; done; then
      :
    else
      log "  Warning: omp verifier sync failed on $host"
    fi
  done
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

  # Merge, never clobber. A remote may carry host-level keys that this Mac has
  # no business knowing about — stackmod's `make setup-ide` merges watcher/search
  # excludes for its 94 GB data/ dir into blrofc3's settings, and a whole-file
  # rsync silently reverted them on every deploy. This Mac stays authoritative
  # for the keys it defines; remote-only keys survive. The merge runs here, not
  # on the remote, so no remote jq is required.
  local jq_bin=""
  jq_bin="$(command -v jq 2>/dev/null || true)"
  if [[ -z "$jq_bin" ]]; then
    log "Warning: jq not found; pushing settings as a whole-file copy (remote-only keys will be lost)"
  fi

  log "Pushing live code-server settings to remotes ($src)"
  local host
  for host in "${REMOTE_HOSTS[@]}"; do
    log "  → $host"
    ssh -o BatchMode=yes "$host" 'mkdir -p ~/.local/share/code-server/User'

    local payload="$src"
    local remote_current="" merged=""
    if [[ -n "$jq_bin" ]]; then
      remote_current="$(mktemp)"
      if ssh -o BatchMode=yes "$host" 'cat ~/.local/share/code-server/User/settings.json 2>/dev/null' \
          >"$remote_current" 2>/dev/null \
        && [[ -s "$remote_current" ]] \
        && "$jq_bin" -e . "$remote_current" >/dev/null 2>&1; then
        merged="$(mktemp)"
        # --slurpfile, not `-s file file`: jq is often the jaq clone on macOS,
        # whose --slurp reads only the first file and silently yields null for
        # the second — which sent this Mac's file over whole and deleted every
        # remote-only key, the exact clobbering this merge exists to prevent.
        if "$jq_bin" -n --slurpfile remote "$remote_current" --slurpfile local "$src" \
          '$remote[0] * $local[0]' >"$merged" 2>/dev/null; then
          payload="$merged"
        else
          log "    Warning: settings merge failed; pushing this Mac's file as-is"
          rm -f "$merged"
          merged=""
        fi
      fi
      rm -f "$remote_current"
    fi

    rsync -az "$payload" "$host:~/.local/share/code-server/User/settings.json"
    if [[ -n "$merged" ]]; then
      rm -f "$merged"
    fi
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
# Self-wake nudge env (interpolated at heredoc time from the Mac's env; empty
# values are fine — the nudge then skips instead of failing the deploy).
PASEO_NUDGE_URL='${PASEO_NUDGE_URL:-}'
PASEO_NUDGE_PASSWORD='${PASEO_NUDGE_PASSWORD:-${PASEO_PASSWORD:-}}'
# Daemon password for the Commander Voice node env file on this host. Same
# channel as the nudge password: interpolated from the Mac's env at heredoc
# time, so the remote voice node authenticates instead of being locked out.
PASEO_PASSWORD='${PASEO_PASSWORD:-}'

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
  # Read pid/listen without broken quoting. IMPORTANT: do not put \\" inside
  # single-quoted node -e scripts — that yields literal backslash-quotes and
  # JS parse failures, so new_pid stays empty forever and health is never tried.
  # Prefer python3 (stdlib json); fall back to node with proper single-quoted JS.
  read_daemon_pid() {
    local home="\$1"
    local f="\$home/paseo.pid"
    [[ -f "\$f" ]] || return 0
    if command -v python3 >/dev/null 2>&1; then
      python3 -c 'import json,sys
try:
 p=json.load(open(sys.argv[1])); print(p.get("pid") or "", end="")
except Exception:
 pass' "\$f" 2>/dev/null || true
    elif command -v node >/dev/null 2>&1; then
      node -e 'try{const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(p.pid!=null)process.stdout.write(String(p.pid))}catch{}' "\$f" 2>/dev/null || true
    fi
  }
  read_daemon_listen() {
    local home="\$1"
    local f cfg out=""
    # Prefer live pid file (what the process actually bound), then config.json.
    f="\$home/paseo.pid"
    if [[ -f "\$f" ]] && command -v python3 >/dev/null 2>&1; then
      out="\$(python3 -c 'import json,sys
try:
 p=json.load(open(sys.argv[1])); print((p.get("listen") or "").strip(), end="")
except Exception:
 pass' "\$f" 2>/dev/null || true)"
    fi
    if [[ -z "\$out" ]]; then
      cfg="\$home/config.json"
      if [[ -f "\$cfg" ]] && command -v python3 >/dev/null 2>&1; then
        out="\$(python3 -c 'import json,sys
try:
 c=json.load(open(sys.argv[1])); d=c.get("daemon") or {}; print((d.get("listen") or "").strip(), end="")
except Exception:
 pass' "\$cfg" 2>/dev/null || true)"
      elif [[ -f "\$cfg" ]] && command -v node >/dev/null 2>&1; then
        out="\$(node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const l=c&&c.daemon&&c.daemon.listen;if(typeof l==="string"&&l.trim())process.stdout.write(l.trim())}catch{}' "\$cfg" 2>/dev/null || true)"
      fi
    fi
    printf '%s' "\$out"
  }
  health_urls_for_listen() {
    local listen="\$1"
    local port primary secondary
    listen="\${listen:-127.0.0.1:6767}"
    port="\${listen##*:}"
    case "\$listen" in
      0.0.0.0:*|\\[::\\]:*)
        primary="http://127.0.0.1:\${port}/api/health"
        secondary="\$primary"
        ;;
      *)
        # Tailscale/WireGuard-only binds (e.g. blrofc3 100.x:6767): primary is
        # the real bind; secondary loopback often fails and must not be the only probe.
        primary="http://\${listen}/api/health"
        secondary="http://127.0.0.1:\${port}/api/health"
        ;;
    esac
    printf '%s %s' "\$primary" "\$secondary"
  }

  # Self-wake nudge: snapshot running agents BEFORE the daemon stops. The
  # daemon respawns an agent's provider process on first message, so after the
  # restart below each snapshot agent is nudged and resumes without a human.
  # Never fails the deploy (the script exits 0 on failure; || true too).
  nudge_file=""
  if [[ '${PASEO_DEPLOY_NUDGE:-1}' != "0" ]]; then
    nudge_file="\$PASEO_HOME/deploy-nudge-remote.json"
    log "Snapshotting running agents before daemon restart (nudge: \$nudge_file)"
    PASEO_NUDGE_URL="\$PASEO_NUDGE_URL" \
    PASEO_NUDGE_PASSWORD="\$PASEO_NUDGE_PASSWORD" \
      node "\$HOME/\$REMOTE_REPO_DIR/scripts/deploy-nudge.mjs" --snapshot "\$nudge_file" || true
  fi

  # Detached restart via built CLI (not npx tsx). Require a NEW pid + health on
  # configured listen and/or loopback:port (Tailscale-only binds fail on 127.0.0.1).
  restart_log="/tmp/paseo-daemon-restart-remote-\$\$.log"
  : >"\$restart_log"
  old_pid="\$(read_daemon_pid "\$PASEO_HOME")"
  cli_bin="\$HOME/.local/bin/paseo"
  if [[ ! -x "\$cli_bin" ]]; then
    cli_bin="node \$HOME/\$REMOTE_REPO_DIR/packages/cli/dist/index.js"
  fi
  log "Restarting daemon (\$PASEO_HOME) [detached; log \$restart_log] old_pid=\${old_pid:-none}"
  if command -v setsid >/dev/null 2>&1; then
    setsid bash -c "export PATH=\"\$(daemon_path_env)\"; export NVM_DIR=\"\${NVM_DIR:-\$HOME/.nvm}\"; [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"; cd \"\$HOME/\$REMOTE_REPO_DIR\"; exec \$cli_bin daemon restart --home \"\$PASEO_HOME\"" >>"\$restart_log" 2>&1 </dev/null &
  else
    nohup bash -c "export PATH=\"\$(daemon_path_env)\"; export NVM_DIR=\"\${NVM_DIR:-\$HOME/.nvm}\"; [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"; cd \"\$HOME/\$REMOTE_REPO_DIR\"; exec \$cli_bin daemon restart --home \"\$PASEO_HOME\"" >>"\$restart_log" 2>&1 </dev/null &
  fi
  ok=0
  primary=""
  for i in \$(seq 1 90); do
    new_pid="\$(read_daemon_pid "\$PASEO_HOME")"
    listen="\$(read_daemon_listen "\$PASEO_HOME")"
    # shellcheck disable=SC2206
    urls=(\$(health_urls_for_listen "\$listen"))
    primary="\${urls[0]}"
    secondary="\${urls[1]:-\$primary}"
    if [[ -n "\$new_pid" && "\$new_pid" != "\${old_pid:-}" ]]; then
      if curl -fsS --max-time 2 "\$primary" >/dev/null 2>&1 \\
        || curl -fsS --max-time 2 "\$secondary" >/dev/null 2>&1; then
        log "Daemon healthy after \${i}s (pid \${old_pid:-none} -> \$new_pid; \$primary)"
        ok=1
        break
      fi
    fi
    sleep 1
  done
  if [[ "\$ok" -ne 1 ]]; then
    log "Daemon health check failed; restart log:"
    tail -n 80 "\$restart_log" 2>/dev/null || true
    log "Debug: old_pid=\${old_pid:-none} new_pid=\$(read_daemon_pid "\$PASEO_HOME") listen=\$(read_daemon_listen "\$PASEO_HOME") primary=\${primary:-unset}"
    echo "Daemon failed to come back (\${primary:-no-url}) after restart" >&2
    exit 1
  fi

  # Health check passed — nudge the agents that were running before the restart
  # so they resurrect (daemon respawns the provider on first message) and resume.
  if [[ -n "\$nudge_file" ]]; then
    log "Nudging resurrected agents after daemon restart"
    PASEO_NUDGE_URL="\$PASEO_NUDGE_URL" \
    PASEO_NUDGE_PASSWORD="\$PASEO_NUDGE_PASSWORD" \
      node "\$HOME/\$REMOTE_REPO_DIR/scripts/deploy-nudge.mjs" --nudge "\$nudge_file" || true
  fi
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

deploy_plannotator() {
  if [[ '${PASEO_SKIP_PLANNOTATOR:-0}' == "1" ]]; then
    log "Skipping plannotator deploy (PASEO_SKIP_PLANNOTATOR=1)"
    return
  fi
  cd "\$HOME/\$REMOTE_REPO_DIR"
  log "Deploying plannotator (binary only)"
  PLANNOTATOR_VERSION='${PLANNOTATOR_VERSION:-}' bash scripts/plannotator/install.sh '$host'
}

deploy_commander_voice() {
  if [[ '${PASEO_SKIP_COMMANDER_VOICE:-0}' == "1" ]]; then
    log "Skipping Commander Voice deploy (PASEO_SKIP_COMMANDER_VOICE=1)"
    return
  fi
  cd "\$HOME/\$REMOTE_REPO_DIR"
  log "Deploying Commander Voice node"
  # The daemon password travels over ssh stdin (never argv/logs) and lands in
  # ~/.config/commander-voice/env chmod 600 on the host; unset keeps existing.
  # PASEO_PASSWORD was interpolated into this script's env at heredoc time from
  # the Mac's env (same channel as PASEO_NUDGE_PASSWORD) — without it the node
  # is locked out of the daemon.
  PASEO_HOME="\$PASEO_HOME" \
    PASEO_PASSWORD="\$PASEO_PASSWORD" \
    PASEO_COMMANDER_VOICE_PASSWORD='${PASEO_COMMANDER_VOICE_PASSWORD:-}' \
    GEMINI_API_KEY='${GEMINI_API_KEY:-}' \
    bash scripts/commander-voice/install.sh '$host'
}

ensure_node
ensure_fork_remotes
sync_git
# Remote daemons always rebuild/restart unless PASEO_SKIP_REMOTE_DAEMON=1.
# PASEO_SKIP_DAEMON only affects the local Mac (see run_parallel_post_push_deploy).
if [[ '${PASEO_SKIP_REMOTE_DAEMON:-0}' == "1" ]]; then
  log "Skipping remote daemon build/restart (PASEO_SKIP_REMOTE_DAEMON=1)"
else
  maybe_install_deps
  build_and_restart
fi
deploy_code_server
deploy_plannotator
deploy_commander_voice
install_stall_cron() {
  if [[ '${PASEO_SKIP_STALL_CRON:-0}' == "1" ]]; then
    log "Skipping stall-check schedule install (PASEO_SKIP_STALL_CRON=1)"
    return
  fi
  local line
  line="\$(bash "\$HOME/\$REMOTE_REPO_DIR/scripts/install-stall-cron.sh" "\$HOME/\$REMOTE_REPO_DIR" "\$PASEO_HOME")"
  log "Stall-check schedule installed (every minute, log \$PASEO_HOME/stall-check.log): \$line"
}
install_stall_cron
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

Orchestrator (auto-detected by `uname -s`):
  macOS (MacBook)     local = MacBook (daemon + desktop build/install),
                      remotes = blrofc3 + iammvaibhav.
  Linux (iammvaibhav) local = iammvaibhav (daemon + services),
                      remotes = blrofc3; MacBook = desktop-only ssh job
                      (reachability-gated, non-fatal, MacBook daemon untouched).

What a full run does (local Mac):
  0. Self-detaches into a new session (unless PASEO_DEPLOY_FOREGROUND=1) and writes
     durable logs under ~/.paseo/deploy-logs/ (latest.log → current run)
  1. Auto-commit uncommitted changes (message via claude; on pre-commit failure,
     grok fixes checks and commits)
  2. Fetch upstream, fast-forward origin/main to upstream/main
  3. Merge $UPSTREAM_REMOTE/main into '$BRANCH' (on conflict, grok resolves, stages,
     fixes pre-commit checks, and completes the merge commit — streaming output)
  4. Push branch to $ORIGIN_REMOTE
  5. Post-push in parallel: each remote host, local daemon restart (+ server build first),
     local code-server, and desktop app build/install to $DESKTOP_APP then relaunch
     (desktop via the MacBook ssh job when deploying from iammvaibhav)
Then remotes are ${REMOTE_HOSTS[*]} (each gets its own parallel job).

Daemon restarts (local + remote) always run in a NEW session so cancelling an agent
tool mid-wait cannot leave stop-without-start. The whole deploy is also detached by
default for the same reason — agents should \`tail -f ~/.paseo/deploy-logs/latest.log\`.

Scope flags (set to 1 unless noted):
  PASEO_SKIP_LOCAL                 Skip the local host entirely (remotes only)
  PASEO_SKIP_REMOTES              Skip all remote hosts (local only)
  PASEO_REMOTE_HOSTS             Space-separated remote subset (default: ${REMOTE_HOSTS[*]})
  PASEO_SKIP_DAEMON              Skip local daemon build/restart (desktop still builds)
  PASEO_SKIP_REMOTE_DAEMON       Skip remote daemon build/restart (remotes still pull git +
                                   code-server/plannotator; default is to rebuild remotes)
  PASEO_SKIP_MACBOOK             Skip the MacBook desktop job (iammvaibhav orchestrator)
  PASEO_MACBOOK_HOST             ssh alias/IP for the MacBook (default: $MACBOOK_HOST)
  PASEO_MACBOOK_REPO_DIR         repo dir name under \$HOME on the MacBook (default: $MACBOOK_REPO_DIR)
  PASEO_SKIP_CODE_SERVER         Skip code-server deploy everywhere
  PASEO_SKIP_CODE_SERVER_EXTENSION  Skip installing the paseo-bridge extension
  PASEO_SKIP_PLANNOTATOR         Skip plannotator binary deploy everywhere
  PASEO_SKIP_STALL_CRON          Skip installing the stall-check cron entry on every host
  PASEO_SKIP_COMMANDER_VOICE     Skip Commander Voice node deploy everywhere
  PASEO_BUILD_DESKTOP=0            Skip the desktop app build (built by default)
  PASEO_DESKTOP_ONLY=1             ONLY desktop build/install/relaunch (no git/remotes/daemon)
  PASEO_DESKTOP_APP=<path>         Desktop install path (default: $DESKTOP_APP)
  PASEO_DESKTOP_TEST_APP=<path>    COMPAT alias for PASEO_DESKTOP_APP
  PASEO_DEPLOY_FOREGROUND=1        Stay attached (no self-detach; for interactive debug)
  PASEO_DEPLOY_LOG_DIR=<path>      Durable log root (default: $DEPLOY_LOG_ROOT)
  PASEO_SYNC_CODE_SERVER_USER_DATA  Also rsync code-server User/ + extensions/ to remotes
  PASEO_SKIP_FUNNEL               Skip ensuring the Tailscale Funnel on funnel hosts (blrofc3)

Commander Voice (M9) secrets — written ONCE into ~/.config/commander-voice/env
(chmod 600) on every host; never committed. Unset = keep the existing value:
  PASEO_COMMANDER_VOICE_PASSWORD  daemon password for the voice node
  GEMINI_API_KEY                  Gemini Live API key for the voice node

Model selection:
  PASEO_COMMIT_MSG_MODEL          claude model for auto-commit messages (default: $COMMIT_MSG_MODEL)
  PASEO_CONFLICT_MODEL           grok model for conflict/commit fix (default: $CONFLICT_MODEL)
  PASEO_CONFLICT_EFFORT          Reasoning effort for conflict/commit fix (default: $CONFLICT_EFFORT)
  PASEO_CONFLICT_MAX_TURNS       Max agent turns for conflict/commit fix (default: $CONFLICT_MAX_TURNS)

Other:
  CODE_SERVER_VERSION            Pin code-server version (omit for latest)
  PLANNOTATOR_VERSION            Pin plannotator version (omit for latest)
  PASEO_NODE_VERSION             Node version via nvm (default from .tool-versions: $NODE_VERSION)
  PASEO_CUSTOM_BRANCH            Custom branch (default: $BRANCH)
  PASEO_UPSTREAM_REMOTE          Upstream remote (default: $UPSTREAM_REMOTE)
  PASEO_ORIGIN_REMOTE            Fork remote (default: $ORIGIN_REMOTE)
  PASEO_LOCAL_HOME               Local daemon home (default: $LOCAL_PASEO_HOME)

Per-host code-server install (run on a single machine):
  ./scripts/code-server/install.sh <local|blrofc3|iammvaibhav>

Per-host Commander Voice install (run on a single machine):
  ./scripts/commander-voice/install.sh <local|blrofc3|iammvaibhav>
  (secrets come from PASEO_COMMANDER_VOICE_PASSWORD / GEMINI_API_KEY env vars)

Examples:
  PASEO_DESKTOP_ONLY=1 ./scripts/deploy.sh          # app UI only: build + install Paseo.app + relaunch
  PASEO_SKIP_REMOTES=1 ./scripts/deploy.sh          # local only
  PASEO_SKIP_DAEMON=1  ./scripts/deploy.sh          # code-server + settings, no local daemon
  PASEO_REMOTE_HOSTS=blrofc3 PASEO_SKIP_DAEMON=1 ./scripts/deploy.sh
                                                    # only blrofc3 + desktop; no local daemon
EOF
}

main() {
  case "${1:-}" in
    -h | --help | help)
      print_help
      exit 0
      ;;
  esac

  # Self-detach before any heavy work unless FOREGROUND or already detached.
  maybe_detach_self "$@"

  cd "$ROOT_DIR"

  # Detached children inherit PASEO_DEPLOY_RUN_DIR/LOG; foreground runs init here.
  if [[ -z "${PASEO_DEPLOY_RUN_DIR:-}" || -z "${PASEO_DEPLOY_LOG:-}" ]]; then
    init_deploy_log_dir
  else
    mkdir -p "$PASEO_DEPLOY_RUN_DIR"
    : >>"${PASEO_DEPLOY_LOG}"
    log "Continuing detached deploy (log: $PASEO_DEPLOY_LOG)"
  fi

  # App-only: no git, remotes, daemon, or code-server — just desktop build + install.
  if [[ "${PASEO_DESKTOP_ONLY:-0}" == "1" ]]; then
    log "Desktop-only deploy (PASEO_DESKTOP_ONLY=1) → $DESKTOP_APP"
    if [[ "$IS_MAC_ORCHESTRATOR" != "1" ]]; then
      die "PASEO_DESKTOP_ONLY=1 requires macOS — the desktop app builds only on the MacBook (deploy drives it there via the macbook-desktop job)"
    fi
    ensure_node
    if [[ "${PASEO_BUILD_DESKTOP:-1}" == "0" ]]; then
      die "PASEO_DESKTOP_ONLY=1 requires desktop build (unset PASEO_BUILD_DESKTOP=0)"
    fi
    build_desktop_app
    log "Desktop-only deploy complete"
    if [[ -n "${PASEO_DEPLOY_LOG:-}" ]]; then
      log "Full log: $PASEO_DEPLOY_LOG"
    fi
    return 0
  fi

  # Sequential git phase — must finish (and push) before remotes can pull.
  if [[ "${PASEO_SKIP_LOCAL:-0}" != "1" ]]; then
    ensure_fork_remotes
    ensure_node
    autocommit_local_changes
    sync_local_git
  elif [[ "${PASEO_SKIP_REMOTES:-0}" != "1" ]]; then
    # Remotes-only still needs the branch on origin; local git may already be pushed.
    log "PASEO_SKIP_LOCAL=1 — assuming $ORIGIN_REMOTE/$BRANCH is already up to date"
  fi

  # Config must be on disk before daemons restart below; the config store only
  # reads config.json at boot.
  sync_system_prompt
  sync_omp_verifier_config

  # Post-push: local daemon/desktop + both remotes overlap.
  run_parallel_post_push_deploy

  # Settings push needs remotes reachable and code-server units present.
  sync_code_server_settings_to_remotes
  sync_code_server_user_data

  log "Sync complete"
  if [[ -n "${PASEO_DEPLOY_LOG:-}" ]]; then
    log "Full log: $PASEO_DEPLOY_LOG"
  fi
}

main "$@"