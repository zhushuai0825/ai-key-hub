const $ = (selector) => document.querySelector(selector);
let rows = [];

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function formatTime(value) {
  if (!value) return '--';
  return new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}

function typeLabel(type) {
  return { finance: '账本', fitness: '健康', knowledge: '知识库', wechat: '企微', task: '提醒', report: '报告', audit: '审计' }[type] || type;
}

function detailText(detail = {}) {
  if (detail.amount !== undefined) return `${detail.direction === 'income' ? '收入' : '支出'} ¥${detail.amount} · ${detail.category || '未分类'}`;
  if (detail.entry_type) return [detail.entry_type, detail.weight_kg && `${detail.weight_kg}kg`, detail.calories && `${detail.calories}kcal`, detail.duration_min && `${detail.duration_min}分钟`, detail.sleep_hours && `${detail.sleep_hours}小时`].filter(Boolean).join(' · ');
  if (detail.status) return `状态 ${detail.status}`;
  if (detail.parse_status) return `${detail.intent || 'unknown'} · ${detail.parse_status}`;
  if (detail.actor) return `${detail.actor} · ${detail.entity_type || ''} ${detail.entity_id || ''}`;
  return Object.entries(detail).slice(0, 4).map(([key, value]) => `${key}: ${value}`).join(' · ');
}

function render() {
  $('#timelineCount').textContent = `${rows.length} 条`;
  $('#updatedAt').textContent = formatTime(new Date());
  $('#timelineList').innerHTML = rows.length ? rows.map((row) => `
    <article class="timeline-item type-${escapeHtml(row.type)}">
      <div class="timeline-mark">${escapeHtml(typeLabel(row.type))}</div>
      <div class="timeline-main">
        <div class="timeline-title"><strong>${escapeHtml(row.title || typeLabel(row.type))}</strong><time>${escapeHtml(formatTime(row.event_at))}</time></div>
        <p>${escapeHtml(detailText(row.detail || {}))}</p>
        <code>${escapeHtml(row.type)}#${escapeHtml(row.entity_id)}</code>
      </div>
    </article>`).join('') : '<div class="empty-state">暂无动态</div>';
}

async function loadTimeline() {
  const data = new FormData($('#filterForm'));
  const params = new URLSearchParams();
  for (const [key, value] of data.entries()) if (value) params.set(key, value);
  rows = await fetch(`/api/timeline?${params}`).then((res) => res.json());
  render();
}

$('#filterForm').addEventListener('submit', (event) => { event.preventDefault(); loadTimeline(); });
$('#refreshBtn').addEventListener('click', loadTimeline);
const initial = new URLSearchParams(location.search).get('type');
if (initial) $('#filterForm').type.value = initial;
loadTimeline();
