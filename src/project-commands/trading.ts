import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CommandResult } from "../types.js";
import type { ProjectCommands } from "./base.js";

const execFileAsync = promisify(execFile);

/**
 * kkabi-trading 전용 명령어.
 * Python 스크립트를 subprocess로 호출해서 결과를 반환한다.
 */
export class TradingCommands implements ProjectCommands {
  constructor(private projectDir: string) {}

  commands(): string[] {
    return ["config", "price", "analyze", "backtest"];
  }

  async execute(cmd: string, args: string): Promise<CommandResult> {
    switch (cmd) {
      case "config":
        return this.runPython("show_config");
      case "price":
        return this.runPython("show_price", args);
      case "analyze":
        return this.runPython("analyze", args);
      case "backtest":
        return this.runPython("backtest", args);
      default:
        return { text: `Unknown trading command: ${cmd}` };
    }
  }

  helpText(): string {
    return [
      "",
      "Trading Commands:",
      "  /config        현재 트레이딩 설정",
      "  /price [심볼]  현재 가격 조회",
      "  /analyze       전략 분석",
      "  /backtest      30일 백테스트",
    ].join("\n");
  }

  private async runPython(
    action: string,
    args?: string,
  ): Promise<CommandResult> {
    const scriptArgs = ["-m", "cli", action];
    if (args) scriptArgs.push(args);

    try {
      const { stdout, stderr } = await execFileAsync("python3", scriptArgs, {
        cwd: this.projectDir,
        timeout: 120_000,
      });

      if (stderr && !stdout) {
        return { text: `⚠️ ${stderr.slice(0, 1000)}` };
      }
      return { text: stdout.trim() || "(결과 없음)" };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);

      if (msg.includes("TIMEOUT")) {
        return { text: "⏰ 실행 시간 초과 (2분)" };
      }
      if (msg.includes("ENOENT")) {
        return { text: "❌ python3을 찾을 수 없음" };
      }
      return { text: `❌ 실행 실패: ${msg.slice(0, 500)}` };
    }
  }
}
