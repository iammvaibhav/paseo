#!/usr/bin/env bash
# Paseo fleet deploy: ./scripts/deploy.sh [desktop] [--help]
# The deploy itself lives in scripts/deploy/main.ts; this picks the Node it runs
# on. Node 22 (the repo's .tool-versions major) runs the TypeScript directly.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null
  nvm use --silent 22 >/dev/null
fi
exec node "$root/scripts/deploy/main.ts" "$@"
