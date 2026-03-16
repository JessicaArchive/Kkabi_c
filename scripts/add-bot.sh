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
      "allowedChatIds": [8252879179]
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
  "dataDir": "$PROJECT_PATH/data",
  "interbot": {
    "enabled": true
  }
}
EOF

echo "Created config: $CONFIG_FILE"
echo ""
echo "Codex 리뷰 활성화하려면:"
echo "  1. 그룹챗 만들고 봇 + @kkabi_codex_bot 초대"
echo "  2. interbot.groupChatId, displayBotToken 추가"
echo "  끄려면: interbot.enabled → false"
echo ""
echo "Start with: ./start-tmux.sh"
