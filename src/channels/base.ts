import type { ChannelType, IncomingMessage } from "../types.js";

export interface Channel {
  readonly type: ChannelType;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendText(chatId: string, text: string, threadId?: string): Promise<string>;
  sendFile(chatId: string, filePath: string, threadId?: string): Promise<void>;
  editMessage(chatId: string, msgId: string, text: string): Promise<void>;
  sendConfirm(chatId: string, text: string, threadId?: string): Promise<boolean>;
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void;
}
