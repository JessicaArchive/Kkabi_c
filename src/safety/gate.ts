import { getConfig } from "../config.js";
import type { Channel } from "../channels/base.js";

export interface SafetyCheckResult {
  safe: boolean;
  matchedKeywords: string[];
}

export function checkSafety(text: string): SafetyCheckResult {
  const config = getConfig();
  if (!config.safety.enabled) {
    return { safe: true, matchedKeywords: [] };
  }

  const lower = text.toLowerCase();
  const matchedKeywords = config.safety.keywords.filter((kw) =>
    lower.includes(kw.toLowerCase()),
  );

  return {
    safe: matchedKeywords.length === 0,
    matchedKeywords,
  };
}

export async function requestApproval(
  channel: Channel,
  chatId: string,
  text: string,
  matchedKeywords: string[],
  threadId?: string,
): Promise<boolean> {
  const config = getConfig();
  const timeoutMs = config.safety.confirmTimeoutMs;

  const warningText =
    `⚠️ 위험 감지: [${matchedKeywords.join(", ")}]\n` +
    `요청: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"\n\n` +
    `실행하시겠습니까?`;

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);

    channel
      .sendConfirm(chatId, warningText, threadId)
      .then((approved) => {
        clearTimeout(timer);
        resolve(approved);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(false);
      });
  });
}
