// Voice input for the note field.
// 1) Live dictation via the Web Speech API where it really works (Chrome, Safari tab).
// 2) Fallback: record audio with MediaRecorder, convert to 16 kHz mono WAV and let the
//    AI provider transcribe it. Needed in iOS home-screen apps, where the Web Speech API
//    is exposed but silently does nothing (WebKit bug 225298).

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export function isIOS() {
  return /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isStandalone() {
  return navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}

export function canLiveDictate() {
  return Boolean(SR) && !(isIOS() && isStandalone());
}

export function canRecord() {
  return Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
}

// Live dictation. Returns a controller { stop() }; calls onText(fullTranscript) as it goes.
export function startDictation({ lang, onText, onEnd, onError }) {
  const rec = new SR();
  rec.lang = lang === 'cs' ? 'cs-CZ' : 'en-US';
  rec.interimResults = true;
  rec.continuous = true;
  rec.onresult = (e) => {
    let text = '';
    for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
    onText(text.trim());
  };
  rec.onerror = (e) => onError?.(e.error || 'error');
  rec.onend = () => onEnd?.();
  rec.start();
  return { stop: () => rec.stop() };
}

// Audio recording. Returns a controller { stop() -> Promise<Blob> }.
export async function startRecording({ maxSeconds = 60, onTick, onAutoStop } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const rec = new MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise((resolve) => {
    rec.onstop = () => {
      stream.getTracks().forEach((tr) => tr.stop());
      resolve(new Blob(chunks, { type: rec.mimeType || 'audio/mp4' }));
    };
  });
  const started = Date.now();
  const timer = setInterval(() => {
    const s = Math.floor((Date.now() - started) / 1000);
    onTick?.(s);
    if (s >= maxSeconds) { stop(); onAutoStop?.(); }
  }, 250);
  function stop() {
    clearInterval(timer);
    if (rec.state !== 'inactive') rec.stop();
    return done;
  }
  rec.start();
  return { stop };
}

// Decode any recorded audio and re-encode it as 16 kHz mono 16-bit WAV,
// a format every provider accepts.
export async function toWav16k(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  ctx.close?.();
  const rate = 16000;
  const length = Math.max(1, Math.ceil(decoded.duration * rate));
  const off = new OfflineAudioContext(1, length, rate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const pcm = (await off.startRendering()).getChannelData(0);

  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const x = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
