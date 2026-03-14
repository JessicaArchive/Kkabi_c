#!/bin/bash
# Usage: ./scripts/add-bot.sh <name> <telegram-token> <project-path>
# Example: ./scripts/add-bot.sh vc 8361701454:AAE... ~/virtual-vc

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CONFIGS_DIR="$PROJECT_ROOT/configs"

NAME="${1:-}"
TOKEN="${2:-}"
PROJECT_PATH="${3:-}"

if [ -z "$NAME" ] || [ -z "$TOKEN" ] || [ -z "$PROJECT_PATH" ]; then
  echo "Usage: $0 <name> <telegram-token> <project-path>"
  echo "Example: $0 vc 8361701454:AAE... ~/virtual-vc"
  exit 1
fi

CONFIG_FILE="$CONFIGS_DIR/$NAME.json"

if [ -f "$CONFIG_FILE" ]; then
  echo "Config already exists: $CONFIG_FILE"
  exit 1
fi

mkdir -p "$CONFIGS_DIR"

cat > "$CONFIG_FILE" << EOF
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "$TOKEN",
      "allowedChatIds": []
    }
  },
  "claude": {
    "timeoutMs": 300000,
    "maxConcurrent": 1,
    "workingDir": "$PROJECT_PATH",
    "projects": {}
  },
  "memory": {
    "enabled": true,
    "logRetentionDays": 30
  },
  "safety": {
    "enabled": true,
    "confirmTimeoutMs": 120000,
    "keywords": ["rm", "drop", "delete", "reset", "deploy", "push", "삭제", "제거", "초기화"]
  },
  "scheduler": {
    "enabled": false
  },
  "dashboard": {
    "enabled": false
  },
  "dataDir": "data-$NAME"
}
EOF

echo "Created config: $CONFIG_FILE"
echo "Role: worker bot (project execution only)"
echo "Data directory: data-$NAME/"
echo "Start with: ./start-all.sh"
