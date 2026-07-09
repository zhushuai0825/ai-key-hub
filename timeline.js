const $ = (selector) => document.querySelector(selector);
let rows = [];

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function formatTime(value) {
  if (!value) return '--';
  return new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}

function typeMeta(type) {
  return {
    finance: { label: '账本', tone: 'finance' },
    fitness: { label: '健康', tone: 'fitness' },
    knowledge: { label: '知识库', tone: 'knowledge' },
    wechat: { label: '企微', tone: 'wechat' },
    task: { label: '提醒', tone: 'task' },
    report: { label: '报告', tone: 'report' },
    audit: { label: '系统', tone: 'audit' },
  }[type] || { label: type || '动态', tone: 'other' };
}

function actorLabel(actor) {
  if (!actor || actor === 'system') return '系统自动';
  if (actor === 'admin' || actor === 'web') return '网页操作';
  return actor;
}

function fitnessTypeLabel(type) {
  return { weight: '体重', meal: '饮食', workout: '运动', sleep: '睡眠' }[type] || type || '健康';
}

function intentLabel(intent = '') {
  const map = {
    finance: '记账',
    fitness: '健康记录',
    knowledge: '知识库',
    knowledge_upload: '知识库上传',
    task: '提醒',
    chat: '聊天问答',
    memory: '长期记忆',
    report: '报告',
    undo: '撤销',
    unknown: '未识别',
  };
  return map[intent] || intent || '消息';
}

function parseStatusLabel(status = '') {
  return {
    success: '已处理',
    failed: '失败',
    pending: '处理中',
    skipped: '已跳过',
    needs_clarification: '待澄清',
  }[status] || status || '';
}

const AUDIT_ACTIONS = {
  'backup.auto_success': '自动备份成功',
  'backup.auto_failed': '自动备份失败',
  'backup.manual_success': '手动备份成功',
  'backup.create': '创建备份',
  'backup.import': '导入备份',
  'backup.import_success': '备份导入完成',
  'wechat.retry_checked': '检查企微失败消息',
  'wechat.retry_failed': '企微失败重试异常',
  'wechat.push_success': '企微消息推送成功',
  'wechat.push_failed': '企微消息推送失败',
  'wechat_message.reprocess': '重新处理企微消息',
  'wechat_message.correct': '纠错企微消息',
  'wechat_message.undo': '撤销企微写入',
  'wechat_message.unlink': '取消企微关联记录',
  'wechat_message.retry_failed': '批量重试失败消息',
  'finance.update': '修改账本记录',
  'finance.delete': '删除账本记录',
  'fitness.delete': '删除健康记录',
  'api_key.create': '新增 API Key',
  'api_key.update': '修改 API Key',
  'api_key.delete': '删除 API Key',
  'api_key.copy': '复制 API Key',
  'api_key.budget_update': '更新 Key 预算',
  'assistant_rule.create': '新增学习规则',
  'assistant_rule.update': '修改学习规则',
  'assistant_rule.delete': '删除学习规则',
  'wechat_profile.upsert': '保存企微用户绑定',
  'wechat_profile.update': '更新企微用户绑定',
  'wechat_profile.delete': '删除企微用户绑定',
  'notification.update': '更新通知订阅',
  'report_subscription.upsert': '保存报告订阅',
  'report_subscription.update': '更新报告订阅',
  'report_subscription.delete': '删除报告订阅',
};

function auditTitle(action = '') {
  if (AUDIT_ACTIONS[action]) return AUDIT_ACTIONS[action];
  if (action.startsWith('backup.')) return '备份相关操作';
  if (action.startsWith('wechat.')) return '企微系统任务';
  if (action.startsWith('api_key.')) return 'API Key 操作';
  if (action.startsWith('finance.')) return '账本操作';
  if (action.startsWith('fitness.')) return '健康操作';
  return action || '系统记录';
}

function formatBytes(size) {
  const n = Number(size || 0);
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function reasonLabel(reason = '') {
  return { startup: '启动时', auto: '定时任务', manual: '手动触发' }[reason] || reason || '';
}

function humanTitle(row) {
  const detail = row.detail || {};
  if (row.type === 'audit') return auditTitle(row.title);
  if (row.type === 'finance') {
    const dir = detail.direction === 'income' ? '收入' : '支出';
    return `${dir} ${row.title || '账本记录'}`;
  }
  if (row.type === 'fitness') return row.title || fitnessTypeLabel(detail.entry_type);
  if (row.type === 'knowledge') return `入库：${row.title || detail.filename || '文档'}`;
  if (row.type === 'wechat') {
    const text = String(row.title || '').trim();
    if (text && text !== detail.msg_type) return text.length > 48 ? `${text.slice(0, 48)}…` : text;
    return `企微${detail.msg_type || '消息'}`;
  }
  if (row.type === 'task') return `提醒：${row.title || '任务'}`;
  if (row.type === 'report') return row.title || '报告';
  return row.title || typeMeta(row.type).label;
}

function humanDetail(row) {
  const detail = row.detail || {};
  if (row.type === 'finance') {
    const parts = [
      detail.direction === 'income' ? '收入' : '支出',
      detail.amount !== undefined ? `¥${Number(detail.amount).toFixed(2)}` : '',
      detail.category || '未分类',
      detail.note || '',
      detail.source_user ? `来自 ${detail.source_user}` : '',
    ];
    return parts.filter(Boolean).join(' · ');
  }
  if (row.type === 'fitness') {
    const parts = [
      fitnessTypeLabel(detail.entry_type),
      detail.weight_kg ? `${detail.weight_kg} kg` : '',
      detail.calories ? `${detail.calories} kcal` : '',
      detail.duration_min ? `${detail.duration_min} 分钟` : '',
      detail.sleep_hours ? `${detail.sleep_hours} 小时` : '',
      detail.note || '',
      detail.source_user ? `来自 ${detail.source_user}` : '',
    ];
    return parts.filter(Boolean).join(' · ');
  }
  if (row.type === 'knowledge') {
    const parts = [
      detail.source_channel === 'wechat' ? '企微上传' : '网页入库',
      detail.filename || '',
      detail.status ? `状态 ${detail.status}` : '',
      detail.source_user ? `上传人 ${detail.source_user}` : '',
    ];
    return parts.filter(Boolean).join(' · ');
  }
  if (row.type === 'wechat') {
    const parts = [
      detail.from_user ? `用户 ${detail.from_user}` : '',
      detail.msg_type ? `类型 ${detail.msg_type}` : '',
      intentLabel(detail.intent),
      parseStatusLabel(detail.parse_status),
      detail.media_status && detail.media_status !== 'none' ? `媒体 ${detail.media_status}` : '',
    ];
    return parts.filter(Boolean).join(' · ');
  }
  if (row.type === 'task') {
    const parts = [
      detail.status === 'done' ? '已完成' : detail.status === 'paused' ? '已暂停' : '待提醒',
      detail.recurrence && detail.recurrence !== 'none' ? `重复 ${detail.recurrence}` : '单次',
      detail.note || '',
      detail.from_user ? `绑定 ${detail.from_user}` : '',
    ];
    return parts.filter(Boolean).join(' · ');
  }
  if (row.type === 'report') {
    const parts = [
      detail.report_type === 'weekly' ? '周报' : detail.report_type === 'monthly' ? '月报' : '日报',
      detail.from_user ? `发给 ${detail.from_user}` : '',
    ];
    return parts.filter(Boolean).join(' · ');
  }
  if (row.type === 'audit') {
    const nested = detail.detail || {};
    const parts = [actorLabel(detail.actor)];
    if (row.title?.startsWith('backup.')) {
      if (detail.entity_id) parts.push(`文件 ${detail.entity_id}`);
      if (nested.size) parts.push(formatBytes(nested.size));
      if (nested.reason) parts.push(reasonLabel(nested.reason));
      if (nested.error) parts.push(`错误：${nested.error}`);
    } else if (String(row.title || '').includes('wechat.retry')) {
      parts.push(reasonLabel(nested.reason) || '定时检查');
      if (nested.processed !== undefined) parts.push(`处理 ${nested.processed} 条`);
      if (nested.failed !== undefined) parts.push(`失败 ${nested.failed} 条`);
      if (nested.error) parts.push(`错误：${nested.error}`);
    } else if (String(row.title || '').includes('wechat.push')) {
      if (nested.to_user || detail.entity_id) parts.push(`接收人 ${nested.to_user || detail.entity_id}`);
      if (nested.errmsg) parts.push(nested.errmsg);
    } else if (detail.entity_type === 'wechat_message' || String(row.title || '').startsWith('wechat_message.')) {
      if (detail.entity_id) parts.push(`消息 #${detail.entity_id}`);
      if (nested.intent) parts.push(intentLabel(nested.intent));
      if (nested.parse_status) parts.push(parseStatusLabel(nested.parse_status));
      if (nested.action) parts.push(`动作 ${nested.action}`);
      if (nested.value) parts.push(String(nested.value));
    } else if (String(row.title || '').startsWith('api_key.')) {
      if (nested.name) parts.push(nested.name);
      if (nested.mode) parts.push(`复制方式 ${nested.mode}`);
      if (nested.status) parts.push(`状态 ${nested.status}`);
    } else if (String(row.title || '').startsWith('finance.') || String(row.title || '').startsWith('fitness.')) {
      if (detail.entity_id) parts.push(`记录 #${detail.entity_id}`);
      if (nested.deleted !== undefined) parts.push(nested.deleted ? '已删除' : '未找到');
      if (nested.category) parts.push(nested.category);
      if (nested.amount !== undefined) parts.push(`¥${nested.amount}`);
    } else {
      if (detail.entity_type && detail.entity_id) parts.push(`${detail.entity_type} #${detail.entity_id}`);
      else if (detail.entity_id) parts.push(`#${detail.entity_id}`);
      const extras = Object.entries(nested)
        .filter(([key]) => !['level', 'reason', 'size', 'removed', 'processed', 'failed'].includes(key))
        .slice(0, 3)
        .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
      parts.push(...extras);
    }
    return parts.filter(Boolean).join(' · ');
  }
  return '';
}

function rowHref(row) {
  if (row.type === 'wechat') return `/wechat-inbox.html?q=${encodeURIComponent(`#${row.entity_id}`)}`;
  if (row.type === 'knowledge') return `/knowledge.html?doc=${encodeURIComponent(row.entity_id)}`;
  if (row.type === 'finance') return '/finance.html';
  if (row.type === 'fitness') return '/fitness.html';
  if (row.type === 'task') return '/tasks.html';
  if (row.type === 'report') return '/assistant-cache.html';
  if (row.type === 'audit') {
    const action = String(row.title || '');
    const entityType = row.detail?.entity_type || '';
    if (action.startsWith('backup.') || entityType === 'backup') return '/backup.html';
    if (action.includes('wechat.retry') || entityType === 'wechat_retry') return '/wechat-inbox.html?status=failed';
    if (action.includes('wechat.push') || entityType === 'wechat_push') return '/wechat-diagnostics.html';
    if (entityType === 'wechat_message') return `/wechat-inbox.html?q=${encodeURIComponent(`#${row.detail?.entity_id || ''}`)}`;
    if (entityType === 'api_key') return '/keys.html';
    return '';
  }
  return '';
}

function render() {
  const type = $('#filterForm').type.value;
  $('#timelineCount').textContent = `${rows.length} 条`;
  $('#updatedAt').textContent = formatTime(new Date());
  $('#listTitle').textContent = type === 'audit' ? '管理操作摘要' : type ? `${typeMeta(type).label}动态` : '全部动态';
  $('#timelineHint').textContent = type === 'audit'
    ? '这里是时间线里的操作摘要。完整系统日志看「系统日志」，完整管理操作看「审计日志」；企微原文看「企微消息」。'
    : '账本、健康、知识库、提醒、报告、企微消息与管理操作摘要，按时间倒序。';

  $('#timelineList').innerHTML = rows.length ? rows.map((row) => {
    const meta = typeMeta(row.type);
    const href = rowHref(row);
    const title = humanTitle(row);
    const detail = humanDetail(row);
    const link = href ? `<a class="timeline-link" href="${escapeHtml(href)}">查看</a>` : '';
    return `
    <article class="timeline-item type-${escapeHtml(meta.tone)}">
      <div class="timeline-mark tone-${escapeHtml(meta.tone)}" aria-hidden="true"></div>
      <div class="timeline-main">
        <div class="timeline-title">
          <div class="timeline-heading">
            <span class="timeline-type">${escapeHtml(meta.label)}</span>
            <strong>${escapeHtml(title)}</strong>
          </div>
          <time>${escapeHtml(formatTime(row.event_at))}</time>
        </div>
        ${detail ? `<p>${escapeHtml(detail)}</p>` : ''}
        <div class="timeline-foot">
          <code>${escapeHtml(row.type)} · ${escapeHtml(row.entity_id)}${row.type === 'audit' && row.title ? ` · ${escapeHtml(row.title)}` : ''}</code>
          ${link}
        </div>
      </div>
    </article>`;
  }).join('') : '<div class="empty-state">暂无动态。记账、发企微、上传知识库后会出现在这里。</div>';
}

async function loadTimeline() {
  const data = new FormData($('#filterForm'));
  const params = new URLSearchParams();
  for (const [key, value] of data.entries()) if (value) params.set(key, value);
  const res = await fetch(`/api/timeline?${params}`);
  if (!res.ok) throw new Error(await res.text() || '加载失败');
  rows = await res.json();
  render();
}

$('#filterForm').addEventListener('submit', (event) => {
  event.preventDefault();
  loadTimeline().catch((error) => { $('#timelineList').innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`; });
});
$('#refreshBtn').addEventListener('click', () => loadTimeline().catch(console.error));
const initial = new URLSearchParams(location.search).get('type');
if (initial) $('#filterForm').type.value = initial;
loadTimeline().catch((error) => { $('#timelineList').innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`; });
