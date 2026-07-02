const colors = ['#111111', '#5f5f5f', '#9a9a9a', '#cfcfcf', '#e6e6e2'];
const chartText = { color: '#6f6f6f' };
const gridLine = { color: '#dededb' };

function $(selector) { return document.querySelector(selector); }
function chart(id) { return echarts.init(document.getElementById(id)); }

function updateClock() {
  $('#clock').textContent = new Date().toLocaleString('zh-CN', { hour12: false });
}
setInterval(updateClock, 1000);
updateClock();

function animateCounters() {
  document.querySelectorAll('[data-count]').forEach((el) => {
    const target = Number(el.dataset.count);
    const duration = 900;
    const start = performance.now();
    function tick(now) {
      const progress = Math.min((now - start) / duration, 1);
      const value = Math.floor(target * (1 - Math.pow(1 - progress, 3)));
      el.textContent = value.toLocaleString('zh-CN');
      if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
}

function initCharts() {
  const resourceChart = chart('resourceChart');
  resourceChart.setOption({
    color: colors,
    tooltip: { trigger: 'item' },
    series: [{
      type: 'pie',
      radius: ['50%', '72%'],
      center: ['50%', '50%'],
      label: { color: '#111', formatter: '{b}\n{d}%' },
      itemStyle: { borderColor: '#fff', borderWidth: 3 },
      data: [
        { name: '模型 Key', value: 26 },
        { name: 'Agent 应用', value: 28 },
        { name: '知识库', value: 23 },
        { name: '自动化任务', value: 15 },
        { name: '监控告警', value: 8 },
      ],
    }],
  });

  const callTrend = chart('callTrend');
  callTrend.setOption({
    color: ['#111111', '#777777', '#b8b8b8'],
    grid: { left: 48, right: 20, top: 28, bottom: 32 },
    tooltip: { trigger: 'axis' },
    legend: { top: 0, right: 12, textStyle: chartText },
    xAxis: {
      type: 'category',
      data: ['06-26', '06-27', '06-28', '06-29', '06-30', '07-01', '07-02'],
      axisLabel: chartText,
      axisLine: { lineStyle: gridLine },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      axisLabel: chartText,
      splitLine: { lineStyle: gridLine },
    },
    series: [
      { name: 'DeepSeek', type: 'line', smooth: true, data: [42, 48, 55, 61, 73, 82, 91], lineStyle: { width: 3 }, symbolSize: 6 },
      { name: '千问', type: 'line', smooth: true, data: [31, 36, 43, 49, 52, 58, 67], lineStyle: { width: 2 }, symbolSize: 5 },
      { name: '豆包', type: 'line', smooth: true, data: [24, 29, 34, 33, 41, 46, 52], lineStyle: { width: 2 }, symbolSize: 5 },
    ],
  });

  const spendChart = chart('spendChart');
  spendChart.setOption({
    color: ['#111111', '#d8d8d4'],
    grid: { left: 48, right: 20, top: 26, bottom: 32 },
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'category',
      data: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
      axisLabel: chartText,
      axisLine: { lineStyle: gridLine },
      axisTick: { show: false },
    },
    yAxis: { type: 'value', axisLabel: chartText, splitLine: { lineStyle: gridLine } },
    series: [
      { name: '实际费用', type: 'bar', data: [812, 936, 1180, 1265, 1542, 1320, 1681], barWidth: 18, itemStyle: { color: '#111' } },
      { name: '预算线', type: 'line', data: [1200, 1200, 1200, 1200, 1200, 1200, 1200], symbol: 'none', lineStyle: { type: 'dashed', width: 2, color: '#777' } },
    ],
  });

  window.addEventListener('resize', () => [resourceChart, callTrend, spendChart].forEach((item) => item.resize()));
}

function renderLists() {
  const legend = [
    ['模型 Key', '#111111', '26%'],
    ['Agent 应用', '#5f5f5f', '28%'],
    ['知识库', '#9a9a9a', '23%'],
    ['自动化任务', '#cfcfcf', '15%'],
    ['监控告警', '#e6e6e2', '8%'],
  ];
  $('#resourceLegend').innerHTML = legend.map(([name, color, value]) => `<li><span><i style="background:${color}"></i>${name}</span><b>${value}</b></li>`).join('');

  const modules = [
    ['模型 Key 管理', '资产/密钥', '运行中', '/keys.html'],
    ['模型网关', '路由/限流', '规划中', '#'],
    ['Agent 任务中心', '自动化', '规划中', '#'],
    ['向量知识库', 'RAG 检索', '规划中', '#'],
    ['API 费用监控', '成本/告警', '规划中', '#'],
  ];
  $('#moduleTable').innerHTML = modules.map(([name, type, status, href]) => `<tr><td>${name}</td><td>${type}</td><td><span class="badge ${status === '运行中' ? '' : 'warn'}">${status}</span></td><td><a href="${href}">${href === '#' ? '待接入' : '进入'}</a></td></tr>`).join('');

  const alerts = [
    ['high', '今日 API 费用超预算', '今日模型调用费用 ¥8,736，已超过日预算线 18%。', '建议切换部分任务到经济模型。'],
    ['mid', 'DeepSeek 调用量异常升高', '过去 2 小时调用量较昨日同期增加 42%。', '建议检查是否存在循环任务或重复请求。'],
    ['high', '智谱 Key 余额不足', '剩余余额低于 ¥50，预计 1.5 天内耗尽。', '建议补充余额或临时关闭高频任务。'],
    ['mid', '豆包平均响应变慢', 'P95 响应时间升至 2.8s，影响部分批处理任务。', '建议开启备用模型路由。'],
  ];
  $('#alerts').innerHTML = alerts.map(([level, title, text, action]) => `<div class="alert-item ${level}"><strong>${title}</strong><p>${text}</p><span>${action}</span></div>`).join('');

  const tasks = [
    ['API 费用日报', '生成中', '94%'],
    ['Key 余额巡检', '已完成', '100%'],
    ['异常调用分析', '排队中', '32%'],
    ['知识库同步', '运行中', '71%'],
  ];
  $('#tasks').innerHTML = tasks.map(([name, status, progress]) => `<div class="task-item"><div><strong>${name}</strong><p>${status}</p></div><span>${progress}</span></div>`).join('');
}

animateCounters();
renderLists();
initCharts();
