import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ChannelType } from "../types.js";
import { enqueue } from "../claude/queue.js";

const QUEUE_FILE = resolve(process.cwd(), "data", "queue.json");
const RUNS_DIR = resolve(process.cwd(), "data", "cron-runs");

export interface QueueTask {
  id: string;
  name: string;
  prompt: string;
  channelType: ChannelType;
  chatId: string;
  workingDir?: string;
  agentId?: string;
  model?: string;
  timeoutMs?: number;
  status: "pending" | "running" | "done" | "error";
  createdAt: number;
  order: number;
}

interface QueueFile {
  version: 1;
  tasks: QueueTask[];
}

// --- Persistence ---

function loadTasks(): QueueTask[] {
  if (!existsSync(QUEUE_FILE)) return [];
  const raw = readFileSync(QUEUE_FILE, "utf-8");
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  return (parsed as QueueFile).tasks ?? [];
}

function saveTasks(tasks: QueueTask[]): void {
  mkdirSync(dirname(QUEUE_FILE), { recursive: true });
  writeFileSync(QUEUE_FILE, JSON.stringify({ version: 1, tasks } as QueueFile, null, 2), "utf-8");
}

// --- CRUD ---

export function listQueue(): QueueTask[] {
  return loadTasks().sort((a, b) => a.order - b.order);
}

export function getQueueTask(id: string): QueueTask | undefined {
  return loadTasks().find((t) => t.id === id);
}

export function addQueueTask(data: {
  name?: string;
  prompt: string;
  channelType?: ChannelType;
  chatId?: string;
  workingDir?: string;
  timeoutMs?: number;
}): QueueTask {
  const tasks = loadTasks();
  const maxOrder = tasks.reduce((max, t) => Math.max(max, t.order), 0);

  const task: QueueTask = {
    id: randomUUID(),
    name: data.name || data.prompt.slice(0, 40),
    prompt: data.prompt,
    channelType: data.channelType ?? "local",
    chatId: data.chatId ?? "",
    workingDir: data.workingDir,
    timeoutMs: data.timeoutMs,
    status: "pending",
    createdAt: Date.now(),
    order: maxOrder + 1,
  };

  tasks.push(task);
  saveTasks(tasks);
  return task;
}

export function removeQueueTask(id: string): boolean {
  const tasks = loadTasks();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return false;
  tasks.splice(idx, 1);
  saveTasks(tasks);
  return true;
}

export function updateQueueTask(id: string, updates: Partial<Pick<QueueTask, "name" | "prompt" | "workingDir" | "order" | "timeoutMs">>): QueueTask | null {
  const tasks = loadTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) return null;

  if (updates.name !== undefined) task.name = updates.name;
  if (updates.prompt !== undefined) task.prompt = updates.prompt;
  if (updates.workingDir !== undefined) task.workingDir = updates.workingDir;
  if (updates.order !== undefined) task.order = updates.order;
  if (updates.timeoutMs !== undefined) task.timeoutMs = updates.timeoutMs;

  saveTasks(tasks);
  return task;
}

export function reorderQueue(ids: string[]): void {
  const tasks = loadTasks();
  for (let i = 0; i < ids.length; i++) {
    const task = tasks.find((t) => t.id === ids[i]);
    if (task) task.order = i + 1;
  }
  saveTasks(tasks);
}

// --- Execution ---

const runningQueueTasks = new Map<string, { startMs: number; logFile: string }>();
let sequentialRunning = false;
let sequentialAbort = false;

export function getRunningQueueTasks(): Map<string, { startMs: number; logFile: string }> {
  return runningQueueTasks;
}

export function isSequentialRunning(): boolean {
  return sequentialRunning;
}

export async function runQueueTask(id: string): Promise<string> {
  const task = getQueueTask(id);
  if (!task) return `Not found: ${id}`;
  if (task.status === "running") return `Already running: ${task.name}`;

  executeQueueTask(task).catch((err) =>
    console.error(`[Queue] Run error (${id}):`, err),
  );
  return `Queue task "${task.name}" started.`;
}

export async function startSequentialQueue(): Promise<string> {
  if (sequentialRunning) return "Queue is already running.";

  const pending = listQueue().filter((t) => t.status === "pending");
  if (pending.length === 0) return "No pending tasks in queue.";

  sequentialRunning = true;
  sequentialAbort = false;

  runSequential(pending).catch((err) =>
    console.error("[Queue] Sequential run error:", err),
  );

  return `Started queue: ${pending.length} tasks.`;
}

export function stopSequentialQueue(): string {
  if (!sequentialRunning) return "Queue is not running.";
  sequentialAbort = true;
  return "Queue will stop after current task completes.";
}

async function runSequential(tasks: QueueTask[]): Promise<void> {
  for (const task of tasks) {
    if (sequentialAbort) break;

    // Re-check status in case it was manually run
    const current = getQueueTask(task.id);
    if (!current || current.status !== "pending") continue;

    await executeQueueTask(current);
  }
  sequentialRunning = false;
  sequentialAbort = false;
  console.log("[Queue] Sequential run completed.");
}

async function executeQueueTask(task: QueueTask): Promise<void> {
  const startMs = Date.now();
  const logFile = resolve(RUNS_DIR, "logs", `queue-${task.id}-${startMs}.log`);

  // Update status to running
  updateTaskStatus(task.id, "running");
  runningQueueTasks.set(task.id, { startMs, logFile });

  const { promise } = enqueue({
    prompt: task.prompt,
    chatId: task.chatId,
    channel: task.channelType,
    workingDir: task.workingDir,
    model: task.model,
    timeoutMs: task.timeoutMs,
    logFile,
  });

  try {
    const result = await promise;
    const durationMs = Date.now() - startMs;
    const isError = !!result.error;

    updateTaskStatus(task.id, isError ? "error" : "done");

    appendRunLog({
      ts: startMs,
      jobId: `queue:${task.id}`,
      source: "queue",
      taskName: task.name,
      status: isError ? "error" : "ok",
      durationMs,
      error: result.error,
      outputSnippet: result.output?.slice(0, 200),
      logFile,
    });
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const errorMsg = err instanceof Error ? err.message : String(err);

    updateTaskStatus(task.id, "error");

    appendRunLog({
      ts: startMs,
      jobId: `queue:${task.id}`,
      source: "queue",
      taskName: task.name,
      status: "error",
      durationMs,
      error: errorMsg,
      logFile,
    });

    console.error(`[Queue] Error executing task ${task.id}:`, err);
  }

  runningQueueTasks.delete(task.id);
}

function updateTaskStatus(id: string, status: QueueTask["status"]): void {
  const tasks = loadTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  task.status = status;
  saveTasks(tasks);
}

interface RunLogEntry {
  ts: number;
  jobId: string;
  source: "queue";
  taskName: string;
  status: "ok" | "error";
  durationMs: number;
  error?: string;
  outputSnippet?: string;
  logFile?: string;
}

function appendRunLog(entry: RunLogEntry): void {
  const filePath = resolve(RUNS_DIR, "queue-runs.jsonl");
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
}
