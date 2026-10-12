#!/bin/sh
# Run a heavy TypeScript compiler command in a machine-wide slot.
#
#   sh scripts/cpu-slot.sh <slot> <command> [args...]
#
# Every worktree on a host shares one lock per slot under /tmp, so at most one
# command per slot runs at a time; the rest wait in line instead of fighting for
# CPU and memory (each tsgo/tsc run takes about a core and 1-4 GB). Package
# scripts use two slots, "typecheck" and "build", so one of each can overlap.
#
# Wrap only leaf compiler invocations, never a script that calls another wrapped
# script: flock is not reentrant across processes, so nesting deadlocks.
# Hosts without flock (macOS) run the command unqueued.
set -eu

slot="$1"
shift

if ! command -v flock >/dev/null 2>&1; then
  exec "$@"
fi

lock="/tmp/paseo-cpu-slot-$slot.lock"
exec 9>>"$lock"
if ! flock -n 9; then
  echo "cpu-slot: waiting for the '$slot' slot, another worktree holds $lock" >&2
  flock 9
fi
# fd 9 stays open in the exec'd command, so the lock is held until it exits.
exec "$@"
