import { getRecentConversation } from "../db/store.js";
import { readMemory } from "../memory/manager.js";
import { loadPersona, getLang } from "../memory/persona.js";
import { listCrons } from "../scheduler/cron.js";

export function buildPrompt(userMessage: string, chatId: string): string {
  const parts: string[] = [];

  // System persona
  const persona = loadPersona();
  if (persona.soul) {
    parts.push(`[SOUL]\n${persona.soul}`);
  }
  if (persona.user) {
    parts.push(`[USER INFO]\n${persona.user}`);
  }
  if (persona.mood) {
    parts.push(`[MOOD]\n${persona.mood}`);
  }

  // Capabilities — cron scheduling via hidden tags
  parts.push(buildCapabilitiesSection(chatId));

  // Memory
  const memory = readMemory();
  if (memory) {
    parts.push(`[MEMORY]\n${memory}`);
  }

  // Recent conversation context
  const recent = getRecentConversation(chatId, 20);
  if (recent.length > 0) {
    const history = recent
      .map((r) => `${r.role === "user" ? "User" : "Assistant"}: ${r.content}`)
      .join("\n");
    parts.push(`[CONVERSATION HISTORY]\n${history}`);
  }

  // Current message
  parts.push(`[CURRENT MESSAGE]\nUser: ${userMessage}`);

  return parts.join("\n\n");
}

function buildCapabilitiesSection(chatId: string): string {
  const lang = getLang();
  const lines: string[] = ["[CAPABILITIES]"];

  lines.push("You can manage scheduled (cron) tasks by including hidden HTML comment tags in your response.");
  lines.push("The system will parse these tags, execute the action, and strip them before showing your reply.");
  lines.push("");

  // Tag format instructions
  lines.push("## Cron Tag Format");
  lines.push("To register a new cron job:");
  lines.push('  <!--CRON_JOB:{"schedule":"<cron expression>","prompt":"<task prompt>"}-->');
  lines.push("To remove an existing cron job:");
  lines.push('  <!--CRON_REMOVE:{"id":"<id prefix>"}-->');
  lines.push("To list all cron jobs:");
  lines.push("  <!--CRON_LIST-->");
  lines.push("");

  // Cron expression examples
  lines.push("## Cron Expression Examples");
  lines.push("- Every day at 9 AM: 0 9 * * *");
  lines.push("- Every weekday at 9 AM: 0 9 * * 1-5");
  lines.push("- Every Monday at 10 AM: 0 10 * * 1");
  lines.push("- Every hour: 0 * * * *");
  lines.push("- Every 30 minutes: */30 * * * *");
  lines.push("");

  // Rules
  lines.push("## Rules");
  lines.push("- When the user asks to schedule/register a recurring task, include the appropriate CRON_JOB tag.");
  lines.push("- When the user asks to cancel/remove/delete a scheduled task, include the CRON_REMOVE tag.");
  lines.push("- When the user asks to see/list scheduled tasks, include the CRON_LIST tag.");
  lines.push("- ALWAYS also include a natural language confirmation in your response (the tag alone is not visible to the user).");
  lines.push("- Place tags at the END of your response, after your natural language text.");
  if (lang === "ko") {
    lines.push("- Respond in Korean.");
  }
  lines.push("");

  // Current cron jobs for context
  const jobs = listCrons().filter((j) => j.chatId === chatId);
  if (jobs.length > 0) {
    lines.push("## Current Cron Jobs for This Chat");
    for (const job of jobs) {
      const status = job.enabled ? "ON" : "OFF";
      lines.push(`- ID: ${job.id.slice(0, 8)} | Schedule: ${job.schedule} | Prompt: ${job.prompt} | ${status}`);
    }
  } else {
    lines.push("## Current Cron Jobs for This Chat");
    lines.push("(none)");
  }

  return lines.join("\n");
}
