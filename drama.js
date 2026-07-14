const $ = (s) => document.querySelector(s);

const state = {
  projects: [],
  projectId: null,
  bundle: null,
  episodeId: null,
  tab: 'shots',
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
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || '请求失败');
  return data;
}

function shortText(value = '', max = 64) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function currentEpisode() {
  return (state.bundle?.episodes || []).find((e) => e.id === state.episodeId) || null;
}

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.drama-tabs button').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.drama-tab-panel').forEach((panel) => {
    const active = panel.dataset.panel === tab;
    panel.hidden = !active;
    panel.classList.toggle('is-active', active);
  });
}

function renderProjects() {
  $('#projectCount').textContent = String(state.projects.length);
  $('#projectList').innerHTML = state.projects.length
    ? state.projects.map((p) => `
      <button type="button" class="drama-project-item ${p.id === state.projectId ? 'is-active' : ''}" data-id="${p.id}">
        <strong>${escapeHtml(p.title)}</strong>
        <span>${escapeHtml(p.genre || '未分类')} · ${p.episode_count || 0} 集 · ${p.shot_count || 0} 镜</span>
      </button>`).join('')
    : '<div class="empty-state">还没有项目</div>';
}

function fillProjectForm(project) {
  const form = $('#projectForm');
  form.title.value = project.title || '';
  form.genre.value = project.genre || '';
  form.synopsis.value = project.synopsis || '';
  form.style_guide.value = project.style_guide || '';
  form.status.value = project.status || 'draft';
}

function renderEpisodes() {
  const episodes = state.bundle?.episodes || [];
  $('#episodeList').innerHTML = episodes.length
    ? episodes.map((ep) => `
      <article class="drama-card ${ep.id === state.episodeId ? 'is-active' : ''}" data-ep="${ep.id}">
        <div class="drama-card-head">
          <strong>第${ep.episode_no}集 · ${escapeHtml(ep.title || '未命名')}</strong>
          <div class="drama-card-actions">
            <button type="button" data-act="select" data-id="${ep.id}">分镜</button>
            <button type="button" data-act="delete-ep" data-id="${ep.id}">删除</button>
          </div>
        </div>
        <p>${escapeHtml(shortText(ep.synopsis || '（无梗概）', 120))}</p>
      </article>`).join('')
    : '<div class="empty-state">先新增一集</div>';

  const select = $('#episodeSelect');
  select.innerHTML = episodes.map((ep) => (
    `<option value="${ep.id}" ${ep.id === state.episodeId ? 'selected' : ''}>第${ep.episode_no}集 · ${escapeHtml(ep.title || '未命名')}</option>`
  )).join('') || '<option value="">暂无分集</option>';
}

function renderCharacters() {
  const chars = state.bundle?.characters || [];
  $('#characterList').innerHTML = chars.length
    ? chars.map((c) => `
      <article class="drama-card" data-char="${c.id}">
        <div class="drama-card-head">
          <strong>${escapeHtml(c.name)} ${c.mbti ? `<em>${escapeHtml(c.mbti)}</em>` : ''}</strong>
          <button type="button" data-act="delete-char" data-id="${c.id}">删除</button>
        </div>
        <p>${escapeHtml(shortText([c.appearance, c.personality, c.ref_prompt].filter(Boolean).join(' / '), 140))}</p>
      </article>`).join('')
    : '<div class="empty-state">添加角色卡，方便豆包保持人物一致</div>';
}

function renderShots(shots = []) {
  $('#shotCountLabel').textContent = `${shots.length} 镜`;
  const ep = currentEpisode();
  $('#episodeSynopsisForm').synopsis.value = ep?.synopsis || '';

  $('#shotList').innerHTML = shots.length
    ? shots.map((s) => `
      <article class="drama-shot" data-shot="${s.id}">
        <div class="drama-shot-head">
          <strong>镜 ${s.shot_no}</strong>
          <select data-field="shot_size">
            ${['远景', '全景', '中景', '近景', '特写'].map((v) => `<option ${s.shot_size === v ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
          <input data-field="duration_sec" type="number" min="1" max="30" step="0.5" value="${escapeHtml(s.duration_sec)}" title="秒" />
          <select data-field="status">
            ${['draft', 'ready', 'generated', 'done'].map((v) => `<option value="${v}" ${s.status === v ? 'selected' : ''}>${
              ({ draft: '草稿', ready: '可生成', generated: '已出片', done: '已剪完' })[v]
            }</option>`).join('')}
          </select>
          <button type="button" data-act="save-shot">保存</button>
          <button type="button" data-act="copy-prompt">复制提示词</button>
          <button type="button" data-act="delete-shot">删除</button>
        </div>
        <div class="drama-shot-grid">
          <input data-field="characters" placeholder="出场角色，逗号分隔" value="${escapeHtml(s.characters || '')}" />
          <input data-field="camera_note" placeholder="运镜" value="${escapeHtml(s.camera_note || '')}" />
          <textarea data-field="visual_prompt" rows="2" placeholder="画面描述">${escapeHtml(s.visual_prompt || '')}</textarea>
          <textarea data-field="dialogue" rows="2" placeholder="对白">${escapeHtml(s.dialogue || '')}</textarea>
          <textarea data-field="doubao_prompt" rows="4" placeholder="豆包提示词（保存时自动重建，也可手改）">${escapeHtml(s.doubao_prompt || '')}</textarea>
        </div>
      </article>`).join('')
    : '<div class="empty-state">本集还没有分镜。写好梗概后点「AI 拆分镜」，或手动「加一镜」。</div>';
}

async function loadProjects() {
  state.projects = await api('/api/drama/projects');
  renderProjects();
}

async function loadProject(id) {
  state.projectId = Number(id);
  state.bundle = await api(`/api/drama/projects/${id}`);
  $('#emptyProject').hidden = true;
  $('#projectWorkspace').hidden = false;
  fillProjectForm(state.bundle.project);
  if (!state.episodeId || !(state.bundle.episodes || []).some((e) => e.id === state.episodeId)) {
    state.episodeId = state.bundle.episodes?.[0]?.id || null;
  }
  renderEpisodes();
  renderCharacters();
  renderProjects();
  await loadShots();
}

async function loadShots() {
  if (!state.episodeId) {
    renderShots([]);
    return;
  }
  const shots = await api(`/api/drama/episodes/${state.episodeId}/shots`);
  renderShots(shots);
}

async function createProject() {
  const title = window.prompt('项目标题', '新的漫剧项目');
  if (!title) return;
  const project = await api('/api/drama/projects', {
    method: 'POST',
    body: JSON.stringify({ title: title.trim(), genre: 'MBTI 短剧' }),
  });
  await loadProjects();
  await loadProject(project.id);
  setTab('shots');
  toast('项目已创建');
}

$('#newProjectBtn').addEventListener('click', () => {
  createProject().catch((err) => toast(err.message));
});

$('#projectList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-id]');
  if (!btn) return;
  loadProject(btn.dataset.id).catch((err) => toast(err.message));
});

document.querySelectorAll('.drama-tabs button').forEach((btn) => {
  btn.addEventListener('click', () => setTab(btn.dataset.tab));
});

$('#projectForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.projectId) return;
  const form = e.currentTarget;
  try {
    await api(`/api/drama/projects/${state.projectId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title: form.title.value,
        genre: form.genre.value,
        synopsis: form.synopsis.value,
        style_guide: form.style_guide.value,
        status: form.status.value,
      }),
    });
    await loadProjects();
    await loadProject(state.projectId);
    toast('项目已保存');
  } catch (err) {
    toast(err.message);
  }
});

$('#deleteProjectBtn').addEventListener('click', async () => {
  if (!state.projectId || !window.confirm('删除项目及全部角色/分集/分镜？')) return;
  try {
    await api(`/api/drama/projects/${state.projectId}`, { method: 'DELETE' });
    state.projectId = null;
    state.bundle = null;
    state.episodeId = null;
    $('#projectWorkspace').hidden = true;
    $('#emptyProject').hidden = false;
    await loadProjects();
    toast('已删除');
  } catch (err) {
    toast(err.message);
  }
});

$('#episodeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.projectId) return;
  const form = e.currentTarget;
  try {
    const ep = await api(`/api/drama/projects/${state.projectId}/episodes`, {
      method: 'POST',
      body: JSON.stringify({
        title: form.title.value || undefined,
        synopsis: form.synopsis.value,
      }),
    });
    form.reset();
    state.episodeId = ep.id;
    await loadProject(state.projectId);
    setTab('shots');
    toast('分集已添加');
  } catch (err) {
    toast(err.message);
  }
});

$('#episodeList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  try {
    if (btn.dataset.act === 'select') {
      state.episodeId = id;
      setTab('shots');
      renderEpisodes();
      await loadShots();
      return;
    }
    if (btn.dataset.act === 'delete-ep') {
      if (!window.confirm('删除这一集及分镜？')) return;
      await api(`/api/drama/episodes/${id}`, { method: 'DELETE' });
      if (state.episodeId === id) state.episodeId = null;
      await loadProject(state.projectId);
      toast('分集已删除');
    }
  } catch (err) {
    toast(err.message);
  }
});

$('#characterForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.projectId) return;
  const form = e.currentTarget;
  try {
    await api(`/api/drama/projects/${state.projectId}/characters`, {
      method: 'POST',
      body: JSON.stringify({
        name: form.name.value,
        mbti: form.mbti.value,
        appearance: form.appearance.value,
        personality: form.personality.value,
        ref_prompt: form.ref_prompt.value,
      }),
    });
    form.reset();
    await loadProject(state.projectId);
    toast('角色已添加');
  } catch (err) {
    toast(err.message);
  }
});

$('#characterList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act="delete-char"]');
  if (!btn) return;
  try {
    await api(`/api/drama/characters/${btn.dataset.id}`, { method: 'DELETE' });
    await loadProject(state.projectId);
    toast('角色已删除');
  } catch (err) {
    toast(err.message);
  }
});

$('#episodeSelect').addEventListener('change', async (e) => {
  state.episodeId = Number(e.target.value) || null;
  await loadShots().catch((err) => toast(err.message));
});

$('#episodeSynopsisForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.episodeId) return;
  try {
    await api(`/api/drama/episodes/${state.episodeId}`, {
      method: 'PATCH',
      body: JSON.stringify({ synopsis: e.currentTarget.synopsis.value }),
    });
    await loadProject(state.projectId);
    toast('本集梗概已保存');
  } catch (err) {
    toast(err.message);
  }
});

$('#splitBtn').addEventListener('click', async () => {
  if (!state.episodeId) return toast('请先选择分集');
  const synopsis = $('#episodeSynopsisForm').synopsis.value.trim()
    || state.bundle?.project?.synopsis
    || '';
  if (!synopsis) return toast('请先写本集或项目梗概');
  if (!window.confirm('将用 AI 拆分镜并替换本集现有分镜，继续？')) return;
  $('#splitBtn').disabled = true;
  try {
    const result = await api(`/api/drama/episodes/${state.episodeId}/split`, {
      method: 'POST',
      body: JSON.stringify({ synopsis, replace: true }),
    });
    await loadProject(state.projectId);
    toast(`已生成 ${result.count} 镜`);
  } catch (err) {
    toast(err.message);
  } finally {
    $('#splitBtn').disabled = false;
  }
});

$('#addShotBtn').addEventListener('click', async () => {
  if (!state.episodeId) return toast('请先选择分集');
  try {
    await api(`/api/drama/episodes/${state.episodeId}/shots`, {
      method: 'POST',
      body: JSON.stringify({ visual_prompt: '', shot_size: '中景', duration_sec: 4 }),
    });
    await loadShots();
    toast('已加一镜');
  } catch (err) {
    toast(err.message);
  }
});

function downloadExport(format) {
  if (!state.episodeId) return toast('请先选择分集');
  window.open(`/api/drama/episodes/${state.episodeId}/export?format=${format}`, '_blank');
}

$('#exportMdBtn').addEventListener('click', () => downloadExport('md'));
$('#exportCsvBtn').addEventListener('click', () => downloadExport('csv'));

$('#shotList').addEventListener('click', async (e) => {
  const article = e.target.closest('.drama-shot');
  if (!article) return;
  const id = article.dataset.shot;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;

  if (act === 'copy-prompt') {
    const text = article.querySelector('[data-field="doubao_prompt"]')?.value || '';
    try {
      await navigator.clipboard.writeText(text);
      toast('提示词已复制');
    } catch (_) {
      toast('复制失败，请手动选中');
    }
    return;
  }

  if (act === 'delete-shot') {
    if (!window.confirm('删除这一镜？')) return;
    try {
      await api(`/api/drama/shots/${id}`, { method: 'DELETE' });
      await loadShots();
      await loadProjects();
      toast('已删除');
    } catch (err) {
      toast(err.message);
    }
    return;
  }

  if (act === 'save-shot') {
    const payload = { rebuild_prompt: true };
    article.querySelectorAll('[data-field]').forEach((el) => {
      payload[el.dataset.field] = el.value;
    });
    // Keep manual doubao edits if user changed and unchecked rebuild — always rebuild from fields for consistency
    delete payload.doubao_prompt;
    try {
      const row = await api(`/api/drama/shots/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      article.querySelector('[data-field="doubao_prompt"]').value = row.doubao_prompt || '';
      toast('分镜已保存');
    } catch (err) {
      toast(err.message);
    }
  }
});

setTab('shots');
loadProjects()
  .then(() => {
    if (state.projects[0]) return loadProject(state.projects[0].id);
    return null;
  })
  .catch((err) => toast(err.message));
