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

function render(status) {
  $('#updatedAt').textContent = formatTime(status.checked_at);
  $('#healthGrid').innerHTML = [
    card('数据库', status.database?.ok, [`时间 ${formatTime(status.database?.now)}`, status.database?.error || '连接可用']),
    card('Chroma 向量库', status.chroma?.ok, [`地址 ${status.chroma?.url || '--'}`, status.chroma?.error || `HTTP ${status.chroma?.status || '--'}`]),
    card('Embedding', true, [`模式 ${status.embeddings?.use_hash ? 'Hash' : status.embeddings?.model || '--'}`, `维度 ${status.embeddings?.dimension || '--'}`]),
    card('企业微信', Object.values(status.wechat || {}).filter((value) => typeof value === 'boolean').every(Boolean), [`问题消息 ${status.wechat?.recent_problem_messages || 0}`, `Corp ${status.wechat?.corp_id ? '已配' : '未配'} · Agent ${status.wechat?.agent_id ? '已配' : '未配'}`]),
    card('OCR', status.ocr?.configured, [`模型 ${status.ocr?.model || '--'}`, `Base URL ${status.ocr?.base_url ? '已配' : '未配'}`]),
    card('模型网关', true, [`24h 调用 ${status.gateway?.last_24h_calls || 0}`, `24h 失败 ${status.gateway?.last_24h_failed || 0}`, `超时 ${status.gateway?.timeout_ms}ms · 重试 ${status.gateway?.retry_count}`]),
  ].join('');
  $('#auditList').innerHTML = (status.recent_audits || []).length ? status.recent_audits.map((row) => `
    <article class="timeline-item">
      <div class="timeline-mark">审计</div>
      <div class="timeline-main">
        <div class="timeline-title"><strong>${escapeHtml(row.action)}</strong><time>${escapeHtml(formatTime(row.created_at))}</time></div>
        <p>${escapeHtml(row.actor || 'system')} · ${escapeHtml(row.entity_type || '')} ${escapeHtml(row.entity_id || '')}</p>
      </div>
    </article>`).join('') : '<div class="empty-state">暂无审计记录</div>';
}

async function loadStatus() {
  const status = await fetch('/api/system/status').then((res) => res.json());
  render(status);
}

$('#refreshBtn').addEventListener('click', loadStatus);
loadStatus();
