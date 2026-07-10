const $ = (selector) => document.querySelector(selector);
let currentProfile = null;
let currentMemories = [];

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function toast(message) {
  const box = $('#toast');
  box.textContent = message;
  box.classList.add('show');
  setTimeout(() => box.classList.remove('show'), 2200);
}

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!res.ok) throw new Error(await res.text() || '请求失败');
  return res.json();
}

function formatTime(value) {
  if (!value) return '--';
  return new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}

function shortText(value = '', max = 72) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function card(title, rows) {
  return `<span class="log-stat" title="${escapeHtml(title)}"><em>${escapeHtml(title)}</em><b>${rows.length}</b></span>`;
}

function memoryQueryString() {
  const params = new URLSearchParams();
  for (const [key, value] of new FormData($('#memoryFilterForm')).entries()) {
    if (String(value || '').trim()) params.set(key, value);
  }
  return params.toString();
}

function renderMemories(rows = []) {
  currentMemories = rows;
  $('#memoryCount').textContent = `${rows.length} 条`;
  $('#memoryList').innerHTML = rows.length ? rows.map((memory) => {
    const meta = [`#${memory.id}`, `重要度 ${memory.importance}`, memory.pinned ? '已置顶' : '未置顶', memory.source || ''].filter(Boolean).join(' · ');
    return `<article class="log-row tone-${memory.pinned ? 'ok' : 'muted'}" id="memory-${memory.id}">
      <i class="log-dot" aria-hidden="true"></i>
      <div class="log-body">
        <div class="log-line"><strong title="${escapeHtml(memory.category)}">${escapeHtml(shortText(memory.category, 36))}</strong><time>${escapeHtml(formatTime(memory.updated_at))}</time></div>
        <div class="log-meta">
          <span title="${escapeHtml(memory.content || '')}">${escapeHtml(shortText(memory.content, 70))}</span>
          <button type="button" class="timeline-link" data-edit-memory="${memory.id}">编辑</button>
          <button type="button" class="timeline-link" data-toggle-pin="${memory.id}" data-pinned="${memory.pinned ? '1' : '0'}">${memory.pinned ? '取消置顶' : '置顶'}</button>
          <button type="button" class="timeline-link" data-importance="${memory.id}">重要度</button>
          <button type="button" class="timeline-link danger" data-delete-memory="${memory.id}">删除</button>
        </div>
        <p class="log-extra">${escapeHtml(shortText(meta, 90))}</p>
      </div>
    </article>`;
  }).join('') : '<div class="empty-state">没有匹配的长期记忆</div>';
  bindMemoryActions();
}

function findMemory(id) {
  return currentMemories.find((memory) => String(memory.id) === String(id));
}

function bindMemoryActions() {
  document.querySelectorAll('[data-edit-memory]').forEach((button) => {
    button.onclick = async () => {
      const memory = findMemory(button.dataset.editMemory);
      if (!memory) return;
      const category = prompt('分类', memory.category);
      if (!category) return;
      const content = prompt('内容', memory.content);
      if (!content) return;
      try {
        await api(`/api/assistant/memories/${memory.id}`, { method: 'PATCH', body: JSON.stringify({ category, content }) });
        toast('记忆已更新');
        await loadAll();
      } catch (error) { toast(error.message); }
    };
  });
  document.querySelectorAll('[data-toggle-pin]').forEach((button) => {
    button.onclick = async () => {
      try {
        await api(`/api/assistant/memories/${button.dataset.togglePin}`, { method: 'PATCH', body: JSON.stringify({ pinned: button.dataset.pinned !== '1' }) });
        toast('置顶状态已更新');
        await loadAll();
      } catch (error) { toast(error.message); }
    };
  });
  document.querySelectorAll('[data-importance]').forEach((button) => {
    button.onclick = async () => {
      const memory = findMemory(button.dataset.importance);
      const value = Number(prompt('重要度 1-5', memory?.importance || 3));
      if (!value) return;
      try {
        await api(`/api/assistant/memories/${button.dataset.importance}`, { method: 'PATCH', body: JSON.stringify({ importance: Math.max(1, Math.min(5, value)) }) });
        toast('重要度已更新');
        await loadAll();
      } catch (error) { toast(error.message); }
    };
  });
  document.querySelectorAll('[data-delete-memory]').forEach((button) => {
    button.onclick = async () => {
      if (!confirm('删除这条长期记忆？')) return;
      try {
        await api(`/api/assistant/memories/${button.dataset.deleteMemory}`, { method: 'DELETE' });
        toast('记忆已删除');
        await loadAll();
      } catch (error) { toast(error.message); }
    };
  });
}

async function loadProfile() {
  const params = new URLSearchParams(location.search);
  const fromUser = params.get('from_user');
  currentProfile = await api(`/api/profile${fromUser ? `?from_user=${encodeURIComponent(fromUser)}` : ''}`);
  $('#profileUser').textContent = currentProfile.from_user || '全局画像';
  $('#profileSummary').textContent = currentProfile.summary;
  $('#profileGrid').innerHTML = [
    card('账本画像', currentProfile.finance || []),
    card('健康画像', currentProfile.fitness || []),
    card('任务画像', currentProfile.tasks || []),
    card('报告画像', currentProfile.reports || []),
  ].join('');
}

async function loadMemories() {
  renderMemories(await api(`/api/assistant/memories?${memoryQueryString()}`));
  const target = new URLSearchParams(location.search).get('memory');
  if (target) document.getElementById(`memory-${target}`)?.scrollIntoView({ block: 'center' });
}

async function loadAll() {
  await Promise.all([loadProfile(), loadMemories()]);
}

$('#memoryFilterForm').onsubmit = (event) => {
  event.preventDefault();
  loadMemories().catch((error) => toast(error.message));
};
$('#refreshBtn').onclick = () => loadAll().catch((error) => toast(error.message));
loadAll().catch((error) => toast(error.message));
