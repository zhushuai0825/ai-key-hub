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

function shortText(value = '', max = 56) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function renderSummary() {
  $('#kbSummary').textContent = `${summary?.documents || 0} 文档 · ${summary?.chunks || 0} 片段`;
  $('#docCount').textContent = `${docs.length} 篇`;
}

function renderDocs() {
  renderSummary();
  $('#docList').innerHTML = docs.length ? docs.map((doc) => {
    const meta = [
      statusLabel(doc.status),
      qualityLabel(doc.quality_status),
      sourceLabel(doc),
      `${doc.chunk_count || 0} 片段`,
      doc.source_user || '',
    ].filter(Boolean).join(' · ');
    return `<article class="log-row tone-${pillClass(doc.status) || pillClass(doc.quality_status) || 'muted'}">
      <i class="log-dot" aria-hidden="true"></i>
      <div class="log-body">
        <div class="log-line">
          <strong title="${escapeHtml(doc.title)}">${escapeHtml(shortText(doc.title, 48))}</strong>
          <time>${escapeHtml(formatTime(doc.created_at))}</time>
        </div>
        <div class="log-meta">
          <span title="${escapeHtml(meta)}">${escapeHtml(shortText(meta, 90))}</span>
          <button type="button" class="timeline-link" data-detail-doc="${doc.id}">详情</button>
          <button type="button" class="timeline-link" data-reindex-doc="${doc.id}">重建</button>
          <button type="button" class="timeline-link danger" data-delete-doc="${doc.id}">删除</button>
        </div>
        ${doc.error_message ? `<p class="error-text">${escapeHtml(doc.error_message)}</p>` : ''}
      </div>
    </article>`;
  }).join('') : '<div class="empty-state">还没有文档。粘贴文本或上传文件即可入库。</div>';
  document.querySelectorAll('[data-detail-doc]').forEach((button) => { button.onclick = () => loadDocDetail(Number(button.dataset.detailDoc)); });
  document.querySelectorAll('[data-reindex-doc]').forEach((button) => { button.onclick = () => reindexDoc(Number(button.dataset.reindexDoc)); });
  document.querySelectorAll('[data-delete-doc]').forEach((button) => { button.onclick = () => deleteDoc(Number(button.dataset.deleteDoc)); });
}

function renderDocDetail(payload) {
  const doc = payload.document;
  $('#docDetailMeta').textContent = `#${doc.id} · v${doc.version || 1} · ${doc.chunk_count || 0} 片段`;
  $('#docDetail').classList.remove('empty-state');
  $('#docDetail').innerHTML = `
    <div class="detail-compact">
      <div class="log-line"><strong>${escapeHtml(doc.title)}</strong><span class="status-pill ${pillClass(doc.status)}">${escapeHtml(statusLabel(doc.status))}</span></div>
      <p class="log-extra">${escapeHtml(doc.filename || doc.source_type || '')} · ${doc.raw_text?.length || 0} 字符 · ${escapeHtml(qualityLabel(doc.quality_status))}</p>
      ${(doc.quality_issues || []).length ? `<p class="log-extra">${escapeHtml(doc.quality_issues.map((issue) => issue.message).join('；'))}</p>` : ''}
      ${doc.error_message ? `<p class="error-text">${escapeHtml(doc.error_message)}</p>` : ''}
      <div class="log-action-bar">
        <button type="button" data-reindex-doc="${doc.id}">重建向量</button>
        <button type="button" data-quality-doc="${doc.id}">检测质量</button>
        <button type="button" class="danger" data-delete-duplicates="${doc.id}" ${payload.duplicates.length ? '' : 'disabled'}>删重复 ${payload.duplicates.length}</button>
      </div>
    </div>
    <details class="log-actions openable"><summary>版本 ${payload.versions?.length || 0}</summary>
      ${(payload.versions || []).map((v) => `<div class="mini-row"><strong>#${v.id} v${v.version} ${escapeHtml(v.title)}</strong><span>${escapeHtml(v.version_status)} · ${formatTime(v.created_at)}</span></div>`).join('') || '<div class="empty-state">暂无版本</div>'}
    </details>
    <details class="log-actions openable"><summary>切片 ${payload.chunks.length}</summary>
      ${payload.chunks.length ? payload.chunks.map((chunk) => `<details class="chunk-card" id="chunk-${chunk.chunk_index}"><summary>#${chunk.chunk_index} · ${chunk.char_count} 字符</summary><pre>${escapeHtml(chunk.content)}</pre></details>`).join('') : '<div class="empty-state">暂无切片</div>'}
    </details>
    <details class="log-actions openable"><summary>重复 ${payload.duplicates.length}</summary>
      ${payload.duplicates.length ? payload.duplicates.map((dup) => `<div class="mini-row"><strong>#${dup.id} ${escapeHtml(dup.title)}</strong><span>${escapeHtml(statusLabel(dup.status))} · ${formatTime(dup.created_at)}</span></div>`).join('') : '<div class="empty-state">无重复</div>'}
    </details>
    <details class="log-actions openable"><summary>问答 ${payload.queries.length}</summary>
      ${payload.queries.length ? payload.queries.map((query) => `<details class="query-card"><summary>${escapeHtml(shortText(query.question, 40))} · ${formatTime(query.created_at)}</summary><p>${escapeHtml(query.answer)}</p></details>`).join('') : '<div class="empty-state">暂无问答</div>'}
    </details>`;
  $('#docDetail').querySelectorAll('[data-reindex-doc]').forEach((button) => { button.onclick = () => reindexDoc(Number(button.dataset.reindexDoc)); });
  $('#docDetail').querySelectorAll('[data-quality-doc]').forEach((button) => { button.onclick = () => qualityDoc(Number(button.dataset.qualityDoc)); });
  $('#docDetail').querySelectorAll('[data-delete-duplicates]').forEach((button) => { button.onclick = () => deleteDuplicates(Number(button.dataset.deleteDuplicates)); });
  const chunk = new URLSearchParams(location.search).get('chunk');
  if (chunk) document.getElementById(`chunk-${chunk}`)?.scrollIntoView({ block: 'center' });
}

function renderQuality() {
  const counts = Object.fromEntries((quality.summary || []).map((item) => [item.quality_status, item.count]));
  $('#qualitySummary').innerHTML = ['bad', 'warn', 'ok', 'unchecked'].map((status) => `
    <span class="log-stat ${pillClass(status)}"><em>${escapeHtml(qualityLabel(status))}</em><b>${counts[status] || 0}</b></span>`).join('');
  $('#qualityList').innerHTML = (quality.documents || []).length ? quality.documents.map((doc) => `
    <article class="log-row tone-${pillClass(doc.quality_status) || 'muted'}">
      <i class="log-dot" aria-hidden="true"></i>
      <div class="log-body">
        <div class="log-line"><strong>${escapeHtml(shortText(doc.title, 36))}</strong><time>${formatTime(doc.updated_at)}</time></div>
        <div class="log-meta">
          <span>${escapeHtml(shortText((doc.quality_issues || []).map((i) => i.message).join('；') || doc.status, 70))}</span>
          <button type="button" class="timeline-link" data-detail-doc="${doc.id}">详情</button>
          <button type="button" class="timeline-link" data-quality-doc="${doc.id}">检测</button>
        </div>
      </div>
    </article>`).join('') : '<div class="empty-state">没有质量问题</div>';
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

document.querySelectorAll('.ingest-tab').forEach((tab) => {
  tab.onclick = () => {
    const name = tab.dataset.tab;
    document.querySelectorAll('.ingest-tab').forEach((el) => el.classList.toggle('active', el === tab));
    document.querySelectorAll('.ingest-pane').forEach((pane) => pane.classList.toggle('active', pane.dataset.pane === name));
  };
});

const fileInput = $('#fileInput');
const fileName = $('#fileName');
const fileDrop = $('#fileDrop');

function setFileLabel(file) {
  if (!fileName) return;
  fileName.textContent = file?.name || '点击选择文件，或拖到这里';
  fileDrop?.classList.toggle('has-file', Boolean(file?.name));
}

fileInput?.addEventListener('change', () => setFileLabel(fileInput.files?.[0]));

['dragenter', 'dragover'].forEach((type) => {
  fileDrop?.addEventListener(type, (event) => {
    event.preventDefault();
    fileDrop.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach((type) => {
  fileDrop?.addEventListener(type, (event) => {
    event.preventDefault();
    fileDrop.classList.remove('dragover');
  });
});
fileDrop?.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (!file || !fileInput) return;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  fileInput.files = transfer.files;
  setFileLabel(file);
});

$('#uploadForm')?.addEventListener('reset', () => setTimeout(() => setFileLabel(null), 0));

loadPrimary().catch((error) => toast(error.message));
