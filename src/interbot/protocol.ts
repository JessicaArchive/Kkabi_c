export type BotMsgType = "review_request" | "review_response" | "review_reply";

export interface BotMsgHeader {
  from: string;       // canonical bot username (e.g. "kkabi_trading_bot")
  to?: string;        // target bot provider type (e.g. "codex") or username
  type: BotMsgType;
  reqId: string;       // e.g. "rev_kkabi_trading_bot_1710504600000"
}

export interface BotMsg {
  header: BotMsgHeader;
  body: Record<string, unknown>;
}

// Header format: [BOT_MSG:from=X,to=Y,type=Z,reqId=W]
// "to" is optional for backwards compat
const HEADER_WITH_TO_RE = /^\[BOT_MSG:from=([^,]+),to=([^,]+),type=([^,]+),reqId=([^\]]+)\]$/;
const HEADER_NO_TO_RE = /^\[BOT_MSG:from=([^,]+),type=([^,]+),reqId=([^\]]+)\]$/;

const VALID_TYPES = new Set<string>(["review_request", "review_response", "review_reply"]);

export function parseBotMsg(text: string): BotMsg | null {
  const newlineIdx = text.indexOf("\n");
  if (newlineIdx === -1) return null;

  const headerLine = text.slice(0, newlineIdx);

  // Try with "to" first
  let from: string, to: string | undefined, type: string, reqId: string;
  const matchTo = headerLine.match(HEADER_WITH_TO_RE);
  if (matchTo) {
    [, from, to, type, reqId] = matchTo;
  } else {
    const matchNoTo = headerLine.match(HEADER_NO_TO_RE);
    if (!matchNoTo) return null;
    [, from, type, reqId] = matchNoTo;
    to = undefined;
  }

  if (!VALID_TYPES.has(type)) return null;

  try {
    const body = JSON.parse(text.slice(newlineIdx + 1));
    return { header: { from, to, type: type as BotMsgType, reqId }, body };
  } catch {
    return null;
  }
}

export function buildBotMsg(header: BotMsgHeader, body: Record<string, unknown>): string {
  const toPart = header.to ? `,to=${header.to}` : "";
  const headerLine = `[BOT_MSG:from=${header.from}${toPart},type=${header.type},reqId=${header.reqId}]`;
  return `${headerLine}\n${JSON.stringify(body)}`;
}

export function generateReqId(botUsername: string): string {
  return `rev_${botUsername}_${Date.now()}`;
}
