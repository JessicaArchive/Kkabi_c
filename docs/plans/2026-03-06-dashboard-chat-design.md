# Dashboard Chat Design

## Goal
Add a Chat page to the Kkabi dashboard that provides the same Claude Code experience as the terminal, but through a web UI. Support multiple simultaneous sessions, real-time streaming, and integration with Queue/Cron registration.

## Architecture

### Backend
- Express server adds WebSocket support via `ws` library
- Each Chat session spawns an independent `claude` CLI process
- CLI mode: `claude --output-format stream-json --verbose`
- Chat sessions are **independent from Cron/Queue** — no shared queue
- Cron/Queue keep their existing sequential queue (future: split into 2 separate queues)

### Frontend
- New "Chat" page in dashboard sidebar
- Multi-tab interface: session list on left, conversation area on right
- WebSocket connection per active session
- Real-time streaming of Claude output
- Project (working directory) selector when starting a new session

### Data Flow
```
[Browser Tab] <--WebSocket--> [Express + ws Server] <--stdin/stdout--> [Claude CLI Process]
                                      |
                              [Queue/Cron REST API]
```

## Features

### 1. Multi-session Tabs
- Multiple conversations can run simultaneously
- Each tab has its own Claude CLI process
- Session list shows active/completed sessions

### 2. Real-time Streaming
- Claude output streamed via WebSocket as it's generated
- `stream-json` format parsed and rendered in chat UI
- User messages sent through WebSocket to CLI stdin

### 3. Project Selection
- Working directory dropdown when starting new session
- Reuses `discoverProjects()` from existing branch management

### 4. Queue/Cron Registration
- UI "Add to Queue" button in chat — takes conversation context and creates a queue task
- Claude can also be asked directly to register tasks (requires CLAUDE.md instruction)

### 5. Session History
- Sessions saved to `data/chat-sessions/` as JSON
- Session list shows previous conversations
- Can resume/review previous sessions

### 6. Prompt File Selection
- Queue task creation modal gets a file picker for `data/prompts/*.md`
- Selected file content populates the prompt field

## Future (Not in Scope)
- Split Cron/Queue into 2 separate execution queues (cron-only + queue-only)
- Cron/Queue concurrent execution
