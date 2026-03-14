import type { CommandResult } from "../types.js";

/**
 * 직원봇별 확장 명령 인터페이스.
 * 각 프로젝트는 이 인터페이스를 구현해서 전용 명령을 제공한다.
 */
export interface ProjectCommands {
  /** 이 프로젝트가 지원하는 명령어 목록 */
  commands(): string[];

  /** 명령어 실행 */
  execute(cmd: string, args: string): Promise<CommandResult>;

  /** 도움말 텍스트 */
  helpText(): string;
}
