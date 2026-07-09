const $ = (selector) => document.querySelector(selector);

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function formatTime(value) {
  if (!value) return '--';
  return new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}

function statePill(ok) {
  return `<span class="state-pill ${ok ? 'ok' : 'bad'}">${ok ? '正常' : '异常'}</span>`;
}

function card(title, ok, lines) {
  return `<article class="monitor-card">
    <div><strong>${escapeHtml(title)}</strong>${statePill(ok)}</div>
    ${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('')}
  </article>`;
}

function timelineRow(mark, title, time, detail) {
  return `<article class="timeline-item">
    <div class="timeline-mark">${escapeHtml(mark)}</div>
    <div class="timeline-main">
      <div class="timeline-title"><strong>${escapeHtml(title || '--')}</strong><time>${escapeHtml(formatTime(time))}</time></div>
      <p>${escapeHtml(detail || '')}</p>
    </div>
  </article>`;
}

function render(status) {
  $('#updatedAt').textContent = formatTime(status.checked_at);
  $('#healthGrid').innerHTML = [
    card('数据库', status.database?.ok, [`时间 ${formatTime(status.database?.now)}`, status.database?.error || '连接可用']),
    card('Chroma 向量库', status.chroma?.ok, [`地址 ${status.chroma?.url || '--'}`, status.chroma?.error || `HTTP ${status.chroma?.status || '--'}`]),
    card('Embedding', true, [`模式 ${status.embeddings?.use_hash ? 'Hash' : status.embeddings?.model || '--'}`, `维度 ${status.embeddings?.dimension || '--'}`]),
    card('企业微信', Object.values(status.wechat || {}).filter((value) => typeof value === 'boolean').every(Boolean), [`问题消息 ${status.wechat?.recent_problem_messages || 0}`, `上传失败 ${status.wechat?.upload_failures_24h || 0}`, `Corp ${status.wechat?.corp_id ? '已配' : '未配'} · Agent ${status.wechat?.agent_id ? '已配' : '未配'}`]),
    card('OCR', status.ocr?.configured, [`模型 ${status.ocr?.model || '--'}`, `Base URL ${status.ocr?.base_url ? '已配' : '未配'}`]),
    card('模型网关', true, [`24h 调用 ${status.gateway?.last_24h_calls || 0}`, `24h 失败 ${status.gateway?.last_24h_failed || 0}`, `超时 ${status.gateway?.timeout_ms}ms · 重试 ${status.gateway?.retry_count}`]),
    card('自动备份', status.backup?.enabled, [`保留 ${status.backup?.keep || 0} 份`, `最近备份 ${(status.backup?.files || []).length} 份`, status.backup?.last?.file || status.backup?.last?.error || '暂无运行记录']),
    card('失败重试', status.wechat?.failed_retry?.enabled, [`待重试 ${status.wechat?.retry_queue || 0} 条`, `间隔 ${Math.round((status.wechat?.failed_retry?.interval_ms || 0) / 1000)} 秒`, status.wechat?.failed_retry?.last?.checked_at ? `上次 ${formatTime(status.wechat.failed_retry.last.checked_at)}` : '暂无运行记录']),
  ].join('');
  $('#auditList').innerHTML = (status.recent_audits || []).length ? status.recent_audits.map((row) => timelineRow('审计', row.action, row.created_at, `${row.actor || 'system'} · ${row.entity_type || ''} ${row.entity_id || ''}`)).join('') : '<div class="empty-state">暂无审计记录</div>';
  $('#problemCount').textContent = `${(status.recent_problems || []).length} 条`;
  $('#problemList').innerHTML = (status.recent_problems || []).length ? status.recent_problems.map((row) => timelineRow('失败', `${row.intent || row.msg_type} / ${row.parse_status}`, row.received_at, row.media_error || row.reply_text || '')).join('') : '<div class="empty-state">最近没有失败消息。</div>';
  const uploads = status.knowledge?.recent_uploads || [];
  $('#uploadCount').textContent = `${uploads.length} 条`;
  $('#uploadList').innerHTML = uploads.length ? uploads.map((row) => timelineRow('上传', `${row.title || row.filename}`, row.created_at, `${row.source_type} · ${row.status}${row.error_message ? ` · ${row.error_message}` : ''}`)).join('') : '<div class="empty-state">暂无企微上传记录。</div>';
  const duplicates = status.knowledge?.duplicate_documents || [];
  $('#duplicateCount').textContent = `${duplicates.length} 组`;
  $('#duplicateList').innerHTML = duplicates.length ? duplicates.map((row) => timelineRow('重复', row.title || row.filename, row.latest, `${row.count} 份 · KB#${row.kb_id}`)).join('') : '<div class="empty-state">没有检测到重复文档。</div>';
}

async function loadStatus() {
  const status = await fetch('/api/system/status').then((res) => res.json());
  render(status);
}

$('#refreshBtn').addEventListener('click', loadStatus);
loadStatus();
