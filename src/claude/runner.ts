// Backwards-compatible wrapper — delegates to queue-level job management
import { cancelAllJobs, isAnyJobRunning, getFirstRunningPromptId } from "./queue.js";
import type { RunResult } from "../providers/base.js";

export type ClaudeResult = RunResult;

export const cancelCurrent = (): boolean => {
  if (isAnyJobRunning()) {
    cancelAllJobs();
    return true;
  }
  return false;
};

export const isRunning = (): boolean => isAnyJobRunning();
export const getCurrentPromptId = (): string | null => getFirstRunningPromptId();
