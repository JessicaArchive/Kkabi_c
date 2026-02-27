import type { Channel } from "../channels/base.js";
import type { IncomingMessage } from "../types.js";
import { isCommand, executeCommand } from "./commands.js";
import { buildPrompt } from "../claude/context.js";
import { enqueue } from "../claude/queue.js";
import { checkSafety, requestApproval } from "../safety/gate.js";
import { saveMessage, saveExecution } from "../db/store.js";
import { appendDailyLog } from "../memory/manager.js";

export function createHandler(channel: Channel) {
  return async (msg: IncomingMessage): Promise<void> => {
    const { chatId, text, threadId, senderName } = msg;

    // Log incoming message
    saveMessage({
      role: "user",
      content: text,
      channel: msg.channel,
      chatId,
      timestamp: msg.timestamp,
    });
    appendDailyLog(`[${senderName}] ${text.slice(0, 100)}`);

    // Command handling
    if (isCommand(text)) {
      const result = await executeCommand(text, chatId, msg.channel);
      await channel.sendText(chatId, result.text, threadId);
      return;
    }

    // Safety check
    const safety = checkSafety(text);
    if (!safety.safe) {
      const approved = await requestApproval(
        channel,
        chatId,
        text,
        safety.matchedKeywords,
        threadId,
      );
      if (!approved) {
        await channel.sendText(chatId, "🚫 요청이 거부되었습니다.", threadId);
        return;
      }
    }

    // Send "처리 중..." message
    const pendingMsgId = await channel.sendText(chatId, "⏳ 처리 중...", threadId);

    // Build prompt and enqueue
    const prompt = buildPrompt(text, chatId);
    const { promise, position } = enqueue(prompt, chatId, msg.channel);

    if (position > 1) {
      await channel.editMessage(chatId, pendingMsgId, `⏳ 대기 중... (${position}번째)`);
    }

    const startTime = Date.now();

    try {
      const result = await promise;
      const durationMs = Date.now() - startTime;

      if (result.error) {
        const errorMsg = `❌ 오류: ${result.error}`;
        await channel.editMessage(chatId, pendingMsgId, errorMsg);
        saveExecution({
          prompt: text,
          output: result.error,
          status: result.timedOut ? "timeout" : "error",
          channel: msg.channel,
          chatId,
          timestamp: Date.now(),
          durationMs,
        });
        return;
      }

      // Send response (edit the pending message)
      const response = result.output || "(빈 응답)";
      await channel.editMessage(chatId, pendingMsgId, response);

      // Save conversation
      saveMessage({
        role: "assistant",
        content: response,
        channel: msg.channel,
        chatId,
        timestamp: Date.now(),
      });

      saveExecution({
        prompt: text,
        output: response.slice(0, 1000),
        status: "success",
        channel: msg.channel,
        chatId,
        timestamp: Date.now(),
        durationMs,
      });

      appendDailyLog(`[까비] ${response.slice(0, 100)}`);
    } catch (err) {
      const errorMsg = `❌ 예상치 못한 오류: ${err instanceof Error ? err.message : String(err)}`;
      await channel.editMessage(chatId, pendingMsgId, errorMsg);
    }
  };
}
