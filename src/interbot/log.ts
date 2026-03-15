import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getDataPath } from "../paths.js";

export interface GroupChatLogEntry {
  ts: string;
  bot: string;
  role: "user" | "assistant" | "system" | "bot";
  from?: string;
  type?: string;     // review_request, review_response, review_reply
  reqId?: string;     // for tracking review sessions
  text: string;
}

export function appendGroupChatLog(chatId: string, entry: GroupChatLogEntry): void {
  const logPath = getDataPath("group_chat", `${chatId}.jsonl`);
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
}
