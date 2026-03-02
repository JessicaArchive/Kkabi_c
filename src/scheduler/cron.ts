import cron from "node-cron";
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { CronJob, CronJobState, ChannelType } from "../types.js";
import { getAgent } from "../agents/store.js";
import { buildPrompt } from "../claude/context.js";
import { enqueue } from "../claude/queue.js";

const CRONS_FILE = resolve(process.cwd(), "data", "crons.json");
const RUNS_DIR = resolve(process.cwd(), "data", "cron-runs");
const activeTasks = new Map<string, cron.ScheduledTask>();

// --- Send callback ---

type SendCallback = (channelType: ChannelType, chatId: string, text: string) => Promise<void>;
let sendCallback: SendCallback | null = null;

export function setCronSendCallback(cb: SendCallback): void {
  sendCallback = cb;
}

// --- Persistence ---

interface CronsFile {
  version: 1;
  jobs: CronJob[];
}

function loadCronsRaw(): CronJob[] {
  if (!existsSync(CRONS_FILE)) return [];
  const raw = readFileSync(CRONS_FILE, "utf-8");
  const parsed = JSON.parse(raw);
  // Support both old array format and new { version, jobs } format
  if (Array.isArray(parsed)) {
    return parsed;
  }
  return (parsed as CronsFile).jobs ?? [];
}

function saveCronsRaw(jobs: CronJob[]): void {
  mkdirSync(dirname(CRONS_FILE), { recursive: true });
  const data: CronsFile = { version: 1, jobs };
  writeFileSync(CRONS_FILE, JSON.stringify(data, null, 2), "utf-8");
}

// --- CRUD ---

export function listCrons(): CronJob[] {
  return loadCronsRaw();
}

export function getCron(id: string): CronJob | undefined {
  const jobs = loadCronsRaw();
  return jobs.find((j) => j.id === id || j.id.startsWith(id));
}

export function addCron(
  schedule: string,
  prompt: string,
  channelType: ChannelType,
  chatId: string,
): CronJob {
  if (!cron.validate(schedule)) {
    throw new Error(`Invalid cron schedule: ${schedule}`);
  }

  const now = Date.now();
  const job: CronJob = {
    id: randomUUID(),
    name: prompt.slice(0, 40),
    schedule,
    prompt,
    channelType,
    chatId,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };

  const jobs = loadCronsRaw();
  jobs.push(job);
  saveCronsRaw(jobs);

  scheduleCron(job);
  return job;
}

export function removeCron(id: string): boolean {
  const jobs = loadCronsRaw();
  const idx = jobs.findIndex((j) => j.id === id || j.id.startsWith(id));
  if (idx === -1) return false;

  const removed = jobs[idx];
  jobs.splice(idx, 1);
  saveCronsRaw(jobs);

  const task = activeTasks.get(removed.id);
  if (task) {
    task.stop();
    activeTasks.delete(removed.id);
  }
  return true;
}

export function toggleCron(id: string): CronJob | null {
  const jobs = loadCronsRaw();
  const job = jobs.find((j) => j.id === id || j.id.startsWith(id));
  if (!job) return null;

  job.enabled = !job.enabled;
  job.updatedAt = Date.now();
  saveCronsRaw(jobs);

  const task = activeTasks.get(job.id);
  if (task) {
    if (job.enabled) task.start();
    else task.stop();
  } else if (job.enabled) {
    scheduleCron(job);
  }

  return job;
}

// --- Execution ---

function resolvePrompt(job: CronJob): string {
  if (job.promptPath) {
    const filePath = resolve(process.cwd(), job.promptPath);
    if (existsSync(filePath)) {
      return readFileSync(filePath, "utf-8");
    }
    console.error(`[Cron] Prompt file not found: ${filePath}, falling back to inline prompt`);
  }
  return job.prompt;
}

function scheduleCron(job: CronJob): void {
  if (!job.enabled) return;

  const task = cron.schedule(job.schedule, async () => {
    await executeCronJob(job);
  });

  activeTasks.set(job.id, task);
}

async function executeCronJob(job: CronJob): Promise<void> {
  const startMs = Date.now();
  const agent = job.agentId ? getAgent(job.agentId) : undefined;

  // Resolve prompt: promptPath > inline prompt
  let promptText = resolvePrompt(job);

  // Inject agent persona if present
  if (agent?.persona) {
    promptText = `[PERSONA]\n${agent.persona}\n\n${promptText}`;
  }

  // Build full prompt with conversation context
  const fullPrompt = buildPrompt(promptText, job.chatId);

  // Resolve settings: CronJob > Agent > defaults
  const model = job.model ?? agent?.model;
  const workingDir = job.workingDir ?? agent?.workingDir;
  const timeoutMs = job.timeoutMs ?? agent?.timeoutMs;

  const { promise } = enqueue({
    prompt: fullPrompt,
    chatId: job.chatId,
    channel: job.channelType,
    model,
    workingDir,
    timeoutMs,
  });

  try {
    const result = await promise;
    const durationMs = Date.now() - startMs;
    const isError = !!result.error;

    // Update state
    updateJobState(job.id, {
      lastRunAtMs: startMs,
      lastStatus: isError ? "error" : "ok",
      lastDurationMs: durationMs,
      consecutiveErrors: isError ? ((job.state?.consecutiveErrors ?? 0) + 1) : 0,
      lastError: isError ? result.error : undefined,
    });

    // Write JSONL log
    appendRunLog(job.id, {
      ts: startMs,
      jobId: job.id,
      status: isError ? "error" : "ok",
      durationMs,
      model,
      error: result.error,
      outputSnippet: result.output?.slice(0, 200),
    });

    // Send result to channel
    const text = result.error
      ? `[Cron] Error: ${result.error}`
      : `[Cron] ${result.output}`;

    if (sendCallback) {
      await sendCallback(job.channelType, job.chatId, text);
    }
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const errorMsg = err instanceof Error ? err.message : String(err);

    updateJobState(job.id, {
      lastRunAtMs: startMs,
      lastStatus: "error",
      lastDurationMs: durationMs,
      consecutiveErrors: (job.state?.consecutiveErrors ?? 0) + 1,
      lastError: errorMsg,
    });

    appendRunLog(job.id, {
      ts: startMs,
      jobId: job.id,
      status: "error",
      durationMs,
      model,
      error: errorMsg,
    });

    console.error(`[Cron] Error executing job ${job.id}:`, err);
  }
}

export async function runCronNow(id: string): Promise<string> {
  const job = getCron(id);
  if (!job) return `Not found: ${id}`;

  executeCronJob(job).catch((err) =>
    console.error(`[Cron] Manual run error (${id}):`, err),
  );
  return `Cron job "${job.name}" started.`;
}

// --- State tracking ---

function updateJobState(id: string, state: CronJobState): void {
  const jobs = loadCronsRaw();
  const job = jobs.find((j) => j.id === id);
  if (!job) return;

  job.state = state;
  job.updatedAt = Date.now();
  saveCronsRaw(jobs);
}

// --- JSONL run logs ---

interface CronRunLogEntry {
  ts: number;
  jobId: string;
  status: "ok" | "error";
  durationMs: number;
  model?: string;
  error?: string;
  outputSnippet?: string;
}

function appendRunLog(jobId: string, entry: CronRunLogEntry): void {
  const filePath = resolve(RUNS_DIR, `${jobId}.jsonl`);
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
}

// --- Lifecycle ---

export function startAllCrons(): void {
  const jobs = loadCronsRaw();
  for (const job of jobs) {
    if (job.enabled) {
      scheduleCron(job);
    }
  }
  if (jobs.length > 0) {
    console.log(`[Cron] Loaded ${jobs.filter((j) => j.enabled).length} active cron jobs`);
  }
}

export function stopAllCrons(): void {
  for (const [, task] of activeTasks) {
    task.stop();
  }
  activeTasks.clear();
}

export function reloadCrons(): number {
  stopAllCrons();
  const jobs = loadCronsRaw();
  for (const job of jobs) {
    if (job.enabled) {
      scheduleCron(job);
    }
  }
  const active = jobs.filter((j) => j.enabled).length;
  console.log(`[Cron] Reloaded: ${active} active cron jobs`);
  return active;
}
