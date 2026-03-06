import express from "express";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import {
  setupChatWebSocket, listSessions, deleteSession,
  getPromptFiles, getPromptFileContent,
} from "./chat.js";
import {
  listCrons, getCron, addCron, removeCron, toggleCron, updateCron,
  runCronNow, reloadCrons, getRunningJobs,
} from "../scheduler/cron.js";
import {
  listQueue, addQueueTask, removeQueueTask, updateQueueTask,
  runQueueTask, startSequentialQueue, stopSequentialQueue,
  isSequentialRunning, getRunningQueueTasks,
} from "../scheduler/taskQueue.js";

const RUNS_DIR = resolve(process.cwd(), "data", "cron-runs");

export function createDashboardServer(port = 3000): void {
  const app = express();
  app.use(express.json());

  // Static files — use import.meta.dirname for ESM compatibility
  const staticDir = resolve(import.meta.dirname, "static");
  app.use("/dashboard", express.static(staticDir));

  // --- Cron CRUD ---
  app.get("/api/crons", (_req, res) => {
    res.json(listCrons());
  });

  app.put("/api/crons/:id", (req, res) => {
    const job = getCron(req.params.id);
    if (!job) { res.status(404).json({ error: "Not found" }); return; }

    if (req.body.enabled !== undefined && Object.keys(req.body).length === 1) {
      const toggled = toggleCron(job.id);
      res.json(toggled);
      return;
    }

    try {
      const updated = updateCron(job.id, req.body);
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
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
    if (!existsSync(RUNS_DIR)) { res.json([]); return; }

    const files = readdirSync(RUNS_DIR).filter((f) => f.endsWith(".jsonl"));
    const runs: Record<string, unknown>[] = [];

    for (const file of files) {
      const content = readFileSync(resolve(RUNS_DIR, file), "utf-8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          // Tag source if not already tagged
          if (!entry.source) entry.source = "cron";
          runs.push(entry);
        } catch { /* skip malformed */ }
      }
    }

    // Add currently running cron jobs
    const running = getRunningJobs();
    for (const [jobId, info] of running) {
      runs.push({
        ts: info.startMs,
        jobId,
        source: "cron",
        status: "running",
        durationMs: Date.now() - info.startMs,
      });
    }

    // Add currently running queue tasks
    const runningQueue = getRunningQueueTasks();
    for (const [taskId, info] of runningQueue) {
      runs.push({
        ts: info.startMs,
        jobId: `queue:${taskId}`,
        source: "queue",
        status: "running",
        durationMs: Date.now() - info.startMs,
      });
    }

    // Enrich with job/task name
    const jobs = listCrons();
    const jobMap = new Map(jobs.map((j) => [j.id, j]));
    const queueTasks = listQueue();
    const queueMap = new Map(queueTasks.map((t) => [t.id, t]));
    for (const run of runs) {
      const r = run as any;
      if (r.source === "queue") {
        const taskId = r.jobId.replace("queue:", "");
        const task = queueMap.get(taskId);
        if (task) r.jobName = task.name;
        if (!r.jobName && r.taskName) r.jobName = r.taskName;
      } else {
        const job = jobMap.get(r.jobId);
        if (job) r.jobName = job.name;
      }
    }

    runs.sort((a, b) => (b as any).ts - (a as any).ts);
    res.json(runs.slice(0, 100));
  });

  app.delete("/api/runs/:jobId/:ts", (req, res) => {
    const { jobId, ts } = req.params;

    // Remove from JSONL
    const jsonlFile = resolve(RUNS_DIR, `${jobId}.jsonl`);
    if (existsSync(jsonlFile)) {
      const lines = readFileSync(jsonlFile, "utf-8").split("\n").filter((line) => {
        if (!line.trim()) return false;
        try {
          const entry = JSON.parse(line);
          return String(entry.ts) !== ts;
        } catch { return true; }
      });
      writeFileSync(jsonlFile, lines.join("\n") + (lines.length ? "\n" : ""), "utf-8");
    }

    // Remove log file if exists
    const logFile = resolve(RUNS_DIR, "logs", `${jobId}-${ts}.log`);
    if (existsSync(logFile)) unlinkSync(logFile);

    res.json({ deleted: true });
  });

  app.get("/api/runs/:jobId/:ts", (req, res) => {
    const { jobId, ts } = req.params;
    const logFile = resolve(RUNS_DIR, "logs", `${jobId}-${ts}.log`);

    if (!existsSync(logFile)) {
      res.status(404).json({ error: "Log file not found" });
      return;
    }

    const content = readFileSync(logFile, "utf-8");
    res.type("text/plain").send(content);
  });

  // --- Queue ---
  app.get("/api/queue", (_req, res) => {
    res.json(listQueue());
  });

  app.post("/api/queue", (req, res) => {
    try {
      const task = addQueueTask(req.body);
      res.status(201).json(task);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put("/api/queue/:id", (req, res) => {
    const updated = updateQueueTask(req.params.id, req.body);
    if (!updated) { res.status(404).json({ error: "Not found" }); return; }
    res.json(updated);
  });

  app.delete("/api/queue/:id", (req, res) => {
    const removed = removeQueueTask(req.params.id);
    res.json({ removed });
  });

  app.post("/api/queue/:id/run", async (req, res) => {
    const msg = await runQueueTask(req.params.id);
    res.json({ message: msg });
  });

  app.post("/api/queue/start", async (_req, res) => {
    const msg = await startSequentialQueue();
    res.json({ message: msg });
  });

  app.post("/api/queue/stop", (_req, res) => {
    const msg = stopSequentialQueue();
    res.json({ message: msg });
  });

  app.get("/api/queue/status", (_req, res) => {
    res.json({ running: isSequentialRunning() });
  });

  // --- Branches ---
  const PROJECTS_BASE = resolve("C:/Users/kyjs0/Documents/Work/AI_Platform");

  function discoverProjects(): Record<string, string> {
    const projects: Record<string, string> = {};
    for (const entry of readdirSync(PROJECTS_BASE, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = resolve(PROJECTS_BASE, entry.name);
      if (!existsSync(resolve(dir, ".git"))) continue;
      // Check if it has a GitHub remote
      try {
        const remote = execSync("git remote get-url origin", { cwd: dir, encoding: "utf-8" }).trim();
        if (remote.includes("github")) {
          projects[entry.name] = dir;
        }
      } catch { /* no remote */ }
    }
    return projects;
  }

  app.get("/api/projects", (_req, res) => {
    res.json(Object.keys(discoverProjects()));
  });

  app.get("/api/branches/:project", (req, res) => {
    const dir = discoverProjects()[req.params.project];
    if (!dir) { res.status(404).json({ error: "Project not found" }); return; }

    try {
      const current = execSync("git branch --show-current", { cwd: dir, encoding: "utf-8" }).trim();
      const raw = execSync("git branch --format='%(refname:short)'", { cwd: dir, encoding: "utf-8" });
      const branches = raw.split("\n").map((b) => b.trim().replace(/^'|'$/g, "")).filter(Boolean);
      res.json({ project: req.params.project, current, branches });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/branches/:project/checkout", (req, res) => {
    const dir = discoverProjects()[req.params.project];
    if (!dir) { res.status(404).json({ error: "Project not found" }); return; }

    const { branch } = req.body;
    if (!branch) { res.status(400).json({ error: "branch is required" }); return; }

    try {
      execSync(`git checkout ${branch}`, { cwd: dir, encoding: "utf-8" });
      res.json({ current: branch });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // --- Dev Server ---
  const devProcesses = new Map<string, { proc: ReturnType<typeof import("node:child_process").spawn>; port?: string }>();

  app.post("/api/devserver/:project/start", (req, res) => {
    const project = req.params.project;
    const dir = discoverProjects()[project];
    if (!dir) { res.status(404).json({ error: "Project not found" }); return; }

    if (devProcesses.has(project)) {
      res.json({ status: "already running" });
      return;
    }

    const { spawn } = require("node:child_process") as typeof import("node:child_process");
    const proc = spawn("npm", ["run", "dev"], { cwd: dir, shell: true, stdio: "ignore", detached: false });
    devProcesses.set(project, { proc });

    proc.on("close", () => {
      devProcesses.delete(project);
    });

    res.json({ status: "started" });
  });

  app.post("/api/devserver/:project/stop", (req, res) => {
    const entry = devProcesses.get(req.params.project);
    if (!entry) { res.json({ status: "not running" }); return; }

    entry.proc.kill();
    devProcesses.delete(req.params.project);
    res.json({ status: "stopped" });
  });

  app.get("/api/devserver", (_req, res) => {
    const running = Object.fromEntries(
      [...devProcesses.entries()].map(([k]) => [k, true]),
    );
    res.json(running);
  });

  // --- Chat Sessions ---
  app.get("/api/chat/sessions", (_req, res) => {
    res.json(listSessions());
  });

  app.delete("/api/chat/sessions/:id", (req, res) => {
    res.json({ deleted: deleteSession(req.params.id) });
  });

  // --- Prompt Files ---
  app.get("/api/prompts", (_req, res) => {
    res.json(getPromptFiles());
  });

  app.get("/api/prompts/:filename", (req, res) => {
    const content = getPromptFileContent(req.params.filename);
    if (!content) { res.status(404).json({ error: "Not found" }); return; }
    res.type("text/plain").send(content);
  });

  // --- Project Paths ---
  app.get("/api/projects/paths", (_req, res) => {
    res.json(discoverProjects());
  });

  // --- Start server with WebSocket ---
  const httpServer = createServer(app);
  setupChatWebSocket(httpServer);

  httpServer.listen(port, () => {
    console.log(`[Dashboard] http://localhost:${port}/dashboard`);
  });
}
