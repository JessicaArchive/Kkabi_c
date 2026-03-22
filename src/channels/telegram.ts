import { Telegraf, Markup } from "telegraf";
import { createReadStream } from "node:fs";
import * as https from "node:https";
import { lookup } from "node:dns";
import type { Channel } from "./base.js";
import type { ChannelType, IncomingMessage } from "../types.js";
import type { TelegramConfig } from "../config.js";

const MAX_TEXT_LENGTH = 4096;

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

      const incoming: IncomingMessage = {
        id: String(msg.message_id),
        channel: "telegram",
        chatId: String(chatId),
        senderId: String(msg.from.id),
        senderName: msg.from.username ?? msg.from.first_name ?? "unknown",
        text: msg.text,
        threadId: msg.message_thread_id ? String(msg.message_thread_id) : undefined,
        timestamp: msg.date * 1000,
      };

      if (this.handler) {
        this.startTyping(String(chatId));
        try {
          await this.handler(incoming);
        } catch (err) {
          console.error("[Telegram] Handler error:", err);
        } finally {
          this.stopTyping(String(chatId));
        }
      }
    });

    // Handle confirm callback queries
    this.bot.on("callback_query", async (ctx) => {
      const data = (ctx.callbackQuery as any).data as string | undefined;
      console.log(`[Telegram] callback_query received: ${data}`);
      if (!data) return;

      await ctx.answerCbQuery();

      const [action, confirmId] = data.split(":");
      console.log(`[Telegram] action=${action}, confirmId=${confirmId}, pending=${this.pendingConfirms.size}`);
      const resolver = this.pendingConfirms.get(confirmId);
      if (resolver) {
        console.log(`[Telegram] Resolving confirm ${confirmId} → ${action}`);
        resolver(action === "approve");
        this.pendingConfirms.delete(confirmId);

        // Update the message to show result
        const label = action === "approve" ? "Approved" : "Denied";
        try {
          await ctx.editMessageReplyMarkup(undefined);
          await ctx.editMessageText(
            (ctx.callbackQuery as any).message.text + `\n\n→ ${label}`,
          );
        } catch {
          // ignore edit errors
        }
      }
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
    const confirmId = String(Date.now());
    const opts: any = {};
    if (threadId) opts.message_thread_id = Number(threadId);

    await this.bot.telegram.sendMessage(Number(chatId), text, {
      ...opts,
      ...Markup.inlineKeyboard([
        Markup.button.callback("Approve", `approve:${confirmId}`),
        Markup.button.callback("Deny", `deny:${confirmId}`),
      ]),
    });

    return new Promise<boolean>((resolve) => {
      this.pendingConfirms.set(confirmId, resolve);

      // 2분 타임아웃 — 응답 없으면 자동 거부
      setTimeout(() => {
        if (this.pendingConfirms.has(confirmId)) {
          console.log(`[Telegram] Confirm ${confirmId} timed out, auto-denying`);
          this.pendingConfirms.delete(confirmId);
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
