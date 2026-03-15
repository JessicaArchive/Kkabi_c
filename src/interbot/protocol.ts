export type BotMsgType = "review_request" | "review_response" | "review_reply";

export interface BotMsgHeader {
  from: string;       // canonical bot username (e.g. "kkabi_trading_bot")
  type: BotMsgType;
  reqId: string;       // e.g. "rev_kkabi_trading_bot_1710504600000"
}

export interface BotMsg {
  header: BotMsgHeader;
  body: Record<string, unknown>;
}

const HEADER_RE = /^\[BOT_MSG:from=([^,]+),type=([^,]+),reqId=([^\]]+)\]$/;

const VALID_TYPES = new Set<string>(["review_request", "review_response", "review_reply"]);

export function parseBotMsg(text: string): BotMsg | null {
  const newlineIdx = text.indexOf("\n");
  if (newlineIdx === -1) return null;

  const headerLine = text.slice(0, newlineIdx);
  const headerMatch = headerLine.match(HEADER_RE);
  if (!headerMatch) return null;

  const [, from, type, reqId] = headerMatch;
  if (!VALID_TYPES.has(type)) return null;

  try {
    const body = JSON.parse(text.slice(newlineIdx + 1));
    return { header: { from, type: type as BotMsgType, reqId }, body };
  } catch {
    return null;
  }
}

export function buildBotMsg(header: BotMsgHeader, body: Record<string, unknown>): string {
  const headerLine = `[BOT_MSG:from=${header.from},type=${header.type},reqId=${header.reqId}]`;
  return `${headerLine}\n${JSON.stringify(body)}`;
}

export function generateReqId(botUsername: string): string {
  return `rev_${botUsername}_${Date.now()}`;
}
