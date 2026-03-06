import { randomUUID } from "node:crypto";
import type { ClaudeResult, QueueItem, ChannelType } from "../types.js";
import { runClaude } from "./runner.js";

const queue: QueueItem[] = [];
let processing = false;

export function getQueueLength(): number {
  return queue.length;
}

export function getQueueItems(): QueueItem[] {
  return [...queue];
}

export interface EnqueueOptions {
  prompt: string;
  chatId: string;
  channel: ChannelType;
  workingDir?: string;
  model?: string;
  timeoutMs?: number;
  logFile?: string;
}

export function enqueue(
  options: EnqueueOptions,
): { promise: Promise<ClaudeResult>; position: number; id: string } {
  const { prompt, chatId, channel, workingDir, model, timeoutMs, logFile } = options;
  const id = randomUUID();

  const promise = new Promise<ClaudeResult>((resolve, reject) => {
    queue.push({ id, prompt, chatId, channel, workingDir, model, timeoutMs, logFile, resolve, reject });
  });

  const position = queue.length;

  if (!processing) {
    processNext();
  }

  return { promise, position, id };
}

export function removeFromQueue(id: string): boolean {
  const idx = queue.findIndex((item) => item.id === id);
  if (idx === -1) return false;
  const [removed] = queue.splice(idx, 1);
  removed.resolve({ output: "", error: "Cancelled from queue", timedOut: false });
  return true;
}

async function processNext(): Promise<void> {
  if (queue.length === 0) {
    processing = false;
    return;
  }

  processing = true;
  const item = queue.shift()!;

  try {
    const result = await runClaude({
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
  }

  processNext();
}
