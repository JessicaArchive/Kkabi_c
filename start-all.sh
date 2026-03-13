#!/bin/bash
# Start all Kkabi bots (main + workers)
# Usage: ./start-all.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Load fnm environment
eval "$(fnm env)"

PIDS=()

cleanup() {
  echo ""
  echo "Stopping all bots..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait
  echo "All bots stopped."
}

trap cleanup SIGINT SIGTERM

# Start main bot (kkabi)
echo "[kkabi] Starting main bot..."
npx tsx src/index.ts &
PIDS+=($!)
echo "[kkabi] PID: $!"

# Wait for main bot to initialize before starting workers
sleep 3

# Start worker bots from configs/
if [ -d "configs" ]; then
  for config in configs/*.json; do
    [ -f "$config" ] || continue
    name=$(basename "$config" .json)
    echo "[${name}] Starting worker bot..."
    npx tsx src/index.ts --config "$config" &
    PIDS+=($!)
    echo "[${name}] PID: $!"
    sleep 2
  done
fi

echo ""
echo "All bots started. Press Ctrl+C to stop all."
wait
