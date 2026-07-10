const $ = (s) => document.querySelector(s);
let entries = [];

function e(v = '') {
  return String(v).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function toast(m) {
  const b = $('#toast');
  b.textContent = m;
  b.classList.add('show');
  setTimeout(() => b.classList.remove('show'), 2200);
}

function t(v) {
  return v ? new Date(v).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '--';
}

function shortText(value = '', max = 72) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function api(p, o = {}) {
  const r = await fetch(p, { headers: { 'Content-Type': 'application/json' }, ...o });
  if (!r.ok) throw new Error(await r.text() || '请求失败');
  return r.json();
}

function stat(k, v) {
  return `<span class="log-stat"><em>${e(k)}</em><b>${e(v)}</b></span>`;
}

async function loadSummary() {
  const s = await api('/api/finance/summary');
  $('#financeUpdated').textContent = t(new Date());
  $('#financeSummary').innerHTML = [
    stat('收入', `¥${Number(s.month.income || 0).toFixed(2)}`),
    stat('支出', `¥${Number(s.month.expense || 0).toFixed(2)}`),
    stat('结余', `¥${Number(s.month.balance || 0).toFixed(2)}`),
    stat('分类', s.categories.length),
  ].join('');
}

function render() {
  $('#entryCount').textContent = `${entries.length} 条`;
  $('#financeList').innerHTML = entries.length ? entries.map((x) => {
    const tone = x.direction === 'income' ? 'ok' : 'warn';
    const meta = `${x.direction === 'income' ? '收入' : '支出'} ¥${Number(x.amount).toFixed(2)} · ${x.category || ''}`;
    return `<article class="log-row tone-${tone}">
      <i class="log-dot" aria-hidden="true"></i>
      <div class="log-body">
        <div class="log-line"><strong title="${e(x.title)}">${e(shortText(x.title, 40))}</strong><time>${e(t(x.occurred_at))}</time></div>
        <div class="log-meta">
          <span title="${e(meta)}">${e(shortText(meta, 60))}</span>
          <button type="button" class="timeline-link" data-edit="${x.id}">编辑</button>
          <button type="button" class="timeline-link danger" data-delete="${x.id}">删除</button>
        </div>
        ${x.note || x.raw_message ? `<p class="log-extra">${e(shortText(x.note || x.raw_message, 90))}</p>` : ''}
      </div>
    </article>`;
  }).join('') : '<div class="empty-state">暂无流水</div>';
  document.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => editEntry(b.dataset.edit); });
  document.querySelectorAll('[data-delete]').forEach((b) => { b.onclick = () => deleteEntry(b.dataset.delete); });
}

async function loadEntries() {
  const d = Object.fromEntries(new FormData($('#financeFilter')).entries());
  const qs = new URLSearchParams();
  Object.entries(d).forEach(([k, v]) => { if (v) qs.set(k, v); });
  entries = await api(`/api/finance/entries?${qs}`);
  render();
}

async function editEntry(id) {
  const x = entries.find((i) => String(i.id) === String(id));
  const category = prompt('分类', x.category);
  if (!category) return;
  const title = prompt('标题', x.title) || x.title;
  await api(`/api/finance/entries/${id}`, { method: 'PATCH', body: JSON.stringify({ category, title }) });
  toast('已更新');
  await Promise.all([loadSummary(), loadEntries()]);
}

async function deleteEntry(id) {
  if (!confirm('删除这条流水？')) return;
  await api(`/api/finance/entries/${id}`, { method: 'DELETE' });
  toast('已删除');
  await Promise.all([loadSummary(), loadEntries()]);
}

$('#financeFilter').onsubmit = (ev) => {
  ev.preventDefault();
  loadEntries().catch((err) => toast(err.message));
};
$('#refreshBtn').onclick = () => Promise.all([loadSummary(), loadEntries()]);
Promise.all([loadSummary(), loadEntries()]).catch((err) => toast(err.message));
