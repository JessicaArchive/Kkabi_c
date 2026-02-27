import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ChannelType, ConversationRow, ExecutionRow } from "../types.js";

let db: Database.Database;

export function initDb(dbPath: string): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      channel TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt TEXT NOT NULL,
      output TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('success', 'error', 'timeout', 'cancelled')),
      channel TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_conv_chat_ts ON conversations(chat_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_exec_ts ON executions(timestamp);
  `);
}

export function getDb(): Database.Database {
  if (!db) throw new Error("Database not initialized. Call initDb() first.");
  return db;
}

export function saveMessage(row: ConversationRow): void {
  const stmt = getDb().prepare(`
    INSERT INTO conversations (role, content, channel, chat_id, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(row.role, row.content, row.channel, row.chatId, row.timestamp);
}

export function getRecentConversation(chatId: string, limit = 20): ConversationRow[] {
  const rows = getDb().prepare(`
    SELECT role, content, channel, chat_id as chatId, timestamp
    FROM conversations
    WHERE chat_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(chatId, limit) as ConversationRow[];
  return rows.reverse();
}

export function saveExecution(row: ExecutionRow): void {
  const stmt = getDb().prepare(`
    INSERT INTO executions (prompt, output, status, channel, chat_id, timestamp, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(row.prompt, row.output, row.status, row.channel, row.chatId, row.timestamp, row.durationMs);
}

export function getRecentExecutions(limit = 10): ExecutionRow[] {
  return getDb().prepare(`
    SELECT prompt, output, status, channel, chat_id as chatId, timestamp, duration_ms as durationMs
    FROM executions
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(limit) as ExecutionRow[];
}

export function closeDb(): void {
  if (db) db.close();
}
