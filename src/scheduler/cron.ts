import cron from "node-cron";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { CronJob, ChannelType } from "../types.js";
import { buildPrompt } from "../claude/context.js";
import { enqueue } from "../claude/queue.js";

const CRONS_FILE = resolve(process.cwd(), "data", "crons.json");
const activeTasks = new Map<string, cron.ScheduledTask>();

// Callback for sending results to channel
type SendCallback = (channelType: ChannelType, chatId: string, text: string) => Promise<void>;
let sendCallback: SendCallback | null = null;

export function setCronSendCallback(cb: SendCallback): void {
  sendCallback = cb;
}

function loadCrons(): CronJob[] {
  if (!existsSync(CRONS_FILE)) return [];
  const raw = readFileSync(CRONS_FILE, "utf-8");
  return JSON.parse(raw);
}

function saveCrons(jobs: CronJob[]): void {
  mkdirSync(dirname(CRONS_FILE), { recursive: true });
  writeFileSync(CRONS_FILE, JSON.stringify(jobs, null, 2), "utf-8");
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

  const job: CronJob = {
    id: randomUUID(),
    schedule,
    prompt,
    channelType,
    chatId,
    enabled: true,
    createdAt: Date.now(),
  };

  const jobs = loadCrons();
  jobs.push(job);
  saveCrons(jobs);

  scheduleCron(job);
  return job;
}

export function removeCron(id: string): boolean {
  const jobs = loadCrons();
  const idx = jobs.findIndex((j) => j.id === id || j.id.startsWith(id));
  if (idx === -1) return false;

  const removed = jobs[idx];
  jobs.splice(idx, 1);
  saveCrons(jobs);

  const task = activeTasks.get(removed.id);
  if (task) {
    task.stop();
    activeTasks.delete(removed.id);
  }
  return true;
}

export function listCrons(): CronJob[] {
  return loadCrons();
}

export function toggleCron(id: string): CronJob | null {
  const jobs = loadCrons();
  const job = jobs.find((j) => j.id === id || j.id.startsWith(id));
  if (!job) return null;

  job.enabled = !job.enabled;
  saveCrons(jobs);

  const task = activeTasks.get(job.id);
  if (task) {
    if (job.enabled) task.start();
    else task.stop();
  } else if (job.enabled) {
    scheduleCron(job);
  }

  return job;
}

function scheduleCron(job: CronJob): void {
  if (!job.enabled) return;

  const task = cron.schedule(job.schedule, async () => {
    const prompt = buildPrompt(job.prompt, job.chatId);
    const { promise } = enqueue(prompt, job.chatId, job.channelType);

    try {
      const result = await promise;
      const text = result.error
        ? `[Cron] Error: ${result.error}`
        : `[Cron] ${result.output}`;

      if (sendCallback) {
        await sendCallback(job.channelType, job.chatId, text);
      }
    } catch (err) {
      console.error(`[Cron] Error executing job ${job.id}:`, err);
    }
  });

  activeTasks.set(job.id, task);
}

export function startAllCrons(): void {
  const jobs = loadCrons();
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
