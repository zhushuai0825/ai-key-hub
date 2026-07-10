const $ = (selector) => document.querySelector(selector);
let queries = [];
let activeKbId = null;
let summary = null;

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
  return new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}

function shortText(value = '', max = 56) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function requireKb() {
  if (!activeKbId) throw new Error('知识库尚未就绪');
}

function renderSummary() {
  $('#kbSummary').textContent = `${summary?.documents || 0} 文档 · ${summary?.chunks || 0} 片段`;
  $('#askKbName').textContent = '统一知识库';
}

function renderResults(rows) {
  $('#searchResults').innerHTML = rows.length ? rows.map((row, index) => `
    <article class="log-row tone-muted">
      <i class="log-dot" aria-hidden="true"></i>
      <div class="log-body">
        <div class="log-line">
          <strong title="${escapeHtml(row.document_title || '')}">#${index + 1} ${escapeHtml(shortText(row.document_title || '文档片段', 40))}</strong>
          <time>chunk ${row.chunk_index}</time>
        </div>
        <div class="log-meta">
          <span title="${escapeHtml(row.content || '')}">${escapeHtml(shortText(row.content, 80))}</span>
          <a class="timeline-link" href="${escapeHtml(row.href || `/knowledge.html?doc=${row.doc_id}&chunk=${row.chunk_index}`)}">原文</a>
        </div>
      </div>
    </article>`).join('') : '<div class="empty-state">没有检索到内容</div>';
}

function renderAnswer(data) {
  const sources = data.sources || [];
  const globalResults = data.global_results || [];
  $('#answerBox').innerHTML = `
    ${data.from_cache ? '<p class="log-extra accent-note">命中缓存，未重复调用 AI</p>' : ''}
    <div class="answer-text">${escapeHtml(data.answer || '').replace(/\n/g, '<br>')}</div>
    <div class="source-list">
      <strong>引用来源</strong>
      ${sources.length ? sources.map((item, index) => `<p>${index + 1}. <a href="${escapeHtml(item.href || `/knowledge.html?doc=${item.doc_id}&chunk=${item.chunk_index}`)}">${escapeHtml(item.document_title || item.filename || '文档片段')} · chunk ${item.chunk_index}</a></p>`).join('') : '<p>没有引用来源</p>'}
    </div>
    ${globalResults.length ? `<div class="source-list"><strong>全局搜索</strong>${globalResults.map((item) => `<p>${escapeHtml(item.type)} · ${escapeHtml(item.title)}</p>`).join('')}</div>` : ''}`;
}

function renderQueries() {
  $('#queryHistory').innerHTML = queries.length ? queries.map((item) => `
    <article class="log-row tone-muted">
      <i class="log-dot" aria-hidden="true"></i>
      <div class="log-body">
        <div class="log-line">
          <strong title="${escapeHtml(item.question)}">${escapeHtml(shortText(item.question, 42))}</strong>
          <time>${formatTime(item.created_at)}</time>
        </div>
        <div class="log-meta">
          <span title="${escapeHtml(item.answer || '')}">${escapeHtml(shortText(item.answer, 72))}</span>
        </div>
      </div>
    </article>`).join('') : '<div class="empty-state">暂无问答历史</div>';
}

async function loadPrimary() {
  const primary = await api('/api/knowledge/primary');
  activeKbId = primary.id;
  summary = await api('/api/knowledge/summary');
  renderSummary();
  await loadQueries();
  $('#answerBox').innerHTML = '<div class="empty-state">直接提问即可，所有文档都在同一个知识库里。</div>';
}

async function loadQueries() {
  if (!activeKbId) {
    queries = [];
    renderQueries();
    return;
  }
  queries = await api(`/api/knowledge/bases/${activeKbId}/queries`);
  renderQueries();
}

$('#searchForm').onsubmit = async (event) => {
  event.preventDefault();
  try {
    requireKb();
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (!payload.query?.trim()) throw new Error('请输入搜索内容');
    const rows = await api('/api/knowledge/search', { method: 'POST', body: JSON.stringify({ kb_id: activeKbId, query: payload.query }) });
    renderResults(rows);
  } catch (error) { toast(error.message); }
};

$('#askForm').onsubmit = async (event) => {
  event.preventDefault();
  try {
    requireKb();
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (!payload.question?.trim()) throw new Error('请输入问题');
    $('#answerBox').textContent = '正在检索知识库并调用 DeepSeek…';
    const data = await api('/api/knowledge/ask', { method: 'POST', body: JSON.stringify({ kb_id: activeKbId, question: payload.question }) });
    renderAnswer(data);
    summary = await api('/api/knowledge/summary');
    renderSummary();
    await loadQueries();
  } catch (error) { toast(error.message); }
};

loadPrimary().catch((error) => toast(error.message));
