#!/usr/bin/env bash
# Bring a builder's checkout (the current directory) to the commit deploy is
# shipping and install dependencies when they changed. Run by
# scripts/deploy/main.ts on each builder.
#
# Env: EXPECT  commit the checkout must end up at
#      BRANCH  branch to fast-forward from origin
#      FETCH   1 = fetch + fast-forward (remote builders); 0 = this checkout
#              is the one deploy runs from, already at EXPECT
#
# Never discards work: a dirty or diverged checkout stops the job.
set -euo pipefail

if [[ "$FETCH" == "1" ]]; then
  git fetch -q origin --prune
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "checkout $PWD has uncommitted changes; commit or discard them, then redeploy" >&2
    exit 1
  fi
  git checkout -q "$BRANCH" 2>/dev/null || git checkout -q -b "$BRANCH" "origin/$BRANCH"
  if ! git merge -q --ff-only "origin/$BRANCH"; then
    echo "checkout $PWD diverged from origin/$BRANCH; run: git merge origin/$BRANCH" >&2
    exit 1
  fi
fi
head="$(git rev-parse HEAD)"
if [[ "$head" != "$EXPECT"* ]]; then
  echo "checkout is at ${head:0:9}, deploy ships ${EXPECT:0:9} (origin moved during the deploy?)" >&2
  exit 1
fi

# Dependencies: reinstall when the lockfile, a package.json, or the patches
# changed since the last install here. Patches are re-applied every time: a
# plain `pnpm install` skips lifecycle scripts when nothing changed.
ref_file="$HOME/.paseo-sync-ref"
prev="$(cat "$ref_file" 2>/dev/null || true)"
if [[ -z "$prev" ]] || ! git cat-file -e "$prev^{commit}" 2>/dev/null \
  || git diff --name-only "$prev" "$head" \
  | grep -Eq '(^|/)package\.json$|^pnpm-lock\.yaml$|^pnpm-workspace\.yaml$|^patches/|^scripts/postinstall-patches\.mjs$'; then
  echo "installing dependencies"
  corepack enable && corepack prepare pnpm@11.22.0 --activate && pnpm install --frozen-lockfile
fi
if [[ -x node_modules/.bin/patch-package ]]; then
  PATH="$PWD/node_modules/.bin:$PATH" node scripts/postinstall-patches.mjs
fi
echo "$head" >"$ref_file"
echo "checkout at ${head:0:9}"
