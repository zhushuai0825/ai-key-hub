const $ = (selector) => document.querySelector(selector);
let data = { notifications: [], report_subscriptions: [] };

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function toast(message) {
  const box = $('#toast');
  box.textContent = message;
  box.classList.add('show');
  setTimeout(() => box.classList.remove('show'), 2200);
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

function shortText(value = '', max = 72) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function typeLabel(type) {
  return {
    daily_report: '每日总结',
    weekly_report: '每周总结',
    task_reminder: '任务提醒',
    backup_success: '备份成功',
    backup_failed: '备份失败',
    wechat_retry_failed: '企微失败消息',
    system_error: '系统异常',
  }[type] || type;
}

function renderNotifications() {
  const rows = data.notifications || [];
  $('#notificationCount').textContent = `${rows.length} 项`;
  $('#notificationList').innerHTML = rows.length ? rows.map((row) => {
    const meta = [
      row.enabled ? '已开启' : '已关闭',
      row.to_user || '未指定接收人',
      row.send_time || '实时触发',
      row.description || '',
    ].filter(Boolean).join(' · ');
    return `<article class="log-row tone-${row.enabled ? 'ok' : 'muted'}">
      <i class="log-dot" aria-hidden="true"></i>
      <div class="log-body">
        <div class="log-line">
          <strong>${escapeHtml(typeLabel(row.notification_type))}</strong>
          <time>上次 ${escapeHtml(formatTime(row.last_sent_at))}</time>
        </div>
        <div class="log-meta">
          <span title="${escapeHtml(meta)}">${escapeHtml(shortText(meta, 80))}</span>
          <button type="button" class="timeline-link" data-toggle-notify="${escapeHtml(row.notification_type)}" data-enabled="${row.enabled ? '1' : '0'}">${row.enabled ? '关闭' : '开启'}</button>
          <button type="button" class="timeline-link" data-edit-notify="${escapeHtml(row.notification_type)}">编辑</button>
        </div>
      </div>
    </article>`;
  }).join('') : '<div class="empty-state">暂无通知配置</div>';
  bindNotificationActions();
}

function renderReports() {
  const rows = data.report_subscriptions || [];
  $('#reportSubCount').textContent = `${rows.length} 项`;
  $('#reportSubList').innerHTML = rows.length ? rows.map((row) => {
    const title = `${row.report_type === 'weekly' ? '周报' : '日报'} · ${row.from_user}`;
    const meta = [
      row.send_time,
      row.report_type === 'weekly' ? `周${row.weekday}` : '',
      row.enabled ? '已开启' : '已关闭',
      `#${row.id}`,
    ].filter(Boolean).join(' · ');
    return `<article class="log-row tone-${row.enabled ? 'ok' : 'muted'}">
      <i class="log-dot" aria-hidden="true"></i>
      <div class="log-body">
        <div class="log-line">
          <strong title="${escapeHtml(title)}">${escapeHtml(shortText(title, 40))}</strong>
          <time>上次 ${escapeHtml(formatTime(row.last_sent_at))}</time>
        </div>
        <div class="log-meta">
          <span title="${escapeHtml(meta)}">${escapeHtml(shortText(meta, 70))}</span>
          <button type="button" class="timeline-link" data-toggle-report="${row.id}" data-enabled="${row.enabled ? '1' : '0'}">${row.enabled ? '关闭' : '开启'}</button>
          <button type="button" class="timeline-link" data-edit-report="${row.id}">改时间</button>
          <button type="button" class="timeline-link danger" data-delete-report="${row.id}">删除</button>
        </div>
      </div>
    </article>`;
  }).join('') : '<div class="empty-state">暂无日报/周报订阅</div>';
  bindReportActions();
}

function findNotification(type) {
  return data.notifications.find((row) => row.notification_type === type);
}

function findReport(id) {
  return data.report_subscriptions.find((row) => String(row.id) === String(id));
}

function bindNotificationActions() {
  document.querySelectorAll('[data-toggle-notify]').forEach((button) => {
    button.onclick = async () => {
      try {
        await api(`/api/notifications/${encodeURIComponent(button.dataset.toggleNotify)}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: button.dataset.enabled !== '1' }),
        });
        toast('通知开关已更新');
        await load();
      } catch (error) { toast(error.message); }
    };
  });
  document.querySelectorAll('[data-edit-notify]').forEach((button) => {
    button.onclick = async () => {
      const row = findNotification(button.dataset.editNotify);
      const toUser = prompt('接收企业微信 UserID', row?.to_user || '');
      if (toUser === null) return;
      const sendTime = prompt('发送时间，可留空表示实时触发', row?.send_time || '');
      if (sendTime === null) return;
      try {
        await api(`/api/notifications/${encodeURIComponent(button.dataset.editNotify)}`, {
          method: 'PATCH',
          body: JSON.stringify({ to_user: toUser, send_time: sendTime }),
        });
        toast('通知配置已更新');
        await load();
      } catch (error) { toast(error.message); }
    };
  });
}

function bindReportActions() {
  document.querySelectorAll('[data-toggle-report]').forEach((button) => {
    button.onclick = async () => {
      try {
        await api(`/api/assistant/report-subscriptions/${button.dataset.toggleReport}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: button.dataset.enabled !== '1' }),
        });
        toast('订阅开关已更新');
        await load();
      } catch (error) { toast(error.message); }
    };
  });
  document.querySelectorAll('[data-edit-report]').forEach((button) => {
    button.onclick = async () => {
      const row = findReport(button.dataset.editReport);
      const sendTime = prompt('发送时间 HH:mm', row?.send_time || '21:30');
      if (!sendTime) return;
      try {
        await api(`/api/assistant/report-subscriptions/${button.dataset.editReport}`, {
          method: 'PATCH',
          body: JSON.stringify({ send_time: sendTime }),
        });
        toast('发送时间已更新');
        await load();
      } catch (error) { toast(error.message); }
    };
  });
  document.querySelectorAll('[data-delete-report]').forEach((button) => {
    button.onclick = async () => {
      if (!confirm('删除这个日报/周报订阅？')) return;
      try {
        await api(`/api/assistant/report-subscriptions/${button.dataset.deleteReport}`, { method: 'DELETE' });
        toast('订阅已删除');
        await load();
      } catch (error) { toast(error.message); }
    };
  });
}

async function load() {
  data = await api('/api/notifications');
  renderNotifications();
  renderReports();
}

$('#reportForm').onsubmit = async (event) => {
  event.preventDefault();
  try {
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    payload.enabled = true;
    await api('/api/assistant/report-subscriptions', { method: 'POST', body: JSON.stringify(payload) });
    event.currentTarget.reset();
    event.currentTarget.send_time.value = '21:30';
    toast('日报/周报订阅已保存');
    await load();
  } catch (error) { toast(error.message); }
};
$('#refreshBtn').onclick = () => load().catch((error) => toast(error.message));
load().catch((error) => toast(error.message));
