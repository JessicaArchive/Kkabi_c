import type { Channel } from "../channels/base.js";
import { updateSoul, updateUser, updateMood, setLang, isOnboardingDone } from "../memory/persona.js";
import type { Lang } from "../memory/persona.js";

const activeSetups = new Map<string, OnboardingState>();

interface OnboardingState {
  step: "lang" | "soul" | "user" | "mood" | "done";
  lang: Lang;
}

// Language selection — shown in both languages
const ASK_LANG = `Hello! I'm *Kkabi*.
안녕! 나는 *깨비*야.

Choose your language / 언어를 선택해줘:
1️⃣ 한국어
2️⃣ English`;

const MESSAGES = {
  welcome: {
    ko: `좋아! 한국어로 갈게.
처음이니까 간단하게 세팅하자.
(각 단계에서 \`!skip\` 치면 넘어갈 수 있어)

*1/3 — 깨비 성격*
깨비가 어떤 말투/성격이면 좋겠어?
예: "반말, 간결하게, 팩트 위주", "존댓말, 친절하게"`,
    en: `Great! Let's go with English.
It looks like this is your first time! Let's do a quick setup.
(Type \`!skip\` at any step to skip it)

*1/3 — Kkabi's Personality*
What kind of personality or tone would you like Kkabi to have?
Examples: "casual and friendly", "polite and formal", "direct and developer-like"`,
  },
  askUser: {
    ko: `*2/3 — 너에 대해*
너에 대해 알려줘. 대화할 때 참고할게.
예: "백엔드 개발자, TypeScript 주로 씀"`,
    en: `*2/3 — About You*
Tell me about yourself. Kkabi will use this as context during conversations.
Examples: "Backend developer, mainly uses TypeScript, name is Jessica"`,
  },
  askMood: {
    ko: `*3/3 — 기본 모드*
깨비의 기본 작업 모드를 설정해줘.
예: "코드 리뷰 위주", "자유 대화", "간결하게 업무 중심"`,
    en: `*3/3 — Kkabi's Default Mode*
Set Kkabi's default working mode.
Examples: "focus on code reviews", "free-form conversation", "concise and work-oriented"`,
  },
  done: {
    ko: `세팅 완료! 이제 편하게 말 걸어.
설정은 언제든 \`!persona\`로 바꿀 수 있어.`,
    en: `Setup complete! Feel free to talk to me anytime.
You can modify these settings at any time with \`!persona\`.`,
  },
};

export function isFirstTime(): boolean {
  return !isOnboardingDone();
}

export function isInSetup(chatId: string): boolean {
  return activeSetups.has(chatId);
}

export async function startOnboarding(channel: Channel, chatId: string): Promise<void> {
  activeSetups.set(chatId, { step: "lang", lang: "en" });
  await channel.sendText(chatId, ASK_LANG);
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
    case "lang": {
      const input = text.trim();
      if (input.includes("한국어") || input === "1" || input === "1️⃣") {
        state.lang = "ko";
      } else {
        state.lang = "en";
      }
      setLang(state.lang);
      state.step = "soul";
      await channel.sendText(chatId, MESSAGES.welcome[state.lang]);
      return true;
    }

    case "soul":
      if (!skip) updateSoul(`# Kkabi\n${text}`);
      state.step = "user";
      await channel.sendText(chatId, MESSAGES.askUser[state.lang]);
      return true;

    case "user":
      if (!skip) updateUser(`# User Info\n${text}`);
      state.step = "mood";
      await channel.sendText(chatId, MESSAGES.askMood[state.lang]);
      return true;

    case "mood":
      if (!skip) updateMood(`# Default Mode\n${text}`);
      activeSetups.delete(chatId);
      await channel.sendText(chatId, MESSAGES.done[state.lang]);
      return true;

    default:
      activeSetups.delete(chatId);
      return false;
  }
}
