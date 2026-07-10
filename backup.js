const $ = (selector) => document.querySelector(selector);
let selectedBackup = null;

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function toast(message) {
  const box = $('#toast');
  box.textContent = message;
  box.classList.add('show');
  setTimeout(() => box.classList.remove('show'), 2400);
}

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!res.ok) throw new Error(await res.text() || '请求失败');
  return res.json();
}

function formatTime(value) {
  if (!value) return '--';
  return new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}

function formatSize(size = 0) {
  if (size > 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

function shortText(value = '', max = 56) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function summarizeTables(tables = {}) {
  return Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, Array.isArray(rows) ? rows.length : rows]));
}

function setBackupFileLabel(file) {
  const label = $('#backupFileName');
  const drop = $('#backupDrop');
  if (!label) return;
  label.textContent = file?.name || '点击选择备份 JSON，或拖到这里';
  drop?.classList.toggle('has-file', Boolean(file?.name));
}

async function loadBackupFiles() {
  const files = await api('/api/backup/files');
  $('#backupFileCount').textContent = `${files.length} 份`;
  $('#backupFiles').innerHTML = files.length ? files.map((file) => `
    <article class="log-row tone-ok">
      <i class="log-dot" aria-hidden="true"></i>
      <div class="log-body">
        <div class="log-line">
          <strong title="${escapeHtml(file.file)}">${escapeHtml(shortText(file.file, 48))}</strong>
          <time>${escapeHtml(formatTime(file.updated_at))}</time>
        </div>
        <div class="log-meta"><span>${escapeHtml(formatSize(file.size))}</span></div>
      </div>
    </article>`).join('') : '<div class="empty-state">暂无本地备份。点击「创建备份」即可。</div>';
}

async function readBackupFile() {
  const file = $('#backupFile').files[0];
  if (!file) throw new Error('请先选择备份 JSON 文件');
  const text = await file.text();
  selectedBackup = JSON.parse(text);
  return selectedBackup;
}

$('#createBackupBtn').onclick = async () => {
  try {
    const result = await api('/api/backup/create', { method: 'POST', body: JSON.stringify({ reason: 'manual', notify: false }) });
    $('#backupPreview').value = JSON.stringify(result, null, 2);
    toast('本地备份已创建');
    await loadBackupFiles();
  } catch (error) { toast(error.message); }
};

$('#exportBtn').onclick = async () => {
  const data = await api('/api/backup/export');
  $('#backupPreview').value = JSON.stringify({ exported_at: data.exported_at, version: data.version, tables: summarizeTables(data.tables) }, null, 2);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `ai-key-hub-backup-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  toast('备份已导出');
};

$('#previewImportBtn').onclick = async () => {
  try {
    const backup = await readBackupFile();
    const preview = await api('/api/backup/preview-import', { method: 'POST', body: JSON.stringify(backup) });
    $('#importPreview').value = JSON.stringify(preview, null, 2);
    toast('预览完成');
  } catch (error) { toast(error.message); }
};

async function importBackup(mode) {
  try {
    const backup = selectedBackup || await readBackupFile();
    const label = mode === 'replace' ? '覆盖同 ID' : '导入新数据';
    if (!confirm(`${label} 会写入数据库，确认执行？`)) return;
    const result = await api('/api/backup/import', { method: 'POST', body: JSON.stringify({ backup, mode }) });
    $('#importPreview').value = JSON.stringify(result, null, 2);
    toast('恢复导入完成');
    await loadBackupFiles();
  } catch (error) { toast(error.message); }
}

const backupFile = $('#backupFile');
const backupDrop = $('#backupDrop');
backupFile?.addEventListener('change', () => setBackupFileLabel(backupFile.files?.[0]));
['dragenter', 'dragover'].forEach((type) => {
  backupDrop?.addEventListener(type, (event) => {
    event.preventDefault();
    backupDrop.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach((type) => {
  backupDrop?.addEventListener(type, (event) => {
    event.preventDefault();
    backupDrop.classList.remove('dragover');
  });
});
backupDrop?.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (!file || !backupFile) return;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  backupFile.files = transfer.files;
  setBackupFileLabel(file);
});

$('#importSkipBtn').onclick = () => importBackup('skip');
$('#importReplaceBtn').onclick = () => importBackup('replace');
loadBackupFiles().catch((error) => toast(error.message));
