import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { initDb, closeDb } from "./db/store.js";
import { SlackChannel } from "./channels/slack.js";
import { GitHubChannel } from "./channels/github.js";
import { createHandler } from "./core/handler.js";
import { startAllCrons, stopAllCrons, setCronSendCallback } from "./scheduler/cron.js";
import { cleanOldLogs } from "./memory/manager.js";
import { cancelCurrent } from "./claude/runner.js";
import type { Channel } from "./channels/base.js";
import type { ChannelType } from "./types.js";

const channels = new Map<ChannelType, Channel>();

async function main(): Promise<void> {
  console.log("Kkabi starting up...");

  // Load config
  const config = loadConfig();
  console.log("[Config] Loaded");

  // Init DB
  const dbPath = resolve(process.cwd(), "data", "kkabi.db");
  initDb(dbPath);
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

  // Set up cron send callback
  setCronSendCallback(async (channelType: ChannelType, chatId: string, text: string) => {
    const ch = channels.get(channelType);
    if (ch) {
      await ch.sendText(chatId, text);
    }
  });

  // Start cron jobs
  if (config.scheduler.enabled) {
    startAllCrons();
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

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
