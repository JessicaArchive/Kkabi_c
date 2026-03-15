import type { Channel } from "../channels/base.js";
import type { ReviewRequest } from "./reviewParser.js";
import { generateReqId } from "../interbot/protocol.js";
import { validateSenderWorkingDir } from "../interbot/registry.js";
import { appendGroupChatLog } from "../interbot/log.js";
import { getConfig } from "../config.js";
import { enqueue } from "../claude/queue.js";

const TG_MAX_LEN = 4096;
const MAX_REVIEW_ROUNDS = 3;

// ── Telegram helpers ──

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

// ── Group chat display ──

interface GroupChatContext {
  channel: Channel;
  groupChatId: string;
  displayToken?: string;
  reqId: string;
}

/** 응답에서 '요약:' 줄을 추출. 없으면 전체 텍스트의 첫 300자 */
function extractSummary(text: string): string {
  const lines = text.split("\n");
  const summaryLines: string[] = [];
  let found = false;
  for (const line of lines) {
    if (line.startsWith("요약:") || line.startsWith("요약 :")) {
      found = true;
      summaryLines.push(line);
    } else if (found && line.trim()) {
      summaryLines.push(line); // 요약이 여러 줄일 수 있음
    } else if (found && !line.trim()) {
      break; // 빈 줄에서 끊기
    }
  }
  return found ? summaryLines.join("\n") : text.slice(0, 300);
}

async function postAsCodex(ctx: GroupChatContext, text: string): Promise<void> {
  // 텔레그램엔 요약만
  const display = extractSummary(text);
  const sendPromise = ctx.displayToken
    ? sendAsBotToken(ctx.displayToken, ctx.groupChatId, display)
    : ctx.channel.sendText(ctx.groupChatId, `[Codex]\n${display}`);
  await sendPromise.catch((err) => console.error("[Review] Failed to post Codex msg:", err));

  // JSONL엔 전체 저장
  appendGroupChatLog(ctx.groupChatId, {
    ts: new Date().toISOString(),
    bot: "codex",
    role: "bot",
    from: "codex",
    type: "review_response",
    reqId: ctx.reqId,
    text: text.slice(0, 2000),
  });
}

async function postAsClaude(ctx: GroupChatContext, botUsername: string, text: string): Promise<void> {
  // 텔레그램엔 요약만
  const display = extractSummary(text);
  await ctx.channel.sendText(ctx.groupChatId, display)
    .catch((err) => console.error("[Review] Failed to post Claude msg:", err));

  // JSONL엔 전체 저장
  appendGroupChatLog(ctx.groupChatId, {
    ts: new Date().toISOString(),
    bot: botUsername,
    role: "bot",
    from: botUsername,
    type: "review_reply",
    reqId: ctx.reqId,
    text: text.slice(0, 2000),
  });
}

// ── Prompt builders ──

function buildReviewPrompt(req: ReviewRequest, reqId: string, fromBot: string): string {
  const parts: string[] = [];
  parts.push(`[CODE REVIEW REQUEST from ${fromBot}]`);
  parts.push(`Request ID: ${reqId}`);
  parts.push(`Working directory: ${req.workingDir}`);
  if (req.branch) parts.push(`Branch: ${req.branch}`);
  if (req.files?.length) parts.push(`Files changed: ${req.files.join(", ")}`);
  parts.push(`Summary: ${req.summary}`);
  parts.push("");
  parts.push("Review the changes above. Check the actual files and git diff in the working directory.");
  parts.push("Focus on: bugs, edge cases, security, performance.");
  parts.push("Do NOT run simulations, tests, or execute code. Static analysis only.");
  parts.push("If no issues found, include [LGTM] in your response.");
  parts.push("Be concise. At the very end, add a Korean summary line starting with '요약:'.");
  return parts.join("\n");
}

function buildFeedbackPrompt(codexReview: string, req: ReviewRequest, reqId: string): string {
  const parts: string[] = [];
  parts.push(`[CODE REVIEW FEEDBACK]`);
  parts.push(`Request ID: ${reqId}`);
  parts.push(`Working directory: ${req.workingDir}`);
  if (req.files?.length) parts.push(`Files: ${req.files.join(", ")}`);
  parts.push("");
  parts.push("The reviewer found the following issues:");
  parts.push(codexReview);
  parts.push("");
  parts.push("Based on this feedback:");
  parts.push("1. Fix the code if the issues are valid.");
  parts.push("2. Explain why if you disagree.");
  parts.push("3. Summarize what you fixed and what you disagree with.");
  parts.push("");
  parts.push("IMPORTANT: Do NOT include REVIEW_REQUEST tags. The review loop runs automatically.");
  parts.push("At the very end, add a Korean summary line starting with '요약:'.");
  return parts.join("\n");
}

function buildReReviewPrompt(claudeResponse: string, req: ReviewRequest, reqId: string, round: number): string {
  const parts: string[] = [];
  parts.push(`[CODE RE-REVIEW — Round ${round + 1}]`);
  parts.push(`Request ID: ${reqId}`);
  parts.push(`Working directory: ${req.workingDir}`);
  if (req.files?.length) parts.push(`Files: ${req.files.join(", ")}`);
  parts.push("");
  parts.push("The developer responded to the previous review feedback:");
  parts.push(claudeResponse);
  parts.push("");
  parts.push("Re-review the actual files and git diff.");
  parts.push("- Verify previous issues are resolved.");
  parts.push("- Check for new problems introduced by the fixes.");
  parts.push("- If all issues are resolved, include [LGTM] in your response.");
  parts.push("Do NOT run simulations, tests, or execute code. Static analysis only.");
  parts.push("Be concise. At the very end, add a Korean summary line starting with '요약:'.");
  return parts.join("\n");
}

// ── Consensus detection ──

function isApproved(review: string): boolean {
  return review.includes("[LGTM]") || review.includes("[승인]");
}

// ── Multi-round review loop ──

async function runReviewLoop(
  firstReview: string,
  req: ReviewRequest,
  reqId: string,
  botUsername: string,
  ctx: GroupChatContext | null,
): Promise<void> {
  let codexReview = firstReview;
  const chatId = ctx?.groupChatId ?? "__review__";

  for (let round = 0; round < MAX_REVIEW_ROUNDS; round++) {
    // Codex가 승인했으면 종료
    if (isApproved(codexReview)) {
      console.log(`[Review] ${reqId} — LGTM at round ${round + 1}`);
      if (ctx) {
        await postAsCodex(ctx, `✅ 리뷰 완료 (${round + 1}라운드)`);
      }
      return;
    }

    console.log(`[Review] ${reqId} — Round ${round + 1}: Claude fixing...`);

    // 진행 상황 표시
    if (ctx) {
      await postAsClaude(ctx, botUsername, `🔧 Round ${round + 1}: 코드 수정 중...`);
    }

    // Claude가 피드백을 받고 코드 수정
    const feedbackPrompt = buildFeedbackPrompt(codexReview, req, reqId);
    const claudeResult = await enqueue({
      prompt: feedbackPrompt,
      chatId,
      channel: "telegram",
      provider: "claude",
      workingDir: req.workingDir,
    }).promise;

    const claudeResponse = claudeResult.output || "(no response)";

    // 그룹챗에 Claude 수정 내용 표시
    if (ctx) {
      await postAsClaude(ctx, botUsername, `[Round ${round + 1} 수정]\n\n${claudeResponse}`);
    }

    if (claudeResult.error) {
      console.error(`[Review] ${reqId} — Claude error at round ${round + 1}:`, claudeResult.error);
      break;
    }

    console.log(`[Review] ${reqId} — Round ${round + 1}: Codex re-reviewing...`);

    // 진행 상황 표시
    if (ctx) {
      await postAsCodex(ctx, `🔍 Round ${round + 1}: 재리뷰 중...`);
    }

    // Codex 재리뷰
    const reReviewPrompt = buildReReviewPrompt(claudeResponse, req, reqId, round);
    const codexResult = await enqueue({
      prompt: reReviewPrompt,
      chatId,
      channel: "telegram",
      provider: "codex",
      workingDir: req.workingDir,
    }).promise;

    codexReview = codexResult.output || "(no review output)";

    // 그룹챗에 Codex 재리뷰 표시
    if (ctx) {
      await postAsCodex(ctx, codexReview);
    }

    if (codexResult.error) {
      console.error(`[Review] ${reqId} — Codex error at round ${round + 1}:`, codexResult.error);
      break;
    }
  }

  // 라운드 한도 도달
  if (!isApproved(codexReview)) {
    console.log(`[Review] ${reqId} — Max rounds (${MAX_REVIEW_ROUNDS}) reached without consensus`);
    if (ctx) {
      await postAsCodex(ctx, `⚠️ ${MAX_REVIEW_ROUNDS}라운드 완료 — 합의 미도달. 사용자 판단 필요.`);
    }
  }
}

// ── Main entry point ──

export interface ReviewExecutionResult {
  success: boolean;
  message: string;
  reqId?: string;
}

export async function executeReviewRequests(
  requests: ReviewRequest[],
  channel: Channel,
  botUsername: string,
): Promise<ReviewExecutionResult[]> {
  const config = getConfig();
  const groupChatId = config.interbot?.groupChatId;
  const displayToken = config.interbot?.displayBotToken;
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

    // 그룹챗에 요청 표시
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

      channel.sendText(
        String(groupChatId),
        `📋 리뷰 요청\n${req.summary}`,
      ).catch((err) => console.error("[Review] Failed to post request to group:", err));
    }

    // 진행 상황 표시 — Codex 리뷰 시작
    if (groupChatId && displayToken) {
      sendAsBotToken(displayToken, String(groupChatId), `🔍 코드 리뷰 시작...\n${req.summary}`)
        .catch((err) => console.error("[Review] Failed to post start msg:", err));
    }

    // Codex 초기 리뷰 enqueue (fire-and-forget — 이후 루프는 비동기)
    const { promise } = enqueue({
      prompt,
      chatId: groupChatId ? String(groupChatId) : "__review__",
      channel: "telegram",
      provider: "codex",
      workingDir: req.workingDir,
    });

    const ctx: GroupChatContext | null = groupChatId
      ? { channel, groupChatId: String(groupChatId), displayToken, reqId }
      : null;

    promise.then(async (result) => {
      const reviewText = result.output || "(no review output)";
      console.log(`[Review] Codex initial review completed for ${reqId}`);

      // 그룹챗에 첫 리뷰 표시
      if (ctx) {
        await postAsCodex(ctx, reviewText);
      }

      // 멀티라운드 루프 시작 (승인될 때까지 또는 max rounds)
      await runReviewLoop(reviewText, req, reqId, botUsername, ctx);
    }).catch((err) => {
      console.error(`[Review] Codex review failed for ${reqId}:`, err);
      if (groupChatId) {
        const errMsg = `Review failed: ${err instanceof Error ? err.message : String(err)}`;
        const sendPromise = displayToken
          ? sendAsBotToken(displayToken, String(groupChatId), errMsg)
          : channel.sendText(String(groupChatId), errMsg);
        sendPromise.catch(() => {});
      }
    });

    results.push({ success: true, message: `Review enqueued: ${reqId.slice(0, 20)}`, reqId });
    console.log(`[Review] Enqueued ${reqId} to Codex provider`);
  }

  return results;
}
