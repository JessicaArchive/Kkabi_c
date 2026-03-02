# Kkabi_c — Project Documentation

## Overview

Kkabi_c is a multi-channel AI assistant that bridges messaging platforms (Slack, GitHub Issues) with Claude Code CLI. Users send messages through their preferred channel, and Kkabi processes them via `claude -p`, returning AI-generated responses.

## Architecture

```
┌─────────┐   ┌──────────┐   ┌─────────┐   ┌───────────┐
│  Slack   │──>│          │──>│  Queue   │──>│  claude   │
│ (Socket) │   │ Handler  │   │ (FIFO)   │   │  CLI -p   │
└─────────┘   │          │   └─────────┘   └───────────┘
┌─────────┐   │ Onboard  │        │
│  GitHub  │──>│ Command  │        v
│ (Poll)   │   │ Safety   │   ┌─────────┐
└─────────┘   └──────────┘   │ SQLite  │
                              │ Memory  │
                              │ Persona │
                              └─────────┘
```

### Directory Structure

```
src/
├── index.ts              # Entry point — boots channels, DB, cron
├── config.ts             # Zod schema for config.json validation
├── types.ts              # Shared TypeScript types (Agent, CronJob, etc.)
├── channels/
│   ├── base.ts           # Channel interface (sendText, sendConfirm, etc.)
│   ├── slack.ts          # Slack via @slack/bolt (Socket Mode)
│   └── github.ts         # GitHub Issues via octokit (polling)
├── core/
│   ├── handler.ts        # Main message handler (onboard → cmd → safety → claude)
│   ├── commands.ts       # ! commands (!help, !cd, !persona, !cron, !agent, etc.)
│   └── onboarding.ts     # First-time user setup (bilingual KO/EN)
├── claude/
│   ├── runner.ts         # Spawns `claude -p` subprocess (supports --model override)
│   ├── context.ts        # Builds prompt (persona + memory + history + message)
│   └── queue.ts          # FIFO queue for sequential processing
├── agents/
│   └── store.ts          # Agent CRUD, Zod validation, cached reads
├── memory/
│   ├── persona.ts        # SOUL.md, USER.md, MOOD.md, LANG.txt management
│   └── manager.ts        # MEMORY.md and daily logs (data/memory/logs/)
├── safety/
│   └── gate.ts           # Keyword scanning + approval flow
├── scheduler/
│   └── cron.ts           # Cron scheduling, state tracking, agent integration, JSONL run logs
└── db/
    └── store.ts          # SQLite (better-sqlite3) — conversations & executions
```

### Data Directory (`data/` — gitignored, user-owned)

```
data/
├── kkabi.db              # SQLite database
├── persona/
│   ├── SOUL.md           # Bot personality
│   ├── USER.md           # User info
│   ├── MOOD.md           # Default mode
│   └── LANG.txt          # Language preference (ko | en)
├── memory/
│   ├── MEMORY.md         # Persistent notes
│   └── logs/
│       └── YYYY-MM-DD.md # Daily activity logs (auto-cleaned after 30 days)
├── crons.json            # Scheduled jobs + per-job state (runtime-mutable)
├── cron-runs/            # JSONL run logs per cron job
├── agents.json           # Agent definitions (reusable persona/model/dir configs)
└── uploads/              # File uploads (if any)
```

Program code (`src/`) and user data (`data/`, `config.json`) are fully separated.
Cron jobs live in `data/crons.json` and agent definitions in `data/agents.json` — both gitignored.
Program updates never touch user workflows.

---

## How to Run

### Prerequisites

- Node.js 22+
- `claude` CLI installed and authenticated (Anthropic Claude Code)
- Slack Bot Token + App Token (for Slack channel)
- GitHub Personal Access Token (for GitHub Issues channel)

### Setup

```bash
# Install dependencies
npm install

# Create config.json (see Configuration section below)
cp config.example.json config.json  # or create manually

# Run in development mode (watch)
npm run dev

# Run in production
npm start

# Type check only
npm run typecheck

# Build to dist/
npm run build
```

### Startup Sequence

1. Load and validate `config.json` (Zod)
2. Initialize SQLite database (`data/kkabi.db`)
3. Clean old daily logs (> 30 days)
4. Start enabled channels (Slack and/or GitHub)
5. Register cron job send callback
6. Start scheduled cron jobs
7. Listen for messages

---

## Configuration

`config.json` (gitignored — contains secrets):

```jsonc
{
  "channels": {
    "slack": {
      "enabled": false,           // Enable Slack channel
      "botToken": "xoxb-...",     // Slack Bot Token
      "appToken": "xapp-...",     // Slack App Token (Socket Mode)
      "allowedChannels": []       // Empty = allow all DMs
    },
    "github": {
      "enabled": true,            // Enable GitHub Issues channel
      "token": "github_pat_...",  // GitHub PAT with issues read/write
      "repositories": ["owner/repo"],
      "pollIntervalMs": 15000,    // Polling interval (ms)
      "label": ""                 // Optional: only poll issues with this label
    }
  },
  "claude": {
    "timeoutMs": 300000,          // Claude CLI timeout (5 min)
    "maxConcurrent": 1,           // Max concurrent executions
    "workingDir": "~"             // Working directory for claude
  },
  "memory": {
    "enabled": true,
    "logRetentionDays": 30
  },
  "safety": {
    "enabled": true,
    "confirmTimeoutMs": 120000,   // Approval timeout (2 min)
    "keywords": ["rm", "drop", "delete", "reset", "deploy", "push", "삭제", "제거", "초기화"]
  },
  "scheduler": {
    "enabled": true
  }
}
```

---

## Channels

### Slack

- **Transport**: Real-time via Socket Mode (`@slack/bolt`)
- **chatId**: Slack channel ID
- **Features**: Text chunking (4000 chars), file uploads, interactive approve/deny buttons
- **Confirmation**: Button-based (`confirm_approve` / `confirm_deny`)

### GitHub Issues

- **Transport**: Polling-based via `octokit`
- **chatId**: `"owner/repo#123"` (each issue is a conversation)
- **Features**: Deduplication via `processedIds` set, own-comment tracking, optional label filter
- **Confirmation**: Reaction polling (👍 = approve, 👎 = deny, 120s timeout)
- **Message truncation**: 65536 chars per comment (GitHub API limit)

---

## Message Flow

```
User message arrives
    │
    ├─ First time? ──> Start onboarding (lang → soul → user → mood)
    │
    ├─ In onboarding? ──> Handle onboarding step
    │
    ├─ Starts with "!"? ──> Execute command, return result
    │
    ├─ Safety keywords? ──> Request approval (approve/deny)
    │                        Denied? → "Request denied."
    │
    └─ Build prompt (persona + memory + history + message)
       → Enqueue → Claude CLI → Edit "Processing..." with response
       → Save to DB (conversations + executions)
       → Append to daily log
```

---

## Commands

| Command | Description |
|---------|-------------|
| `!cd <path>` | Change claude working directory |
| `!pwd` | Show current working directory |
| `!status` | Show running/queue status |
| `!history [N]` | Show last N messages (default: 10) |
| `!memory [text]` | View or append to persistent memory |
| `!forget` | Clear all memory |
| `!persona [section] [text]` | View or edit soul/user/mood |
| `!cancel` | Cancel currently running claude task |
| `!running` | Show running task and queue |
| `!cron` | List all cron jobs |
| `!cron add "schedule" "prompt"` | Add a cron job |
| `!cron remove <id>` | Remove a cron job |
| `!cron toggle <id>` | Enable/disable a cron job |
| `!cron run <id>` | Force run a cron job now |
| `!cron status [id]` | Show cron job state details |
| `!cron reload` | Reload crons from file |
| `!agent` | List all agents |
| `!agent show <id>` | Show agent details |
| `!agent reload` | Reload agents from file |
| `!system` | Show system info + recent executions |
| `!help` | Show command help |

---

## Onboarding

When a user sends their first message, Kkabi initiates a setup flow:

1. **Language selection** — Korean or English (bilingual prompt)
2. **Soul** — Bot personality/tone (e.g., "casual and friendly")
3. **User** — User background info (e.g., "Backend dev, uses TypeScript")
4. **Mood** — Default working mode (e.g., "focus on code reviews")

Each step can be skipped with `!skip`. Settings are saved to `data/persona/` files.

---

## Safety Gate

- Scans every non-command message for dangerous keywords
- Korean keywords (`삭제`, `제거`, `초기화`) are included
- On match: sends an approval prompt to the channel
- Slack: interactive buttons | GitHub: reaction polling (👍/👎)
- Timeout (120s default) defaults to deny

---

## Prompt Context

Each message sent to Claude includes:

```
[SOUL]       → Bot personality from SOUL.md
[USER INFO]  → User background from USER.md
[MOOD]       → Working mode from MOOD.md
[MEMORY]     → Persistent notes from MEMORY.md
[CONVERSATION HISTORY] → Last 20 messages from SQLite
[CURRENT MESSAGE]      → The actual user message
```

---

## Database

SQLite with WAL mode. Two tables:

- **conversations**: `role`, `content`, `channel`, `chat_id`, `timestamp` (indexed by `chat_id + timestamp`)
- **executions**: `prompt`, `output`, `status`, `channel`, `chat_id`, `timestamp`, `duration_ms`

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `@slack/bolt` | Slack Socket Mode API |
| `octokit` | GitHub REST API |
| `better-sqlite3` | Local SQLite database |
| `node-cron` | Cron job scheduling |
| `zod` | Config schema validation |
| `chalk` | Console colors |
| `tsx` | Run TypeScript directly (dev) |

---

## Pending Work (Uncommitted Changes)

1. **GitHub channel improvements** (`src/channels/github.ts`)
   - Deduplication with `processedIds` and `ownCommentIds` sets
   - 2-second buffer on polling `since` timestamp to avoid missing issues
   - Error handling per repo in poll loop
   - Debug logging

2. **Bilingual onboarding** (`src/core/onboarding.ts`)
   - Language selection (Korean/English) as first step
   - All onboarding messages translated to both languages

3. **Language persistence** (`src/memory/persona.ts`)
   - `getLang()` / `setLang()` functions
   - Saved to `data/persona/LANG.txt`

### Known TODOs

- `src/channels/github.ts:93` — Restore bot self-skip when using a dedicated bot account
- `src/types.ts:1` — `gchat` channel type defined but not implemented

---

## Agents

Agents are reusable persona/model/directory configurations that can be referenced by cron jobs. Definitions live in `data/agents.json` (runtime-mutable).

### Configuration

Create `data/agents.json`:

```json
{
  "version": 1,
  "agents": [
    {
      "id": "planner",
      "name": "Planner Agent",
      "model": "claude-opus-4-20250514",
      "persona": "You are a technical planner...",
      "workingDir": "~/work_test",
      "timeoutMs": 600000
    },
    {
      "id": "developer",
      "name": "Developer Agent",
      "model": "claude-sonnet-4-20250514",
      "workingDir": "~/work_test"
    }
  ]
}
```

### Usage

| Command | Description |
|---------|-------------|
| `!agent` | List all agents |
| `!agent show <id>` | Show agent details (model, dir, persona) |
| `!agent reload` | Re-read `data/agents.json` |

---

## Cron Jobs

Cron jobs are scheduled tasks that run Claude on a schedule. Definitions live in `data/crons.json` (runtime-mutable). Each job tracks execution state and writes JSONL run logs to `data/cron-runs/`.

### Architecture

```
Program code (src/)              User data (data/)
┌───────────────────────┐       ┌──────────────────────────────┐
│ scheduler/cron.ts     │       │ data/crons.json              │
│   - addCron()         │◄──────│   { version: 1, jobs: [...] }│
│   - executeCronJob()  │       │                              │
│   - updateJobState()  │       │ data/cron-runs/              │
│   - appendRunLog()    │       │   <job-id>.jsonl             │
│   - reloadCrons()     │       │                              │
│                       │       │ data/agents.json             │
│ agents/store.ts       │◄──────│   { version: 1, agents: [] } │
│   - getAgent()        │       └──────────────────────────────┘
└───────────────────────┘
```

### CronJob fields

| Field | Description |
|-------|-------------|
| `schedule` | Cron expression (e.g. `"0 9 * * *"`) |
| `prompt` | Inline prompt text |
| `promptPath` | Optional: load prompt from file instead |
| `agentId` | Optional: reference an agent for persona/model/dir |
| `model` | Optional: override model (takes priority over agent) |
| `workingDir` | Optional: override working dir |
| `timeoutMs` | Optional: override timeout |
| `state` | Auto-managed: `lastRunAtMs`, `lastStatus`, `lastDurationMs`, `consecutiveErrors`, `lastError` |

Resolution priority: CronJob field > Agent field > config default.

### Run Logs

Each execution is logged as a JSONL line in `data/cron-runs/<job-id>.jsonl`:

```json
{"ts":1709280000000,"jobId":"abc-123","status":"ok","durationMs":45000,"model":"claude-opus-4-20250514","outputSnippet":"..."}
```

---

## Graceful Shutdown

On `SIGINT` or `SIGTERM`:
1. Cancel running claude subprocess
2. Stop all cron jobs
3. Stop all channels
4. Close SQLite database
