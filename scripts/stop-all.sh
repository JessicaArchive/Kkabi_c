#!/bin/bash
# Stop all running bots
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PIDS_DIR="$PROJECT_ROOT/.pids"

if [ ! -d "$PIDS_DIR" ]; then
  echo "No running bots found."
  exit 0
fi

for pidfile in "$PIDS_DIR"/*.pid; do
  [ -f "$pidfile" ] || continue
  name="$(basename "$pidfile" .pid)"
  pid="$(cat "$pidfile")"

  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    echo "Stopped $name (PID: $pid)"
  else
    echo "$name already stopped (PID: $pid)"
  fi
  rm "$pidfile"
done

echo "All bots stopped."
rmdir "$PIDS_DIR" 2>/dev/null || true
