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
  toolsUsed?: string[];  // tools invoked during execution (e.g. "Write", "Edit", "Bash")
}

export interface RunHandle {
  promise: Promise<RunResult>;
  cancel: () => void;
}

export interface Provider {
  readonly name: string;
  run(options: RunOptions): RunHandle;
}
