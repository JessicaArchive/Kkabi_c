import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { CommandResult, ChannelType } from "../types.js";
import { getRecentConversation, getRecentExecutions } from "../db/store.js";
import { readMemory, appendMemory, clearMemory } from "../memory/manager.js";
import { loadPersona, updateSoul, updateUser, updateMood } from "../memory/persona.js";
import { cancelCurrent, isRunning, getCurrentPromptId } from "../claude/runner.js";
import { getQueueLength, getQueueItems } from "../claude/queue.js";
import {
  addCron,
  removeCron,
  listCrons,
  toggleCron,
  getCron,
  runCronNow,
  reloadCrons,
} from "../scheduler/cron.js";
import { loadAgents, getAgent, reloadAgents, saveAgent, removeAgent } from "../agents/store.js";

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
    case "agent":
      return cmdAgent(args);
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

// --- !cron ---

function cmdCron(args: string, chatId: string, channel: ChannelType): CommandResult {
  if (!args) {
    const crons = listCrons();
    if (crons.length === 0) return { text: "No cron jobs registered." };
    const lines = crons.map((c) => {
      const status = c.enabled ? "ON" : "OFF";
      const lastStatus = c.state?.lastStatus ?? "-";
      const agentTag = c.agentId ? ` [${c.agentId}]` : "";
      return `${status} [${c.id.slice(0, 8)}] ${c.schedule} | ${lastStatus} | ${c.name}${agentTag}`;
    });
    return { text: lines.join("\n") };
  }

  const parts = args.split(" ");
  const sub = parts[0];

  switch (sub) {
    case "add": {
      const match = args.match(/add\s+"([^"]+)"\s+"([^"]+)"/);
      if (!match) return { text: 'Usage: !cron add "<schedule>" "<prompt>" [--agent <id>]' };
      const rest = args.slice(match[0].length);
      const agentId = rest.match(/--agent\s+(\S+)/)?.[1];
      if (agentId && !getAgent(agentId)) {
        return { text: `Agent "${agentId}" not found.` };
      }
      const job = addCron(match[1], match[2], channel, chatId, agentId);
      const agentTag = agentId ? ` [agent: ${agentId}]` : "";
      return { text: `Cron job added: ${job.id.slice(0, 8)} (${match[1]})${agentTag}` };
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
    case "run": {
      const id = parts[1];
      if (!id) return { text: "Usage: !cron run <id>" };
      const msg = runCronNow(id);
      return { text: msg instanceof Promise ? "Starting..." : msg };
    }
    case "status": {
      const id = parts[1];
      return cmdCronStatus(id);
    }
    case "reload": {
      const count = reloadCrons();
      return { text: `Crons reloaded. ${count} active job(s).` };
    }
    default:
      return { text: 'Usage: !cron <add|remove|toggle|run|status|reload>\n!cron add "<schedule>" "<prompt>"' };
  }
}

function cmdCronStatus(id?: string): CommandResult {
  if (!id) {
    // Show summary of all cron jobs
    const crons = listCrons();
    if (crons.length === 0) return { text: "No cron jobs registered." };
    const lines: string[] = [];
    for (const c of crons) {
      const status = c.enabled ? "ON" : "OFF";
      const lastRun = c.state?.lastRunAtMs ? new Date(c.state.lastRunAtMs).toISOString() : "never";
      const duration = c.state?.lastDurationMs != null ? `${(c.state.lastDurationMs / 1000).toFixed(1)}s` : "-";
      const errors = c.state?.consecutiveErrors ?? 0;
      const lastStatus = c.state?.lastStatus ?? "-";
      lines.push(`${status} [${c.id.slice(0, 8)}] ${c.name}`);
      lines.push(`  ${c.schedule} | ${lastStatus} | last: ${lastRun} | ${duration} | errors: ${errors}`);
      if (c.state?.lastError) {
        lines.push(`  error: ${c.state.lastError.slice(0, 100)}`);
      }
    }
    return { text: lines.join("\n") };
  }

  const job = getCron(id);
  if (!job) return { text: `Not found: ${id}` };

  const lastRun = job.state?.lastRunAtMs ? new Date(job.state.lastRunAtMs).toISOString() : "never";
  const duration = job.state?.lastDurationMs != null ? `${(job.state.lastDurationMs / 1000).toFixed(1)}s` : "-";
  const errors = job.state?.consecutiveErrors ?? 0;

  const lines = [
    `Cron Job: ${job.name} (${job.enabled ? "enabled" : "disabled"})`,
    `  ID: ${job.id}`,
    `  Schedule: ${job.schedule}`,
    `  Status: ${job.state?.lastStatus ?? "-"}`,
    `  Last run: ${lastRun}`,
    `  Duration: ${duration}`,
    `  Consecutive errors: ${errors}`,
  ];
  if (job.agentId) lines.push(`  Agent: ${job.agentId}`);
  if (job.model) lines.push(`  Model: ${job.model}`);
  if (job.promptPath) lines.push(`  Prompt file: ${job.promptPath}`);
  if (job.state?.lastError) lines.push(`  Last error: ${job.state.lastError}`);
  return { text: lines.join("\n") };
}

// --- !agent ---

function cmdAgent(args: string): CommandResult {
  if (!args) {
    return cmdAgentList();
  }

  const parts = args.split(" ");
  const sub = parts[0];

  switch (sub) {
    case "show": {
      const id = parts.slice(1).join(" ").trim();
      return cmdAgentShow(id);
    }
    case "add":
      return cmdAgentAdd(args.slice(4).trim());
    case "remove": {
      const id = parts[1]?.trim();
      if (!id) return { text: "Usage: !agent remove <id>" };
      return removeAgent(id)
        ? { text: `Agent removed: ${id}` }
        : { text: `Agent "${id}" not found.` };
    }
    case "reload": {
      const agents = reloadAgents();
      return { text: `Agents reloaded. ${agents.length} agent(s) loaded.` };
    }
    default:
      return { text: "Usage: !agent [show <id> | add | remove | reload]" };
  }
}

function cmdAgentList(): CommandResult {
  const agents = loadAgents();
  if (agents.length === 0) return { text: "No agents configured. Add definitions to data/agents.json" };
  const lines = agents.map((a) => {
    const model = a.model ?? "default";
    return `${a.id}: ${a.name} (${model})`;
  });
  return { text: lines.join("\n") };
}

function cmdAgentShow(id: string): CommandResult {
  if (!id) return { text: "Usage: !agent show <id>" };
  const agent = getAgent(id);
  if (!agent) return { text: `Agent "${id}" not found.` };

  const lines = [
    `Agent: ${agent.name}`,
    `  ID: ${agent.id}`,
    `  Model: ${agent.model ?? "default"}`,
    `  Working dir: ${agent.workingDir ?? "-"}`,
    `  Timeout: ${agent.timeoutMs ? `${agent.timeoutMs / 1000}s` : "-"}`,
  ];
  if (agent.persona) {
    lines.push(`  Persona: ${agent.persona.slice(0, 100)}${agent.persona.length > 100 ? "..." : ""}`);
  }
  return { text: lines.join("\n") };
}

function cmdAgentAdd(raw: string): CommandResult {
  // Parse: <id> "<name>" [--model M] [--dir D] [--timeout N]
  const match = raw.match(/^(\S+)\s+"([^"]+)"/);
  if (!match) return { text: 'Usage: !agent add <id> "<name>" [--model M] [--dir D] [--timeout N]' };

  const [, id, name] = match;
  const rest = raw.slice(match[0].length);

  const model = rest.match(/--model\s+(\S+)/)?.[1];
  const dir = rest.match(/--dir\s+(\S+)/)?.[1]?.replace("~", process.env.HOME ?? "");
  const timeoutRaw = rest.match(/--timeout\s+(\d+)/)?.[1];
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) * 1000 : undefined;

  saveAgent({ id, name, model, workingDir: dir, timeoutMs });
  return { text: `Agent added: ${id} ("${name}")` };
}

// --- Utilities ---

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
!cron              List cron jobs
!cron add "<s>" "<p>" [--agent <id>]  Add cron job
!cron remove <id>  Remove cron job
!cron toggle <id>  Enable/disable cron job
!cron run <id>     Force run cron job
!cron status [id]  Show cron job status
!cron reload       Reload crons from file
!agent             List agents
!agent show <id>   Show agent details
!agent add <id> "<name>" [--model M] [--dir D]  Add agent
!agent remove <id> Remove agent
!agent reload      Reload agents from file
!help              Show this help`;
