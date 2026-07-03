const $ = (selector) => document.querySelector(selector);
let bases = [];
let docs = [];
let categories = [];
let activeKbId = null;
let summary = null;

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

async function api(path, options = {}) {
  const headers = options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' };
  const res = await fetch(path, { headers, ...options });
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

function statusLabel(status) {
  const labels = { ready: '向量已入库', ready_pg_only: '本地检索', processing: '处理中', pending: '待处理' };
  return labels[status] || status || '未知';
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
      <div class="row-actions"><button class="danger-btn" type="button" data-delete-base="${base.id}">删除</button></div>
    </article>`).join('') : '<div class="empty-state">暂无知识库，先新建一个用于管理资料。</div>';
  document.querySelectorAll('[data-base]').forEach((el) => {
    el.onclick = (event) => {
      if (event.target.dataset.deleteBase) return;
      activeKbId = Number(el.dataset.base);
      renderBases();
      renderActiveName();
      loadDocuments();
    };
  });
  document.querySelectorAll('[data-delete-base]').forEach((button) => { button.onclick = () => deleteBase(Number(button.dataset.deleteBase)); });
}

function renderCategories() {
  $('#categorySelect').innerHTML = categories.map((category) => `<option value="${escapeHtml(category.code)}">${escapeHtml(category.name)}</option>`).join('');
  $('#categoryList').innerHTML = categories.length ? categories.map((category) => `
    <article class="category-card">
      <div><strong>${escapeHtml(category.name)}</strong><span>${category.base_count || 0} 个知识库</span></div>
      <div class="row-actions">
        <button type="button" data-edit-category="${category.id}">改名</button>
        <button class="danger-btn" type="button" data-delete-category="${category.id}" ${category.code === 'general' ? 'disabled' : ''}>删除</button>
      </div>
    </article>`).join('') : '<div class="empty-state">暂无分类。</div>';
  document.querySelectorAll('[data-edit-category]').forEach((button) => {
    button.onclick = () => renameCategory(Number(button.dataset.editCategory));
  });
  document.querySelectorAll('[data-delete-category]').forEach((button) => {
    button.onclick = () => deleteCategory(Number(button.dataset.deleteCategory));
  });
}

function renderActiveName() {
  const current = activeBase();
  $('#activeKbName').textContent = current ? `${current.name} · ${current.document_count || 0} 文档` : '请选择知识库';
}

function renderDocs() {
  $('#docList').innerHTML = docs.length ? docs.map((doc) => `
    <article class="doc-card">
      <div class="doc-title-row">
        <strong>${escapeHtml(doc.title)}</strong>
        <span class="status-pill ${doc.status === 'ready' ? 'ok' : ''}">${escapeHtml(statusLabel(doc.status))}</span>
      </div>
      <p>${escapeHtml(doc.filename || doc.source_type)} · ${doc.raw_text?.length || 0} 字符</p>
      <div class="meta">${doc.chunk_count || 0} 向量片段 · ${formatTime(doc.created_at)}</div>
      ${doc.error_message ? `<p class="error-text">${escapeHtml(doc.error_message)}</p>` : ''}
      <div class="row-actions"><button class="danger-btn" type="button" data-delete-doc="${doc.id}">删除文档</button></div>
    </article>`).join('') : '<div class="empty-state">当前知识库暂无文档。支持粘贴文本，也支持 TXT、MD、PDF、DOCX、JSON、CSV。</div>';
  document.querySelectorAll('[data-delete-doc]').forEach((button) => { button.onclick = () => deleteDoc(Number(button.dataset.deleteDoc)); });
}

async function loadBases() {
  [summary, bases, categories] = await Promise.all([api('/api/knowledge/summary'), api('/api/knowledge/bases'), api('/api/knowledge/categories')]);
  if (!activeKbId && bases[0]) activeKbId = bases[0].id;
  if (activeKbId && !bases.some((base) => Number(base.id) === Number(activeKbId))) activeKbId = bases[0]?.id || null;
  renderCategories();
  renderBases();
  renderActiveName();
  await loadDocuments();
}

async function loadDocuments() {
  if (!activeKbId) {
    docs = [];
    renderDocs();
    return;
  }
  docs = await api(`/api/knowledge/bases/${activeKbId}/documents`);
  renderDocs();
}

async function deleteBase(id) {
  if (!confirm('删除这个知识库及所有文档和向量？')) return;
  await api(`/api/knowledge/bases/${id}`, { method: 'DELETE' });
  if (Number(activeKbId) === Number(id)) activeKbId = null;
  toast('知识库已删除');
  await loadBases();
}

async function deleteDoc(id) {
  if (!confirm('删除这个文档及对应向量？')) return;
  await api(`/api/knowledge/documents/${id}`, { method: 'DELETE' });
  toast('文档已删除');
  await loadBases();
}

async function renameCategory(id) {
  const current = categories.find((category) => Number(category.id) === Number(id));
  const name = prompt('输入新的分类名称', current?.name || '');
  if (!name?.trim()) return;
  await api(`/api/knowledge/categories/${id}`, { method: 'PUT', body: JSON.stringify({ name: name.trim() }) });
  toast('分类已修改');
  await loadBases();
}

async function deleteCategory(id) {
  const current = categories.find((category) => Number(category.id) === Number(id));
  if (!current) return;
  if (!confirm(`删除分类“${current.name}”？已有知识库会移到“通用”。`)) return;
  await api(`/api/knowledge/categories/${id}`, { method: 'DELETE' });
  toast('分类已删除');
  await loadBases();
}

$('#baseForm').onsubmit = async (event) => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
  const base = await api('/api/knowledge/bases', { method: 'POST', body: JSON.stringify(payload) });
  event.currentTarget.reset();
  activeKbId = base.id;
  toast('知识库已创建');
  await loadBases();
};

$('#categoryForm').onsubmit = async (event) => {
  event.preventDefault();
  try {
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (!payload.name?.trim()) throw new Error('请输入分类名称');
    await api('/api/knowledge/categories', { method: 'POST', body: JSON.stringify({ name: payload.name.trim() }) });
    event.currentTarget.reset();
    toast('分类已添加');
    await loadBases();
  } catch (error) { toast(error.message); }
};

$('#textForm').onsubmit = async (event) => {
  event.preventDefault();
  try {
    requireKb();
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (!payload.text?.trim()) throw new Error('请输入文本内容');
    await api(`/api/knowledge/bases/${activeKbId}/documents/text`, { method: 'POST', body: JSON.stringify(payload) });
    event.currentTarget.reset();
    toast('文本已切分并入库');
    await loadBases();
  } catch (error) { toast(error.message); }
};

$('#uploadForm').onsubmit = async (event) => {
  event.preventDefault();
  try {
    requireKb();
    const formData = new FormData(event.currentTarget);
    if (!formData.get('file')?.name) throw new Error('请选择文件');
    await api(`/api/knowledge/bases/${activeKbId}/documents/upload`, { method: 'POST', body: formData });
    event.currentTarget.reset();
    toast('文件已解析、切分并入库');
    await loadBases();
  } catch (error) { toast(error.message); }
};

loadBases().catch((error) => toast(error.message));
