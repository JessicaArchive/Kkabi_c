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
  const isAscii = (s: string): boolean => /^[\x00-\x7F]+$/.test(s);
  const matchedKeywords = config.safety.keywords.filter((kw) => {
    const kwLower = kw.toLowerCase();
    if (isAscii(kwLower)) {
      // ASCII: \b 단어 경계로 부분 문자열 방지 ("format" 안의 "rm" 무시)
      const pattern = new RegExp(`\\b${kwLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      return pattern.test(lower);
    }
    // 비ASCII (한국어 등): includes로 매칭 ("삭제 해줘"에서 "삭제" 감지)
    return lower.includes(kwLower);
  });

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
    `Warning — risky keywords detected: [${matchedKeywords.join(", ")}]\n` +
    `Request: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"\n\n` +
    `Do you want to proceed?`;

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
