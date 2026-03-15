import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getConfig } from "../config.js";
import type { Provider, RunOptions, RunResult, RunHandle } from "./base.js";

export class CodexProvider implements Provider {
  readonly name = "codex";

  run(options: RunOptions): RunHandle {
    const { prompt, promptId, workingDir, model, timeoutMs } = options;
    const config = getConfig();
    const runner = config.runner ?? config.claude;
    const timeout = timeoutMs ?? runner.timeoutMs;
    const raw = workingDir ?? runner.workingDir;
    const cwd = raw.startsWith("~") ? raw.replace(/^~/, process.env.HOME ?? "") : raw;

    const args = ["exec", prompt, "--json", "-s", "read-only", "--skip-git-repo-check"];
    if (model) args.push("-m", model);

    const proc = spawn("codex", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    const tag = `[Codex:${promptId.slice(0, 8)}]`;

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

    proc.stdout?.on("data", (chunk: Buffer) => {
      lineBuf += chunk.toString();
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          // Codex CLI --json emits item.completed events with item.type = "agent_message"
          if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
            resultText += event.item.text;
            logWrite(`${tag} ${event.item.text}\n`);
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
            if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
              resultText += event.item.text;
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
