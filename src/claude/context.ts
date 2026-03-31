import { getRecentConversation } from "../db/store.js";
import { readMemory } from "../memory/manager.js";
import { loadPersona, getLang } from "../memory/persona.js";
import { listCrons } from "../scheduler/cron.js";
import { loadAgents } from "../agents/store.js";
import { getConfig } from "../config.js";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export function buildPrompt(userMessage: string, chatId: string, workingDir?: string): string {
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

  // Coding rules — git workflow instructions
  parts.push(buildCodingRulesSection());

  // Memory
  const memory = readMemory();
  if (memory) {
    parts.push(`[MEMORY]\n${memory}`);
  }

  // Recent conversation context — compare with terminal session logs
  const recent = getRecentConversation(chatId, 20);
  const lastMsgTs = recent.length > 0 ? recent[recent.length - 1].timestamp : 0;
  const sessionLog = getLatestSessionLog(workingDir);

  if (sessionLog && sessionLog.timestamp > lastMsgTs) {
    // Terminal session log is more recent — include it as context
    const history = recent.length > 0
      ? recent
          .map((r) => `${r.role === "user" ? "User" : "Assistant"}: ${r.content}`)
          .join("\n")
      : "";
    const sessionSection = `[RECENT TERMINAL SESSION]\n아래는 터미널에서 진행된 최근 세션 요약이야. 텔레그램 대화보다 최신이니 이 맥락을 우선 참고해.\n\n${sessionLog.content}`;
    if (history) {
      parts.push(`[CONVERSATION HISTORY]\n${history}`);
    }
    parts.push(sessionSection);
  } else if (recent.length > 0) {
    const history = recent
      .map((r) => `${r.role === "user" ? "User" : "Assistant"}: ${r.content}`)
      .join("\n");
    parts.push(`[CONVERSATION HISTORY]\n${history}`);
  }

  // Current message
  parts.push(`[CURRENT MESSAGE]\nUser: ${userMessage}`);

  return parts.join("\n\n");
}

function getLatestSessionLog(workingDir?: string): { content: string; timestamp: number } | null {
  try {
    const baseDir = join(homedir(), "Obsidian", "Kkabi", "sessions");

    // If workingDir given, derive slug = first path component relative to home
    // e.g. ~/kkabi-trading/src → "kkabi-trading"
    const projectSlug = workingDir
      ? (workingDir.startsWith("~/")
          ? workingDir.slice(2).split("/")[0]
          : workingDir.replace(homedir() + "/", "").split("/")[0])
      : null;
    const sessionsDir = projectSlug
      ? join(baseDir, projectSlug)
      : baseDir;

    let dir = sessionsDir;
    let files = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort().reverse();
    } catch {
      // Subdirectory doesn't exist yet — fall back to base dir
      dir = baseDir;
      files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort().reverse();
    }

    if (files.length === 0) return null;

    const latestFile = files[0];
    // Parse timestamp from filename: YYYY-MM-DD-HH.md
    const match = latestFile.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})\.md$/);
    if (!match) return null;

    const [, year, month, day, hour] = match;
    const timestamp = new Date(
      Number(year), Number(month) - 1, Number(day), Number(hour)
    ).getTime();

    const content = readFileSync(join(dir, latestFile), "utf-8");
    return { content, timestamp };
  } catch {
    return null;
  }
}

function buildCodingRulesSection(): string {
  const lines: string[] = ["[CODING RULES]"];
  lines.push("When the user asks you to modify code, fix bugs, or add features, follow these rules:");
  lines.push("");
  lines.push("## Git Workflow");
  lines.push("- ALWAYS create a new branch before making changes. Never commit directly to main/master.");
  lines.push("- Use descriptive branch names like: feature/<short-description>, fix/<short-description>");
  lines.push("- NEVER run git commit, git push, gh pr create, or gh pr merge yourself.");
  lines.push("- Instead, use the COMMIT_SUGGEST tag (see below) and the system will handle everything.");
  lines.push("- NEVER force push. NEVER delete branches.");
  lines.push("");
  lines.push("## Commit Suggest Tag");
  lines.push("- 기능 하나 완성하거나 버그 하나 고치면 커밋을 제안해.");
  lines.push("- 큰 작업이 끝나면 반드시 커밋을 제안해.");
  lines.push("- 커밋 제안 시 응답 끝에 아래 태그를 포함해:");
  lines.push('  <!--COMMIT_SUGGEST:{"message":"feat: 기능 설명"}-->');
  lines.push("- 커밋 메시지는 conventional commits 형식 (feat:, fix:, refactor: 등).");
  lines.push("- 태그 외에 자연어로도 변경 내용을 설명해.");
  lines.push("- 시스템이 태그를 감지하면 사용자에게 커밋 승인 버튼을 보내고, 승인 시 자동으로 commit → push → PR → 머지까지 처리해.");
  lines.push("");
  lines.push("## Response Format");
  lines.push("- After completing code changes, include a summary of what you did:");
  lines.push("  - Which files were modified/created");
  lines.push("  - What the changes do");
  return lines.join("\n");
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
  lines.push("To register a cron job with an agent:");
  lines.push('  <!--CRON_JOB:{"schedule":"<cron expression>","prompt":"<task prompt>","agentId":"<agent id>"}-->');
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
  lines.push("- Cron jobs are for RECURRING tasks only (e.g. 'every day at 9am', 'every Monday'). Do NOT register a cron job for one-time requests.");
  lines.push("- One-time delayed requests (e.g. 'tell me in 5 minutes', 'remind me once') cannot be scheduled — inform the user that only recurring schedules are supported.");
  lines.push("- When the user asks to schedule/register a recurring task, include the appropriate CRON_JOB tag.");
  lines.push("- When the user asks to cancel/remove/delete a scheduled task, include the CRON_REMOVE tag.");
  lines.push("- When the user asks to see/list scheduled tasks, include the CRON_LIST tag.");
  lines.push("- ALWAYS also include a natural language confirmation in your response (the tag alone is not visible to the user).");
  lines.push("- Place tags at the END of your response, after your natural language text.");
  if (lang === "ko") {
    lines.push("- Respond in Korean.");
  }
  lines.push("");

  // Code review capability (only when interbot is enabled and provider is claude)
  const appConfig = getConfig();
  if (appConfig.interbot?.enabled && (appConfig.provider ?? "claude") === "claude") {
    lines.push("## Code Review (IMPORTANT)");
    lines.push("You have an automated code review system. Do NOT use debate scripts or other tools for code review.");
    lines.push("Instead, when you make code changes OR when the user asks for a review, include this hidden tag at the END of your response:");
    lines.push('  <!--REVIEW_REQUEST:{"workingDir":"~/kkabi-trading","type":"code_change","summary":"added format_price utility","files":["utils/formatting.py"],"branch":"feature/format-price"}-->');
    lines.push("The system will automatically send this to the Codex review bot. You do NOT need to run any scripts.");
    lines.push("Replace the example values with actual values from your work.");
    lines.push("Do NOT request review for: simple questions, status checks, or config lookups.");
    lines.push("ALWAYS include a natural language summary before the tag.");
    lines.push("");
  }

  // File sending capability
  lines.push("## File Sending");
  lines.push("When the user asks you to send, share, or show a file, include this hidden tag at the END of your response:");
  lines.push('  <!--SEND_FILE:{"path":"/absolute/path/to/file"}-->');
  lines.push("The system will send the file as a Telegram document attachment.");
  lines.push("Rules:");
  lines.push("- Use ABSOLUTE paths (expand ~ to full home path).");
  lines.push("- You can include multiple SEND_FILE tags to send multiple files.");
  lines.push("- ALWAYS include a natural language response alongside the tag.");
  lines.push("- Only use this for actual files the user requested. Verify the file exists before including the tag.");
  lines.push("");

  // Available agents
  const agents = loadAgents();
  if (agents.length > 0) {
    lines.push("## Available Agents");
    lines.push("When the user mentions a specific agent, include the agentId in the CRON_JOB tag.");
    for (const a of agents) {
      lines.push(`- ${a.id}: ${a.name}${a.model ? ` (${a.model})` : ""}`);
    }
  }
  lines.push("");

  // Current cron jobs for context
  const jobs = listCrons().filter((j) => j.chatId === chatId);
  if (jobs.length > 0) {
    lines.push("## Current Cron Jobs for This Chat");
    for (const job of jobs) {
      const status = job.enabled ? "ON" : "OFF";
      const summary = job.name || job.prompt.slice(0, 40) + "…";
      lines.push(`- ID: ${job.id.slice(0, 8)} | Schedule: ${job.schedule} | ${summary} | ${status}`);
    }
  } else {
    lines.push("## Current Cron Jobs for This Chat");
    lines.push("(none)");
  }

  return lines.join("\n");
}
