import { randomUUID } from "node:crypto";
import type { ClaudeResult, QueueItem, ChannelType, ProviderType } from "../types.js";
import { ClaudeProvider } from "../providers/claude.js";
import { CodexProvider } from "../providers/codex.js";
import type { Provider } from "../providers/base.js";

// Provider instances (stateless — no mutable state)
const providers: Record<ProviderType, Provider> = {
  claude: new ClaudeProvider(),
  codex: new CodexProvider(),
};

// Active job cancel handles — keyed by job id
const activeJobs = new Map<string, { cancel: () => void; promptId: string; dir: string }>();

// workingDir-based sub-queues for parallel processing
const queues = new Map<string, QueueItem[]>();
const processingCount = new Map<string, number>(); // dir → active count
let globalRunning = 0;

const DEFAULT_DIR = "__default__";

let maxConcurrent = 1;
let maxPerWorkingDir = 1;

export function setQueueLimits(concurrent: number, perDir: number): void {
  maxConcurrent = concurrent;
  maxPerWorkingDir = perDir;
}

export function getQueueLength(): number {
  let total = 0;
  for (const q of queues.values()) total += q.length;
  return total;
}

export function getQueueItems(): QueueItem[] {
  const items: QueueItem[] = [];
  for (const q of queues.values()) items.push(...q);
  return items;
}

export function getActiveJobCount(): number {
  return activeJobs.size;
}

export interface EnqueueOptions {
  prompt: string;
  chatId: string;
  channel: ChannelType;
  provider?: ProviderType;
  workingDir?: string;
  model?: string;
  timeoutMs?: number;
  logFile?: string;
}

export function enqueue(
  options: EnqueueOptions,
): { promise: Promise<ClaudeResult>; position: number; id: string } {
  const dir = options.workingDir ?? DEFAULT_DIR;
  const id = randomUUID();

  if (!queues.has(dir)) {
    queues.set(dir, []);
  }

  const promise = new Promise<ClaudeResult>((resolve, reject) => {
    queues.get(dir)!.push({
      id,
      prompt: options.prompt,
      chatId: options.chatId,
      channel: options.channel,
      provider: options.provider,
      workingDir: options.workingDir,
      model: options.model,
      timeoutMs: options.timeoutMs,
      logFile: options.logFile,
      resolve,
      reject,
    });
  });

  const position = getQueueLength();
  tryProcessNext();
  return { promise, position, id };
}

export function removeFromQueue(id: string): boolean {
  for (const [, q] of queues) {
    const idx = q.findIndex((item) => item.id === id);
    if (idx !== -1) {
      const [removed] = q.splice(idx, 1);
      removed.resolve({ output: "", error: "Cancelled from queue", timedOut: false });
      return true;
    }
  }
  return false;
}

// Cancel a running job by id
export function cancelJob(id: string): boolean {
  const job = activeJobs.get(id);
  if (job) {
    job.cancel();
    return true;
  }
  return removeFromQueue(id);
}

// Cancel all running jobs (for shutdown)
export function cancelAllJobs(): void {
  for (const [, job] of activeJobs) {
    job.cancel();
  }
}

// Check if any job is running
export function isAnyJobRunning(): boolean {
  return activeJobs.size > 0;
}

// Get the first running job's prompt id (backwards compat)
export function getFirstRunningPromptId(): string | null {
  for (const [, job] of activeJobs) {
    return job.promptId;
  }
  return null;
}

function tryProcessNext(): void {
  for (const [dir, queue] of queues) {
    if (queue.length === 0) continue;
    if (globalRunning >= maxConcurrent) return;

    const dirCount = processingCount.get(dir) ?? 0;
    if (dirCount >= maxPerWorkingDir) continue;

    processingCount.set(dir, dirCount + 1);
    globalRunning++;
    const item = queue.shift()!;
    processItem(item, dir);
  }
}

async function processItem(item: QueueItem, dir: string): Promise<void> {
  const provider = providers[item.provider ?? "claude"];
  const handle = provider.run({
    prompt: item.prompt,
    promptId: item.id,
    workingDir: item.workingDir,
    model: item.model,
    timeoutMs: item.timeoutMs,
    logFile: item.logFile,
  });

  activeJobs.set(item.id, { cancel: handle.cancel, promptId: item.id, dir });

  try {
    const result = await handle.promise;
    item.resolve(result);
  } catch (err) {
    item.reject(err instanceof Error ? err : new Error(String(err)));
  } finally {
    activeJobs.delete(item.id);
    const dirCount = (processingCount.get(dir) ?? 1) - 1;
    if (dirCount <= 0) {
      processingCount.delete(dir);
    } else {
      processingCount.set(dir, dirCount);
    }
    globalRunning--;
    const q = queues.get(dir);
    if (q && q.length === 0) queues.delete(dir);
    tryProcessNext();
  }
}
