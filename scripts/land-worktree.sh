#!/usr/bin/env bash
#
# scripts/land-worktree.sh — land the current ticket-worktree branch into the
# shared checkout's vaibhav/customizations branch.
#
# Trigger words: "land it", "merge it".
#
# Protocol:
#   Phase A (no lock, rerunnable): merge the shared tip into this worktree
#     branch. On conflict the script stops with the merge left in progress —
#     resolve inside the worktree, commit the resolution, re-run this script.
#   Phase B (under $PASEO_LAND_LOCK): re-read the shared tip; if it moved
#     since Phase A, abort and retry from Phase A (bounded attempts). Else
#     merge this branch into the shared checkout. Check-and-merge is one
#     atomic critical section w.r.t. other script users, so a concurrent land
#     cannot interleave between the tip check and the merge.
#
# The lock is cooperative: it only serializes landers that go through this
# script. Never land by hand while another land is in progress.
#
# Never pushes to origin (deploy owns that). Never touches the shared
# checkout except for the final merge. Refuses to run with a dirty tree.
#
# Env overrides: PASEO_SHARED_CHECKOUT, PASEO_CUSTOM_BRANCH,
#   PASEO_LAND_LOCK, PASEO_LAND_LOCK_TIMEOUT, PASEO_LAND_ATTEMPTS.

set -euo pipefail

SHARED="${PASEO_SHARED_CHECKOUT:-}"
BRANCH="${PASEO_CUSTOM_BRANCH:-vaibhav/customizations}"
LOCK_FILE="${PASEO_LAND_LOCK:-/tmp/paseo-land.lock}"
LOCK_TIMEOUT="${PASEO_LAND_LOCK_TIMEOUT:-60}"
MAX_ATTEMPTS="${PASEO_LAND_ATTEMPTS:-5}"

die() {
  echo "land-worktree: ERROR: $*" >&2
  exit 1
}
log() { echo "land-worktree: $*"; }

command -v flock >/dev/null 2>&1 || die "flock not found (util-linux required)"

WORKTREE_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git worktree"
WORK_BRANCH="$(git -C "$WORKTREE_ROOT" branch --show-current)"
[ -n "$WORK_BRANCH" ] || die "detached HEAD in $WORKTREE_ROOT — check out the ticket branch first"
[ "$WORK_BRANCH" != "$BRANCH" ] || die "already on $BRANCH — run this from the ticket worktree branch"
[ -z "$(git -C "$WORKTREE_ROOT" status --porcelain)" ] || die "worktree has uncommitted changes — commit first"

if [ -z "$SHARED" ]; then
  for candidate in /data/paseo /home/ubuntu/paseo; do
    if git -C "$candidate" rev-parse --git-dir >/dev/null 2>&1; then
      SHARED="$candidate"
      break
    fi
  done
fi
[ -n "$SHARED" ] || die "no shared checkout found; set PASEO_SHARED_CHECKOUT"

# Shared-checkout sanity: right branch, no merge in progress, clean tree.
[ "$(git -C "$SHARED" branch --show-current)" = "$BRANCH" ] ||
  die "shared checkout $SHARED is on $(git -C "$SHARED" branch --show-current), not $BRANCH"
git -C "$SHARED" rev-parse --verify -q MERGE_HEAD >/dev/null &&
  die "shared checkout has a merge in progress — resolve it there first"
[ -z "$(git -C "$SHARED" status --porcelain)" ] ||
  die "shared checkout has uncommitted changes — refusing to merge into a dirty tree"

attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  log "attempt $attempt/$MAX_ATTEMPTS"

  # Phase A — merge shared tip into the worktree branch (no lock held).
  git -C "$WORKTREE_ROOT" fetch -q "$SHARED" "$BRANCH" || die "fetch of $BRANCH from $SHARED failed"
  shared_tip="$(git -C "$WORKTREE_ROOT" rev-parse FETCH_HEAD)"
  if ! git -C "$WORKTREE_ROOT" merge --no-edit -m "Merge branch '$BRANCH' into $WORK_BRANCH" FETCH_HEAD; then
    log "conflicts merging $BRANCH into $WORK_BRANCH."
    log "Resolve inside the worktree, commit the resolution, then re-run $0."
    exit 2
  fi
  work_head="$(git -C "$WORKTREE_ROOT" rev-parse HEAD)"

  # Phase B — atomic check-and-merge under the land lock.
  exec 9>"$LOCK_FILE"
  if ! flock -w "$LOCK_TIMEOUT" 9; then
    exec 9>&-
    die "another land is in progress (could not take $LOCK_FILE in ${LOCK_TIMEOUT}s)"
  fi
  current_tip="$(git -C "$SHARED" rev-parse "$BRANCH")"
  if [ "$current_tip" != "$shared_tip" ]; then
    log "shared tip moved ($shared_tip → $current_tip) while resolving; retrying from Phase A"
    exec 9>&-
    attempt=$((attempt + 1))
    sleep 2
    continue
  fi
  if ! git -C "$SHARED" rev-parse --verify -q MERGE_HEAD >/dev/null &&
    [ -z "$(git -C "$SHARED" status --porcelain)" ] &&
    [ "$(git -C "$SHARED" branch --show-current)" = "$BRANCH" ]; then
    git -C "$SHARED" fetch -q "$WORKTREE_ROOT" HEAD || {
      exec 9>&-
      die "fetch of $WORK_BRANCH from worktree failed"
    }
    if git -C "$SHARED" merge --no-edit -m "Merge branch '$WORK_BRANCH' into $BRANCH" FETCH_HEAD; then
      new_tip="$(git -C "$SHARED" rev-parse "$BRANCH")"
      exec 9>&-
      log "landed $WORK_BRANCH ($work_head) into $BRANCH at $new_tip"
      git -C "$SHARED" log --oneline -2
      log "done. Pushing to origin belongs to ./scripts/deploy.sh — do not push from the worktree."
      exit 0
    fi
    git -C "$SHARED" merge --abort >/dev/null 2>&1 || true
    log "merge conflicted in shared checkout; aborted cleanly, retrying from Phase A"
  else
    log "shared checkout changed under us (dirty/mid-merge/wrong branch); retrying from Phase A"
  fi
  exec 9>&-
  attempt=$((attempt + 1))
  sleep 2
done

die "gave up after $MAX_ATTEMPTS attempts — shared tip keeps moving; retry later"
