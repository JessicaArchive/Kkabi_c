#!/bin/bash
# Wrapper around the canonical worker creation script.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

exec "$SCRIPT_DIR/scripts/add-bot.sh" "$@"
