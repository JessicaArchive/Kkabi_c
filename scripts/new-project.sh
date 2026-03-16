#!/bin/bash
# 새 직원봇 프로젝트 원클릭 생성
# Usage: ./scripts/new-project.sh <name> <telegram-token>
# Example: ./scripts/new-project.sh design 8361701454:AAE...
#
# 하는 일:
#   1. ~/kkabi-<name>/ 폴더 생성 + git init
#   2. GitHub 레포 생성 (JessicaArchive/kkabi-<name>, private)
#   3. Kkabi_c에 직원봇 config 등록 (add-bot.sh)
#
# 사전 조건: gh auth login 완료

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

NAME="${1:-}"
TOKEN="${2:-}"

if [ -z "$NAME" ] || [ -z "$TOKEN" ]; then
  echo "Usage: $0 <name> <telegram-token>"
  echo "Example: $0 design 8361701454:AAE..."
  exit 1
fi

PROJECT_DIR="$HOME/kkabi-$NAME"
REPO_NAME="kkabi-$NAME"

# ── 1. 프로젝트 폴더 ──

if [ -d "$PROJECT_DIR" ]; then
  echo "❌ 폴더가 이미 존재: $PROJECT_DIR"
  exit 1
fi

echo "📁 프로젝트 폴더 생성: $PROJECT_DIR"
mkdir -p "$PROJECT_DIR"

cat > "$PROJECT_DIR/.gitignore" << 'GITIGNORE'
node_modules/
__pycache__/
.env
data/
*.db
.DS_Store
.claude/
*.log
GITIGNORE

cat > "$PROJECT_DIR/PROJECT.md" << PROJECTMD
# kkabi-$NAME

Kkabi 직원봇 프로젝트.

## Setup
- Telegram: @kkabi_${NAME}_bot
- Working dir: ~/kkabi-$NAME/
PROJECTMD

cd "$PROJECT_DIR"
git init -q
git add -A
git commit -q -m "init: kkabi-$NAME 프로젝트 생성"

echo "  ✅ git init 완료"

# ── 2. GitHub 레포 ──

echo "🌐 GitHub 레포 생성: JessicaArchive/$REPO_NAME"

if gh repo view "JessicaArchive/$REPO_NAME" &>/dev/null; then
  echo "  ⚠️ 레포가 이미 존재. push만 합니다."
else
  gh repo create "JessicaArchive/$REPO_NAME" --private --source="$PROJECT_DIR" --push -q
  echo "  ✅ 레포 생성 + push 완료"
fi

# remote 설정 (이미 있으면 무시)
git remote get-url origin &>/dev/null || git remote add origin "git@github.com:JessicaArchive/$REPO_NAME.git"
git push -u origin main 2>/dev/null || git push -u origin master 2>/dev/null || true

# ── 3. Kkabi_c에 등록 ──

echo "🤖 Kkabi_c 직원봇 등록"
bash "$SCRIPT_DIR/add-bot.sh" "$NAME" "$TOKEN" "~/kkabi-$NAME"

echo ""
echo "═══════════════════════════════════════"
echo "✅ kkabi-$NAME 프로젝트 생성 완료!"
echo ""
echo "  폴더: $PROJECT_DIR"
echo "  레포: github.com/JessicaArchive/$REPO_NAME"
echo "  봇:   @kkabi_${NAME}_bot"
echo "  config: $PROJECT_ROOT/configs/$NAME.json"
echo "═══════════════════════════════════════"
