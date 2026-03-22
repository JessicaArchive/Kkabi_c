import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CommitSuggestion } from "./commitParser.js";
import type { Channel } from "../channels/base.js";
import { getConfig } from "../config.js";

const execFileAsync = promisify(execFile);

async function run(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(cmd, args, { cwd, timeout: 30_000 });
}

interface ExecResult {
  success: boolean;
  message: string;
  prNumber?: number;
  prUrl?: string;
}

export async function executeCommitSuggestion(
  suggestion: CommitSuggestion,
  channel: Channel,
  chatId: string,
  threadId?: string,
): Promise<void> {
  const config = getConfig();
  const runner = config.runner ?? config.claude;
  const cwd = runner.workingDir;

  const result = await doCommitAndPR(suggestion.message, cwd);
  await channel.sendText(chatId, result.message, threadId);
}

async function doCommitAndPR(
  message: string,
  cwd: string,
): Promise<ExecResult> {
  try {
    // 변경사항 확인
    const { stdout: status } = await run("git", ["status", "--porcelain"], cwd);
    if (!status.trim()) {
      return { success: false, message: "커밋할 변경사항이 없어." };
    }

    // 현재 브랜치 확인
    const { stdout: branchOut } = await run(
      "git",
      ["branch", "--show-current"],
      cwd,
    );
    const currentBranch = branchOut.trim();

    if (currentBranch === "main" || currentBranch === "master") {
      return {
        success: false,
        message: "main 브랜치에서는 직접 커밋할 수 없어.",
      };
    }

    // git add + commit
    await run("git", ["add", "-A"], cwd);
    await run("git", ["commit", "-m", message], cwd);

    // push
    await run("git", ["push", "-u", "origin", currentBranch], cwd);

    // PR 생성
    try {
      const { stdout: prOut } = await run(
        "gh",
        ["pr", "create", "--title", message, "--body", `${message}`, "--fill"],
        cwd,
      );
      const prUrl = prOut.trim();
      const prMatch = prUrl.match(/\/pull\/(\d+)/);
      const prNumber = prMatch ? parseInt(prMatch[1], 10) : undefined;

      return {
        success: true,
        message: `✅ 커밋 + PR 생성 완료\n${prUrl}`,
        prNumber,
        prUrl,
      };
    } catch (prErr: any) {
      // PR이 이미 존재하는 경우
      if (prErr.stderr?.includes("already exists")) {
        const { stdout: existingPr } = await run(
          "gh",
          ["pr", "view", "--json", "number,url"],
          cwd,
        );
        const prInfo = JSON.parse(existingPr);
        return {
          success: true,
          message: `✅ 커밋 완료 + 기존 PR에 push됨\n${prInfo.url}`,
          prNumber: prInfo.number,
          prUrl: prInfo.url,
        };
      }
      return {
        success: false,
        message: `커밋은 했는데 PR 생성 실패: ${prErr.message}`,
      };
    }
  } catch (err: any) {
    return { success: false, message: `git 실패: ${err.message}` };
  }
}

