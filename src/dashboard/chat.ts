import { WebSocketServer, WebSocket } from "ws";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  readFileSync, mkdirSync, existsSync, readdirSync, unlinkSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Server } from "node:http";
import { buildPrompt } from "../claude/context.js";
import { getChatSessionsDir, getPromptsDir } from "../paths.js";

export interface ChatSession {
  id: string;
  claudeSessionId?: string;
  name: string;
  workingDir?: string;
  messages: { role: "user" | "assistant"; text: string; ts: number }[];
  createdAt: number;
  updatedAt: number;
}

const activeProcs = new Map<string, import("node:child_process").ChildProcess>();
const sessionCache = new Map<string, ChatSession>();

export function setupChatWebSocket(server: Server): void {
  mkdirSync(getChatSessionsDir(), { recursive: true });

  const wss = new WebSocketServer({ server, path: "/ws/chat" });

  wss.on("connection", (ws: WebSocket) => {
    let sessionId: string | null = null;

    ws.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        handleMessage(ws, msg, () => sessionId, (id) => { sessionId = id; });
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", error: String(err) }));
      }
    });

    ws.on("close", () => {
      if (sessionId) {
        const proc = activeProcs.get(sessionId);
        if (proc) {
          proc.kill();
          activeProcs.delete(sessionId);
        }
      }
    });
  });
}

function handleMessage(
  ws: WebSocket,
  msg: any,
  getSessionId: () => string | null,
  setSessionId: (id: string) => void,
): void {
  console.log(`[Chat] WS message:`, msg.type, msg.text?.slice(0, 50) || '');
  switch (msg.type) {
    case "new-session": {
      const session = createSession(msg.name, msg.workingDir);
      setSessionId(session.id);
      ws.send(JSON.stringify({ type: "session-created", session }));
      break;
    }

    case "resume-session": {
      const existing = loadSession(msg.sessionId);
      if (!existing) {
        ws.send(JSON.stringify({ type: "error", error: "Session not found" }));
        return;
      }
      setSessionId(existing.id);
      ws.send(JSON.stringify({ type: "session-resumed", session: existing }));
      break;
    }

    case "send-message": {
      const sid = getSessionId();
      if (!sid) {
        ws.send(JSON.stringify({ type: "error", error: "No active session" }));
        return;
      }
      sendMessage(ws, sid, msg.text);
      break;
    }

    case "stop": {
      const stopSid = getSessionId();
      if (stopSid) {
        const proc = activeProcs.get(stopSid);
        if (proc) {
          proc.kill();
          activeProcs.delete(stopSid);
          ws.send(JSON.stringify({ type: "stopped" }));
        }
      }
      break;
    }
  }
}

function createSession(name?: string, workingDir?: string): ChatSession {
  const session: ChatSession = {
    id: randomUUID(),
    name: name || `Chat ${new Date().toLocaleString()}`,
    workingDir,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  saveSession(session);
  return session;
}

function sendMessage(ws: WebSocket, sessionId: string, text: string): void {
  const session = loadSession(sessionId);
  if (!session) return;

  // Kill any existing process for this session
  const existing = activeProcs.get(sessionId);
  if (existing) {
    existing.kill();
    activeProcs.delete(sessionId);
  }

  // Save user message
  session.messages.push({ role: "user", text, ts: Date.now() });
  session.updatedAt = Date.now();
  saveSession(session);

  // Build full prompt with system context (persona, capabilities, cron tags, etc.)
  const fullPrompt = buildPrompt(text, `dashboard:${sessionId}`);

  // Build claude args — per-message spawn with --resume for continuity
  const args = [
    "-p", fullPrompt,
    "--output-format", "stream-json",
    "--verbose",
  ];

  if (session.claudeSessionId) {
    args.push("--resume", session.claudeSessionId);
  }

  const cwd = session.workingDir || process.cwd();
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  console.log(`[Chat] Spawning claude with args:`, args, `cwd:`, cwd);
  console.log(`[Chat] CLAUDECODE=${env.CLAUDECODE}, ENTRYPOINT=${env.CLAUDE_CODE_ENTRYPOINT}`);
  const proc = spawn("/opt/homebrew/bin/claude", args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Close stdin immediately — we use -p flag for input
  proc.stdin?.end();
  activeProcs.set(sessionId, proc);

  proc.on("error", (err) => {
    console.error(`[Chat] Spawn error:`, err);
    ws.send(JSON.stringify({ type: "error", error: `Spawn failed: ${err.message}` }));
  });

  let fullResponse = "";
  let claudeSessionId: string | undefined;

  proc.stdout.on("data", (chunk: Buffer) => {
    console.log(`[Chat] stdout chunk (${chunk.length} bytes)`);
    const lines = chunk.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);

        // Extract session ID (Claude CLI uses snake_case: session_id)
        if (event.session_id) {
          claudeSessionId = event.session_id;
        }

        // Collect assistant text
        if (event.type === "assistant" && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === "text") {
              fullResponse += block.text;
            }
          }
        }
        if (event.type === "content_block_delta" && event.delta?.text) {
          fullResponse += event.delta.text;
        }

        ws.send(JSON.stringify({ type: "claude-event", event }));
      } catch {
        ws.send(JSON.stringify({ type: "claude-text", text: line }));
      }
    }
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    console.error(`[Chat] stderr:`, text);
    ws.send(JSON.stringify({ type: "claude-stderr", text }));
  });

  proc.on("close", (code: number | null) => {
    console.log(`[Chat] claude process closed with code:`, code);
    activeProcs.delete(sessionId);

    const sess = loadSession(sessionId);
    if (sess) {
      if (fullResponse) {
        sess.messages.push({ role: "assistant", text: fullResponse, ts: Date.now() });
      }
      if (claudeSessionId) {
        sess.claudeSessionId = claudeSessionId;
      }
      sess.updatedAt = Date.now();
      saveSession(sess);
    }

    ws.send(JSON.stringify({ type: "claude-done", code, sessionId }));
  });
}

// --- Persistence ---

function loadSession(id: string): ChatSession | null {
  const cached = sessionCache.get(id);
  if (cached) return cached;
  const file = resolve(getChatSessionsDir(), `${id}.json`);
  if (!existsSync(file)) return null;
  const session = JSON.parse(readFileSync(file, "utf-8"));
  sessionCache.set(id, session);
  return session;
}

function saveSession(session: ChatSession): void {
  sessionCache.set(session.id, session);
  const sessionsDir = getChatSessionsDir();
  mkdirSync(sessionsDir, { recursive: true });
  const file = resolve(sessionsDir, `${session.id}.json`);
  writeFile(file, JSON.stringify(session, null, 2), "utf-8").catch((err) =>
    console.error(`[Chat] Failed to save session:`, err)
  );
}

// --- REST API helpers ---

export function listSessions(): ChatSession[] {
  const sessionsDir = getChatSessionsDir();
  mkdirSync(sessionsDir, { recursive: true });
  const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
  return files.map((f) => {
    const content = readFileSync(resolve(sessionsDir, f), "utf-8");
    return JSON.parse(content) as ChatSession;
  }).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function renameSession(id: string, name: string): ChatSession | null {
  const session = loadSession(id);
  if (!session) return null;
  session.name = name;
  session.updatedAt = Date.now();
  saveSession(session);
  return session;
}

export function deleteSession(id: string): boolean {
  const file = resolve(getChatSessionsDir(), `${id}.json`);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  sessionCache.delete(id);
  return true;
}

export function getPromptFiles(): string[] {
  const dir = getPromptsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md"));
}

export function getPromptFileContent(filename: string): string | null {
  // Prevent path traversal
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) return null;
  const file = resolve(getPromptsDir(), filename);
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf-8");
}
