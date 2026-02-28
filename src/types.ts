export type ChannelType = "slack" | "github" | "gchat";

export interface IncomingMessage {
  id: string;
  channel: ChannelType;
  chatId: string;
  senderId: string;
  senderName: string;
  text: string;
  files?: FileAttachment[];
  threadId?: string;
  timestamp: number;
}

export interface FileAttachment {
  name: string;
  url: string;
  mimeType?: string;
  localPath?: string;
}

export interface OutgoingMessage {
  chatId: string;
  text: string;
  files?: string[];
  threadId?: string;
}

export interface CommandResult {
  text: string;
  files?: string[];
}

export interface ClaudeResult {
  output: string;
  error?: string;
  timedOut: boolean;
}

export interface QueueItem {
  id: string;
  prompt: string;
  chatId: string;
  channel: ChannelType;
  workingDir?: string;
  resolve: (result: ClaudeResult) => void;
  reject: (error: Error) => void;
}

export interface CronJob {
  id: string;
  schedule: string;
  prompt: string;
  channelType: ChannelType;
  chatId: string;
  enabled: boolean;
  createdAt: number;
}

export interface ConversationRow {
  id?: number;
  role: "user" | "assistant";
  content: string;
  channel: ChannelType;
  chatId: string;
  timestamp: number;
}

export interface ExecutionRow {
  id?: number;
  prompt: string;
  output: string;
  status: "success" | "error" | "timeout" | "cancelled";
  channel: ChannelType;
  chatId: string;
  timestamp: number;
  durationMs: number;
}
