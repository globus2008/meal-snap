import { PROVIDERS, ADAPTERS, ProviderError } from './providers.js';
import { LANGS, initialLang, setLang, getLang, t, applyI18n } from './i18n.js';
import { canLiveDictate, canRecord, startDictation, startRecording, toWav16k, withTimeout } from './voice.js';

const VERSION = '1.0.4';
const HISTORY_MAX = 30;
const $ = (sel, root = document) => root.querySelector(sel);

// ---------- storage (always guarded: private mode / blocked storage must not break the app) ----------

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
};

const settings = Object.assign({ provider: 'gemini', keys: {}, models: {} }, store.get('ms.settings', {}));
const saveSettings = () => store.set('ms.settings', settings);
const currentKey = () => (settings.keys[settings.provider] || '').trim();
const currentModel = () => (settings.models[settings.provider] || '').trim() || PROVIDERS[settings.provider].defaultModel;

let history = store.get('ms.history', []);
function saveHistory() {
  history = history.slice(0, HISTORY_MAX);
  if (store.set('ms.history', history)) return;
  // Storage full: drop thumbnails, then retry.
  history.forEach((h) => { delete h.thumb; });
  store.set('ms.history', history);
}

// ---------- state ----------

let photo = null;     // { base64, thumb, previewUrl }
let current = null;   // history entry shown in the result view

// ---------- utils ----------

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 2200);
}

function setStatus(el, msg, kind = '') {
  el.textContent = msg || '';
  el.className = `status ${kind}`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(t('toast.copied', { text: text.length > 40 ? `${text.slice(0, 40)}…` : text }));
}

function errorMessage(err) {
  const code = err instanceof ProviderError ? err.code : 'unknown';
  const msg = t(`error.${code}`, { provider: PROVIDERS[settings.provider].label });
  return err.detail && ['http', 'badResponse', 'refused', 'audio', 'unknown'].includes(code)
    ? `${msg} (${err.detail})`
    : msg;
}

const fmt = (n, d = 0) => (Math.round(n * 10 ** d) / 10 ** d).toLocaleString(getLang() === 'cs' ? 'cs-CZ' : 'en-US');

// ---------- photo ----------

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')); };
    img.src = url;
  });
}

function drawScaled(img, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

async function onPhotoChosen(file) {
  if (!file) return;
  try {
    const { img, url } = await loadImage(file);
    if (photo?.previewUrl) URL.revokeObjectURL(photo.previewUrl);
    photo = {
      base64: drawScaled(img, 1024, 0.8).split(',')[1],
      thumb: drawScaled(img, 120, 0.7),
      previewUrl: url,
    };
    $('#photo-preview').src = url;
    $('#photo-preview').hidden = false;
    $('#photo-empty').hidden = true;
    $('#photo-drop').classList.add('has-photo');
    $('#analyze').disabled = false;
    setStatus($('#status'), '');
  } catch {
    setStatus($('#status'), t('error.image'), 'error');
  }
}

function resetComposer() {
  if (photo?.previewUrl) URL.revokeObjectURL(photo.previewUrl);
  photo = null;
  current = null;
  $('#photo-input').value = '';
  $('#photo-preview').hidden = true;
  $('#photo-preview').removeAttribute('src');
  $('#photo-empty').hidden = false;
  $('#photo-drop').classList.remove('has-photo');
  $('#note').value = '';
  $('#analyze').disabled = true;
  setStatus($('#status'), '');
  $('#result').hidden = true;
  $('#composer').hidden = false;
  window.scrollTo({ top: 0 });
}

// ---------- analysis ----------

async function analyze() {
  if (!photo) return;
  if (!currentKey()) {
    setStatus($('#status'), t('error.noKey', { provider: PROVIDERS[settings.provider].label }), 'error');
    return;
  }
  const btn = $('#analyze');
  btn.disabled = true;
  setStatus($('#status'), t('snap.analyzing', { provider: PROVIDERS[settings.provider].label }), 'busy');
  try {
    const note = $('#note').value.trim();
    const res = await ADAPTERS[settings.provider].analyze({
      key: currentKey(),
      model: currentModel(),
      imageBase64: photo.base64,
      note,
      lang: getLang(),
    });
    if (!res.items.length) {
      setStatus($('#status'), res.note || t('error.noFood'), 'error');
      return;
    }
    current = {
      id: Date.now().toString(36),
      date: new Date().toISOString(),
      dish: res.dish,
      note: res.note,
      confidence: res.confidence,
      items: res.items,
      userNote: note,
      thumb: photo.thumb,
      provider: settings.provider,
      model: currentModel(),
    };
    history.unshift(current);
    saveHistory();
    setStatus($('#status'), '');
    showResult();
  } catch (err) {
    console.error(err);
    setStatus($('#status'), errorMessage(err), 'error');
  } finally {
    btn.disabled = !photo;
  }
}

// ---------- result view ----------

function itemTotals(it) {
  const k = (it.grams || 0) / 100;
  return { kcal: it.kcal_100g * k, p: it.protein_100g * k, c: it.carbs_100g * k, f: it.fat_100g * k };
}

function updateTotals() {
  const sum = current.items.reduce((a, it) => {
    const x = itemTotals(it);
    return { kcal: a.kcal + x.kcal, p: a.p + x.p, c: a.c + x.c, f: a.f + x.f };
  }, { kcal: 0, p: 0, c: 0, f: 0 });
  $('#total-kcal').textContent = fmt(sum.kcal);
  $('#total-p').textContent = fmt(sum.p, 1);
  $('#total-c').textContent = fmt(sum.c, 1);
  $('#total-f').textContent = fmt(sum.f, 1);
}

function updateItemRow(li, it) {
  const x = itemTotals(it);
  $('.item-kcal strong', li).textContent = fmt(x.kcal);
  $('.item-macros', li).textContent =
    `${t('macro.p')} ${fmt(x.p, 1)} · ${t('macro.c')} ${fmt(x.c, 1)} · ${t('macro.f')} ${fmt(x.f, 1)}`;
}

function renderItems() {
  const list = $('#items');
  list.textContent = '';
  const tpl = $('#item-tpl');
  current.items.forEach((it, i) => {
    const li = tpl.content.firstElementChild.cloneNode(true);
    li.dataset.index = i;
    applyI18n(li);
    li.querySelectorAll('[data-field]').forEach((input) => { input.value = it[input.dataset.field]; });
    $('.item-name', li).setAttribute('aria-label', t('result.name'));
    $('.grams input', li).setAttribute('aria-label', t('result.grams'));
    updateItemRow(li, it);
    list.appendChild(li);
  });
  updateTotals();
}

function showResult() {
  $('#composer').hidden = true;
  $('#result').hidden = false;
  $('#dish').value = current.dish;
  const conf = $('#confidence');
  conf.textContent = t(`confidence.${current.confidence}`);
  conf.className = `badge ${current.confidence}`;
  $('#result-thumb').hidden = !current.thumb;
  if (current.thumb) $('#result-thumb').src = current.thumb;
  $('#ai-note').textContent = current.note || '';
  renderItems();
  window.scrollTo({ top: 0 });
}

function persistCurrent() {
  const idx = history.findIndex((h) => h.id === current.id);
  if (idx >= 0) history[idx] = current;
  saveHistory();
}

function wireResult() {
  const list = $('#items');

  list.addEventListener('input', (e) => {
    const input = e.target.closest('[data-field]');
    if (!input) return;
    const li = input.closest('.item');
    const it = current.items[+li.dataset.index];
    const field = input.dataset.field;
    if (field === 'name') {
      it.name = input.value;
    } else {
      const n = parseFloat(String(input.value).replace(',', '.'));
      it[field] = Number.isFinite(n) && n >= 0 ? n : 0;
      updateItemRow(li, it);
      updateTotals();
    }
    persistCurrent();
  });

  list.addEventListener('click', (e) => {
    const li = e.target.closest('.item');
    if (!li) return;
    const i = +li.dataset.index;
    if (e.target.closest('.copy-one')) {
      copyText(current.items[i].name.trim());
    } else if (e.target.closest('.remove')) {
      current.items.splice(i, 1);
      persistCurrent();
      renderItems();
    } else if (e.target.closest('.toggle-details')) {
      const d = $('.item-details', li);
      d.hidden = !d.hidden;
    }
  });

  $('#add-item').addEventListener('click', () => {
    current.items.push({ name: '', grams: 100, kcal_100g: 0, protein_100g: 0, carbs_100g: 0, fat_100g: 0 });
    persistCurrent();
    renderItems();
    const li = list.lastElementChild;
    $('.item-details', li).hidden = false;
    $('.item-name', li).focus();
  });

  $('#copy-all').addEventListener('click', () => {
    const lines = current.items
      .filter((it) => it.name.trim())
      .map((it) => `${it.name.trim()} – ${fmt(it.grams)} g`);
    copyText(lines.join('\n'));
  });

  $('#dish').addEventListener('input', (e) => { current.dish = e.target.value; persistCurrent(); });
  $('#new-photo').addEventListener('click', resetComposer);
}

// ---------- voice note ----------

function wireVoice() {
  const mic = $('#mic');
  const note = $('#note');
  const statusEl = $('#voice-status');
  let session = null; // { kind: 'live'|'rec', stop }

  const hint = () => { statusEl.textContent = t('snap.noteHint'); };
  const idle = () => { session = null; mic.classList.remove('recording'); };

  async function startRecorder() {
    if (!PROVIDERS[settings.provider].audio) {
      statusEl.textContent = t('voice.useKeyboard', { provider: PROVIDERS[settings.provider].label });
      return;
    }
    if (!currentKey()) {
      statusEl.textContent = t('error.noKey', { provider: PROVIDERS[settings.provider].label });
      return;
    }
    try {
      const ctl = await startRecording({
        maxSeconds: 60,
        onTick: (s) => { statusEl.textContent = t('voice.recording', { s }); },
        onAutoStop: () => finishRecording(),
      });
      session = { kind: 'rec', stop: ctl.stop };
      mic.classList.add('recording');
      statusEl.textContent = t('voice.recording', { s: 0 });
    } catch (err) {
      console.error(err);
      statusEl.textContent = t('voice.denied');
    }
  }

  async function finishRecording() {
    if (!session || session.kind !== 'rec') return;
    const { stop } = session;
    idle();
    statusEl.textContent = t('voice.transcribing');
    try {
      const raw = await withTimeout(stop(), 5000).catch(() => { throw new ProviderError('audio', 'recorder did not stop'); });
      let audio;
      try {
        audio = await withTimeout(toWav16k(raw), 15000);
      } catch (e) {
        console.warn('WAV conversion failed, sending the raw recording', raw.type, e);
        // OpenAI reads webm/ogg/mp4 directly; Gemini needs the WAV.
        if (settings.provider !== 'openai') throw new ProviderError('audio', e.message);
        audio = raw;
      }
      const text = await ADAPTERS[settings.provider].transcribe({
        key: currentKey(), model: currentModel(), wavBlob: audio, lang: getLang(),
      });
      if (text) note.value = note.value.trim() ? `${note.value.trim()} ${text}` : text;
      hint();
    } catch (err) {
      console.error(err);
      statusEl.textContent = errorMessage(err);
    }
  }

  mic.addEventListener('click', async () => {
    if (session?.kind === 'rec') return finishRecording();
    if (session?.kind === 'live') { session.stop(); return; }

    // Prefer recording + AI transcription whenever the provider can do it: browser
    // dictation can listen without ever returning text or an error (seen in Chrome on Windows).
    if (PROVIDERS[settings.provider].audio && canRecord()) {
      startRecorder();
    } else if (canLiveDictate()) {
      const base = note.value.trim();
      let gotText = false;
      let fellBack = false;
      try {
        const ctl = startDictation({
          lang: getLang(),
          onText: (txt) => { gotText = true; note.value = base ? `${base} ${txt}` : txt; },
          // onend also fires after onerror; don't let it reset a recorder started by the fallback.
          onEnd: () => { if (!fellBack) { idle(); hint(); } },
          onError: (code) => {
            idle();
            // Speech service unavailable -> fall back to recording + AI transcription.
            if (!gotText && code !== 'aborted' && code !== 'no-speech' && canRecord()) { fellBack = true; startRecorder(); }
            else hint();
          },
        });
        session = { kind: 'live', stop: ctl.stop };
        mic.classList.add('recording');
        statusEl.textContent = t('voice.listening');
      } catch {
        if (canRecord()) startRecorder();
      }
    } else if (canRecord()) {
      startRecorder();
    } else {
      statusEl.textContent = t('voice.useKeyboard', { provider: PROVIDERS[settings.provider].label });
    }
  });
}

// ---------- history view ----------

function renderHistory() {
  const list = $('#history-list');
  list.textContent = '';
  $('#history-empty').hidden = history.length > 0;
  $('#history-clear').hidden = history.length === 0;
  const dateFmt = new Intl.DateTimeFormat(getLang() === 'cs' ? 'cs-CZ' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
  history.forEach((h) => {
    const kcal = h.items.reduce((a, it) => a + itemTotals(it).kcal, 0);
    const li = document.createElement('li');
    li.className = 'card';
    li.dataset.id = h.id;
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    const media = h.thumb ? Object.assign(document.createElement('img'), { src: h.thumb, alt: '' }) : Object.assign(document.createElement('div'), { className: 'ph' });
    const meta = document.createElement('div');
    meta.className = 'meta';
    const strong = document.createElement('strong');
    strong.textContent = h.dish || t('history.untitled');
    const small = document.createElement('small');
    small.textContent = `${dateFmt.format(new Date(h.date))} · ${t('history.items', { n: h.items.length })}`;
    meta.append(strong, small);
    const kc = document.createElement('span');
    kc.className = 'kc';
    kc.textContent = `${fmt(kcal)} kcal`;
    li.append(media, meta, kc);
    list.appendChild(li);
  });
}

function wireHistory() {
  const open = (li) => {
    const h = history.find((x) => x.id === li.dataset.id);
    if (!h) return;
    current = h;
    showView('snap');
    showResult();
  };
  $('#history-list').addEventListener('click', (e) => { const li = e.target.closest('li'); if (li) open(li); });
  $('#history-list').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { const li = e.target.closest('li'); if (li) { e.preventDefault(); open(li); } }
  });
  $('#history-clear').addEventListener('click', () => {
    if (!confirm(t('history.confirmClear'))) return;
    history = [];
    saveHistory();
    renderHistory();
    if (current) resetComposer();
  });
}

// ---------- settings view ----------

function renderProviders() {
  const wrap = $('#provider-list');
  wrap.textContent = '';
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const label = document.createElement('label');
    label.className = 'provider';
    const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'provider', value: id, checked: id === settings.provider });
    const name = Object.assign(document.createElement('span'), { className: 'name', textContent: p.label });
    const tag = Object.assign(document.createElement('span'), { className: `tag ${p.free ? 'free' : ''}`, textContent: t(p.free ? 'settings.free' : 'settings.paid') });
    label.append(input, name, tag);
    wrap.appendChild(label);
  }
}

function fillModelList(models) {
  const dl = $('#model-list');
  dl.textContent = '';
  for (const m of models) dl.appendChild(Object.assign(document.createElement('option'), { value: m }));
}

function renderProviderFields() {
  const p = PROVIDERS[settings.provider];
  $('#api-key').value = settings.keys[settings.provider] || '';
  $('#api-key').placeholder = t(`settings.keyPlaceholder.${settings.provider}`);
  $('#key-link').href = p.keyUrl;
  $('#model').value = settings.models[settings.provider] || '';
  $('#model').placeholder = p.defaultModel;
  fillModelList(p.suggestedModels);
  setStatus($('#key-status'), '');
  updateKeyBanner();
}

function updateKeyBanner() {
  $('#key-banner').hidden = Boolean(currentKey());
}

function wireSettings() {
  $('#provider-list').addEventListener('change', (e) => {
    settings.provider = e.target.value;
    saveSettings();
    renderProviderFields();
  });
  $('#api-key').addEventListener('input', (e) => {
    settings.keys[settings.provider] = e.target.value.trim();
    saveSettings();
    updateKeyBanner();
  });
  $('#model').addEventListener('input', (e) => {
    settings.models[settings.provider] = e.target.value.trim();
    saveSettings();
  });
  $('#key-show').addEventListener('click', () => {
    const k = $('#api-key');
    k.type = k.type === 'password' ? 'text' : 'password';
  });
  $('#key-test').addEventListener('click', async () => {
    const st = $('#key-status');
    setStatus(st, t('settings.testing'), 'busy');
    try {
      const models = await ADAPTERS[settings.provider].listModels({ key: currentKey() });
      const p = PROVIDERS[settings.provider];
      fillModelList([...new Set([...p.suggestedModels, ...models])]);
      const model = currentModel();
      if (models.length && !models.includes(model)) {
        setStatus(st, t('settings.keyOkModelMissing', { model }), 'error');
      } else {
        setStatus(st, t('settings.keyOk'), 'ok');
      }
    } catch (err) {
      setStatus(st, errorMessage(err), 'error');
    }
  });
  const sel = $('#lang-select');
  for (const [code, name] of Object.entries(LANGS)) sel.appendChild(Object.assign(document.createElement('option'), { value: code, textContent: name }));
  sel.addEventListener('change', () => changeLang(sel.value));
}

// ---------- navigation + language ----------

function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  document.querySelectorAll('.tab').forEach((b) => {
    const on = b.dataset.goto === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  if (name === 'history') renderHistory();
  window.scrollTo({ top: 0 });
}

async function changeLang(code) {
  await setLang(code);
  $('#lang-select').value = getLang();
  $('#lang-toggle').textContent = getLang() === 'en' ? 'CS' : 'EN';
  renderProviders();
  renderProviderFields();
  if (current && !$('#result').hidden) showResult();
  if ($('#view-history').classList.contains('active')) renderHistory();
}

// ---------- boot ----------

async function init() {
  $('#app-version').textContent = VERSION;
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-goto]');
    if (go) showView(go.dataset.goto);
  });
  $('#lang-toggle').addEventListener('click', () => changeLang(getLang() === 'en' ? 'cs' : 'en'));
  $('#photo-input').addEventListener('change', (e) => onPhotoChosen(e.target.files[0]));
  $('#analyze').addEventListener('click', analyze);

  wireResult();
  wireVoice();
  wireHistory();
  wireSettings();
  await changeLang(initialLang());

  if (!currentKey()) showView('settings');

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    // A new worker taking over means a new version was deployed: reload once to show it now
    // instead of on the next launch, unless the user is in the middle of something.
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      const busy = photo || $('#note').value.trim() || $('#mic').classList.contains('recording') || !$('#result').hidden;
      if (hadController && !busy && !init.reloaded) { init.reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
  }
}

init();
