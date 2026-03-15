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
import { buildBotMsg, parseBotMsg, type BotMsg, type BotMsgHeader } from "../interbot/protocol.js";
import { appendGroupChatLog } from "../interbot/log.js";

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

/**
 * Build a review-specific prompt from a BOT_MSG body.
 * Gives the provider clear context about what to review and where.
 */
function buildReviewPrompt(botMsg: BotMsg): string {
  const { body, header } = botMsg;
  const summary = body.summary as string ?? "";
  const files = (body.files as string[] ?? []).join(", ");
  const branch = body.branch as string ?? "";
  const workingDir = body.workingDir as string ?? "";

  const parts: string[] = [];
  parts.push(`[CODE REVIEW REQUEST from ${header.from}]`);
  parts.push(`Request ID: ${header.reqId}`);
  parts.push(`Working directory: ${workingDir}`);
  if (branch) parts.push(`Branch: ${branch}`);
  if (files) parts.push(`Files changed: ${files}`);
  parts.push(`Summary: ${summary}`);
  parts.push("");
  parts.push("Please review the changes described above. Check the actual files and git diff in the working directory.");
  parts.push("Focus on: bugs, edge cases, security issues, performance problems.");
  parts.push("Be concise and constructive.");
  parts.push("");
  parts.push(`When you respond, format your response as a review. Your response will be sent back to ${header.from}.`);

  return parts.join("\n");
}

/**
 * Build a prompt for when Claude receives Codex review feedback (review_response).
 * Claude should review the feedback, fix issues or explain disagreements.
 */
function buildFeedbackPrompt(botMsg: BotMsg): string {
  const { body, header } = botMsg;
  const review = body.review as string ?? "";
  const workingDir = body.workingDir as string ?? "";

  const parts: string[] = [];
  parts.push(`[CODE REVIEW FEEDBACK from ${header.from}]`);
  parts.push(`Request ID: ${header.reqId}`);
  parts.push(`Working directory: ${workingDir}`);
  parts.push("");
  parts.push("The reviewer said:");
  parts.push(review);
  parts.push("");
  parts.push("Based on this feedback:");
  parts.push("1. If the reviewer found real issues, fix them in the code.");
  parts.push("2. If you disagree with a point, explain why clearly.");
  parts.push("3. Summarize what you fixed and what you disagree with.");
  parts.push("Your response will be sent back to the reviewer for further discussion if needed.");

  return parts.join("\n");
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
    let reviewBotMsg: BotMsg | undefined;

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
        // Fix 3: check "to" field — only process if addressed to me
        const to = filterResult.botMsg.header.to;
        if (to && to !== options.botUsername) {
          return; // not addressed to me
        }
        reviewBotMsg = filterResult.botMsg;
      }
    }

    // First-time onboarding (skip for interbot review messages)
    if (!reviewBotMsg) {
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

    // Log to group chat JSONL for any interbot review message
    // Uses reviewBotMsg (already parsed) or checks if chatId is a known group
    if (config.interbot?.enabled && reviewBotMsg) {
      appendGroupChatLog(chatId, {
        ts: new Date().toISOString(),
        bot: options?.botUsername ?? "unknown",
        role: "bot",
        from: reviewBotMsg.header.from,
        type: reviewBotMsg.header.type,
        reqId: reviewBotMsg.header.reqId,
        text: text.slice(0, 500),
      });
    } else if (config.interbot?.enabled && config.interbot.groupChatId &&
        String(config.interbot.groupChatId) === chatId) {
      // Non-review messages in the configured group chat (project bot's group)
      appendGroupChatLog(chatId, {
        ts: new Date().toISOString(),
        bot: options?.botUsername ?? "unknown",
        role: "user",
        from: senderName,
        text: text.slice(0, 500),
      });
    }

    // Command handling (skip for review messages)
    if (!reviewBotMsg && isCommand(text)) {
      const result = await executeCommand(text, chatId, msg.channel);
      await channel.sendText(chatId, result.text, threadId);
      return;
    }

    // Safety check (skip for review messages — they are system-generated)
    if (!reviewBotMsg) {
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
    }

    // Build prompt and resolve workingDir
    let prompt: string;
    let workingDir: string | undefined;

    if (reviewBotMsg) {
      // Use different prompts based on message type:
      // review_request/review_reply → "perform a code review" (for Codex)
      // review_response → "review this feedback and fix/respond" (for Claude)
      prompt = reviewBotMsg.header.type === "review_response"
        ? buildFeedbackPrompt(reviewBotMsg)
        : buildReviewPrompt(reviewBotMsg);
      workingDir = reviewBotMsg.body.workingDir as string | undefined;
    } else {
      prompt = buildPrompt(text, chatId);
      workingDir = resolveWorkingDir(chatId, msg.channel);
    }

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

      // Post-process cron tags from response
      let response = result.output || "(empty response)";
      const { actions, cleanedResponse } = parseCronTags(response);

      if (actions.length > 0) {
        const cronResults = executeCronActions(actions, msg.channel, chatId);
        response = cleanedResponse;

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

        // Auto-review: if code-modifying tools were used, automatically request review
        const CODE_TOOLS = ["Write", "Edit", "NotebookEdit"];
        const usedCodeTools = (result.toolsUsed ?? []).filter((t) => CODE_TOOLS.includes(t));
        if (usedCodeTools.length > 0 && reviewRequests.length === 0 && !reviewBotMsg) {
          const runnerConfig = config.runner ?? config.claude;
          const autoReviewResults = await executeReviewRequests(
            [{
              workingDir: workingDir ?? runnerConfig.workingDir,
              type: "code_change",
              summary: `Auto-review: ${usedCodeTools.join(", ")} used. ${text.slice(0, 100)}`,
            }],
            channel,
            options.botUsername,
          );
          const extras: string[] = [];
          for (const r of autoReviewResults) {
            if (r.success) {
              extras.push(`Auto review requested (${r.reqId?.slice(0, 20)})`);
            }
          }
          if (extras.length > 0) {
            response = response + "\n\n" + extras.join("\n");
          }
        }
      }

      // If this was a review message, wrap response as structured BOT_MSG
      // Reply to the same chat the message came from (supports per-project groups)
      if (reviewBotMsg && config.interbot?.enabled && options?.botUsername) {
        const replyChatId = chatId; // use incoming chatId, not config groupChatId
        {
          // Determine reply type based on incoming message type:
          // review_request/review_reply → respond with review_response
          // review_response → respond with review_reply (keeps same reqId)
          const replyType = reviewBotMsg.header.type === "review_response"
            ? "review_reply" as const
            : "review_response" as const;

          const responseHeader: BotMsgHeader = {
            from: options.botUsername,
            to: reviewBotMsg.header.from, // send back to the sender
            type: replyType,
            reqId: reviewBotMsg.header.reqId, // always preserve reqId
          };
          const responseBody: Record<string, unknown> = {
            review: response,
            workingDir: reviewBotMsg.body.workingDir,
          };
          const botMsgText = buildBotMsg(responseHeader, responseBody);
          await channel.sendText(replyChatId, botMsgText, threadId);

          // Log outgoing review message
          appendGroupChatLog(replyChatId, {
            ts: new Date().toISOString(),
            bot: options.botUsername,
            role: "bot",
            from: options.botUsername,
            type: replyType,
            reqId: reviewBotMsg.header.reqId,
            text: response.slice(0, 500),
          });
        }
      } else {
        await channel.sendText(chatId, response, threadId);
      }

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
