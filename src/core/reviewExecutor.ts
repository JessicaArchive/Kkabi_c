import type { Channel } from "../channels/base.js";
import type { ReviewRequest } from "./reviewParser.js";
import { generateReqId } from "../interbot/protocol.js";
import { validateSenderWorkingDir } from "../interbot/registry.js";
import { appendGroupChatLog } from "../interbot/log.js";
import { getConfig } from "../config.js";
import { enqueue } from "../claude/queue.js";

const TG_MAX_LEN = 4096;

/** Send a message via Telegram Bot API using a specific bot token (with 4096 char splitting) */
async function sendAsBotToken(token: string, chatId: string, text: string): Promise<void> {
  const chunks = text.length <= TG_MAX_LEN
    ? [text]
    : splitForTelegram(text, TG_MAX_LEN);

  for (const chunk of chunks) {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Telegram API ${res.status}: ${body}`);
    }
  }
}

function splitForTelegram(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf("\n", maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, "");
  }
  return chunks;
}

export interface ReviewExecutionResult {
  success: boolean;
  message: string;
  reqId?: string;
}

/**
 * Build a review prompt directly from a ReviewRequest.
 * Codex will receive this prompt and review the code in workingDir.
 */
function buildReviewPrompt(req: ReviewRequest, reqId: string, fromBot: string): string {
  const parts: string[] = [];
  parts.push(`[CODE REVIEW REQUEST from ${fromBot}]`);
  parts.push(`Request ID: ${reqId}`);
  parts.push(`Working directory: ${req.workingDir}`);
  if (req.branch) parts.push(`Branch: ${req.branch}`);
  if (req.files?.length) parts.push(`Files changed: ${req.files.join(", ")}`);
  parts.push(`Summary: ${req.summary}`);
  parts.push("");
  parts.push("위 변경사항을 리뷰해주세요. working directory의 실제 파일과 git diff를 확인하세요.");
  parts.push("중점: 버그, 엣지케이스, 보안, 성능 문제.");
  parts.push("한국어로 간결하게 작성하세요.");
  return parts.join("\n");
}

export async function executeReviewRequests(
  requests: ReviewRequest[],
  channel: Channel,
  botUsername: string,
): Promise<ReviewExecutionResult[]> {
  const config = getConfig();
  const groupChatId = config.interbot?.groupChatId;
  const results: ReviewExecutionResult[] = [];

  for (const req of requests) {
    if (!validateSenderWorkingDir(botUsername, req.workingDir)) {
      console.warn(`[Review] REJECTED: workingDir mismatch for ${botUsername} (claimed: ${req.workingDir})`);
      results.push({
        success: false,
        message: `workingDir mismatch: ${botUsername} is not registered for ${req.workingDir}`,
      });
      continue;
    }

    const reqId = generateReqId(botUsername);
    const prompt = buildReviewPrompt(req, reqId, botUsername);

    // Log review request
    if (groupChatId) {
      appendGroupChatLog(String(groupChatId), {
        ts: new Date().toISOString(),
        bot: botUsername,
        role: "bot",
        from: botUsername,
        type: "review_request",
        reqId,
        text: req.summary.slice(0, 500),
      });

      // Post request summary to group chat (display only)
      channel.sendText(
        String(groupChatId),
        `[Review Request] @${botUsername}\n${req.summary}`,
      ).catch((err) => console.error("[Review] Failed to post request to group:", err));
    }

    // Enqueue directly to Codex provider (fire-and-forget)
    const { promise } = enqueue({
      prompt,
      chatId: groupChatId ? String(groupChatId) : "__review__",
      channel: "telegram",
      provider: "codex",
      workingDir: req.workingDir,
    });

    const displayToken = config.interbot?.displayBotToken;

    promise.then((result) => {
      const reviewText = result.output || "(no review output)";
      console.log(`[Review] Codex completed ${reqId}`);

      if (groupChatId) {
        const chatIdStr = String(groupChatId);
        const msg = `${reviewText}`;

        // displayBotToken이 있으면 Codex 봇 이름으로 전송, 없으면 프로젝트 봇으로 전송
        const sendPromise = displayToken
          ? sendAsBotToken(displayToken, chatIdStr, msg)
          : channel.sendText(chatIdStr, `[Codex Review]\n\n${msg}`);

        sendPromise.catch((err) =>
          console.error("[Review] Failed to post result to group:", err),
        );

        appendGroupChatLog(chatIdStr, {
          ts: new Date().toISOString(),
          bot: "codex",
          role: "bot",
          from: "codex",
          type: "review_response",
          reqId,
          text: reviewText.slice(0, 500),
        });
      }
    }).catch((err) => {
      console.error(`[Review] Codex review failed for ${reqId}:`, err);
      if (groupChatId) {
        const chatIdStr = String(groupChatId);
        const errMsg = `Review failed: ${err instanceof Error ? err.message : String(err)}`;

        const sendPromise = displayToken
          ? sendAsBotToken(displayToken, chatIdStr, errMsg)
          : channel.sendText(chatIdStr, errMsg);

        sendPromise.catch(() => {});
      }
    });

    results.push({ success: true, message: `Review enqueued: ${reqId.slice(0, 20)}`, reqId });
    console.log(`[Review] Enqueued ${reqId} to Codex provider`);
  }

  return results;
}
