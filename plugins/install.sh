#!/usr/bin/env bash
# Install or update this repo's omp plugins on one host.
#
# omp discovers plugins under ~/.omp/plugins: every entry in node_modules/ whose
# package.json carries an `omp.extensions` manifest is loaded at process start,
# and omp-plugins.lock.json decides whether it stays enabled. Bun loads the
# TypeScript entry directly, so there is no build step.
#
# Plugins are COPIED, not symlinked into the checkout. Symlinking looks tidier
# and gives free updates on git pull, but it makes every omp process on the host
# depend on one directory staying put and staying on one branch: a Paseo
# worktree is disposable, and a branch switch would silently change agent
# routing. A copy plus a content stamp keeps installs deterministic and makes
# re-running cheap.
#
# Two deliberate non-behaviors:
#   - A foreign install (a directory or symlink this script did not create) is
#     moved aside, never deleted. On the machine where these plugins were first
#     written by hand, that may be the only copy of something not yet vendored.
#   - `enabled` is only defaulted for a NEW lock entry. Deploy must never
#     re-enable a plugin someone turned off on that host.
#
# Running omp processes are unaffected: extensions are read when a process
# starts, so an update applies to newly spawned agents.
#
# Usage: bash plugins/install.sh [host-label]
set -euo pipefail

HOST_LABEL="${1:-local}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT_DIR/plugins"
OMP_PLUGIN_DIR="${OMP_PLUGIN_DIR:-$HOME/.omp/plugins}"
MODULES_DIR="$OMP_PLUGIN_DIR/node_modules"
LOCK_FILE="$OMP_PLUGIN_DIR/omp-plugins.lock.json"
STAMP_NAME=".paseo-install-stamp"

say() { printf '  [omp-plugins:%s] %s\n' "$HOST_LABEL" "$*"; }

if ! command -v python3 >/dev/null 2>&1; then
  say "python3 not found; cannot update the plugin lock safely — skipping"
  exit 0
fi

# Content signature of a plugin source tree: every tracked file's path and hash.
# Cheap for a handful of small TypeScript files, and it changes whenever any
# file is added, removed, or edited.
plugin_signature() {
  local dir="$1"
  (
    cd "$dir"
    find . -type f ! -name "$STAMP_NAME" -print0 | LC_ALL=C sort -z |
      xargs -0 sha256sum | sha256sum | cut -d' ' -f1
  )
}

mkdir -p "$MODULES_DIR"

installed=0
updated=0
unchanged=0

for plugin_path in "$SRC_DIR"/*/; do
  src="${plugin_path%/}"
  name="$(basename "$src")"
  manifest="$src/package.json"

  [[ -f "$manifest" ]] || continue
  # Only real omp plugins: a package.json with no `omp` manifest key is not
  # something omp would ever load.
  if ! python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if isinstance(d.get("omp"),dict) else 1)' \
    "$manifest" 2>/dev/null; then
    say "$name: no omp manifest, skipped"
    continue
  fi

  version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("version") or "0.0.0")' "$manifest")"
  target="$MODULES_DIR/$name"
  signature="$(plugin_signature "$src")"

  action="install"
  if [[ -f "$target/$STAMP_NAME" ]]; then
    if [[ "$(cat "$target/$STAMP_NAME" 2>/dev/null)" == "$signature" ]]; then
      action="none"
    else
      action="update"
    fi
  elif [[ -e "$target" || -L "$target" ]]; then
    # Not ours: a hand-installed directory, or a symlink from `omp plugin link`.
    backup="${target}.replaced-$(date '+%Y%m%d-%H%M%S')"
    if [[ -L "$target" ]]; then
      # Keep a note of where it pointed; the target itself is somebody's source
      # tree and must not be touched.
      say "$name: existing symlink → $(readlink "$target")"
      rm -f "$target"
    else
      mv "$target" "$backup"
      say "$name: existing install moved aside → $(basename "$backup")"
    fi
  fi

  case "$action" in
    none)
      unchanged=$((unchanged + 1))
      say "$name@$version: up to date"
      ;;
    *)
      rm -rf "$target"
      mkdir -p "$target"
      # -a to preserve the executable bit on any bundled scripts.
      cp -a "$src/." "$target/"
      printf '%s\n' "$signature" >"$target/$STAMP_NAME"
      if [[ "$action" == "update" ]]; then
        updated=$((updated + 1))
        say "$name@$version: updated"
      else
        installed=$((installed + 1))
        say "$name@$version: installed"
      fi
      ;;
  esac

  python3 - "$LOCK_FILE" "$name" "$version" <<'PY'
import json, os, sys, tempfile

lock_path, name, version = sys.argv[1], sys.argv[2], sys.argv[3]

try:
    with open(lock_path, encoding="utf-8") as handle:
        lock = json.load(handle)
except (OSError, ValueError):
    lock = {}
if not isinstance(lock, dict):
    lock = {}

plugins = lock.get("plugins")
if not isinstance(plugins, dict):
    plugins = {}
    lock["plugins"] = plugins

entry = plugins.get(name)
if isinstance(entry, dict):
    # Respect whatever this host decided; only refresh the version.
    state = "kept"
else:
    entry = {"enabledFeatures": None, "enabled": True}
    state = "added"
entry["version"] = version
entry.setdefault("enabledFeatures", None)
entry.setdefault("enabled", True)
plugins[name] = entry

if not isinstance(lock.get("settings"), dict):
    lock["settings"] = {}

os.makedirs(os.path.dirname(lock_path), exist_ok=True)
descriptor, tmp_path = tempfile.mkstemp(dir=os.path.dirname(lock_path))
with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
    json.dump(lock, handle, indent=2)
    handle.write("\n")
os.replace(tmp_path, lock_path)

print(f"    lock entry {state} (enabled={entry['enabled']})")
PY
done

say "installed=$installed updated=$updated unchanged=$unchanged"

# Read-only confirmation that omp itself resolves what we just installed.
if command -v omp >/dev/null 2>&1; then
  omp plugin list --json 2>/dev/null | python3 -c '
import json, sys

try:
    data = json.load(sys.stdin)
except ValueError:
    sys.exit(0)
for plugin in data.get("npm") or []:
    name = plugin.get("name")
    version = plugin.get("version")
    state = "enabled" if plugin.get("enabled") else "disabled"
    print(f"    omp sees {name}@{version} ({state})")
' || true
fi
