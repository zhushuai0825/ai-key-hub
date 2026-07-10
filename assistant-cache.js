const $ = (selector) => document.querySelector(selector);
let memory = null;
let cacheRows = [];
let reportSubscriptions = [];
let goals = [];

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

async function api(path, options = {}) {
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

function topicLabel(topic) {
  return { fitness: '健康', finance: '账本', knowledge: '知识库', memory: '长期记忆' }[topic] || topic;
}

function fitnessTitle(row) {
  if (row.entry_type === 'weight') return `体重 ${row.weight_kg}kg`;
  if (row.entry_type === 'sleep') return `睡眠 ${row.sleep_hours}小时`;
  if (row.entry_type === 'workout') return `${row.workout_type || '运动'} ${row.duration_min || 0}分钟`;
  if (row.entry_type === 'meal') return `${row.meal_type || '饮食'} ${row.food_text || row.note || ''}`;
  return row.note || row.entry_type;
}

function fitnessDetail(row) {
  if (row.entry_type === 'meal') return `约 ${row.calories || 0} 千卡`;
  if (row.entry_type === 'workout') return `约消耗 ${row.burned_calories || 0} 千卡`;
  if (row.entry_type === 'sleep') return `质量：${row.sleep_quality || '一般'}`;
  return row.ai_summary || row.note || '';
}

function financeTitle(row) {
  const label = row.direction === 'income' ? '收入' : '支出';
  return `${label} ¥${Number(row.amount).toFixed(2)} · ${row.title}`;
}

function shortText(value = '', max = 72) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function logRow(tone, title, time, meta, actions = '') {
  return `<article class="log-row tone-${tone || 'muted'}">
    <i class="log-dot" aria-hidden="true"></i>
    <div class="log-body">
      <div class="log-line"><strong title="${escapeHtml(title)}">${escapeHtml(shortText(title, 44))}</strong><time>${escapeHtml(time)}</time></div>
      <div class="log-meta"><span title="${escapeHtml(meta)}">${escapeHtml(shortText(meta, 80))}</span>${actions}</div>
    </div>
  </article>`;
}

function renderSummary() {
  const s = memory?.counts || {};
  const month = memory?.month_stats || {};
  $('#memoryStats').innerHTML = [
    ['健康', s.fitness || 0],
    ['账本', s.finance || 0],
    ['本月支出', `¥${Number(month.expense || 0).toFixed(0)}`],
    ['本月收入', `¥${Number(month.income || 0).toFixed(0)}`],
    ['记忆', s.memories || 0],
    ['待办', s.tasks || 0],
    ['报告', s.reports || 0],
    ['问答', s.useful_cache || 0],
  ].map(([label, value]) => `<span class="log-stat"><em>${label}</em><b>${escapeHtml(String(value))}</b></span>`).join('');
  $('#memoryUpdatedAt').textContent = formatTime(new Date().toISOString());
}

function memoryCategoryLabel(category) {
  return {
    preference: '偏好', profile: '个人资料', goal: '目标', project: '项目',
    health: '健康', finance: '财务', knowledge: '知识', general: '通用',
  }[category] || category || '通用';
}

function renderLongMemories() {
  const rows = memory?.memories || [];
  $('#longMemoryCount').textContent = `${rows.length} 条`;
  $('#longMemoryList').innerHTML = rows.length ? rows.map((row) => logRow(
    row.pinned ? 'ok' : 'muted',
    row.content,
    formatTime(row.updated_at),
    `${memoryCategoryLabel(row.category)} · 重要度 ${row.importance}${row.pinned ? ' · 已固定' : ''}`,
    `<button type="button" class="timeline-link" data-memory-pin="${row.id}" data-pinned="${row.pinned ? '1' : '0'}">${row.pinned ? '取消固定' : '固定'}</button>
     <button type="button" class="timeline-link danger" data-memory-delete="${row.id}">删除</button>`,
  )).join('') : '<div class="empty-state">还没有长期记忆</div>';

  document.querySelectorAll('[data-memory-pin]').forEach((btn) => {
    btn.onclick = async () => {
      const id = Number(btn.dataset.memoryPin);
      const pinned = btn.dataset.pinned !== '1';
      try {
        await api(`/api/assistant/memories/${id}`, { method: 'PATCH', body: JSON.stringify({ pinned }) });
        toast(pinned ? '记忆已固定' : '已取消固定');
        await loadAll();
      } catch (error) { toast(error.message); }
    };
  });
  document.querySelectorAll('[data-memory-delete]').forEach((btn) => {
    btn.onclick = async () => {
      const id = Number(btn.dataset.memoryDelete);
      if (!window.confirm('确定删除这条长期记忆吗？')) return;
      try {
        await api(`/api/assistant/memories/${id}`, { method: 'DELETE' });
        toast('记忆已删除');
        await loadAll();
      } catch (error) { toast(error.message); }
    };
  });
}

function renderFitness() {
  const rows = memory?.fitness || [];
  $('#fitnessCount').textContent = `${rows.length} 条`;
  $('#fitnessList').innerHTML = rows.length ? rows.map((row) => logRow(
    'ok',
    fitnessTitle(row),
    formatTime(row.recorded_at),
    fitnessDetail(row),
    `<button type="button" class="timeline-link danger" data-fitness-delete="${row.id}">删除</button>`,
  )).join('') : '<div class="empty-state">还没有健康记录</div>';
  document.querySelectorAll('[data-fitness-delete]').forEach((btn) => {
    btn.onclick = async () => {
      const id = Number(btn.dataset.fitnessDelete);
      if (!window.confirm('确定删除这条健康记录吗？')) return;
      try {
        await api(`/api/fitness/entries/${id}`, { method: 'DELETE' });
        toast('健康记录已删除');
        await loadAll();
      } catch (error) { toast(error.message); }
    };
  });
}

function renderFinance() {
  const rows = memory?.finance || [];
  $('#financeCount').textContent = `${rows.length} 条`;
  $('#financeList').innerHTML = rows.length ? rows.map((row) => logRow(
    row.direction === 'income' ? 'ok' : 'warn',
    financeTitle(row),
    formatTime(row.occurred_at),
    `${row.category || '未分类'}${row.note ? ` · ${row.note}` : ''}`,
    `<button type="button" class="timeline-link danger" data-finance-delete="${row.id}">删除</button>`,
  )).join('') : '<div class="empty-state">还没有账本记录</div>';
  document.querySelectorAll('[data-finance-delete]').forEach((btn) => {
    btn.onclick = async () => {
      const id = Number(btn.dataset.financeDelete);
      if (!window.confirm('确定删除这条账本记录吗？')) return;
      try {
        await api(`/api/finance/entries/${id}`, { method: 'DELETE' });
        toast('账本记录已删除');
        await loadAll();
      } catch (error) { toast(error.message); }
    };
  });
}

function renderCache() {
  $('#cacheCount').textContent = `${cacheRows.length} 条`;
  $('#cacheList').innerHTML = cacheRows.length ? cacheRows.map((row) => logRow(
    row.pinned ? 'ok' : 'muted',
    row.question,
    formatTime(row.updated_at),
    `${topicLabel(row.topic)}${row.hit_count ? ` · 命中 ${row.hit_count}` : ''} · ${String(row.answer || '').replace(/\s+/g, ' ')}`,
    `<button type="button" class="timeline-link" data-pin="${row.id}" data-pinned="${row.pinned ? '1' : '0'}">${row.pinned ? '取消固定' : '固定'}</button>
     <button type="button" class="timeline-link danger" data-delete="${row.id}">删除</button>`,
  )).join('') : '<div class="empty-state">还没有有价值问答</div>';

  document.querySelectorAll('[data-pin]').forEach((btn) => {
    btn.onclick = async () => {
      const id = Number(btn.dataset.pin);
      const pinned = btn.dataset.pinned !== '1';
      try {
        await api(`/api/assistant/cache/${id}`, { method: 'PATCH', body: JSON.stringify({ pinned }) });
        toast(pinned ? '已固定' : '已取消固定');
        await loadAll();
      } catch (error) {
        toast(error.message);
      }
    };
  });

  document.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.onclick = async () => {
      const id = Number(btn.dataset.delete);
      if (!window.confirm('确定删除这条问答吗？')) return;
      try {
        await api(`/api/assistant/cache/${id}`, { method: 'DELETE' });
        toast('已删除');
        await loadAll();
      } catch (error) {
        toast(error.message);
      }
    };
  });
}

function reportTypeLabel(type) {
  return { daily: '日报', weekly: '周报' }[type] || type;
}

function weekdayLabel(value) {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][Number(value)] || '--';
}

function renderReportSubscriptions() {
  $('#reportSubCount').textContent = `${reportSubscriptions.length} 条`;
  $('#reportSubList').innerHTML = reportSubscriptions.length ? reportSubscriptions.map((row) => logRow(
    row.enabled ? 'ok' : 'muted',
    `${row.from_user} · ${reportTypeLabel(row.report_type)}`,
    formatTime(row.updated_at),
    `${row.send_time}${row.report_type === 'weekly' ? ` · ${weekdayLabel(row.weekday)}` : ''} · ${row.enabled ? '已启用' : '已停用'} · 最近 ${row.last_sent_at ? formatTime(row.last_sent_at) : '从未'}`,
    `<button type="button" class="timeline-link" data-report-toggle="${row.id}" data-enabled="${row.enabled ? '1' : '0'}">${row.enabled ? '停用' : '启用'}</button>
     <button type="button" class="timeline-link danger" data-report-delete="${row.id}">删除</button>`,
  )).join('') : '<div class="empty-state">暂无报告订阅</div>';
  document.querySelectorAll('[data-report-toggle]').forEach((button) => {
    button.onclick = async () => {
      const enabled = button.dataset.enabled !== '1';
      try {
        await api(`/api/assistant/report-subscriptions/${button.dataset.reportToggle}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
        toast(enabled ? '订阅已启用' : '订阅已停用');
        await loadAll();
      } catch (error) { toast(error.message); }
    };
  });
  document.querySelectorAll('[data-report-delete]').forEach((button) => {
    button.onclick = async () => {
      if (!confirm('删除这个报告订阅？')) return;
      try {
        await api(`/api/assistant/report-subscriptions/${button.dataset.reportDelete}`, { method: 'DELETE' });
        toast('订阅已删除');
        await loadAll();
      } catch (error) { toast(error.message); }
    };
  });
}

function goalTypeLabel(type) {
  return { weight: '体重', monthly_expense: '月支出', weekly_workout: '周运动', sleep: '睡眠' }[type] || type;
}

function renderGoals() {
  $('#goalCount').textContent = `${goals.length} 条`;
  $('#goalList').innerHTML = goals.length ? goals.map((row) => logRow(
    row.enabled ? 'ok' : 'muted',
    `${row.title} · ${Number(row.target_value).toFixed(row.goal_type === 'weekly_workout' ? 0 : 1)}${row.unit || ''}`,
    formatTime(row.updated_at),
    `${goalTypeLabel(row.goal_type)} · ${row.from_user || '全局'} · ${row.enabled ? '启用' : '停用'}${row.note ? ` · ${row.note}` : ''}`,
    `<button type="button" class="timeline-link" data-goal-toggle="${row.id}" data-enabled="${row.enabled ? '1' : '0'}">${row.enabled ? '停用' : '启用'}</button>
     <button type="button" class="timeline-link danger" data-goal-delete="${row.id}">删除</button>`,
  )).join('') : '<div class="empty-state">暂无目标</div>';
  document.querySelectorAll('[data-goal-toggle]').forEach((button) => {
    button.onclick = async () => {
      const enabled = button.dataset.enabled !== '1';
      try {
        await api(`/api/assistant/goals/${button.dataset.goalToggle}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
        toast(enabled ? '目标已启用' : '目标已停用');
        await loadAll();
      } catch (error) { toast(error.message); }
    };
  });
  document.querySelectorAll('[data-goal-delete]').forEach((button) => {
    button.onclick = async () => {
      if (!confirm('删除这个目标？')) return;
      try {
        await api(`/api/assistant/goals/${button.dataset.goalDelete}`, { method: 'DELETE' });
        toast('目标已删除');
        await loadAll();
      } catch (error) { toast(error.message); }
    };
  });
}

async function loadCacheRows() {
  const form = new FormData($('#filterForm'));
  const params = new URLSearchParams();
  if (form.get('topic')) params.set('topic', form.get('topic'));
  if (form.get('q')) params.set('q', form.get('q'));
  cacheRows = await api(`/api/assistant/cache?${params.toString()}`);
}

async function loadAll() {
  [memory, reportSubscriptions, goals] = await Promise.all([
    api('/api/assistant/memory'),
    api('/api/assistant/report-subscriptions'),
    api('/api/assistant/goals'),
  ]);
  const form = new FormData($('#filterForm'));
  const topic = form.get('topic');
  const q = form.get('q');
  if (!topic && !q) {
    cacheRows = memory.useful_cache || [];
  } else {
    await loadCacheRows();
  }
  renderSummary();
  renderLongMemories();
  renderFitness();
  renderFinance();
  renderGoals();
  renderReportSubscriptions();
  renderCache();
}

$('#filterForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await loadCacheRows();
    renderCache();
  } catch (error) {
    toast(error.message);
  }
});

$('#refreshBtn').onclick = () => loadAll().catch((error) => toast(error.message));

$('#goalForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (!payload.from_user) delete payload.from_user;
    await api('/api/assistant/goals', { method: 'POST', body: JSON.stringify(payload) });
    event.currentTarget.reset();
    toast('目标已添加');
    await loadAll();
  } catch (error) { toast(error.message); }
});

$('#reportSubForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    await api('/api/assistant/report-subscriptions', { method: 'POST', body: JSON.stringify(payload) });
    toast('报告订阅已保存');
    await loadAll();
  } catch (error) { toast(error.message); }
});

loadAll().catch((error) => toast(error.message));
