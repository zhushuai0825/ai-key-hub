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

function renderSummary() {
  const s = memory?.counts || {};
  const month = memory?.month_stats || {};
  $('#memoryStats').innerHTML = `
    <div class="cache-stat-card"><strong>${s.fitness || 0}</strong><span>健康记录</span></div>
    <div class="cache-stat-card"><strong>${s.finance || 0}</strong><span>账本记录</span></div>
    <div class="cache-stat-card"><strong>¥${Number(month.expense || 0).toFixed(0)}</strong><span>本月支出</span></div>
    <div class="cache-stat-card"><strong>¥${Number(month.income || 0).toFixed(0)}</strong><span>本月收入</span></div>
    <div class="cache-stat-card"><strong>${s.memories || 0}</strong><span>长期记忆</span></div>
    <div class="cache-stat-card"><strong>${s.tasks || 0}</strong><span>待办提醒</span></div>
    <div class="cache-stat-card"><strong>${s.reports || 0}</strong><span>AI报告</span></div>
    <div class="cache-stat-card"><strong>${s.useful_cache || 0}</strong><span>有价值问答</span></div>`;
  $('#memoryUpdatedAt').textContent = `更新于 ${formatTime(new Date().toISOString())}`;
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
  $('#longMemoryList').innerHTML = rows.length ? rows.map((row) => `
    <article class="history-card cache-card ${row.pinned ? 'pinned' : ''}">
      <div class="cache-card-head">
        <strong>${escapeHtml(row.content)}</strong>
        <div class="cache-badges">
          <span class="status-pill ok">${escapeHtml(memoryCategoryLabel(row.category))}</span>
          <span class="status-pill">重要度 ${row.importance}</span>
          ${row.pinned ? '<span class="status-pill ok">已固定</span>' : ''}
        </div>
      </div>
      <div class="meta">更新 ${formatTime(row.updated_at)}</div>
      <div class="row-actions">
        <button type="button" data-memory-pin="${row.id}" data-pinned="${row.pinned ? '1' : '0'}">${row.pinned ? '取消固定' : '固定记忆'}</button>
        <button class="danger-btn" type="button" data-memory-delete="${row.id}">删除</button>
      </div>
    </article>`).join('') : '<div class="empty-state">还没有长期记忆。你可以在企业微信里说：记住我不喝奶茶、我的目标是体重到68kg、这个项目叫AI助手。</div>';

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
  $('#fitnessList').innerHTML = rows.length ? rows.map((row) => `
    <article class="history-card">
      <strong>${escapeHtml(fitnessTitle(row))}</strong>
      <p>${escapeHtml(fitnessDetail(row))}</p>
      <div class="meta">${formatTime(row.recorded_at)}</div>
      <div class="row-actions"><button class="danger-btn" type="button" data-fitness-delete="${row.id}">删除</button></div>
    </article>`).join('') : '<div class="empty-state">还没有健康记录。在企业微信发：体重 72.5、跑步 30 分钟、睡了 7 小时。</div>';
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
  $('#financeList').innerHTML = rows.length ? rows.map((row) => `
    <article class="history-card">
      <strong>${escapeHtml(financeTitle(row))}</strong>
      <p>${escapeHtml(row.category || '未分类')}${row.note ? ` · ${escapeHtml(row.note)}` : ''}</p>
      <div class="meta">${formatTime(row.occurred_at)}</div>
      <div class="row-actions"><button class="danger-btn" type="button" data-finance-delete="${row.id}">删除</button></div>
    </article>`).join('') : '<div class="empty-state">还没有账本记录。在企业微信发：买咖啡 18、收入工资 5000。</div>';
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
  $('#cacheList').innerHTML = cacheRows.length ? cacheRows.map((row) => `
    <article class="history-card cache-card ${row.pinned ? 'pinned' : ''}">
      <div class="cache-card-head">
        <strong>${escapeHtml(row.question)}</strong>
        <div class="cache-badges">
          <span class="status-pill ok">${escapeHtml(topicLabel(row.topic))}</span>
          ${row.pinned ? '<span class="status-pill ok">已固定</span>' : ''}
          ${Number(row.hit_count || 0) > 0 ? `<span class="status-pill">命中 ${row.hit_count}</span>` : ''}
        </div>
      </div>
      <p>${escapeHtml(row.answer).replace(/\n/g, '<br>')}</p>
      <div class="meta">更新 ${formatTime(row.updated_at)}${row.last_hit_at ? ` · 最近命中 ${formatTime(row.last_hit_at)}` : ''}</div>
      <div class="row-actions">
        <button type="button" data-pin="${row.id}" data-pinned="${row.pinned ? '1' : '0'}">${row.pinned ? '取消固定' : '固定收藏'}</button>
        <button class="danger-btn" type="button" data-delete="${row.id}">删除</button>
      </div>
    </article>`).join('') : '<div class="empty-state">还没有有价值问答。试试问：我这个月花了多少、最近体重怎么样、知识库里的问题。</div>';

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
  $('#reportSubList').innerHTML = reportSubscriptions.length ? reportSubscriptions.map((row) => `
    <article class="history-card cache-card ${row.enabled ? 'pinned' : 'expired'}">
      <div class="cache-card-head">
        <strong>${escapeHtml(row.from_user)} · ${escapeHtml(reportTypeLabel(row.report_type))}</strong>
        <div class="cache-badges">
          <span class="status-pill ${row.enabled ? 'ok' : ''}">${row.enabled ? '已启用' : '已停用'}</span>
          <span class="status-pill">${escapeHtml(row.send_time)}</span>
          ${row.report_type === 'weekly' ? `<span class="status-pill">${escapeHtml(weekdayLabel(row.weekday))}</span>` : ''}
        </div>
      </div>
      <div class="meta">最近推送 ${row.last_sent_at ? formatTime(row.last_sent_at) : '从未'} · 更新 ${formatTime(row.updated_at)}</div>
      <div class="row-actions">
        <button type="button" data-report-toggle="${row.id}" data-enabled="${row.enabled ? '1' : '0'}">${row.enabled ? '停用' : '启用'}</button>
        <button class="danger-btn" type="button" data-report-delete="${row.id}">删除</button>
      </div>
    </article>`).join('') : '<div class="empty-state">暂无报告订阅。添加后系统会按时间通过企业微信推送日报或周报。</div>';
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
  $('#goalList').innerHTML = goals.length ? goals.map((row) => `
    <article class="history-card cache-card ${row.enabled ? 'pinned' : 'expired'}">
      <div class="cache-card-head">
        <strong>${escapeHtml(row.title)} · ${Number(row.target_value).toFixed(row.goal_type === 'weekly_workout' ? 0 : 1)}${escapeHtml(row.unit || '')}</strong>
        <div class="cache-badges">
          <span class="status-pill ${row.enabled ? 'ok' : ''}">${row.enabled ? '启用' : '停用'}</span>
          <span class="status-pill">${escapeHtml(goalTypeLabel(row.goal_type))}</span>
          ${row.from_user ? `<span class="status-pill">${escapeHtml(row.from_user)}</span>` : '<span class="status-pill">全局</span>'}
        </div>
      </div>
      ${row.note ? `<p>${escapeHtml(row.note)}</p>` : ''}
      <div class="meta">更新 ${formatTime(row.updated_at)}</div>
      <div class="row-actions">
        <button type="button" data-goal-toggle="${row.id}" data-enabled="${row.enabled ? '1' : '0'}">${row.enabled ? '停用' : '启用'}</button>
        <button class="danger-btn" type="button" data-goal-delete="${row.id}">删除</button>
      </div>
    </article>`).join('') : '<div class="empty-state">暂无目标。可以添加体重、月支出、周运动或睡眠目标，日报/周报会自动对比偏差。</div>';
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
