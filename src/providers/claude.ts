import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getConfig } from "../config.js";
import { getSessionsFile } from "../paths.js";
import type { Provider, RunOptions, RunResult, RunHandle } from "./base.js";

const MAX_RETRIES = 2;
const CRASH_EXIT_CODE = 3221225794; // Windows access violation

// Session ID cache: workingDir -> last Claude session ID (file-backed)
const sessionCache = new Map<string, string>();

function loadSessionCache(): void {
  try {
    const data = JSON.parse(readFileSync(getSessionsFile(), "utf-8"));
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === "string") sessionCache.set(k, v);
    }
  } catch {
    // 파일 없거나 파싱 실패 — 빈 캐시로 시작
  }
}

function persistSessionCache(): void {
  try {
    const obj = Object.fromEntries(sessionCache);
    writeFileSync(getSessionsFile(), JSON.stringify(obj, null, 2));
  } catch (err) {
    console.warn("[Claude] Failed to persist session cache:", err);
  }
}

// 부팅 시 파일에서 복원
loadSessionCache();

// Idle timeout: kill process if no new message for this duration (ms)
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

export class ClaudeProvider implements Provider {
  readonly name = "claude";

  run(options: RunOptions): RunHandle {
    let cancelled = false;
    let cancelFn = (): void => { cancelled = true; };

    const promise = (async (): Promise<RunResult> => {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (cancelled) return { output: "", error: "Cancelled", timedOut: false };
        const handle = this.runOnce(options);
        cancelFn = handle.cancel;
        const result = await handle.promise;
        if (!result.error?.includes(`exit_code_${CRASH_EXIT_CODE}`)) {
          return result;
        }
        console.log(`[Claude] Crash detected (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying...`);
      }
      return { output: "", error: `Crashed after ${MAX_RETRIES + 1} attempts`, timedOut: false };
    })();

    return { promise, cancel: () => cancelFn() };
  }

  private runOnce(options: RunOptions): RunHandle {
    const { prompt, promptId, workingDir, model, timeoutMs } = options;
    const config = getConfig();
    const runner = config.runner ?? config.claude;
    const timeout = timeoutMs ?? runner.timeoutMs;
    const raw = workingDir ?? runner.workingDir;
    const cwd = raw.startsWith("~") ? raw.replace(/^~/, process.env.HOME ?? "") : raw;

    const isRoot = process.getuid?.() === 0;

    // Build args: use -p with --resume for session continuity
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];

    // Resume previous session if exists for this workingDir
    const sessionKey = cwd;
    const prevSessionId = sessionCache.get(sessionKey);
    if (prevSessionId) {
      args.push("--resume", prevSessionId);
      console.log(`[Claude] Resuming session ${prevSessionId.slice(0, 12)}... for ${sessionKey}`);
    }

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
    const disallowed = runner.disallowedTools;
    if (disallowed.length > 0) {
      args.push("--disallowedTools", ...disallowed);
    }
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const proc = spawn("claude", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    const tag = `[Claude:${promptId.slice(0, 8)}]`;

    let logStream: ReturnType<typeof createWriteStream> | undefined;
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
    const toolsUsed: string[] = [];

    // Reset idle timer for this workingDir
    const existingTimer = idleTimers.get(sessionKey);
    if (existingTimer) clearTimeout(existingTimer);

    proc.stdout?.on("data", (chunk: Buffer) => {
      lineBuf += chunk.toString();
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          // Extract and cache session ID for future --resume
          if (event.session_id) {
            sessionCache.set(sessionKey, event.session_id);
            persistSessionCache();
          }

          switch (event.type) {
            case "assistant":
              if (event.message?.content) {
                for (const block of event.message.content) {
                  if (block.type === "text" && block.text) {
                    resultText += block.text;
                    logWrite(`${tag} ${block.text}\n`);
                  }
                  if (block.type === "tool_use" && block.name) {
                    logWrite(`${tag} [tool: ${block.name}]\n`);
                    if (!toolsUsed.includes(block.name)) {
                      toolsUsed.push(block.name);
                    }
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
              if (event.type === "tool_use" || event.type === "content_block_start") {
                const toolName = event.tool_name ?? event.content_block?.tool_name ?? "";
                if (toolName) {
                  logWrite(`${tag} [tool: ${toolName}]\n`);
                  if (!toolsUsed.includes(toolName)) {
                    toolsUsed.push(toolName);
                  }
                }
              }
              break;
          }
        } catch {
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

    const promise = new Promise<RunResult>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        resolve({ output: resultText, error: "Timed out", timedOut: true });
      }, timeout);

      proc.on("close", (code) => {
        clearTimeout(timer);
        logStream?.end();

        if (lineBuf.trim()) {
          try {
            const event = JSON.parse(lineBuf);
            if (event.result) resultText = event.result;
            if (event.session_id) {
              sessionCache.set(sessionKey, event.session_id);
              persistSessionCache();
            }
          } catch {
            resultText += lineBuf;
          }
        }

        // Set idle timer — clear session cache after prolonged inactivity
        idleTimers.set(sessionKey, setTimeout(() => {
          console.log(`[Claude] Session idle timeout for ${sessionKey}, clearing cache`);
          sessionCache.delete(sessionKey);
          persistSessionCache();
          idleTimers.delete(sessionKey);
        }, SESSION_IDLE_TIMEOUT_MS));

        if (code === 0) {
          resolve({ output: resultText.trim(), timedOut: false, toolsUsed });
        } else {
          const error = classifyError(stderr, code);
          // If session expired or invalid, clear cache and retry without --resume
          if (prevSessionId && (error.includes("session") || error.includes("resume"))) {
            console.log(`[Claude] Session ${prevSessionId.slice(0, 12)} expired, clearing`);
            sessionCache.delete(sessionKey);
            persistSessionCache();
          }
          resolve({ output: resultText.trim(), error, timedOut: false, toolsUsed });
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        logStream?.end();
        resolve({ output: "", error: `Spawn error: ${err.message}`, timedOut: false });
      });
    });

    return {
      promise,
      cancel: () => { proc.kill("SIGTERM"); },
    };
  }
}

// Expose session cache for external inspection (dashboard, etc.)
export function getSessionCache(): ReadonlyMap<string, string> {
  return sessionCache;
}

export function clearSession(workingDir: string): boolean {
  const key = workingDir.startsWith("~")
    ? workingDir.replace(/^~/, process.env.HOME ?? "")
    : workingDir;
  const deleted = sessionCache.delete(key);
  if (deleted) persistSessionCache();
  return deleted;
}

function classifyError(stderr: string, code: number | null): string {
  const lower = stderr.toLowerCase();
  if (lower.includes("auth") || lower.includes("unauthorized")) return "auth_error";
  if (lower.includes("rate") || lower.includes("throttl")) return "rate_limit";
  if (lower.includes("timeout")) return "timeout";
  return `exit_code_${code ?? "unknown"}: ${stderr.slice(0, 200)}`;
}
