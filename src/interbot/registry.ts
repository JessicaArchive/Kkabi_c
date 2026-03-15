import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export interface BotEntry {
  username: string;       // canonical id — set at runtime via registerBotUsername()
  workingDir: string;
  configPath: string;
  provider: string;
}

const botMap = new Map<string, BotEntry>();

export function loadBotRegistry(configDir?: string): Map<string, BotEntry> {
  const dir = configDir ?? resolve(process.cwd(), "configs");
  botMap.clear();

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return botMap;
  }

  for (const file of files) {
    const filePath = resolve(dir, file);
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      const token = raw.channels?.telegram?.botToken;
      if (!token) continue;

      const entry: BotEntry = {
        username: "",
        workingDir: raw.runner?.workingDir ?? raw.claude?.workingDir ?? "~",
        configPath: filePath,
        provider: raw.provider ?? "claude",
      };
      botMap.set(filePath, entry);
    } catch {
      // skip malformed config
    }
  }

  // Also load the main config.json
  const mainConfig = resolve(process.cwd(), "config.json");
  try {
    const raw = JSON.parse(readFileSync(mainConfig, "utf-8"));
    if (raw.channels?.telegram?.botToken) {
      botMap.set(mainConfig, {
        username: "",
        workingDir: raw.runner?.workingDir ?? raw.claude?.workingDir ?? "~",
        configPath: mainConfig,
        provider: raw.provider ?? "claude",
      });
    }
  } catch {
    // skip
  }

  return botMap;
}

export function getBotByUsername(username: string): BotEntry | undefined {
  for (const entry of botMap.values()) {
    if (entry.username === username) return entry;
  }
  return undefined;
}

export function registerBotUsername(configPath: string, username: string): void {
  const entry = botMap.get(configPath);
  if (entry) entry.username = username;
}

export function validateSenderWorkingDir(senderUsername: string, claimedWorkingDir: string): boolean {
  const entry = getBotByUsername(senderUsername);
  if (!entry) return false;
  const normalize = (p: string) => p.replace(/^~/, process.env.HOME ?? "").replace(/\/+$/, "");
  return normalize(entry.workingDir) === normalize(claimedWorkingDir);
}

export function getAllBotEntries(): BotEntry[] {
  return [...botMap.values()];
}
