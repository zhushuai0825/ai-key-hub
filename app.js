const $ = (s) => document.querySelector(s);

const axisStyle = { color: '#6b7280', fontSize: 10, fontFamily: 'IBM Plex Mono, Menlo, monospace' };
const gridLine = { color: 'rgba(255,255,255,0.05)' };
const tooltip = {
  backgroundColor: '#14171c',
  borderColor: 'rgba(255,255,255,0.12)',
  borderWidth: 1,
  textStyle: { color: '#e8eaed', fontSize: 11 },
};

const MODULE_GROUPS = [
  {
    id: 'ai',
    title: 'AI 与知识',
    hint: 'Key、知识库、全局搜索',
    modules: [
      { id: 'aitoken', name: 'AIToken', desc: '厂商 API Key、真实余额、一键复制', icon: 'aitoken.svg', href: '/keys.html', status: 'online', metricKey: 'key_count', metricLabel: 'Key' },
      { id: 'knowledge', name: 'Knowledge', desc: '统一知识库检索与 AI 提问', icon: 'knowledge.svg', href: '/knowledge-ask.html', status: 'online', metricKey: 'knowledge_chunks', metricLabel: 'chunks' },
      { id: 'knowledge-manage', name: '知识库管理', desc: '上传文档、质量检测与重建向量', icon: 'knowledge.svg', href: '/knowledge.html', status: 'online' },
      { id: 'search', name: 'Global Search', desc: '跨账本、健康、知识库与企微搜索', icon: 'knowledge.svg', href: '/global-search.html', status: 'online' },
      { id: 'gateway', name: 'Gateway', desc: '统一模型路由、限流与故障切换', icon: 'gateway.svg', status: 'planned' },
      { id: 'cost', name: 'Cost Lens', desc: '费用归因、预算预警与报表', icon: 'cost.svg', status: 'planned' },
    ],
  },
  {
    id: 'life',
    title: '生活助手',
    hint: '数据、账本、健康、提醒、画像',
    modules: [
      { id: 'cache', name: '我的数据', desc: '体重、账本、运动、睡眠与有价值问答', icon: 'audit.svg', href: '/assistant-cache.html', status: 'online', metricKey: 'cache_hits', metricLabel: 'hits' },
      { id: 'finance', name: 'Finance', desc: '账本流水、分类统计与纠错', icon: 'cost.svg', href: '/finance.html', status: 'online' },
      { id: 'fitlog', name: 'FitLog', desc: '体重、饮食、运动与 AI 建议', icon: 'monitor.svg', href: '/fitness.html', status: 'online' },
      { id: 'tasks', name: 'Task Center', desc: '提醒任务、重复提醒、完成与暂停', icon: 'tasks.svg', href: '/tasks.html', status: 'online', metricKey: 'pending_tasks', metricLabel: 'tasks' },
      { id: 'profile', name: 'Profile', desc: '个人画像与长期记忆', icon: 'agent.svg', href: '/profile.html', status: 'online' },
      { id: 'notifications', name: 'Notifications', desc: '日报、周报与系统通知订阅', icon: 'tasks.svg', href: '/notifications.html', status: 'online' },
    ],
  },
  {
    id: 'wecom',
    title: '企业微信',
    hint: '消息处理与链路诊断',
    modules: [
      { id: 'wecom', name: 'WeCom Inbox', desc: '消息识别、失败原因与关联记录', icon: 'tasks.svg', href: '/wechat-inbox.html', status: 'online' },
      { id: 'wechat-diagnostics', name: 'WeCom Diagnostics', desc: '回调、上传、媒体与推送诊断', icon: 'monitor.svg', href: '/wechat-diagnostics.html', status: 'online' },
    ],
  },
  {
    id: 'ops',
    title: '运维与审计',
    hint: '监控、事件、配置、备份',
    modules: [
      { id: 'monitor', name: 'Monitor', desc: '服务健康、Chroma、企微、OCR 状态', icon: 'monitor.svg', href: '/monitor.html', status: 'online' },
      { id: 'events', name: 'System Events', desc: '备份、重试、推送与恢复事件', icon: 'audit.svg', href: '/events.html', status: 'online' },
      { id: 'timeline', name: 'Timeline', desc: '账本、健康、知识库与审计动态', icon: 'audit.svg', href: '/timeline.html', status: 'online' },
      { id: 'audit', name: 'Audit Log', desc: '系统任务与管理操作记录', icon: 'audit.svg', href: '/timeline.html?type=audit', status: 'online' },
      { id: 'config', name: 'Config Center', desc: '环境变量与集成配置状态', icon: 'gateway.svg', href: '/config.html', status: 'online' },
      { id: 'backup', name: 'Backup', desc: '数据导出、备份与恢复', icon: 'audit.svg', href: '/backup.html', status: 'online' },
      { id: 'agent', name: 'Agent Hub', desc: '多 Agent 编排与工具链调度', icon: 'agent.svg', status: 'planned' },
    ],
  },
];

const MODULES = MODULE_GROUPS.flatMap((group) => group.modules);

let stats = { count: 0, key_count: 0, total_balance: 0, abnormal_keys: 0, today_calls: 0, today_cost: 0, avg_latency: 0 };
let providers = [];
let keys = [];
let models = [];
let usageSeries = [];
let pulseChart;
let fitnessSummary = null;
let fitnessChart;
let knowledgeSummary = null;
let cacheSummary = null;
let dashboardMemory = null;

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function formatDashTime(value) {
  if (!value) return '--';
  return new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}

function topicLabel(topic) {
  return { fitness: '健康', finance: '账本', knowledge: '知识库' }[topic] || topic;
}

function lifestyleTitle(row) {
  if (row.entry_type === 'weight') return `体重 ${row.weight_kg}kg`;
  if (row.entry_type === 'sleep') return `睡眠 ${row.sleep_hours}小时`;
  if (row.entry_type === 'meal') return `${row.meal_type || '饮食'} ${row.food_text || row.note || ''}`;
  return row.note || row.entry_type;
}

function lifestyleDetail(row) {
  if (row.entry_type === 'meal') return `约 ${row.calories || 0} 千卡`;
  if (row.entry_type === 'sleep') return `质量 ${row.sleep_quality || '一般'}`;
  return row.note || '';
}

function lifestyleTag(row) {
  return { weight: '体重', meal: '饮食', sleep: '睡眠' }[row.entry_type] || row.entry_type;
}

function renderCacheHitFeed() {
  const rows = dashboardMemory?.cache_hits || [];
  const totalHits = rows.reduce((sum, row) => sum + Number(row.hit_count || 0), 0);
  $('#cacheHitMeta').textContent = rows.length ? `${rows.length} 条 · 累计 ${totalHits} 次` : '0 次命中';
  $('#cacheHitFeed').innerHTML = rows.length
    ? rows.map((row) => `
      <div class="dash-row">
        <strong>${escapeHtml(row.question)}<span class="dash-tag hit">×${row.hit_count}</span><span class="dash-tag">${escapeHtml(topicLabel(row.topic))}</span></strong>
        <p>${escapeHtml(row.answer)}</p>
        <span class="dash-time">${formatDashTime(row.last_hit_at || row.updated_at)}</span>
      </div>`).join('')
    : '<div class="dash-row"><p>暂无命中缓存。重复问健康/账本/知识库问题后会出现在这里。</p></div>';
}

function renderLifestyleFeed() {
  const rows = dashboardMemory?.lifestyle || [];
  $('#lifestyleFeed').innerHTML = rows.length
    ? rows.map((row) => `
      <div class="dash-row">
        <strong>${escapeHtml(lifestyleTitle(row))}<span class="dash-tag ${row.entry_type}">${lifestyleTag(row)}</span></strong>
        <p>${escapeHtml(lifestyleDetail(row))}</p>
        <span class="dash-time">${formatDashTime(row.recorded_at)}</span>
      </div>`).join('')
    : '<div class="dash-row"><p>暂无记录。企微发送：体重 72.5、吃了鸡胸肉、睡了 7 小时。</p></div>';
}

function renderFinanceFeed() {
  const rows = dashboardMemory?.finance || [];
  const month = dashboardMemory?.month_stats || {};
  $('#financeMonthMeta').textContent = `本月 收 ¥${fmtNum(month.income || 0, 0)} / 支 ¥${fmtNum(month.expense || 0, 0)}`;
  $('#financeFeed').innerHTML = rows.length
    ? rows.map((row) => {
      const label = row.direction === 'income' ? '收入' : '支出';
      const tagClass = row.direction === 'income' ? 'income' : 'expense';
      return `
      <div class="dash-row">
        <strong>${label} ¥${Number(row.amount).toFixed(2)} · ${escapeHtml(row.title)}<span class="dash-tag ${tagClass}">${escapeHtml(row.category || '未分类')}</span></strong>
        <p>${escapeHtml(row.note || '')}</p>
        <span class="dash-time">${formatDashTime(row.occurred_at)}</span>
      </div>`;
    }).join('')
    : '<div class="dash-row"><p>暂无记账。企微发送：买咖啡 18、收入工资 5000。</p></div>';
}

function isTaskDue(row) {
  if (!row.remind_at) return false;
  return new Date(row.remind_at).getTime() <= Date.now();
}

function renderTasksFeed() {
  const rows = dashboardMemory?.tasks || [];
  const dueCount = dashboardMemory?.counts?.tasks_due || rows.filter(isTaskDue).length;
  $('#tasksMeta').textContent = rows.length ? `${dueCount} 项到期 / 共 ${rows.length} 项` : '0 项';
  $('#tasksFeed').innerHTML = rows.length
    ? rows.map((row) => `
      <div class="dash-row">
        <strong>${escapeHtml(row.title)}${isTaskDue(row) ? '<span class="dash-tag hit">到期</span>' : ''}${row.recurrence && row.recurrence !== 'none' ? `<span class="dash-tag">${escapeHtml(row.recurrence)}</span>` : ''}</strong>
        <p>${escapeHtml(row.note || '无备注')}</p>
        <span class="dash-time">${row.remind_at ? formatDashTime(row.remind_at) : '无提醒时间'}</span>
      </div>`).join('')
    : '<div class="dash-row"><p>暂无待办。企微说：明天早上9点提醒我开会。</p></div>';
}

function renderMemoryDashboard() {
  renderCacheHitFeed();
  renderTasksFeed();
  renderLifestyleFeed();
  renderFinanceFeed();
}

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!res.ok) throw new Error(await res.text() || '请求失败');
  return res.json();
}

function updateClock() {
  const el = $('#clock');
  if (!el) return;
  el.textContent = new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}
setInterval(updateClock, 1000);
updateClock();

function fmtNum(n, digits = 0) {
  return Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function money(n) {
  return `¥${fmtNum(n, 2)}`;
}

function renderTelemetry() {
  const items = [
    ['厂商', stats.count || providers.length, ''],
    ['Key 总数', stats.key_count || keys.length, stats.abnormal_keys ? `${stats.abnormal_keys} 异常` : ''],
    ['今日调用', stats.today_calls || 0, '真实日志'],
    ['今日费用', money(stats.today_cost), '真实日志'],
    ['平均延迟', `${stats.avg_latency || 0}ms`, '真实日志'],
  ];

  $('#telemetry').innerHTML = items.map(([label, value, sub]) => `
    <div class="tel-item">
      <span>${label}</span>
      <strong>${value}</strong>
      ${sub ? `<em>${sub}</em>` : ''}
    </div>
  `).join('');
}

function renderModuleCard(m) {
  const isOnline = m.status === 'online';
  const Tag = isOnline ? 'a' : 'div';
  const metric = m.metricKey && stats[m.metricKey] != null
    ? `<div class="module-metric"><strong>${fmtNum(stats[m.metricKey])}</strong><span>${m.metricLabel || ''}</span></div>`
    : '';
  const classes = ['module-card', isOnline ? 'online' : 'locked'].filter(Boolean).join(' ');
  return `
    <${Tag} class="${classes}" ${isOnline ? `href="${m.href}"` : ''} ${!isOnline ? 'aria-disabled="true"' : ''}>
      <div class="module-top">
        <img class="module-icon" src="./assets/icons/${m.icon}" alt="" width="40" height="40" />
        <span class="module-status ${m.status}">${isOnline ? '在线' : '未接入'}</span>
      </div>
      <div class="module-name">${m.name}</div>
      <p class="module-desc">${m.desc}</p>
      ${metric}
      <div class="module-enter">${isOnline ? '进入' : '规划中'}</div>
    </${Tag}>`;
}

function renderModules() {
  const root = $('#moduleGroups');
  if (!root) return;
  root.innerHTML = MODULE_GROUPS.map((group) => {
    const online = group.modules.filter((m) => m.status === 'online').length;
    return `
      <section class="module-group" data-group="${group.id}">
        <header class="module-group-head">
          <div>
            <h2>${group.title}</h2>
            <p>${group.hint}</p>
          </div>
          <span class="module-group-meta">${online}/${group.modules.length} 在线</span>
        </header>
        <div class="module-grid">${group.modules.map(renderModuleCard).join('')}</div>
      </section>`;
  }).join('');
  const online = MODULES.filter((m) => m.status === 'online').length;
  $('#nodeStatus').textContent = `${MODULES.length} modules · ${online} online`;
}

function renderSignals() {
  const lowProviders = providers.filter((p) => Number(p.balance) < Number(p.low_balance_threshold));
  const abnormalKeys = keys.filter((k) => k.status !== 'active');
  const signals = [
    ...lowProviders.map((p) => ({ level: 'high', title: `${p.name} 余额不足`, text: `当前余额 ${money(p.balance)}，低于阈值 ${money(p.low_balance_threshold)}。` })),
    ...abnormalKeys.map((k) => ({ level: k.status === 'warning' ? 'mid' : 'high', title: `${k.provider_name} Key 状态异常`, text: `${k.name} 当前状态：${k.status}。` })),
  ];
  $('#alertCount').textContent = signals.length;
  $('#signalFeed').innerHTML = signals.length
    ? signals.map((s) => `<div class="signal-item ${s.level}"><strong>${s.title}</strong><p>${s.text}</p></div>`).join('')
    : '<div class="empty-state">暂无真实预警</div>';
}

function buildUsageSeries(logs) {
  const hours = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`);
  const map = new Map(hours.map((hour) => [hour, 0]));
  logs.forEach((log) => {
    const date = new Date(log.bucket);
    const hour = `${String(date.getHours()).padStart(2, '0')}:00`;
    map.set(hour, Number(log.calls || 0));
  });
  return { labels: hours, values: hours.map((hour) => map.get(hour)) };
}

function initPulseChart() {
  const el = document.getElementById('pulseChart');
  if (!el || typeof echarts === 'undefined') return;
  pulseChart = echarts.init(el);
  renderPulseChart();
}

function initFitnessChart() {
  const el = document.getElementById('fitnessChart');
  if (!el || typeof echarts === 'undefined') return;
  fitnessChart = echarts.init(el);
  renderFitnessChart();
}

function renderPulseChart() {
  if (!pulseChart) return;
  const series = buildUsageSeries(usageSeries);
  pulseChart.setOption({
    tooltip,
    grid: { top: 18, right: 12, bottom: 28, left: 36 },
    xAxis: {
      type: 'category',
      data: series.labels,
      axisLabel: { ...axisStyle, interval: 3 },
      axisLine: { lineStyle: gridLine },
      axisTick: { show: false },
    },
    yAxis: { type: 'value', axisLabel: axisStyle, splitLine: { lineStyle: gridLine }, minInterval: 1 },
    series: [{
      type: 'line',
      smooth: true,
      symbol: 'none',
      data: series.values,
      lineStyle: { color: '#d4924a', width: 2 },
      areaStyle: { color: 'rgba(212,146,74,0.12)' },
    }],
  });
}

function renderFitnessChart() {
  if (!fitnessChart) return;
  const weightRows = fitnessSummary?.weight_trend || [];
  const dailyRows = fitnessSummary?.daily_records || [];
  const labels = Array.from(new Set([
    ...weightRows.map((row) => new Date(row.recorded_at).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }).slice(5)),
    ...dailyRows.map((row) => new Date(row.record_day).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }).slice(5)),
  ]));
  const weightMap = new Map(weightRows.map((row) => [new Date(row.recorded_at).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }).slice(5), Number(row.weight_kg)]));
  const calorieMap = new Map(dailyRows.map((row) => [new Date(row.record_day).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }).slice(5), Number(row.calories || 0)]));
  const workoutMap = new Map(dailyRows.map((row) => [new Date(row.record_day).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }).slice(5), Number(row.workout_min || 0)]));
  const sleepMap = new Map(dailyRows.map((row) => [new Date(row.record_day).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }).slice(5), Number(row.sleep_hours || 0)]));
  fitnessChart.setOption({
    tooltip,
    legend: { top: 0, right: 0, textStyle: axisStyle },
    grid: { top: 38, right: 10, bottom: 24, left: 32 },
    xAxis: { type: 'category', data: labels, axisLabel: axisStyle, axisLine: { lineStyle: gridLine }, axisTick: { show: false } },
    yAxis: [
      { type: 'value', scale: true, axisLabel: axisStyle, splitLine: { lineStyle: gridLine } },
      { type: 'value', axisLabel: axisStyle, splitLine: { show: false } },
    ],
    series: [
      { name: '体重kg', type: 'line', smooth: true, symbolSize: 5, data: labels.map((label) => weightMap.get(label) ?? null), lineStyle: { color: '#d4924a', width: 2 }, itemStyle: { color: '#d4924a' } },
      { name: '摄入kcal', type: 'bar', yAxisIndex: 1, data: labels.map((label) => calorieMap.get(label) || 0), itemStyle: { color: 'rgba(212,146,74,.28)' } },
      { name: '运动min', type: 'bar', yAxisIndex: 1, data: labels.map((label) => workoutMap.get(label) || 0), itemStyle: { color: 'rgba(61,154,106,.32)' } },
      { name: '睡眠h', type: 'line', yAxisIndex: 1, smooth: true, symbolSize: 4, data: labels.map((label) => sleepMap.get(label) || 0), lineStyle: { color: '#a8b0bc', width: 1.5 }, itemStyle: { color: '#a8b0bc' } },
    ],
  });
}

function renderBudgetList() {
  const target = $('#budgetList');
  if (!target) return;
  const rows = providers.map((p) => {
    const balance = Number(p.balance || 0);
    const threshold = Number(p.low_balance_threshold || 0);
    const pct = threshold > 0 ? Math.min(100, Math.round((balance / threshold) * 100)) : 0;
    return { name: p.name, balance, threshold, pct, low: threshold > 0 && balance < threshold };
  });
  target.innerHTML = rows.length
    ? rows.map((r) => `
      <div class="budget-row">
        <div><strong>${r.name}</strong><span>${money(r.balance)} / 阈值 ${money(r.threshold)}</span></div>
        <div class="bar"><i style="width:${r.pct}%" class="${r.low ? 'warn' : ''}"></i></div>
      </div>`).join('')
    : '<div class="empty-state">暂无真实厂商余额</div>';
}

function renderDataStream() {
  const target = $('#dataStream');
  if (!target) return;
  const rows = usageSeries.slice(0, 6);
  target.innerHTML = rows.length
    ? rows.map((row) => `<div class="stream-row"><span>${new Date(row.bucket).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}</span><strong>${row.calls} calls</strong><em>${money(row.cost)}</em></div>`).join('')
    : '<div class="empty-state">暂无真实调用日志</div>';
}

async function loadDashboard() {
  await api('/api/balances/refresh', { method: 'POST' }).catch(() => null);
  [stats, providers, keys, models, usageSeries, fitnessSummary, knowledgeSummary, cacheSummary, dashboardMemory] = await Promise.all([
    api('/api/stats'),
    api('/api/providers'),
    api('/api/keys'),
    api('/api/models'),
    api('/api/usage/hourly'),
    api('/api/fitness/summary'),
    api('/api/knowledge/summary'),
    api('/api/assistant/cache/summary').catch(() => null),
    api('/api/dashboard/memory').catch(() => null),
  ]);
  stats.knowledge_chunks = knowledgeSummary?.chunks || 0;
  stats.knowledge_queries = knowledgeSummary?.queries || 0;
  stats.cache_hits = dashboardMemory?.counts?.cache_hits || cacheSummary?.total_hits || 0;
  stats.pending_tasks = dashboardMemory?.counts?.tasks || 0;
  renderTelemetry();
  renderModules();
  renderSignals();
  renderMemoryDashboard();
  renderBudgetList();
  renderDataStream();
  renderPulseChart();
  renderFitnessChart();
}

initPulseChart();
initFitnessChart();
loadDashboard().catch((error) => {
  console.error(error);
  $('#signalFeed').innerHTML = `<div class="empty-state">加载真实数据失败：${error.message}</div>`;
});
window.addEventListener('resize', () => { pulseChart?.resize(); fitnessChart?.resize(); });
