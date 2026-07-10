const $ = (s) => document.querySelector(s);
let tasks = [];

function escapeHtml(v = '') {
  return String(v).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function toast(m) {
  const b = $('#toast');
  b.textContent = m;
  b.classList.add('show');
  setTimeout(() => b.classList.remove('show'), 2200);
}

function formatTime(v) {
  return v ? new Date(v).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '未设置';
}

function shortText(value = '', max = 56) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function api(p, o = {}) {
  const r = await fetch(p, { headers: { 'Content-Type': 'application/json' }, ...o });
  if (!r.ok) throw new Error(await r.text() || '请求失败');
  return r.json();
}

function statusLabel(s) {
  return { pending: '待提醒', done: '已完成', paused: '已暂停' }[s] || s;
}

function toneFor(s) {
  if (s === 'done') return 'ok';
  if (s === 'paused') return 'muted';
  return 'warn';
}

function render() {
  $('#taskList').innerHTML = tasks.length ? tasks.map((t) => {
    const meta = [t.from_user || '无用户', statusLabel(t.status), t.recurrence || 'none'].join(' · ');
    return `<article class="log-row tone-${toneFor(t.status)}">
      <i class="log-dot" aria-hidden="true"></i>
      <div class="log-body">
        <div class="log-line"><strong title="${escapeHtml(t.title)}">${escapeHtml(shortText(t.title, 40))}</strong><time>${escapeHtml(formatTime(t.remind_at))}</time></div>
        <div class="log-meta">
          <span title="${escapeHtml(meta)}">${escapeHtml(shortText(meta, 70))}</span>
          <button type="button" class="timeline-link" data-done="${t.id}" ${t.status === 'done' ? 'disabled' : ''}>完成</button>
          <button type="button" class="timeline-link" data-pause="${t.id}">${t.status === 'paused' ? '恢复' : '暂停'}</button>
          <button type="button" class="timeline-link" data-edit="${t.id}">编辑</button>
          <button type="button" class="timeline-link danger" data-delete="${t.id}">删除</button>
        </div>
        ${t.note ? `<p class="log-extra">${escapeHtml(shortText(t.note, 90))}</p>` : ''}
      </div>
    </article>`;
  }).join('') : '<div class="empty-state">暂无提醒任务</div>';

  document.querySelectorAll('[data-done]').forEach((b) => { b.onclick = () => updateTask(b.dataset.done, { status: 'done' }); });
  document.querySelectorAll('[data-pause]').forEach((b) => {
    const t = tasks.find((x) => String(x.id) === b.dataset.pause);
    b.onclick = () => updateTask(b.dataset.pause, { status: t?.status === 'paused' ? 'pending' : 'paused' });
  });
  document.querySelectorAll('[data-delete]').forEach((b) => { b.onclick = () => deleteTask(b.dataset.delete); });
  document.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => editTask(b.dataset.edit); });
}

async function load() {
  const s = $('#statusFilter').value;
  tasks = await api(`/api/assistant/tasks${s ? `?status=${s}` : ''}`);
  render();
}

async function updateTask(id, payload) {
  await api(`/api/assistant/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
  toast('任务已更新');
  await load();
}

async function deleteTask(id) {
  if (!confirm('删除这个提醒？')) return;
  await api(`/api/assistant/tasks/${id}`, { method: 'DELETE' });
  toast('任务已删除');
  await load();
}

async function editTask(id) {
  const t = tasks.find((x) => String(x.id) === String(id));
  if (!t) return;
  const title = prompt('提醒标题', t.title);
  if (!title) return;
  const note = prompt('备注', t.note || '') ?? t.note;
  await updateTask(id, { title, note });
}

$('#taskForm').onsubmit = async (e) => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.currentTarget).entries());
  await api('/api/assistant/tasks', { method: 'POST', body: JSON.stringify(d) });
  e.currentTarget.reset();
  toast('提醒已创建');
  await load();
};
$('#statusFilter').onchange = load;
$('#runDueBtn').onclick = async () => {
  const r = await api('/api/assistant/tasks/run-due', { method: 'POST' });
  toast(`已检查，处理 ${r.processed || 0} 条`);
  await load();
};
load().catch((e) => toast(e.message));
