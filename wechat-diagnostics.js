const $ = (s) => document.querySelector(s);

function e(v = '') {
  return String(v).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function t(v) {
  return v ? new Date(v).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '--';
}

function shortText(value = '', max = 72) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function metricLabel(key) {
  return {
    total_messages: '消息总数',
    failed_messages: '失败消息',
    pending_media: '待处理媒体',
    pending_upload_targets: '待确认上传',
    recent_uploads: '最近上传',
    upload_failures_24h: '24h 上传失败',
    retry_queue: '重试队列',
  }[key] || key;
}

function toneForStatus(text = '') {
  const value = String(text).toLowerCase();
  if (value.includes('fail') || value.includes('error') || value.includes('失败')) return 'bad';
  if (value.includes('pending') || value.includes('wait') || value.includes('待')) return 'warn';
  if (value.includes('ok') || value.includes('ready') || value.includes('replied') || value.includes('成功')) return 'ok';
  return 'muted';
}

function logRow(tone, title, time, detail) {
  return `<article class="log-row tone-${tone || 'muted'}">
    <i class="log-dot" aria-hidden="true"></i>
    <div class="log-body">
      <div class="log-line"><strong title="${e(title || '--')}">${e(shortText(title || '--', 42))}</strong><time>${e(t(time))}</time></div>
      <div class="log-meta"><span title="${e(detail || '')}">${e(shortText(detail || '', 90))}</span></div>
    </div>
  </article>`;
}

function prettyDetail(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const data = JSON.parse(text);
      if (data && typeof data === 'object') {
        const parts = [
          data.kb_name && `知识库 ${data.kb_name}`,
          data.kb_id && `KB#${data.kb_id}`,
          data.requested && `请求 ${data.requested}`,
          data.expires_at && `过期 ${t(data.expires_at)}`,
          data.status && `状态 ${data.status}`,
        ].filter(Boolean);
        if (parts.length) return parts.join(' · ');
      }
    } catch (_) { /* keep raw */ }
  }
  return text;
}

async function load() {
  const d = await fetch('/api/wechat/diagnostics').then((r) => r.json());
  $('#updatedAt').textContent = t(new Date());

  const summary = d.summary || {};
  const preferred = [
    'total_messages',
    'failed_messages',
    'pending_media',
    'pending_upload_targets',
    'recent_uploads',
    'upload_failures_24h',
    'retry_queue',
  ];
  const keys = [
    ...preferred.filter((key) => key in summary),
    ...Object.keys(summary).filter((key) => !preferred.includes(key)),
  ];
  $('#summaryGrid').innerHTML = keys.length
    ? keys.map((key) => {
      const value = summary[key];
      const tone = Number(value) > 0 && /fail|pending|retry/i.test(key) ? 'warn' : 'ok';
      return `<span class="log-stat ${tone}" title="${e(key)}"><em>${e(metricLabel(key))}</em><b>${e(value)}</b></span>`;
    }).join('')
    : '<div class="empty-state">暂无诊断数据</div>';

  $('#messageList').innerHTML = (d.messages || []).length
    ? d.messages.map((m) => logRow(
      toneForStatus(m.parse_status || m.media_error),
      `${m.msg_type || 'msg'} · ${m.intent || '--'}/${m.parse_status || '--'}`,
      m.received_at,
      prettyDetail(m.media_error || m.reply_text || m.content),
    )).join('')
    : '<div class="empty-state">暂无消息</div>';

  const uploads = [
    ...(d.uploads || []).map((u) => ({
      tone: toneForStatus(u.status || u.error_message),
      title: u.title || u.filename || '上传',
      time: u.created_at,
      detail: [u.status, u.error_message].filter(Boolean).join(' · '),
    })),
    ...(d.pending_targets || []).map((p) => ({
      tone: 'warn',
      title: p.from_user || '上传目标',
      time: p.created_at,
      detail: prettyDetail(p.content),
    })),
    ...(d.pending_media || []).map((p) => ({
      tone: 'warn',
      title: p.msg_type || '媒体',
      time: p.created_at,
      detail: prettyDetail(p.content_hint || p.status || p.content),
    })),
  ];
  $('#uploadCount').textContent = `${uploads.length} 条`;
  $('#uploadList').innerHTML = uploads.length
    ? uploads.map((u) => logRow(u.tone, u.title, u.time, u.detail)).join('')
    : '<div class="empty-state">暂无上传诊断</div>';
}

$('#refreshBtn').onclick = load;
load();
