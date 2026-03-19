# Commit & Merge Pipeline via Telegram

## Overview

봇이 작업 단위를 완료하면 텔레그램으로 커밋을 제안하고, 2단계 승인(커밋+PR → 머지)을 거쳐 main에 반영하는 파이프라인.

## Flow

```
[작업 단위 완료]
Claude 응답에 <!--COMMIT_SUGGEST:{"message":"..."}-->  태그 포함

→ commitParser: 태그 파싱 + 제거
→ commitExecutor: 텔레그램에 커밋 제안 버튼 전송
  "커밋할까? feat: 실시간 크래시 감시"
  [✅ 커밋+PR] [❌ 나중에]

[✅ 승인]
→ git add -A → git commit → git push → gh pr create
→ 텔레그램에 머지 버튼 전송
  "PR #12 생성됨"
  [🔀 머지] [❌ 나중에]

[🔀 승인]
→ gh pr merge --squash #12
→ "✅ PR #12 머지 완료"
```

## Design Decisions

- **태그 기반**: 기존 CRON_JOB, REVIEW_REQUEST 패턴과 동일한 방식
- **2단계 승인**: 커밋+PR 생성 → 머지, 각 단계에서 사용자 확인
- **Squash merge**: main 히스토리 깔끔하게 유지
- **각 봇이 자기 PR 관리**: 중앙 집중 아닌 분산 방식
- **작업 단위 기준 제안**: 기능 완성 / 버그 수정 완료 시

## New Files

| File | Role |
|------|------|
| `src/core/commitParser.ts` | `<!--COMMIT_SUGGEST-->` 태그 파싱 |
| `src/core/commitExecutor.ts` | git commit → push → PR → 머지 버튼 |

## Modified Files

| File | Change |
|------|--------|
| `src/core/handler.ts` | 응답 후처리에 commitParser 추가 |
| `src/claude/context.ts` | 시스템 프롬프트에 COMMIT_SUGGEST 태그 + 행동 규칙 |
| `src/channels/telegram.ts` | 머지 승인 콜백 처리 |

## System Prompt Addition

```
## Commit Workflow
- 기능 하나 완성하거나 버그 하나 고치면 커밋을 제안해.
- 커밋 제안 시 응답에 아래 태그를 포함해:
  <!--COMMIT_SUGGEST:{"message":"커밋 메시지"}-->
- 직접 git commit/push/merge 하지 마. 태그만 포함하면 시스템이 처리해.
```

## Callback Data

```typescript
// 커밋 승인 대기
{ type: "commit", message: string, chatId: string }

// 머지 승인 대기
{ type: "merge", prNumber: number, repo: string, chatId: string }
```

## Scope

- 모든 봇 (관리자 + 직원봇)
- GitHub branch protection 유지 (main 직접 push 금지)
- `gh` CLI 인증 활용 (이미 설정됨)
