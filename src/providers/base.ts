export interface RunOptions {
  prompt: string;
  promptId: string;
  workingDir?: string;
  model?: string;
  timeoutMs?: number;
  logFile?: string;
}

export interface RunResult {
  output: string;
  error?: string;
  timedOut: boolean;
}

export interface Provider {
  readonly name: string;
  run(options: RunOptions): Promise<RunResult>;
  cancel(): boolean;
  isRunning(): boolean;
  getCurrentPromptId(): string | null;
}
