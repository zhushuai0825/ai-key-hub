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
    hint: 'Key、知识库、漫剧',
    modules: [
      { id: 'aitoken', name: 'AIToken', desc: '厂商 API Key、真实余额、一键复制', icon: 'aitoken.svg', href: '/keys.html', status: 'online', metricKey: 'key_count', metricLabel: 'Key' },
      { id: 'knowledge', name: 'Knowledge', desc: '统一知识库检索与 AI 提问', icon: 'knowledge.svg', href: '/knowledge-ask.html', status: 'online', metricKey: 'knowledge_chunks', metricLabel: 'chunks' },
      { id: 'knowledge-manage', name: '知识库管理', desc: '上传文档、质量检测与重建向量', icon: 'knowledge.svg', href: '/knowledge.html', status: 'online' },
      { id: 'drama', name: '漫剧工作室', desc: '梗概分镜、角色卡、导出分镜提示词', icon: 'agent.svg', href: '/drama.html', status: 'online' },
    ],
  },
  {
    id: 'life',
    title: '生活助手',
    hint: '提醒任务',
    modules: [
      { id: 'tasks', name: '提醒', desc: '提醒任务、重复提醒、完成与暂停', icon: 'tasks.svg', href: '/tasks.html', status: 'online', metricKey: 'pending_tasks', metricLabel: 'tasks' },
    ],
  },
  {
    id: 'wecom',
    title: '企业微信',
    hint: '消息处理',
    modules: [
      { id: 'wecom', name: '企微处理台', desc: '识别错了可重处理、改分类、撤销', icon: 'tasks.svg', href: '/wechat-inbox.html', status: 'online', metricKey: 'wecom_pending', metricLabel: 'pending' },
    ],
  },
  {
    id: 'ops',
    title: '系统运维',
    hint: '健康状态与备份恢复',
    modules: [
      { id: 'monitor', name: '系统监控', desc: '数据库、Chroma、企微、OCR、网关健康', icon: 'monitor.svg', href: '/monitor.html', status: 'online' },
      { id: 'backup', name: '备份恢复', desc: '导出、本地备份与导入恢复', icon: 'audit.svg', href: '/backup.html', status: 'online' },
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
  return { knowledge: '知识库', wechat: '企微', task: '提醒' }[topic] || topic;
}

function wecomStatusLabel(status) {
  return { failed: '失败', processing: '处理中', recorded: '已记录', replied: '已回复', ignored: '忽略' }[status] || status || '未知';
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
    : '<div class="dash-row"><p>暂无命中缓存。重复问知识库问题后会出现在这里。</p></div>';
}

function renderWecomFeed() {
  const rows = dashboardMemory?.wecom || [];
  $('#wecomMeta').textContent = `${rows.length} 条`;
  $('#wecomFeed').innerHTML = rows.length
    ? rows.map((row) => `
      <div class="dash-row">
        <strong>${escapeHtml(row.content || '[非文本]')}<span class="dash-tag ${row.parse_status === 'failed' ? 'hit' : ''}">${escapeHtml(wecomStatusLabel(row.parse_status))}</span></strong>
        <p>${escapeHtml(row.intent || '未分类')} · ${escapeHtml((row.reply_text || '').slice(0, 80) || '暂无回复')}</p>
        <span class="dash-time">${formatDashTime(row.received_at)}</span>
      </div>`).join('')
    : '<div class="dash-row"><p>暂无待处理企微消息。失败或处理中的会显示在这里。</p></div>';
}

function renderKnowledgeFeed() {
  const rows = dashboardMemory?.knowledge || [];
  $('#knowledgeMeta').textContent = `${rows.length} 条`;
  $('#knowledgeFeed').innerHTML = rows.length
    ? rows.map((row) => {
      const isQuery = row.kind === 'query';
      return `
      <div class="dash-row">
        <strong>${escapeHtml(row.title)}<span class="dash-tag">${isQuery ? '提问' : '入库'}</span></strong>
        <p>${escapeHtml(row.preview || '')}</p>
        <span class="dash-time">${formatDashTime(row.time)}</span>
      </div>`;
    }).join('')
    : '<div class="dash-row"><p>暂无知识库动态。上传文档或提问后会出现在这里。</p></div>';
}

function isTaskDue(row) {
  if (!row.remind_at) return false;
  return new Date(row.remind_at).getTime() <= Date.now();
}

function renderTasksFeed() {
  const rows = dashboardMemory?.tasks || [];
  $('#tasksMeta').textContent = `${rows.length} 条`;
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
  renderTasksFeed();
  renderWecomFeed();
  renderKnowledgeFeed();
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
  return `${Math.round(Number(n || 0)).toLocaleString('zh-CN')} 分`;
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
  [stats, providers, keys, models, usageSeries, knowledgeSummary, cacheSummary, dashboardMemory] = await Promise.all([
    api('/api/stats'),
    api('/api/providers'),
    Promise.resolve([]),
    api('/api/models'),
    api('/api/usage/hourly'),
    api('/api/knowledge/summary'),
    api('/api/assistant/cache/summary').catch(() => null),
    api('/api/dashboard/memory').catch(() => null),
  ]);
  keys = [];
  stats.knowledge_chunks = knowledgeSummary?.chunks || 0;
  stats.knowledge_queries = knowledgeSummary?.queries || 0;
  stats.cache_hits = dashboardMemory?.counts?.cache_hits || cacheSummary?.total_hits || 0;
  stats.pending_tasks = dashboardMemory?.counts?.tasks || 0;
  stats.wecom_pending = dashboardMemory?.counts?.wecom_pending || 0;
  renderTelemetry();
  renderModules();
  renderMemoryDashboard();
  renderBudgetList();
  renderDataStream();
  renderPulseChart();
}

initPulseChart();
loadDashboard().catch((error) => {
  console.error(error);
});
setInterval(() => {
  if (document.hidden) return;
  loadDashboard().catch(() => null);
}, 60000);
window.addEventListener('resize', () => { pulseChart?.resize(); });
