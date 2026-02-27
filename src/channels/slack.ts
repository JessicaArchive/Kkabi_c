import { App } from "@slack/bolt";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { Channel } from "./base.js";
import type { ChannelType, IncomingMessage } from "../types.js";
import type { SlackConfig } from "../config.js";

const MAX_TEXT_LENGTH = 4000;

export class SlackChannel implements Channel {
  readonly type: ChannelType = "slack";
  private app: App;
  private handler: ((msg: IncomingMessage) => Promise<void>) | null = null;
  private pendingConfirms = new Map<string, (approved: boolean) => void>();

  constructor(private config: SlackConfig) {
    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
    });

    this.setupListeners();
  }

  private setupListeners(): void {
    // Listen to DM messages
    this.app.message(async ({ message, say }) => {
      const msg = message as any;

      // Ignore bot messages and subtypes
      if (msg.subtype || msg.bot_id) return;
      if (!msg.text) return;

      // Check allowed channels
      if (
        this.config.allowedChannels.length > 0 &&
        !this.config.allowedChannels.includes(msg.channel)
      ) {
        return;
      }

      const incoming: IncomingMessage = {
        id: msg.ts,
        channel: "slack",
        chatId: msg.channel,
        senderId: msg.user ?? "unknown",
        senderName: msg.user ?? "unknown",
        text: msg.text,
        threadId: msg.thread_ts,
        timestamp: Date.now(),
      };

      // Handle file attachments
      if (msg.files && msg.files.length > 0) {
        incoming.files = msg.files.map((f: any) => ({
          name: f.name ?? "file",
          url: f.url_private ?? "",
          mimeType: f.mimetype,
        }));
      }

      if (this.handler) {
        try {
          await this.handler(incoming);
        } catch (err) {
          console.error("[Slack] Handler error:", err);
        }
      }
    });

    // Handle confirm button actions
    this.app.action("confirm_approve", async ({ ack, body }) => {
      await ack();
      const actionId = (body as any).message?.ts;
      const resolver = this.pendingConfirms.get(actionId);
      if (resolver) {
        resolver(true);
        this.pendingConfirms.delete(actionId);
      }
    });

    this.app.action("confirm_deny", async ({ ack, body }) => {
      await ack();
      const actionId = (body as any).message?.ts;
      const resolver = this.pendingConfirms.get(actionId);
      if (resolver) {
        resolver(false);
        this.pendingConfirms.delete(actionId);
      }
    });
  }

  async start(): Promise<void> {
    await this.app.start();
    console.log("[Slack] Connected via Socket Mode");
  }

  async stop(): Promise<void> {
    await this.app.stop();
    console.log("[Slack] Disconnected");
  }

  async sendText(chatId: string, text: string, threadId?: string): Promise<string> {
    // Split long messages
    const chunks = splitText(text, MAX_TEXT_LENGTH);

    let firstTs = "";
    for (const chunk of chunks) {
      const result = await this.app.client.chat.postMessage({
        channel: chatId,
        text: chunk,
        thread_ts: threadId,
      });
      if (!firstTs && result.ts) firstTs = result.ts;
    }
    return firstTs;
  }

  async sendFile(chatId: string, filePath: string, threadId?: string): Promise<void> {
    const opts: any = {
      channel_id: chatId,
      file: createReadStream(filePath),
      filename: basename(filePath),
    };
    if (threadId) opts.thread_ts = threadId;
    await this.app.client.files.uploadV2(opts);
  }

  async editMessage(chatId: string, msgId: string, text: string): Promise<void> {
    const truncated = text.length > MAX_TEXT_LENGTH
      ? text.slice(0, MAX_TEXT_LENGTH - 20) + "\n\n... (truncated)"
      : text;

    try {
      await this.app.client.chat.update({
        channel: chatId,
        ts: msgId,
        text: truncated,
      });
    } catch {
      // If edit fails (e.g., too old), send new message
      await this.sendText(chatId, text);
    }
  }

  async sendConfirm(chatId: string, text: string, threadId?: string): Promise<boolean> {
    const result = await this.app.client.chat.postMessage({
      channel: chatId,
      text,
      thread_ts: threadId,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Approve" },
              style: "primary",
              action_id: "confirm_approve",
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Deny" },
              style: "danger",
              action_id: "confirm_deny",
            },
          ],
        },
      ],
    });

    const msgTs = result.ts!;

    return new Promise<boolean>((resolve) => {
      this.pendingConfirms.set(msgTs, resolve);
    });
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler;
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

    // Try to split at newline
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx === -1 || splitIdx < maxLen * 0.5) {
      // Try space
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
