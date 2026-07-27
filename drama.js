const $ = (s) => document.querySelector(s);

const state = {
  projects: [],
  projectId: null,
  bundle: null,
  step: 'outline',
  chat: [],
  busy: false,
};

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function toast(message) {
  const box = $('#toast');
  box.textContent = message;
  box.classList.add('show');
  setTimeout(() => box.classList.remove('show'), 2400);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    if (res.status === 504 || /504|Gateway Time-out/i.test(text)) {
      throw new Error('识别超时（网关约 60 秒限制）。已改为分步识别，请再点一次「一键识别」');
    }
    throw new Error(res.status ? `请求失败（HTTP ${res.status}）` : '请求失败');
  }
  if (!res.ok) throw new Error(data.error || data.message || `请求失败（HTTP ${res.status}）`);
  return data;
}

function shortText(value = '', max = 80) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function projectPhase(p) {
  if ((p.character_count || 0) + (p.scene_count || 0) + (p.prop_count || 0) > 0) return '可导出';
  if ((p.script_count || 0) > 0 || (p.has_script)) return '待识别';
  if (p.has_outline) return '待写剧本';
  return '待写大纲';
}

function currentOutline() {
  return String(state.bundle?.project?.outline || state.bundle?.project?.synopsis || '').trim();
}

function hasScripts() {
  return (state.bundle?.episodes || []).some((ep) => String(ep.script_content || '').trim().length > 40);
}

function hasAssets() {
  return (state.bundle?.characters?.length || 0) + (state.bundle?.scenes?.length || 0) + (state.bundle?.props?.length || 0) > 0;
}

function showList() {
  state.projectId = null;
  state.bundle = null;
  state.chat = [];
  $('#viewList').hidden = false;
  $('#viewWork').hidden = true;
  $('#headerHint').textContent = '选择或新建项目';
  renderProjects();
}

function showWork() {
  $('#viewList').hidden = true;
  $('#viewWork').hidden = false;
  $('#headerHint').textContent = '大纲 → 剧本 → 识别 → 导出';
}

function setStep(step) {
  state.step = step;
  document.querySelectorAll('.drama-step').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.step === step);
  });
  document.querySelectorAll('.drama-step-panel').forEach((panel) => {
    const on = panel.dataset.panel === step;
    panel.hidden = !on;
    panel.classList.toggle('is-active', on);
  });
  if (step === 'outline') renderChat();
  if (step === 'script') renderScriptStep();
  if (step === 'assets') renderAssets();
}

function pickInitialStep() {
  if (hasAssets()) return 'export';
  if (hasScripts()) return 'assets';
  if (currentOutline().length >= 80) return 'script';
  return 'outline';
}

function renderProjects() {
  const grid = $('#projectGrid');
  if (!state.projects.length) {
    grid.innerHTML = `
      <div class="drama-empty">
        <strong>还没有剧本项目</strong>
        <p>点右上角「新建项目」，用对话写出第一份大纲</p>
        <button type="button" class="btn btn-solid" id="emptyNewBtn">新建项目</button>
      </div>`;
    $('#emptyNewBtn')?.addEventListener('click', () => createProject().catch((e) => toast(e.message)));
    return;
  }
  grid.innerHTML = state.projects.map((p) => `
    <button type="button" class="drama-card-btn" data-id="${p.id}">
      <strong>${escapeHtml(p.title)}</strong>
      <span class="drama-card-phase">${escapeHtml(projectPhase(p))}</span>
      <span>${escapeHtml(p.genre || '未分类')} · ${p.episode_count || 0} 集</span>
      <em>${escapeHtml(shortText(p.logline || p.synopsis || p.outline || '尚未开始写大纲', 72))}</em>
    </button>`).join('');
}

function renderWorkBar() {
  const p = state.bundle?.project;
  if (!p) return;
  $('#workTitle').textContent = p.title || '未命名';
  $('#workMeta').textContent = [
    p.genre || '未分类',
    p.logline ? shortText(p.logline, 40) : '',
  ].filter(Boolean).join(' · ');
}

function renderChat() {
  const log = $('#chatLog');
  const outline = currentOutline();
  const live = $('#outlineLive');
  const status = $('#outlineStatus');
  $('#gotoScriptBtn').disabled = outline.length < 80;
  status.textContent = outline
    ? `${outline.length} 字${outline.length >= 80 ? ' · 可生成剧本' : ' · 继续补充'}`
    : '还没有大纲';
  live.textContent = outline || '对话几轮后，这里会实时显示整理好的大纲。';

  if (!state.chat.length) {
    log.innerHTML = `
      <div class="drama-bubble assistant">
        <p>你好，我们用对话写大纲。</p>
        <p>直接说题材、主角、冲突就行。例如：「MBTI 咖啡店恋爱，ENFP 店长遇上 ISTJ 常客，三集。」</p>
      </div>`;
    return;
  }
  log.innerHTML = state.chat.map((item) => `
    <div class="drama-bubble ${item.role}">
      <p>${escapeHtml(item.content).replace(/\n/g, '<br>')}</p>
    </div>`).join('');
  log.scrollTop = log.scrollHeight;
}

function renderScriptStep() {
  const outline = currentOutline();
  $('#outlinePreview').textContent = outline || '（还没有大纲，请先回到上一步）';
  $('#generateScriptsBtn').disabled = outline.length < 40;
  const episodes = state.bundle?.episodes || [];
  const withScript = episodes.filter((ep) => String(ep.script_content || '').trim());
  $('#gotoAssetsBtn').disabled = withScript.length === 0;
  $('#scriptList').innerHTML = withScript.length
    ? withScript.map((ep) => `
      <details class="drama-detail" ${withScript.length === 1 ? 'open' : ''}>
        <summary>第${ep.episode_no}集 · ${escapeHtml(ep.title || '未命名')} · ${String(ep.script_content).length} 字</summary>
        <pre>${escapeHtml(ep.script_content)}</pre>
      </details>`).join('')
    : '<div class="drama-empty-inline">点「生成剧本」后，各集正文会出现在这里</div>';
}

function renderAssets() {
  const chars = state.bundle?.characters || [];
  const scenes = state.bundle?.scenes || [];
  const props = state.bundle?.props || [];
  $('#charCount').textContent = String(chars.length);
  $('#sceneCount').textContent = String(scenes.length);
  $('#propCount').textContent = String(props.length);
  $('#characterList').innerHTML = chars.length
    ? chars.map((c) => `<article class="drama-mini"><strong>${escapeHtml(c.name)}</strong><p>${escapeHtml(shortText(c.appearance || c.personality || '', 90))}</p></article>`).join('')
    : '<p class="form-hint">暂无</p>';
  $('#sceneList').innerHTML = scenes.length
    ? scenes.map((s) => `<article class="drama-mini"><strong>${escapeHtml(s.location)} · ${escapeHtml(s.time_label || '日')}</strong><p>${escapeHtml(shortText(s.prompt || '', 90))}</p></article>`).join('')
    : '<p class="form-hint">暂无</p>';
  $('#propList').innerHTML = props.length
    ? props.map((p) => `<article class="drama-mini"><strong>${escapeHtml(p.name)}</strong><p>${escapeHtml(shortText(p.description || p.prompt || '', 90))}</p></article>`).join('')
    : '<p class="form-hint">暂无</p>';
}

async function loadProjects() {
  const rows = await api('/api/drama/projects');
  state.projects = rows.map((p) => ({
    ...p,
    has_outline: Boolean(String(p.outline || p.synopsis || '').trim()),
    has_script: Number(p.script_count || 0) > 0,
  }));
  renderProjects();
}

async function loadProject(id, { preferStep } = {}) {
  state.projectId = Number(id);
  state.bundle = await api(`/api/drama/projects/${id}`);
  state.chat = [];
  showWork();
  renderWorkBar();
  const outline = currentOutline();
  if (outline) {
    state.chat = [{
      role: 'assistant',
      content: `已有大纲（约 ${outline.length} 字）。继续补充设定，或点下方进入「生成剧本」。`,
    }];
  }
  setStep(preferStep || pickInitialStep());
  await loadProjects();
}

async function createProject() {
  if (state.busy) return;
  state.busy = true;
  try {
    const stamp = new Date().toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Asia/Shanghai',
    });
    const project = await api('/api/drama/projects', {
      method: 'POST',
      body: JSON.stringify({ title: `新的漫剧 ${stamp}` }),
    });
    await loadProjects();
    await loadProject(project.id, { preferStep: 'outline' });
    toast('已创建，直接说故事想法吧');
    $('#chatInput')?.focus();
  } finally {
    state.busy = false;
  }
}

function exportLmdZip() {
  if (!state.projectId) return toast('请先打开项目');
  window.open(`/api/drama/projects/${state.projectId}/export-lmd`, '_blank');
}

$('#newProjectBtn').addEventListener('click', () => createProject().catch((e) => toast(e.message)));
$('#backListBtn').addEventListener('click', () => showList());
$('#exportLmdBtn').addEventListener('click', exportLmdZip);
$('#exportLmdBtn2').addEventListener('click', exportLmdZip);

$('#projectGrid').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-id]');
  if (!btn) return;
  loadProject(btn.dataset.id).catch((err) => toast(err.message));
});

document.querySelectorAll('.drama-step').forEach((btn) => {
  btn.addEventListener('click', () => setStep(btn.dataset.step));
});

$('#deleteProjectBtn').addEventListener('click', async () => {
  if (!state.projectId || !window.confirm('删除这个项目？')) return;
  try {
    await api(`/api/drama/projects/${state.projectId}`, { method: 'DELETE' });
    toast('已删除');
    await loadProjects();
    showList();
  } catch (err) {
    toast(err.message);
  }
});

$('#chatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.projectId || state.busy) return;
  const input = $('#chatInput');
  const message = input.value.trim();
  if (!message) return;
  state.chat.push({ role: 'user', content: message });
  input.value = '';
  renderChat();
  state.busy = true;
  $('#chatSendBtn').disabled = true;
  try {
    const history = state.chat.slice(0, -1).map(({ role, content }) => ({ role, content }));
    const result = await api(`/api/drama/projects/${state.projectId}/outline-chat`, {
      method: 'POST',
      body: JSON.stringify({ message, history }),
    });
    state.bundle.project = result.project;
    state.chat.push({ role: 'assistant', content: result.reply || '已更新大纲。' });
    renderWorkBar();
    renderChat();
    if (result.suggested_episode_count) $('#episodeCountInput').value = result.suggested_episode_count;
  } catch (err) {
    state.chat.push({ role: 'assistant', content: `出错了：${err.message}` });
    renderChat();
  } finally {
    state.busy = false;
    $('#chatSendBtn').disabled = false;
    input.focus();
  }
});

$('#gotoScriptBtn').addEventListener('click', () => setStep('script'));
$('#backOutlineBtn').addEventListener('click', () => setStep('outline'));
$('#gotoAssetsBtn').addEventListener('click', () => setStep('assets'));
$('#gotoExportBtn').addEventListener('click', () => setStep('export'));

$('#generateScriptsBtn').addEventListener('click', async () => {
  if (!state.projectId || state.busy) return;
  const btn = $('#generateScriptsBtn');
  state.busy = true;
  btn.disabled = true;
  const total = Math.min(12, Math.max(1, Number($('#episodeCountInput').value) || 3));
  const batchSize = 2; // 每批 2 集，避开 nginx 60s 超时
  let generated = 0;
  try {
    for (let from = 1; from <= total; from += batchSize) {
      const batch = Math.min(batchSize, total - from + 1);
      const end = from + batch - 1;
      btn.textContent = batch === 1
        ? `生成第${from}集… ${from}/${total}`
        : `生成第${from}-${end}集… ${end}/${total}`;
      const result = await api(`/api/drama/projects/${state.projectId}/generate-scripts`, {
        method: 'POST',
        body: JSON.stringify({
          episode_count: total,
          from_episode: from,
          batch_count: batch,
        }),
      });
      generated += result.episodes?.length || 0;
      await loadProject(state.projectId, { preferStep: 'script' });
    }
    toast(`已生成 ${generated} 集剧本`);
  } catch (err) {
    await loadProject(state.projectId, { preferStep: 'script' }).catch(() => null);
    toast(err.message);
  } finally {
    state.busy = false;
    btn.disabled = false;
    btn.textContent = '生成剧本';
    renderScriptStep();
  }
});

$('#extractAllBtn').addEventListener('click', async () => {
  if (!state.projectId || state.busy) return;
  const btn = $('#extractAllBtn');
  state.busy = true;
  btn.disabled = true;
  // 分步请求，避免 nginx 60s 网关超时（人物+场景+道具一次串行会超）
  const steps = [
    { type: 'characters', label: '人物' },
    { type: 'scenes', label: '场景' },
    { type: 'props', label: '道具' },
  ];
  try {
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      btn.textContent = `识别${step.label}… ${i + 1}/${steps.length}`;
      await api(`/api/drama/projects/${state.projectId}/extract-assets`, {
        method: 'POST',
        body: JSON.stringify({ types: [step.type], replace: true }),
      });
      await loadProject(state.projectId, { preferStep: 'assets' });
    }
    const chars = state.bundle?.characters?.length || 0;
    const scenes = state.bundle?.scenes?.length || 0;
    const props = state.bundle?.props?.length || 0;
    toast(`人物 ${chars} · 场景 ${scenes} · 道具 ${props}`);
  } catch (err) {
    await loadProject(state.projectId, { preferStep: 'assets' }).catch(() => null);
    toast(err.message);
  } finally {
    state.busy = false;
    btn.disabled = false;
    btn.textContent = '一键识别';
    renderAssets();
  }
});

const bootId = Number(new URLSearchParams(location.search).get('id') || 0);
loadProjects()
  .then(() => {
    if (bootId) return loadProject(bootId);
    showList();
    return null;
  })
  .catch((err) => toast(err.message));
