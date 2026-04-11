import { join, resolve } from "node:path";
import { getConfig } from "./config.js";

function expandHome(path: string): string {
  if (path === "~") {
    return process.env.HOME ?? path;
  }
  if (path.startsWith("~/")) {
    return join(process.env.HOME ?? "~", path.slice(2));
  }
  return path;
}

export function getDataDir(): string {
  try {
    const config = getConfig();
    if (config.dataDir) {
      return resolve(expandHome(config.dataDir));
    }
  } catch {
    // Config may not be loaded yet.
  }
  return resolve(process.cwd(), "data");
}

export function getDataPath(...parts: string[]): string {
  return resolve(getDataDir(), ...parts);
}

export function getDbPath(): string {
  return getDataPath("kkabi.db");
}

export function getLocalOutputLogPath(): string {
  return getDataPath("local-output.log");
}

export function getCronsFile(): string {
  return getDataPath("crons.json");
}

export function getCronRunsDir(): string {
  return getDataPath("cron-runs");
}

export function getAgentsFile(): string {
  return getDataPath("agents.json");
}

export function getQueueFile(): string {
  return getDataPath("queue.json");
}

export function getMemoryLogsDir(): string {
  return getDataPath("memory", "logs");
}

export function getMemoryFile(): string {
  return getDataPath("memory", "MEMORY.md");
}

export function getPersonaDir(): string {
  return getDataPath("persona");
}

export function getChatSessionsDir(): string {
  return getDataPath("chat-sessions");
}

export function getPromptsDir(): string {
  return getDataPath("prompts");
}

export function getSessionsFile(): string {
  return getDataPath("sessions.json");
}
