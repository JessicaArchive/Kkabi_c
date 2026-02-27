import { getRecentConversation } from "../db/store.js";
import { readMemory } from "../memory/manager.js";
import { loadPersona } from "../memory/persona.js";

export function buildPrompt(userMessage: string, chatId: string): string {
  const parts: string[] = [];

  // System persona
  const persona = loadPersona();
  if (persona.soul) {
    parts.push(`[SOUL]\n${persona.soul}`);
  }
  if (persona.user) {
    parts.push(`[USER INFO]\n${persona.user}`);
  }
  if (persona.mood) {
    parts.push(`[MOOD]\n${persona.mood}`);
  }

  // Memory
  const memory = readMemory();
  if (memory) {
    parts.push(`[MEMORY]\n${memory}`);
  }

  // Recent conversation context
  const recent = getRecentConversation(chatId, 20);
  if (recent.length > 0) {
    const history = recent
      .map((r) => `${r.role === "user" ? "User" : "Assistant"}: ${r.content}`)
      .join("\n");
    parts.push(`[CONVERSATION HISTORY]\n${history}`);
  }

  // Current message
  parts.push(`[CURRENT MESSAGE]\nUser: ${userMessage}`);

  return parts.join("\n\n");
}
