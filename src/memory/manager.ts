import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { getConfig } from "../config.js";

const DATA_DIR = resolve(process.cwd(), "data");
const MEMORY_DIR = join(DATA_DIR, "memory");
const LOGS_DIR = join(MEMORY_DIR, "logs");
const MEMORY_FILE = join(MEMORY_DIR, "MEMORY.md");

function ensureDirs(): void {
  mkdirSync(LOGS_DIR, { recursive: true });
}

export function readMemory(): string {
  ensureDirs();
  if (!existsSync(MEMORY_FILE)) return "";
  return readFileSync(MEMORY_FILE, "utf-8");
}

export function writeMemory(content: string): void {
  ensureDirs();
  writeFileSync(MEMORY_FILE, content, "utf-8");
}

export function appendMemory(line: string): void {
  ensureDirs();
  const current = readMemory();
  const updated = current ? `${current}\n${line}` : line;
  writeFileSync(MEMORY_FILE, updated, "utf-8");
}

export function clearMemory(): void {
  ensureDirs();
  writeFileSync(MEMORY_FILE, "", "utf-8");
}

// Daily log

function todayLogPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return join(LOGS_DIR, `${date}.md`);
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
  const files = readdirSync(LOGS_DIR).filter((f) => f.endsWith(".md"));

  for (const file of files) {
    const dateStr = file.replace(".md", "");
    const fileDate = new Date(dateStr).getTime();
    if (!isNaN(fileDate) && fileDate < cutoff) {
      unlinkSync(join(LOGS_DIR, file));
    }
  }
}
