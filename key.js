const $ = (s) => document.querySelector(s);
const money = (v) => `¥${Number(v || 0).toFixed(2)}`;

let providers = [];
let keys = [];
let models = [];
let selectedProvider = '';
let selectedStatus = '';
let searchQuery = '';

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!res.ok) throw new Error(await res.text() || '请求失败');
  return res.json();
}

function toast(msg) {
  const box = $('#toast');
  box.textContent = msg;
  box.classList.add('show');
  setTimeout(() => box.classList.remove('show'), 1800);
}

function statusText(s) {
  return { active: '启用', warning: '关注', disabled: '停用' }[s] || s;
}

function statusClass(s) {
  return { active: 'ok', warning: 'warn', disabled: 'bad' }[s] || '';
}

function updateClock() {
  $('#clock').textContent = new Date().toLocaleString('zh-CN', { hour12: false });
}
setInterval(updateClock, 1000);
updateClock();

async function loadAll() {
  [providers, keys, models] = await Promise.all([
    api('/api/providers'),
    api('/api/keys'),
    api('/api/models'),
  ]);
  renderProviderFilter();
  renderStats(await api('/api/stats'));
  renderProviderCards();
  renderKeys();
  renderAlerts();
}

function renderStats(stats) {
  const active = keys.filter((k) => k.status === 'active').length;
  const cards = [
    ['厂商', providers.length],
    ['Key', stats.key_count || keys.length],
    ['可用', active],
    ['余额', money(stats.total_balance)],
    ['今日调用', Number(stats.today_calls || 0).toLocaleString('zh-CN')],
    ['模型', models.length],
  ];
  $('#stats').innerHTML = cards.map(([label, val]) =>
    `<div class="stat"><span>${label}</span><strong>${val}</strong></div>`
  ).join('');
}

function renderProviderFilter() {
  $('#providerFilter').innerHTML = `<option value="">全部厂商</option>` +
    providers.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
  $('#providerFilter').value = selectedProvider;
}

function renderProviderCards() {
  $('#providerCards').innerHTML = providers.map((p) => {
    const cnt = keys.filter((k) => Number(k.provider_id) === Number(p.id)).length;
    const low = Number(p.balance) < Number(p.low_balance_threshold);
    const on = Number(selectedProvider) === Number(p.id);
    return `
      <div class="provider-row ${on ? 'active' : ''}" data-id="${p.id}">
        <div><strong>${p.name}</strong><div class="sub">${cnt} 个 Key</div></div>
        <span class="bal ${low ? 'bad' : 'ok'}">${money(p.balance)}</span>
      </div>`;
  }).join('');

  document.querySelectorAll('.provider-row').forEach((el) => {
    el.onclick = () => {
      const id = el.dataset.id;
      selectedProvider = selectedProvider === id ? '' : id;
      $('#providerFilter').value = selectedProvider;
      renderProviderCards();
      renderKeys();
    };
  });
}

function providerModels(pid) {
  return models.filter((m) => Number(m.provider_id) === Number(pid));
}

function modelInline(pid) {
  const list = providerModels(pid);
  if (!list.length) return '';
  return `<div class="model-inline">${list.slice(0, 3).map((m) => `<span>${m.name}</span>`).join('')}${list.length > 3 ? `<span>+${list.length - 3}</span>` : ''}</div>`;
}

function filterKeys() {
  return keys.filter((k) => {
    if (selectedProvider && Number(k.provider_id) !== Number(selectedProvider)) return false;
    if (selectedStatus && k.status !== selectedStatus) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      if (!`${k.name} ${k.provider_name}`.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

function renderKeys() {
  const list = filterKeys();
  if (!list.length) {
    $('#keys').innerHTML = '<div class="empty">没有匹配的 Key</div>';
    return;
  }

  $('#keys').innerHTML = `
    <table class="key-table">
      <thead>
        <tr>
          <th>名称</th>
          <th>Key</th>
          <th>余额</th>
          <th>预算 / 已用</th>
          <th>状态</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${list.map((k) => {
          const bal = Number(k.provider_balance || 0);
          const thr = Number(k.low_balance_threshold || 0);
          const balCls = bal < thr ? 'bad' : 'ok';
          return `
            <tr>
              <td>
                <div class="name">${k.name}</div>
                <div class="sub">${k.provider_name}</div>
                ${modelInline(k.provider_id)}
              </td>
              <td><code>${k.api_key}</code></td>
              <td><span class="num ${balCls}">${money(bal)}</span></td>
              <td>
                <span class="num">${money(k.monthly_quota)}</span>
                <div class="sub">已用 ${money(k.used_amount)}</div>
              </td>
              <td><span class="badge ${statusClass(k.status)}">${statusText(k.status)}</span></td>
              <td>
                <div class="row-btns">
                  <button type="button" data-copy="${k.id}">复制</button>
                  <button type="button" class="danger" data-delete="${k.id}">删</button>
                </div>
              </td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;

  document.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = () => copyKey(b.dataset.copy); });
  document.querySelectorAll('[data-delete]').forEach((b) => { b.onclick = () => deleteKey(Number(b.dataset.delete)); });
}

function renderAlerts() {
  const low = providers.filter((p) => Number(p.balance) < Number(p.low_balance_threshold));
  const bad = keys.filter((k) => k.status !== 'active');
  const items = [
    ...low.map((p) => ({ t: '余额不足', p: `${p.name} 剩 ${money(p.balance)}`, lv: 'bad' })),
    ...bad.map((k) => ({ t: 'Key 异常', p: `${k.provider_name} / ${k.name} — ${statusText(k.status)}`, lv: k.status === 'warning' ? 'warn' : 'bad' })),
  ];
  $('#alerts').innerHTML = items.length
    ? items.map((i) => `<div class="feed-item ${i.lv}"><strong>${i.t}</strong><p>${i.p}</p></div>`).join('')
    : '<div class="feed-item"><strong>正常</strong><p>余额与 Key 状态无异常</p></div>';
}

async function copyKey(id) {
  const key = keys.find((k) => Number(k.id) === Number(id));
  const model = providerModels(key?.provider_id)[0]?.name || '';
  const data = await api(`/api/keys/${id}/copy?mode=key&model=${encodeURIComponent(model)}`);
  await navigator.clipboard.writeText(data.content);
  toast('已复制');
}

async function deleteKey(id) {
  if (!confirm('删除这个 Key？')) return;
  await api(`/api/keys/${id}`, { method: 'DELETE' });
  toast('已删除');
  await loadAll();
}

$('#providerFilter').onchange = () => { selectedProvider = $('#providerFilter').value; renderProviderCards(); renderKeys(); };
$('#statusFilter').onchange = () => { selectedStatus = $('#statusFilter').value; renderKeys(); };
$('#searchInput').oninput = (e) => { searchQuery = e.target.value.trim(); renderKeys(); };
$('#refreshBtn').onclick = () => loadAll().then(() => toast('已刷新')).catch((e) => toast(e.message));

loadAll().catch((e) => toast(e.message));
