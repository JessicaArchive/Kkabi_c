import { spawn, type ChildProcess } from "node:child_process";
import { getConfig } from "../config.js";
import type { ClaudeResult } from "../types.js";

let currentProcess: ChildProcess | null = null;
let currentPromptId: string | null = null;

export function isRunning(): boolean {
  return currentProcess !== null;
}

export function getCurrentPromptId(): string | null {
  return currentPromptId;
}

export function cancelCurrent(): boolean {
  if (currentProcess) {
    currentProcess.kill("SIGTERM");
    currentProcess = null;
    currentPromptId = null;
    return true;
  }
  return false;
}

export async function runClaude(
  prompt: string,
  promptId: string,
  workingDir?: string,
): Promise<ClaudeResult> {
  const config = getConfig();
  const timeout = config.claude.timeoutMs;
  const raw = workingDir ?? config.claude.workingDir;
  const cwd = raw.startsWith("~") ? raw.replace(/^~/, process.env.HOME ?? "") : raw;

  return new Promise<ClaudeResult>((resolve) => {
    const args = ["-p", prompt, "--output-format", "text"];
    const disallowed = config.claude.disallowedTools;
    if (disallowed.length > 0) {
      args.push("--disallowedTools", ...disallowed);
    }
    const proc = spawn("claude", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CLAUDECODE: undefined },
    });

    currentProcess = proc;
    currentPromptId = promptId;

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      currentProcess = null;
      currentPromptId = null;
      resolve({ output: stdout, error: "Timed out", timedOut: true });
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timer);
      currentProcess = null;
      currentPromptId = null;

      if (code === 0) {
        resolve({ output: stdout.trim(), timedOut: false });
      } else {
        const error = classifyError(stderr, code);
        resolve({ output: stdout.trim(), error, timedOut: false });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      currentProcess = null;
      currentPromptId = null;
      resolve({ output: "", error: `Spawn error: ${err.message}`, timedOut: false });
    });
  });
}

function classifyError(stderr: string, code: number | null): string {
  const lower = stderr.toLowerCase();
  if (lower.includes("auth") || lower.includes("unauthorized")) return "auth_error";
  if (lower.includes("rate") || lower.includes("throttl")) return "rate_limit";
  if (lower.includes("timeout")) return "timeout";
  return `exit_code_${code ?? "unknown"}: ${stderr.slice(0, 200)}`;
}
