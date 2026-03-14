import type { ProjectCommands } from "./base.js";
import type { CommandResult } from "../types.js";
import { TradingCommands } from "./trading.js";

/**
 * projectType 기반으로 프로젝트 전용 명령어 세트를 결정한다.
 * 새 프로젝트 추가 시 여기에 매핑만 추가하면 된다.
 */

let activeCommands: ProjectCommands | null = null;

const PROJECT_MAP: Record<string, (dir: string) => ProjectCommands> = {
  trading: (dir) => new TradingCommands(dir),
};

export function initProjectCommands(
  workingDir: string,
  projectType?: string,
): void {
  if (projectType && PROJECT_MAP[projectType]) {
    activeCommands = PROJECT_MAP[projectType](workingDir);
  } else {
    activeCommands = null;
  }
}

export function getProjectCommands(): ProjectCommands | null {
  return activeCommands;
}

export function isProjectCommand(cmd: string): boolean {
  return activeCommands?.commands().includes(cmd) ?? false;
}

export async function executeProjectCommand(
  cmd: string,
  args: string,
): Promise<CommandResult> {
  if (!activeCommands) {
    return { text: `Unknown command: ${cmd}` };
  }
  return activeCommands.execute(cmd, args);
}

export function getProjectHelpText(): string {
  return activeCommands?.helpText() ?? "";
}
