const $ = (selector) => document.querySelector(selector);

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function toast(message) {
  const box = $('#toast');
  if (!box) return;
  box.textContent = message;
  box.classList.add('show');
  setTimeout(() => box.classList.remove('show'), 2200);
}

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(await res.text() || '请求失败');
  return res.json();
}

function formatTime(value) {
  if (!value) return '--';
  return new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}

function statusLabel(status) {
  return { recorded: '已记录', replied: '已回复', failed: '失败', processing: '处理中', ignored: '已忽略' }[status] || status || '未知';
}

function statusClass(status) {
  if (status === 'recorded' || status === 'replied') return 'ok';
  if (status === 'failed') return 'bad';
  if (status === 'processing') return 'warn';
  return '';
}

function intentLabel(intent = '') {
  if (!intent) return '未知';
  if (intent.startsWith('finance')) return '记账';
  if (intent.startsWith('fitness')) return '健康';
  if (intent.startsWith('knowledge')) return '知识库';
  if (intent.startsWith('task')) return '提醒';
  if (intent.startsWith('memory')) return '记忆';
  if (intent.startsWith('chat')) return '聊天';
  if (intent.startsWith('report')) return '报告';
  if (intent.startsWith('control')) return '修正';
  return intent;
}

function msgTypeLabel(type = '') {
  return { text: '文本', image: '图片', voice: '语音', file: '文件', video: '视频' }[type] || type || '消息';
}

function relationText(row) {
  const parts = [];
  if (row.finance_entry_id) {
    parts.push(`${row.finance_direction === 'income' ? '收入' : '支出'} ¥${Number(row.finance_amount || 0).toFixed(2)} · ${row.finance_category || '未分类'}`);
  }
  if (row.fitness_entry_id) {
    if (row.fitness_type === 'weight') parts.push(`体重 ${row.weight_kg}kg`);
    else if (row.fitness_type === 'sleep') parts.push(`睡眠 ${row.sleep_hours}小时`);
    else if (row.fitness_type === 'meal') parts.push(`${row.meal_type || '饮食'} ${row.food_text || ''}`);
    else parts.push(`${row.workout_type || '运动'} ${row.duration_min || 0}分钟`);
  }
  if (row.knowledge_document_id) {
    parts.push(`入库 ${row.knowledge_title || row.knowledge_filename || '文档'}`);
  }
  if (row.task_id) {
    parts.push(`提醒 ${row.task_title || ''}`);
  }
  return parts.filter(Boolean).join(' · ');
}

function renderSummary(summary = {}) {
  const items = [
    ['24h', summary.last_24h || 0, ''],
    ['已回复', summary.replied || 0, 'ok'],
    ['已记录', summary.recorded || 0, 'ok'],
    ['失败', summary.failed || 0, summary.failed ? 'bad' : ''],
  ];
  $('#summaryGrid').innerHTML = items.map(([label, count, tone]) => `
    <span class="log-stat ${tone}"><em>${escapeHtml(label)}</em><b>${count}</b></span>`).join('');
}

function shortText(value = '', max = 72) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function renderRows(rows = []) {
  $('#chatCount').textContent = `${rows.length} 条`;
  $('#chatList').innerHTML = rows.length ? rows.map((row) => {
    const content = String(row.content || '').trim() || `（${msgTypeLabel(row.msg_type)}消息）`;
    const reply = String(row.reply_text || '').trim();
    const relation = relationText(row);
    const meta = [
      statusLabel(row.parse_status),
      intentLabel(row.intent),
      row.from_user || '',
      msgTypeLabel(row.source_msg_type || row.msg_type),
      relation,
    ].filter(Boolean).join(' · ');
    return `<article class="log-row tone-${statusClass(row.parse_status) || 'muted'}">
      <i class="log-dot" aria-hidden="true"></i>
      <div class="log-body">
        <div class="log-line">
          <strong title="${escapeHtml(content)}">${escapeHtml(shortText(content, 64))}</strong>
          <time>${escapeHtml(formatTime(row.received_at))}</time>
        </div>
        <div class="log-meta">
          <span>${escapeHtml(meta)}</span>
          ${reply ? `<span class="log-reply" title="${escapeHtml(reply)}">回复：${escapeHtml(shortText(reply, 56))}</span>` : ''}
          <a class="timeline-link" href="/wechat-inbox.html?q=${encodeURIComponent(`#${row.id}`)}">处理</a>
        </div>
      </div>
    </article>`;
  }).join('') : '<div class="empty-state">暂无对话记录。在企业微信给助手发「你好」后会出现在这里。</div>';
}

async function loadChatLog() {
  const form = new FormData($('#filterForm'));
  const params = new URLSearchParams();
  for (const [key, value] of form.entries()) {
    if (String(value || '').trim()) params.set(key, value);
  }
  const data = await api(`/api/wechat/inbox?${params}`);
  renderSummary(data.summary || {});
  renderRows(data.rows || []);
}

$('#filterForm').onsubmit = (event) => {
  event.preventDefault();
  loadChatLog().catch((error) => toast(error.message));
};
$('#refreshBtn').onclick = () => loadChatLog().catch((error) => toast(error.message));

const initialQ = new URLSearchParams(location.search).get('q');
if (initialQ) $('#filterForm').q.value = initialQ;
loadChatLog().catch((error) => {
  $('#chatList').innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
});
