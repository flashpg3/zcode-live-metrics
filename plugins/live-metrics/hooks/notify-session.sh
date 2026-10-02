#!/bin/bash
# Hook entry (SessionStart / UserPromptSubmit / Stop). Writes the
# active-session signal (the focus anchor) and revives a dead daemon.
# Always exit 0, never output: the session must not notice us (PRD §3).
set -u
ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DATA_DIR="${ZCODE_METRICS_PLUGIN_DATA:-${TMPDIR:-/tmp}/zcode-live-metrics}"

input="$(cat)"
session_id="$(printf '%s' "$input" | sed -n 's/.*"session_id"[: ]*"\(sess_[A-Za-z0-9._-]*\)".*/\1/p' | head -1)"
[ -z "$session_id" ] && session_id="$(printf '%s' "$input" | sed -n 's/.*"sessionId"[: ]*"\(sess_[A-Za-z0-9._-]*\)".*/\1/p' | head -1)"
event="$(printf '%s' "$input" | sed -n 's/.*"hook_event_name"[: ]*"\([A-Za-z_]*\)".*/\1/p' | head -1)"

mkdir -p "$DATA_DIR"

# Stop intentionally does NOT refresh the signal: a background task finishing
# in session A must not yank focus away from the session the user looks at.
if [ -n "$session_id" ] && [ "$event" != "Stop" ]; then
  tmp="$DATA_DIR/active-session.json.$$"
  printf '{"sessionId":"%s","ts":%s}' "$session_id" "$(($(date +%s) * 1000))" > "$tmp"
  mv "$tmp" "$DATA_DIR/active-session.json"
fi

# Revive the daemon when gone: pid must be alive AND be one of ours
# (guards against PID reuse claiming a false positive).
daemon_ok=0
pid_file="$DATA_DIR/daemon.pid"
if [ -f "$pid_file" ]; then
  pid="$(cat "$pid_file" 2>/dev/null)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    if ps -p "$pid" -o command= 2>/dev/null | grep -q "live-metrics\|server/main\.mjs"; then
      daemon_ok=1
    fi
  fi
fi
if [ "$daemon_ok" -eq 0 ]; then
  CLAUDE_PLUGIN_ROOT="$ROOT" nohup "$ROOT/scripts/launch.sh" daemon >/dev/null 2>&1 &
  disown 2>/dev/null || true
fi
exit 0
