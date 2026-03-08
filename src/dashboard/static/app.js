// State
let currentPage = 'home';
let pollTimer = null;

// Navigation
function navigate(page) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
  document.getElementById(page + '-page').classList.add('active');
  document.querySelectorAll('.nav-link').forEach(el => el.classList.remove('active'));
  const navLink = document.querySelector(`[data-page="${page}"]`);
  if (navLink) navLink.classList.add('active');

  clearInterval(pollTimer);
  if (page === 'chat') {
    connectChatWs();
    loadChatProjects();
  }
  refresh();
  pollTimer = setInterval(refresh, 3000);
}

function refresh() {
  if (currentPage === 'home') fetchHome();
  else if (currentPage === 'chat') fetchChatSessions();
  else if (currentPage === 'crons') fetchCrons();
  else if (currentPage === 'queue') fetchQueue();
  else if (currentPage === 'runs') fetchRuns();
  else if (currentPage === 'branches') fetchBranches();
  else if (currentPage === 'log') fetchLog();
}

async function fetchHome() {
  try {
    const [cronsRes, queueRes, runsRes, chatRes] = await Promise.all([
      fetch('/api/crons'),
      fetch('/api/queue'),
      fetch('/api/runs'),
      fetch('/api/chat/sessions')
    ]);
    const crons = await cronsRes.json();
    const queue = await queueRes.json();
    const runs = await runsRes.json();
    const chats = await chatRes.json();

    const activeCrons = crons.filter(c => c.enabled).length;
    document.getElementById('home-crons-count').textContent = `${activeCrons} active / ${crons.length} total`;

    const pendingTasks = queue.filter(t => t.status === 'pending').length;
    document.getElementById('home-queue-count').textContent = `${pendingTasks} pending / ${queue.length} total`;

    document.getElementById('home-chat-count').textContent = `${chats.length}`;

    const recent = runs.slice(0, 5);
    document.getElementById('home-recent-runs').innerHTML = recent.map(r => `
      <tr>
        <td><span class="badge badge-source-${r.source || 'cron'}">${r.source === 'queue' ? 'Queue' : 'Cron'}</span></td>
        <td>${esc(r.jobName || r.jobId)}</td>
        <td>${formatTime(r.ts)}</td>
        <td><span class="badge badge-${r.status}">${r.status === 'ok' ? 'Success' : r.status === 'error' ? 'Failed' : 'Running'}</span></td>
      </tr>
    `).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--text-muted)">No runs yet</td></tr>';
  } catch (err) {
    console.error('Failed to fetch home data:', err);
  }
}

// Crons
async function fetchCrons() {
  try {
    const res = await fetch('/api/crons');
    const jobs = await res.json();
    const tbody = document.getElementById('crons-body');
    tbody.innerHTML = jobs.map(j => `
      <tr>
        <td><span class="job-name clickable" onclick='showCronDetail(${JSON.stringify(j).replace(/'/g, "&#39;")})'>${esc(j.name)}</span></td>
        <td>
          <span>${esc(cronToHuman(j.schedule))}</span> <code class="cron-expr">${esc(j.schedule)}</code>
          ${j.enabled ? `<span class="cron-next">Next: ${formatNextRun(getNextCronRun(j.schedule))}</span>` : ''}
          <button class="btn btn-icon btn-sm" onclick="editSchedule('${esc(j.id)}', '${esc(j.schedule)}')" title="Edit schedule">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 0 0-.354 0L3.462 11.098a.25.25 0 0 0-.064.108l-.563 1.97 1.971-.564a.25.25 0 0 0 .108-.064l8.61-8.61a.25.25 0 0 0 0-.354l-1.086-1.086z"/></svg>
          </button>
        </td>
        <td><label class="toggle"><input type="checkbox" ${j.enabled ? 'checked' : ''} onchange="toggleCron('${esc(j.id)}')"><span class="toggle-slider"></span></label></td>
        <td>
          <button class="btn btn-primary btn-sm" onclick="runCron('${esc(j.id)}')">Run</button>
          <button class="btn btn-danger btn-sm" onclick="deleteCron('${esc(j.id)}')">Delete</button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Failed to fetch crons:', err);
  }
}

async function runCron(id) {
  await fetch(`/api/crons/${id}/run`, { method: 'POST' });
  fetchCrons();
}

async function toggleCron(id) {
  await fetch(`/api/crons/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true })
  });
  fetchCrons();
}

async function deleteCron(id) {
  if (!confirm('Delete this cron job?')) return;
  await fetch(`/api/crons/${id}`, { method: 'DELETE' });
  fetchCrons();
}

// Cron detail
function showCronDetail(job) {
  document.getElementById('detail-title').textContent = job.name || job.id;
  const modal = document.getElementById('detail-modal');
  modal.dataset.jobId = job.id;
  document.getElementById('detail-content').innerHTML = `
    <div class="detail-label">ID</div>
    <div class="detail-value"><code>${esc(job.id)}</code></div>
    <div class="detail-label">Schedule</div>
    <div class="detail-value"><code>${esc(job.schedule)}</code></div>
    <div class="detail-label">Prompt</div>
    <div class="detail-value">
      <textarea id="detail-prompt" rows="5" style="width:100%;font-family:var(--font-mono);font-size:12px;">${esc(job.prompt)}</textarea>
    </div>
    <div class="detail-label">Channel</div>
    <div class="detail-value">${esc(job.channelType || '-')}</div>
    <div class="detail-label">Chat ID</div>
    <div class="detail-value">${esc(job.chatId || '-')}</div>
    <div class="detail-label">Working Dir</div>
    <div class="detail-value">${esc(job.workingDir || '-')}</div>
    <div class="detail-label">Timeout</div>
    <div class="detail-value">${job.timeoutMs ? formatDuration(job.timeoutMs) : '-'}</div>
    <div class="detail-label">Created</div>
    <div class="detail-value">${job.createdAt ? formatTime(job.createdAt) : '-'}</div>
  `;
  modal.style.display = 'flex';
}

function closeDetailModal() {
  document.getElementById('detail-modal').style.display = 'none';
}

async function saveCronPrompt() {
  const modal = document.getElementById('detail-modal');
  const id = modal.dataset.jobId;
  const prompt = document.getElementById('detail-prompt').value.trim();
  if (!prompt) return;

  const res = await fetch(`/api/crons/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt })
  });

  if (res.ok) {
    closeDetailModal();
    fetchCrons();
  } else {
    const data = await res.json();
    showToast(data.error || 'Failed to update prompt', 'error');
  }
}

// Schedule editor
function editSchedule(id, currentSchedule) {
  const modal = document.getElementById('schedule-modal');
  document.getElementById('schedule-cron').value = currentSchedule;
  document.getElementById('schedule-preset').value = '';
  document.getElementById('schedule-onetime').value = '';
  modal.dataset.jobId = id;
  modal.style.display = 'flex';
}

function closeScheduleModal() {
  document.getElementById('schedule-modal').style.display = 'none';
}

function applyPreset() {
  const preset = document.getElementById('schedule-preset').value;
  if (preset) document.getElementById('schedule-cron').value = preset;
}

function applyOneTime() {
  const dt = document.getElementById('schedule-onetime').value;
  if (!dt) return;
  const d = new Date(dt);
  document.getElementById('schedule-cron').value = `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
}

async function saveSchedule() {
  const modal = document.getElementById('schedule-modal');
  const id = modal.dataset.jobId;
  const schedule = document.getElementById('schedule-cron').value.trim();
  if (!schedule) return;

  const res = await fetch(`/api/crons/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schedule })
  });

  if (res.ok) {
    closeScheduleModal();
    fetchCrons();
  } else {
    const data = await res.json();
    showToast(data.error || 'Failed to update schedule', 'error');
  }
}

// Add Cron
function openAddCronModal() {
  document.getElementById('add-cron-prompt').value = '';
  document.getElementById('add-cron-schedule').value = '';
  document.getElementById('add-cron-preset').value = '';
  document.getElementById('add-cron-channel').value = 'local';
  document.getElementById('add-cron-chatid').value = '';
  document.getElementById('add-cron-modal').style.display = 'flex';
}

function closeAddCronModal() {
  document.getElementById('add-cron-modal').style.display = 'none';
}

function applyAddPreset() {
  const preset = document.getElementById('add-cron-preset').value;
  if (preset) document.getElementById('add-cron-schedule').value = preset;
}

async function addCron() {
  const prompt = document.getElementById('add-cron-prompt').value.trim();
  const schedule = document.getElementById('add-cron-schedule').value.trim();
  const channelType = document.getElementById('add-cron-channel').value;
  const chatId = document.getElementById('add-cron-chatid').value.trim();

  if (!prompt || !schedule) {
    showToast('Prompt and schedule are required.', 'error');
    return;
  }

  const res = await fetch('/api/crons', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schedule, prompt, channelType, chatId })
  });

  if (res.ok) {
    closeAddCronModal();
    fetchCrons();
  } else {
    const data = await res.json();
    showToast(data.error || 'Failed to create cron job', 'error');
  }
}

// Runs
async function fetchRuns() {
  try {
    const res = await fetch('/api/runs');
    allRuns = await res.json();
    renderFilteredRuns();
  } catch (err) {
    console.error('Failed to fetch runs:', err);
  }
}

async function deleteRun(jobId, ts) {
  if (!confirm('Delete this run?')) return;
  await fetch(`/api/runs/${jobId}/${ts}`, { method: 'DELETE' });
  fetchRuns();
}

// Log detail
let currentLog = { jobId: '', ts: 0 };

function showLog(jobId, ts) {
  currentLog = { jobId, ts };
  document.getElementById('log-meta').innerHTML = `
    <div class="log-meta-item"><strong>Job:</strong> ${esc(jobId)}</div>
    <div class="log-meta-item"><strong>Time:</strong> ${formatTime(ts)}</div>
  `;
  document.getElementById('log-content').textContent = 'Loading...';
  navigate('log');
}

async function fetchLog() {
  if (!currentLog.jobId) return;
  try {
    const res = await fetch(`/api/runs/${currentLog.jobId}/${currentLog.ts}`);
    if (res.ok) {
      document.getElementById('log-content').textContent = await res.text();
    } else {
      document.getElementById('log-content').textContent = 'Log file not found.';
    }
  } catch {
    document.getElementById('log-content').textContent = 'Error loading log.';
  }
}

// Branches
let projectsLoaded = false;

async function loadProjects() {
  if (projectsLoaded) return;
  try {
    const res = await fetch('/api/projects');
    const projects = await res.json();
    const select = document.getElementById('project-select');
    select.innerHTML = projects.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    projectsLoaded = true;
  } catch (err) {
    console.error('Failed to load projects:', err);
  }
}

async function fetchBranches() {
  await loadProjects();
  const project = document.getElementById('project-select').value;
  if (!project) return;
  try {
    const res = await fetch(`/api/branches/${project}`);
    const data = await res.json();
    document.getElementById('branches-current').innerHTML = `
      <span>Current branch:</span> <strong>${esc(data.current)}</strong>
    `;
    const tbody = document.getElementById('branches-body');
    tbody.innerHTML = data.branches.map(b => `
      <tr class="${b === data.current ? 'branch-active' : ''}">
        <td>
          ${b === data.current ? '<span class="badge badge-ok">active</span> ' : ''}
          ${esc(b)}
        </td>
        <td>
          ${b === data.current
            ? '<button class="btn btn-sm" disabled>Current</button>'
            : `<button class="btn btn-primary btn-sm" onclick="checkoutBranch('${esc(b)}')">Checkout</button>`}
        </td>
      </tr>
    `).join('');
    fetchDevServer();
  } catch (err) {
    console.error('Failed to fetch branches:', err);
  }
}

async function checkoutBranch(branch) {
  const project = document.getElementById('project-select').value;
  if (!confirm(`Switch "${project}" to "${branch}"?`)) return;
  const res = await fetch(`/api/branches/${project}/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch })
  });
  if (res.ok) {
    fetchBranches();
  } else {
    const data = await res.json();
    showToast(data.error || 'Failed to checkout', 'error');
  }
}

// Dev Server
async function fetchDevServer() {
  const project = document.getElementById('project-select').value;
  if (!project) return;
  try {
    const res = await fetch('/api/devserver');
    const running = await res.json();
    const controls = document.getElementById('devserver-controls');
    if (running[project]) {
      controls.innerHTML = `
        <span class="badge badge-running">Dev Server Running</span>
        <a href="http://localhost:5173" target="_blank" class="btn btn-sm">Open Dev Server</a>
        <button class="btn btn-danger btn-sm" onclick="stopDevServer()">Stop</button>
      `;
    } else {
      controls.innerHTML = `
        <button class="btn btn-primary btn-sm" onclick="startDevServer()">Start Dev Server</button>
      `;
    }
  } catch (err) {
    console.error('Failed to fetch devserver status:', err);
  }
}

async function startDevServer() {
  const project = document.getElementById('project-select').value;
  await fetch(`/api/devserver/${project}/start`, { method: 'POST' });
  fetchDevServer();
}

async function stopDevServer() {
  const project = document.getElementById('project-select').value;
  await fetch(`/api/devserver/${project}/stop`, { method: 'POST' });
  fetchDevServer();
}

// Chat
let chatWs = null;
let currentChatSession = null;
let chatStreaming = false;
let pendingChatMessage = null;
let chatUserScrolledUp = false;

async function fetchChatSessions() {
  try {
    const res = await fetch('/api/chat/sessions');
    const sessions = await res.json();
    const list = document.getElementById('chat-sessions-list');
    list.innerHTML = sessions.map(s => `
      <div class="chat-session-item ${currentChatSession?.id === s.id ? 'active' : ''}"
           onclick="resumeChatSession('${esc(s.id)}')">
        <div class="session-name" ondblclick="event.stopPropagation();renameSessionInline(this,'${esc(s.id)}')">${esc(s.name)}</div>
        <div class="session-meta">
          <span class="session-time">${formatTime(s.updatedAt)}</span>
          <button class="btn-icon-sm" onclick="event.stopPropagation();renameSessionInline(this.parentElement.previousElementSibling,'${esc(s.id)}')" title="Rename">&#9998;</button>
          <button class="btn-icon-sm" onclick="event.stopPropagation();deleteChatSession('${esc(s.id)}')" title="Delete">&times;</button>
        </div>
      </div>
    `).join('') || '<div class="chat-empty">No sessions</div>';
  } catch (err) {
    console.error('Failed to fetch chat sessions:', err);
  }
}

let wsReconnectTimer = null;
let wsReconnectDelay = 1000;

function connectChatWs() {
  if (chatWs && chatWs.readyState === WebSocket.OPEN) return;
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  chatWs = new WebSocket(`${protocol}//${location.host}/ws/chat`);

  chatWs.onopen = () => {
    wsReconnectDelay = 1000;
    updateWsStatus('connected');
  };

  chatWs.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleChatEvent(msg);
  };

  chatWs.onclose = () => {
    chatWs = null;
    updateWsStatus('reconnecting');
    wsReconnectTimer = setTimeout(() => {
      connectChatWs();
    }, wsReconnectDelay);
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30000);
  };
}

function handleChatEvent(msg) {
  switch (msg.type) {
    case 'session-created':
    case 'session-resumed':
      currentChatSession = msg.session;
      document.getElementById('chat-session-name').textContent = msg.session.name;
      document.getElementById('chat-add-queue-btn').style.display = '';
      document.getElementById('chat-export-btn').style.display = '';
      renderChatMessages(msg.session.messages);
      fetchChatSessions();
      // Send pending message after session is created
      if (msg.type === 'session-created' && pendingChatMessage) {
        const text = pendingChatMessage;
        pendingChatMessage = null;
        doSendMessage(text);
      }
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
      if (streamingEl) {
        streamingEl.classList.remove('streaming');
        streamingEl.querySelectorAll('pre code').forEach(el => {
          if (typeof hljs !== 'undefined') hljs.highlightElement(el);
        });
        enhanceCodeBlocks(streamingEl);
        // Check for cron suggestion in completed response
        const cronSuggestion = detectCronSuggestion(streamingRawText);
        if (cronSuggestion) {
          addCronButton(streamingEl, cronSuggestion);
        }
      }
      streamingRawText = '';
      document.getElementById('chat-stop-btn').style.display = 'none';
      document.getElementById('chat-input').disabled = false;
      fetchChatSessions();
      break;

    case 'stopped':
      chatStreaming = false;
      const stoppedEl = document.querySelector('.chat-msg.streaming');
      if (stoppedEl) stoppedEl.classList.remove('streaming');
      document.getElementById('chat-stop-btn').style.display = 'none';
      document.getElementById('chat-input').disabled = false;
      break;

    case 'error':
      chatStreaming = false;
      document.getElementById('chat-stop-btn').style.display = 'none';
      document.getElementById('chat-input').disabled = false;
      showToast(msg.error, 'error');
      break;

    case 'claude-stderr':
      console.warn('[Chat stderr]', msg.text);
      break;
  }
}

function handleClaudeStreamEvent(event) {
  // assistant event contains the full response text
  if (event.type === 'assistant' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === 'text') {
        appendToCurrentAssistantMsg(block.text);
      }
    }
  }
  // content_block_delta for streaming chunks (if available)
  if (event.type === 'content_block_delta' && event.delta?.text) {
    appendToCurrentAssistantMsg(event.delta.text);
  }
}

let streamingRawText = '';

// Cron suggestion detection — parse AI's CRON_JOB tags
function detectCronSuggestion(text) {
  const match = text.match(/<!--CRON_JOB:(.*?)-->/);
  if (!match) return null;
  try {
    const data = JSON.parse(match[1]);
    return { schedule: data.schedule || null, prompt: data.prompt || null };
  } catch {
    return null;
  }
}

function addCronButton(msgEl, suggestion) {
  // Don't add duplicate buttons
  if (msgEl.querySelector('.chat-cron-btn')) return;

  const btn = document.createElement('button');
  btn.className = 'chat-cron-btn';
  btn.textContent = '+ 크론잡 추가';
  btn.onclick = () => {
    // Pre-fill the add cron modal
    document.getElementById('add-cron-prompt').value = suggestion.prompt || '';
    document.getElementById('add-cron-schedule').value = suggestion.schedule || '';
    document.getElementById('add-cron-preset').value = '';
    document.getElementById('add-cron-channel').value = 'local';
    document.getElementById('add-cron-chatid').value = '';
    document.getElementById('add-cron-modal').style.display = 'flex';
  };
  msgEl.appendChild(btn);
}

function appendToCurrentAssistantMsg(text) {
  const container = document.getElementById('chat-messages');
  // Remove typing indicator
  const typingEl = container.querySelector('.typing-indicator');
  if (typingEl) typingEl.remove();
  let msgEl = container.querySelector('.chat-msg.assistant.streaming');
  if (!msgEl) {
    msgEl = document.createElement('div');
    msgEl.className = 'chat-msg assistant streaming';
    msgEl.dataset.raw = '';
    container.appendChild(msgEl);
    streamingRawText = '';
  }
  streamingRawText += text;
  msgEl.innerHTML = renderMarkdown(streamingRawText);
  chatScrollToBottom();
}

function renderMarkdown(text) {
  if (typeof marked !== 'undefined') {
    const html = marked.parse(text, { breaks: true });
    return html;
  }
  return esc(text);
}

function renderChatMessages(messages) {
  const container = document.getElementById('chat-messages');
  container.innerHTML = messages.map(m => {
    const content = m.role === 'assistant' ? renderMarkdown(m.text) : esc(m.text);
    return `<div class="chat-msg ${m.role}" data-raw-text="${m.role === 'assistant' ? esc(m.text) : ''}">${content}</div>`;
  }).join('') || '<div class="chat-empty">Start the conversation</div>';
  // Highlight code blocks and enhance
  container.querySelectorAll('pre code').forEach(el => {
    if (typeof hljs !== 'undefined') hljs.highlightElement(el);
  });
  enhanceCodeBlocks(container);
  // Add cron buttons to assistant messages that mention cron-related topics
  container.querySelectorAll('.chat-msg.assistant').forEach(el => {
    const rawText = el.dataset.rawText || el.textContent;
    const suggestion = detectCronSuggestion(rawText);
    if (suggestion) addCronButton(el, suggestion);
  });
  chatScrollToBottom();
}

function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || chatStreaming) return;

  // If no session, auto-create one and queue the message
  if (!currentChatSession) {
    pendingChatMessage = text;
    input.value = '';
    // Show message in UI immediately
    const container = document.getElementById('chat-messages');
    const emptyEl = container.querySelector('.chat-empty');
    if (emptyEl) emptyEl.remove();
    const msgEl = document.createElement('div');
    msgEl.className = 'chat-msg user';
    msgEl.textContent = text;
    container.appendChild(msgEl);
    chatScrollToBottom();
    // Create session — pending message will be sent on session-created event
    createChatSession(text.substring(0, 30));
    return;
  }

  doSendMessage(text);
}

function doSendMessage(text) {
  const input = document.getElementById('chat-input');
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

  // Show typing indicator
  const typingEl = document.createElement('div');
  typingEl.className = 'chat-msg assistant typing-indicator';
  typingEl.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
  container.appendChild(typingEl);

  chatWs.send(JSON.stringify({ type: 'send-message', text }));
  chatScrollToBottom();
}

function stopChat() {
  if (chatWs) {
    chatWs.send(JSON.stringify({ type: 'stop' }));
  }
}

function startNewChat() {
  currentChatSession = null;
  document.getElementById('chat-session-name').textContent = 'New conversation';
  document.getElementById('chat-messages').innerHTML = '<div class="chat-empty">Type a message to start a new conversation</div>';
  document.getElementById('chat-add-queue-btn').style.display = 'none';
  document.getElementById('chat-input').value = '';
  document.getElementById('chat-input').disabled = false;
  document.getElementById('chat-input').focus();
  fetchChatSessions();
}

function loadChatProjects() {
  fetch('/api/projects/paths').then(r => r.json()).then(projects => {
    const select = document.getElementById('chat-project-dropdown');
    if (!select) return;
    select.innerHTML = '<option value="">Default (Kkabi_c)</option>' +
      Object.entries(projects).map(([name, path]) =>
        `<option value="${esc(path)}">${esc(name)}</option>`
      ).join('');
  }).catch(() => {});
}

function createChatSession(name, callback) {
  connectChatWs();
  const workingDir = document.getElementById('chat-project-dropdown')?.value || undefined;

  const send = () => {
    chatWs.send(JSON.stringify({ type: 'new-session', name, workingDir }));
    if (callback) callback();
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

async function deleteChatSession(id) {
  if (!confirm('Delete this chat session?')) return;
  await fetch(`/api/chat/sessions/${id}`, { method: 'DELETE' });
  if (currentChatSession?.id === id) {
    currentChatSession = null;
    document.getElementById('chat-session-name').textContent = 'New conversation';
    document.getElementById('chat-messages').innerHTML = '<div class="chat-empty">Type a message to start a new conversation</div>';
    document.getElementById('chat-add-queue-btn').style.display = 'none';
    document.getElementById('chat-export-btn').style.display = 'none';
  }
  fetchChatSessions();
}

function renameSessionInline(el, id) {
  if (el.querySelector('input')) return;
  const oldName = el.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = oldName;
  input.className = 'session-rename-input';
  el.textContent = '';
  el.appendChild(input);
  input.focus();
  input.select();

  const save = async () => {
    const newName = input.value.trim();
    if (newName && newName !== oldName) {
      await fetch(`/api/chat/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName })
      });
      if (currentChatSession?.id === id) {
        currentChatSession.name = newName;
        document.getElementById('chat-session-name').textContent = newName;
      }
    }
    fetchChatSessions();
  };

  input.onblur = save;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { el.textContent = oldName; }
  };
}

function addChatToQueue() {
  if (!currentChatSession) return;
  const lastUserMsg = [...currentChatSession.messages].reverse().find(m => m.role === 'user');
  document.getElementById('add-queue-prompt').value = lastUserMsg?.text || '';
  document.getElementById('add-queue-name').value = currentChatSession.name || '';
  openAddQueueModal();
}

// Queue
async function fetchQueue() {
  try {
    const [queueRes, statusRes] = await Promise.all([
      fetch('/api/queue'),
      fetch('/api/queue/status')
    ]);
    const tasks = await queueRes.json();
    const { running } = await statusRes.json();

    // Update start/stop buttons
    document.getElementById('queue-start-btn').style.display = running ? 'none' : '';
    document.getElementById('queue-stop-btn').style.display = running ? '' : 'none';
    document.getElementById('queue-status').innerHTML = running
      ? '<span class="badge badge-running">Queue Running</span>'
      : '';

    const tbody = document.getElementById('queue-body');
    tbody.innerHTML = tasks.map((t, i) => `
      <tr>
        <td>${i + 1}</td>
        <td><span class="job-name clickable" onclick='showQueueDetail(${JSON.stringify(t).replace(/'/g, "&#39;")})'>${esc(t.name)}</span></td>
        <td><span class="badge badge-${t.status === 'done' ? 'ok' : t.status}">${t.status === 'done' ? 'Done' : t.status === 'error' ? 'Failed' : t.status === 'running' ? 'Running' : 'Pending'}</span></td>
        <td>
          ${t.status === 'pending' ? `<button class="btn btn-primary btn-sm" onclick="runQueueTask('${esc(t.id)}')">Run</button>` : ''}
          <button class="btn btn-danger btn-sm" onclick="deleteQueueTask('${esc(t.id)}')">Delete</button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Failed to fetch queue:', err);
  }
}

async function runQueueTask(id) {
  await fetch(`/api/queue/${id}/run`, { method: 'POST' });
  fetchQueue();
}

async function deleteQueueTask(id) {
  if (!confirm('Delete this task?')) return;
  await fetch(`/api/queue/${id}`, { method: 'DELETE' });
  fetchQueue();
}

async function startQueue() {
  await fetch('/api/queue/start', { method: 'POST' });
  fetchQueue();
}

async function stopQueue() {
  await fetch('/api/queue/stop', { method: 'POST' });
  fetchQueue();
}

function showQueueDetail(task) {
  document.getElementById('queue-detail-title').textContent = task.name || task.id;
  document.getElementById('queue-detail-content').innerHTML = `
    <div class="detail-label">ID</div>
    <div class="detail-value"><code>${esc(task.id)}</code></div>
    <div class="detail-label">Prompt</div>
    <div class="detail-value"><pre>${esc(task.prompt)}</pre></div>
    <div class="detail-label">Status</div>
    <div class="detail-value">${esc(task.status)}</div>
    <div class="detail-label">Channel</div>
    <div class="detail-value">${esc(task.channelType || '-')}</div>
    <div class="detail-label">Chat ID</div>
    <div class="detail-value">${esc(task.chatId || '-')}</div>
    <div class="detail-label">Working Dir</div>
    <div class="detail-value">${esc(task.workingDir || '-')}</div>
    <div class="detail-label">Created</div>
    <div class="detail-value">${task.createdAt ? formatTime(task.createdAt) : '-'}</div>
  `;
  document.getElementById('queue-detail-modal').style.display = 'flex';
}

function closeQueueDetailModal() {
  document.getElementById('queue-detail-modal').style.display = 'none';
}

function openAddQueueModal() {
  document.getElementById('add-queue-name').value = '';
  document.getElementById('add-queue-prompt').value = '';
  document.getElementById('add-queue-workdir').value = '';
  document.getElementById('add-queue-channel').value = 'local';
  document.getElementById('add-queue-chatid').value = '';
  document.getElementById('add-queue-modal').style.display = 'flex';
  loadPromptFileOptions();
}

async function loadPromptFile() {
  const filename = document.getElementById('add-queue-promptfile').value;
  if (!filename) return;
  const res = await fetch(`/api/prompts/${filename}`);
  if (res.ok) {
    document.getElementById('add-queue-prompt').value = await res.text();
  }
}

async function loadPromptFileOptions() {
  try {
    const res = await fetch('/api/prompts');
    const files = await res.json();
    const select = document.getElementById('add-queue-promptfile');
    if (select) {
      select.innerHTML = '<option value="">-- Select prompt file --</option>' +
        files.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
    }
  } catch {}
}

function closeAddQueueModal() {
  document.getElementById('add-queue-modal').style.display = 'none';
}

async function addQueueTask() {
  const name = document.getElementById('add-queue-name').value.trim();
  const prompt = document.getElementById('add-queue-prompt').value.trim();
  const workingDir = document.getElementById('add-queue-workdir').value.trim();
  const channelType = document.getElementById('add-queue-channel').value;
  const chatId = document.getElementById('add-queue-chatid').value.trim();

  if (!prompt) {
    showToast('Prompt is required.', 'error');
    return;
  }

  const res = await fetch('/api/queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, prompt, workingDir: workingDir || undefined, channelType, chatId })
  });

  if (res.ok) {
    closeAddQueueModal();
    fetchQueue();
  } else {
    const data = await res.json();
    showToast(data.error || 'Failed to create task', 'error');
  }
}

// Cron expression to human-readable
function cronToHuman(expr) {
  const presets = {
    '0 * * * *': 'Every hour (at :00)',
    '*/30 * * * *': 'Every 30 minutes',
    '*/15 * * * *': 'Every 15 minutes',
    '0 */2 * * *': 'Every 2 hours',
    '0 */3 * * *': 'Every 3 hours',
    '0 9 * * *': 'Daily at 9 AM',
    '0 9 * * 1-5': 'Weekdays at 9 AM',
    '0 9,13,17 * * *': '3x daily (9, 13, 17)',
  };
  if (presets[expr]) return presets[expr];

  const parts = expr.split(' ');
  if (parts.length !== 5) return expr;
  const [min, hour, day, month, dow] = parts;

  if (day === '*' && month === '*' && dow === '*') {
    if (hour === '*' && min.startsWith('*/')) return `Every ${min.slice(2)} minutes`;
    if (hour.startsWith('*/') && min === '0') return `Every ${hour.slice(2)} hours`;
    if (hour !== '*' && min !== '*') return `Daily at ${hour}:${min.padStart(2, '0')}`;
  }
  return expr;
}

// Helpers
function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}

function formatTime(ts) {
  return new Date(ts).toLocaleString();
}

function formatDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m + 'm ' + (s % 60) + 's';
}

function updateWsStatus(state) {
  const el = document.getElementById('chat-ws-status');
  if (!el) return;
  el.className = 'ws-status ws-' + state;
  el.title = state === 'connected' ? 'Connected' : state === 'reconnecting' ? 'Reconnecting...' : 'Disconnected';
}

function chatScrollToBottom() {
  const container = document.getElementById('chat-messages');
  if (!chatUserScrolledUp) {
    container.scrollTop = container.scrollHeight;
  }
}

// === Toast Notifications ===
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => { toast.classList.add('toast-fade'); }, 2500);
  setTimeout(() => { toast.remove(); }, 3000);
}

// === Next Cron Run Time ===
function getNextCronRun(expr) {
  const parts = expr.split(' ');
  if (parts.length !== 5) return null;
  const [minExpr, hourExpr, dayExpr, monthExpr, dowExpr] = parts;
  const now = new Date();

  for (let offset = 0; offset < 1440; offset++) {
    const candidate = new Date(now.getTime() + offset * 60000);
    candidate.setSeconds(0, 0);
    const m = candidate.getMinutes(), h = candidate.getHours();
    const dom = candidate.getDate(), mon = candidate.getMonth() + 1;
    const dow = candidate.getDay();

    if (!matchCronField(minExpr, m, 0, 59)) continue;
    if (!matchCronField(hourExpr, h, 0, 23)) continue;
    if (!matchCronField(dayExpr, dom, 1, 31)) continue;
    if (!matchCronField(monthExpr, mon, 1, 12)) continue;
    if (!matchCronField(dowExpr, dow, 0, 6)) continue;
    if (candidate <= now) continue;
    return candidate;
  }
  return null;
}

function matchCronField(expr, value, min, max) {
  if (expr === '*') return true;
  return expr.split(',').some(part => {
    if (part.includes('/')) {
      const [range, step] = part.split('/');
      const s = parseInt(step);
      const start = range === '*' ? min : parseInt(range);
      for (let i = start; i <= max; i += s) { if (i === value) return true; }
      return false;
    }
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      return value >= a && value <= b;
    }
    return parseInt(part) === value;
  });
}

function formatNextRun(date) {
  if (!date) return '';
  const now = new Date();
  const diffMs = date - now;
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.floor(diffMin / 60);
  const remMin = diffMin % 60;
  return `${diffH}h${remMin > 0 ? remMin + 'm' : ''}`;
}

// === History Filters ===
let runsFilterStatus = 'all';
let runsFilterSource = 'all';
let allRuns = [];

function setRunsFilter(type, value) {
  if (type === 'status') runsFilterStatus = value;
  if (type === 'source') runsFilterSource = value;
  renderFilteredRuns();
  document.querySelectorAll('.filter-btn').forEach(btn => {
    const isActive = (btn.dataset.type === 'status' && btn.dataset.value === runsFilterStatus) ||
                     (btn.dataset.type === 'source' && btn.dataset.value === runsFilterSource);
    btn.classList.toggle('active', isActive);
  });
}

function renderFilteredRuns() {
  let filtered = allRuns;
  if (runsFilterStatus !== 'all') filtered = filtered.filter(r => r.status === runsFilterStatus);
  if (runsFilterSource !== 'all') filtered = filtered.filter(r => (r.source || 'cron') === runsFilterSource);
  const tbody = document.getElementById('runs-body');
  tbody.innerHTML = filtered.map(r => `
    <tr>
      <td><span class="badge badge-source-${r.source || 'cron'}">${r.source === 'queue' ? 'Queue' : 'Cron'}</span></td>
      <td class="clickable" onclick="showLog('${esc(r.jobId)}', ${r.ts})">${esc(r.jobName || r.jobId)}</td>
      <td class="clickable" onclick="showLog('${esc(r.jobId)}', ${r.ts})">${formatTime(r.ts)}</td>
      <td class="clickable" onclick="showLog('${esc(r.jobId)}', ${r.ts})">${r.status === 'running' ? formatDuration(r.durationMs) + '...' : r.durationMs ? formatDuration(r.durationMs) : '-'}</td>
      <td class="clickable" onclick="showLog('${esc(r.jobId)}', ${r.ts})"><span class="badge badge-${r.status}">${r.status === 'ok' ? 'Success' : r.status === 'error' ? 'Failed' : 'Running'}</span></td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteRun('${esc(r.jobId)}', ${r.ts})">Delete</button></td>
    </tr>
  `).join('');
}

// === Chat Export ===
function exportChat() {
  if (!currentChatSession) return;
  const lines = [`# ${currentChatSession.name}\n`];
  for (const m of currentChatSession.messages) {
    lines.push(`## ${m.role === 'user' ? 'User' : 'Assistant'}\n`);
    lines.push(m.text + '\n');
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${currentChatSession.name.replace(/[^a-zA-Z0-9가-힣]/g, '_')}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('Chat exported');
}

// === Code Block Enhancement ===
function enhanceCodeBlocks(container) {
  container.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('.code-header')) return;
    const code = pre.querySelector('code');
    if (!code) return;

    const langClass = [...code.classList].find(c => c.startsWith('language-'));
    const lang = langClass ? langClass.replace('language-', '') : '';

    const header = document.createElement('div');
    header.className = 'code-header';
    header.innerHTML = `
      <span class="code-lang">${esc(lang || 'code')}</span>
      <button class="code-copy-btn" onclick="copyCode(this)">Copy</button>
    `;
    pre.insertBefore(header, pre.firstChild);
  });
}

function copyCode(btn) {
  const pre = btn.closest('pre');
  const code = pre.querySelector('code');
  navigator.clipboard.writeText(code.textContent).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });
}

// === Chat Session Search ===
function filterChatSessions() {
  const query = document.getElementById('chat-search-input').value.toLowerCase();
  document.querySelectorAll('.chat-session-item').forEach(el => {
    const name = el.querySelector('.session-name').textContent.toLowerCase();
    el.style.display = name.includes(query) ? '' : 'none';
  });
}

// === Keyboard Shortcuts ===
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Cmd+N: new chat
    if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
      e.preventDefault();
      navigate('chat');
      setTimeout(() => startNewChat(), 100);
    }
    // Escape: close modals
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay').forEach(m => {
        if (m.style.display !== 'none') m.style.display = 'none';
      });
    }
  });
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  navigate('home');
  setupKeyboardShortcuts();

  const chatContainer = document.getElementById('chat-messages');
  chatContainer.addEventListener('scroll', () => {
    const { scrollTop, scrollHeight, clientHeight } = chatContainer;
    chatUserScrolledUp = scrollHeight - scrollTop - clientHeight > 50;
  });
});
