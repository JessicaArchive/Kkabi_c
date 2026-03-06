# Kkabi_c Dashboard Design

## Overview

A web dashboard served from the bot process itself. Provides a GUI for managing cron jobs, viewing execution history, and reading detailed stdout logs — replacing the current CLI-only workflow.

Access via `localhost:3000/dashboard` when the bot is running.

## Architecture

```
Bot Process (index.ts)
├── GitHub Channel (existing)
├── Cron Scheduler (existing)
└── Express Server (new)
    ├── REST API (/api/*)
    └── Static Files (/dashboard)
```

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/crons | List all cron jobs |
| PUT | /api/crons/:id | Update schedule, enabled, etc. |
| POST | /api/crons | Add new cron job |
| DELETE | /api/crons/:id | Remove cron job |
| POST | /api/crons/:id/run | Trigger manual execution |
| GET | /api/runs | List all execution records |
| GET | /api/runs/:id | Execution detail + stdout log |

### Technology

- Backend: Express (added to existing bot process)
- Frontend: Pure HTML/JS/CSS (no framework, no build step)
- Data: Existing `data/crons.json` and `data/cron-runs/*.jsonl`
- Polling: Frontend polls API every 3 seconds for status updates

## Data Flow

### Cron Jobs

- Source: `data/crons.json` (existing, read/write directly)
- API modifies file, then calls `reloadCrons()` to apply changes

### Execution History (Runs)

- Source: `data/cron-runs/*.jsonl` (existing)
- Each JSONL line = one execution record
- Fields: `ts`, `jobId`, `status`, `durationMs`, `error`, `outputSnippet`

### Stdout Logs (New)

- Runner saves full stdout per execution to `data/cron-runs/logs/<jobId>-<timestamp>.log`
- API serves log file content on demand
- For running tasks, log file grows and frontend polls for updates

## Frontend

### Layout

- Left sidebar: navigation menu (Cron Jobs / Runs)
- Right main area: selected page content

### Cron Jobs Page

- Table: name, schedule, status (ON/OFF), last run result
- Row actions: Run, Edit, Toggle, Delete
- Top: Add button → inline form (name, schedule, prompt, workingDir)

### Runs Page

- Table: cron job name, start time, duration, status
- Status badges: Running (blue), Completed (green), Failed (red)
- Click row → log detail page

### Log Detail Page

- Top: meta info (cron job name, start time, duration, status)
- Bottom: full stdout in monospace font
- Running tasks: polls every 3 seconds for log updates

### Style

- Dark theme, terminal aesthetic
- Pure CSS, no framework

## Code Changes

### New Files

- `src/dashboard/server.ts` — Express server + API routes
- `src/dashboard/static/index.html` — Dashboard SPA
- `src/dashboard/static/style.css` — Styles
- `src/dashboard/static/app.js` — Frontend logic

### Modified Files

- `src/index.ts` — Start Express server on boot
- `src/claude/runner.ts` — Save stdout to log file per execution
- `src/scheduler/cron.ts` — Expose current execution state for API

### Dependencies

- `express` + `@types/express`
