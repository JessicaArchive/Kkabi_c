import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { CommandResult, ChannelType } from "../types.js";
import { getRecentConversation, getRecentExecutions } from "../db/store.js";
import { readMemory, appendMemory, clearMemory } from "../memory/manager.js";
import { loadPersona, updateSoul, updateUser, updateMood } from "../memory/persona.js";
import { cancelCurrent, isRunning, getCurrentPromptId } from "../claude/runner.js";
import { getQueueLength, getQueueItems } from "../claude/queue.js";
import { addCron, removeCron, listCrons, toggleCron } from "../scheduler/cron.js";

let workingDir = process.env.HOME ?? process.cwd();

export function getWorkingDir(): string {
  return workingDir;
}

export function isCommand(text: string): boolean {
  return text.startsWith("!");
}

export async function executeCommand(
  text: string,
  chatId: string,
  channel: ChannelType,
): Promise<CommandResult> {
  const trimmed = text.slice(1).trim();
  const spaceIdx = trimmed.indexOf(" ");
  const cmd = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  switch (cmd.toLowerCase()) {
    case "cd":
      return cmdCd(args);
    case "pwd":
      return { text: `📁 ${workingDir}` };
    case "status":
      return cmdStatus();
    case "history":
      return cmdHistory(chatId, args);
    case "memory":
      return cmdMemory(args);
    case "forget":
      return cmdForget();
    case "system":
      return { text: formatSystemInfo() };
    case "persona":
      return cmdPersona(args);
    case "cancel":
      return cmdCancel();
    case "running":
      return cmdRunning();
    case "cron":
      return cmdCron(args, chatId, channel);
    case "help":
      return { text: HELP_TEXT };
    default:
      return { text: `❓ 알 수 없는 명령어: ${cmd}\n!help 로 도움말 확인` };
  }
}

function cmdCd(args: string): CommandResult {
  if (!args) return { text: "사용법: !cd <경로>" };
  const target = args.replace("~", process.env.HOME ?? "");
  const resolved = resolve(workingDir, target);
  if (!existsSync(resolved)) {
    return { text: `❌ 경로 없음: ${resolved}` };
  }
  workingDir = resolved;
  return { text: `📁 → ${workingDir}` };
}

function cmdStatus(): CommandResult {
  const running = isRunning();
  const queueLen = getQueueLength();
  const lines = [
    `🤖 상태: ${running ? "실행 중" : "대기"}`,
    `📋 큐: ${queueLen}개`,
    `📁 작업 디렉토리: ${workingDir}`,
  ];
  return { text: lines.join("\n") };
}

function cmdHistory(chatId: string, args: string): CommandResult {
  const limit = parseInt(args) || 10;
  const rows = getRecentConversation(chatId, limit);
  if (rows.length === 0) return { text: "대화 기록이 없습니다." };
  const lines = rows.map(
    (r) => `[${new Date(r.timestamp).toLocaleTimeString("ko-KR")}] ${r.role}: ${r.content.slice(0, 100)}`,
  );
  return { text: lines.join("\n") };
}

function cmdMemory(args: string): CommandResult {
  if (!args) {
    const mem = readMemory();
    return { text: mem || "(비어있음)" };
  }
  appendMemory(args);
  return { text: `✅ 메모리 추가: ${args}` };
}

function cmdForget(): CommandResult {
  clearMemory();
  return { text: "🗑️ 메모리 초기화 완료" };
}

function cmdPersona(args: string): CommandResult {
  if (!args) {
    const p = loadPersona();
    return {
      text: `[SOUL]\n${p.soul}\n\n[USER]\n${p.user}\n\n[MOOD]\n${p.mood}`,
    };
  }
  const [section, ...rest] = args.split(" ");
  const content = rest.join(" ");
  if (!content) return { text: "사용법: !persona <soul|user|mood> <내용>" };

  switch (section.toLowerCase()) {
    case "soul":
      updateSoul(content);
      return { text: "✅ SOUL 업데이트 완료" };
    case "user":
      updateUser(content);
      return { text: "✅ USER 업데이트 완료" };
    case "mood":
      updateMood(content);
      return { text: "✅ MOOD 업데이트 완료" };
    default:
      return { text: "사용법: !persona <soul|user|mood> <내용>" };
  }
}

function cmdCancel(): CommandResult {
  if (cancelCurrent()) {
    return { text: "🛑 실행 중인 작업을 취소했습니다." };
  }
  return { text: "실행 중인 작업이 없습니다." };
}

function cmdRunning(): CommandResult {
  const running = isRunning();
  const promptId = getCurrentPromptId();
  const queueItems = getQueueItems();

  if (!running && queueItems.length === 0) {
    return { text: "실행 중인 작업이 없습니다." };
  }

  const lines: string[] = [];
  if (running) {
    lines.push(`▶️ 실행 중: ${promptId}`);
  }
  if (queueItems.length > 0) {
    lines.push(`📋 대기열 (${queueItems.length}개):`);
    queueItems.forEach((item, i) => {
      lines.push(`  ${i + 1}. ${item.prompt.slice(0, 50)}...`);
    });
  }
  return { text: lines.join("\n") };
}

function cmdCron(args: string, chatId: string, channel: ChannelType): CommandResult {
  if (!args) {
    const crons = listCrons();
    if (crons.length === 0) return { text: "등록된 크론잡이 없습니다." };
    const lines = crons.map(
      (c) =>
        `${c.enabled ? "✅" : "⏸️"} [${c.id.slice(0, 8)}] ${c.schedule} → ${c.prompt.slice(0, 40)}`,
    );
    return { text: lines.join("\n") };
  }

  const parts = args.split(" ");
  const sub = parts[0];

  switch (sub) {
    case "add": {
      const match = args.match(/add\s+"([^"]+)"\s+"([^"]+)"/);
      if (!match) return { text: '사용법: !cron add "<스케줄>" "<프롬프트>"' };
      const job = addCron(match[1], match[2], channel, chatId);
      return { text: `✅ 크론잡 등록: ${job.id.slice(0, 8)} (${match[1]})` };
    }
    case "remove": {
      const id = parts[1];
      if (!id) return { text: "사용법: !cron remove <id>" };
      return removeCron(id)
        ? { text: `🗑️ 크론잡 삭제: ${id}` }
        : { text: `❌ 찾을 수 없음: ${id}` };
    }
    case "toggle": {
      const id = parts[1];
      if (!id) return { text: "사용법: !cron toggle <id>" };
      const toggled = toggleCron(id);
      return toggled
        ? { text: `${toggled.enabled ? "✅" : "⏸️"} 크론잡 ${toggled.enabled ? "활성화" : "비활성화"}: ${id}` }
        : { text: `❌ 찾을 수 없음: ${id}` };
    }
    default:
      return { text: '사용법: !cron <add|remove|toggle|list>\n!cron add "<스케줄>" "<프롬프트>"' };
  }
}

function formatSystemInfo(): string {
  const execs = getRecentExecutions(5);
  const lines = [
    "📊 시스템 정보",
    `  작업 디렉토리: ${workingDir}`,
    `  큐: ${getQueueLength()}개`,
    "",
    "최근 실행:",
  ];
  for (const e of execs) {
    lines.push(
      `  [${new Date(e.timestamp).toLocaleTimeString("ko-KR")}] ${e.status} (${e.durationMs}ms)`,
    );
  }
  return lines.join("\n");
}

const HELP_TEXT = `📖 까비 명령어

!cd <경로>          작업 디렉토리 변경
!pwd               현재 작업 디렉토리
!status            상태 확인
!history [N]       대화 기록 (기본 10개)
!memory [내용]      메모리 보기/추가
!forget            메모리 초기화
!system            시스템 정보
!persona [section]  페르소나 보기/수정
!cancel            실행 중 작업 취소
!running           실행 중/대기 작업 보기
!cron              크론잡 관리
!help              이 도움말`;
