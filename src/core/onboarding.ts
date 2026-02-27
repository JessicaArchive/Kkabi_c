import type { Channel } from "../channels/base.js";
import { getRecentConversation } from "../db/store.js";
import { updateSoul, updateUser, updateMood } from "../memory/persona.js";

const activeSetups = new Map<string, OnboardingState>();

interface OnboardingState {
  step: "soul" | "user" | "mood" | "done";
}

const WELCOME = `Hello! I'm *Kkabi*.
It looks like this is your first time! Let's do a quick setup.
(Type \`!skip\` at any step to skip it)

*1/3 — Kkabi's Personality*
What kind of personality or tone would you like Kkabi to have?
Examples: "casual and friendly", "polite and formal", "direct and developer-like"`;

const ASK_USER = `*2/3 — About You*
Tell me about yourself. Kkabi will use this as context during conversations.
Examples: "Backend developer, mainly uses TypeScript, name is Jessica"`;

const ASK_MOOD = `*3/3 — Kkabi's Default Mode*
Set Kkabi's default working mode.
Examples: "focus on code reviews", "free-form conversation", "concise and work-oriented"`;

const DONE = `Setup complete! Feel free to talk to me anytime.
You can modify these settings at any time with \`!persona\`.`;

export function isFirstTime(chatId: string): boolean {
  const history = getRecentConversation(chatId, 1);
  return history.length === 0;
}

export function isInSetup(chatId: string): boolean {
  return activeSetups.has(chatId);
}

export async function startOnboarding(channel: Channel, chatId: string): Promise<void> {
  activeSetups.set(chatId, { step: "soul" });
  await channel.sendText(chatId, WELCOME);
}

export async function handleOnboardingStep(
  channel: Channel,
  chatId: string,
  text: string,
): Promise<boolean> {
  const state = activeSetups.get(chatId);
  if (!state) return false;

  const skip = text.trim() === "!skip";

  switch (state.step) {
    case "soul":
      if (!skip) updateSoul(`# Kkabi\n${text}`);
      state.step = "user";
      await channel.sendText(chatId, ASK_USER);
      return true;

    case "user":
      if (!skip) updateUser(`# User Info\n${text}`);
      state.step = "mood";
      await channel.sendText(chatId, ASK_MOOD);
      return true;

    case "mood":
      if (!skip) updateMood(`# Default Mode\n${text}`);
      activeSetups.delete(chatId);
      await channel.sendText(chatId, DONE);
      return true;

    default:
      activeSetups.delete(chatId);
      return false;
  }
}
