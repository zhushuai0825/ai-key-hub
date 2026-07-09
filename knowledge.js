const $ = (selector) => document.querySelector(selector);
let docs = [];
let activeKbId = null;
let summary = null;
let quality = { summary: [], documents: [] };

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

function requireKb() {
  if (!activeKbId) throw new Error('知识库尚未就绪');
}

function statusLabel(status) {
  const labels = { ready: '向量已入库', ready_pg_only: '本地检索', processing: '处理中', pending: '待处理' };
  return labels[status] || status || '未知';
}

function qualityLabel(status) {
  return { ok: '质量正常', warn: '需要关注', bad: '存在问题', unchecked: '未检测' }[status] || status || '未检测';
}

function pillClass(status) {
  if (status === 'ok' || status === 'ready') return 'ok';
  if (status === 'warn' || status === 'ready_pg_only') return 'warn';
  if (status === 'bad') return 'bad';
  return '';
}

function sourceLabel(doc) {
  if (doc.source_type === 'wechat_text') return '企业微信文本';
  if (doc.source_type === 'image_ocr') return '图片 OCR';
  if (doc.source_channel === 'wechat') return '企业微信上传';
  if (doc.source_type === 'upload') return '网页上传';
  if (doc.source_type === 'text') return '网页文本';
  return doc.source_type || '未知来源';
}

function renderSummary() {
  $('#kbSummary').textContent = `${summary?.documents || 0} 文档 · ${summary?.chunks || 0} 向量片段 · 全部资料统一存放`;
  $('#docCount').textContent = `${docs.length} 篇`;
}

function renderDocs() {
  renderSummary();
  $('#docList').innerHTML = docs.length ? docs.map((doc) => `
    <article class="doc-card">
      <div class="doc-title-row">
        <strong>${escapeHtml(doc.title)}</strong>
        <span class="status-pill ${pillClass(doc.status)}">${escapeHtml(statusLabel(doc.status))}</span>
        <span class="status-pill ${pillClass(doc.quality_status)}">${escapeHtml(qualityLabel(doc.quality_status))}</span>
      </div>
      <p>${escapeHtml(doc.filename || doc.source_type)} · ${doc.raw_text?.length || 0} 字符 · v${doc.version || 1}</p>
      <div class="meta">${doc.chunk_count || 0} 向量片段 · ${formatTime(doc.created_at)}</div>
      <div class="doc-source-row">
        <span>${escapeHtml(sourceLabel(doc))}</span>
        ${doc.source_user ? `<span>上传人：${escapeHtml(doc.source_user)}</span>` : ''}
        ${doc.source_note ? `<span>${escapeHtml(doc.source_note)}</span>` : ''}
      </div>
      ${doc.error_message ? `<p class="error-text">${escapeHtml(doc.error_message)}</p>` : ''}
      <div class="row-actions">
        <button type="button" data-detail-doc="${doc.id}">查看详情</button>
        <button type="button" data-reindex-doc="${doc.id}">重建向量</button>
        <button class="danger-btn" type="button" data-delete-doc="${doc.id}">删除文档</button>
      </div>
    </article>`).join('') : '<div class="empty-state">还没有文档。粘贴文本或上传文件即可入库；企微发文件也会进这里。</div>';
  document.querySelectorAll('[data-detail-doc]').forEach((button) => { button.onclick = () => loadDocDetail(Number(button.dataset.detailDoc)); });
  document.querySelectorAll('[data-reindex-doc]').forEach((button) => { button.onclick = () => reindexDoc(Number(button.dataset.reindexDoc)); });
  document.querySelectorAll('[data-delete-doc]').forEach((button) => { button.onclick = () => deleteDoc(Number(button.dataset.deleteDoc)); });
}

function renderDocDetail(payload) {
  const doc = payload.document;
  $('#docDetailMeta').textContent = `#${doc.id} · v${doc.version || 1} · ${doc.chunk_count || 0} 片段`;
  $('#docDetail').classList.remove('empty-state');
  $('#docDetail').innerHTML = `
    <article class="doc-detail-card">
      <div class="doc-title-row"><strong>${escapeHtml(doc.title)}</strong><span class="status-pill ${pillClass(doc.status)}">${escapeHtml(statusLabel(doc.status))}</span><span class="status-pill ${pillClass(doc.quality_status)}">${escapeHtml(qualityLabel(doc.quality_status))}</span></div>
      <p>${escapeHtml(doc.filename || doc.source_type || '')}</p>
      <div class="meta">v${doc.version || 1} · ${formatTime(doc.created_at)} · ${doc.raw_text?.length || 0} 字符</div>
      ${(doc.quality_issues || []).length ? `<div class="inbox-relations">${doc.quality_issues.map((issue) => `<span>${escapeHtml(issue.type)}：${escapeHtml(issue.message)}</span>`).join('')}</div>` : ''}
      ${doc.error_message ? `<p class="error-text">${escapeHtml(doc.error_message)}</p>` : ''}
      <div class="detail-actions">
        <button type="button" data-reindex-doc="${doc.id}">重建当前文档向量</button>
        <button type="button" data-quality-doc="${doc.id}">重新检测质量</button>
        <button class="danger-btn" type="button" data-delete-duplicates="${doc.id}" ${payload.duplicates.length ? '' : 'disabled'}>删除重复文档 ${payload.duplicates.length}</button>
      </div>
    </article>
    <section class="detail-section"><h3>版本记录</h3>${payload.versions?.length ? payload.versions.map((v) => `<div class="mini-row"><strong>#${v.id} v${v.version} ${escapeHtml(v.title)}</strong><span>${escapeHtml(v.version_status)} · ${formatTime(v.created_at)}</span></div>`).join('') : '<div class="empty-state">暂无版本记录。</div>'}</section>
    <section class="detail-section"><h3>切分片段</h3>${payload.chunks.length ? payload.chunks.map((chunk) => `
      <details class="chunk-card" id="chunk-${chunk.chunk_index}"><summary>#${chunk.chunk_index} · ${chunk.char_count} 字符</summary><pre>${escapeHtml(chunk.content)}</pre></details>`).join('') : '<div class="empty-state">暂无切片。</div>'}</section>
    <section class="detail-section"><h3>重复文档</h3>${payload.duplicates.length ? payload.duplicates.map((dup) => `
      <div class="mini-row"><strong>#${dup.id} ${escapeHtml(dup.title)}</strong><span>${escapeHtml(statusLabel(dup.status))} · ${formatTime(dup.created_at)}</span></div>`).join('') : '<div class="empty-state">没有发现同名重复文档。</div>'}</section>
    <section class="detail-section"><h3>相关问答记录</h3>${payload.queries.length ? payload.queries.map((query) => `
      <details class="query-card"><summary>${escapeHtml(query.question)} · ${formatTime(query.created_at)}</summary><p>${escapeHtml(query.answer)}</p></details>`).join('') : '<div class="empty-state">暂无引用这个文档的问答记录。</div>'}</section>`;
  $('#docDetail').querySelectorAll('[data-reindex-doc]').forEach((button) => { button.onclick = () => reindexDoc(Number(button.dataset.reindexDoc)); });
  $('#docDetail').querySelectorAll('[data-quality-doc]').forEach((button) => { button.onclick = () => qualityDoc(Number(button.dataset.qualityDoc)); });
  $('#docDetail').querySelectorAll('[data-delete-duplicates]').forEach((button) => { button.onclick = () => deleteDuplicates(Number(button.dataset.deleteDuplicates)); });
  const chunk = new URLSearchParams(location.search).get('chunk');
  if (chunk) document.getElementById(`chunk-${chunk}`)?.scrollIntoView({ block: 'center' });
}

function renderQuality() {
  const counts = Object.fromEntries((quality.summary || []).map((item) => [item.quality_status, item.count]));
  $('#qualitySummary').innerHTML = ['bad', 'warn', 'ok', 'unchecked'].map((status) => `<article class="monitor-card"><div><strong>${escapeHtml(qualityLabel(status))}</strong><span class="state-pill ${pillClass(status)}">${counts[status] || 0}</span></div><p>${escapeHtml(status)}</p></article>`).join('');
  $('#qualityList').innerHTML = (quality.documents || []).length ? quality.documents.map((doc) => `<article class="timeline-item"><div class="timeline-mark ${pillClass(doc.quality_status)}">${escapeHtml(qualityLabel(doc.quality_status))}</div><div class="timeline-main"><div class="timeline-title"><strong>${escapeHtml(doc.title)}</strong><time>${formatTime(doc.updated_at)}</time></div><p>${escapeHtml((doc.quality_issues || []).map((i) => i.message).join('；') || doc.status)}</p><div class="row-actions"><button type="button" data-detail-doc="${doc.id}">查看详情</button><button type="button" data-quality-doc="${doc.id}">重新检测</button></div></div></article>`).join('') : '<div class="empty-state">没有检测到质量问题。</div>';
  $('#qualityList').querySelectorAll('[data-detail-doc]').forEach((button) => { button.onclick = () => loadDocDetail(Number(button.dataset.detailDoc)); });
  $('#qualityList').querySelectorAll('[data-quality-doc]').forEach((button) => { button.onclick = () => qualityDoc(Number(button.dataset.qualityDoc)); });
}

async function loadDocDetail(id) {
  $('#docDetailMeta').textContent = '加载中';
  const payload = await api(`/api/knowledge/documents/${id}`);
  renderDocDetail(payload);
}

async function reindexDoc(id) {
  if (!confirm('重新切分并写入向量库？')) return;
  await api(`/api/knowledge/documents/${id}/reindex`, { method: 'POST' });
  toast('向量已重建');
  await loadDocuments();
  await loadDocDetail(id).catch(() => {});
}

async function deleteDuplicates(id) {
  if (!confirm('删除这个文档的同名重复文档？当前文档会保留。')) return;
  const result = await api(`/api/knowledge/documents/${id}/duplicates`, { method: 'DELETE' });
  toast(`已删除 ${result.deleted} 个重复文档`);
  await loadDocuments();
  await loadDocDetail(id).catch(() => {});
}

async function loadPrimary() {
  const primary = await api('/api/knowledge/primary');
  activeKbId = primary.id;
  summary = await api('/api/knowledge/summary');
  await loadDocuments();
  const initialDoc = Number(new URLSearchParams(location.search).get('doc') || 0);
  if (initialDoc) loadDocDetail(initialDoc).catch((error) => toast(error.message));
}

async function loadDocuments() {
  if (!activeKbId) {
    docs = [];
    renderDocs();
    return;
  }
  [summary, docs] = await Promise.all([
    api('/api/knowledge/summary'),
    api(`/api/knowledge/bases/${activeKbId}/documents`),
  ]);
  renderDocs();
  await loadQuality().catch(() => {});
}

async function loadQuality() {
  quality = await api(`/api/knowledge/quality${activeKbId ? `?kb_id=${activeKbId}` : ''}`);
  renderQuality();
}

async function qualityDoc(id) {
  await api(`/api/knowledge/documents/${id}/quality`, { method: 'POST' });
  toast('质量检测已更新');
  await loadQuality();
  await loadDocDetail(id).catch(() => {});
}

async function deleteDoc(id) {
  if (!confirm('删除这个文档及对应向量？')) return;
  await api(`/api/knowledge/documents/${id}`, { method: 'DELETE' });
  toast('文档已删除');
  await loadDocuments();
  $('#docDetail').classList.add('empty-state');
  $('#docDetail').textContent = '文档已删除。';
  $('#docDetailMeta').textContent = '未选择';
}

$('#textForm').onsubmit = async (event) => {
  event.preventDefault();
  try {
    requireKb();
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (!payload.text?.trim()) throw new Error('请输入文本内容');
    await api(`/api/knowledge/bases/${activeKbId}/documents/text`, { method: 'POST', body: JSON.stringify(payload) });
    event.currentTarget.reset();
    toast('文本已切分并入库');
    await loadDocuments();
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
    await loadDocuments();
  } catch (error) { toast(error.message); }
};

$('#refreshQualityBtn').onclick = () => loadQuality().catch((error) => toast(error.message));

$('#reindexAllBtn').onclick = async () => {
  if (!confirm('重建全部文档向量？可能需要一些时间。')) return;
  try {
    const result = await api('/api/knowledge/reindex', { method: 'POST' });
    toast(`已处理 ${result.ok}/${result.processed} 篇`);
    await loadDocuments();
  } catch (error) { toast(error.message); }
};

loadPrimary().catch((error) => toast(error.message));
