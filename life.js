const $ = (s) => document.querySelector(s);

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function toast(message) {
  const box = $('#toast');
  box.textContent = message;
  box.classList.add('show');
  setTimeout(() => box.classList.remove('show'), 2400);
}

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || '请求失败');
  return data;
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

function typeLabel(type) {
  return {
    finance: '账本', fitness: '健康', knowledge: '知识库', wechat: '企微',
    task: '提醒', report: '报告', audit: '运维', memory: '记忆', query: '问答',
  }[type] || type;
}

function typeTone(type) {
  if (type === 'finance') return 'tone-warn';
  if (type === 'wechat' || type === 'query') return 'tone-info';
  if (type === 'task') return 'tone-ok';
  if (type === 'audit') return 'tone-muted';
  return 'tone-muted';
}

function sinceIso(days) {
  return new Date(Date.now() - Number(days || 7) * 24 * 60 * 60 * 1000).toISOString();
}

function detailPreview(row) {
  const d = row.detail || {};
  if (row.type === 'finance') return `${d.direction === 'income' ? '收入' : '支出'} ¥${Number(d.amount || 0).toFixed(2)} · ${d.category || ''}`;
  if (row.type === 'wechat') return `${d.intent || ''} · ${shortText(d.reply_text || '', 40)}`;
  if (row.type === 'task') return `${d.status || ''} · ${shortText(d.note || '', 40)}`;
  if (row.type === 'memory') return `${d.category || ''} · 重要度 ${d.importance ?? '-'}`;
  if (row.type === 'query') return shortText(d.answer || '', 60);
  return shortText(JSON.stringify(d), 60);
}

function renderStats(stats = {}) {
  const byType = stats.by_type || {};
  const chips = [
    `<span class="log-stat"><em>事件</em><b>${stats.total || 0}</b></span>`,
    `<span class="log-stat"><em>支出</em><b>¥${Number(stats.spend || 0).toFixed(0)}</b></span>`,
    `<span class="log-stat"><em>收入</em><b>¥${Number(stats.income || 0).toFixed(0)}</b></span>`,
    ...Object.entries(byType).slice(0, 6).map(([type, count]) => (
      `<span class="log-stat"><em>${escapeHtml(typeLabel(type))}</em><b>${count}</b></span>`
    )),
  ];
  $('#lifeStats').innerHTML = chips.join('');
}

function renderList(rows = []) {
  $('#lifeCount').textContent = `${rows.length} 条`;
  $('#lifeList').innerHTML = rows.length
    ? rows.map((row) => `
      <article class="log-row ${typeTone(row.type)}">
        <i class="log-dot" aria-hidden="true"></i>
        <div class="log-body">
          <div class="log-line">
            <strong title="${escapeHtml(row.title || '')}">${escapeHtml(typeLabel(row.type))} · ${escapeHtml(shortText(row.title, 48))}</strong>
            <time>${escapeHtml(formatTime(row.event_at))}</time>
          </div>
          <div class="log-meta"><span>${escapeHtml(detailPreview(row))}</span></div>
        </div>
      </article>`).join('')
    : '<div class="empty-state">这段时间没有事件</div>';
}

async function loadFeed() {
  const form = $('#lifeFilterForm');
  const data = new FormData(form);
  const days = data.get('days') || '7';
  const params = new URLSearchParams({
    limit: '160',
    since: sinceIso(days),
  });
  const type = data.get('type');
  const q = data.get('q');
  if (type) params.set('type', type);
  if (q) params.set('q', q);
  $('#lifeList').innerHTML = '<div class="empty-state">加载中…</div>';
  try {
    const rows = await api(`/api/timeline?${params}`);
    renderList(rows);
  } catch (error) {
    toast(error.message);
    $('#lifeList').innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

async function askLife(question, days) {
  $('#lifeRangeLabel').textContent = `近 ${days} 天`;
  $('#lifeAnswerBox').innerHTML = '<div class="empty-state">正在串起时间轴…</div>';
  try {
    const data = await api('/api/life/ask', {
      method: 'POST',
      body: JSON.stringify({ question, days: Number(days || 7), limit: 180 }),
    });
    renderStats(data.stats || {});
    $('#lifeAnswerBox').innerHTML = `
      <div class="answer-text">${escapeHtml(data.answer || '').replace(/\n/g, '<br>')}</div>
      <div class="source-list"><strong>依据事件</strong>${
        (data.sources || []).slice(0, 8).map((row) => (
          `<p>${escapeHtml(typeLabel(row.type))} · ${escapeHtml(shortText(row.title, 50))} · ${escapeHtml(formatTime(row.event_at))}</p>`
        )).join('') || '<p>无</p>'
      }</div>`;
    if (data.sources?.length) renderList(data.sources);
  } catch (error) {
    toast(error.message);
    $('#lifeAnswerBox').innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

$('#lifeAskForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const question = String(data.get('question') || '').trim();
  if (!question) return toast('请先输入问题');
  askLife(question, data.get('days'));
});

$('#lifeFilterForm').addEventListener('submit', (event) => {
  event.preventDefault();
  loadFeed();
});

$('#lifeChips')?.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-q]');
  if (!btn) return;
  const form = $('#lifeAskForm');
  form.question.value = btn.dataset.q;
  askLife(btn.dataset.q, form.days.value);
});

loadFeed();
