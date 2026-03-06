# Workflow Engine — Decision Log

## Summary

Kkabi_c에 범용 서브 에이전트 프레임워크(Workflow Engine)를 추가하는 설계 과정의 Q&A 및 결정사항 정리.

## Context

OpenClaw에서는 크론잡에 긴 프롬프트를 넣어 "기획자 모드 → 개발자 모드" 파이프라인을 구현했음. Kkabi_c에서는 이를 구조화된 서브 에이전트 시스템으로 만들고자 함.

---

## Decision Map

```
┌─────────────────────────────────────────────────────┐
│                  Workflow Engine                      │
├─────────────────┬───────────────────────────────────┤
│ 핵심 목표       │ 범용 서브 에이전트 프레임워크      │
│ 트리거          │ 명령어 (!workflow) + 크론잡         │
│ 실행 패턴       │ 순차 + 병렬 모두 지원              │
│ 데이터 전달     │ 파일 + 컨텍스트 하이브리드         │
│ 워크플로우 정의 │ JSON 파일 (workflows.json)         │
│ 아키텍처        │ Workflow Engine (접근 방식 1)       │
└─────────────────┴───────────────────────────────────┘
```

---

## Q&A Details

### Q1. 핵심 목표

| 질문 | 서브 에이전트의 핵심 용도가 뭔가요? |
|------|--------------------------------------|
| 선택지 | (1) 범용 프레임워크 (2) work_dev 먼저 (3) 둘 다 동시에 |
| **결정** | **범용 서브 에이전트 프레임워크** |
| 근거 | 사용자 선택 |

### Q2. 트리거 방식

| 질문 | 서브 에이전트를 어떻게 실행할 수 있어야 하나요? |
|------|--------------------------------------------------|
| 선택지 | (1) 크론잡에서만 (2) 명령어+크론잡 (3) 명령어+크론잡+이벤트 |
| **결정** | **명령어 + 크론잡 모두** |
| 근거 | 기존 시스템과 자연스러운 통합, 이벤트는 추후 확장 |

### Q3. 실행 패턴

| 질문 | 순차/병렬 실행 방식을 어떻게 할까요? |
|------|---------------------------------------|
| 선택지 | (1) 순차만 (2) 순차+병렬 (3) DAG 기반 |
| **결정** | **순차 + 병렬 모두** |
| 근거 | 순차가 기본값(현재 queue 호환), 병렬은 옵션, DAG는 과도 |

### Q4. 데이터 전달

| 질문 | 서브 에이전트 간 데이터를 어떻게 전달할까요? |
|------|-----------------------------------------------|
| 선택지 | (1) 파일 기반 (2) 컨텍스트 주입 (3) 하이브리드 |
| **결정** | **파일 + 컨텍스트 하이브리드** |
| 근거 | 짧은 결과는 프롬프트 주입, 큰 데이터는 파일 공유 |

### Q5. 워크플로우 정의 방식

| 질문 | 워크플로우를 어떻게 정의할까요? |
|------|----------------------------------|
| 선택지 | (1) JSON 파일 (2) TypeScript 코드 (3) 명령어 |
| **결정** | **JSON 파일 + 명령어로 생성** |
| 근거 | 기존 패턴(crons.json, agents.json)과 일관성 |

### Q6. 아키텍처 접근 방식

| 질문 | 3가지 접근 방식 중 어떤 것으로? |
|------|----------------------------------|
| 선택지 | (1) Workflow Engine (2) Agent Chaining (3) Pipeline as Prompt |
| **결정** | **Workflow Engine (접근 방식 1)** |
| 근거 | 범용 프레임워크 목표에 부합, 기존 시스템 위에 레이어 추가 |

---

## Architecture Chosen: Workflow Engine

```
Trigger (command/cron)
       │
       ▼
Workflow Engine ──→ reads workflows.json
       │              resolves step dependencies
       ▼
Step Executor ────→ serial or parallel
       │              injects prev output into prompt
       ▼
Claude Queue ─────→ existing system (runner.ts)
       │
       ▼
Channel Report ───→ results to Slack/GitHub
```

### New Files
- `src/workflow/store.ts` — CRUD (same pattern as agents/store.ts)
- `src/workflow/engine.ts` — Execution engine

### New Commands
- `!workflow` — list, show, run, add, remove, toggle, status, reload

### Integration Points
- CronJob gets optional `workflowId` field
- `context.ts` lists available workflows in capabilities section
- New hidden tag: `<!--WORKFLOW_RUN:{"id":"..."}-->`

---

## Out of Scope (for now)
- Conditional branching (if/else) in workflow definition
- Loop/retry logic
- Cross-workflow dependencies
- Approval gates between steps
- Event-driven triggers
