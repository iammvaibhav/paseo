#!/usr/bin/env bash
# Make sure this host's webhook tunnel can run. Run by scripts/deploy/main.ts on
# hosts whose inventory entry sets `tunnel`. Never fails the deploy.
#
#   tunnel.sh cloudflared        install cloudflared if missing; the daemon runs
#                                the quick tunnel itself (PASEO_TUNNEL_AUTOSTART)
#   tunnel.sh tailscale-funnel   keep `tailscale funnel` proxying to the daemon
set -uo pipefail
provider="${1:-}"
say() { printf '  [%s] %s\n' "$provider" "$*"; }

case "$provider" in
  cloudflared)
    if command -v cloudflared >/dev/null 2>&1; then
      say "installed ($(command -v cloudflared))"
      exit 0
    fi
    case "$(uname -m)" in
      x86_64 | amd64) arch=amd64 ;;
      aarch64 | arm64) arch=arm64 ;;
      *) say "unsupported arch $(uname -m); install cloudflared manually"; exit 0 ;;
    esac
    mkdir -p "$HOME/.local/bin"
    if curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}" \
      -o "$HOME/.local/bin/cloudflared"; then
      chmod +x "$HOME/.local/bin/cloudflared"
      say "installed to ~/.local/bin/cloudflared"
    else
      say "download failed; install cloudflared manually"
    fi
    ;;
  tailscale-funnel)
    command -v tailscale >/dev/null 2>&1 || { say "tailscale not found; skipping"; exit 0; }
    listen="$(grep -oE '"listen"[[:space:]]*:[[:space:]]*"[^"]+"' "$HOME/.paseo/config.json" 2>/dev/null \
      | head -n 1 | grep -oE '"[^"]+"$' | tr -d '"')"
    target="http://${listen:-127.0.0.1:6767}"
    target="${target/0.0.0.0/127.0.0.1}"
    if tailscale funnel status 2>/dev/null | grep -qF "$target"; then
      say "proxying to $target"
      exit 0
    fi
    sudo -n tailscale set --operator="$USER" >/dev/null 2>&1 || true
    if tailscale funnel --bg "$target" >/dev/null 2>&1; then
      say "funnel up -> $target"
    else
      say "failed; run: sudo tailscale set --operator=$USER && tailscale funnel --bg $target"
    fi
    ;;
  *)
    echo "usage: tunnel.sh cloudflared|tailscale-funnel" >&2
    exit 0
    ;;
esac
