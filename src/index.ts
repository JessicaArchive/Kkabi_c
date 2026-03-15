import { dirname } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { loadConfig } from "./config.js";
import { getDataPath } from "./paths.js";
import { initDb, closeDb } from "./db/store.js";
import { SlackChannel } from "./channels/slack.js";
import { GitHubChannel } from "./channels/github.js";
import { TelegramChannel } from "./channels/telegram.js";
import { createHandler } from "./core/handler.js";
import { syncWorkingDirFromConfig, getWorkingDir } from "./core/commands.js";
import { initProjectCommands } from "./project-commands/registry.js";
import { startAllCrons, stopAllCrons, setCronSendCallback } from "./scheduler/cron.js";
import { cleanOldLogs } from "./memory/manager.js";
import { cancelCurrent } from "./claude/runner.js";
import { createDashboardServer } from "./dashboard/server.js";
import { getDbPath, getLocalOutputLogPath } from "./paths.js";
import type { Channel } from "./channels/base.js";
import { setQueueLimits } from "./claude/queue.js";
import { loadBotRegistry, registerBotUsername } from "./interbot/registry.js";
import type { ChannelType } from "./types.js";

const channels = new Map<ChannelType, Channel>();

function getConfigPathFromArgs(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") {
      return argv[i + 1];
    }
    if (argv[i].startsWith("--config=")) {
      return argv[i].slice("--config=".length);
    }
  }
  return undefined;
}

function localSend(text: string): void {
  const localOutputLog = getLocalOutputLogPath();
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${text}`;
  console.log(line);
  mkdirSync(dirname(localOutputLog), { recursive: true });
  appendFileSync(localOutputLog, line + "\n", "utf-8");
}

async function main(): Promise<void> {
  console.log("Kkabi starting up...");

  // Load config
  const configPath = getConfigPathFromArgs(process.argv.slice(2));
  const config = loadConfig(configPath);
  syncWorkingDirFromConfig();
  initProjectCommands(getWorkingDir(), config.projectType);
  const provider = config.provider ?? "claude";

  // Set queue limits from runner config
  const runner = config.runner ?? config.claude;
  setQueueLimits(
    runner.maxConcurrent,
    (config.runner as any)?.maxPerWorkingDir ?? 1,
  );

  console.log(`[Config] Loaded (provider: ${provider})`);

  // Load bot registry for interbot validation
  if (config.interbot?.enabled) {
    loadBotRegistry();
    console.log("[Interbot] Bot registry loaded");
  }

  // Init DB
  initDb(getDbPath());
  console.log("[DB] Initialized");

  // Clean old logs
  cleanOldLogs();

  // Start channels
  if (config.channels.slack?.enabled) {
    const slack = new SlackChannel(config.channels.slack);
    const handler = createHandler(slack);
    slack.onMessage(handler);
    await slack.start();
    channels.set("slack", slack);
  }

  if (config.channels.github?.enabled) {
    const github = new GitHubChannel(config.channels.github);
    const handler = createHandler(github);
    github.onMessage(handler);
    await github.start();
    channels.set("github", github);
  }

  if (config.channels.telegram?.enabled) {
    const telegram = new TelegramChannel(config.channels.telegram);
    await telegram.start();
    const botUsername = telegram.getBotUsername();

    // Register this bot's username in the interbot registry
    if (config.interbot?.enabled && botUsername) {
      const resolvedConfigPath = configPath ?? "config.json";
      const { resolve } = await import("node:path");
      registerBotUsername(resolve(process.cwd(), resolvedConfigPath), botUsername);
      console.log(`[Interbot] Registered @${botUsername}`);
    }

    const handler = createHandler(telegram, { provider, botUsername });
    telegram.onMessage(handler);
    channels.set("telegram", telegram);
  }

  // Set up cron send callback
  setCronSendCallback(async (channelType: ChannelType, chatId: string, text: string) => {
    if (channelType === "local") {
      localSend(text);
      return;
    }
    const ch = channels.get(channelType);
    if (ch) {
      await ch.sendText(chatId, text);
    }
  });

  // Start cron jobs
  if (config.scheduler.enabled) {
    startAllCrons();
  }

  // Start dashboard
  if (config.dashboard.enabled) {
    createDashboardServer(config.dashboard.port);
  }

  console.log("Kkabi is ready!");
}

// Graceful shutdown
function shutdown(signal: string): void {
  console.log(`\n[${signal}] Shutting down...`);

  cancelCurrent();
  stopAllCrons();

  for (const [type, ch] of channels) {
    ch.stop().catch((err) => console.error(`[${type}] Stop error:`, err));
  }

  closeDb();
  console.log("Kkabi stopped.");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Crash protection: log errors instead of dying silently
function logCrash(type: string, err: unknown): void {
  const timestamp = new Date().toISOString();
  const message = err instanceof Error
    ? `${err.message}\n${err.stack}`
    : String(err);
  const line = `[${timestamp}] [${type}] ${message}\n`;

  console.error(line);

  try {
    const crashLog = getDataPath("crash.log");
    mkdirSync(dirname(crashLog), { recursive: true });
    appendFileSync(crashLog, line, "utf-8");
  } catch {
    // If we can't write the log, at least stderr got it
  }
}

process.on("uncaughtException", (err) => {
  logCrash("uncaughtException", err);
  // Don't exit — keep the bot alive
});

process.on("unhandledRejection", (reason) => {
  logCrash("unhandledRejection", reason);
  // Don't exit — keep the bot alive
});

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
