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

const ACTION_LABELS = {
  'api_key.create': '新增 API Key',
  'api_key.update': '修改 API Key',
  'api_key.delete': '删除 API Key',
  'api_key.copy': '复制 API Key',
  'api_key.budget_update': '更新 Key 预算',
  'finance.update': '修改账本记录',
  'finance.delete': '删除账本记录',
  'fitness.delete': '删除健康记录',
  'wechat_message.reprocess': '重新处理企微消息',
  'wechat_message.correct': '纠错企微消息',
  'wechat_message.undo': '撤销企微写入',
  'wechat_message.unlink': '取消企微关联',
  'wechat_message.retry_failed': '批量重试失败消息',
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
  'backup.create': '手动创建备份',
  'backup.import': '导入备份',
};

function isSystemNoise(action = '') {
  return /^(backup\.auto_|backup\.manual_success|backup\.import_success|wechat\.retry_|wechat\.push_)/.test(action);
}

function actionLabel(action = '') {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action];
  if (action.startsWith('api_key.')) return 'API Key 操作';
  if (action.startsWith('finance.')) return '账本操作';
  if (action.startsWith('wechat_message.')) return '企微消息管理';
  if (action.startsWith('backup.')) return '备份操作';
  return action || '未知操作';
}

function actorLabel(actor = '') {
  if (!actor || actor === 'system') return '系统';
  if (actor === 'admin' || actor === 'web') return '网页管理员';
  return actor;
}

function detailText(row) {
  const detail = row.detail || {};
  const parts = [];
  if (detail.name) parts.push(detail.name);
  if (detail.mode) parts.push(`方式 ${detail.mode}`);
  if (detail.status) parts.push(`状态 ${detail.status}`);
  if (detail.category) parts.push(detail.category);
  if (detail.amount !== undefined) parts.push(`¥${detail.amount}`);
  if (detail.intent) parts.push(detail.intent);
  if (detail.parse_status) parts.push(detail.parse_status);
  if (detail.action) parts.push(detail.action);
  if (detail.value) parts.push(String(detail.value));
  if (detail.display_name) parts.push(detail.display_name);
  if (detail.deleted !== undefined) parts.push(detail.deleted ? '已删除' : '未找到');
  if (detail.reason) parts.push(detail.reason);
  if (detail.file || detail.entity_id) parts.push(detail.file || detail.entity_id);
  if (!parts.length) {
    const extras = Object.entries(detail)
      .filter(([key]) => !['level'].includes(key))
      .slice(0, 4)
      .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
    parts.push(...extras);
  }
  return parts.filter(Boolean).join(' · ');
}

function rowHref(row) {
  const action = String(row.action || '');
  const entityType = String(row.entity_type || '');
  if (action.startsWith('api_key.') || entityType === 'api_key') return '/keys.html';
  if (action.startsWith('finance.') || entityType === 'finance_entry') return '/finance.html';
  if (action.startsWith('fitness.') || entityType === 'fitness_entry') return '/fitness.html';
  if (action.startsWith('wechat_message.') || entityType === 'wechat_message') {
    return row.entity_id ? `/wechat-inbox.html?q=${encodeURIComponent(`#${row.entity_id}`)}` : '/wechat-inbox.html';
  }
  if (action.startsWith('backup.') || entityType === 'backup') return '/backup.html';
  if (action.startsWith('wechat_profile.')) return '/wechat-inbox.html';
  if (action.startsWith('notification.') || action.startsWith('report_subscription.')) return '/notifications.html';
  return '';
}

function render(rows) {
  $('#auditCount').textContent = `${rows.length} 条`;
  $('#auditList').innerHTML = rows.length ? rows.map((row) => {
    const href = rowHref(row);
    const detail = detailText(row);
    return `<article class="timeline-item">
      <div class="timeline-mark ok">操作</div>
      <div class="timeline-main">
        <div class="timeline-title">
          <strong>${escapeHtml(actionLabel(row.action))}</strong>
          <time>${escapeHtml(formatTime(row.created_at))}</time>
        </div>
        <p>${escapeHtml(actorLabel(row.actor))}${detail ? ` · ${escapeHtml(detail)}` : ''}${row.entity_id ? ` · #${escapeHtml(row.entity_id)}` : ''}</p>
        <div class="timeline-foot">
          <code>${escapeHtml(row.action || '')}</code>
          ${href ? `<a class="timeline-link" href="${escapeHtml(href)}">查看</a>` : ''}
        </div>
      </div>
    </article>`;
  }).join('') : '<div class="empty-state">暂无管理操作记录。在网页里改 Key、纠错、删除后会出现在这里。</div>';
}

async function loadAudit() {
  const form = new FormData($('#filterForm'));
  const q = String(form.get('q') || '').trim().toLowerCase();
  const limit = Math.min(300, Math.max(20, Number(form.get('limit') || 120)));
  const rows = await api('/api/audit-logs');
  const filtered = rows
    .filter((row) => !isSystemNoise(row.action))
    .filter((row) => {
      if (!q) return true;
      const hay = `${row.action || ''} ${row.actor || ''} ${row.entity_type || ''} ${row.entity_id || ''} ${JSON.stringify(row.detail || {})}`.toLowerCase();
      return hay.includes(q);
    })
    .slice(0, limit);
  render(filtered);
}

$('#filterForm').onsubmit = (event) => {
  event.preventDefault();
  loadAudit().catch((error) => toast(error.message));
};
$('#refreshBtn').onclick = () => loadAudit().catch((error) => toast(error.message));
loadAudit().catch((error) => {
  $('#auditList').innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
});
