import type { Channel } from "../channels/base.js";
import { getRecentConversation } from "../db/store.js";
import { updateSoul, updateUser, updateMood } from "../memory/persona.js";

const activeSetups = new Map<string, OnboardingState>();

interface OnboardingState {
  step: "soul" | "user" | "mood" | "done";
}

const WELCOME = `🐾 안녕하세요! 저는 *까비(Kkabi)* 입니다.
처음이시네요! 간단한 설정을 하고 시작할게요.
(건너뛰려면 아무 단계에서나 \`!skip\` 입력)

*1/3 — 까비의 성격*
까비가 어떤 말투/성격이면 좋을까요?
예: "반말로 편하게", "존댓말로 정중하게", "개발자처럼 직설적으로"`;

const ASK_USER = `*2/3 — 사용자 정보*
본인에 대해 알려주세요. 까비가 대화할 때 참고합니다.
예: "백엔드 개발자, TypeScript 주로 씀, 이름은 제시카"`;

const ASK_MOOD = `*3/3 — 까비 기본 모드*
까비의 기본 작업 모드를 설정해주세요.
예: "코드 리뷰 위주", "자유롭게 대화", "업무 중심 간결하게"`;

const DONE = `✅ 설정 완료! 이제 편하게 말 걸어주세요.
\`!persona\` 로 언제든 수정 가능합니다.`;

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
      if (!skip) updateSoul(`# Kkabi (까비)\n${text}`);
      state.step = "user";
      await channel.sendText(chatId, ASK_USER);
      return true;

    case "user":
      if (!skip) updateUser(`# 사용자 정보\n${text}`);
      state.step = "mood";
      await channel.sendText(chatId, ASK_MOOD);
      return true;

    case "mood":
      if (!skip) updateMood(`# 기본 모드\n${text}`);
      activeSetups.delete(chatId);
      await channel.sendText(chatId, DONE);
      return true;

    default:
      activeSetups.delete(chatId);
      return false;
  }
}
