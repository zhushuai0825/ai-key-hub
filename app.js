const $ = (s) => document.querySelector(s);

const axisStyle = { color: '#6b7280', fontSize: 10, fontFamily: 'IBM Plex Mono, Menlo, monospace' };
const gridLine = { color: 'rgba(255,255,255,0.05)' };
const tooltip = {
  backgroundColor: '#14171c',
  borderColor: 'rgba(255,255,255,0.12)',
  borderWidth: 1,
  textStyle: { color: '#e8eaed', fontSize: 11 },
};

const MODULES = [
  {
    id: 'aitoken',
    name: 'AIToken',
    desc: '厂商 API Key、真实余额、一键复制',
    icon: 'aitoken.svg',
    href: '/keys.html',
    status: 'online',
    hero: true,
    metricKey: 'key_count',
    metricLabel: 'Key',
  },
  { id: 'gateway', name: 'Gateway', desc: '统一模型路由、限流与故障切换', icon: 'gateway.svg', status: 'planned' },
  { id: 'agent', name: 'Agent Hub', desc: '多 Agent 编排与工具链调度', icon: 'agent.svg', status: 'planned' },
  { id: 'knowledge', name: 'Knowledge', desc: 'RAG 知识库索引与检索', icon: 'knowledge.svg', status: 'planned' },
  { id: 'tasks', name: 'Task Forge', desc: '定时任务、巡检与自动化流水线', icon: 'tasks.svg', status: 'planned' },
  { id: 'monitor', name: 'Monitor', desc: '延迟、错误率与链路追踪', icon: 'monitor.svg', status: 'planned', wide: true },
  { id: 'cost', name: 'Cost Lens', desc: '费用归因、预算预警与报表', icon: 'cost.svg', status: 'planned' },
  { id: 'audit', name: 'Audit Log', desc: '操作审计与合规留痕', icon: 'audit.svg', status: 'planned' },
];

let stats = { count: 0, key_count: 0, total_balance: 0, abnormal_keys: 0, today_calls: 0, today_cost: 0, avg_latency: 0 };
let providers = [];
let keys = [];
let models = [];
let usageSeries = [];
let pulseChart;

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!res.ok) throw new Error(await res.text() || '请求失败');
  return res.json();
}

function updateClock() {
  const el = $('#clock');
  if (!el) return;
  el.textContent = new Date().toLocaleString('zh-CN', { hour12: false });
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
  const classes = ['module-card', m.hero ? 'hero' : '', m.wide ? 'wide' : '', isOnline ? 'online' : 'locked'].filter(Boolean).join(' ');
  return `
    <${Tag} class="${classes}" ${isOnline ? `href="${m.href}"` : ''} ${!isOnline ? 'aria-disabled="true"' : ''}>
      <div class="module-top">
        <img class="module-icon" src="./assets/icons/${m.icon}" alt="" width="48" height="48" />
        <span class="module-status ${m.status}">${isOnline ? '在线' : '未接入'}</span>
      </div>
      <div class="module-name">${m.name}</div>
      <p class="module-desc">${m.desc}</p>
      ${metric}
      <div class="module-enter">${isOnline ? '进入模块' : '暂无真实数据'}</div>
    </${Tag}>`;
}

function renderModules() {
  $('#moduleGrid').innerHTML = MODULES.map(renderModuleCard).join('');
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

function renderPulseChart() {
  if (!pulseChart) return;
  const series = buildUsageSeries(usageSeries);
  pulseChart.setOption({
    tooltip,
    grid: { top: 18, right: 10, bottom: 24, left: 28 },
    xAxis: { type: 'category', data: series.labels, axisLabel: axisStyle, axisLine: { lineStyle: gridLine }, axisTick: { show: false } },
    yAxis: { type: 'value', axisLabel: axisStyle, splitLine: { lineStyle: gridLine } },
    series: [{ type: 'line', smooth: true, symbol: 'none', data: series.values, lineStyle: { color: '#f4f5f6', width: 2 }, areaStyle: { color: 'rgba(255,255,255,0.06)' } }],
  });
}

function renderBudgetList() {
  const rows = providers.map((p) => {
    const balance = Number(p.balance || 0);
    const threshold = Number(p.low_balance_threshold || 0);
    const pct = threshold > 0 ? Math.min(100, Math.round((balance / threshold) * 100)) : 0;
    return { name: p.name, balance, threshold, pct, low: threshold > 0 && balance < threshold };
  });
  $('#budgetList').innerHTML = rows.length
    ? rows.map((r) => `
      <div class="budget-row">
        <div><strong>${r.name}</strong><span>${money(r.balance)} / 阈值 ${money(r.threshold)}</span></div>
        <div class="bar"><i style="width:${r.pct}%" class="${r.low ? 'warn' : ''}"></i></div>
      </div>`).join('')
    : '<div class="empty-state">暂无真实厂商余额</div>';
}

function renderDataStream() {
  const rows = usageSeries.slice(0, 6);
  $('#dataStream').innerHTML = rows.length
    ? rows.map((row) => `<div class="stream-row"><span>${new Date(row.bucket).toLocaleTimeString('zh-CN', { hour12: false })}</span><strong>${row.calls} calls</strong><em>${money(row.cost)}</em></div>`).join('')
    : '<div class="empty-state">暂无真实调用日志</div>';
}

async function loadDashboard() {
  await api('/api/balances/refresh', { method: 'POST' }).catch(() => null);
  [stats, providers, keys, models, usageSeries] = await Promise.all([
    api('/api/stats'),
    api('/api/providers'),
    api('/api/keys'),
    api('/api/models'),
    api('/api/usage/hourly'),
  ]);
  renderTelemetry();
  renderModules();
  renderSignals();
  renderBudgetList();
  renderDataStream();
  renderPulseChart();
}

initPulseChart();
loadDashboard().catch((error) => {
  console.error(error);
  $('#signalFeed').innerHTML = `<div class="empty-state">加载真实数据失败：${error.message}</div>`;
});
window.addEventListener('resize', () => pulseChart?.resize());
