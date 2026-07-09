const $ = (selector) => document.querySelector(selector);
let inbox = { summary: {}, intents: [], rows: [] };
let rules = [];
let profiles = [];

function escapeHtml(value = '') {
  return String(value).replace(/[&<> '\"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', ' ': ' ', "'": '&#39;', '"': '&quot;' }[char]));
}

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(await res.text() || '请求失败');
  return res.json();
}

async function apiWrite(path, options = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
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
  if (!value) return '--';
  return new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}

function statusLabel(status) {
  return { recorded: '已记录', replied: '已回复', failed: '失败', processing: '处理中', ignored: '已忽略' }[status] || status || '未知';
}

function documentStatusLabel(status) {
  return { ready: '向量已入库', ready_pg_only: '本地检索', processing: '处理中', pending: '待处理' }[status] || status || '未知';
}

function intentLabel(intent) {
  if (!intent) return '未知';
  if (intent.startsWith('finance')) return '账本';
  if (intent.startsWith('fitness')) return '健康';
  if (intent.startsWith('knowledge')) return '知识库';
  if (intent.startsWith('task')) return '提醒';
  if (intent.startsWith('memory')) return '记忆';
  if (intent.startsWith('chat')) return '聊天';
  if (intent.startsWith('report')) return '报告';
  if (intent.startsWith('control')) return '修正';
  return intent;
}

function correctionLabel(status) {
  return { none: '', corrected: '已纠错', undone: '已撤销' }[status] || status || '';
}

function relationText(row) {
  const parts = [];
  if (row.finance_entry_id) {
    const amount = Number(row.finance_amount || 0).toFixed(2);
    parts.push(`账本：${row.finance_direction === 'income' ? '收入' : '支出'} ¥${amount} · ${row.finance_category || '未分类'} · ${row.finance_title || ''}`);
  }
  if (row.fitness_entry_id) {
    if (row.fitness_type === 'weight') parts.push(`健康：体重 ${row.weight_kg}kg`);
    else if (row.fitness_type === 'sleep') parts.push(`健康：睡眠 ${row.sleep_hours}小时`);
    else if (row.fitness_type === 'meal') parts.push(`健康：${row.meal_type || '饮食'} ${row.food_text || ''}`);
    else parts.push(`健康：${row.workout_type || '运动'} ${row.duration_min || 0}分钟`);
  }
  if (row.knowledge_document_id) {
    parts.push(`知识库：${row.knowledge_base_name || '未知知识库'} · ${row.knowledge_title || row.knowledge_filename || '文档'} · ${documentStatusLabel(row.knowledge_status)}`);
  }
  if (row.task_id) {
    parts.push(`提醒：${row.task_title || '未命名'} · ${row.task_remind_at ? formatTime(row.task_remind_at) : '未设时间'} · ${statusLabel(row.task_status)}`);
  }
  return parts;
}

function statusClass(status) {
  if (status === 'recorded' || status === 'replied') return 'ok';
  if (status === 'failed') return 'bad';
  if (status === 'processing') return 'warn';
  return '';
}

function mediaLabel(row) {
  if (!row.source_msg_type || row.source_msg_type === row.msg_type) return '';
  const status = row.media_status ? ` · ${row.media_status}` : '';
  return `${row.source_msg_type} → ${row.msg_type}${status}`;
}

function renderAssistantContext(row) {
  const context = row.raw_payload?.assistant_context;
  if (!context) return '';
  const actions = (context.ai_actions || []).map((item) => `<span>${escapeHtml(item)}</span>`).join('');
  const sources = (context.knowledge_sources || []).map((item) => `<li>资料${escapeHtml(item.index)}：${escapeHtml(item.title || item.preview || '知识片段')}</li>`).join('');
  return `
    <details class="payload-details assistant-context-details">
      <summary>AI 判断依据</summary>
      ${actions ? `<div class="inbox-relations"><span>动作</span>${actions}</div>` : ''}
      ${context.ai_reply_preview ? `<p><strong>AI 预判回复：</strong>${escapeHtml(context.ai_reply_preview)}</p>` : ''}
      ${sources ? `<p><strong>知识来源：</strong></p><ul class="context-source-list">${sources}</ul>` : ''}
      <pre>${escapeHtml([
        context.recent_context ? `最近对话\n${context.recent_context}` : '',
        context.memory_context ? `长期记忆\n${context.memory_context}` : '',
        context.user_context ? `用户数据\n${context.user_context}` : '',
        context.error ? `错误\n${context.error}` : '',
      ].filter(Boolean).join('\n\n'))}</pre>
    </details>`;
}

function renderSummary() {
  const s = inbox.summary || {};
  $('#updatedAt').textContent = `更新 ${formatTime(new Date())}`;
  $('#summaryStats').innerHTML = `
    <div class="cache-stat-card"><strong>${s.total || 0}</strong><span>总消息</span></div>
    <div class="cache-stat-card"><strong>${s.last_24h || 0}</strong><span>24小时</span></div>
    <div class="cache-stat-card"><strong>${s.recorded || 0}</strong><span>已记录</span></div>
    <div class="cache-stat-card"><strong>${s.replied || 0}</strong><span>已回复</span></div>
    <div class="cache-stat-card"><strong>${s.failed || 0}</strong><span>失败</span></div>
    <div class="cache-stat-card"><strong>${s.processing || 0}</strong><span>处理中</span></div>`;
}

function renderIntents() {
  $('#intentCount').textContent = `${inbox.intents.length} 类`;
  $('#intentList').innerHTML = inbox.intents.length ? inbox.intents.map((item) => `
    <button type="button" data-intent-pick="${escapeHtml(item.intent)}">
      <span>${escapeHtml(intentLabel(item.intent))}</span>
      <code>${escapeHtml(item.intent)}</code>
      <strong>${item.count}</strong>
    </button>`).join('') : '<div class="empty-state">暂无意图数据。</div>';
  document.querySelectorAll('[data-intent-pick]').forEach((button) => {
    button.onclick = () => {
      $('#filterForm').elements.intent.value = button.dataset.intentPick.split('.')[0] || '';
      loadInbox().catch((error) => toast(error.message));
    };
  });
}

function renderRules() {
  $('#ruleCount').textContent = `${rules.length} 条`;
  $('#ruleList').innerHTML = rules.length ? rules.map((rule) => `
    <button type="button" class="rule-row ${rule.enabled ? '' : 'disabled'}">
      <span>${escapeHtml(rule.pattern)}</span>
      <code>${escapeHtml(rule.value)} · 命中 ${rule.hit_count || 0}</code>
      <strong>${rule.enabled ? '开' : '关'}</strong>
      <em class="rule-actions">
        <i data-rule-toggle="${rule.id}" data-enabled="${rule.enabled ? '1' : '0'}">${rule.enabled ? '停用' : '启用'}</i>
        <i data-rule-delete="${rule.id}">删除</i>
      </em>
    </button>`).join('') : '<div class="empty-state">暂无规则。可以添加“关键词 -> 分类”，纠错也会自动学习。</div>';
  document.querySelectorAll('[data-rule-toggle]').forEach((button) => {
    button.onclick = async (event) => {
      event.stopPropagation();
      try {
        const enabled = button.dataset.enabled !== '1';
        await apiWrite(`/api/assistant/rules/${button.dataset.ruleToggle}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
        toast(enabled ? '规则已启用' : '规则已停用');
        await loadRules();
      } catch (error) { toast(error.message); }
    };
  });
  document.querySelectorAll('[data-rule-delete]').forEach((button) => {
    button.onclick = async (event) => {
      event.stopPropagation();
      if (!confirm('删除这条学习规则？')) return;
      try {
        await apiWrite(`/api/assistant/rules/${button.dataset.ruleDelete}`, { method: 'DELETE' });
        toast('规则已删除');
        await loadRules();
      } catch (error) { toast(error.message); }
    };
  });
}

function renderProfiles() {
  $('#profileCount').textContent = `${profiles.length} 人`;
  $('#profileList').innerHTML = profiles.length ? profiles.map((profile) => `
    <button type="button" class="rule-row ${profile.enabled ? '' : 'disabled'}">
      <span>${escapeHtml(profile.display_name || profile.from_user)}</span>
      <code>${escapeHtml(profile.from_user)} · ${escapeHtml(profile.daily_report_time)}</code>
      <strong>${profile.enabled ? '开' : '关'}</strong>
      <em class="rule-actions">
        <i data-profile-toggle="${escapeHtml(profile.from_user)}" data-enabled="${profile.enabled ? '1' : '0'}">${profile.enabled ? '停用' : '启用'}</i>
        <i data-profile-delete="${escapeHtml(profile.from_user)}">删除</i>
      </em>
    </button>`).join('') : '<div class="empty-state">暂无用户配置。绑定后可指定昵称和日报时间。</div>';
  document.querySelectorAll('[data-profile-toggle]').forEach((button) => {
    button.onclick = async (event) => {
      event.stopPropagation();
      try {
        const enabled = button.dataset.enabled !== '1';
        await apiWrite(`/api/wechat/user-profiles/${encodeURIComponent(button.dataset.profileToggle)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
        toast(enabled ? '用户已启用' : '用户已停用');
        await loadProfiles();
      } catch (error) { toast(error.message); }
    };
  });
  document.querySelectorAll('[data-profile-delete]').forEach((button) => {
    button.onclick = async (event) => {
      event.stopPropagation();
      if (!confirm('删除这个用户配置？')) return;
      try {
        await apiWrite(`/api/wechat/user-profiles/${encodeURIComponent(button.dataset.profileDelete)}`, { method: 'DELETE' });
        toast('用户配置已删除');
        await loadProfiles();
      } catch (error) { toast(error.message); }
    };
  });
}

function renderRows() {
  $('#rowCount').textContent = `${inbox.rows.length} 条`;
  $('#messageList').innerHTML = inbox.rows.length ? inbox.rows.map((row) => {
    const relations = relationText(row);
    return `
      <article class="history-card inbox-card ${statusClass(row.parse_status)}">
        <div class="cache-card-head">
          <strong>${escapeHtml(row.content || row.raw_payload?.FileName || row.msg_type || '空消息')}</strong>
          <div class="cache-badges">
            <span class="status-pill ${statusClass(row.parse_status)}">${escapeHtml(statusLabel(row.parse_status))}</span>
            <span class="status-pill">${escapeHtml(intentLabel(row.intent))}</span>
            <span class="status-pill">${escapeHtml(row.msg_type)}</span>
            ${mediaLabel(row) ? `<span class="status-pill">${escapeHtml(mediaLabel(row))}</span>` : ''}
            ${correctionLabel(row.correction_status) ? `<span class="status-pill warn">${escapeHtml(correctionLabel(row.correction_status))}</span>` : ''}
          </div>
        </div>
        <div class="meta">#${row.id} · ${formatTime(row.received_at)} · ${escapeHtml(row.from_user || '未知用户')} · ${escapeHtml(row.intent || 'unknown')}${row.retry_count ? ` · 重试 ${row.retry_count} 次` : ''}</div>
        ${row.raw_payload?.pending_media_id ? `<div class="inbox-relations"><span>补充说明：已关联 ${escapeHtml(row.raw_payload.pending_media_type || '媒体')} #${escapeHtml(row.raw_payload.pending_media_id)}</span></div>` : ''}
        ${row.media_error ? `<p class="error-text">${escapeHtml(row.media_error)}</p>` : ''}
        ${relations.length ? `<div class="inbox-relations">${relations.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>` : '<div class="inbox-relations muted"><span>未关联业务记录</span></div>'}
        ${row.reply_text ? `<p>${escapeHtml(row.reply_text)}</p>` : ''}
        ${renderAssistantContext(row)}
        <details class="payload-details">
          <summary>查看原始 payload</summary>
          <pre>${escapeHtml(JSON.stringify(row.raw_payload || {}, null, 2))}</pre>
        </details>
        <div class="row-actions inbox-actions">
          <button type="button" data-reprocess="${row.id}" ${row.msg_type !== 'text' ? 'disabled' : ''}>重新处理</button>
          <button type="button" data-undo="${row.id}" ${relations.length ? '' : 'disabled'}>撤销</button>
          <button type="button" data-correct-category="${row.id}" ${row.finance_entry_id ? '' : 'disabled'}>改分类</button>
          <button type="button" data-correct-direction="${row.id}" ${row.finance_entry_id ? '' : 'disabled'}>改方向</button>
          <button type="button" data-save-memory="${row.id}">存为记忆</button>
          <button class="danger-btn" type="button" data-delete-links="${row.id}" ${relations.length ? '' : 'disabled'}>删除关联记录</button>
        </div>
      </article>`;
  }).join('') : '<div class="empty-state">没有匹配的企业微信消息。</div>';
  document.querySelectorAll('[data-reprocess]').forEach((button) => {
    button.onclick = async () => {
      if (!confirm('重新处理这条消息？旧的关联记录会先删除，再按当前规则重新识别。')) return;
      try {
        await apiWrite(`/api/wechat/inbox/${button.dataset.reprocess}/reprocess`, { method: 'POST' });
        toast('消息已重新处理');
        await loadInbox();
      } catch (error) { toast(error.message); }
    };
  });
  document.querySelectorAll('[data-delete-links]').forEach((button) => {
    button.onclick = async () => {
      if (!confirm('删除这条消息关联的账本/健康/知识库/提醒记录？消息本身会保留。')) return;
      try {
        await apiWrite(`/api/wechat/inbox/${button.dataset.deleteLinks}/links`, { method: 'DELETE' });
        toast('关联记录已删除');
        await loadInbox();
      } catch (error) { toast(error.message); }
    };
  });
  document.querySelectorAll('[data-undo]').forEach((button) => {
    button.onclick = async () => {
      if (!confirm('撤销这条消息写入的账本/健康/知识库/提醒记录？')) return;
      try {
        await apiWrite(`/api/wechat/inbox/${button.dataset.undo}/undo`, { method: 'POST' });
        toast('已撤销关联记录');
        await loadInbox();
      } catch (error) { toast(error.message); }
    };
  });
  document.querySelectorAll('[data-correct-category]').forEach((button) => {
    button.onclick = async () => {
      const value = prompt('改成哪个分类？例如 餐饮、交通、项目/工具、收入');
      if (!value) return;
      try {
        await apiWrite(`/api/wechat/inbox/${button.dataset.correctCategory}/correct`, { method: 'POST', body: JSON.stringify({ action: 'finance_category', value }) });
        toast('分类已修改，并已学习规则');
        await loadInbox();
      } catch (error) { toast(error.message); }
    };
  });
  document.querySelectorAll('[data-save-memory]').forEach((button) => {
    button.onclick = async () => {
      const value = prompt('保存成长期记忆的内容');
      if (!value) return;
      try {
        await apiWrite(`/api/wechat/inbox/${button.dataset.saveMemory}/correct`, { method: 'POST', body: JSON.stringify({ action: 'save_memory', category: 'general', value }) });
        toast('已保存为长期记忆');
      } catch (error) { toast(error.message); }
    };
  });
  document.querySelectorAll('[data-correct-direction]').forEach((button) => {
    button.onclick = async () => {
      const value = prompt('改成收入还是支出？', '支出');
      if (!value) return;
      try {
        await apiWrite(`/api/wechat/inbox/${button.dataset.correctDirection}/correct`, { method: 'POST', body: JSON.stringify({ action: 'finance_direction', value: value.includes('收') ? 'income' : 'expense' }) });
        toast('方向已修改');
        await loadInbox();
      } catch (error) { toast(error.message); }
    };
  });
}

function queryString() {
  const data = Object.fromEntries(new FormData($('#filterForm')).entries());
  const params = new URLSearchParams();
  Object.entries(data).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  return params.toString();
}

async function loadInbox() {
  inbox = await api(`/api/wechat/inbox?${queryString()}`);
  renderSummary();
  renderIntents();
  renderRows();
}

async function loadRules() {
  rules = await api('/api/assistant/rules?rule_type=finance_category');
  renderRules();
}

async function loadProfiles() {
  profiles = await api('/api/wechat/user-profiles');
  renderProfiles();
}

$('#filterForm').onsubmit = (event) => {
  event.preventDefault();
  loadInbox().catch((error) => toast(error.message));
};
$('#refreshBtn').onclick = () => loadInbox().catch((error) => toast(error.message));

const retryBtn = document.createElement('button');
retryBtn.type = 'button';
retryBtn.className = 'btn';
retryBtn.textContent = '重试失败消息';
retryBtn.onclick = async () => {
  try {
    const result = await apiWrite('/api/wechat/inbox/retry-failed', { method: 'POST', body: JSON.stringify({ limit: 10, notify: false }) });
    toast(`已处理 ${result.processed || 0} 条失败消息`);
    await loadInbox();
  } catch (error) { toast(error.message); }
};
$('#refreshBtn').insertAdjacentElement('afterend', retryBtn);

$('#ruleForm').onsubmit = async (event) => {
  event.preventDefault();
  try {
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (!payload.from_user) delete payload.from_user;
    await apiWrite('/api/assistant/rules', { method: 'POST', body: JSON.stringify({ ...payload, rule_type: 'finance_category' }) });
    event.currentTarget.reset();
    toast('规则已添加');
    await loadRules();
  } catch (error) { toast(error.message); }
};

$('#profileForm').onsubmit = async (event) => {
  event.preventDefault();
  try {
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    await apiWrite('/api/wechat/user-profiles', { method: 'POST', body: JSON.stringify(payload) });
    event.currentTarget.reset();
    toast('用户配置已保存');
    await loadProfiles();
  } catch (error) { toast(error.message); }
};

Promise.all([loadInbox(), loadRules(), loadProfiles()]).catch((error) => toast(error.message));
