const $ = (selector) => document.querySelector(selector);
let summary = null;
let entries = [];
let weightChart;

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!res.ok) throw new Error(await res.text() || '请求失败');
  return res.json();
}

function toast(message) {
  const box = $('#toast');
  box.textContent = message;
  box.classList.add('show');
  setTimeout(() => box.classList.remove('show'), 1800);
}

function updateClock() {
  $('#clock').textContent = new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}
setInterval(updateClock, 1000);
updateClock();

function money(value) { return `¥${Number(value || 0).toFixed(2)}`; }
function numberText(value, unit = '') { return value === null || value === undefined ? '--' : `${Number(value).toFixed(unit === 'kg' ? 1 : 0)}${unit}`; }
function timeText(value) { return new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }); }
function shanghaiDatetimeLocal(date = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date).reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function entryTitle(entry) {
  if (entry.entry_type === 'weight') return `体重 ${numberText(entry.weight_kg, 'kg')}`;
  if (entry.entry_type === 'meal') return `${entry.meal_type || '饮食'} · ${entry.food_text || '未填写食物'}`;
  if (entry.entry_type === 'sleep') return `睡眠 ${numberText(entry.sleep_hours, 'h')} · ${entry.sleep_quality || '--'}`;
  return `${entry.workout_type || '运动'} · ${entry.duration_min || 0}min`;
}

function entryBody(entry) {
  if (entry.entry_type === 'weight') return entry.note || '记录体重变化。';
  if (entry.entry_type === 'meal') return [`热量 ${numberText(entry.calories, 'kcal')}`, `蛋白 ${numberText(entry.protein_g, 'g')}`, `碳水 ${numberText(entry.carbs_g, 'g')}`, `脂肪 ${numberText(entry.fat_g, 'g')}`].join(' · ');
  if (entry.entry_type === 'sleep') return `睡眠质量 ${entry.sleep_quality || '--'} · ${entry.note || '记录睡眠恢复情况。'}`;
  return `${entry.workout_text || '未填写运动内容'} · 强度 ${entry.intensity || '--'} · 消耗 ${numberText(entry.burned_calories, 'kcal')}`;
}

function setType(type) {
  $('#entryForm').entry_type.value = type;
  document.querySelectorAll('.type-tabs button').forEach((button) => button.classList.toggle('active', button.dataset.type === type));
  document.querySelectorAll('.fields').forEach((el) => el.classList.add('hidden'));
  document.querySelector(`.fields-${type}`).classList.remove('hidden');
}

function renderSummary() {
  const latestWeight = summary?.latest_weight?.weight_kg;
  const profile = summary?.profile || { height_cm: 177, bmi: null };
  const meals = summary?.today_meals || { count: 0, calories: 0 };
  const workout = summary?.today_workout || { count: 0, duration_min: 0, burned_calories: 0 };
  $('#fitSummary').innerHTML = [
    ['当前体重', latestWeight ? `${Number(latestWeight).toFixed(1)}kg` : '--'],
    ['身高 / BMI', `${profile.height_cm}cm / ${profile.bmi || '--'}`],
    ['今日饮食', `${meals.count || 0} 条`],
    ['今日运动', `${workout.duration_min || 0}min`],
  ].map(([label, value]) => `<div class="fit-stat"><span>${label}</span><strong>${value}</strong></div>`).join('');
}

function renderAdvice() {
  const advice = summary?.latest_advice;
  $('#latestAdvice').innerHTML = advice
    ? `<strong>${advice.summary}</strong><p>${advice.advice}</p>`
    : '<div class="empty-state">暂无 AI 建议，提交第一条记录后生成。</div>';
}

function renderEntries() {
  $('#entryList').innerHTML = entries.length
    ? entries.map((entry) => `
      <article class="entry-card">
        <header><strong>${entryTitle(entry)}</strong><div><time>${timeText(entry.recorded_at)}</time><button class="delete-entry" data-delete="${entry.id}" type="button">删除</button></div></header>
        <p>${entryBody(entry)}</p>
        ${entry.ai_summary ? `<div class="ai"><strong>${entry.ai_summary}</strong><p>${entry.ai_advice || ''}</p></div>` : ''}
      </article>`).join('')
    : '<div class="empty-state">暂无记录。</div>';
  document.querySelectorAll('[data-delete]').forEach((button) => { button.onclick = () => deleteEntry(Number(button.dataset.delete)); });
}

function renderChart() {
  const el = document.getElementById('weightChart');
  if (!el || typeof echarts === 'undefined') return;
  if (!weightChart) weightChart = echarts.init(el);
  const rows = summary?.weight_trend || [];
  weightChart.setOption({
    tooltip: { trigger: 'axis' },
    grid: { top: 24, right: 16, bottom: 28, left: 38 },
    xAxis: { type: 'category', data: rows.map((row) => new Date(row.recorded_at).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }).slice(5)), axisLabel: { color: '#6b7280' }, axisLine: { lineStyle: { color: 'rgba(255,255,255,.08)' } } },
    yAxis: { type: 'value', scale: true, axisLabel: { color: '#6b7280' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } } },
    series: [{ type: 'line', smooth: true, symbolSize: 6, data: rows.map((row) => Number(row.weight_kg)), lineStyle: { color: '#d4924a', width: 2 }, itemStyle: { color: '#d4924a' }, areaStyle: { color: 'rgba(212,146,74,.12)' } }],
  });
}

async function loadAll() {
  [summary, entries] = await Promise.all([api('/api/fitness/summary'), api('/api/fitness/entries')]);
  renderSummary();
  renderAdvice();
  renderEntries();
  renderChart();
}

async function saveEntry(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  Object.keys(payload).forEach((key) => { if (payload[key] === '') delete payload[key]; });
  await api('/api/fitness/entries', { method: 'POST', body: JSON.stringify(payload) });
  form.reset();
  form.recorded_at.value = shanghaiDatetimeLocal();
  setType(payload.entry_type || 'weight');
  toast('已保存并生成建议');
  await loadAll();
}

async function deleteEntry(id) {
  if (!confirm('删除这条记录？')) return;
  await api(`/api/fitness/entries/${id}`, { method: 'DELETE' });
  toast('记录已删除');
  await loadAll();
}

$('#entryForm').recorded_at.value = shanghaiDatetimeLocal();
document.querySelectorAll('.type-tabs button').forEach((button) => { button.onclick = () => setType(button.dataset.type); });
$('#entryForm').onsubmit = saveEntry;
$('#refreshBtn').onclick = () => loadAll().then(() => toast('已刷新')).catch((error) => toast(error.message));
window.addEventListener('resize', () => weightChart?.resize());
loadAll().catch((error) => toast(error.message));
