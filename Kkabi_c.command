#!/bin/bash
cd "$(dirname "$0")"

# Load fnm environment
eval "$(fnm env)"

# Check if Kkabi_c is already running (port 3000)
if lsof -iTCP:3000 -sTCP:LISTEN -t > /dev/null 2>&1; then
    echo "[!] Kkabi_c is already running on port 3000."
    echo ""
    read -p "Kill existing process and restart? (y/N): " choice
    if [[ "$choice" != "y" && "$choice" != "Y" ]]; then
        echo "Aborted."
        exit 0
    fi
    kill $(lsof -iTCP:3000 -sTCP:LISTEN -t) 2>/dev/null
    sleep 2
fi

echo "Starting Kkabi_c... (auto-restart on crash, Ctrl+C to stop)"
echo ""

while true; do
    ./start-all.sh
    EXIT_CODE=$?
    echo ""
    echo "[!] Kkabi_c exited (code: $EXIT_CODE). Restarting in 3 seconds..."
    echo "    Press Ctrl+C to stop."
    sleep 3
done
