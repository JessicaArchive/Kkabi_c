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
  model?: string;
  timeoutMs?: number;
  resolve: (result: ClaudeResult) => void;
  reject: (error: Error) => void;
}

export interface Agent {
  id: string;
  name: string;
  model?: string;
  persona?: string;
  workingDir?: string;
  timeoutMs?: number;
}

export interface CronJobState {
  lastRunAtMs?: number;
  lastStatus?: "ok" | "error";
  lastDurationMs?: number;
  consecutiveErrors?: number;
  lastError?: string;
}

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;

  // Schedule
  schedule: string;

  // Execution
  prompt: string;
  promptPath?: string;
  agentId?: string;
  model?: string;
  workingDir?: string;
  timeoutMs?: number;

  // Delivery
  channelType: ChannelType;
  chatId: string;

  // State
  state?: CronJobState;
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
