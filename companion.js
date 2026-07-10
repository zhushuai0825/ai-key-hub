const $ = (s) => document.querySelector(s);

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const synth = window.speechSynthesis;

let sessionId = null;
let recognition = null;
let active = false;
let busy = false;
let muted = false;
let speaking = false;
let shouldListen = false;
let turns = 0;
let lastSentAt = 0;
let restartTimer = null;

function toast(message) {
  const box = $('#toast');
  box.textContent = message;
  box.classList.add('show');
  setTimeout(() => box.classList.remove('show'), 2400);
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
  if (!active || busy || speaking) return;
  shouldListen = true;
  setStatus('listening', '继续说就行，说完会自动回复。');
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    try {
      recognition?.start();
    } catch (_) { /* already started */ }
  }, 220);
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
    if (event.error === 'not-allowed') {
      setStatus('error', '麦克风被拒绝了。请允许权限后重新开始。');
      stopCompanion();
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

async function startCompanion() {
  if (!SpeechRecognition) {
    setStatus('error', '当前浏览器不支持语音识别，请用 Chrome / Edge。');
    return;
  }
  try {
    await ensureSession(false);
    if (!recognition) recognition = createRecognition();
    active = true;
    shouldListen = true;
    $('#toggleBtn').textContent = '结束陪伴';
    $('#muteBtn').disabled = false;
    $('#interruptBtn').disabled = false;
    setStatus('listening', '已开始。直接说话，说完停顿一下就会自动回复。');
    recognition.start();
  } catch (error) {
    setStatus('error', error.message || '无法启动麦克风');
    toast(error.message || '无法启动麦克风');
    stopCompanion();
  }
}

function stopCompanion() {
  active = false;
  shouldListen = false;
  busy = false;
  clearTimeout(restartTimer);
  pauseListening();
  stopSpeaking();
  $('#toggleBtn').textContent = '开始陪伴';
  $('#interruptBtn').disabled = true;
  setStatus('paused', '已结束。再点「开始陪伴」可继续聊。');
  $('#interimText').textContent = '…';
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
  try {
    await ensureSession(true);
    toast('已开启新会话');
    setStatus('idle', '点「开始陪伴」后直接说话即可。');
  } catch (error) {
    toast(error.message);
  }
};

(function initCompat() {
  const hints = [];
  if (!SpeechRecognition) hints.push('当前浏览器不支持连续语音识别，请用 Chrome 或 Edge。');
  if (!window.isSecureContext) hints.push('当前不是 HTTPS/localhost，部分浏览器可能禁止麦克风，若无法授权请用本机 https 或 Chrome 旗标放行。');
  if (!synth) hints.push('当前环境不支持语音朗读，仍可文字对话。');
  $('#compatHint').textContent = hints.join(' ');
  setStatus('idle', '点一次「开始陪伴」授权麦克风，之后不用按键。');
})();
