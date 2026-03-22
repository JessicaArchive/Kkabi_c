import { Telegraf } from "telegraf";
import { createReadStream } from "node:fs";
import * as https from "node:https";
import { lookup } from "node:dns";
import type { Channel } from "./base.js";
import type { ChannelType, IncomingMessage } from "../types.js";
import type { TelegramConfig } from "../config.js";

const MAX_TEXT_LENGTH = 4096;

const AFFIRM_RE = /^(응|ㅇ|ㅇㅇ|네|넹|넵|예|yes|y|ok|ㅇㅋ|확인|고|ㄱ|ㄱㄱ|해|해줘|ㅇㅇㅇ|당연|물론|승인|approve)$/i;
const DENY_RE = /^(아니|ㄴ|ㄴㄴ|노|no|n|취소|안해|하지마|deny|거부|ㄴㅇ)$/i;

// Node.js 22의 autoSelectFamily가 IPv6를 먼저 시도 → 텔레그램 IPv6 연결 실패 → ETIMEDOUT.
// IPv4 전용 lookup으로 우회.
const telegramAgent = new https.Agent({
  keepAlive: false,
  timeout: 30000,
  lookup: (hostname, options, cb) => {
    const opts = typeof options === "object" ? options : {};
    lookup(hostname, { ...opts, family: 4 }, cb as any);
  },
});

export class TelegramChannel implements Channel {
  readonly type: ChannelType = "telegram";
  private bot: Telegraf;
  private botUsername = "";
  private handler: ((msg: IncomingMessage) => Promise<void>) | null = null;
  private pendingConfirms = new Map<string, (approved: boolean) => void>();
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  constructor(private config: TelegramConfig) {
    this.bot = new Telegraf(config.botToken, {
      handlerTimeout: 600_000,
      telegram: { agent: telegramAgent },
    });
    this.bot.catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("timed out") || msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET")) {
        console.warn("[Telegram] Polling recoverable error (will retry):", msg.slice(0, 120));
      } else if (msg.includes("409")) {
        console.error("[Telegram] Duplicate bot instance detected — another process is polling with the same token");
      } else {
        console.error("[Telegram] Bot error:", msg.slice(0, 200));
      }
    });
    this.setupListeners();
  }

  private setupListeners(): void {
    this.bot.on("text", async (ctx) => {
      const msg = ctx.message;
      const chatId = msg.chat.id;

      // Check allowed chat IDs
      if (
        this.config.allowedChatIds.length > 0 &&
        !this.config.allowedChatIds.includes(chatId)
      ) {
        return;
      }

      // 텍스트 기반 승인 체크 — pendingConfirm이 있으면 자연어 매칭
      const strChatId = String(chatId);
      const resolver = this.pendingConfirms.get(strChatId);
      if (resolver) {
        const text = msg.text.trim();
        if (AFFIRM_RE.test(text)) {
          this.pendingConfirms.delete(strChatId);
          resolver(true);
          return;
        }
        if (DENY_RE.test(text)) {
          this.pendingConfirms.delete(strChatId);
          resolver(false);
          return;
        }
        // 패턴에 안 맞으면 일반 메시지로 처리 (fall through)
      }

      const incoming: IncomingMessage = {
        id: String(msg.message_id),
        channel: "telegram",
        chatId: strChatId,
        senderId: String(msg.from.id),
        senderName: msg.from.username ?? msg.from.first_name ?? "unknown",
        text: msg.text,
        threadId: msg.message_thread_id ? String(msg.message_thread_id) : undefined,
        timestamp: msg.date * 1000,
      };

      if (this.handler) {
        this.startTyping(strChatId);
        try {
          await this.handler(incoming);
        } catch (err) {
          console.error("[Telegram] Handler error:", err);
        } finally {
          this.stopTyping(strChatId);
        }
      }
    });

    // 레거시 callback_query 처리 (이전에 보낸 버튼이 남아있을 수 있음)
    this.bot.on("callback_query", async (ctx) => {
      await ctx.answerCbQuery("텍스트로 응답해주세요 (응/아니)");
    });
  }

  async start(): Promise<void> {
    const botInfo = await this.bot.telegram.getMe();
    this.botUsername = botInfo.username ?? "";
    await this.bot.telegram.deleteWebhook({ drop_pending_updates: true });
    this.launchWithRetry();
    console.log(`[Telegram] Bot started: @${this.botUsername}`);
  }

  private launchWithRetry(attempt = 0): void {
    const maxRetries = 5;
    // launch()는 resolve되지 않으므로 (계속 폴링) .catch로 에러만 처리
    this.bot.launch({ dropPendingUpdates: true }).catch(async (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("409") && attempt < maxRetries) {
        const delay = (attempt + 1) * 3000;
        console.warn(`[Telegram] @${this.botUsername} 409 conflict, retry ${attempt + 1}/${maxRetries} in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        // 새 Telegraf 인스턴스 필요 — 기존 polling 인스턴스는 재사용 불가
        this.bot = new Telegraf(this.config.botToken, {
          handlerTimeout: 600_000,
          telegram: { agent: telegramAgent },
        });
        this.bot.catch((e: unknown) => {
          const m = e instanceof Error ? e.message : String(e);
          if (m.includes("timed out") || m.includes("ETIMEDOUT") || m.includes("ECONNRESET")) {
            console.warn("[Telegram] Polling recoverable error (will retry):", m.slice(0, 120));
          } else if (m.includes("409")) {
            console.error("[Telegram] Duplicate bot instance detected");
          } else {
            console.error("[Telegram] Bot error:", m.slice(0, 200));
          }
        });
        this.setupListeners();
        this.launchWithRetry(attempt + 1);
      } else {
        console.error(`[Telegram] @${this.botUsername} polling stopped:`, msg.slice(0, 150));
      }
    });
  }

  getBotUsername(): string {
    return this.botUsername;
  }

  async stop(): Promise<void> {
    this.bot.stop("SIGTERM");
    console.log("[Telegram] Bot stopped");
  }

  async sendText(chatId: string, text: string, threadId?: string): Promise<string> {
    const chunks = splitText(text, MAX_TEXT_LENGTH);
    let firstMsgId = "";

    for (const chunk of chunks) {
      const opts: any = {};
      if (threadId) opts.message_thread_id = Number(threadId);

      const result = await this.trySend(Number(chatId), chunk, opts);
      if (result && !firstMsgId) firstMsgId = String(result.message_id);
    }

    return firstMsgId;
  }

  private async trySend(
    chatId: number,
    text: string,
    opts: any,
    retries = 2,
  ): Promise<{ message_id: number } | null> {
    for (let i = 0; i <= retries; i++) {
      try {
        return await this.bot.telegram.sendMessage(chatId, text, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isRetryable = msg.includes("timed out") || msg.includes("ETIMEDOUT")
          || msg.includes("ECONNRESET") || msg.includes("429");
        if (!isRetryable || i === retries) {
          console.error(`[Telegram] sendMessage failed (attempt ${i + 1}):`, msg.slice(0, 150));
          if (i === retries) return null;
          throw err;
        }
        const delay = (i + 1) * 2000;
        console.warn(`[Telegram] Send retry ${i + 1}/${retries} in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    return null;
  }

  async sendFile(chatId: string, filePath: string, threadId?: string): Promise<void> {
    const opts: any = {};
    if (threadId) opts.message_thread_id = Number(threadId);

    await this.bot.telegram.sendDocument(
      Number(chatId),
      { source: createReadStream(filePath) },
      opts,
    );
  }

  async editMessage(chatId: string, msgId: string, text: string): Promise<void> {
    const truncated =
      text.length > MAX_TEXT_LENGTH
        ? text.slice(0, MAX_TEXT_LENGTH - 20) + "\n\n... (truncated)"
        : text;

    try {
      await this.bot.telegram.editMessageText(
        Number(chatId),
        Number(msgId),
        undefined,
        truncated,
      );
    } catch {
      // If edit fails, send new message
      await this.sendText(chatId, text);
    } finally {
      this.stopTyping(chatId);
    }
  }

  async sendConfirm(chatId: string, text: string, threadId?: string): Promise<boolean> {
    const opts: any = {};
    if (threadId) opts.message_thread_id = Number(threadId);

    await this.bot.telegram.sendMessage(
      Number(chatId),
      `${text}\n\n(응/ㅇㅇ → 승인, 아니/ㄴ → 거부)`,
      opts,
    );

    return new Promise<boolean>((resolve) => {
      this.pendingConfirms.set(chatId, resolve);

      // 2분 타임아웃 — 응답 없으면 자동 거부
      setTimeout(() => {
        if (this.pendingConfirms.has(chatId)) {
          console.log(`[Telegram] Confirm for chat ${chatId} timed out, auto-denying`);
          this.pendingConfirms.delete(chatId);
          resolve(false);
        }
      }, 120_000);
    });
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler;
  }

  private startTyping(chatId: string): void {
    // Send immediately, then repeat every 4s (Telegram typing expires after 5s)
    const numChatId = Number(chatId);
    this.bot.telegram.sendChatAction(numChatId, "typing").catch(() => {});

    const interval = setInterval(() => {
      this.bot.telegram.sendChatAction(numChatId, "typing").catch(() => {});
    }, 4000);

    this.typingIntervals.set(chatId, interval);
  }

  private stopTyping(chatId: string): void {
    const interval = this.typingIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(chatId);
    }
  }
}

function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx === -1 || splitIdx < maxLen * 0.5) {
      splitIdx = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitIdx === -1 || splitIdx < maxLen * 0.5) {
      splitIdx = maxLen;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}
