const $ = (s) => document.querySelector(s);

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const synth = window.speechSynthesis;

let sessionId = null;
let recognition = null;
let micStream = null;
let active = false;
let busy = false;
let muted = false;
let speaking = false;
let shouldListen = false;
let turns = 0;
let lastSentAt = 0;
let restartTimer = null;
let lastError = '';

function toast(message) {
  const box = $('#toast');
  box.textContent = message;
  box.classList.add('show');
  setTimeout(() => box.classList.remove('show'), 2800);
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function setStatus(mode, hint) {
  const labels = {
    idle: '待开始',
    listening: '聆听中',
    thinking: '思考中',
    speaking: '说话中',
    paused: '已暂停',
    error: '出错了',
  };
  $('#statusLabel').textContent = labels[mode] || mode;
  if (hint) $('#statusHint').textContent = hint;
  $('#orb').dataset.mode = mode;
  document.body.dataset.companion = mode;
}

function appendChat(role, text) {
  const row = document.createElement('article');
  row.className = `companion-bubble ${role}`;
  row.innerHTML = `<em>${role === 'user' ? '你' : '小伴'}</em><p>${escapeHtml(text)}</p>`;
  $('#chatLog').appendChild(row);
  $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
}

function updateTurnCount() {
  $('#turnCount').textContent = `${turns} 轮`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || '请求失败');
  return data;
}

function stopSpeaking() {
  if (synth?.speaking) synth.cancel();
  speaking = false;
}

function speak(text) {
  return new Promise((resolve) => {
    if (muted || !synth || !window.SpeechSynthesisUtterance) {
      resolve();
      return;
    }
    stopSpeaking();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'zh-CN';
    utter.rate = 1.05;
    utter.pitch = 1;
    speaking = true;
    setStatus('speaking', '正在朗读回复，说完会继续听你。');
    utter.onend = () => {
      speaking = false;
      resolve();
    };
    utter.onerror = () => {
      speaking = false;
      resolve();
    };
    synth.speak(utter);
  });
}

function shouldIgnore(text) {
  const clean = String(text || '').trim();
  if (!clean) return true;
  if (clean.length < 2) return true;
  if (/^(嗯|啊|呃|哦|唔|额|那个|就是)[。.!！？\s]*$/i.test(clean)) return true;
  if (Date.now() - lastSentAt < 1200) return true;
  return false;
}

async function handleFinalText(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!active || busy || shouldIgnore(clean)) return;
  busy = true;
  lastSentAt = Date.now();
  $('#interimText').textContent = clean;
  pauseListening();
  appendChat('user', clean);
  setStatus('thinking', '听懂了，正在想怎么回你…');
  try {
    const data = await api('/api/companion/chat', {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId, text: clean }),
    });
    sessionId = data.session_id || sessionId;
    turns += 1;
    updateTurnCount();
    appendChat('assistant', data.reply);
    await speak(data.reply);
  } catch (error) {
    lastError = error.message;
    setStatus('error', error.message);
    toast(error.message);
  } finally {
    busy = false;
    if (active && shouldListen) resumeListening();
    else if (active) setStatus('listening', '继续说就行，说完会自动回复。');
  }
}

function pauseListening() {
  shouldListen = false;
  try { recognition?.stop(); } catch (_) { /* ignore */ }
}

function resumeListening() {
  if (!active || busy || speaking || !recognition) return;
  shouldListen = true;
  setStatus('listening', '继续说就行，说完会自动回复。');
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    try { recognition.start(); } catch (_) { /* already started */ }
  }, 220);
}

function releaseMic() {
  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
  }
}

async function requestMic() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('浏览器不支持麦克风接口。请换 Chrome / Edge。');
  }
  if (!window.isSecureContext) {
    throw new Error('当前是 HTTP 访问，浏览器禁止麦克风。请用 https:// 打开，或在本机 localhost 调试。');
  }
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  return micStream;
}

function createRecognition() {
  const rec = new SpeechRecognition();
  rec.lang = 'zh-CN';
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  rec.onstart = () => {
    if (active && !busy && !speaking) setStatus('listening', '正在听你说话…');
  };

  rec.onresult = (event) => {
    let interim = '';
    let finalText = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const transcript = result[0]?.transcript || '';
      if (result.isFinal) finalText += transcript;
      else interim += transcript;
    }
    if (interim) $('#interimText').textContent = interim;
    if (finalText) handleFinalText(finalText);
  };

  rec.onerror = (event) => {
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      lastError = '麦克风或语音识别被拒绝。请允许权限，并确认使用 HTTPS / Chrome。';
      failCompanion(lastError);
      return;
    }
    if (event.error === 'network') {
      lastError = '语音识别需要联网（浏览器会连 Google 语音服务）。请检查网络或代理。';
      setStatus('error', lastError);
      toast(lastError);
      return;
    }
    toast(`识别异常：${event.error}`);
  };

  rec.onend = () => {
    if (active && shouldListen && !busy && !speaking) {
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        try { recognition.start(); } catch (_) { /* ignore */ }
      }, 180);
    }
  };

  return rec;
}

async function ensureSession(forceNew = false) {
  if (sessionId && !forceNew) return sessionId;
  const data = await api('/api/companion/session', {
    method: 'POST',
    body: JSON.stringify({ session_id: forceNew ? sessionId : null }),
  });
  sessionId = data.session_id;
  return sessionId;
}

function failCompanion(message) {
  active = false;
  shouldListen = false;
  busy = false;
  clearTimeout(restartTimer);
  try { recognition?.stop(); } catch (_) { /* ignore */ }
  stopSpeaking();
  releaseMic();
  $('#toggleBtn').textContent = '开始陪伴';
  $('#interruptBtn').disabled = true;
  lastError = message || lastError || '启动失败';
  setStatus('error', lastError);
  toast(lastError);
}

async function startCompanion() {
  if (!SpeechRecognition) {
    failCompanion('当前浏览器不支持连续语音识别，请用 Chrome / Edge。');
    return;
  }
  try {
    setStatus('thinking', '正在申请麦克风权限…');
    await ensureSession(false);
    await requestMic();
    if (!recognition) recognition = createRecognition();
    active = true;
    shouldListen = true;
    lastError = '';
    $('#toggleBtn').textContent = '结束陪伴';
    $('#muteBtn').disabled = false;
    $('#interruptBtn').disabled = false;
    setStatus('listening', '已开始。直接说话，说完停顿一下就会自动回复。');
    recognition.start();
  } catch (error) {
    const msg = error?.name === 'NotAllowedError'
      ? '麦克风权限被拒绝，请在浏览器地址栏允许麦克风后重试。'
      : (error?.message || '无法启动麦克风');
    failCompanion(msg);
  }
}

function stopCompanion() {
  active = false;
  shouldListen = false;
  busy = false;
  clearTimeout(restartTimer);
  try { recognition?.stop(); } catch (_) { /* ignore */ }
  stopSpeaking();
  releaseMic();
  $('#toggleBtn').textContent = '开始陪伴';
  $('#interruptBtn').disabled = true;
  setStatus('paused', lastError ? `已停止。上次问题：${lastError}` : '已结束。再点「开始陪伴」可继续聊。');
  $('#interimText').textContent = '…';
}

async function sendTyped() {
  const input = $('#textInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  if (!sessionId) {
    try { await ensureSession(false); } catch (error) {
      toast(error.message);
      return;
    }
  }
  active = true;
  await handleFinalText(text);
}

$('#toggleBtn').onclick = () => {
  if (active) stopCompanion();
  else startCompanion();
};

$('#muteBtn').onclick = () => {
  muted = !muted;
  $('#muteBtn').textContent = muted ? '开启朗读' : '静音回复';
  if (muted) stopSpeaking();
  toast(muted ? '已静音，只显示文字回复' : '已开启语音朗读');
};

$('#interruptBtn').onclick = () => {
  stopSpeaking();
  if (active) resumeListening();
};

$('#resetBtn').onclick = async () => {
  stopCompanion();
  $('#chatLog').innerHTML = '';
  turns = 0;
  updateTurnCount();
  lastError = '';
  try {
    await ensureSession(true);
    toast('已开启新会话');
    setStatus('idle', '点「开始陪伴」后直接说话即可；麦克风不可用时也可下方打字。');
  } catch (error) {
    toast(error.message);
  }
};

$('#textForm')?.addEventListener('submit', (event) => {
  event.preventDefault();
  sendTyped();
});

(function initCompat() {
  const hints = [];
  if (!SpeechRecognition) hints.push('当前浏览器不支持连续语音识别，请用 Chrome 或 Edge。');
  if (!window.isSecureContext) {
    hints.push('重要：当前不是 HTTPS/localhost，浏览器会禁止麦克风。语音陪伴需要 https 访问，或先用文字输入对话。');
    setStatus('error', '当前页面不是安全上下文（HTTP），无法开麦克风。可先用下方文字聊天，或配置 HTTPS 后再用语音。');
  }
  if (!synth) hints.push('当前环境不支持语音朗读，仍可文字对话。');
  $('#compatHint').textContent = hints.join(' ');
  if (window.isSecureContext) setStatus('idle', '点一次「开始陪伴」授权麦克风，之后不用按键。');
})();
