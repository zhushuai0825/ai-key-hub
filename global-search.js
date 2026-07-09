const $ = (selector) => document.querySelector(selector);
let lastBundle = null;

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!res.ok) throw new Error(await res.text() || '请求失败');
  return res.json();
}

function toast(message) {
  const box = $('#toast');
  box.textContent = message;
  box.classList.add('show');
  setTimeout(() => box.classList.remove('show'), 2200);
}

function formatTime(value) {
  if (!value) return '--';
  return new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}

function typeLabel(type) {
  return { knowledge: '知识库', finance: '账本', fitness: '健康', memory: '记忆', task: '提醒', wechat: '企微', report: '报告' }[type] || type;
}

function renderBundle(bundle) {
  lastBundle = bundle;
  const items = bundle.items || [];
  $('#resultCount').textContent = `${items.length} 条`;
  const groups = bundle.groups || {};
  $('#groupSummary').innerHTML = Object.entries(groups).map(([type, rows]) => `
    <article class="monitor-card"><div><strong>${escapeHtml(typeLabel(type))}</strong><span class="state-pill ok">${rows.length}</span></div><p>${escapeHtml(type)} results</p></article>`).join('');
  $('#globalResultList').innerHTML = items.length ? items.map((item) => `
    <article class="global-result-card type-${escapeHtml(item.type)}">
      <div class="timeline-title"><strong>${escapeHtml(item.title)}</strong><time>${escapeHtml(formatTime(item.time))}</time></div>
      <p>${escapeHtml(item.preview || '')}</p>
      <div class="meta">${escapeHtml(typeLabel(item.type))} · #${escapeHtml(item.id)} · ${escapeHtml(item.meta || '')}</div>
    </article>`).join('') : '<div class="empty-state">没有找到相关数据。</div>';
}

$('#globalSearchForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = new FormData(event.currentTarget).get('query');
  if (!String(query || '').trim()) return toast('请输入搜索内容');
  $('#globalResultList').innerHTML = '<div class="empty-state">正在搜索所有数据...</div>';
  try {
    renderBundle(await api('/api/global-search', { method: 'POST', body: JSON.stringify({ query, limit: 8 }) }));
  } catch (error) {
    toast(error.message);
  }
});

$('#globalAskBtn').addEventListener('click', async () => {
  const query = new FormData($('#globalSearchForm')).get('query');
  if (!String(query || '').trim()) return toast('请输入问题');
  $('#globalAnswerBox').innerHTML = '<div class="empty-state">正在搜索全局数据并生成回答...</div>';
  try {
    const data = await api('/api/global-answer', { method: 'POST', body: JSON.stringify({ question: query, limit: 10 }) });
    $('#globalAnswerBox').innerHTML = `<div class="answer-text">${escapeHtml(data.answer || '').replace(/\n/g, '<br>')}</div><div class="source-list"><strong>引用的全局结果</strong>${(data.global_results || []).map((item) => `<p>${escapeHtml(typeLabel(item.type))} · ${escapeHtml(item.title)}</p>`).join('')}</div>`;
    renderBundle({ items: data.global_results || [], groups: {} });
  } catch (error) {
    toast(error.message);
  }
});

const initial = new URLSearchParams(location.search).get('q');
if (initial) {
  $('#globalSearchForm').query.value = initial;
  $('#globalSearchForm').dispatchEvent(new Event('submit'));
}
