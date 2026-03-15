import type { Channel } from "../channels/base.js";
import type { ReviewRequest } from "./reviewParser.js";
import { buildBotMsg, generateReqId, type BotMsgHeader } from "../interbot/protocol.js";
import { validateSenderWorkingDir } from "../interbot/registry.js";
import { getConfig } from "../config.js";

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

  if (!groupChatId) {
    return requests.map(() => ({
      success: false,
      message: "interbot.groupChatId not configured",
    }));
  }

  const results: ReviewExecutionResult[] = [];

  for (const req of requests) {
    // sender workingDir 검증
    if (!validateSenderWorkingDir(botUsername, req.workingDir)) {
      console.log(`[Review] workingDir validation skipped for ${botUsername} (not in registry or mismatch)`);
    }

    const reqId = generateReqId(botUsername);
    const header: BotMsgHeader = {
      from: botUsername,
      type: "review_request",
      reqId,
    };
    const body: Record<string, unknown> = {
      workingDir: req.workingDir,
      type: req.type,
      summary: req.summary,
    };
    if (req.files) body.files = req.files;
    if (req.branch) body.branch = req.branch;

    const message = buildBotMsg(header, body);

    try {
      await channel.sendText(String(groupChatId), message);
      console.log(`[Review] Sent review request ${reqId} to group ${groupChatId}`);
      results.push({ success: true, message: `Review requested: ${reqId.slice(0, 20)}`, reqId });
    } catch (err) {
      console.error(`[Review] Failed to send review request:`, err);
      results.push({
        success: false,
        message: `Failed to send review: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return results;
}
