import { Telegraf, Markup } from "telegraf";
import { createReadStream } from "node:fs";
import * as https from "node:https";
import type { Channel } from "./base.js";
import type { ChannelType, IncomingMessage } from "../types.js";
import type { TelegramConfig } from "../config.js";

const MAX_TEXT_LENGTH = 4096;

// keepAlive OFF: 크론잡이 6시간 간격이라 유휴 소켓이 죽은 채 풀에 남아있음.
// 매 요청마다 새 연결을 만드는 게 안정적.
const telegramAgent = new https.Agent({
  keepAlive: false,
  timeout: 30000,
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
      if (!data) return;

      await ctx.answerCbQuery();

      const [action, confirmId] = data.split(":");
      const resolver = this.pendingConfirms.get(confirmId);
      if (resolver) {
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
    // launch() never resolves (it keeps polling), so don't await it
    this.bot.launch({ dropPendingUpdates: true });
    console.log(`[Telegram] Bot started: @${this.botUsername}`);
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

      const result = await this.bot.telegram.sendMessage(Number(chatId), chunk, opts);
      if (!firstMsgId) firstMsgId = String(result.message_id);
    }

    return firstMsgId;
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
