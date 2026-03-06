import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
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

export interface RunClaudeOptions {
  prompt: string;
  promptId: string;
  workingDir?: string;
  model?: string;
  timeoutMs?: number;
  logFile?: string;
}

const MAX_RETRIES = 2;
const CRASH_EXIT_CODE = 3221225794; // Windows access violation

export async function runClaude(options: RunClaudeOptions): Promise<ClaudeResult> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await runClaudeOnce(options);
    if (!result.error?.includes(`exit_code_${CRASH_EXIT_CODE}`)) {
      return result;
    }
    console.log(`[Claude] Crash detected (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying...`);
  }
  return { output: "", error: `Crashed after ${MAX_RETRIES + 1} attempts`, timedOut: false };
}

async function runClaudeOnce(options: RunClaudeOptions): Promise<ClaudeResult> {
  const { prompt, promptId, workingDir, model, timeoutMs } = options;
  const config = getConfig();
  const timeout = timeoutMs ?? config.claude.timeoutMs;
  const raw = workingDir ?? config.claude.workingDir;
  const cwd = raw.startsWith("~") ? raw.replace(/^~/, process.env.HOME ?? "") : raw;

  const isRoot = process.getuid?.() === 0;

  return new Promise<ClaudeResult>((resolve) => {
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
    if (isRoot) {
      args.push(
        "--allowedTools",
        "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Agent,NotebookEdit,TodoWrite,TodoRead",
      );
    } else {
      args.push("--dangerously-skip-permissions");
    }
    if (model) {
      args.push("--model", model);
    }
    const disallowed = config.claude.disallowedTools;
    if (disallowed.length > 0) {
      args.push("--disallowedTools", ...disallowed);
    }
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const proc = spawn("claude", args, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    currentProcess = proc;
    currentPromptId = promptId;

    const tag = `[Claude:${promptId.slice(0, 8)}]`;

    let logStream: WriteStream | undefined;
    if (options.logFile) {
      mkdirSync(dirname(options.logFile), { recursive: true });
      logStream = createWriteStream(options.logFile, { flags: "w" });
    }
    const logWrite = (text: string): void => {
      process.stdout.write(text);
      logStream?.write(text);
    };

    let resultText = "";
    let stderr = "";
    let lineBuf = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      lineBuf += chunk.toString();
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          switch (event.type) {
            case "assistant":
              if (event.message?.content) {
                for (const block of event.message.content) {
                  if (block.type === "text" && block.text) {
                    resultText += block.text;
                    logWrite(`${tag} ${block.text}\n`);
                  }
                }
              }
              break;
            case "content_block_delta":
              if (event.delta?.type === "text_delta" && event.delta.text) {
                resultText += event.delta.text;
                logWrite(event.delta.text);
              }
              break;
            case "result":
              if (event.result) {
                resultText = event.result;
                logWrite(`${tag} [result received]\n`);
              }
              break;
            default:
              // Log tool use and other events briefly
              if (event.type === "tool_use" || event.type === "content_block_start") {
                const toolName = event.tool_name ?? event.content_block?.tool_name ?? "";
                if (toolName) {
                  logWrite(`${tag} [tool: ${toolName}]\n`);
                }
              }
              break;
          }
        } catch {
          // Non-JSON line, just log it
          logWrite(`${tag} ${line}\n`);
          resultText += line;
        }
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(`${tag} ${text}`);
      logStream?.write(`${tag} [stderr] ${text}`);
    });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      currentProcess = null;
      currentPromptId = null;
      resolve({ output: resultText, error: "Timed out", timedOut: true });
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timer);
      currentProcess = null;
      currentPromptId = null;
      logStream?.end();

      // Process remaining buffer
      if (lineBuf.trim()) {
        try {
          const event = JSON.parse(lineBuf);
          if (event.result) resultText = event.result;
        } catch {
          resultText += lineBuf;
        }
      }

      if (code === 0) {
        resolve({ output: resultText.trim(), timedOut: false });
      } else {
        const error = classifyError(stderr, code);
        resolve({ output: resultText.trim(), error, timedOut: false });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      currentProcess = null;
      currentPromptId = null;
      logStream?.end();
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
