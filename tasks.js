const $ = (s) => document.querySelector(s);
let tasks = [];
function escapeHtml(v=''){return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function toast(m){const b=$('#toast');b.textContent=m;b.classList.add('show');setTimeout(()=>b.classList.remove('show'),2200);}
function formatTime(v){return v?new Date(v).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'}):'未设置';}
async function api(p,o={}){const r=await fetch(p,{headers:{'Content-Type':'application/json'},...o});if(!r.ok)throw new Error(await r.text()||'请求失败');return r.json();}
function statusLabel(s){return {pending:'待提醒',done:'已完成',paused:'已暂停'}[s]||s;}
function render(){
  $('#taskList').innerHTML=tasks.length?tasks.map(t=>`<article class="task-card"><div class="timeline-title"><strong>${escapeHtml(t.title)}</strong><time>${escapeHtml(formatTime(t.remind_at))}</time></div><p>${escapeHtml(t.note||'')}</p><div class="meta">${escapeHtml(t.from_user||'无用户')} · ${escapeHtml(statusLabel(t.status))} · ${escapeHtml(t.recurrence||'none')} · 上次推送 ${escapeHtml(formatTime(t.last_notified_at))}</div><div class="row-actions"><button data-done="${t.id}" ${t.status==='done'?'disabled':''}>完成</button><button data-pause="${t.id}">${t.status==='paused'?'恢复':'暂停'}</button><button data-edit="${t.id}">编辑</button><button class="danger-btn" data-delete="${t.id}">删除</button></div></article>`).join(''):'<div class="empty-state">暂无提醒任务。</div>';
  document.querySelectorAll('[data-done]').forEach(b=>b.onclick=()=>updateTask(b.dataset.done,{status:'done'}));
  document.querySelectorAll('[data-pause]').forEach(b=>{const t=tasks.find(x=>String(x.id)===b.dataset.pause);b.onclick=()=>updateTask(b.dataset.pause,{status:t?.status==='paused'?'pending':'paused'});});
  document.querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>deleteTask(b.dataset.delete));
  document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>editTask(b.dataset.edit));
}
async function load(){const s=$('#statusFilter').value;tasks=await api(`/api/assistant/tasks${s?`?status=${s}`:''}`);render();}
async function updateTask(id,payload){await api(`/api/assistant/tasks/${id}`,{method:'PATCH',body:JSON.stringify(payload)});toast('任务已更新');await load();}
async function deleteTask(id){if(!confirm('删除这个提醒？'))return;await api(`/api/assistant/tasks/${id}`,{method:'DELETE'});toast('任务已删除');await load();}
async function editTask(id){const t=tasks.find(x=>String(x.id)===String(id));if(!t)return;const title=prompt('提醒标题',t.title);if(!title)return;const note=prompt('备注',t.note||'')??t.note;await updateTask(id,{title,note});}
$('#taskForm').onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.currentTarget).entries());await api('/api/assistant/tasks',{method:'POST',body:JSON.stringify(d)});e.currentTarget.reset();toast('提醒已创建');await load();};
$('#statusFilter').onchange=load;
$('#runDueBtn').onclick=async()=>{const r=await api('/api/assistant/tasks/run-due',{method:'POST'});toast(`已检查，处理 ${r.processed||0} 条`);await load();};
load().catch(e=>toast(e.message));
