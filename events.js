const $ = (selector) => document.querySelector(selector);

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

function levelClass(level) {
  if (level === 'error') return 'bad';
  if (level === 'warn') return 'warn';
  return 'ok';
}

function levelLabel(level) {
  return { error: '错误', warn: '警告', info: '信息' }[level] || level || '信息';
}

function queryString() {
  const params = new URLSearchParams();
  for (const [key, value] of new FormData($('#filterForm')).entries()) {
    if (String(value || '').trim()) params.set(key, value);
  }
  return params.toString();
}

function renderSummary(summary = []) {
  const map = Object.fromEntries(summary.map((item) => [item.level, item.count]));
  $('#summaryGrid').innerHTML = ['error', 'warn', 'info'].map((level) => `
    <article class="monitor-card">
      <div><strong>${escapeHtml(levelLabel(level))}</strong><span class="state-pill ${levelClass(level)}">${map[level] || 0}</span></div>
      <p>最近 7 天 ${escapeHtml(level)} 事件</p>
    </article>`).join('');
}

function eventActionButtons(row) {
  const buttons = [];
  if (row.href) buttons.push(`<a class="btn" href="${escapeHtml(row.href)}">打开关联</a>`);
  if (String(row.action || '').startsWith('wechat.retry')) buttons.push('<button type="button" data-retry-failed="1">重试失败</button>');
  if (String(row.action || '').startsWith('backup.')) buttons.push('<button type="button" data-create-backup="1">新建备份</button>');
  return buttons.length ? `<div class="row-actions inbox-actions">${buttons.join('')}</div>` : '';
}

const EVENT_ACTIONS = {
  'backup.auto_success': '自动备份成功',
  'backup.auto_failed': '自动备份失败',
  'backup.manual_success': '手动备份成功',
  'backup.import_success': '备份导入完成',
  'wechat.retry_checked': '检查企微失败消息',
  'wechat.retry_failed': '企微失败重试异常',
  'wechat.push_success': '企微推送成功',
  'wechat.push_failed': '企微推送失败',
};

function eventTitle(action = '') {
  if (EVENT_ACTIONS[action]) return EVENT_ACTIONS[action];
  if (action.startsWith('backup.')) return '备份相关任务';
  if (action.startsWith('wechat.retry')) return '企微失败重试';
  if (action.startsWith('wechat.push')) return '企微推送';
  return action || '系统事件';
}

function renderEvents(rows = []) {
  $('#eventCount').textContent = `${rows.length} 条`;
  $('#eventList').innerHTML = rows.length ? rows.map((row) => {
    const detail = row.detail || {};
    const detailText = JSON.stringify(detail, null, 2);
    return `<article class="timeline-item">
      <div class="timeline-mark ${levelClass(row.level)}">${escapeHtml(levelLabel(row.level))}</div>
      <div class="timeline-main">
        <div class="timeline-title"><strong>${escapeHtml(eventTitle(row.action))}</strong><time>${escapeHtml(formatTime(row.created_at))}</time></div>
        <p>${escapeHtml(row.entity_type || 'system')}${row.entity_id ? ` · ${escapeHtml(row.entity_id)}` : ''} · <code>${escapeHtml(row.action || '')}</code></p>
        ${eventActionButtons(row)}
        <details class="payload-details"><summary>事件详情</summary><pre>${escapeHtml(detailText)}</pre></details>
      </div>
    </article>`;
  }).join('') : '<div class="empty-state">没有匹配的系统日志。</div>';
  bindEventActions();
}

function bindEventActions() {
  document.querySelectorAll('[data-retry-failed]').forEach((button) => {
    button.onclick = async () => {
      try {
        const result = await api('/api/wechat/inbox/retry-failed', { method: 'POST', body: JSON.stringify({ limit: 10, notify: false }) });
        toast(`已重试 ${result.processed || 0} 条失败消息`);
        await loadEvents();
      } catch (error) { toast(error.message); }
    };
  });
  document.querySelectorAll('[data-create-backup]').forEach((button) => {
    button.onclick = async () => {
      try {
        await api('/api/backup/create', { method: 'POST', body: JSON.stringify({ reason: 'event-center', notify: false }) });
        toast('已创建本地备份');
        await loadEvents();
      } catch (error) { toast(error.message); }
    };
  });
}

async function loadEvents() {
  const data = await api(`/api/system/events?${queryString()}`);
  $('#eventUpdated').textContent = new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
  renderSummary(data.summary || []);
  renderEvents(data.rows || []);
}

$('#filterForm').onsubmit = (event) => {
  event.preventDefault();
  loadEvents().catch((error) => toast(error.message));
};
$('#refreshBtn').onclick = () => loadEvents().catch((error) => toast(error.message));
loadEvents().catch((error) => toast(error.message));
