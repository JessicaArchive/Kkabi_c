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

export function enqueue(
  prompt: string,
  chatId: string,
  channel: ChannelType,
  workingDir?: string,
): { promise: Promise<ClaudeResult>; position: number; id: string } {
  const id = randomUUID();

  const promise = new Promise<ClaudeResult>((resolve, reject) => {
    queue.push({ id, prompt, chatId, channel, workingDir, resolve, reject });
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
    const result = await runClaude(item.prompt, item.id, item.workingDir);
    item.resolve(result);
  } catch (err) {
    item.reject(err instanceof Error ? err : new Error(String(err)));
  }

  processNext();
}
