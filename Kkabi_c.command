#!/bin/bash
cd "$(dirname "$0")"

# Load fnm environment
eval "$(fnm env)"

echo "Starting Kkabi_c via tmux..."
echo ""

./start-tmux.sh

echo ""
echo "Bots are running in tmux session 'kkabi'."
echo "  tmux attach -t kkabi    # View output"
echo "  ./start-tmux.sh stop    # Stop all"
