import type { CronAction } from "./cronParser.js";
import type { ChannelType, CronJob } from "../types.js";
import { addCron, removeCron, listCrons } from "../scheduler/cron.js";

export interface CronExecutionResult {
  success: boolean;
  message: string;
}

export function executeCronActions(
  actions: CronAction[],
  channelType: ChannelType,
  chatId: string,
): CronExecutionResult[] {
  const results: CronExecutionResult[] = [];

  for (const action of actions) {
    switch (action.type) {
      case "add": {
        try {
          const job = addCron(action.schedule, action.prompt, channelType, chatId);
          results.push({
            success: true,
            message: `Cron registered: \`${job.schedule}\` (ID: ${job.id.slice(0, 8)})`,
          });
        } catch (err) {
          results.push({
            success: false,
            message: `Failed to register cron: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        break;
      }

      case "remove": {
        const removed = removeCron(action.id);
        if (removed) {
          results.push({ success: true, message: `Cron removed: ${action.id}` });
        } else {
          results.push({ success: false, message: `Cron not found: ${action.id}` });
        }
        break;
      }

      case "list": {
        const jobs = listCrons().filter((j) => j.chatId === chatId);
        if (jobs.length === 0) {
          results.push({ success: true, message: "No cron jobs registered." });
        } else {
          const lines = jobs.map(formatCronJob);
          results.push({ success: true, message: lines.join("\n") });
        }
        break;
      }
    }
  }

  return results;
}

function formatCronJob(job: CronJob): string {
  const status = job.enabled ? "ON" : "OFF";
  return `- \`${job.schedule}\` | ${job.prompt} | ${status} | ID: ${job.id.slice(0, 8)}`;
}
