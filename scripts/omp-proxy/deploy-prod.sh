#!/usr/bin/env bash
# Deploy the prod omp services (omp-auth-broker, omp-proxy, omp-grok-refresher,
# bifrost units + the omp-proxy binary) version-locked with the fleet omp.
#
# Invoked by scripts/deploy.sh (prod_job) after the orchestrator's `omp update`
# sets OMP_TARGET_VERSION. Never run by hand unless OMP_TARGET_VERSION is set.
set -euo pipefail

PROD_HOST="${PASEO_PROD_HOST:-prod}"
TARGET="${OMP_TARGET_VERSION:?prod: OMP_TARGET_VERSION must be set (run via scripts/deploy.sh)}"
PROXY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() {
  printf '\n[%s:prod] %s\n' "$(date '+%H:%M:%S')" "$*"
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

SSH=(ssh -o BatchMode=yes)

# The proxy compiles for linux-arm64, and prod is aarch64: only this
# orchestrator can build a binary prod can run.
if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "aarch64" ]]; then
  log "prod: skipped (build host must be linux-arm64)"
  exit 0
fi

if ! "${SSH[@]}" -o ConnectTimeout=8 "$PROD_HOST" 'true' 2>/dev/null; then
  die "prod: host $PROD_HOST unreachable"
fi
log "prod ($PROD_HOST) reachable — fleet omp target $TARGET"

# The proxy links exact @oh-my-pi/* natives: its pin must equal the fleet omp,
# or a fresh omp would delete the natives the proxy was built against.
if command -v node >/dev/null 2>&1; then
  PINNED="$(node -p 'require(process.argv[1]).dependencies["@oh-my-pi/pi-ai"]' "$PROXY_DIR/package.json")"
elif command -v jq >/dev/null 2>&1; then
  PINNED="$(jq -r '.dependencies["@oh-my-pi/pi-ai"]' "$PROXY_DIR/package.json")"
else
  die "prod: need node or jq to read the omp-proxy pin"
fi
if [[ "$PINNED" != "$TARGET" ]]; then
  die "prod: omp-proxy is pinned to $PINNED but the fleet is on $TARGET; run scripts/omp-proxy/bump.sh $TARGET, commit, redeploy"
fi
log "prod: omp-proxy pinned to $PINNED — matches fleet"

export PATH="$HOME/.bun/bin:$PATH"
log "prod: building omp-proxy"
(cd "$PROXY_DIR" && bun install --frozen-lockfile && bun run build) || die "prod: omp-proxy build failed"
DIST="$PROXY_DIR/dist/omp-proxy"
[[ -x "$DIST" ]] || die "prod: build did not produce $DIST"
LOCAL_SHA="$(sha256sum "$DIST" | awk '{print $1}')"
log "prod: built $DIST (sha256 $LOCAL_SHA)"

# --- Idempotence: touch prod only when something drifted -----------------------
PROD_OMP="$("${SSH[@]}" "$PROD_HOST" '~/.local/bin/omp --version 2>/dev/null' | sed -e 's/^omp\///' -e 's/[[:space:]]//g' || true)"
PROD_SHA="$("${SSH[@]}" "$PROD_HOST" 'sha256sum ~/.local/bin/omp-proxy 2>/dev/null' | awk '{print $1}' || true)"
HEALTH="$("${SSH[@]}" "$PROD_HOST" 'curl -fsS --max-time 5 127.0.0.1:4317/healthz 2>/dev/null' | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("version", ""), end="")
except Exception:
    pass' 2>/dev/null || true)"
BROKER_EXE="$("${SSH[@]}" "$PROD_HOST" 'pid=$(systemctl --user show omp-auth-broker -p MainPID --value 2>/dev/null); if [[ -n "$pid" && "$pid" != "0" ]]; then readlink "/proc/$pid/exe" 2>/dev/null || true; fi' || true)"

units_same=1
for svc in omp-auth-broker omp-proxy omp-grok-refresher bifrost; do
  if ! diff -q "$PROXY_DIR/deploy/$svc.service" \
      <("${SSH[@]}" "$PROD_HOST" "cat ~/.config/systemd/user/$svc.service" 2>/dev/null) >/dev/null 2>&1; then
    units_same=0
    break
  fi
done

if [[ "$PROD_OMP" == "$TARGET" && "$PROD_SHA" == "$LOCAL_SHA" && "$HEALTH" == "$TARGET" \
  && -n "$BROKER_EXE" && "$BROKER_EXE" != *"(deleted)"* && "$units_same" == "1" ]]; then
  log "prod: up to date (omp + omp-proxy $TARGET)"
  exit 0
fi
log "prod: drift detected (omp=$PROD_OMP proxy=${PROD_SHA:0:12} health=$HEALTH broker_exe=$BROKER_EXE units_same=$units_same) — redeploying"

# --- Deploy: stage files, then mutate in one ssh session -----------------------
STAGE="$("${SSH[@]}" "$PROD_HOST" 'mktemp -d')"
cleanup_stage() {
  if [[ -n "${STAGE:-}" ]]; then
    "${SSH[@]}" "$PROD_HOST" "rm -rf '$STAGE'" 2>/dev/null || true
  fi
}
trap cleanup_stage EXIT
scp -o BatchMode=yes "$PROXY_DIR"/deploy/*.service "$PROD_HOST:$STAGE/"
scp -o BatchMode=yes "$DIST" "$PROD_HOST:.local/bin/omp-proxy.new"

# The token goes over stdin, not the ssh command line, so it never shows in
# prod's process list.
{
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then printf 'GITHUB_TOKEN=%q\n' "$GITHUB_TOKEN"; fi
  cat <<'REMOTE'
set -euo pipefail
# omp installs to ~/.local/bin, which the non-interactive ssh shell lacks.
export PATH="$HOME/.local/bin:$PATH"
trap 'rm -rf "$STAGE"' EXIT
log() { printf '\n[%s:prod] %s\n' "$(date '+%H:%M:%S')" "$*"; }
unit_fail() {
  local unit="$1"; shift
  log "prod: $unit failed: $*"
  systemctl --user status "$unit" --no-pager 2>&1 || true
  journalctl --user -u "$unit" -n 30 --no-pager 2>&1 || true
  exit 1
}

# omp and the proxy move together: update first, verify, and stop before
# touching services on mismatch (a new omp deletes the old natives dir).
command -v omp >/dev/null 2>&1 || unit_fail omp-auth-broker "omp not installed on prod"
if [[ "$OMP_SKIP_UPDATE" == "1" ]]; then
  log "prod: skipping omp update (PASEO_SKIP_OMP_UPDATE=1)"
else
  log "prod: updating omp (fleet target $TARGET)"
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then export GITHUB_TOKEN; fi
  omp update
fi
ver="$(omp --version 2>/dev/null | sed -e 's/^omp\///' -e 's/[[:space:]]//g')"
[[ "$ver" == "$TARGET" ]] || unit_fail omp-auth-broker "omp version mismatch: got $ver, fleet target $TARGET"
log "prod: omp at $ver"

changed=0
for svc in omp-auth-broker omp-proxy omp-grok-refresher bifrost; do
  if ! cmp -s "$STAGE/$svc.service" "$HOME/.config/systemd/user/$svc.service" 2>/dev/null; then
    install -m 644 "$STAGE/$svc.service" "$HOME/.config/systemd/user/$svc.service"
    log "prod: installed $svc.service"
    changed=1
  fi
done
if [[ "$changed" == "1" ]]; then
  systemctl --user daemon-reload
fi

cur="$(sha256sum ~/.local/bin/omp-proxy 2>/dev/null | awk '{print $1}' || true)"
if [[ "$cur" != "$LOCAL_SHA" ]]; then
  if [[ -f ~/.local/bin/omp-proxy ]]; then
    cp -f ~/.local/bin/omp-proxy ~/.local/bin/omp-proxy.prev
  fi
  chmod +x ~/.local/bin/omp-proxy.new
  mv -f ~/.local/bin/omp-proxy.new ~/.local/bin/omp-proxy
  log "prod: installed omp-proxy (previous kept as omp-proxy.prev)"
else
  rm -f ~/.local/bin/omp-proxy.new
fi

systemctl --user restart omp-auth-broker || unit_fail omp-auth-broker "restart failed"
bind="$(grep -oE -- '--bind=[^ ]+' ~/.config/systemd/user/omp-auth-broker.service | head -1 | cut -d= -f2)"
bind="${bind:-100.123.97.105:8770}"
bhost="${bind%:*}"
bport="${bind##*:}"
broker_ok=0
for i in $(seq 1 30); do
  if systemctl --user is-active --quiet omp-auth-broker && (echo >/dev/tcp/"$bhost"/"$bport") 2>/dev/null; then
    broker_ok=1
    break
  fi
  sleep 1
done
[[ "$broker_ok" == "1" ]] || unit_fail omp-auth-broker "not active on $bind after 30s"
log "prod: omp-auth-broker active ($bind)"

# bifrost fronts the proxy and never needs a restart for this.
systemctl --user restart omp-proxy || unit_fail omp-proxy "restart failed"
systemctl --user restart omp-grok-refresher || unit_fail omp-grok-refresher "restart failed"
proxy_ok=0
hv=""
for i in $(seq 1 60); do
  hv="$(curl -fsS --max-time 2 127.0.0.1:4317/healthz 2>/dev/null | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("version", ""), end="")
except Exception:
    pass' 2>/dev/null || true)"
  if [[ "$hv" == "$TARGET" ]] \
    && systemctl --user is-active --quiet omp-proxy \
    && systemctl --user is-active --quiet omp-grok-refresher; then
    proxy_ok=1
    break
  fi
  sleep 1
done
[[ "$proxy_ok" == "1" ]] || unit_fail omp-proxy "healthz version '$hv' != '$TARGET' after 60s"
log "prod: omp-proxy healthy (version $hv)"
REMOTE
} | "${SSH[@]}" "$PROD_HOST" \
  "TARGET='$TARGET' LOCAL_SHA='$LOCAL_SHA' STAGE='$STAGE' OMP_SKIP_UPDATE='${PASEO_SKIP_OMP_UPDATE:-0}' bash -s"

log "prod: deploy complete (omp + omp-proxy $TARGET)"
