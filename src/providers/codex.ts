import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import type { Provider, RunOptions, RunResult } from "./base.js";

export class CodexProvider implements Provider {
  readonly name = "codex";
  private currentProcess: ChildProcess | null = null;
  private currentPromptId: string | null = null;

  isRunning(): boolean {
    return this.currentProcess !== null;
  }

  getCurrentPromptId(): string | null {
    return this.currentPromptId;
  }

  cancel(): boolean {
    if (this.currentProcess) {
      this.currentProcess.kill("SIGTERM");
      this.currentProcess = null;
      this.currentPromptId = null;
      return true;
    }
    return false;
  }

  async run(options: RunOptions): Promise<RunResult> {
    const { prompt, promptId, workingDir, model, timeoutMs } = options;
    const timeout = timeoutMs ?? 300_000;
    const cwd = workingDir?.startsWith("~")
      ? workingDir.replace(/^~/, process.env.HOME ?? "")
      : (workingDir ?? process.env.HOME ?? process.cwd());

    return new Promise<RunResult>((resolve) => {
      const args = ["exec", prompt, "--json", "-s", "read-only"];
      if (model) args.push("-m", model);

      const proc = spawn("codex", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });

      this.currentProcess = proc;
      this.currentPromptId = promptId;

      const tag = `[Codex:${promptId.slice(0, 8)}]`;

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
            // Codex JSONL: message events with assistant role
            if (event.type === "message" && event.role === "assistant") {
              for (const part of event.content ?? []) {
                if (part.type === "output_text" && part.text) {
                  resultText += part.text;
                  logWrite(`${tag} ${part.text}\n`);
                }
              }
            }
            // Also handle direct text output
            if (event.type === "output_text" && event.text) {
              resultText += event.text;
              logWrite(`${tag} ${event.text}\n`);
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

      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        this.currentProcess = null;
        this.currentPromptId = null;
        resolve({ output: resultText, error: "Timed out", timedOut: true });
      }, timeout);

      proc.on("close", (code) => {
        clearTimeout(timer);
        this.currentProcess = null;
        this.currentPromptId = null;
        logStream?.end();

        // Process remaining buffer
        if (lineBuf.trim()) {
          try {
            const event = JSON.parse(lineBuf);
            if (event.type === "message" && event.role === "assistant") {
              for (const part of event.content ?? []) {
                if (part.type === "output_text" && part.text) {
                  resultText += part.text;
                }
              }
            }
          } catch {
            resultText += lineBuf;
          }
        }

        if (code === 0) {
          resolve({ output: resultText.trim(), timedOut: false });
        } else {
          resolve({
            output: resultText.trim(),
            error: `codex exit ${code}: ${stderr.slice(0, 200)}`,
            timedOut: false,
          });
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        this.currentProcess = null;
        this.currentPromptId = null;
        logStream?.end();
        resolve({ output: "", error: `Spawn error: ${err.message}`, timedOut: false });
      });
    });
  }
}
