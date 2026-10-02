#!/bin/bash
# Resolve a Node (>=18) then exec the server in the requested mode.
# Usage: launch.sh daemon   |   launch.sh            (MCP stdio mode)
ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

node_bin() {
  if [ -n "${ZCODE_METRICS_NODE:-}" ] && [ -x "$ZCODE_METRICS_NODE" ]; then
    echo "$ZCODE_METRICS_NODE"; return
  fi
  if command -v node >/dev/null 2>&1; then command -v node; return; fi
  for c in /opt/homebrew/bin/node /usr/local/bin/node /snap/bin/node; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  for c in "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  echo ""
}

NODE_BIN="$(node_bin)"
if [ -z "$NODE_BIN" ]; then
  echo "live-metrics: node (>=18) not found; set ZCODE_METRICS_NODE" >&2
  exit 1
fi
exec "$NODE_BIN" "$ROOT/server/main.mjs" "$@"
