const form = document.getElementById('authForm');
const errorBox = document.getElementById('authError');
const okBox = document.getElementById('authOk');
const btn = document.getElementById('authBtn');
const title = document.getElementById('formTitle');
const modeSwitch = document.getElementById('modeSwitch');
const passwordInput = document.getElementById('passwordInput');

/** 默认先注册；?mode=login 可直接进登录 */
let mode = new URLSearchParams(location.search).get('mode') === 'login' ? 'login' : 'register';

function nextPath(user = null) {
  if (user && !user.is_admin) return '/drama.html';
  const params = new URLSearchParams(location.search);
  const next = params.get('next') || '/hub.html';
  if (!next.startsWith('/') || next.startsWith('//')) return '/hub.html';
  if (next.startsWith('/login.html')) return '/hub.html';
  return next;
}

function renderMode() {
  errorBox.textContent = '';
  okBox.textContent = '';
  if (mode === 'register') {
    document.title = '注册 · AI Key Hub';
    title.textContent = '注册';
    btn.textContent = '注册';
    modeSwitch.textContent = '已有账号？去登录';
    passwordInput.autocomplete = 'new-password';
  } else {
    document.title = '登录 · AI Key Hub';
    title.textContent = '登录';
    btn.textContent = '登录';
    modeSwitch.textContent = '没有账号？去注册';
    passwordInput.autocomplete = 'current-password';
  }
}

async function ensureSession() {
  try {
    const res = await fetch('/api/auth/session', { credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (data.ok && data.user) {
      location.replace(nextPath(data.user));
    }
  } catch (_) { /* stay */ }
}

modeSwitch.addEventListener('click', () => {
  mode = mode === 'register' ? 'login' : 'register';
  renderMode();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.textContent = '';
  okBox.textContent = '';
  btn.disabled = true;
  const payload = Object.fromEntries(new FormData(form).entries());
  const isRegister = mode === 'register';
  btn.textContent = isRegister ? '注册中…' : '登录中…';
  try {
    const res = await fetch(isRegister ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || (isRegister ? '注册失败' : '登录失败'));
    if (isRegister) {
      mode = 'login';
      renderMode();
      okBox.textContent = '注册成功，请登录';
      passwordInput.value = '';
      passwordInput.focus();
    } else {
      location.replace(nextPath(data.user));
    }
  } catch (error) {
    errorBox.textContent = error.message || (isRegister ? '注册失败' : '登录失败');
  } finally {
    btn.disabled = false;
    if (mode === 'register') btn.textContent = '注册';
    else btn.textContent = '登录';
  }
});

renderMode();
ensureSession();
