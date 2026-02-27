import type { Channel } from "../channels/base.js";
import type { IncomingMessage } from "../types.js";
import { isCommand, executeCommand } from "./commands.js";
import { buildPrompt } from "../claude/context.js";
import { enqueue } from "../claude/queue.js";
import { checkSafety, requestApproval } from "../safety/gate.js";
import { saveMessage, saveExecution } from "../db/store.js";
import { appendDailyLog } from "../memory/manager.js";
import { isFirstTime, isInSetup, startOnboarding, handleOnboardingStep } from "./onboarding.js";

export function createHandler(channel: Channel) {
  return async (msg: IncomingMessage): Promise<void> => {
    const { chatId, text, threadId, senderName } = msg;

    // First-time onboarding
    if (isFirstTime(chatId) && !isInSetup(chatId)) {
      await startOnboarding(channel, chatId);
      saveMessage({ role: "user", content: text, channel: msg.channel, chatId, timestamp: msg.timestamp });
      return;
    }

    // Onboarding in progress
    if (isInSetup(chatId)) {
      const handled = await handleOnboardingStep(channel, chatId, text);
      if (handled) return;
    }

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
        await channel.sendText(chatId, "Request denied.", threadId);
        return;
      }
    }

    // Send "Processing..." message
    const pendingMsgId = await channel.sendText(chatId, "Processing...", threadId);

    // Build prompt and enqueue
    const prompt = buildPrompt(text, chatId);
    const { promise, position } = enqueue(prompt, chatId, msg.channel);

    if (position > 1) {
      await channel.editMessage(chatId, pendingMsgId, `Waiting in queue... (position ${position})`);
    }

    const startTime = Date.now();

    try {
      const result = await promise;
      const durationMs = Date.now() - startTime;

      if (result.error) {
        const errorMsg = `Error: ${result.error}`;
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
      const response = result.output || "(empty response)";
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

      appendDailyLog(`[Kkabi] ${response.slice(0, 100)}`);
    } catch (err) {
      const errorMsg = `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
      await channel.editMessage(chatId, pendingMsgId, errorMsg);
    }
  };
}
