import { PROVIDERS, ADAPTERS, ProviderError } from './providers.js';
import { LANGS, initialLang, setLang, getLang, t, applyI18n } from './i18n.js';
import { canLiveDictate, canRecord, startDictation, startRecording, toWav16k, withTimeout } from './voice.js';
import { MEALS, KtError, DEFAULT_PROXY, ktProxy, ktConfigured, defaultMeal, isoDate, ktTest, ktLog, ktSearch, bestMatch, md5 } from './kt.js';

const VERSION = '1.3.0';
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

const settings = Object.assign({ provider: 'gemini', keys: {}, models: {}, kt: {} }, store.get('ms.settings', {}));
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

// EXIF DateTimeOriginal (local time) of a JPEG, or null. Reads only the first 128 KB.
async function exifTakenAt(file) {
  try {
    const v = new DataView(await file.slice(0, 128 * 1024).arrayBuffer());
    if (v.getUint16(0) !== 0xffd8) return null;
    let p = 2;
    while (p + 4 <= v.byteLength && v.getUint8(p) === 0xff) {
      const marker = v.getUint8(p + 1);
      const size = v.getUint16(p + 2);
      if (marker === 0xe1 && v.getUint32(p + 4) === 0x45786966) { // APP1 "Exif"
        const tiff = p + 10;
        const le = v.getUint16(tiff) === 0x4949;
        const u16 = (o) => v.getUint16(tiff + o, le);
        const u32 = (o) => v.getUint32(tiff + o, le);
        const findTag = (ifd, tag) => {
          for (let i = 0, n = u16(ifd); i < n; i++) {
            const e = ifd + 2 + i * 12;
            if (u16(e) === tag) return e;
          }
          return -1;
        };
        const ascii = (e) => {
          const off = tiff + u32(e + 8);
          let s = '';
          for (let i = 0; i < 19 && off + i < v.byteLength; i++) s += String.fromCharCode(v.getUint8(off + i));
          return s;
        };
        const ifd0 = u32(4);
        const exifPtr = findTag(ifd0, 0x8769);
        let e = exifPtr >= 0 ? findTag(u32(exifPtr + 8), 0x9003) : -1; // DateTimeOriginal
        if (e < 0) e = findTag(ifd0, 0x0132); // DateTime
        const m = e >= 0 && ascii(e).match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
        return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
      }
      if (marker === 0xda) break; // image data starts, no EXIF
      p += 2 + size;
    }
  } catch { /* malformed EXIF */ }
  return null;
}

// When the meal was eaten, for preselecting the meal of the day: the photo's EXIF time, else the
// file date (gallery picks on Android), never in the future. A fresh camera shot gives "now".
async function photoTakenAt(file) {
  const now = Date.now();
  const exif = await exifTakenAt(file);
  if (exif && !Number.isNaN(exif.getTime()) && exif.getTime() <= now + 60000) return exif.getTime();
  return file.lastModified && file.lastModified <= now ? file.lastModified : now;
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
      takenAt: await photoTakenAt(file),
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
      takenAt: new Date(photo.takenAt).toISOString(),
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
    updateKtRow(li, it);
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
  renderKt();
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
      delete it.search; // the AI's search term described the old name
    } else {
      const n = parseFloat(String(input.value).replace(',', '.'));
      it[field] = Number.isFinite(n) && n >= 0 ? n : 0;
      updateItemRow(li, it);
      updateTotals();
    }
    persistCurrent();
  });

  list.addEventListener('change', (e) => {
    const li = e.target.closest('.item');
    if (!li) return;
    const it = current.items[+li.dataset.index];
    if (e.target.matches('.item-kt-select')) {
      it.kt = { ...it.kt, foodId: e.target.value || null };
      persistCurrent();
    } else if (e.target.matches('.item-name')) {
      searchKt();
    }
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

// ---------- Kalorické tabulky export ----------

const mealName = (id) => t(`kt.meal.${id}`);

function ktSentText(kt) {
  const d = new Date(`${kt.date}T12:00`);
  const day = new Intl.DateTimeFormat(getLang() === 'cs' ? 'cs-CZ' : 'en-US', { day: 'numeric', month: 'numeric' }).format(d);
  return t('kt.sent', { meal: mealName(kt.mealId), date: day });
}

function ktErrorMessage(err) {
  return t(`kt.error.${err instanceof KtError ? err.code : 'unknown'}`);
}

// ---- matching items with the KT food database ----

const ktSearching = new Set(); // items with a search in flight
const ktQuery = (it) => (it.search || it.name || '').trim();

function updateKtRow(li, it) {
  const row = $('.item-kt', li);
  row.hidden = !ktConfigured(settings.kt) || !it.name.trim();
  if (row.hidden) return;
  const busy = ktSearching.has(it);
  const sel = $('.item-kt-select', li);
  $('.item-kt-busy', li).hidden = !busy;
  sel.hidden = busy;
  if (busy) return;
  sel.textContent = '';
  for (const c of it.kt?.candidates || []) {
    const label = `${c.title}${c.brand ? ` (${c.brand})` : ''} · ${fmt(c.kcal)} kcal/100 ${c.unit}`;
    sel.appendChild(Object.assign(document.createElement('option'), { value: c.id, textContent: label }));
  }
  sel.appendChild(Object.assign(document.createElement('option'), { value: '', textContent: t('kt.ownFood') }));
  sel.value = it.kt?.foodId || '';
}

function refreshKtRows() {
  document.querySelectorAll('#items .item').forEach((li) => {
    const it = current?.items[+li.dataset.index];
    if (it) updateKtRow(li, it);
  });
}

// Looks up every item whose search term changed since its last lookup, in one request.
async function searchKt() {
  if (!current || !ktConfigured(settings.kt)) return;
  const todo = current.items.filter((it) => ktQuery(it) && it.kt?.query !== ktQuery(it) && !ktSearching.has(it));
  if (!todo.length) return;
  const queries = todo.map(ktQuery);
  todo.forEach((it) => ktSearching.add(it));
  refreshKtRows();
  try {
    const results = await ktSearch(settings.kt, queries);
    todo.forEach((it, i) => {
      // The name may have changed again while searching; keep the result only if it still fits.
      if (ktQuery(it) !== queries[i]) return;
      const candidates = results[i] || [];
      it.kt = { query: queries[i], candidates, foodId: bestMatch(candidates, it.kcal_100g) };
    });
    saveHistory(); // the items may belong to a meal that is no longer open
  } catch (err) {
    console.error(err);
    if (!$('#result').hidden) setStatus($('#kt-status'), `${t('kt.searchFailed')} ${ktErrorMessage(err)}`, 'error');
  } finally {
    todo.forEach((it) => ktSearching.delete(it));
    refreshKtRows();
  }
}

function renderKt() {
  const ready = ktConfigured(settings.kt);
  $('#kt-form').hidden = !ready;
  $('#kt-setup').hidden = ready;
  const sel = $('#kt-meal');
  sel.textContent = '';
  for (const id of MEALS) sel.appendChild(Object.assign(document.createElement('option'), { value: id, textContent: mealName(id) }));
  // Preselect from the last export, else from when the photo was taken (older meals: analyzed).
  const pre = current.kt || (({ date, mealId }) => ({ date: isoDate(date), mealId }))(defaultMeal(current.takenAt || current.date));
  $('#kt-date').value = pre.date;
  sel.value = pre.mealId;
  if (current.kt) setStatus($('#kt-status'), ktSentText(current.kt), 'ok');
  else setStatus($('#kt-status'), '');
  refreshKtRows();
  searchKt();
}

async function sendToKt() {
  const date = $('#kt-date').value;
  const mealId = $('#kt-meal').value;
  if (!date) { $('#kt-date').focus(); return; }
  const named = current.items.filter((it) => it.name.trim());
  if (!named.length) return;
  // After a partial failure only the unsent items go; a meal already logged asks first (duplicates).
  let pending = named.filter((it) => !it.ktSent);
  if (current.kt || !pending.length) {
    if (!confirm(t('kt.confirmResend'))) return;
    named.forEach((it) => { delete it.ktSent; });
    pending = named;
  }

  const btn = $('#kt-send');
  const st = $('#kt-status');
  btn.disabled = true;
  setStatus(st, t('kt.sending', { n: pending.length }), 'busy');
  try {
    const items = pending.map((it) => {
      const x = itemTotals(it);
      const own = { title: `${it.name.trim()} (${fmt(it.grams)} g)`, kcal: x.kcal, protein: x.p, carbs: x.c, fat: x.f };
      return it.kt?.foodId && it.grams > 0 ? { ...own, foodId: it.kt.foodId, grams: it.grams } : own;
    });
    const results = await ktLog(settings.kt, { date, mealId, items });
    pending.forEach((it, i) => { if (results[i]?.ok) it.ktSent = true; });
    const fellBack = results.filter((r) => r?.own).length;
    const failed = pending.filter((it) => !it.ktSent);
    if (failed.length) {
      persistCurrent();
      setStatus(st, t('kt.partial', { names: failed.map((it) => it.name.trim()).join(', ') }), 'error');
      return;
    }
    current.items.forEach((it) => { delete it.ktSent; });
    current.kt = { date, mealId, at: new Date().toISOString() };
    persistCurrent();
    const msg = ktSentText(current.kt) + (fellBack ? ` ${t('kt.fellBack', { n: fellBack })}` : '');
    setStatus(st, msg, 'ok');
    toast(msg);
  } catch (err) {
    console.error(err);
    setStatus(st, ktErrorMessage(err), 'error');
  } finally {
    btn.disabled = false;
  }
}

function wireKtSettings() {
  const fill = () => {
    $('#kt-proxy').value = ktProxy(settings.kt);
    $('#kt-email').value = settings.kt.email || '';
    $('#kt-password').value = '';
    $('#kt-password').placeholder = settings.kt.passwordHash ? t('kt.passwordSaved') : '';
  };
  fill();
  // Empty or the default means "use the default", so a future change of the default reaches everyone.
  $('#kt-proxy').addEventListener('input', (e) => {
    const v = e.target.value.trim().replace(/\/+$/, '');
    settings.kt.proxy = v === DEFAULT_PROXY ? '' : v;
    saveSettings();
  });
  $('#kt-proxy').addEventListener('change', (e) => { if (!e.target.value.trim()) e.target.value = DEFAULT_PROXY; });
  $('#kt-email').addEventListener('input', (e) => { settings.kt.email = e.target.value.trim(); saveSettings(); });
  // Keep only the hash the site itself sends at login; the password itself is never stored.
  $('#kt-password').addEventListener('change', (e) => {
    if (!e.target.value) return;
    settings.kt.passwordHash = md5(e.target.value);
    saveSettings();
    fill();
  });
  $('#kt-test').addEventListener('click', async () => {
    const pw = $('#kt-password');
    if (pw.value) pw.dispatchEvent(new Event('change'));
    const st = $('#kt-test-status');
    setStatus(st, t('kt.testing'), 'busy');
    try {
      await ktTest(settings.kt);
      setStatus(st, t('kt.loginOk'), 'ok');
    } catch (err) {
      setStatus(st, ktErrorMessage(err), 'error');
    }
  });
  wireKtSettings.refresh = fill;
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
  if (name === 'snap' && current && !$('#result').hidden) renderKt();
  window.scrollTo({ top: 0 });
}

async function changeLang(code) {
  await setLang(code);
  $('#lang-select').value = getLang();
  $('#lang-toggle').textContent = getLang() === 'en' ? 'CS' : 'EN';
  renderProviders();
  renderProviderFields();
  wireKtSettings.refresh?.();
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
  wireKtSettings();
  $('#kt-send').addEventListener('click', sendToKt);
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
