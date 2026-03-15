import type { Channel } from "../channels/base.js";
import type { ChannelType, IncomingMessage, ProviderType } from "../types.js";
import { isCommand, executeCommand } from "./commands.js";
import { buildPrompt } from "../claude/context.js";
import { enqueue } from "../claude/queue.js";
import { getConfig, getRepoName } from "../config.js";
import { checkSafety, requestApproval } from "../safety/gate.js";
import { saveMessage, saveExecution } from "../db/store.js";
import { appendDailyLog } from "../memory/manager.js";
import { isFirstTime, isInSetup, startOnboarding, handleOnboardingStep } from "./onboarding.js";
import { parseCronTags } from "./cronParser.js";
import { executeCronActions } from "./cronExecutor.js";
import { filterIncoming, type FilterConfig } from "../interbot/filter.js";
import { parseReviewTags } from "./reviewParser.js";
import { executeReviewRequests } from "./reviewExecutor.js";

function resolveWorkingDir(chatId: string, channelType: ChannelType): string | undefined {
  const config = getConfig();
  if (channelType === "github") {
    const match = chatId.match(/^(.+?\/.+?)#\d+$/);
    if (match) {
      const repoName = match[1];
      if (config.claude.projects[repoName]) {
        return config.claude.projects[repoName];
      }
      const repoEntry = config.channels.github?.repositories.find((r) => {
        return getRepoName(r) === repoName;
      });
      if (repoEntry && typeof repoEntry === "object" && "workingDir" in repoEntry && repoEntry.workingDir) {
        return repoEntry.workingDir;
      }
    }
  }
  return undefined;
}

export interface HandlerOptions {
  provider?: ProviderType;
  botUsername?: string;
}

export function createHandler(channel: Channel, options?: HandlerOptions) {
  const provider = options?.provider ?? "claude";
  return async (msg: IncomingMessage): Promise<void> => {
    const { chatId, text, threadId, senderName } = msg;

    // Interbot message filtering (loop prevention)
    const config = getConfig();
    if (config.interbot?.enabled && options?.botUsername) {
      const filterConfig: FilterConfig = {
        myBotUsername: options.botUsername,
        myProvider: provider,
      };
      const filterResult = filterIncoming(text, filterConfig);
      if (filterResult.action === "ignore") {
        return;
      }
      if (filterResult.action === "process_review" && filterResult.botMsg) {
        // Review message — extract workingDir from body for provider execution
        const reviewWorkingDir = filterResult.botMsg.body.workingDir as string | undefined;
        if (reviewWorkingDir) {
          // Override workingDir so the provider runs in the correct project directory
          msg = { ...msg, text: text };
          // The workingDir will be resolved below via the review body
        }
      }
    }

    // First-time onboarding
    if (isFirstTime() && !isInSetup(chatId)) {
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

    // Build prompt and enqueue
    const prompt = buildPrompt(text, chatId);
    const workingDir = resolveWorkingDir(chatId, msg.channel);
    const { promise, position } = enqueue({ prompt, chatId, channel: msg.channel, workingDir, provider });

    if (position > 1) {
      await channel.sendText(chatId, `Waiting in queue... (position ${position})`, threadId);
    }

    const startTime = Date.now();

    try {
      const result = await promise;
      const durationMs = Date.now() - startTime;

      if (result.error) {
        const errorMsg = `Error: ${result.error}`;
        await channel.sendText(chatId, errorMsg, threadId);
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

      // Post-process cron tags from Claude's response
      let response = result.output || "(empty response)";
      const { actions, cleanedResponse } = parseCronTags(response);

      if (actions.length > 0) {
        const cronResults = executeCronActions(actions, msg.channel, chatId);
        response = cleanedResponse;

        // Append cron result messages
        const extras: string[] = [];
        for (const r of cronResults) {
          if (!r.success) {
            extras.push(`⚠ ${r.message}`);
          } else if (actions.some((a) => a.type === "list")) {
            extras.push(r.message);
          }
        }
        if (extras.length > 0) {
          response = response + "\n\n" + extras.join("\n");
        }
      }

      // Post-process review tags (send review requests to group chat)
      if (config.interbot?.enabled && options?.botUsername) {
        const { requests: reviewRequests, cleanedResponse: reviewCleaned } = parseReviewTags(response);
        if (reviewRequests.length > 0) {
          response = reviewCleaned;
          const reviewResults = await executeReviewRequests(reviewRequests, channel, options.botUsername);
          const extras: string[] = [];
          for (const r of reviewResults) {
            if (r.success) {
              extras.push(`Code review requested (${r.reqId?.slice(0, 20)})`);
            } else {
              extras.push(`Review failed: ${r.message}`);
            }
          }
          if (extras.length > 0) {
            response = response + "\n\n" + extras.join("\n");
          }
        }
      }

      await channel.sendText(chatId, response, threadId);

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
      await channel.sendText(chatId, errorMsg, threadId);
    }
  };
}
