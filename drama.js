const $ = (s) => document.querySelector(s);

const state = {
  projects: [],
  projectId: null,
  bundle: null,
  episodeId: null,
  tab: 'shots',
  library: [],
  models: [],
  selectedModel: '',
};

const ROLE_LABEL = { main: '主角', supporting: '配角', minor: '次要' };
const SHOT_STATUS = {
  draft: '草稿',
  ready: '可导出',
  generated: '站外制作',
  done: '已归档',
};

const CURSOR_POLISH_PROMPT = [
  '请用 seedance-director（或 seedance-2.0）按我刚从 Hub 导出的分镜 MD，',
  '逐镜润色成可直接粘贴的即梦/豆包 Seedance 提示词；',
  '为每镜同时给出「首帧」「尾帧」提示；保留人物一致性与中文对白口型。不要改情节，只强化镜头、光、运动与角色锚点。',
  '提醒：进 LocalMiniDrama 后须定妆齐再批量分镜图，并点「采用此图」后再烧视频。',
].join('');

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function toast(message) {
  const box = $('#toast');
  box.textContent = message;
  box.classList.add('show');
  setTimeout(() => box.classList.remove('show'), 2800);
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

function parseAnchors(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value) || {};
  } catch (_) {
    return {};
  }
}

function anchorsFromForm(form) {
  const anchors = {};
  const face = form.anchor_face?.value?.trim();
  const features = form.anchor_features?.value?.trim();
  const marks = form.anchor_marks?.value?.trim();
  const hair = form.anchor_hair?.value?.trim();
  if (face) anchors.face_shape = face;
  if (features) anchors.facial_features = features;
  if (marks) anchors.unique_marks = marks;
  if (hair) anchors.hair_style = hair;
  return anchors;
}

function fillAnchorFields(form, anchors = {}) {
  const a = parseAnchors(anchors);
  if (form.anchor_face) form.anchor_face.value = a.face_shape || '';
  if (form.anchor_features) form.anchor_features.value = a.facial_features || '';
  if (form.anchor_marks) form.anchor_marks.value = a.unique_marks || '';
  if (form.anchor_hair) form.anchor_hair.value = a.hair_style || '';
}

function characterPayloadFromForm(form) {
  return {
    name: form.name.value,
    role: form.role.value,
    mbti: form.mbti.value,
    description: form.description.value,
    personality: form.personality.value,
    voice_note: form.voice_note.value,
    catchphrases: form.catchphrases.value,
    appearance: form.appearance.value,
    identity_anchors: anchorsFromForm(form),
    ref_prompt: form.ref_prompt.value,
    tags: form.tags?.value || undefined,
  };
}

function updateSteps() {
  const project = state.bundle?.project;
  const chars = state.bundle?.characters?.length || 0;
  const hasSynopsis = Boolean(project?.synopsis || currentEpisode()?.synopsis);
  const shotCount = Number(($('#shotCountLabel')?.textContent || '0').replace(/\D/g, '')) || 0;
  const flags = {
    project: Boolean(project?.title),
    characters: chars > 0,
    shots: shotCount > 0 || hasSynopsis,
    export: shotCount > 0,
  };
  document.querySelectorAll('.drama-steps button').forEach((btn) => {
    btn.classList.toggle('is-done', Boolean(flags[btn.dataset.step]));
    btn.classList.toggle('is-active', btn.dataset.step === (
      !flags.project ? 'project'
        : !flags.characters ? 'characters'
          : !flags.export ? 'shots'
            : 'export'
    ));
  });
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
  if (tab === 'library') loadLibrary().catch((err) => toast(err.message));
}

function renderModels() {
  const select = $('#modelSelect');
  if (!state.models.length) {
    select.innerHTML = '<option value="">未配置可用模型（去 Key 管理）</option>';
    $('#modelHint').textContent = '模型：未配置';
    return;
  }
  if (!state.selectedModel || !state.models.some((m) => m.model === state.selectedModel)) {
    state.selectedModel = state.models[0].model;
  }
  select.innerHTML = state.models.map((m) => (
    `<option value="${escapeHtml(m.model)}" ${m.model === state.selectedModel ? 'selected' : ''}>${escapeHtml(m.label)}</option>`
  )).join('');
  $('#modelHint').textContent = `模型：${state.selectedModel}`;
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

function resetCharacterForm() {
  const form = $('#characterForm');
  form.reset();
  form.edit_id.value = '';
  form.role.value = 'main';
  $('#characterSubmitBtn').textContent = '添加角色';
  $('#resetCharacterBtn').hidden = true;
  $('#characterFormHint').textContent = '角色卡会自动拼进每镜豆包提示词';
}

function fillCharacterForm(c) {
  const form = $('#characterForm');
  form.edit_id.value = String(c.id);
  form.name.value = c.name || '';
  form.role.value = c.role || 'main';
  form.mbti.value = c.mbti || '';
  form.description.value = c.description || '';
  form.personality.value = c.personality || '';
  form.voice_note.value = c.voice_note || '';
  form.catchphrases.value = c.catchphrases || '';
  form.appearance.value = c.appearance || '';
  form.ref_prompt.value = c.ref_prompt || '';
  fillAnchorFields(form, c.identity_anchors);
  $('#characterSubmitBtn').textContent = '保存修改';
  $('#resetCharacterBtn').hidden = false;
  $('#characterFormHint').textContent = `编辑中：${c.name}`;
  setTab('characters');
  form.name.focus();
}

function renderCharacters() {
  const chars = state.bundle?.characters || [];
  $('#characterList').innerHTML = chars.length
    ? chars.map((c) => {
      const role = ROLE_LABEL[c.role] || c.role || '';
      const bits = [role, c.mbti, c.description, c.appearance, c.personality, c.voice_note].filter(Boolean);
      return `
      <article class="drama-card ${Number($('#characterForm').edit_id.value) === c.id ? 'is-active' : ''}" data-char="${c.id}">
        <div class="drama-card-head">
          <strong>${escapeHtml(c.name)} ${c.mbti ? `<em>${escapeHtml(c.mbti)}</em>` : ''}${role ? `<em>${escapeHtml(role)}</em>` : ''}</strong>
          <div class="drama-card-actions">
            <button type="button" data-act="edit-char" data-id="${c.id}">编辑</button>
            <button type="button" data-act="to-library" data-id="${c.id}">存入人物库</button>
            <button type="button" data-act="delete-char" data-id="${c.id}">删除</button>
          </div>
        </div>
        <p>${escapeHtml(shortText(bits.join(' / '), 160))}</p>
        ${c.library_id ? `<p class="form-hint">已关联人物库 #${c.library_id}</p>` : ''}
      </article>`;
    }).join('')
    : '<div class="empty-state">添加角色卡，从人物库引入，或从 Cursor Skill 导入</div>';
}

function resetLibraryForm() {
  const form = $('#libraryForm');
  form.reset();
  form.edit_id.value = '';
  form.role.value = 'main';
  $('#librarySubmitBtn').textContent = '入库';
  $('#resetLibraryBtn').hidden = true;
  $('#libraryFormHint').textContent = '写入全局人物库';
}

function fillLibraryForm(c) {
  const form = $('#libraryForm');
  form.edit_id.value = String(c.id);
  form.name.value = c.name || '';
  form.role.value = c.role || 'main';
  form.mbti.value = c.mbti || '';
  form.tags.value = c.tags || '';
  form.description.value = c.description || '';
  form.personality.value = c.personality || '';
  form.voice_note.value = c.voice_note || '';
  form.catchphrases.value = c.catchphrases || '';
  form.appearance.value = c.appearance || '';
  form.ref_prompt.value = c.ref_prompt || '';
  fillAnchorFields(form, c.identity_anchors);
  $('#librarySubmitBtn').textContent = '保存库角色';
  $('#resetLibraryBtn').hidden = false;
  $('#libraryFormHint').textContent = `编辑库角色：${c.name}`;
}

function renderLibrary() {
  $('#libraryList').innerHTML = state.library.length
    ? state.library.map((c) => {
      const role = ROLE_LABEL[c.role] || c.role || '';
      const bits = [role, c.mbti, c.tags, c.description, c.appearance].filter(Boolean);
      return `
      <article class="drama-card" data-lib="${c.id}">
        <div class="drama-card-head">
          <strong>${escapeHtml(c.name)} ${c.mbti ? `<em>${escapeHtml(c.mbti)}</em>` : ''}</strong>
          <div class="drama-card-actions">
            <button type="button" data-act="import-lib" data-id="${c.id}">加入当前项目</button>
            <button type="button" data-act="edit-lib" data-id="${c.id}">编辑</button>
            <button type="button" data-act="delete-lib" data-id="${c.id}">删除</button>
          </div>
        </div>
        <p>${escapeHtml(shortText(bits.join(' / '), 160))}</p>
      </article>`;
    }).join('')
    : '<div class="empty-state">人物库为空。可在此新建，或从项目角色「存入人物库」。</div>';
}

function renderShots(shots = []) {
  $('#shotCountLabel').textContent = `${shots.length} 镜`;
  const ep = currentEpisode();
  $('#episodeSynopsisForm').synopsis.value = ep?.synopsis || '';

  $('#shotList').innerHTML = shots.length
    ? shots.map((s) => `
      <article class="drama-shot" data-shot="${s.id}">
        <div class="drama-shot-head">
          <strong>镜 ${s.shot_no}${s.title ? ` · ${escapeHtml(s.title)}` : ''}</strong>
          <select data-field="shot_size">
            ${['远景', '全景', '中景', '近景', '特写'].map((v) => `<option ${s.shot_size === v ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
          <input data-field="duration_sec" type="number" min="1" max="30" step="0.5" value="${escapeHtml(s.duration_sec)}" title="秒" />
          <select data-field="status">
            ${Object.entries(SHOT_STATUS).map(([value, label]) => (
              `<option value="${value}" ${s.status === value ? 'selected' : ''}>${label}</option>`
            )).join('')}
          </select>
          <button type="button" data-act="save-shot">保存</button>
          <button type="button" data-act="rebuild-prompt">重建提示词</button>
          <button type="button" data-act="copy-prompt">复制提示词</button>
          <button type="button" data-act="delete-shot">删除</button>
        </div>
        <div class="drama-shot-grid">
          <input data-field="title" placeholder="镜头标题" value="${escapeHtml(s.title || '')}" />
          <input data-field="characters" placeholder="出场角色，逗号分隔（会匹配角色卡）" value="${escapeHtml(s.characters || '')}" />
          <input data-field="movement" placeholder="运镜：固定/推/拉/摇/跟…" value="${escapeHtml(s.movement || s.camera_note || '')}" />
          <input data-field="camera_note" placeholder="机位补充" value="${escapeHtml(s.camera_note || '')}" />
          <textarea data-field="action" rows="2" placeholder="动作：谁在做什么">${escapeHtml(s.action || '')}</textarea>
          <textarea data-field="result" rows="2" placeholder="结果：这镜结束画面变成啥">${escapeHtml(s.result || '')}</textarea>
          <textarea data-field="dialogue" rows="2" placeholder="对白">${escapeHtml(s.dialogue || '')}</textarea>
          <textarea data-field="narration" rows="2" placeholder="旁白">${escapeHtml(s.narration || '')}</textarea>
          <input data-field="atmosphere" placeholder="氛围" value="${escapeHtml(s.atmosphere || '')}" />
          <input data-field="emotion" placeholder="情绪" value="${escapeHtml(s.emotion || '')}" />
          <textarea data-field="visual_prompt" rows="2" placeholder="画面补充">${escapeHtml(s.visual_prompt || '')}</textarea>
          <textarea data-field="layout_description" rows="2" placeholder="空间布局（可选，导出为首尾帧站位参考）">${escapeHtml(s.layout_description || '')}</textarea>
          <textarea data-field="doubao_prompt" rows="4" placeholder="豆包提示词（手改后点「保存」会保留；要按字段重算点「重建提示词」）">${escapeHtml(s.doubao_prompt || '')}</textarea>
        </div>
        <p class="form-hint drama-shot-hint">保存保留手改｜重建按角色卡+字段重算｜导出含首/尾帧提示｜Local 出片前点「采用此图」｜润色用 Cursor seedance-director / seedance-2.0</p>
      </article>`).join('')
    : '<div class="empty-state">本集还没有分镜。写好梗概后选模型点「AI 拆分镜」，或导入 Cursor 分镜 JSON。</div>';
  updateSteps();
}

async function loadModels() {
  try {
    state.models = await api('/api/drama/models');
  } catch (_) {
    state.models = [];
  }
  renderModels();
}

async function loadProjects() {
  state.projects = await api('/api/drama/projects');
  renderProjects();
}

async function loadLibrary() {
  state.library = await api('/api/drama/library');
  renderLibrary();
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
  resetCharacterForm();
  renderEpisodes();
  renderCharacters();
  renderProjects();
  await loadShots();
  updateSteps();
}

async function loadShots() {
  if (!state.episodeId) {
    renderShots([]);
    return;
  }
  const shots = await api(`/api/drama/episodes/${state.episodeId}/shots`);
  renderShots(shots);
}

function collectShotPayload(article, { rebuild = false } = {}) {
  const payload = { rebuild_prompt: rebuild };
  article.querySelectorAll('[data-field]').forEach((el) => {
    payload[el.dataset.field] = el.value;
  });
  if (payload.movement && !payload.camera_note) payload.camera_note = payload.movement;
  if (rebuild) delete payload.doubao_prompt;
  else payload.rebuild_prompt = false;
  return payload;
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

async function copyText(text) {
  await navigator.clipboard.writeText(text);
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

document.querySelectorAll('.drama-steps button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const step = btn.dataset.step;
    if (step === 'project') {
      $('#projectForm').synopsis?.focus();
      return;
    }
    if (step === 'characters') return setTab('characters');
    if (step === 'shots' || step === 'export') return setTab('shots');
  });
});

$('#modelSelect').addEventListener('change', (e) => {
  state.selectedModel = e.target.value;
  $('#modelHint').textContent = state.selectedModel ? `模型：${state.selectedModel}` : '模型：未配置';
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
  const editId = form.edit_id.value;
  const payload = characterPayloadFromForm(form);
  try {
    if (editId) {
      await api(`/api/drama/characters/${editId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      toast('角色已更新');
    } else {
      await api(`/api/drama/projects/${state.projectId}/characters`, { method: 'POST', body: JSON.stringify(payload) });
      toast('角色已添加');
    }
    resetCharacterForm();
    await loadProject(state.projectId);
  } catch (err) {
    toast(err.message);
  }
});

$('#resetCharacterBtn').addEventListener('click', () => {
  resetCharacterForm();
  renderCharacters();
});

$('#characterImportBtn').addEventListener('click', async () => {
  if (!state.projectId) return toast('请先选择项目');
  const text = $('#characterImportText').value.trim();
  if (!text) return toast('请粘贴角色卡文本');
  try {
    const result = await api(`/api/drama/projects/${state.projectId}/characters/import`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    $('#characterImportText').value = '';
    await loadProject(state.projectId);
    toast(`已导入 ${result.count} 个角色`);
  } catch (err) {
    toast(err.message);
  }
});

$('#characterList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const char = (state.bundle?.characters || []).find((c) => c.id === id);
  try {
    if (btn.dataset.act === 'edit-char') {
      if (!char) return;
      fillCharacterForm(char);
      renderCharacters();
      return;
    }
    if (btn.dataset.act === 'to-library') {
      if (!char) return;
      const created = await api('/api/drama/library', {
        method: 'POST',
        body: JSON.stringify({
          name: char.name,
          role: char.role,
          mbti: char.mbti,
          description: char.description,
          personality: char.personality,
          voice_note: char.voice_note,
          catchphrases: char.catchphrases,
          appearance: char.appearance,
          identity_anchors: char.identity_anchors,
          ref_prompt: char.ref_prompt,
        }),
      });
      await api(`/api/drama/characters/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ library_id: created.id }),
      });
      await loadProject(state.projectId);
      await loadLibrary();
      toast('已存入人物库');
      return;
    }
    if (btn.dataset.act === 'delete-char') {
      if (!window.confirm('删除这个角色？')) return;
      await api(`/api/drama/characters/${id}`, { method: 'DELETE' });
      if (Number($('#characterForm').edit_id.value) === id) resetCharacterForm();
      await loadProject(state.projectId);
      toast('角色已删除');
    }
  } catch (err) {
    toast(err.message);
  }
});

$('#libraryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const editId = form.edit_id.value;
  const payload = characterPayloadFromForm(form);
  payload.tags = form.tags.value;
  try {
    if (editId) {
      await api(`/api/drama/library/${editId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      toast('库角色已更新');
    } else {
      await api('/api/drama/library', { method: 'POST', body: JSON.stringify(payload) });
      toast('已入库');
    }
    resetLibraryForm();
    await loadLibrary();
  } catch (err) {
    toast(err.message);
  }
});

$('#resetLibraryBtn').addEventListener('click', () => {
  resetLibraryForm();
  renderLibrary();
});

$('#libraryList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const row = state.library.find((c) => c.id === id);
  try {
    if (btn.dataset.act === 'edit-lib') {
      if (!row) return;
      fillLibraryForm(row);
      return;
    }
    if (btn.dataset.act === 'import-lib') {
      if (!state.projectId) return toast('请先选择项目');
      await api(`/api/drama/projects/${state.projectId}/characters/from-library`, {
        method: 'POST',
        body: JSON.stringify({ library_id: id }),
      });
      await loadProject(state.projectId);
      setTab('characters');
      toast('已加入当前项目');
      return;
    }
    if (btn.dataset.act === 'delete-lib') {
      if (!window.confirm('从人物库删除？项目内已引入的角色仍会保留。')) return;
      await api(`/api/drama/library/${id}`, { method: 'DELETE' });
      if (Number($('#libraryForm').edit_id.value) === id) resetLibraryForm();
      await loadLibrary();
      toast('已从人物库删除');
    }
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
  if (!state.selectedModel) return toast('请先在 Key 管理配置可用模型');
  const synopsis = $('#episodeSynopsisForm').synopsis.value.trim()
    || state.bundle?.project?.synopsis
    || '';
  if (!synopsis) return toast('请先写本集或项目梗概');
  const replace = $('#splitReplace').checked;
  const msg = replace
    ? `将用配置模型 ${state.selectedModel} 拆分镜并替换本集现有分镜，继续？`
    : `将用配置模型 ${state.selectedModel} 拆分镜并追加到本集，继续？`;
  if (!window.confirm(msg)) return;
  $('#splitBtn').disabled = true;
  try {
    const result = await api(`/api/drama/episodes/${state.episodeId}/split`, {
      method: 'POST',
      body: JSON.stringify({ synopsis, replace, model: state.selectedModel }),
    });
    await loadProject(state.projectId);
    toast(`已生成 ${result.count} 镜（${result.model || state.selectedModel}）`);
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

$('#shotImportBtn').addEventListener('click', async () => {
  if (!state.episodeId) return toast('请先选择分集');
  const text = $('#shotImportText').value.trim();
  if (!text) return toast('请粘贴分镜 JSON');
  try {
    const result = await api(`/api/drama/episodes/${state.episodeId}/shots/import`, {
      method: 'POST',
      body: JSON.stringify({ text, replace: $('#shotImportReplace').checked }),
    });
    $('#shotImportText').value = '';
    await loadShots();
    await loadProjects();
    toast(`已导入 ${result.count} 镜`);
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

$('#copyCursorPromptBtn').addEventListener('click', async () => {
  try {
    await copyText(CURSOR_POLISH_PROMPT);
    toast('已复制：粘贴到 Cursor，配合导出的 MD 润色');
  } catch (_) {
    toast('复制失败，请手动复制');
  }
});

$('#shotList').addEventListener('click', async (e) => {
  const article = e.target.closest('.drama-shot');
  if (!article) return;
  const id = article.dataset.shot;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;

  if (act === 'copy-prompt') {
    const text = article.querySelector('[data-field="doubao_prompt"]')?.value || '';
    try {
      await copyText(text);
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

  if (act === 'save-shot' || act === 'rebuild-prompt') {
    const rebuild = act === 'rebuild-prompt';
    const payload = collectShotPayload(article, { rebuild });
    try {
      const row = await api(`/api/drama/shots/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      article.querySelector('[data-field="doubao_prompt"]').value = row.doubao_prompt || '';
      if (row.characters != null) {
        const charsEl = article.querySelector('[data-field="characters"]');
        if (charsEl) charsEl.value = row.characters || '';
      }
      toast(rebuild ? '提示词已重建' : '分镜已保存（保留手改提示词）');
    } catch (err) {
      toast(err.message);
    }
  }
});

setTab('shots');
Promise.all([loadModels(), loadProjects()])
  .then(() => {
    if (state.projects[0]) return loadProject(state.projects[0].id);
    return null;
  })
  .catch((err) => toast(err.message));
