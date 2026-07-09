const $ = (selector) => document.querySelector(selector);
const token = new URLSearchParams(location.search).get('token') || '';

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function setProgress(step, label) {
  const percent = [8, 35, 72, 100][Math.max(0, Math.min(3, step))];
  $('#progressBar').style.width = `${percent}%`;
  [...document.querySelectorAll('#uploadSteps span')].forEach((item, index) => {
    item.classList.toggle('active', index <= step);
  });
  if (label) $('#statusText').textContent = label;
}

async function loadTarget() {
  const res = await fetch(`/api/wechat/upload-token?token=${encodeURIComponent(token)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '上传链接不可用');
  setProgress(0, '链接有效');
  $('#targetText').textContent = `目标知识库：${data.kb_name}。有效期：${new Date(data.expires_at).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}`;
}

$('#uploadTokenForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  if (button.disabled) return;
  button.disabled = true;
  setProgress(1, '上传中');
  $('#resultBox').textContent = '文件正在上传，上传完成后会自动解析、切分并写入向量知识库...';
  const formData = new FormData(event.currentTarget);
  try {
    setTimeout(() => setProgress(2, '解析入库中'), 600);
    const res = await fetch(`/api/wechat/upload-token?token=${encodeURIComponent(token)}`, { method: 'POST', body: formData });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '上传失败');
    setProgress(3, '完成');
    $('#resultBox').innerHTML = `已写入 <strong>${escapeHtml(data.kb.name)}</strong>：${escapeHtml(data.document.title)}，切分 ${escapeHtml(data.processed.chunks)} 段。<br><a class="btn" href="/knowledge.html?doc=${data.document.id}">查看文档详情</a>`;
    event.currentTarget.reset();
  } catch (error) {
    $('#statusText').textContent = '失败';
    $('#resultBox').textContent = error.message;
    button.disabled = false;
  }
});

loadTarget().catch((error) => {
  $('#statusText').textContent = '链接无效';
  $('#targetText').textContent = error.message;
  $('#uploadTokenForm button').disabled = true;
});
