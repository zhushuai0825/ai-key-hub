const $ = (selector) => document.querySelector(selector);
let bases = [];
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

function activeBase() {
  return bases.find((base) => Number(base.id) === Number(activeKbId));
}

function requireKb() {
  if (!activeKbId) throw new Error('请先选择知识库');
}

function renderBases() {
  $('#kbSummary').textContent = `${summary?.bases || 0} 库 · ${summary?.documents || 0} 文档 · ${summary?.chunks || 0} 向量片段`;
  $('#baseList').innerHTML = bases.length ? bases.map((base) => `
    <article class="base-card ${Number(base.id) === Number(activeKbId) ? 'active' : ''}" data-base="${base.id}">
      <div class="card-main">
        <strong>${escapeHtml(base.name)}</strong>
        <p>${escapeHtml(base.description || '暂无描述')}</p>
        <div class="meta">${escapeHtml(base.category)} · ${base.document_count || 0} 文档 · ${base.chunk_count || 0} 向量片段</div>
      </div>
    </article>`).join('') : '<div class="empty-state">还没有知识库。请先去“管理知识库”上传资料。</div>';
  document.querySelectorAll('[data-base]').forEach((el) => {
    el.onclick = () => {
      activeKbId = Number(el.dataset.base);
      renderBases();
      renderActiveName();
      loadQueries();
      $('#answerBox').innerHTML = '<div class="empty-state">已切换知识库，可以开始提问。</div>';
      $('#searchResults').innerHTML = '';
    };
  });
}

function renderActiveName() {
  const current = activeBase();
  const name = current ? current.name : '请选择知识库';
  $('#askKbName').textContent = name;
  $('#searchKbName').textContent = name;
}

function renderResults(rows) {
  $('#searchResults').innerHTML = rows.length ? rows.map((row, index) => `
    <article class="result-card">
      <strong>#${index + 1} ${escapeHtml(row.document_title || '文档片段')}</strong>
      <p>${escapeHtml(row.content)}</p>
      <div class="meta">chunk ${row.chunk_index} · score ${row.score === null || row.score === undefined ? '--' : Number(row.score).toFixed(4)}</div>
    </article>`).join('') : '<div class="empty-state">没有检索到内容。</div>';
}

function renderAnswer(data) {
  const sources = data.sources || [];
  const globalResults = data.global_results || [];
  $('#answerBox').innerHTML = `
    ${data.from_cache ? '<div class="meta" style="margin-bottom:10px;color:var(--accent)">命中缓存，未重复调用 AI</div>' : ''}
    <div class="answer-text">${escapeHtml(data.answer || '').replace(/\n/g, '<br>')}</div>
    <div class="source-list">
      <strong>引用来源</strong>
      ${sources.length ? sources.map((item, index) => `<p>${index + 1}. ${escapeHtml(item.document_title || item.filename || '文档片段')} · chunk ${item.chunk_index}</p>`).join('') : '<p>没有引用来源。</p>'}
    </div>`;
  if (globalResults.length) {
    $('#answerBox').innerHTML += `<div class="source-list"><strong>全局搜索结果</strong>${globalResults.map((item) => `<p>${escapeHtml(item.type)} · ${escapeHtml(item.title)} · ${escapeHtml(item.meta || '')}</p>`).join('')}</div>`;
  }
}

function renderQueries() {
  $('#queryHistory').innerHTML = queries.length ? queries.map((item) => `
    <article class="history-card">
      <strong>${escapeHtml(item.question)}</strong>
      <p>${escapeHtml(item.answer).slice(0, 180)}${item.answer.length > 180 ? '...' : ''}</p>
      <div class="meta">${formatTime(item.created_at)}</div>
    </article>`).join('') : '<div class="empty-state">暂无问答历史。</div>';
}

async function loadBases() {
  [summary, bases] = await Promise.all([api('/api/knowledge/summary'), api('/api/knowledge/bases')]);
  if (!activeKbId && bases[0]) activeKbId = bases[0].id;
  renderBases();
  renderActiveName();
  await loadQueries();
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
    $('#answerBox').textContent = '正在检索知识库并调用 DeepSeek...';
    const data = await api('/api/knowledge/ask', { method: 'POST', body: JSON.stringify({ kb_id: activeKbId, question: payload.question }) });
    renderAnswer(data);
    await loadQueries();
    await loadBases();
  } catch (error) { toast(error.message); }
};

loadBases().catch((error) => toast(error.message));
