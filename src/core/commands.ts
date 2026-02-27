import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { CommandResult, ChannelType } from "../types.js";
import { getRecentConversation, getRecentExecutions } from "../db/store.js";
import { readMemory, appendMemory, clearMemory } from "../memory/manager.js";
import { loadPersona, updateSoul, updateUser, updateMood } from "../memory/persona.js";
import { cancelCurrent, isRunning, getCurrentPromptId } from "../claude/runner.js";
import { getQueueLength, getQueueItems } from "../claude/queue.js";
import { addCron, removeCron, listCrons, toggleCron } from "../scheduler/cron.js";

let workingDir = process.env.HOME ?? process.cwd();

export function getWorkingDir(): string {
  return workingDir;
}

export function isCommand(text: string): boolean {
  return text.startsWith("!");
}

export async function executeCommand(
  text: string,
  chatId: string,
  channel: ChannelType,
): Promise<CommandResult> {
  const trimmed = text.slice(1).trim();
  const spaceIdx = trimmed.indexOf(" ");
  const cmd = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  switch (cmd.toLowerCase()) {
    case "cd":
      return cmdCd(args);
    case "pwd":
      return { text: `${workingDir}` };
    case "status":
      return cmdStatus();
    case "history":
      return cmdHistory(chatId, args);
    case "memory":
      return cmdMemory(args);
    case "forget":
      return cmdForget();
    case "system":
      return { text: formatSystemInfo() };
    case "persona":
      return cmdPersona(args);
    case "cancel":
      return cmdCancel();
    case "running":
      return cmdRunning();
    case "cron":
      return cmdCron(args, chatId, channel);
    case "help":
      return { text: HELP_TEXT };
    default:
      return { text: `Unknown command: ${cmd}\nType !help for available commands` };
  }
}

function cmdCd(args: string): CommandResult {
  if (!args) return { text: "Usage: !cd <path>" };
  const target = args.replace("~", process.env.HOME ?? "");
  const resolved = resolve(workingDir, target);
  if (!existsSync(resolved)) {
    return { text: `Path not found: ${resolved}` };
  }
  workingDir = resolved;
  return { text: `-> ${workingDir}` };
}

function cmdStatus(): CommandResult {
  const running = isRunning();
  const queueLen = getQueueLength();
  const lines = [
    `Status: ${running ? "Running" : "Idle"}`,
    `Queue: ${queueLen} item(s)`,
    `Working directory: ${workingDir}`,
  ];
  return { text: lines.join("\n") };
}

function cmdHistory(chatId: string, args: string): CommandResult {
  const limit = parseInt(args) || 10;
  const rows = getRecentConversation(chatId, limit);
  if (rows.length === 0) return { text: "No conversation history." };
  const lines = rows.map(
    (r) => `[${new Date(r.timestamp).toLocaleTimeString("en-US")}] ${r.role}: ${r.content.slice(0, 100)}`,
  );
  return { text: lines.join("\n") };
}

function cmdMemory(args: string): CommandResult {
  if (!args) {
    const mem = readMemory();
    return { text: mem || "(empty)" };
  }
  appendMemory(args);
  return { text: `Memory added: ${args}` };
}

function cmdForget(): CommandResult {
  clearMemory();
  return { text: "Memory cleared." };
}

function cmdPersona(args: string): CommandResult {
  if (!args) {
    const p = loadPersona();
    return {
      text: `[SOUL]\n${p.soul}\n\n[USER]\n${p.user}\n\n[MOOD]\n${p.mood}`,
    };
  }
  const [section, ...rest] = args.split(" ");
  const content = rest.join(" ");
  if (!content) return { text: "Usage: !persona <soul|user|mood> <content>" };

  switch (section.toLowerCase()) {
    case "soul":
      updateSoul(content);
      return { text: "SOUL updated." };
    case "user":
      updateUser(content);
      return { text: "USER updated." };
    case "mood":
      updateMood(content);
      return { text: "MOOD updated." };
    default:
      return { text: "Usage: !persona <soul|user|mood> <content>" };
  }
}

function cmdCancel(): CommandResult {
  if (cancelCurrent()) {
    return { text: "Running task cancelled." };
  }
  return { text: "No task is currently running." };
}

function cmdRunning(): CommandResult {
  const running = isRunning();
  const promptId = getCurrentPromptId();
  const queueItems = getQueueItems();

  if (!running && queueItems.length === 0) {
    return { text: "No task is currently running." };
  }

  const lines: string[] = [];
  if (running) {
    lines.push(`Running: ${promptId}`);
  }
  if (queueItems.length > 0) {
    lines.push(`Queue (${queueItems.length} item(s)):`);
    queueItems.forEach((item, i) => {
      lines.push(`  ${i + 1}. ${item.prompt.slice(0, 50)}...`);
    });
  }
  return { text: lines.join("\n") };
}

function cmdCron(args: string, chatId: string, channel: ChannelType): CommandResult {
  if (!args) {
    const crons = listCrons();
    if (crons.length === 0) return { text: "No cron jobs registered." };
    const lines = crons.map(
      (c) =>
        `${c.enabled ? "ON" : "OFF"} [${c.id.slice(0, 8)}] ${c.schedule} -> ${c.prompt.slice(0, 40)}`,
    );
    return { text: lines.join("\n") };
  }

  const parts = args.split(" ");
  const sub = parts[0];

  switch (sub) {
    case "add": {
      const match = args.match(/add\s+"([^"]+)"\s+"([^"]+)"/);
      if (!match) return { text: 'Usage: !cron add "<schedule>" "<prompt>"' };
      const job = addCron(match[1], match[2], channel, chatId);
      return { text: `Cron job added: ${job.id.slice(0, 8)} (${match[1]})` };
    }
    case "remove": {
      const id = parts[1];
      if (!id) return { text: "Usage: !cron remove <id>" };
      return removeCron(id)
        ? { text: `Cron job removed: ${id}` }
        : { text: `Not found: ${id}` };
    }
    case "toggle": {
      const id = parts[1];
      if (!id) return { text: "Usage: !cron toggle <id>" };
      const toggled = toggleCron(id);
      return toggled
        ? { text: `Cron job ${toggled.enabled ? "enabled" : "disabled"}: ${id}` }
        : { text: `Not found: ${id}` };
    }
    default:
      return { text: 'Usage: !cron <add|remove|toggle|list>\n!cron add "<schedule>" "<prompt>"' };
  }
}

function formatSystemInfo(): string {
  const execs = getRecentExecutions(5);
  const lines = [
    "System Info",
    `  Working directory: ${workingDir}`,
    `  Queue: ${getQueueLength()} item(s)`,
    "",
    "Recent executions:",
  ];
  for (const e of execs) {
    lines.push(
      `  [${new Date(e.timestamp).toLocaleTimeString("en-US")}] ${e.status} (${e.durationMs}ms)`,
    );
  }
  return lines.join("\n");
}

const HELP_TEXT = `Kkabi Commands

!cd <path>          Change working directory
!pwd               Current working directory
!status            Show status
!history [N]       Conversation history (default: 10)
!memory [content]   View/add memory
!forget            Clear memory
!system            System info
!persona [section]  View/edit persona
!cancel            Cancel running task
!running           Show running/queued tasks
!cron              Manage cron jobs
!help              Show this help`;
