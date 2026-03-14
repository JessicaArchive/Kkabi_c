#!/bin/bash
# Start all Kkabi bots (main + workers)
# Usage: ./start-all.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIGS_DIR="$SCRIPT_DIR/configs"
PIDS_DIR="$SCRIPT_DIR/.pids"
MAIN_DASHBOARD_PORT=3000

cd "$SCRIPT_DIR"
mkdir -p "$PIDS_DIR"

# Load fnm environment so node/npm/npx are available in shell launchers.
eval "$(fnm env --shell bash)"

cleanup_pid_files() {
  for pidfile in "$PIDS_DIR"/*.pid; do
    [ -f "$pidfile" ] || continue
    pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
      echo "[cleanup] Stopping stale process from $(basename "$pidfile" .pid) (PID: $pid)"
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  done
}

cleanup_dashboard_port() {
  local port_pid
  port_pid="$(lsof -tiTCP:"$MAIN_DASHBOARD_PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$port_pid" ]; then
    echo "[cleanup] Releasing port $MAIN_DASHBOARD_PORT from PID: $port_pid"
    kill "$port_pid" 2>/dev/null || true
    sleep 1
  fi
}

cleanup() {
  echo ""
  echo "Stopping all bots..."
  cleanup_pid_files
  wait || true
  echo "All bots stopped."
}

trap cleanup SIGINT SIGTERM

cleanup_pid_files
cleanup_dashboard_port

start_bot() {
  local name="$1"
  local config_path="${2:-}"
  local pid_file="$PIDS_DIR/$name.pid"

  if [ -f "$pid_file" ]; then
    local existing_pid
    existing_pid="$(cat "$pid_file")"
    if kill -0 "$existing_pid" 2>/dev/null; then
      echo "[$name] Already running (PID: $existing_pid)"
      return
    fi
    rm -f "$pid_file"
  fi

  echo "[$name] Starting..."
  if [ -n "$config_path" ]; then
    npx tsx src/index.ts --config "$config_path" &
  else
    npx tsx src/index.ts &
  fi
  local pid=$!
  echo "$pid" > "$pid_file"
  echo "[$name] PID: $pid"
}

start_bot "kkabi"

# Wait for main bot to initialize before starting workers.
sleep 3

if [ -d "$CONFIGS_DIR" ]; then
  for config in "$CONFIGS_DIR"/*.json; do
    [ -f "$config" ] || continue
    name="$(basename "$config" .json)"
    start_bot "$name" "$config"
    sleep 2
  done
fi

echo ""
echo "All bots started. PID files saved in .pids/"
echo "To stop all: ./scripts/stop-all.sh"
wait
