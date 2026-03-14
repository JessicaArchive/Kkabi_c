import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "../config.js";
import { getMemoryFile, getMemoryLogsDir } from "../paths.js";

function ensureDirs(): void {
  mkdirSync(getMemoryLogsDir(), { recursive: true });
}

export function readMemory(): string {
  const memoryFile = getMemoryFile();
  ensureDirs();
  if (!existsSync(memoryFile)) return "";
  return readFileSync(memoryFile, "utf-8");
}

export function writeMemory(content: string): void {
  const memoryFile = getMemoryFile();
  ensureDirs();
  writeFileSync(memoryFile, content, "utf-8");
}

export function appendMemory(line: string): void {
  ensureDirs();
  const current = readMemory();
  const updated = current ? `${current}\n${line}` : line;
  writeMemory(updated);
}

export function clearMemory(): void {
  writeMemory("");
}

// Daily log

function todayLogPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return join(getMemoryLogsDir(), `${date}.md`);
}

export function appendDailyLog(entry: string): void {
  ensureDirs();
  const logPath = todayLogPath();
  const timestamp = new Date().toLocaleTimeString("en-US");
  const line = `- [${timestamp}] ${entry}\n`;

  if (existsSync(logPath)) {
    const current = readFileSync(logPath, "utf-8");
    writeFileSync(logPath, current + line, "utf-8");
  } else {
    const header = `# ${new Date().toISOString().slice(0, 10)}\n\n`;
    writeFileSync(logPath, header + line, "utf-8");
  }
}

export function cleanOldLogs(): void {
  const config = getConfig();
  const retentionDays = config.memory.logRetentionDays;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  ensureDirs();
  const logsDir = getMemoryLogsDir();
  const files = readdirSync(logsDir).filter((f) => f.endsWith(".md"));

  for (const file of files) {
    const dateStr = file.replace(".md", "");
    const fileDate = new Date(dateStr).getTime();
    if (!isNaN(fileDate) && fileDate < cutoff) {
      unlinkSync(join(logsDir, file));
    }
  }
}
