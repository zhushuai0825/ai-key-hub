const $ = (s) => document.querySelector(s);

function e(v = '') {
  return String(v).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function pill(v) {
  return `<span class="state-pill ${v ? 'ok' : 'bad'}">${v ? '已配置' : '未配置'}</span>`;
}

function fieldLabel(key) {
  return {
    auth_enabled: '登录保护',
    port: '端口',
    host: '监听地址',
    corp_id: 'Corp ID',
    agent_id: 'Agent ID',
    token: 'Token',
    encoding_aes_key: 'EncodingAESKey',
    configured: '已配置',
    model: '模型',
    base_url: 'Base URL',
    timeout_ms: '超时 ms',
    retry_count: '重试次数',
    enabled: '已启用',
    keep: '保留份数',
    primary_kb: '主知识库',
    chroma: 'Chroma',
  }[key] || key;
}

function card(name, obj) {
  const rows = Object.entries(obj || {}).map(([k, v]) => {
    const value = typeof v === 'boolean' ? pill(v) : `<span title="${e(String(v ?? ''))}">${e(String(v ?? ''))}</span>`;
    return `<p><b title="${e(k)}">${e(fieldLabel(k))}</b>${value}</p>`;
  }).join('');
  return `<article class="monitor-card config-card"><div><strong>${e(name)}</strong></div>${rows}</article>`;
}

async function load() {
  const d = await fetch('/api/config/status').then((r) => r.json());
  $('#configUpdated').textContent = new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
  $('#configGrid').innerHTML = [
    card('App', d.app),
    card('企业微信', d.wechat),
    card('OCR', d.ocr),
    card('模型网关', d.gateway),
    card('助手', d.assistant),
    card('自动备份', d.backup),
    card('通知订阅', d.notifications),
    card('知识库', d.knowledge),
  ].join('');
}

$('#refreshBtn').onclick = load;
load();
