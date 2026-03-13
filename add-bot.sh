#!/bin/bash
# Add a new worker bot to Kkabi
# Usage: ./add-bot.sh <name> <telegram-token> <working-dir>
# Example: ./add-bot.sh vc 8361701454:AAE... ~/virtual-vc

set -e

NAME="$1"
TOKEN="$2"
WORKING_DIR="$3"

if [ -z "$NAME" ] || [ -z "$TOKEN" ] || [ -z "$WORKING_DIR" ]; then
  echo "Usage: ./add-bot.sh <name> <telegram-token> <working-dir>"
  echo "Example: ./add-bot.sh vc 8361701454:AAE... ~/virtual-vc"
  exit 1
fi

CONFIG_FILE="configs/${NAME}.json"

if [ -f "$CONFIG_FILE" ]; then
  echo "Error: Config already exists: $CONFIG_FILE"
  exit 1
fi

# Create config
cat > "$CONFIG_FILE" <<EOF
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "${TOKEN}",
      "allowedChatIds": []
    }
  },
  "claude": {
    "timeoutMs": 300000,
    "maxConcurrent": 1,
    "workingDir": "${WORKING_DIR}"
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
    "enabled": true
  },
  "dashboard": {
    "enabled": false
  },
  "dataDir": "data-${NAME}"
}
EOF

echo "Created config: $CONFIG_FILE"
echo "Data directory: data-${NAME}/"
echo ""
echo "To start this bot:"
echo "  npm start -- --config $CONFIG_FILE"
