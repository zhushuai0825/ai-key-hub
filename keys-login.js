const form = document.getElementById('loginForm');
const errorBox = document.getElementById('loginError');
const btn = document.getElementById('loginBtn');

async function ensureSession() {
  try {
    const res = await fetch('/api/keys/session');
    const data = await res.json().catch(() => ({}));
    if (data.ok) {
      location.replace('/keys.html');
    }
  } catch (_) { /* stay on login */ }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.textContent = '';
  btn.disabled = true;
  btn.textContent = '登录中…';
  try {
    const payload = Object.fromEntries(new FormData(form).entries());
    const res = await fetch('/api/keys/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '登录失败');
    location.replace('/keys.html');
  } catch (error) {
    errorBox.textContent = error.message || '登录失败';
    btn.disabled = false;
    btn.textContent = '进入 Key 管理';
  }
});

ensureSession();
