const $ = (selector) => document.querySelector(selector);

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
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

function healthStat(title, ok, detail) {
  return `<span class="log-stat ${ok ? 'ok' : 'bad'}" title="${escapeHtml(detail)}"><em>${escapeHtml(title)}</em><b>${ok ? '正常' : '异常'}</b></span>`;
}

function logRow(tone, title, time, detail) {
  return `<article class="log-row tone-${tone || 'muted'}">
    <i class="log-dot" aria-hidden="true"></i>
    <div class="log-body">
      <div class="log-line"><strong>${escapeHtml(shortText(title || '--', 48))}</strong><time>${escapeHtml(formatTime(time))}</time></div>
      <div class="log-meta"><span title="${escapeHtml(detail || '')}">${escapeHtml(shortText(detail || '', 90))}</span></div>
    </div>
  </article>`;
}

function render(status) {
  $('#updatedAt').textContent = formatTime(status.checked_at);
  const wechatOk = Object.values(status.wechat || {}).filter((value) => typeof value === 'boolean').every(Boolean);
  $('#healthGrid').innerHTML = [
    healthStat('数据库', status.database?.ok, status.database?.error || `时间 ${formatTime(status.database?.now)}`),
    healthStat('Chroma', status.chroma?.ok, status.chroma?.error || status.chroma?.url || ''),
    healthStat('Embedding', true, `${status.embeddings?.use_hash ? 'Hash' : status.embeddings?.model || '--'} · ${status.embeddings?.dimension || '--'}d`),
    healthStat('企微', wechatOk, `问题 ${status.wechat?.recent_problem_messages || 0} · 上传失败 ${status.wechat?.upload_failures_24h || 0}`),
    healthStat('OCR', status.ocr?.configured, status.ocr?.model || '--'),
    healthStat('网关', true, `24h ${status.gateway?.last_24h_calls || 0} 次 · 失败 ${status.gateway?.last_24h_failed || 0}`),
    healthStat('备份', status.backup?.enabled, status.backup?.last?.file || status.backup?.last?.error || '暂无记录'),
    healthStat('重试', status.wechat?.failed_retry?.enabled, `队列 ${status.wechat?.retry_queue || 0}`),
  ].join('');

  $('#auditList').innerHTML = (status.recent_audits || []).length
    ? status.recent_audits.map((row) => logRow('muted', row.action, row.created_at, `${row.actor || 'system'} · ${row.entity_type || ''} ${row.entity_id || ''}`)).join('')
    : '<div class="empty-state">暂无审计记录</div>';

  $('#problemCount').textContent = `${(status.recent_problems || []).length} 条`;
  $('#problemList').innerHTML = (status.recent_problems || []).length
    ? status.recent_problems.map((row) => logRow('bad', `${row.intent || row.msg_type} / ${row.parse_status}`, row.received_at, row.media_error || row.reply_text || '')).join('')
    : '<div class="empty-state">最近没有失败消息</div>';

  const uploads = status.knowledge?.recent_uploads || [];
  $('#uploadCount').textContent = `${uploads.length} 条`;
  $('#uploadList').innerHTML = uploads.length
    ? uploads.map((row) => logRow(row.error_message ? 'bad' : 'ok', row.title || row.filename, row.created_at, `${row.source_type} · ${row.status}${row.error_message ? ` · ${row.error_message}` : ''}`)).join('')
    : '<div class="empty-state">暂无企微上传记录</div>';

  const duplicates = status.knowledge?.duplicate_documents || [];
  $('#duplicateCount').textContent = `${duplicates.length} 组`;
  $('#duplicateList').innerHTML = duplicates.length
    ? duplicates.map((row) => logRow('warn', row.title || row.filename, row.latest, `${row.count} 份 · KB#${row.kb_id}`)).join('')
    : '<div class="empty-state">没有检测到重复文档</div>';
}

async function loadStatus() {
  const status = await fetch('/api/system/status').then((res) => res.json());
  render(status);
}

$('#refreshBtn').addEventListener('click', loadStatus);
loadStatus();
