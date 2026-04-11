#!/bin/bash
# Start all Kkabi bots inside a tmux session.
# Each bot runs in its own tmux window with auto-restart.
#
# Usage:
#   ./start-tmux.sh          # Start all bots in tmux
#   ./start-tmux.sh attach   # Start and attach to session
#   ./start-tmux.sh stop     # Stop all bots and kill session
#   ./start-tmux.sh status   # Show running bots
#
# Tmux session name: kkabi

set -euo pipefail

# Ensure Homebrew and system binaries (git, tmux, fnm, etc.) are in PATH.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIGS_DIR="$SCRIPT_DIR/configs"
SESSION="kkabi"

cd "$SCRIPT_DIR"

# Load fnm so node/npm/npx are available.
FNM_INIT='eval "$(fnm env --shell bash)"'

# Auto-restart wrapper: runs the command in a loop, restarts on crash.
make_restart_cmd() {
  local label="$1"
  local cmd="$2"
  cat <<WRAPPER
cd "$SCRIPT_DIR" && $FNM_INIT && while true; do
  echo "[$label] Starting at \$(date)"
  $cmd
  EXIT_CODE=\$?
  echo ""
  echo "[$label] Exited (code: \$EXIT_CODE). Restarting in 5s... (\$(date))"
  sleep 5
done
WRAPPER
}

cleanup_orphaned_processes() {
  # start-all.sh / PM2 등 다른 방법으로 띄운 잔존 프로세스도 정리
  local pids
  pids="$(pgrep -f 'src/index.ts' 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "[cleanup] Killing orphaned bot processes: $pids"
    echo "$pids" | xargs kill 2>/dev/null || true
    sleep 2
    pids="$(pgrep -f 'src/index.ts' 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      echo "[cleanup] Force killing: $pids"
      echo "$pids" | xargs kill -9 2>/dev/null || true
    fi
  fi
  # start-all.sh 자체도 정리
  local sh_pids
  sh_pids="$(pgrep -f 'start-all.sh' 2>/dev/null || true)"
  if [ -n "$sh_pids" ]; then
    echo "[cleanup] Killing start-all.sh: $sh_pids"
    echo "$sh_pids" | xargs kill 2>/dev/null || true
  fi
}

cmd_stop() {
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    tmux kill-session -t "$SESSION"
    echo "Kkabi tmux session stopped."
  else
    echo "No kkabi tmux session running."
  fi
  cleanup_orphaned_processes
}

cmd_status() {
  if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "❌ tmux 세션 없음"
    return
  fi
  echo "✅ tmux 세션 실행중"
  echo ""
  while IFS='|' read -r idx name cmd pid; do
    case "$cmd" in
      node|npm|npx|codex|claude|tsx|python|python3)
        echo "  🟢 [$idx] $name — 실행중 ($cmd, pid:$pid)" ;;
      sleep)
        echo "  🟡 [$idx] $name — 재시작 대기중" ;;
      *)
        echo "  🔴 [$idx] $name — 죽음 ($cmd)" ;;
    esac
  done < <(tmux list-windows -t "$SESSION" -F "#{window_index}|#{window_name}|#{pane_current_command}|#{pane_pid}")
}

send_bot_cmd() {
  local target="$1"
  local label="$2"
  local cmd="$3"
  tmux send-keys -t "$target" "cd \"$SCRIPT_DIR\" && $FNM_INIT && while true; do echo \"[$label] Starting at \$(date)\"; $cmd; EXIT_CODE=\$?; echo \"[$label] Exited (\$EXIT_CODE). Restarting in 5s...\"; sleep 5; done" Enter
}

cmd_start() {
  # If session already exists, just report it.
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "Kkabi tmux session already running!"
    cmd_status
    echo ""
    echo "To attach: tmux attach -t $SESSION"
    echo "To stop:   ./start-tmux.sh stop"
    return
  fi

  # 다른 방법으로 띄운 잔존 프로세스 정리
  cleanup_orphaned_processes

  # Clean up stale port.
  local port_pid
  port_pid="$(lsof -tiTCP:3000 -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$port_pid" ]; then
    echo "[cleanup] Releasing port 3000 from PID: $port_pid"
    kill "$port_pid" 2>/dev/null || true
    sleep 1
  fi

  # Create session with main bot.
  tmux new-session -d -s "$SESSION" -n "kkabi"
  send_bot_cmd "$SESSION:kkabi" "kkabi" "npx tsx src/index.ts"
  echo "[kkabi] Started in tmux window 0"
  sleep 3

  # Start worker bots from configs/.
  if [ -d "$CONFIGS_DIR" ]; then
    local idx=1
    for config in "$CONFIGS_DIR"/*.json; do
      [ -f "$config" ] || continue
      local name
      name="$(basename "$config" .json)"
      # codex는 내장 provider — 별도 봇으로 띄우지 않음
      [[ "$name" == "codex" ]] && continue
      tmux new-window -a -t "$SESSION" -n "$name"
      send_bot_cmd "$SESSION:$name" "$name" "npx tsx src/index.ts --config '$config'"
      echo "[$name] Started in tmux window $idx"
      idx=$((idx + 1))
      sleep 2
    done
  fi

  echo ""
  echo "All bots started in tmux session '$SESSION'."
  echo ""
  echo "Commands:"
  echo "  tmux attach -t $SESSION      # View bot output"
  echo "  ./start-tmux.sh status       # Check bot status"
  echo "  ./start-tmux.sh stop         # Stop all bots"

  # Auto-attach if requested.
  if [ "${1:-}" = "attach" ]; then
    tmux attach -t "$SESSION"
  fi
}

# Handle subcommands.
case "${1:-start}" in
  stop)   cmd_stop ;;
  status) cmd_status ;;
  attach) cmd_start attach ;;
  start|*) cmd_start ;;
esac
