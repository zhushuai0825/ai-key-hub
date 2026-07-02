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
    desc: '厂商 API Key、余额巡检、模型目录与一键复制',
    icon: 'aitoken.svg',
    href: '/keys.html',
    status: 'online',
    hero: true,
    metricKey: 'key_count',
    metricLabel: '活跃 Key',
  },
  {
    id: 'gateway',
    name: 'Gateway',
    desc: '统一模型路由、限流与故障切换',
    icon: 'gateway.svg',
    status: 'planned',
  },
  {
    id: 'agent',
    name: 'Agent Hub',
    desc: '多 Agent 编排与工具链调度',
    icon: 'agent.svg',
    status: 'planned',
  },
  {
    id: 'knowledge',
    name: 'Knowledge',
    desc: 'RAG 知识库索引与检索',
    icon: 'knowledge.svg',
    status: 'planned',
  },
  {
    id: 'tasks',
    name: 'Task Forge',
    desc: '定时任务、巡检与自动化流水线',
    icon: 'tasks.svg',
    status: 'planned',
  },
  {
    id: 'monitor',
    name: 'Monitor',
    desc: '延迟、错误率与链路追踪',
    icon: 'monitor.svg',
    status: 'planned',
    wide: true,
  },
  {
    id: 'cost',
    name: 'Cost Lens',
    desc: '费用归因、预算预警与报表',
    icon: 'cost.svg',
    status: 'planned',
  },
  {
    id: 'audit',
    name: 'Audit Log',
    desc: '操作审计与合规留痕',
    icon: 'audit.svg',
    status: 'planned',
  },
];

const SIGNALS = [
  { level: 'high', title: '费用超预算', text: '今日支出超日预算 18%，建议切换经济模型。' },
  { level: 'mid', title: 'DeepSeek 调用升高', text: '2 小时内同比 +42%，检查循环任务。' },
  { level: 'high', title: '智谱余额不足', text: '余额低于 ¥50，约 1.5 天耗尽。' },
  { level: 'mid', title: '豆包响应变慢', text: 'P95 升至 2.8s，考虑备用路由。' },
];

let stats = {
  count: 0,
  key_count: 0,
  total_balance: 0,
  abnormal_keys: 0,
  today_calls: 0,
  today_cost: 0,
  avg_latency: 0,
};

function updateClock() {
  const el = $('#clock');
  if (!el) return;
  el.textContent = new Date().toLocaleString('zh-CN', { hour12: false });
}
setInterval(updateClock, 1000);
updateClock();

function fmtNum(n, digits = 0) {
  return Number(n).toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function renderTelemetry() {
  const items = [
    ['厂商', stats.count, ''],
    ['Key 总数', stats.key_count, stats.abnormal_keys ? `${stats.abnormal_keys} 异常` : '全部正常', stats.abnormal_keys ? 'warn' : 'ok'],
    ['今日调用', stats.today_calls, '次'],
    ['今日费用', `¥${fmtNum(stats.today_cost, 2)}`, stats.today_cost > 5000 ? '接近预算' : ''],
    ['平均延迟', `${stats.avg_latency}ms`, ''],
  ];

  $('#telemetry').innerHTML = items.map(([label, value, sub, cls]) => `
    <div class="tel-item">
      <span>${label}</span>
      <strong>${value}</strong>
      ${sub ? `<em class="${cls || ''}">${sub}</em>` : ''}
    </div>
  `).join('');
}

function renderModuleCard(m) {
  const isOnline = m.status === 'online';
  const Tag = isOnline ? 'a' : 'div';
  const metric = m.metricKey && stats[m.metricKey] != null
    ? `<div class="module-metric"><strong>${fmtNum(stats[m.metricKey])}</strong><span>${m.metricLabel || ''}</span></div>`
    : '';

  const classes = [
    'module-card',
    m.hero ? 'hero' : '',
    m.wide ? 'wide' : '',
    isOnline ? 'online' : 'locked',
  ].filter(Boolean).join(' ');

  return `
    <${Tag}
      class="${classes}"
      ${isOnline ? `href="${m.href}"` : ''}
      ${!isOnline ? 'aria-disabled="true"' : ''}
    >
      <div class="module-top">
        <img class="module-icon" src="./assets/icons/${m.icon}" alt="" width="48" height="48" />
        <span class="module-status ${m.status}">${isOnline ? '在线' : '规划中'}</span>
      </div>
      <div class="module-name">${m.name}</div>
      <p class="module-desc">${m.desc}</p>
      ${metric}
      <div class="module-enter">${isOnline ? '进入模块' : '即将开放'}</div>
    </${Tag}>
  `;
}

function renderModules() {
  $('#moduleGrid').innerHTML = MODULES.map(renderModuleCard).join('');
  const online = MODULES.filter((m) => m.status === 'online').length;
  $('#nodeStatus').textContent = `${MODULES.length} modules · ${online} online`;
}

function renderSignals() {
  $('#alertCount').textContent = SIGNALS.length;
  $('#signalFeed').innerHTML = SIGNALS.map((s) => `
    <div class="signal-item ${s.level}">
      <strong>${s.title}</strong>
      <p>${s.text}</p>
    </div>
  `).join('');
}

function initPulseChart() {
  const el = document.getElementById('pulseChart');
  if (!el || typeof echarts === 'undefined') return;

  const chart = echarts.init(el);
  const hours = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
  const data = [12, 18, 15, 22, 28, 35, 42, 58, 72, 68, 55, 48, 52, 61, 74, 82, 78, 65, 52, 44, 38, 30, 22, 16];

  chart.setOption({
    color: ['#d4924a'],
    grid: { left: 36, right: 8, top: 12, bottom: 22 },
    tooltip: { trigger: 'axis', ...tooltip },
    xAxis: {
      type: 'category',
      data: hours.filter((_, i) => i % 4 === 0),
      axisLabel: { ...axisStyle, interval: 0 },
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.1)' } },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      axisLabel: axisStyle,
      splitLine: { lineStyle: gridLine },
    },
    series: [{
      type: 'line',
      data: data.filter((_, i) => i % 4 === 0),
      smooth: false,
      symbol: 'none',
      lineStyle: { width: 1.5 },
      areaStyle: {
        color: {
          type: 'linear',
          x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: 'rgba(212, 146, 74, 0.25)' },
            { offset: 1, color: 'rgba(212, 146, 74, 0)' },
          ],
        },
      },
    }],
  });

  window.addEventListener('resize', () => chart.resize());
}

async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    if (res.ok) stats = await res.json();
  } catch {
    // demo fallback
    stats = {
      count: 4,
      key_count: 6,
      total_balance: 1280,
      abnormal_keys: 1,
      today_calls: 4286,
      today_cost: 873.6,
      avg_latency: 420,
    };
  }
  renderTelemetry();
  renderModules();
}

renderSignals();
initPulseChart();
loadStats();
