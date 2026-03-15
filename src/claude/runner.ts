// Backwards-compatible wrapper — delegates to ClaudeProvider
import { ClaudeProvider } from "../providers/claude.js";
import type { RunOptions, RunResult } from "../providers/base.js";

const provider = new ClaudeProvider();

export type { RunResult as ClaudeResult };
export type RunClaudeOptions = RunOptions;

export const runClaude = (opts: RunOptions): Promise<RunResult> => provider.run(opts);
export const cancelCurrent = (): boolean => provider.cancel();
export const isRunning = (): boolean => provider.isRunning();
export const getCurrentPromptId = (): string | null => provider.getCurrentPromptId();
export { provider as claudeProvider };
