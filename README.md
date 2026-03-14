# Kkabi_c

텔레그램 기반 AI 에이전트 릴레이 시스템. Claude CLI를 텔레그램 봇으로 감싸서, 채팅으로 개발 작업을 지시하고 결과를 받는 구조.

## 멀티봇 체제

```
관리자봇                     ← config.json
  ├── 직원봇 A               ← configs/worker-a.json → ~/project-a/
  └── 직원봇 B               ← configs/worker-b.json → ~/project-b/
```

- **관리자봇**: 전체 조율, 프로젝트 현황, 스케줄러/대시보드 관리
- **직원봇**: 각자 전담 프로젝트 디렉토리에서만 작업, dataDir 격리
- 봇 구성은 사용자마다 다름 — `configs/`에 원하는 만큼 직원봇 추가 가능

## 디렉토리 구조

```
Kkabi_c/
├── src/
│   ├── index.ts              # 엔트리포인트, 봇 초기화
│   ├── config.ts             # 설정 로더 (Zod 스키마)
│   ├── types.ts              # 타입 정의
│   ├── paths.ts              # 경로 헬퍼 (dataDir 기반)
│   ├── channels/
│   │   ├── base.ts           # 채널 인터페이스
│   │   ├── telegram.ts       # 텔레그램 커넥터 (Telegraf)
│   │   ├── slack.ts          # Slack 커넥터
│   │   └── github.ts         # GitHub 이슈/PR 커넥터
│   ├── core/
│   │   ├── handler.ts        # 메시지 파이프라인
│   │   ├── commands.ts       # !명령어 디스패처
│   │   ├── onboarding.ts     # 최초 사용자 셋업
│   │   ├── cronParser.ts     # 크론 태그 파싱
│   │   └── cronExecutor.ts   # 크론 액션 실행
│   ├── claude/
│   │   ├── runner.ts         # Claude CLI 프로세스 관리
│   │   ├── queue.ts          # 요청 직렬화 큐
│   │   └── context.ts        # 프롬프트 빌더
│   ├── scheduler/
│   │   ├── cron.ts           # 크론 잡 CRUD
│   │   └── taskQueue.ts      # 수동 실행 큐
│   ├── memory/
│   │   ├── manager.ts        # 대화 로그, 일일 요약
│   │   └── persona.ts        # 페르소나/성격
│   ├── safety/
│   │   └── gate.ts           # 위험 키워드 감지 → 승인 요청
│   ├── agents/
│   │   └── store.ts          # 에이전트 설정 관리
│   ├── dashboard/
│   │   ├── server.ts         # Express 웹 대시보드 (:3000)
│   │   └── chat.ts           # 채팅 히스토리 UI
│   └── db/
│       └── store.ts          # SQLite (대화/실행 기록)
├── configs/                   # 직원봇 설정 파일들
├── data/                      # 관리자봇 데이터 (DB, 메모리, 크론)
├── scripts/                   # 유틸리티 스크립트
├── templates/                 # 프로젝트 템플릿
├── docs/                      # 운영 모델 문서
├── logs/                      # 로그 (git 제외)
├── start-all.sh               # 전체 봇 기동
├── add-bot.sh                 # 새 직원봇 생성
└── Kkabi_c.command            # macOS 더블클릭 런처
```

## 실행

```bash
# 전체 봇 기동 (관리자 + 직원봇 전부)
./start-all.sh

# macOS에서 더블클릭 실행 (크래시 시 자동 재시작)
open Kkabi_c.command

# 개발 모드 (관리자봇만, 파일 변경 감지)
npm run dev

# 전체 종료
./scripts/stop-all.sh
```

## 새 봇 추가

```bash
./add-bot.sh <이름>
# → configs/<이름>.json 생성
# → botToken, workingDir, dataDir 설정 후 start-all.sh 재실행
```

## 설정 구조

| 파일 | 역할 |
|------|------|
| `config.json` | 관리자봇 설정 (채널, Claude, 안전, 스케줄러) |
| `configs/*.json` | 직원봇 설정 (사용자가 자유롭게 추가) |
| `config.example.json` | 설정 템플릿 |

각 봇 설정의 핵심 필드:
- `channels.telegram.botToken` — 텔레그램 봇 토큰
- `claude.workingDir` — Claude가 작업할 디렉토리
- `dataDir` — 봇 전용 데이터 저장 경로 (DB, 메모리, 크론)

## 메시지 흐름

```
텔레그램 메시지 수신
  → 온보딩 체크
  → !명령어 감지 → 명령 실행
  → 안전 게이트 (위험 키워드 → 사용자 승인)
  → 컨텍스트 빌드 (히스토리 + 페르소나 + 메모리)
  → Claude 큐 진입 (직렬 처리)
  → Claude CLI 실행 → 응답 스트리밍
  → 크론 태그 파싱 → 스케줄 등록
  → 텔레그램 응답 전송
  → DB 저장 + 메모리 로그
```

## 주요 명령어

| 명령어 | 설명 |
|--------|------|
| `!help` | 전체 명령어 목록 |
| `!cd <경로>` | 작업 디렉토리 변경 |
| `!status` | 큐/실행/메모리 상태 |
| `!memory` | 영속 메모리 조회/추가/삭제 |
| `!cron` | 크론 잡 관리 |
| `!agent` | 에이전트 설정 관리 |
| `!cancel` | 현재 Claude 실행 취소 |

## 기술 스택

- **런타임**: Node.js + TypeScript (tsx)
- **텔레그램**: Telegraf v4
- **Slack**: @slack/bolt v4
- **GitHub**: Octokit v5
- **DB**: better-sqlite3
- **스케줄러**: node-cron
- **웹**: Express v5
- **유효성 검증**: Zod
- **테스트**: Vitest
