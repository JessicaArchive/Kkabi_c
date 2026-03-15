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

// reqId별 라운드 카운트 추적
const roundCounts = new Map<string, number>();
const MAX_ROUNDS = 3;

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

  // "to" 필드가 있으면 대상 확인
  // "to" can be a provider type ("codex") or a specific bot username
  if (botMsg.header.to) {
    const to = botMsg.header.to;
    const isForMe = to === config.myBotUsername || to === config.myProvider;
    if (!isForMe) {
      return { action: "ignore", reason: `addressed to ${to}, not me (${config.myBotUsername}/${config.myProvider})` };
    }
  }

  // 메시지 타입 필터링
  // Codex는 review_request, review_reply만 처리
  if (config.myProvider === "codex") {
    if (botMsg.header.type !== "review_request" && botMsg.header.type !== "review_reply") {
      return { action: "ignore", reason: `codex ignores ${botMsg.header.type}` };
    }
  }

  // Claude는 review_response만 처리
  if (config.myProvider === "claude") {
    if (botMsg.header.type !== "review_response") {
      return { action: "ignore", reason: `claude ignores ${botMsg.header.type}` };
    }
  }

  // 라운드 제한 체크
  const count = roundCounts.get(botMsg.header.reqId) ?? 0;
  if (count >= MAX_ROUNDS) {
    return { action: "ignore", reason: `max rounds (${MAX_ROUNDS}) reached for ${botMsg.header.reqId}` };
  }

  // 라운드 카운트 증가
  roundCounts.set(botMsg.header.reqId, count + 1);

  return { action: "process_review", botMsg };
}

export function resetRoundCount(reqId: string): void {
  roundCounts.delete(reqId);
}
