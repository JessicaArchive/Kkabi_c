// State
let currentPage = 'crons';
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
  refresh();
  pollTimer = setInterval(refresh, 3000);
}

function refresh() {
  if (currentPage === 'chat') fetchChatSessions();
  else if (currentPage === 'crons') fetchCrons();
  else if (currentPage === 'queue') fetchQueue();
  else if (currentPage === 'runs') fetchRuns();
  else if (currentPage === 'branches') fetchBranches();
  else if (currentPage === 'log') fetchLog();
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
  document.getElementById('detail-content').innerHTML = `
    <div class="detail-label">ID</div>
    <div class="detail-value"><code>${esc(job.id)}</code></div>
    <div class="detail-label">Schedule</div>
    <div class="detail-value"><code>${esc(job.schedule)}</code></div>
    <div class="detail-label">Prompt</div>
    <div class="detail-value"><pre>${esc(job.prompt)}</pre></div>
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
  document.getElementById('detail-modal').style.display = 'flex';
}

function closeDetailModal() {
  document.getElementById('detail-modal').style.display = 'none';
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
    alert(data.error || 'Failed to update schedule');
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
    alert('Prompt and schedule are required.');
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
    alert(data.error || 'Failed to create cron job');
  }
}

// Runs
async function fetchRuns() {
  try {
    const res = await fetch('/api/runs');
    const runs = await res.json();
    const tbody = document.getElementById('runs-body');
    tbody.innerHTML = runs.map(r => `
      <tr>
        <td><span class="badge badge-source-${r.source || 'cron'}">${r.source === 'queue' ? 'Queue' : 'Cron'}</span></td>
        <td class="clickable" onclick="showLog('${esc(r.jobId)}', ${r.ts})">${esc(r.jobName || r.jobId)}</td>
        <td class="clickable" onclick="showLog('${esc(r.jobId)}', ${r.ts})">${formatTime(r.ts)}</td>
        <td class="clickable" onclick="showLog('${esc(r.jobId)}', ${r.ts})">${r.status === 'running' ? formatDuration(r.durationMs) + '...' : r.durationMs ? formatDuration(r.durationMs) : '-'}</td>
        <td class="clickable" onclick="showLog('${esc(r.jobId)}', ${r.ts})"><span class="badge badge-${r.status}">${r.status === 'ok' ? 'Success' : r.status === 'error' ? 'Failed' : 'Running'}</span></td>
        <td><button class="btn btn-danger btn-sm" onclick="deleteRun('${esc(r.jobId)}', ${r.ts})">Delete</button></td>
      </tr>
    `).join('');
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
    alert(data.error || 'Failed to checkout');
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

async function fetchChatSessions() {
  try {
    const res = await fetch('/api/chat/sessions');
    const sessions = await res.json();
    const list = document.getElementById('chat-sessions-list');
    list.innerHTML = sessions.map(s => `
      <div class="chat-session-item ${currentChatSession?.id === s.id ? 'active' : ''}"
           onclick="resumeChatSession('${esc(s.id)}')">
        <div class="session-name">${esc(s.name)}</div>
        <div class="session-meta">
          <span class="session-time">${formatTime(s.updatedAt)}</span>
          <button class="btn-icon-sm" onclick="event.stopPropagation();deleteChatSession('${esc(s.id)}')" title="Delete">&times;</button>
        </div>
      </div>
    `).join('') || '<div class="chat-empty">No sessions</div>';
  } catch (err) {
    console.error('Failed to fetch chat sessions:', err);
  }
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

    case 'stopped':
      chatStreaming = false;
      const stoppedEl = document.querySelector('.chat-msg.streaming');
      if (stoppedEl) stoppedEl.classList.remove('streaming');
      document.getElementById('chat-stop-btn').style.display = 'none';
      document.getElementById('chat-input').disabled = false;
      break;

    case 'error':
      alert(msg.error);
      break;
  }
}

function handleClaudeStreamEvent(event) {
  // Collect text from assistant messages
  if (event.type === 'assistant' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === 'text') {
        appendToCurrentAssistantMsg(block.text);
      }
    }
  }
  // Content block delta (streaming chunks)
  if (event.type === 'content_block_delta' && event.delta?.text) {
    appendToCurrentAssistantMsg(event.delta.text);
  }
}

function appendToCurrentAssistantMsg(text) {
  const container = document.getElementById('chat-messages');
  let msgEl = container.querySelector('.chat-msg.assistant.streaming');
  if (!msgEl) {
    msgEl = document.createElement('div');
    msgEl.className = 'chat-msg assistant streaming';
    container.appendChild(msgEl);
  }
  msgEl.textContent += text;
  container.scrollTop = container.scrollHeight;
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
  container.scrollTop = container.scrollHeight;
}

function stopChat() {
  if (chatWs) {
    chatWs.send(JSON.stringify({ type: 'stop' }));
  }
}

function openNewChatModal() {
  document.getElementById('new-chat-name').value = '';
  fetch('/api/projects/paths').then(r => r.json()).then(projects => {
    const select = document.getElementById('new-chat-project');
    select.innerHTML = '<option value="">Default (Kkabi_c)</option>' +
      Object.entries(projects).map(([name, path]) =>
        `<option value="${esc(path)}">${esc(name)}</option>`
      ).join('');
  });
  document.getElementById('new-chat-modal').style.display = 'flex';
}

function closeNewChatModal() {
  document.getElementById('new-chat-modal').style.display = 'none';
}

function createChatSession() {
  connectChatWs();
  const name = document.getElementById('new-chat-name').value.trim() || undefined;
  const workingDir = document.getElementById('new-chat-project').value || undefined;

  const send = () => {
    chatWs.send(JSON.stringify({ type: 'new-session', name, workingDir }));
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

async function deleteChatSession(id) {
  if (!confirm('Delete this chat session?')) return;
  await fetch(`/api/chat/sessions/${id}`, { method: 'DELETE' });
  if (currentChatSession?.id === id) {
    currentChatSession = null;
    document.getElementById('chat-session-name').textContent = 'Select or start a session';
    document.getElementById('chat-messages').innerHTML = '<div class="chat-empty">Start a new chat session</div>';
    document.getElementById('chat-input-area').style.display = 'none';
    document.getElementById('chat-add-queue-btn').style.display = 'none';
  }
  fetchChatSessions();
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
    alert('Prompt is required.');
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
    alert(data.error || 'Failed to create task');
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

// Init
document.addEventListener('DOMContentLoaded', () => {
  navigate('crons');
});
