#!/usr/bin/env bash
# Update the Nix `pnpmDeps` fixed-output-derivation hash for the pnpm
# workspace lockfile.
# Requires: node, nix
#
# Usage:
#   ./scripts/update-nix.sh          # update hash
#   ./scripts/update-nix.sh --check  # verify everything is up to date (CI mode)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HASH_FILE="$ROOT_DIR/nix/pnpm-deps.hash"

CHECK_MODE=false
if [[ "${1:-}" == "--check" ]]; then
  CHECK_MODE=true
fi

# Unlike npm, pnpm always writes complete `resolved`/`integrity` metadata
# into pnpm-lock.yaml. The workspace-local-entries bug that fix-lockfile.mjs
# worked around (https://github.com/npm/cli/issues/4460) was npm-specific
# and does not affect pnpm, so there is no lockfile-fixing step here anymore.

CURRENT_HASH="$(tr -d '[:space:]' < "$HASH_FILE")"

# nixpkgs does not ship a standalone `prefetch-pnpm-deps` CLI analogous to
# `prefetch-npm-deps` (as of the nixpkgs revision pinned in flake.lock), so
# there is no single command that returns the `fetchPnpmDeps` hash directly.
# The technique documented at
# https://nixos.org/manual/nixpkgs/unstable/#javascript-pnpm (and echoed by
# nixpkgs' own pnpm-config-hook.sh error message: "Set pnpmDeps.hash to ''
# (empty string) ... Build the derivation and wait for it to fail with a
# hash mismatch ... Copy the 'got: sha256-' value back into the pnpmDeps.hash
# field") is: write a hash that can never match, let the `pnpmDeps`
# fixed-output derivation fail, and read the real hash off the build's
# "got: sha256-..." line. Do that here against our own flake's `default`
# package (the daemon derivation in nix/package.nix), which requires
# network access to actually fetch the pnpm store, same as the old
# `prefetch-npm-deps` invocation did.
PLACEHOLDER_HASH="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
printf '%s\n' "$PLACEHOLDER_HASH" > "$HASH_FILE"

BUILD_LOG="$(mktemp)"
trap "rm -f '$BUILD_LOG'" EXIT

echo "Building with a placeholder pnpmDeps hash to discover the real one..."
if nix build "$ROOT_DIR#default" --no-link >"$BUILD_LOG" 2>&1; then
  echo "ERROR: build unexpectedly succeeded with a placeholder hash." >&2
  echo "  A placeholder hash can never match a real fixed-output-derivation hash." >&2
  cat "$BUILD_LOG" >&2
  printf '%s\n' "$CURRENT_HASH" > "$HASH_FILE"
  exit 1
fi

NEW_HASH="$(grep -A2 'got:' "$BUILD_LOG" | grep -o 'sha256-[A-Za-z0-9+/=]*' | head -1 || true)"

if [[ -z "$NEW_HASH" ]]; then
  echo "ERROR: could not extract the real pnpmDeps hash from the build failure:" >&2
  tail -40 "$BUILD_LOG" >&2
  printf '%s\n' "$CURRENT_HASH" > "$HASH_FILE"
  exit 1
fi
echo "Computed hash: $NEW_HASH"

if [[ "$NEW_HASH" == "$CURRENT_HASH" ]]; then
  echo "Hash is already up to date."
  printf '%s\n' "$CURRENT_HASH" > "$HASH_FILE"
  exit 0
fi

if $CHECK_MODE; then
  printf '%s\n' "$CURRENT_HASH" > "$HASH_FILE"
  echo "ERROR: pnpmDepsHash is stale."
  echo "  current: $CURRENT_HASH"
  echo "  correct: $NEW_HASH"
  echo "Run ./scripts/update-nix.sh to fix."
  exit 1
fi

echo "Updating nix/pnpm-deps.hash..."
printf '%s\n' "$NEW_HASH" > "$HASH_FILE"
echo "Updated: $CURRENT_HASH -> $NEW_HASH"
