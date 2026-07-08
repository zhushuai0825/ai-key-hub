const $ = (selector) => document.querySelector(selector);
const token = new URLSearchParams(location.search).get('token') || '';

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

async function loadTarget() {
  const res = await fetch(`/api/wechat/upload-token?token=${encodeURIComponent(token)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '上传链接不可用');
  $('#statusText').textContent = '链接有效';
  $('#targetText').textContent = `目标知识库：${data.kb_name}。有效期：${new Date(data.expires_at).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}`;
}

$('#uploadTokenForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#statusText').textContent = '上传中';
  $('#resultBox').textContent = '正在解析和写入向量知识库，请稍候...';
  const formData = new FormData(event.currentTarget);
  try {
    const res = await fetch(`/api/wechat/upload-token?token=${encodeURIComponent(token)}`, { method: 'POST', body: formData });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '上传失败');
    $('#statusText').textContent = '完成';
    $('#resultBox').innerHTML = `已写入 <strong>${escapeHtml(data.kb.name)}</strong>：${escapeHtml(data.document.title)}，切分 ${escapeHtml(data.processed.chunks)} 段。`;
    event.currentTarget.reset();
  } catch (error) {
    $('#statusText').textContent = '失败';
    $('#resultBox').textContent = error.message;
  }
});

loadTarget().catch((error) => {
  $('#statusText').textContent = '链接无效';
  $('#targetText').textContent = error.message;
  $('#uploadTokenForm button').disabled = true;
});
