#!/usr/bin/env bash
#
# omp-stats-fleet.sh — the real `omp stats` dashboard over ALL hosts at once.
#
# `omp stats` reads exactly one SQLite file, `getStatsDbPath()`, and has no
# remote/merge support (checked upstream: no such feature or issue exists).
# But that path is profile-relative:
#
#   ~/.omp/stats.db                     <- your real DB, NEVER touched by this script
#   ~/.omp/profiles/fleet/stats.db      <- OMP_PROFILE=fleet reads this instead
#
# So we synthesize a merged DB inside a throwaway profile and start the stock
# dashboard against it. No omp fork, no rebuild, no file swapping, no backup to
# restore if this dies halfway.
#
# Two things make the merged DB behave:
#   1. The empty profile has no session files, so the dashboard's sync pass finds
#      nothing and never rewrites the rows we imported.
#   2. `session_file` is prefixed per host, which both prevents UNIQUE collisions
#      and keeps the messages<->tool_calls / user_messages joins intact (they key
#      on session_file, not on rowids).
#
# Host attribution: `folder` is rewritten to "<host> · <folder>" so the dashboard's
# Folder dimension doubles as a per-host breakdown. Everything else (Overview,
# Models, Providers, Tools, Behavior, Requests) shows the combined fleet.
#
# Usage:
#   scripts/omp-stats-fleet.sh                  # sync + merge + open dashboard
#   scripts/omp-stats-fleet.sh --no-sync        # reuse each host's existing DB state
#   scripts/omp-stats-fleet.sh --merge-only     # build the DB, don't start the server
#   scripts/omp-stats-fleet.sh --summary        # merged text summary instead of dashboard
#   scripts/omp-stats-fleet.sh --json           # merged JSON instead of dashboard
#
#   OMP_FLEET_HOSTS="local blrofc3"   # subset; "local" means this Mac
#   OMP_FLEET_PROFILE=fleet           # profile name (=> ~/.omp/profiles/<name>)
#   OMP_FLEET_PORT=3848               # dashboard port (default 3848, one above stock)
#
set -euo pipefail

HOSTS=(${OMP_FLEET_HOSTS:-local blrofc3 iammvaibhav})
PROFILE="${OMP_FLEET_PROFILE:-fleet}"
PORT="${OMP_FLEET_PORT:-3848}"
DO_SYNC=1
MODE="dashboard"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-sync) DO_SYNC=0 ;;
    --merge-only) MODE="merge-only" ;;
    --summary) MODE="summary" ;;
    --json) MODE="json" ;;
    -h|--help) sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

log() { printf '\033[2m[fleet]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m[fleet] %s\033[0m\n' "$*" >&2; exit 1; }

command -v omp >/dev/null || die "omp not on PATH"
command -v sqlite3 >/dev/null || die "sqlite3 not on PATH"

CONFIG_ROOT="${HOME}/.omp"
PROFILE_ROOT="${CONFIG_ROOT}/profiles/${PROFILE}"
MERGED_DB="${PROFILE_ROOT}/stats.db"
[[ "$MERGED_DB" == "${CONFIG_ROOT}/stats.db" ]] && die "refusing to target the real stats.db"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/omp-fleet.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

SNAPSHOT_JS="${WORK}/snapshot.js"
cat > "$SNAPSHOT_JS" <<'JS'
// VACUUM INTO writes one consistent file with the WAL already folded in, so we
// never copy a live db+wal pair and hope it recovers. No backticks or single
// quotes in here: this file is also run over ssh.
import { Database } from "bun:sqlite";
const src = process.env.FLEET_SRC;
const dst = process.env.FLEET_DST;
const db = new Database(src, { readonly: true });
db.run("PRAGMA busy_timeout = 10000");
db.run("VACUUM INTO " + JSON.stringify(dst));
db.close();
JS

# ---------------------------------------------------------------------------
# 1. Per host: sync sessions into its own stats.db, then snapshot it here.
#    Remotes have no sqlite3 CLI, but they do have bun (omp runs on it).
# ---------------------------------------------------------------------------
REMOTE_PATH='PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"'

snapshot_host() {
  local host="$1" out="$2"

  if [[ "$host" == "local" ]]; then
    if (( DO_SYNC )); then omp stats --summary >/dev/null 2>&1 || log "local sync warned"; fi
    FLEET_SRC="${CONFIG_ROOT}/stats.db" FLEET_DST="$out" bun "$SNAPSHOT_JS" || die "local: snapshot failed"
  else
    if (( DO_SYNC )); then
      ssh "$host" "${REMOTE_PATH}; omp stats --summary" >/dev/null 2>&1 || log "$host sync warned"
    fi
    scp -q "$SNAPSHOT_JS" "${host}:/tmp/omp-fleet-snapshot.js" || die "$host: script upload failed"
    ssh "$host" "${REMOTE_PATH}; FLEET_SRC=\"\$HOME/.omp/stats.db\" FLEET_DST=/tmp/omp-fleet-snap.db bun /tmp/omp-fleet-snapshot.js" \
      || die "$host: snapshot failed"
    scp -q "${host}:/tmp/omp-fleet-snap.db" "$out" || die "$host: fetch failed"
    ssh "$host" 'rm -f /tmp/omp-fleet-snap.db /tmp/omp-fleet-snapshot.js' || true
  fi
  [[ -s "$out" ]] || die "$host: empty snapshot"
}

log "hosts: ${HOSTS[*]} (sync=$DO_SYNC)"
pids=()
for host in "${HOSTS[@]}"; do
  snapshot_host "$host" "${WORK}/${host}.db" &
  pids+=($!)
done
fail=0
for pid in "${pids[@]}"; do wait "$pid" || fail=1; done
(( fail )) && die "one or more hosts failed to snapshot"

# ---------------------------------------------------------------------------
# 2. Let stock omp create the merged DB, so the schema always matches the
#    installed omp version and every backfill key is already marked complete
#    (an unmarked key makes initDb wipe imported rows on the next open).
# ---------------------------------------------------------------------------
mkdir -p "$PROFILE_ROOT"
log "initializing profile schema: ${MERGED_DB/#$HOME/\~}"
OMP_PROFILE="$PROFILE" omp stats --summary >/dev/null 2>&1 || true
[[ -f "$MERGED_DB" ]] || die "omp did not create $MERGED_DB"
sqlite3 "$MERGED_DB" "select 1 from sqlite_master where name='messages'" | grep -q 1 \
  || die "merged DB has no schema"

# ---------------------------------------------------------------------------
# 3. Merge. Derived tables are rebuilt from scratch every run (idempotent);
#    meta/file_offsets are left alone.
# ---------------------------------------------------------------------------
# ATTACH is illegal inside a transaction, so every source is attached up front
# under its own alias, then all inserts run as one atomic pass.
{
  echo ".timeout 10000"
  i=0
  for host in "${HOSTS[@]}"; do
    printf "ATTACH DATABASE '%s' AS src%d;\n" "${WORK}/${host}.db" "$i"
    i=$((i + 1))
  done

  echo "BEGIN;"
  echo "DELETE FROM messages; DELETE FROM user_messages; DELETE FROM tool_calls; DELETE FROM file_offsets;"
  i=0
  for host in "${HOSTS[@]}"; do
    label="$host"; [[ "$host" == "local" ]] && label="local-mac"
    src="src${i}"
    i=$((i + 1))
    # session_file prefix: row uniqueness + join integrity across hosts.
    # folder prefix: host attribution in the dashboard's Folder dimension.
    cat <<SQL
INSERT INTO messages (session_file, entry_id, folder, model, provider, api, timestamp, duration, ttft,
  stop_reason, error_message, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  total_tokens, premium_requests, cost_input, cost_output, cost_cache_read, cost_cache_write,
  cost_total, agent_type)
SELECT '${label}!' || session_file, entry_id, '${label} · ' || folder, model, provider, api, timestamp,
  duration, ttft, stop_reason, error_message, input_tokens, output_tokens, cache_read_tokens,
  cache_write_tokens, total_tokens, premium_requests, cost_input, cost_output, cost_cache_read,
  cost_cache_write, cost_total, agent_type
FROM ${src}.messages;

INSERT INTO user_messages (session_file, entry_id, folder, timestamp, model, provider, chars, words,
  yelling, profanity, anguish, negation, repetition, blame)
SELECT '${label}!' || session_file, entry_id, '${label} · ' || folder, timestamp, model, provider,
  chars, words, yelling, profanity, anguish, negation, repetition, blame
FROM ${src}.user_messages;

INSERT INTO tool_calls (session_file, entry_id, tool_call_id, folder, tool_name, model, provider,
  timestamp, agent_type, calls_in_turn, args_chars, result_chars, is_error)
SELECT '${label}!' || session_file, entry_id, tool_call_id, '${label} · ' || folder, tool_name, model,
  provider, timestamp, agent_type, calls_in_turn, args_chars, result_chars, is_error
FROM ${src}.tool_calls;
SQL
  done
  echo "COMMIT;"
} | sqlite3 -bail "$MERGED_DB" || die "merge failed"

sqlite3 -noheader "$MERGED_DB" "
  select 'combined: ' || count(*) || ' requests, ' || printf('\$%.2f', coalesce(sum(cost_total), 0)) ||
         ', ' || date(min(timestamp) / 1000, 'unixepoch') || ' -> ' ||
         date(max(timestamp) / 1000, 'unixepoch')
  from messages
  union all
  select '  ' || host || ': ' || reqs || ' requests, ' || printf('\$%.2f', cost)
  from (select substr(folder, 1, instr(folder, ' · ') - 1) as host, count(*) as reqs,
               sum(cost_total) as cost
        from messages group by 1 order by cost desc);" \
  | while read -r line; do log "$line"; done

# ---------------------------------------------------------------------------
# 4. Serve. Same stock dashboard, pointed at the merged profile.
# ---------------------------------------------------------------------------
case "$MODE" in
  merge-only) log "merged DB ready: ${MERGED_DB/#$HOME/\~}"; log "serve it with: OMP_PROFILE=${PROFILE} omp stats -p ${PORT}" ;;
  summary)    exec env OMP_PROFILE="$PROFILE" omp stats --summary ;;
  json)       exec env OMP_PROFILE="$PROFILE" omp stats --json ;;
  dashboard)  log "dashboard: http://127.0.0.1:${PORT} (Ctrl-C to stop)"
              exec env OMP_PROFILE="$PROFILE" omp stats -p "$PORT" ;;
esac
