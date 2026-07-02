const $ = (selector) => document.querySelector(selector);
const money = (value) => `¥${Number(value || 0).toFixed(2)}`;
let providers = [];
let keys = [];
let models = [];
let selectedProvider = '';

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || '请求失败');
  }
  return response.json();
}

function toast(message) {
  const box = $('#toast');
  box.textContent = message;
  box.classList.add('show');
  setTimeout(() => box.classList.remove('show'), 1800);
}

function statusText(status) {
  return { active: '启用', warning: '关注', disabled: '停用' }[status] || status;
}

function statusClass(status) {
  return { active: 'ok', warning: 'warn', disabled: 'bad' }[status] || '';
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
  renderKeys();
  renderAlerts();
}

function renderStats(stats) {
  const activeKeys = keys.filter((item) => item.status === 'active').length;
  const cards = [
    ['厂商数量', providers.length, '个'],
    ['Key 总数', stats.key_count || keys.length, '个'],
    ['可用 Key', activeKeys, '个'],
    ['总余额', money(stats.total_balance), ''],
    ['今日调用', Number(stats.today_calls || 0).toLocaleString('zh-CN'), '次'],
    ['模型数量', models.length, '个'],
  ];
  $('#stats').innerHTML = cards.map(([label, value, unit]) => `
    <div class="stat-item">
      <span>${label}</span>
      <strong>${value}</strong>
      ${unit ? `<em>${unit}</em>` : ''}
    </div>
  `).join('');
}

function renderProviderFilter() {
  const options = providers.map((provider) => `<option value="${provider.id}">${provider.name}</option>`).join('');
  $('#providerFilter').innerHTML = `<option value="">全部厂商</option>${options}`;
  $('#providerFilter').value = selectedProvider;
}

function providerModels(providerId) {
  return models.filter((model) => Number(model.provider_id) === Number(providerId));
}

function modelSummary(providerId) {
  const list = providerModels(providerId);
  if (!list.length) return '<span class="muted">暂无模型数据</span>';
  return list.slice(0, 5).map((model) => `<span class="model-pill">${model.name}</span>`).join('') + (list.length > 5 ? `<span class="model-more">+${list.length - 5}</span>` : '');
}

function providerBalance(key) {
  const balance = Number(key.provider_balance || 0);
  const threshold = Number(key.low_balance_threshold || 0);
  const className = balance < threshold ? 'bad' : 'ok';
  return `<span class="balance ${className}">${money(balance)}</span>`;
}

function renderKeys() {
  const filtered = keys.filter((key) => !selectedProvider || Number(key.provider_id) === Number(selectedProvider));
  $('#keys').innerHTML = filtered.length ? filtered.map((key) => `
    <article class="key-row">
      <div class="key-main">
        <div class="key-title-line">
          <h3>${key.name}</h3>
          <span class="badge ${statusClass(key.status)}">${statusText(key.status)}</span>
        </div>
        <p>${key.provider_name} · ${key.base_url}</p>
        <code>${key.api_key}</code>
        <div class="model-group">${modelSummary(key.provider_id)}</div>
      </div>
      <div class="key-meta">
        <div><span>厂商余额</span>${providerBalance(key)}</div>
        <div><span>月预算</span><strong>${money(key.monthly_quota)}</strong></div>
        <div><span>已使用</span><strong>${money(key.used_amount)}</strong></div>
      </div>
      <div class="row-actions">
        <button class="icon-btn copy" title="复制 API Key" data-copy="${key.id}">复制</button>
        <button class="icon-btn edit" title="编辑入口已移除" disabled>编辑</button>
        <button class="icon-btn delete" title="删除 Key" data-delete="${key.id}">删除</button>
      </div>
    </article>
  `).join('') : '<div class="empty">当前厂商没有 Key。</div>';

  document.querySelectorAll('[data-copy]').forEach((button) => button.onclick = () => copyKey(button.dataset.copy));
  document.querySelectorAll('[data-delete]').forEach((button) => button.onclick = () => deleteKey(Number(button.dataset.delete)));
}

function renderAlerts() {
  const lowBalances = providers.filter((provider) => Number(provider.balance) < Number(provider.low_balance_threshold));
  const abnormalKeys = keys.filter((key) => key.status !== 'active');
  const items = [
    ...lowBalances.map((provider) => ({
      title: '余额预警',
      text: `${provider.name} 剩余 ${money(provider.balance)}，低于阈值 ${money(provider.low_balance_threshold)}。`,
      level: 'bad',
    })),
    ...abnormalKeys.map((key) => ({
      title: 'Key 状态提醒',
      text: `${key.provider_name} / ${key.name} 当前状态：${statusText(key.status)}。`,
      level: key.status === 'warning' ? 'warn' : 'bad',
    })),
  ];

  $('#alerts').innerHTML = items.length ? items.map((item) => `
    <div class="alert-item ${item.level}">
      <strong>${item.title}</strong>
      <p>${item.text}</p>
    </div>
  `).join('') : '<div class="alert-item"><strong>暂无风险</strong><p>所有余额和 Key 状态正常。</p></div>';
}

async function copyKey(id) {
  const key = keys.find((item) => Number(item.id) === Number(id));
  const model = providerModels(key?.provider_id)[0]?.name || '';
  const data = await api(`/api/keys/${id}/copy?mode=key&model=${encodeURIComponent(model)}`);
  await navigator.clipboard.writeText(data.content);
  toast('已复制到剪贴板');
}

async function deleteKey(id) {
  if (!confirm('确定删除这个 Key？')) return;
  await api(`/api/keys/${id}`, { method: 'DELETE' });
  toast('已删除');
  await loadAll();
}

$('#searchBtn').onclick = () => {
  selectedProvider = $('#providerFilter').value;
  renderKeys();
};
$('#providerFilter').onchange = () => {
  selectedProvider = $('#providerFilter').value;
};
loadAll().catch((error) => toast(error.message));
