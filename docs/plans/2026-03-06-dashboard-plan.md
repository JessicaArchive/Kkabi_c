# Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a web dashboard to the Kkabi_c bot for managing cron jobs and viewing execution history via browser.

**Architecture:** Express server embedded in the bot process, serving REST API endpoints and static HTML/JS/CSS files. Frontend uses pure HTML/JS with 3-second polling for status updates.

**Tech Stack:** Express, pure HTML/JS/CSS (no framework, no build step)

---

### Task 1: Install express dependency

**Step 1: Install packages**

Run: `npm install express && npm install -D @types/express`

**Step 2: Verify installation**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add express dependency for dashboard"
```

---

### Task 2: Add stdout log file saving to runner

**Files:**
- Modify: `src/claude/runner.ts`
- Modify: `src/claude/queue.ts`

Runner currently outputs stdout to console only. We need to also save it to a log file per execution so the dashboard can serve it.

**Step 1: Modify runner to accept and write to a log file**

In `src/claude/runner.ts`, add `logFile` to `RunClaudeOptions`:

```typescript
export interface RunClaudeOptions {
  prompt: string;
  promptId: string;
  workingDir?: string;
  model?: string;
  timeoutMs?: number;
  logFile?: string;  // NEW
}
```

In `runClaudeOnce`, after `const tag = ...`, add log file setup:

```typescript
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Inside runClaudeOnce, after tag definition:
let logStream: import("node:fs").WriteStream | null = null;
if (logFile) {
  mkdirSync(dirname(logFile), { recursive: true });
  logStream = createWriteStream(logFile, { flags: "a" });
}
```

Wherever `process.stdout.write(...)` is called, also write to logStream:

```typescript
// Helper at top of function:
const logWrite = (text: string) => {
  process.stdout.write(text);
  logStream?.write(text);
};
```

Replace all `process.stdout.write(...)` calls in the stdout handler with `logWrite(...)`.
Also write stderr to the log file.

On `proc.on("close", ...)` and `proc.on("error", ...)`, close the logStream:

```typescript
logStream?.end();
```

**Step 2: Modify queue to pass logFile**

In `src/claude/queue.ts`, add `logFile` to `EnqueueOptions` and `QueueItem`, pass it through to `runClaude`.

In `src/types.ts`, add `logFile?: string` to `QueueItem`.

**Step 3: Generate logFile path in cron.ts**

In `src/scheduler/cron.ts`, in `executeCronJob`, generate a log file path and pass it:

```typescript
const logFile = resolve(RUNS_DIR, "logs", `${job.id}-${startMs}.log`);

const { promise } = enqueue({
  prompt: promptText,
  chatId: job.chatId,
  channel: job.channelType,
  model,
  workingDir,
  timeoutMs,
  logFile,
});
```

Also save the logFile name in the JSONL entry so the API can find it:

```typescript
// In appendRunLog, add logFile to CronRunLogEntry:
interface CronRunLogEntry {
  ts: number;
  jobId: string;
  status: "ok" | "error";
  durationMs: number;
  model?: string;
  error?: string;
  outputSnippet?: string;
  logFile?: string;  // NEW
}
```

**Step 4: Verify**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add src/claude/runner.ts src/claude/queue.ts src/scheduler/cron.ts src/types.ts
git commit -m "feat: save stdout to log file per execution"
```

---

### Task 3: Expose current execution state from cron scheduler

**Files:**
- Modify: `src/scheduler/cron.ts`

The dashboard needs to know which job is currently running. Add a tracking map.

**Step 1: Add running job tracker**

```typescript
// At module level:
const runningJobs = new Map<string, { startMs: number; logFile: string }>();

export function getRunningJobs(): Map<string, { startMs: number; logFile: string }> {
  return runningJobs;
}
```

In `executeCronJob`, set/delete from the map:

```typescript
// Before enqueue:
runningJobs.set(job.id, { startMs, logFile });

// After promise resolves (in both try and catch):
runningJobs.delete(job.id);
```

**Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/scheduler/cron.ts
git commit -m "feat: track currently running cron jobs"
```

---

### Task 4: Create Express server with API routes

**Files:**
- Create: `src/dashboard/server.ts`

**Step 1: Create the server file**

```typescript
import express from "express";
import { resolve } from "node:path";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import {
  listCrons, getCron, addCron, removeCron, toggleCron,
  runCronNow, reloadCrons, getRunningJobs,
} from "../scheduler/cron.js";

const RUNS_DIR = resolve(process.cwd(), "data", "cron-runs");

export function createDashboardServer(port = 3000): express.Express {
  const app = express();
  app.use(express.json());

  // Static files
  app.use("/dashboard", express.static(resolve(import.meta.dirname, "static")));

  // --- Cron CRUD ---
  app.get("/api/crons", (_req, res) => {
    const jobs = listCrons();
    const running = getRunningJobs();
    const result = jobs.map((j) => ({
      ...j,
      running: running.has(j.id),
      runningStartMs: running.get(j.id)?.startMs,
    }));
    res.json(result);
  });

  app.put("/api/crons/:id", (req, res) => {
    const job = getCron(req.params.id);
    if (!job) return res.status(404).json({ error: "Not found" });

    // Toggle enabled
    if (req.body.enabled !== undefined) {
      const toggled = toggleCron(job.id);
      return res.json(toggled);
    }

    res.json(job);
  });

  app.post("/api/crons", (req, res) => {
    try {
      const { schedule, prompt, channelType, chatId, agentId } = req.body;
      const job = addCron(schedule, prompt, channelType, chatId, agentId);
      res.status(201).json(job);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete("/api/crons/:id", (req, res) => {
    const removed = removeCron(req.params.id);
    res.json({ removed });
  });

  app.post("/api/crons/:id/run", async (req, res) => {
    const msg = await runCronNow(req.params.id);
    res.json({ message: msg });
  });

  app.post("/api/crons/reload", (_req, res) => {
    const count = reloadCrons();
    res.json({ active: count });
  });

  // --- Runs ---
  app.get("/api/runs", (_req, res) => {
    // Read all JSONL files, merge, sort by ts desc
    if (!existsSync(RUNS_DIR)) return res.json([]);

    const files = readdirSync(RUNS_DIR).filter((f) => f.endsWith(".jsonl"));
    const runs: any[] = [];

    for (const file of files) {
      const content = readFileSync(resolve(RUNS_DIR, file), "utf-8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          runs.push(JSON.parse(line));
        } catch { /* skip */ }
      }
    }

    // Sort newest first, limit to 100
    runs.sort((a, b) => b.ts - a.ts);
    res.json(runs.slice(0, 100));
  });

  app.get("/api/runs/:jobId/:ts", (req, res) => {
    const { jobId, ts } = req.params;
    const logFile = resolve(RUNS_DIR, "logs", `${jobId}-${ts}.log`);

    if (!existsSync(logFile)) {
      return res.status(404).json({ error: "Log file not found" });
    }

    const content = readFileSync(logFile, "utf-8");
    res.type("text/plain").send(content);
  });

  // --- Start ---
  app.listen(port, () => {
    console.log(`[Dashboard] http://localhost:${port}/dashboard`);
  });

  return app;
}
```

**Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/dashboard/server.ts
git commit -m "feat: add Express dashboard server with API routes"
```

---

### Task 5: Integrate dashboard server into bot startup

**Files:**
- Modify: `src/index.ts`

**Step 1: Add dashboard startup**

After cron startup, add:

```typescript
import { createDashboardServer } from "./dashboard/server.js";

// In main(), after startAllCrons():
createDashboardServer(3000);
```

**Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: start dashboard server on bot boot"
```

---

### Task 6: Create dashboard frontend — HTML structure

**Files:**
- Create: `src/dashboard/static/index.html`

**Step 1: Create HTML file**

Single-page app with sidebar navigation and main content area. Three views: Cron Jobs, Runs, Log Detail. Use `data-page` attributes for routing. Include inline `<script src="app.js">` and `<link rel="stylesheet" href="style.css">`.

Structure:
- Sidebar: logo/title, nav links (Cron Jobs, Runs)
- Main: container divs for each page (crons-page, runs-page, log-page)
- Cron Jobs page: add button, table
- Runs page: table
- Log detail page: meta info bar, pre block for log content

**Step 2: Commit**

```bash
git add src/dashboard/static/index.html
git commit -m "feat: add dashboard HTML structure"
```

---

### Task 7: Create dashboard frontend — CSS styling

**Files:**
- Create: `src/dashboard/static/style.css`

**Step 1: Create CSS file**

Dark theme, terminal aesthetic:
- Background: #1a1a2e or similar dark
- Text: #e0e0e0
- Accent: #0f3460 for sidebar, #16213e for cards
- Status badges: green (#00c853), red (#ff1744), blue (#2979ff)
- Monospace font for log display
- Tables with subtle borders and hover highlight
- Responsive sidebar (fixed left, ~220px)

**Step 2: Commit**

```bash
git add src/dashboard/static/style.css
git commit -m "feat: add dashboard dark theme CSS"
```

---

### Task 8: Create dashboard frontend — JavaScript logic

**Files:**
- Create: `src/dashboard/static/app.js`

**Step 1: Create JS file**

Functions needed:
- `navigate(page)` — show/hide page divs, update sidebar active state
- `fetchCrons()` — GET /api/crons, render table with actions
- `fetchRuns()` — GET /api/runs, render table with status badges
- `fetchLog(jobId, ts)` — GET /api/runs/:jobId/:ts, display in pre block
- `toggleCron(id)` — PUT /api/crons/:id
- `runCron(id)` — POST /api/crons/:id/run
- `deleteCron(id)` — DELETE /api/crons/:id
- `addCron(form)` — POST /api/crons
- Auto-polling: setInterval for active page every 3 seconds
- Time formatting: relative time for recency, absolute for details

**Step 2: Commit**

```bash
git add src/dashboard/static/app.js
git commit -m "feat: add dashboard frontend logic"
```

---

### Task 9: End-to-end test

**Step 1: Start the bot**

Run: `npx tsx src/index.ts`
Expected: Logs include `[Dashboard] http://localhost:3000/dashboard`

**Step 2: Open browser**

Navigate to `http://localhost:3000/dashboard`
Expected: Dashboard loads with sidebar and cron jobs page

**Step 3: Verify cron jobs page**

Expected: Shows work-dev cron job with schedule, status

**Step 4: Verify runs page**

Click "Runs" in sidebar
Expected: Shows execution history from existing JSONL files

**Step 5: Trigger manual run**

Click "Run" button on work-dev cron job
Expected: Status changes to "Running", new entry appears in runs

**Step 6: Commit final state**

```bash
git add -A
git commit -m "feat: complete dashboard with cron management and run history"
```
