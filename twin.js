const $ = (s) => document.querySelector(s);

let lastDraft = '';

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
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || '请求失败');
  return data;
}

async function draftReply(incoming, channel) {
  $('#twinDraftBox').innerHTML = '<div class="empty-state">正在模仿你的语气起草…</div>';
  $('#twinRationale').innerHTML = '<div class="empty-state">分析中…</div>';
  $('#copyDraftBtn').disabled = true;
  try {
    const data = await api('/api/twin/draft', {
      method: 'POST',
      body: JSON.stringify({ incoming_message: incoming, channel }),
    });
    lastDraft = data.draft || '';
    $('#copyDraftBtn').disabled = !lastDraft;
    $('#twinMeta').textContent = data.tone || '已生成';
    $('#twinDraftBox').innerHTML = `<div class="answer-text twin-draft-text">${escapeHtml(lastDraft).replace(/\n/g, '<br>')}</div>`;
    $('#twinRationale').innerHTML = `<div class="answer-text">${escapeHtml(data.rationale || '无说明').replace(/\n/g, '<br>')}</div>`;
    $('#twinKnowledge').innerHTML = (data.knowledge_hits || []).length
      ? data.knowledge_hits.map((item) => `
        <article class="log-row tone-muted">
          <i class="log-dot" aria-hidden="true"></i>
          <div class="log-body">
            <div class="log-line"><strong>${escapeHtml(item.title || '知识')}</strong></div>
            <div class="log-meta"><span>${escapeHtml(item.preview || '')}</span></div>
          </div>
        </article>`).join('')
      : '<div class="empty-state">无知识库命中</div>';
    $('#twinStylePre').textContent = data.style_examples_used || '暂无样本';
  } catch (error) {
    toast(error.message);
    $('#twinDraftBox').innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

$('#twinForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const incoming = String(data.get('incoming') || '').trim();
  if (!incoming) return toast('请先粘贴对方消息');
  draftReply(incoming, data.get('channel') || 'wecom');
});

$('#copyDraftBtn')?.addEventListener('click', async () => {
  if (!lastDraft) return;
  try {
    await navigator.clipboard.writeText(lastDraft);
    toast('草稿已复制');
  } catch (_) {
    toast('复制失败，请手动选择文本');
  }
});

$('#twinChips')?.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-q]');
  if (!btn) return;
  const form = $('#twinForm');
  form.incoming.value = btn.dataset.q;
  draftReply(btn.dataset.q, form.channel.value);
});
