# Kkabi_c

텔레그램 기반 멀티봇 AI 에이전트 릴레이 시스템.
Claude CLI / Codex CLI를 텔레그램 봇으로 감싸서, 채팅으로 개발 작업을 지시하고 결과를 받는다.

## 멀티봇 체제

```
관리자봇 (@kkabi_bot)             ← config.json
├── 직원봇: Trading              ← configs/trading.json → ~/kkabi-trading/
├── 직원봇: VC                   ← configs/vc.json → ~/virtual-vc/
├── 직원봇: 3DSplat              ← configs/3dsplat.json → ~/kkabi-3dsplat/
├── 직원봇: Uniswap              ← configs/uniswap.json → ~/kkabi-uniswap/
└── 직원봇: Codex (코드 리뷰)    ← configs/codex.json
```

- **관리자봇**: 전체 조율, 스케줄러, 대시보드, 프로젝트 라우팅
- **직원봇**: 각자 전담 프로젝트 디렉토리에서 작업, 격리된 dataDir
- **Codex 봇**: 코드 리뷰 전용 — 멀티라운드 자동 리뷰 루프
- 봇 구성은 `configs/`에 원하는 만큼 추가 가능

## 기술 스택

| 영역 | 기술 |
|------|------|
| 런타임 | Node.js + TypeScript (tsx) |
| 텔레그램 | Telegraf v4 |
| Slack | @slack/bolt v4 |
| GitHub | Octokit v5 |
| DB | better-sqlite3 (WAL) |
| 스케줄러 | node-cron |
| 웹 대시보드 | Express v5 |
| 검증 | Zod |
| 테스트 | Vitest |

## 실행

```bash
# 전체 봇 기동 (tmux 세션으로 관리)
./start-tmux.sh

# tmux 세션에 직접 붙기
./start-tmux.sh attach

# 봇 상태 확인
./start-tmux.sh status

# 전체 종료
./start-tmux.sh stop

# macOS에서 더블클릭 실행
open Kkabi_c.command

# 개발 모드 (관리자봇만, 파일 변경 감지)
npm run dev
```

## 새 봇 추가

```bash
./scripts/add-bot.sh <이름>
# → configs/<이름>.json 생성
# → botToken, workingDir, dataDir 설정 후 start-tmux.sh 재실행
```

## 아키텍처

### 메시지 흐름

```
텔레그램 메시지 수신
  → Interbot 필터 (자기 메시지 무시)
  → 온보딩 체크 (최초 사용자 셋업)
  → !명령어 감지 → 명령 실행
  → Safety Gate (위험 키워드 → 사용자 승인)
  → 프롬프트 빌드 (페르소나 + 메모리 + 히스토리)
  → Claude 큐 진입 (workingDir별 직렬 처리)
  → Provider 실행 (Claude/Codex CLI)
  → 응답 후처리 (크론/리뷰/커밋 태그 파싱)
  → 텔레그램 응답 전송
  → DB 저장
```

### 핵심 디자인 패턴

| 패턴 | 설명 |
|------|------|
| **Provider** | AI 백엔드 추상화 — Claude, Codex 교체 가능 |
| **Channel Adapter** | 메시징 플랫폼 추상화 — Telegram, Slack, GitHub |
| **Per-Dir Queue** | workingDir별 서브큐로 git 경합 방지 |
| **Tag-Based Actions** | 응답 내 HTML 주석 태그로 크론 등록, 코드 리뷰, 커밋 제안 |
| **Safety Gate** | 위험 키워드 감지 → 사용자 승인 후 실행 |
| **Interbot Protocol** | 그룹챗 기반 봇 간 구조화된 통신 (코드 리뷰 루프) |

### 코드 리뷰 (Interbot)

```
Claude가 코드 작성
  → REVIEW_REQUEST 태그 → Codex에 리뷰 요청
  → Codex 리뷰 → [LGTM]이면 완료
  → 아니면 Claude에 피드백 → 수정 → 재리뷰
  → 최대 3라운드
```

### 커밋 파이프라인

```
Claude 응답에 COMMIT_SUGGEST 태그 포함
  → commitParser가 파싱
  → 사용자에게 [승인] [거부] 버튼 전송
  → 승인 시: git add → commit → push → PR 생성
  → PR 머지 승인 → squash merge to main
```

## 디렉토리 구조

```
src/
├── index.ts                 # 엔트리포인트
├── config.ts                # Zod 설정 로더
├── types.ts                 # 타입 정의
├── paths.ts                 # dataDir 기반 경로 헬퍼
├── channels/                # 채널 어댑터 (Telegram, Slack, GitHub)
├── core/                    # 메시지 파이프라인, 명령어, 크론/리뷰/커밋 파서
├── providers/               # AI 백엔드 (Claude, Codex)
├── claude/                  # 큐 시스템, 프롬프트 빌더
├── scheduler/               # 크론 잡 CRUD & 실행
├── memory/                  # 영속 메모리 & 페르소나
├── safety/                  # 위험 키워드 감지
├── interbot/                # 멀티봇 프로토콜 & 통신
├── agents/                  # 에이전트(페르소나) 관리
├── db/                      # SQLite (대화/실행 기록)
├── dashboard/               # Express 웹 대시보드
└── project-commands/        # 프로젝트별 확장 명령어
```

## 설정

| 파일 | 역할 |
|------|------|
| `config.json` | 관리자봇 설정 |
| `configs/*.json` | 직원봇 설정 (자유롭게 추가) |
| `config.example.json` | 설정 템플릿 |

핵심 필드:
- `channels.telegram.botToken` — 텔레그램 봇 토큰
- `provider` — AI 백엔드 (`"claude"` 또는 `"codex"`)
- `claude.workingDir` / `runner.workingDir` — 작업 디렉토리
- `dataDir` — 봇 전용 데이터 경로 (DB, 메모리, 크론)
- `interbot.enabled` — 봇 간 통신 활성화

## 주요 명령어

| 명령어 | 설명 |
|--------|------|
| `!help` | 전체 명령어 목록 |
| `!cd <경로>` | 작업 디렉토리 변경 |
| `!status` | 큐/실행/메모리 상태 |
| `!memory` | 영속 메모리 조회/추가/삭제 |
| `!cron` | 크론 잡 관리 |
| `!agent` | 에이전트 설정 관리 |
| `!persona` | 봇 성격/사용자/모드 수정 |
| `!cancel` | 현재 실행 취소 |

## 확장

| 확장 | 방법 |
|------|------|
| 새 채널 | `channels/`에 Channel 인터페이스 구현 |
| 새 AI 백엔드 | `providers/`에 Provider 인터페이스 구현 |
| 새 프로젝트 명령어 | `project-commands/`에 ProjectCommands 구현 |
| 새 직원봇 | `./scripts/add-bot.sh <이름>` |

## 라이선스

Private
