const $ = (selector) => document.querySelector(selector);
let memory = null;
let cacheRows = [];

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
  return { fitness: '健康', finance: '账本', knowledge: '知识库' }[topic] || topic;
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
    <div class="cache-stat-card"><strong>${s.useful_cache || 0}</strong><span>有价值问答</span></div>`;
  $('#memoryUpdatedAt').textContent = `更新于 ${formatTime(new Date().toISOString())}`;
}

function renderFitness() {
  const rows = memory?.fitness || [];
  $('#fitnessCount').textContent = `${rows.length} 条`;
  $('#fitnessList').innerHTML = rows.length ? rows.map((row) => `
    <article class="history-card">
      <strong>${escapeHtml(fitnessTitle(row))}</strong>
      <p>${escapeHtml(fitnessDetail(row))}</p>
      <div class="meta">${formatTime(row.recorded_at)}</div>
    </article>`).join('') : '<div class="empty-state">还没有健康记录。在企业微信发：体重 72.5、跑步 30 分钟、睡了 7 小时。</div>';
}

function renderFinance() {
  const rows = memory?.finance || [];
  $('#financeCount').textContent = `${rows.length} 条`;
  $('#financeList').innerHTML = rows.length ? rows.map((row) => `
    <article class="history-card">
      <strong>${escapeHtml(financeTitle(row))}</strong>
      <p>${escapeHtml(row.category || '未分类')}${row.note ? ` · ${escapeHtml(row.note)}` : ''}</p>
      <div class="meta">${formatTime(row.occurred_at)}</div>
    </article>`).join('') : '<div class="empty-state">还没有账本记录。在企业微信发：买咖啡 18、收入工资 5000。</div>';
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

async function loadCacheRows() {
  const form = new FormData($('#filterForm'));
  const params = new URLSearchParams();
  if (form.get('topic')) params.set('topic', form.get('topic'));
  if (form.get('q')) params.set('q', form.get('q'));
  cacheRows = await api(`/api/assistant/cache?${params.toString()}`);
}

async function loadAll() {
  memory = await api('/api/assistant/memory');
  const form = new FormData($('#filterForm'));
  const topic = form.get('topic');
  const q = form.get('q');
  if (!topic && !q) {
    cacheRows = memory.useful_cache || [];
  } else {
    await loadCacheRows();
  }
  renderSummary();
  renderFitness();
  renderFinance();
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

loadAll().catch((error) => toast(error.message));
