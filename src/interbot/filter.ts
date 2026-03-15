import { parseBotMsg, type BotMsg } from "./protocol.js";

export interface FilterConfig {
  myBotUsername: string;
  myProvider: "claude" | "codex";
}

export interface FilterResult {
  action: "process" | "process_review" | "ignore";
  botMsg?: BotMsg;
  reason?: string;
}

/**
 * BOT_MSG 감지 및 필터링.
 * 일반 메시지 → "process", BOT_MSG → "process_review" 또는 "ignore".
 * Codex 리뷰는 내부 enqueue로 처리되므로, handler에서 process_review도 무시함.
 */
export function filterIncoming(text: string, config: FilterConfig): FilterResult {
  const botMsg = parseBotMsg(text);

  // 일반 메시지 (BOT_MSG 아님) → 기존 로직대로 처리
  if (!botMsg) {
    return { action: "process" };
  }

  // 자기 메시지 무시
  if (botMsg.header.from === config.myBotUsername) {
    return { action: "ignore", reason: "own message" };
  }

  // BOT_MSG는 모두 process_review로 반환 (handler에서 무시됨)
  return { action: "process_review", botMsg };
}
