# Dashboard Chat Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Chat page to the Kkabi dashboard that provides Claude Code conversation through a web UI, with multi-session support and Queue/Cron integration.

**Architecture:** WebSocket server (ws library) on the Express server handles real-time communication. Each chat session spawns a Claude CLI process per message using `--print --output-format stream-json` with `--resume` for conversation continuity. Sessions are stored as JSON files in `data/chat-sessions/`.

**Tech Stack:** ws (WebSocket), Claude CLI (stream-json), Express, vanilla HTML/CSS/JS

---

### Task 1: Install ws dependency

**Files:**
- Modify: `package.json`

**Step 1: Install ws**

Run: `npm install ws && npm install -D @types/ws`

**Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add ws dependency for dashboard chat"
```

---

### Task 2: Create Chat WebSocket handler

**Files:**
- Create: `src/dashboard/chat.ts`

**Step 1: Implement chat handler**

Create `src/dashboard/chat.ts` with:

```typescript
import { WebSocketServer, WebSocket } from "ws";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync,
} from "node:fs";
import { resolve } from "node:path";
import type { Server } from "node:http";

const SESSIONS_DIR = resolve(process.cwd(), "data", "chat-sessions");

export interface ChatSession {
  id: string;
  claudeSessionId?: string;
  name: string;
  workingDir?: string;
  messages: { role: "user" | "assistant"; text: string; ts: number }[];
  createdAt: number;
  updatedAt: number;
}

// Active processes per session
const activeProcs = new Map<string, ChildProcessWithoutNullStreams>();

export function setupChatWebSocket(server: Server): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });

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
  switch (msg.type) {
    case "new-session":
      const session = createSession(msg.name, msg.workingDir);
      setSessionId(session.id);
      ws.send(JSON.stringify({ type: "session-created", session }));
      break;

    case "resume-session":
      const existing = loadSession(msg.sessionId);
      if (!existing) {
        ws.send(JSON.stringify({ type: "error", error: "Session not found" }));
        return;
      }
      setSessionId(existing.id);
      ws.send(JSON.stringify({ type: "session-resumed", session: existing }));
      break;

    case "send-message":
      const sid = getSessionId();
      if (!sid) {
        ws.send(JSON.stringify({ type: "error", error: "No active session" }));
        return;
      }
      sendMessage(ws, sid, msg.text);
      break;

    case "stop":
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

  // Build claude args
  const args = [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "-p", text,
  ];

  // Resume conversation if we have a claude session ID
  if (session.claudeSessionId) {
    args.push("--resume", session.claudeSessionId);
  }

  const cwd = session.workingDir || process.cwd();
  const env = { ...process.env };
  delete env.CLAUDECODE;

  const proc = spawn("claude", args, { cwd, env, shell: true });
  activeProcs.set(sessionId, proc);

  let fullResponse = "";
  let claudeSessionId: string | undefined;

  proc.stdout.on("data", (chunk: Buffer) => {
    const lines = chunk.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);

        // Extract session ID from init message
        if (event.type === "system" && event.sessionId) {
          claudeSessionId = event.sessionId;
        }

        // Collect assistant text
        if (event.type === "assistant" && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === "text") {
              fullResponse += block.text;
            }
          }
        }

        // Forward all events to client
        ws.send(JSON.stringify({ type: "claude-event", event }));
      } catch {
        // Non-JSON output, forward as text
        ws.send(JSON.stringify({ type: "claude-text", text: line }));
      }
    }
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    ws.send(JSON.stringify({ type: "claude-stderr", text: chunk.toString() }));
  });

  proc.on("close", (code: number | null) => {
    activeProcs.delete(sessionId);

    // Save assistant response and claude session ID
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
  const file = resolve(SESSIONS_DIR, `${id}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf-8"));
}

function saveSession(session: ChatSession): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const file = resolve(SESSIONS_DIR, `${session.id}.json`);
  writeFileSync(file, JSON.stringify(session, null, 2), "utf-8");
}

// --- REST API helpers (used by server.ts) ---

export function listSessions(): ChatSession[] {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
  return files.map((f) => {
    const content = readFileSync(resolve(SESSIONS_DIR, f), "utf-8");
    return JSON.parse(content) as ChatSession;
  }).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function deleteSession(id: string): boolean {
  const file = resolve(SESSIONS_DIR, `${id}.json`);
  if (!existsSync(file)) return false;
  const { unlinkSync } = require("node:fs");
  unlinkSync(file);
  return true;
}

export function getPromptFiles(): string[] {
  const dir = resolve(process.cwd(), "data", "prompts");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md"));
}

export function getPromptFileContent(filename: string): string | null {
  const file = resolve(process.cwd(), "data", "prompts", filename);
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf-8");
}
```

**Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/dashboard/chat.ts
git commit -m "feat: add chat websocket handler with session management"
```

---

### Task 3: Integrate Chat into Express server

**Files:**
- Modify: `src/dashboard/server.ts`

**Step 1: Update server.ts**

Add imports at top:
```typescript
import { createServer } from "node:http";
import {
  setupChatWebSocket, listSessions, deleteSession,
  getPromptFiles, getPromptFileContent,
} from "./chat.js";
```

Change `app.listen()` to create HTTP server and attach WebSocket:
```typescript
// Replace: app.listen(port, () => { ... });
// With:
const httpServer = createServer(app);
setupChatWebSocket(httpServer);

httpServer.listen(port, () => {
  console.log(`[Dashboard] http://localhost:${port}/dashboard`);
});
```

Add REST endpoints before the listen call:
```typescript
// --- Chat Sessions ---
app.get("/api/chat/sessions", (_req, res) => {
  res.json(listSessions());
});

app.delete("/api/chat/sessions/:id", (req, res) => {
  res.json({ deleted: deleteSession(req.params.id) });
});

// --- Prompt Files ---
app.get("/api/prompts", (_req, res) => {
  res.json(getPromptFiles());
});

app.get("/api/prompts/:filename", (req, res) => {
  const content = getPromptFileContent(req.params.filename);
  if (!content) { res.status(404).json({ error: "Not found" }); return; }
  res.type("text/plain").send(content);
});
```

**Step 2: Verify types compile**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/dashboard/server.ts
git commit -m "feat: integrate chat websocket and prompt file API into server"
```

---

### Task 4: Add Chat page HTML

**Files:**
- Modify: `src/dashboard/static/index.html`

**Step 1: Add Chat nav link and page**

Add nav link in sidebar (between Cron Jobs and Queue):
```html
<a class="nav-link" data-page="chat" onclick="navigate('chat')">
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 1h13A1.5 1.5 0 0 1 16 2.5v9a1.5 1.5 0 0 1-1.5 1.5H5.3l-3.1 2.3A.5.5 0 0 1 1.5 15V2.5A1.5 1.5 0 0 1 3 1h-1.5zm1 1a.5.5 0 0 0-.5.5v10.7l2.3-1.7a.5.5 0 0 1 .3-.1h9.9a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5H2.5z"/></svg>
  Chat
</a>
```

Add Chat page div inside `<main class="content">`:
```html
<!-- Chat Page -->
<div id="chat-page" class="page">
  <div class="chat-layout">
    <div class="chat-sidebar">
      <div class="chat-sidebar-header">
        <h3>Sessions</h3>
        <button class="btn btn-primary btn-sm" onclick="openNewChatModal()">New</button>
      </div>
      <div id="chat-sessions-list" class="chat-sessions-list"></div>
    </div>
    <div class="chat-main">
      <div id="chat-header" class="chat-header">
        <span id="chat-session-name">Select or start a session</span>
        <div class="chat-header-actions">
          <button class="btn btn-sm" onclick="addChatToQueue()" title="Add to Queue" style="display:none" id="chat-add-queue-btn">Add to Queue</button>
        </div>
      </div>
      <div id="chat-messages" class="chat-messages">
        <div class="chat-empty">Start a new chat session</div>
      </div>
      <div id="chat-input-area" class="chat-input-area" style="display:none">
        <textarea id="chat-input" placeholder="Type a message..." rows="2" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendChatMessage()}"></textarea>
        <button class="btn btn-primary" onclick="sendChatMessage()">Send</button>
        <button class="btn btn-danger" onclick="stopChat()" id="chat-stop-btn" style="display:none">Stop</button>
      </div>
    </div>
  </div>
</div>
```

Add New Chat Modal:
```html
<!-- New Chat Modal -->
<div id="new-chat-modal" class="modal-overlay" style="display:none" onclick="if(event.target===this)closeNewChatModal()">
  <div class="modal">
    <div class="modal-header">
      <h2>New Chat Session</h2>
      <button class="modal-close" onclick="closeNewChatModal()">&times;</button>
    </div>
    <div class="modal-body">
      <div class="form-group">
        <label>Session Name</label>
        <input type="text" id="new-chat-name" placeholder="e.g. Fix login bug">
      </div>
      <div class="form-group">
        <label>Project</label>
        <select id="new-chat-project">
          <option value="">Default (Kkabi_c)</option>
        </select>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeNewChatModal()">Cancel</button>
      <button class="btn btn-primary" onclick="createChatSession()">Start</button>
    </div>
  </div>
</div>
```

**Step 2: Add prompt file picker to Add Queue Task modal**

In the existing "Add Queue Task" modal, add after the Prompt textarea:
```html
<div class="form-group">
  <label>Or load from file</label>
  <select id="add-queue-promptfile" onchange="loadPromptFile()">
    <option value="">-- Select prompt file --</option>
  </select>
</div>
```

**Step 3: Commit**

```bash
git add src/dashboard/static/index.html
git commit -m "feat: add chat page and prompt file picker HTML"
```

---

### Task 5: Add Chat page CSS

**Files:**
- Modify: `src/dashboard/static/style.css`

**Step 1: Add chat layout styles**

```css
/* Chat Layout */
.chat-layout {
  display: grid;
  grid-template-columns: 240px 1fr;
  height: calc(100vh - 2rem);
  gap: 1px;
  background: var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.chat-sidebar {
  background: var(--bg-surface);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.chat-sidebar-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border);
}

.chat-sidebar-header h3 {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.chat-sessions-list {
  flex: 1;
  overflow-y: auto;
  padding: 0.5rem;
}

.chat-session-item {
  padding: 0.6rem 0.75rem;
  border-radius: 6px;
  cursor: pointer;
  margin-bottom: 2px;
  transition: background 0.15s;
}

.chat-session-item:hover {
  background: var(--bg-hover);
}

.chat-session-item.active {
  background: var(--accent-dim);
  border: 1px solid rgba(88, 166, 255, 0.2);
}

.chat-session-item .session-name {
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chat-session-item .session-time {
  font-size: 0.7rem;
  color: var(--text-muted);
  margin-top: 2px;
}

.chat-main {
  background: var(--bg-base);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.chat-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1.25rem;
  border-bottom: 1px solid var(--border);
  font-weight: 600;
  color: var(--text-primary);
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.chat-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-muted);
  font-size: 0.9rem;
}

.chat-msg {
  max-width: 85%;
  padding: 0.75rem 1rem;
  border-radius: 8px;
  font-size: 0.875rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.chat-msg.user {
  align-self: flex-end;
  background: var(--accent-dim);
  color: var(--text-primary);
  border: 1px solid rgba(88, 166, 255, 0.15);
}

.chat-msg.assistant {
  align-self: flex-start;
  background: var(--bg-surface);
  color: var(--text-primary);
  border: 1px solid var(--border);
}

.chat-msg.assistant pre {
  background: var(--bg-deep);
  padding: 0.5rem;
  border-radius: 4px;
  overflow-x: auto;
  margin: 0.5rem 0;
  font-family: var(--font-mono);
  font-size: 0.8rem;
}

.chat-msg.streaming::after {
  content: "▊";
  animation: blink 0.8s infinite;
  color: var(--accent);
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

.chat-input-area {
  display: flex;
  gap: 0.5rem;
  padding: 0.75rem 1.25rem;
  border-top: 1px solid var(--border);
  background: var(--bg-surface);
  align-items: flex-end;
}

.chat-input-area textarea {
  flex: 1;
  resize: none;
  background: var(--bg-base);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 0.85rem;
  min-height: 2.5rem;
  max-height: 8rem;
}

.chat-input-area textarea:focus {
  outline: none;
  border-color: var(--accent);
}
```

**Step 2: Commit**

```bash
git add src/dashboard/static/style.css
git commit -m "feat: add chat page styles"
```

---

### Task 6: Add Chat page JavaScript

**Files:**
- Modify: `src/dashboard/static/app.js`

**Step 1: Add Chat state and functions**

Add WebSocket state and chat functions:

```javascript
// Chat state
let chatWs = null;
let currentChatSession = null;
let chatStreaming = false;

// Chat navigation hook
// In refresh(), add: else if (currentPage === 'chat') fetchChatSessions();

function fetchChatSessions() {
  fetch('/api/chat/sessions').then(r => r.json()).then(sessions => {
    const list = document.getElementById('chat-sessions-list');
    list.innerHTML = sessions.map(s => `
      <div class="chat-session-item ${currentChatSession?.id === s.id ? 'active' : ''}"
           onclick="resumeChatSession('${esc(s.id)}')">
        <div class="session-name">${esc(s.name)}</div>
        <div class="session-time">${formatTime(s.updatedAt)}</div>
      </div>
    `).join('') || '<div class="chat-empty">No sessions</div>';
  });
}

function connectChatWs() {
  if (chatWs && chatWs.readyState === WebSocket.OPEN) return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  chatWs = new WebSocket(`${protocol}//${location.host}/ws/chat`);

  chatWs.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleChatEvent(msg);
  };

  chatWs.onclose = () => {
    chatWs = null;
  };
}

function handleChatEvent(msg) {
  switch (msg.type) {
    case 'session-created':
    case 'session-resumed':
      currentChatSession = msg.session;
      document.getElementById('chat-session-name').textContent = msg.session.name;
      document.getElementById('chat-input-area').style.display = 'flex';
      document.getElementById('chat-add-queue-btn').style.display = '';
      renderChatMessages(msg.session.messages);
      fetchChatSessions();
      break;

    case 'claude-event':
      handleClaudeStreamEvent(msg.event);
      break;

    case 'claude-text':
      appendToCurrentAssistantMsg(msg.text);
      break;

    case 'claude-done':
      chatStreaming = false;
      const streamingEl = document.querySelector('.chat-msg.streaming');
      if (streamingEl) streamingEl.classList.remove('streaming');
      document.getElementById('chat-stop-btn').style.display = 'none';
      document.getElementById('chat-input').disabled = false;
      fetchChatSessions();
      break;

    case 'error':
      alert(msg.error);
      break;
  }
}

function handleClaudeStreamEvent(event) {
  if (event.type === 'assistant' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === 'text') {
        appendToCurrentAssistantMsg(block.text);
      }
    }
  }
}

function appendToCurrentAssistantMsg(text) {
  let msgEl = document.querySelector('.chat-msg.assistant.streaming');
  if (!msgEl) {
    msgEl = document.createElement('div');
    msgEl.className = 'chat-msg assistant streaming';
    document.getElementById('chat-messages').appendChild(msgEl);
  }
  msgEl.textContent += text;
  msgEl.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function renderChatMessages(messages) {
  const container = document.getElementById('chat-messages');
  container.innerHTML = messages.map(m => `
    <div class="chat-msg ${m.role}">${esc(m.text)}</div>
  `).join('') || '<div class="chat-empty">Start the conversation</div>';
  container.scrollTop = container.scrollHeight;
}

function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || !chatWs || chatStreaming) return;

  // Add user message to UI
  const container = document.getElementById('chat-messages');
  const emptyEl = container.querySelector('.chat-empty');
  if (emptyEl) emptyEl.remove();

  const msgEl = document.createElement('div');
  msgEl.className = 'chat-msg user';
  msgEl.textContent = text;
  container.appendChild(msgEl);

  chatStreaming = true;
  input.value = '';
  input.disabled = true;
  document.getElementById('chat-stop-btn').style.display = '';

  chatWs.send(JSON.stringify({ type: 'send-message', text }));
  msgEl.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function stopChat() {
  if (chatWs) {
    chatWs.send(JSON.stringify({ type: 'stop' }));
  }
}

function openNewChatModal() {
  document.getElementById('new-chat-name').value = '';
  // Load projects
  fetch('/api/projects').then(r => r.json()).then(projects => {
    const select = document.getElementById('new-chat-project');
    select.innerHTML = '<option value="">Default (Kkabi_c)</option>' +
      projects.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  });
  document.getElementById('new-chat-modal').style.display = 'flex';
}

function closeNewChatModal() {
  document.getElementById('new-chat-modal').style.display = 'none';
}

function createChatSession() {
  connectChatWs();
  const name = document.getElementById('new-chat-name').value.trim() || undefined;
  const project = document.getElementById('new-chat-project').value;

  // Wait for connection then send
  const send = () => {
    chatWs.send(JSON.stringify({
      type: 'new-session',
      name,
      workingDir: project ? undefined : undefined, // Project path resolved server-side
    }));
    closeNewChatModal();
  };

  if (chatWs.readyState === WebSocket.OPEN) send();
  else chatWs.onopen = send;
}

function resumeChatSession(id) {
  connectChatWs();
  const send = () => {
    chatWs.send(JSON.stringify({ type: 'resume-session', sessionId: id }));
  };
  if (chatWs.readyState === WebSocket.OPEN) send();
  else chatWs.onopen = send;
}

function addChatToQueue() {
  if (!currentChatSession) return;
  // Pre-fill queue modal with last user message
  const lastUserMsg = [...currentChatSession.messages].reverse().find(m => m.role === 'user');
  document.getElementById('add-queue-prompt').value = lastUserMsg?.text || '';
  document.getElementById('add-queue-name').value = currentChatSession.name || '';
  document.getElementById('add-queue-modal').style.display = 'flex';
}

// Prompt file loader for Queue modal
async function loadPromptFile() {
  const filename = document.getElementById('add-queue-promptfile').value;
  if (!filename) return;
  const res = await fetch(`/api/prompts/${filename}`);
  if (res.ok) {
    document.getElementById('add-queue-prompt').value = await res.text();
  }
}

async function loadPromptFileOptions() {
  const res = await fetch('/api/prompts');
  const files = await res.json();
  const select = document.getElementById('add-queue-promptfile');
  if (select) {
    select.innerHTML = '<option value="">-- Select prompt file --</option>' +
      files.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
  }
}
```

**Step 2: Update refresh() and navigate()**

In `refresh()`, add the chat case.
In `navigate()`, add: if page is 'chat', connect WebSocket and fetch sessions.
In `openAddQueueModal()`, add: `loadPromptFileOptions();`

**Step 3: Commit**

```bash
git add src/dashboard/static/app.js
git commit -m "feat: add chat page javascript with websocket client"
```

---

### Task 7: Wire up project working directory for Chat

**Files:**
- Modify: `src/dashboard/server.ts` (add project path resolution)
- Modify: `src/dashboard/chat.ts` (accept project name and resolve path)

**Step 1: Add project resolution endpoint**

In `server.ts`, update existing `/api/projects` to also return paths:
```typescript
app.get("/api/projects/paths", (_req, res) => {
  res.json(discoverProjects());
});
```

**Step 2: Update Chat new-session handler**

In `chat.ts`, when `msg.type === "new-session"`, resolve `msg.project` to a path using the projects list. Accept both `workingDir` (direct path) and `project` (name to resolve).

**Step 3: Commit**

```bash
git add src/dashboard/server.ts src/dashboard/chat.ts
git commit -m "feat: wire up project working directory for chat sessions"
```

---

### Task 8: End-to-end verification

**Step 1: Build and copy static files**

Run:
```bash
npx tsc
cp src/dashboard/static/* dist/dashboard/static/
```

**Step 2: Start bot and test**

1. Open `http://localhost:3000/dashboard`
2. Navigate to Chat page
3. Click "New" → select project → "Start"
4. Send a message and verify streaming response
5. Test session list, resume, and stop
6. Test "Add to Queue" button
7. Navigate to Queue page, verify prompt file picker works
8. Check Runs page shows Source column (Cron/Queue tags)

**Step 3: Final commit**

```bash
git add -A
git commit -m "feat: dashboard chat with multi-session and queue integration"
```
