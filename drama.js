const $ = (s) => document.querySelector(s);

const state = {
  projects: [],
  projectId: null,
  bundle: null,
  step: 'outline',
  chat: [],
  scriptChat: [],
  activeEpisodeId: null,
  storyboardEpisodeId: null,
  shots: [],
  scriptDirty: false,
  scriptReviews: {},
  user: null,
  busy: false,
  remake: { skeleton: null, concepts: [] },
};

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function toast(message) {
  const box = $('#toast');
  box.textContent = message;
  box.classList.add('show');
  const ms = String(message || '').length > 36 ? 4800 : 2400;
  setTimeout(() => box.classList.remove('show'), ms);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
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
  if (res.status === 401) {
    location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new Error('请先登录');
  }
  if (!res.ok) {
    const msg = typeof data.error === 'string'
      ? data.error
      : (data.error?.message || data.message || `请求失败（HTTP ${res.status}）`);
    throw new Error(msg);
  }
  return data;
}

function shortText(value = '', max = 80) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function projectPhase(p) {
  if (Number(p.shot_count || 0) > 0) return '已有分镜';
  if ((p.character_count || 0) + (p.scene_count || 0) + (p.prop_count || 0) > 0) return '待分镜/导出';
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
  $('#viewRemake').hidden = true;
  $('#viewWork').hidden = true;
  $('#headerHint').textContent = '大纲 → 剧本 → 分镜 → 导出 · 知识库加持的漫剧流水线';
  $('#remakeBtn').hidden = false;
  $('#newProjectBtn').hidden = false;
  renderProjects();
}

function showRemake() {
  state.projectId = null;
  state.bundle = null;
  $('#viewList').hidden = true;
  $('#viewRemake').hidden = false;
  $('#viewWork').hidden = true;
  $('#headerHint').textContent = '仿写爆款 · 同构换皮';
  $('#remakeBtn').hidden = true;
  $('#newProjectBtn').hidden = true;
}

function showWork() {
  $('#viewList').hidden = true;
  $('#viewRemake').hidden = true;
  $('#viewWork').hidden = false;
  $('#headerHint').textContent = (state.user && !state.user.is_admin)
    ? '大纲 → 剧本 → 识别 → 分镜'
    : '大纲 → 剧本 → 识别 → 分镜 → 导出';
  $('#remakeBtn').hidden = true;
  $('#newProjectBtn').hidden = true;
}

function setStep(step) {
  if (step === 'export' && state.user && !state.user.is_admin) {
    step = 'storyboard';
  }
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
  if (step === 'storyboard') {
    renderStoryboardStep().catch((err) => toast(err.message || '加载分镜失败'));
  }
}

function pickInitialStep() {
  if (Number(state.bundle?.project?.shot_count || 0) > 0) return 'storyboard';
  if (hasAssets() && hasScripts()) return 'storyboard';
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
        <p>新建空白项目，或粘贴参考剧「仿写爆款」</p>
        <div class="drama-empty-actions">
          <button type="button" class="btn" id="emptyRemakeBtn">仿写爆款</button>
          <button type="button" class="btn btn-solid" id="emptyNewBtn">新建项目</button>
        </div>
      </div>`;
    $('#emptyNewBtn')?.addEventListener('click', () => createProject().catch((e) => toast(e.message)));
    $('#emptyRemakeBtn')?.addEventListener('click', () => showRemake());
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
  const episodes = (state.bundle?.episodes || [])
    .sort((a, b) => Number(a.episode_no) - Number(b.episode_no));
  const withScript = episodes.filter((ep) => String(ep.script_content || '').trim().length > 0);
  $('#gotoAssetsBtn').disabled = withScript.length === 0;

  const wrap = $('#scriptEditorWrap');
  const empty = $('#scriptEmpty');
  if (!withScript.length) {
    wrap.hidden = true;
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  wrap.hidden = false;

  if (!state.activeEpisodeId || !withScript.some((ep) => Number(ep.id) === Number(state.activeEpisodeId))) {
    state.activeEpisodeId = withScript[0].id;
    state.scriptChat = [{
      role: 'assistant',
      content: '选中这一集后，可直接改左边正文，或在右边说怎么改，例如「结尾钩子更狠」「对白更口语」。',
    }];
    state.scriptDirty = false;
  }

  $('#scriptEpTabs').innerHTML = withScript.map((ep) => `
    <button type="button" class="drama-ep-tab ${Number(ep.id) === Number(state.activeEpisodeId) ? 'is-active' : ''}" data-ep-id="${ep.id}">
      第${ep.episode_no}集
    </button>`).join('');

  const ep = withScript.find((row) => Number(row.id) === Number(state.activeEpisodeId)) || withScript[0];
  $('#scriptEpLabel').textContent = `第${ep.episode_no}集 · ${ep.title || '未命名'}`;
  if (!state.scriptDirty) {
    $('#scriptTitleInput').value = ep.title || '';
    $('#scriptBodyInput').value = ep.script_content || '';
  }
  const bodyLen = String($('#scriptBodyInput').value || '').length;
  $('#scriptMeta').textContent = state.scriptDirty
    ? `${bodyLen} 字 · 未保存`
    : `${bodyLen} 字`;
  renderScriptChat();
  renderScriptQuality({ quick: true }).catch(() => null);
}

function qualityScoreClass(score) {
  if (score >= 85) return 'is-good';
  if (score >= 70) return 'is-ok';
  if (score >= 55) return 'is-warn';
  return 'is-bad';
}

function renderScriptQualityView(review) {
  const scoreEl = $('#scriptQualityScore');
  const summaryEl = $('#scriptQualitySummary');
  const listEl = $('#scriptQualityIssues');
  if (!scoreEl || !listEl) return;
  if (!review) {
    scoreEl.textContent = '—';
    scoreEl.className = 'drama-quality-score';
    if (summaryEl) summaryEl.textContent = '保存或生成后会做规则扫描；点「AI 质检」得详细报告。';
    listEl.innerHTML = '';
    return;
  }
  scoreEl.textContent = `${review.score} 分 · ${review.grade || ''}`;
  scoreEl.className = `drama-quality-score ${qualityScoreClass(review.score)}`;
  if (summaryEl) {
    summaryEl.textContent = review.summary
      || `约 ${review.heuristics?.word_count || review.word_count || '—'} 字 · 对白占比约 ${review.heuristics?.dialogue_ratio ?? review.dialogue_ratio ?? '—'}%`;
  }
  const issues = review.issues || [];
  if (!issues.length) {
    listEl.innerHTML = '<li class="drama-quality-item is-good">未发现明显问题</li>';
    return;
  }
  listEl.innerHTML = issues.map((item) => `
    <li class="drama-quality-item is-${item.severity || 'warn'}">
      <strong>${escapeHtml(item.message)}</strong>
      ${item.fix_hint ? `<span>${escapeHtml(item.fix_hint)}</span>` : ''}
    </li>`).join('');
}

async function renderScriptQuality({ quick = false } = {}) {
  const ep = currentScriptEpisode();
  if (!ep) return;
  const body = String($('#scriptBodyInput')?.value || ep.script_content || '').trim();
  if (!body) {
    renderScriptQualityView(null);
    return;
  }
  if (!quick && state.scriptReviews[ep.id]) {
    renderScriptQualityView(state.scriptReviews[ep.id]);
    return;
  }
  try {
    const review = await api(`/api/drama/episodes/${ep.id}/script-review`, {
      method: 'POST',
      body: JSON.stringify({
        script_content: body,
        use_ai: false,
      }),
    });
    state.scriptReviews[ep.id] = review;
    renderScriptQualityView(review);
  } catch (_) {
    renderScriptQualityView(state.scriptReviews[ep.id] || null);
  }
}

async function runScriptReview() {
  if (state.busy) return;
  const ep = currentScriptEpisode();
  if (!ep) return toast('请先选择一集');
  const body = String($('#scriptBodyInput')?.value || '').trim();
  if (body.length < 80) return toast('正文太短，无法质检');
  state.busy = true;
  $('#scriptReviewBtn').disabled = true;
  try {
    const review = await api(`/api/drama/episodes/${ep.id}/script-review`, {
      method: 'POST',
      body: JSON.stringify({
        script_content: body,
        title: String($('#scriptTitleInput')?.value || '').trim(),
        use_ai: true,
      }),
    });
    state.scriptReviews[ep.id] = review;
    renderScriptQualityView(review);
    const hits = Number(review.knowledge_hits) || 0;
    toast(hits > 0 ? `质检完成（参考知识库 ${hits} 条）` : '质检完成');
  } catch (err) {
    toast(err.message || '质检失败');
  } finally {
    state.busy = false;
    $('#scriptReviewBtn').disabled = false;
  }
}

async function runScriptPolish() {
  if (state.busy) return;
  const ep = currentScriptEpisode();
  if (!ep) return toast('请先选择一集');
  const body = String($('#scriptBodyInput')?.value || '').trim();
  if (body.length < 80) return toast('正文太短，无法润色');
  const review = state.scriptReviews[ep.id];
  const warn = review?.score != null && review.score < 55
    ? window.confirm(`当前得分 ${review.score}，润色会改写全文。继续？`)
    : window.confirm('将按质检结果润色本集正文并自动保存，继续？');
  if (!warn) return;
  state.busy = true;
  $('#scriptPolishBtn').disabled = true;
  $('#scriptReviewBtn').disabled = true;
  try {
    const result = await api(`/api/drama/episodes/${ep.id}/script-polish`, {
      method: 'POST',
      body: JSON.stringify({
        script_content: body,
        title: String($('#scriptTitleInput')?.value || '').trim(),
        review: review?.issues?.length ? review : undefined,
        auto_review: true,
      }),
    });
    if (result.episode) {
      const list = state.bundle?.episodes || [];
      const idx = list.findIndex((row) => Number(row.id) === Number(result.episode.id));
      if (idx >= 0) list[idx] = { ...list[idx], ...result.episode };
      state.scriptDirty = false;
      $('#scriptTitleInput').value = result.episode.title || '';
      $('#scriptBodyInput').value = result.episode.script_content || '';
    }
    state.scriptReviews[ep.id] = result.review_after || result.review_before || review;
    renderScriptQualityView(state.scriptReviews[ep.id]);
    renderScriptStep();
    const before = result.review_before?.score;
    const after = result.review_after?.score;
    const delta = before != null && after != null ? ` ${before}→${after}` : '';
    toast(`润色完成${delta}：${result.reply || '已保存'}`);
  } catch (err) {
    toast(err.message || '润色失败');
  } finally {
    state.busy = false;
    $('#scriptPolishBtn').disabled = false;
    $('#scriptReviewBtn').disabled = false;
  }
}

function renderScriptChat() {
  const log = $('#scriptChatLog');
  if (!log) return;
  if (!state.scriptChat.length) {
    log.innerHTML = `
      <div class="drama-bubble assistant">
        <p>告诉我怎么改这一集，例如：「把开场冲突提前」「压缩中段废话」「结尾换成可见事件钩」。</p>
      </div>`;
    return;
  }
  log.innerHTML = state.scriptChat.map((item) => `
    <div class="drama-bubble ${item.role}">
      <p>${escapeHtml(item.content).replace(/\n/g, '<br>')}</p>
    </div>`).join('');
  log.scrollTop = log.scrollHeight;
}

function currentScriptEpisode() {
  return (state.bundle?.episodes || []).find((ep) => Number(ep.id) === Number(state.activeEpisodeId)) || null;
}

async function selectScriptEpisode(id, { force = false } = {}) {
  if (!force && Number(id) === Number(state.activeEpisodeId)) return;
  if (state.scriptDirty) {
    const ok = window.confirm('本集有未保存修改，先保存再切换？\n确定=保存，取消=丢弃修改');
    if (ok) {
      await saveCurrentScript();
    } else {
      state.scriptDirty = false;
    }
  }
  state.activeEpisodeId = Number(id);
  state.scriptChat = [{
    role: 'assistant',
    content: '已切换到这一集。直接改左边，或在右边下指令让我改稿。',
  }];
  state.scriptDirty = false;
  renderScriptStep();
}

async function saveCurrentScript() {
  const ep = currentScriptEpisode();
  if (!ep) return toast('请先选择一集');
  const title = String($('#scriptTitleInput')?.value || '').trim();
  const script_content = String($('#scriptBodyInput')?.value || '');
  const saved = await api(`/api/drama/episodes/${ep.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title, script_content }),
  });
  const list = state.bundle?.episodes || [];
  const idx = list.findIndex((row) => Number(row.id) === Number(saved.id));
  if (idx >= 0) list[idx] = { ...list[idx], ...saved };
  state.scriptDirty = false;
  renderScriptStep();
  toast('本集已保存');
  return saved;
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

function scriptEpisodes() {
  return (state.bundle?.episodes || [])
    .filter((ep) => String(ep.script_content || '').trim().length > 40)
    .sort((a, b) => Number(a.episode_no) - Number(b.episode_no));
}

async function renderStoryboardStep() {
  const eps = scriptEpisodes();
  const tabs = $('#storyboardEpTabs');
  const list = $('#shotList');
  const meta = $('#storyboardMeta');
  if (!eps.length) {
    tabs.innerHTML = '';
    list.innerHTML = '<div class="drama-empty-inline">请先生成剧本，再来拆分镜</div>';
    meta.textContent = '暂无可用分集';
    $('#generateStoryboardBtn').disabled = true;
    return;
  }
  $('#generateStoryboardBtn').disabled = false;
  if (!state.storyboardEpisodeId || !eps.some((ep) => Number(ep.id) === Number(state.storyboardEpisodeId))) {
    state.storyboardEpisodeId = eps[0].id;
  }
  tabs.innerHTML = eps.map((ep) => `
    <button type="button" class="drama-ep-tab ${Number(ep.id) === Number(state.storyboardEpisodeId) ? 'is-active' : ''}" data-sb-ep-id="${ep.id}">
      第${ep.episode_no}集
    </button>`).join('');
  const ep = eps.find((row) => Number(row.id) === Number(state.storyboardEpisodeId)) || eps[0];
  try {
    state.shots = await api(`/api/drama/episodes/${ep.id}/shots`);
  } catch (_) {
    state.shots = [];
  }
  meta.textContent = `第${ep.episode_no}集 · ${ep.title || '未命名'} · ${state.shots.length} 镜 · 人物 ${(state.bundle?.characters || []).length} · 场景 ${(state.bundle?.scenes || []).length}`;
  if (!(state.bundle?.characters || []).length) {
    meta.textContent += state.shots.length
      ? ' · 有分镜但无人物卡，重新生成会先自动识别'
      : ' · 无人物卡时会先自动识别本集角色';
  }
  if (!state.shots.length) {
    list.innerHTML = '<div class="drama-empty-inline">点「生成本集分镜」：会参考知识库分镜规则；若无人物卡会先自动识别</div>';
    return;
  }
  list.innerHTML = state.shots.map((s) => `
    <article class="drama-shot-card" data-shot-id="${s.id}">
      <header>
        <strong>#${s.shot_no} · ${escapeHtml(s.shot_size || '中景')} · ${escapeHtml(s.camera_note || '固定')} · ${s.duration_sec || 4}s</strong>
        <button type="button" class="btn shot-copy-btn" data-shot-id="${s.id}">复制提示词</button>
      </header>
      <p class="drama-shot-visual">${escapeHtml(s.visual_prompt || '')}</p>
      ${s.dialogue ? `<p class="drama-shot-dialogue">对白：${escapeHtml(s.dialogue)}</p>` : ''}
      ${s.characters ? `<p class="form-hint">角色：${escapeHtml(s.characters)}</p>` : ''}
      <label class="form-hint">Seedance / 即梦提示词</label>
      <textarea class="shot-prompt-input" data-shot-id="${s.id}" rows="3">${escapeHtml(s.doubao_prompt || '')}</textarea>
      <div class="drama-shot-actions">
        <button type="button" class="btn shot-save-btn" data-shot-id="${s.id}">保存本镜</button>
      </div>
    </article>`).join('');
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
  const nextId = Number(id);
  if (state.scriptDirty && state.projectId && nextId !== Number(state.projectId)) {
    const ok = window.confirm('当前分集有未保存修改，先保存再切换项目？\n确定=保存，取消=丢弃修改');
    if (ok) {
      await saveCurrentScript();
    } else {
      state.scriptDirty = false;
    }
  }
  const keepEpisodeId = state.activeEpisodeId;
  const keepScriptChat = state.scriptChat;
  const keepDirty = state.scriptDirty;
  const dirtyTitle = keepDirty ? String($('#scriptTitleInput')?.value || '') : '';
  const dirtyBody = keepDirty ? String($('#scriptBodyInput')?.value || '') : '';
  state.projectId = nextId;
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
  const nextStep = preferStep || pickInitialStep();
  if (nextStep === 'script' && keepEpisodeId) {
    const still = (state.bundle?.episodes || []).some((ep) => Number(ep.id) === Number(keepEpisodeId));
    state.activeEpisodeId = still ? keepEpisodeId : null;
    state.scriptChat = still && keepScriptChat?.length ? keepScriptChat : state.scriptChat;
    state.scriptDirty = still && keepDirty;
  } else if (nextStep !== 'script') {
    state.activeEpisodeId = null;
    state.scriptChat = [];
    state.scriptDirty = false;
  }
  setStep(nextStep);
  if (state.scriptDirty) {
    $('#scriptTitleInput').value = dirtyTitle;
    $('#scriptBodyInput').value = dirtyBody;
    renderScriptStep();
  }
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

function formatRemakeSkeleton(skeleton) {
  if (!skeleton) return '先粘贴参考内容并点击「拆解」。';
  const lines = [];
  if (skeleton.story_promise) lines.push(`故事承诺：${skeleton.story_promise}`);
  if (skeleton.main_conflict) lines.push(`主冲突：${skeleton.main_conflict}`);
  if (skeleton.emotional_engine) lines.push(`情绪引擎：${skeleton.emotional_engine}`);
  if (skeleton.must_replace?.length) {
    lines.push(`必须换掉：${skeleton.must_replace.join('；')}`);
  }
  if (skeleton.episode_functions?.length) {
    lines.push('分集职责：');
    skeleton.episode_functions.slice(0, 12).forEach((row) => {
      lines.push(`  第${row.episode}集 · ${row.function || '—'}${row.hook_function ? ` → 钩：${row.hook_function}` : ''}`);
    });
  }
  return lines.join('\n') || '（骨架为空，请重试拆解）';
}

function renderRemakeConcepts() {
  const box = $('#remakeConcepts');
  const concepts = state.remake.concepts || [];
  if (!concepts.length) {
    box.innerHTML = '<p class="form-hint">拆解后会出现 3 个换皮方向，点「用这个开项目」即可。</p>';
    return;
  }
  box.innerHTML = concepts.map((c, index) => `
    <article class="drama-remake-card" data-concept-index="${index}">
      <header>
        <strong>${escapeHtml(c.title || `方向 ${index + 1}`)}</strong>
        <span>${escapeHtml([c.genre, c.suggested_episode_count ? `${c.suggested_episode_count}集` : ''].filter(Boolean).join(' · ') || '换皮方向')}</span>
      </header>
      <p class="drama-remake-logline">${escapeHtml(c.logline || shortText(c.synopsis, 80))}</p>
      <p class="drama-remake-note">${escapeHtml(c.remake_note || shortText(c.synopsis, 120))}</p>
      <button type="button" class="btn btn-solid remake-apply-btn" data-concept-index="${index}">用这个开项目</button>
    </article>`).join('');
}

async function analyzeRemake() {
  if (state.busy) return;
  const source = String($('#remakeSource')?.value || '').trim();
  if (source.length < 80) {
    toast('请粘贴至少约 80 字的参考剧本或详细梗概');
    return;
  }
  state.busy = true;
  const btn = $('#remakeAnalyzeBtn');
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = '拆解中…';
  $('#remakeSkeletonMeta').textContent = '模型分析中，约需几十秒';
  try {
    const data = await api('/api/drama/remake/analyze', {
      method: 'POST',
      body: JSON.stringify({
        source_text: source,
        hint: String($('#remakeHint')?.value || '').trim(),
      }),
    });
    state.remake.skeleton = data.skeleton || null;
    state.remake.concepts = Array.isArray(data.concepts) ? data.concepts : [];
    $('#remakeSkeleton').textContent = formatRemakeSkeleton(state.remake.skeleton);
    $('#remakeSkeletonMeta').textContent = `已出 ${state.remake.concepts.length} 个方向`;
    renderRemakeConcepts();
    toast('拆解完成，选一个方向开项目');
  } catch (err) {
    toast(err.message || '拆解失败');
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
    state.busy = false;
  }
}

async function applyRemakeConcept(index) {
  if (state.busy) return;
  const concept = state.remake.concepts[Number(index)];
  if (!concept) return toast('请先拆解并选择方向');
  state.busy = true;
  try {
    const data = await api('/api/drama/remake/apply', {
      method: 'POST',
      body: JSON.stringify({
        concept,
        skeleton: state.remake.skeleton,
      }),
    });
    const project = data.project;
    toast(`已创建「${project.title}」，可继续对话细化大纲`);
    await loadProjects();
    await loadProject(project.id, { preferStep: 'outline' });
    $('#chatInput')?.focus();
  } catch (err) {
    toast(err.message || '创建失败');
  } finally {
    state.busy = false;
  }
}

function exportLmdZip() {
  if (!state.projectId) return toast('请先打开项目');
  if (state.user && !state.user.is_admin) return toast('普通用户不可下载压缩包');
  window.open(`/api/drama/projects/${state.projectId}/export-lmd`, '_blank');
}

function exportProjectMd(format) {
  if (!state.projectId) return toast('请先打开项目');
  window.open(`/api/drama/projects/${state.projectId}/export?format=${format}`, '_blank');
}

$('#newProjectBtn').addEventListener('click', () => createProject().catch((e) => toast(e.message)));
$('#remakeBtn').addEventListener('click', () => showRemake());
$('#remakeBackBtn').addEventListener('click', () => showList());
$('#remakeAnalyzeBtn').addEventListener('click', () => analyzeRemake());
$('#remakeConcepts').addEventListener('click', (e) => {
  const btn = e.target.closest('.remake-apply-btn');
  if (!btn) return;
  applyRemakeConcept(btn.dataset.conceptIndex).catch((err) => toast(err.message));
});
$('#backListBtn').addEventListener('click', () => showList());
$('#exportLmdBtn').addEventListener('click', exportLmdZip);
$('#exportLmdBtn2').addEventListener('click', exportLmdZip);
$('#exportScriptsMdBtn')?.addEventListener('click', () => exportProjectMd('scripts'));
$('#exportImagePromptsBtn')?.addEventListener('click', () => exportProjectMd('images'));
$('#exportAllStoryboardsBtn')?.addEventListener('click', () => exportProjectMd('storyboards'));

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
    if (result.knowledge_hits > 0) toast(`大纲已参考知识库 ${result.knowledge_hits} 条`);
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
$('#gotoStoryboardBtn')?.addEventListener('click', () => setStep('storyboard'));
$('#gotoExportFromSbBtn')?.addEventListener('click', () => setStep('export'));
$('#gotoExportBtn')?.addEventListener('click', () => setStep('export'));

$('#storyboardEpTabs')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-sb-ep-id]');
  if (!btn) return;
  state.storyboardEpisodeId = Number(btn.dataset.sbEpId);
  renderStoryboardStep().catch((err) => toast(err.message));
});

$('#generateStoryboardBtn')?.addEventListener('click', async () => {
  if (state.busy) return;
  const epId = state.storyboardEpisodeId;
  if (!epId) return toast('请先选择一集');
  const btn = $('#generateStoryboardBtn');
  state.busy = true;
  btn.disabled = true;
  const prev = btn.textContent;
  const needExtract = !(state.bundle?.characters || []).length;
  btn.textContent = needExtract ? '识别人物并拆分镜…' : '拆分镜中…';
  try {
    const result = await api(`/api/drama/episodes/${epId}/split`, {
      method: 'POST',
      body: JSON.stringify({ replace: true }),
    });
    state.shots = result.shots || [];
    if (result.characters) {
      if (!state.bundle) state.bundle = {};
      state.bundle.characters = result.characters;
    }
    if (result.scenes) {
      if (!state.bundle) state.bundle = {};
      state.bundle.scenes = result.scenes;
    }
    await renderStoryboardStep();
    const parts = [`已生成 ${result.count || state.shots.length} 镜`];
    if (result.knowledge_hits > 0) parts.push(`知识库 ${result.knowledge_hits} 条`);
    if (result.auto_extracted) parts.push('已自动识别人物');
    toast(parts.join(' · '));
  } catch (err) {
    toast(err.message || '拆分镜失败');
  } finally {
    state.busy = false;
    btn.disabled = false;
    btn.textContent = prev;
  }
});

$('#exportShotsMdBtn')?.addEventListener('click', () => {
  const epId = state.storyboardEpisodeId;
  if (!epId) return toast('请先选择一集');
  window.open(`/api/drama/episodes/${epId}/export?format=md`, '_blank');
});

$('#shotList')?.addEventListener('click', async (e) => {
  const copyBtn = e.target.closest('.shot-copy-btn');
  if (copyBtn) {
    const id = copyBtn.dataset.shotId;
    const ta = $(`.shot-prompt-input[data-shot-id="${id}"]`);
    const text = ta?.value || '';
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制提示词');
    } catch (_) {
      ta?.select();
      toast('请手动复制选中文本');
    }
    return;
  }
  const saveBtn = e.target.closest('.shot-save-btn');
  if (!saveBtn) return;
  const id = saveBtn.dataset.shotId;
  const ta = $(`.shot-prompt-input[data-shot-id="${id}"]`);
  try {
    const saved = await api(`/api/drama/shots/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ doubao_prompt: ta?.value || '' }),
    });
    const idx = state.shots.findIndex((s) => Number(s.id) === Number(id));
    if (idx >= 0) state.shots[idx] = { ...state.shots[idx], ...saved };
    toast('本镜已保存');
  } catch (err) {
    toast(err.message || '保存失败');
  }
});

$('#scriptEpTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-ep-id]');
  if (!btn) return;
  selectScriptEpisode(btn.dataset.epId).catch((err) => toast(err.message));
});

$('#scriptTitleInput').addEventListener('input', () => {
  state.scriptDirty = true;
  $('#scriptMeta').textContent = `${String($('#scriptBodyInput').value || '').length} 字 · 未保存`;
});
$('#scriptBodyInput').addEventListener('input', () => {
  state.scriptDirty = true;
  $('#scriptMeta').textContent = `${String($('#scriptBodyInput').value || '').length} 字 · 未保存`;
  clearTimeout(window.__scriptQualityTimer);
  window.__scriptQualityTimer = setTimeout(() => {
    renderScriptQuality({ quick: true }).catch(() => null);
  }, 600);
});
$('#scriptReviewBtn')?.addEventListener('click', () => {
  runScriptReview().catch((err) => toast(err.message));
});
$('#scriptPolishBtn')?.addEventListener('click', () => {
  runScriptPolish().catch((err) => toast(err.message));
});
$('#saveScriptBtn').addEventListener('click', () => {
  saveCurrentScript().catch((err) => toast(err.message));
});

$('#scriptChatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.busy) return;
  const ep = currentScriptEpisode();
  if (!ep) return toast('请先生成并选择一集');
  const input = $('#scriptChatInput');
  const message = input.value.trim();
  if (!message) return;
  state.scriptChat.push({ role: 'user', content: message });
  input.value = '';
  renderScriptChat();
  state.busy = true;
  $('#scriptChatSendBtn').disabled = true;
  try {
    const history = state.scriptChat.slice(0, -1).map(({ role, content }) => ({ role, content }));
    const result = await api(`/api/drama/episodes/${ep.id}/script-chat`, {
      method: 'POST',
      body: JSON.stringify({
        message,
        history,
        script_content: String($('#scriptBodyInput').value || ''),
        title: String($('#scriptTitleInput').value || ''),
      }),
    });
    state.scriptChat.push({ role: 'assistant', content: result.reply || '已处理。' });
    if (result.episode) {
      const list = state.bundle?.episodes || [];
      const idx = list.findIndex((row) => Number(row.id) === Number(result.episode.id));
      if (idx >= 0) list[idx] = { ...list[idx], ...result.episode };
      state.scriptDirty = false;
      $('#scriptTitleInput').value = result.episode.title || '';
      $('#scriptBodyInput').value = result.episode.script_content || '';
    }
    renderScriptStep();
    if (result.applied) {
      toast(result.knowledge_hits > 0
        ? `已改好并保存（参考知识库 ${result.knowledge_hits} 条）`
        : '已按指令改好并保存');
    }
  } catch (err) {
    state.scriptChat.push({ role: 'assistant', content: `出错了：${err.message}` });
    renderScriptChat();
  } finally {
    state.busy = false;
    $('#scriptChatSendBtn').disabled = false;
    input.focus();
  }
});

$('#generateScriptsBtn').addEventListener('click', async () => {
  if (!state.projectId || state.busy) return;
  const btn = $('#generateScriptsBtn');
  state.busy = true;
  btn.disabled = true;
  const total = Math.min(12, Math.max(1, Number($('#episodeCountInput').value) || 3));
  const batchSize = 2; // 每批 2 集，控制单次生成耗时
  let generated = 0;
  let knowledgeHits = 0;
  const allQuality = [];
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
      knowledgeHits = Math.max(knowledgeHits, Number(result.knowledge_hits) || 0);
      if (Array.isArray(result.quality)) allQuality.push(...result.quality);
      await loadProject(state.projectId, { preferStep: 'script' });
    }
    toast(knowledgeHits > 0
      ? `已生成 ${generated} 集（参考知识库 ${knowledgeHits} 条）`
      : `已生成 ${generated} 集剧本`);
    const low = allQuality.filter((q) => q.score < 70);
    if (low.length) {
      toast(`生成完成；第 ${low.map((q) => q.episode_no).join('、')} 集规则分偏低，建议点「AI 质检」→「一键润色」`);
    }
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
  // 人物/场景/道具分步；长剧再按集分批，每批单独请求，避免单次过长
  const steps = [
    { type: 'characters', label: '人物' },
    { type: 'scenes', label: '场景' },
    { type: 'props', label: '道具' },
  ];
  try {
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      let batchIndex = 0;
      let done = false;
      let totalBatches = 1;
      while (!done) {
        btn.textContent = totalBatches > 1
          ? `识别${step.label}… ${i + 1}/${steps.length} · 批 ${batchIndex + 1}/${totalBatches}`
          : `识别${step.label}… ${i + 1}/${steps.length}`;
        const result = await api(`/api/drama/projects/${state.projectId}/extract-assets`, {
          method: 'POST',
          body: JSON.stringify({
            types: [step.type],
            replace: batchIndex === 0,
            batch_index: batchIndex,
          }),
        });
        totalBatches = Math.max(1, Number(result.batches) || 1);
        if (!result.batched) {
          done = true;
        } else {
          done = Boolean(result.done) || batchIndex + 1 >= totalBatches;
          batchIndex += 1;
        }
        await loadProject(state.projectId, { preferStep: 'assets' });
      }
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

async function loadCurrentUser() {
  try {
    const data = await api('/api/auth/session');
    state.user = data.user || null;
    const label = $('#dramaUserLabel');
    if (label && data.user) {
      label.textContent = data.user.is_admin
        ? `${data.user.username} · 管理员`
        : data.user.username;
    }
    applyDramaRoleUi();
  } catch (_) { /* ignore */ }
}

function applyDramaRoleUi() {
  const isAdmin = Boolean(state.user?.is_admin);
  const hub = $('#dramaHubLink');
  if (hub) hub.hidden = !isAdmin;
  ['#exportLmdBtn', '#exportLmdBtn2', '#gotoExportFromSbBtn', '#dramaStepExport'].forEach((sel) => {
    const el = $(sel);
    if (el) el.hidden = !isAdmin;
  });
  const exportPanel = document.querySelector('.drama-step-panel[data-panel="export"]');
  if (exportPanel && !isAdmin) exportPanel.hidden = true;
}

$('#dramaLogoutBtn')?.addEventListener('click', async () => {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (_) { /* ignore */ }
  location.href = '/login.html';
});

function openDramaContact() {
  const modal = $('#dramaContactModal');
  if (modal) modal.hidden = false;
}
function closeDramaContact() {
  const modal = $('#dramaContactModal');
  if (modal) modal.hidden = true;
}
$('#dramaContactBtn')?.addEventListener('click', openDramaContact);
$('#dramaContactCloseBtn')?.addEventListener('click', closeDramaContact);
$('#dramaContactCloseBg')?.addEventListener('click', closeDramaContact);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDramaContact();
});
$('#dramaContactDownload')?.addEventListener('click', async (e) => {
  // 部分浏览器对跨路径 download 不稳定，兜底拉取再触发下载
  try {
    e.preventDefault();
    const res = await fetch('./assets/wechat-contact-qr.png', { credentials: 'same-origin' });
    if (!res.ok) throw new Error('图片加载失败');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'wechat-contact-qr.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('已开始下载');
  } catch (err) {
    toast(err.message || '下载失败，可长按图片保存');
  }
});

loadCurrentUser();
loadProjects()
  .then(() => {
    if (bootId) return loadProject(bootId);
    showList();
    return null;
  })
  .catch((err) => toast(err.message));
