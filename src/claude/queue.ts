import { randomUUID } from "node:crypto";
import type { ClaudeResult, QueueItem, ChannelType, ProviderType } from "../types.js";
import { ClaudeProvider } from "../providers/claude.js";
import { CodexProvider } from "../providers/codex.js";
import type { Provider } from "../providers/base.js";

// Provider instances
const providers: Record<ProviderType, Provider> = {
  claude: new ClaudeProvider(),
  codex: new CodexProvider(),
};

// workingDir-based sub-queues for parallel processing
const queues = new Map<string, QueueItem[]>();
const processing = new Set<string>();
let globalRunning = 0;

const DEFAULT_DIR = "__default__";
const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_MAX_PER_DIR = 1;

let maxConcurrent = DEFAULT_MAX_CONCURRENT;
let maxPerWorkingDir = DEFAULT_MAX_PER_DIR;

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

function tryProcessNext(): void {
  for (const [dir, queue] of queues) {
    if (queue.length === 0) continue;
    if (globalRunning >= maxConcurrent) return;
    if (processing.has(dir)) continue; // maxPerWorkingDir=1 enforced

    processing.add(dir);
    globalRunning++;
    const item = queue.shift()!;
    processItem(item, dir);
  }
}

async function processItem(item: QueueItem, dir: string): Promise<void> {
  const provider = providers[item.provider ?? "claude"];

  try {
    const result = await provider.run({
      prompt: item.prompt,
      promptId: item.id,
      workingDir: item.workingDir,
      model: item.model,
      timeoutMs: item.timeoutMs,
      logFile: item.logFile,
    });
    item.resolve(result);
  } catch (err) {
    item.reject(err instanceof Error ? err : new Error(String(err)));
  } finally {
    processing.delete(dir);
    globalRunning--;
    const q = queues.get(dir);
    if (q && q.length === 0) queues.delete(dir);
    tryProcessNext();
  }
}

// Expose provider instances for cancel/status checks
export function getProvider(type: ProviderType): Provider {
  return providers[type];
}
