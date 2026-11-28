import { PROVIDERS, ADAPTERS, ProviderError } from './providers.js';
import { LANGS, initialLang, setLang, getLang, t, applyI18n } from './i18n.js';
import { canLiveDictate, canRecord, startDictation, startRecording, toWav16k, withTimeout } from './voice.js';
import { MEALS, KtError, DEFAULT_PROXY, ktProxy, ktConfigured, defaultMeal, isoDate, ktTest, ktLog, ktSearch, rankCandidates, bestMatch, md5 } from './kt.js';

const VERSION = '1.9.0';
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

// History lives in IndexedDB (localStorage is too small for an ever-growing diary), with the
// larger meal photos next to it. Nothing is ever deleted automatically: only by the user.
let history = [];
let historyInIdb = false; // false: IndexedDB unavailable, history kept in localStorage

const idb = {
  db: null,
  open() {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open('meal-snap', 2);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos');
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
      };
      req.onsuccess = () => {
        req.result.onversionchange = () => req.result.close(); // let a newer version upgrade
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    });
    return this.db;
  },
  // Rejects on any failure; callers decide whether that matters.
  async run(storeName, mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const req = fn(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  },
};

async function loadHistory() {
  const legacy = store.get('ms.history', null);
  try {
    let saved = await withTimeout(idb.run('meta', 'readonly', (s) => s.get('history')), 5000);
    if (legacy?.length) {
      // Moving over from localStorage (or entries saved there while IndexedDB was unavailable).
      const ids = new Set((saved || []).map((h) => h.id));
      saved = [...(saved || []), ...legacy.filter((h) => !ids.has(h.id))]
        .sort((a, b) => new Date(b.date) - new Date(a.date));
      await idb.run('meta', 'readwrite', (s) => s.put(saved, 'history'));
    }
    if (legacy) try { localStorage.removeItem('ms.history'); } catch { /* ignore */ }
    history = saved || [];
    historyInIdb = true;
  } catch (e) {
    console.warn('IndexedDB unavailable, history stays in localStorage', e);
    history = legacy || [];
  }
}

// Saves coalesce: while one write runs, further calls just mark the history dirty.
let saving = null;
let dirty = false;
function saveHistory() {
  dirty = true;
  saving ??= (async () => {
    while (dirty) {
      dirty = false;
      try {
        if (historyInIdb) await idb.run('meta', 'readwrite', (s) => s.put(history, 'history'));
        else if (!store.set('ms.history', history)) throw new Error('quota');
      } catch (e) {
        console.error('Saving history failed', e);
        toast(t('toast.storageFull'));
      }
    }
    saving = null;
  })();
}

// Larger meal photos for the history, keyed by history entry id. Every call is guarded:
// without IndexedDB the app falls back to the thumbnail.
const photos = {
  async run(mode, fn) {
    try {
      return await idb.run('photos', mode, fn);
    } catch (e) {
      console.warn('Photo storage unavailable', e);
      return undefined;
    }
  },
  get: (id) => photos.run('readonly', (s) => s.get(id)),
  put: (id, blob) => photos.run('readwrite', (s) => s.put(blob, id)),
  // Delete photos whose history entry is gone (deleted or replaced).
  prune: () => photos.run('readwrite', (s) => {
    const keep = new Set(history.map((h) => h.id));
    s.openKeyCursor().onsuccess = (e) => {
      const c = e.target.result;
      if (!c) return;
      if (!keep.has(c.key)) s.delete(c.key);
      c.continue();
    };
  }),
};

// ---------- state ----------

let photo = null;     // { base64, thumb, view, previewUrl }
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
  return c;
}
const scaledDataUrl = (img, maxSide, quality) => drawScaled(img, maxSide, quality).toDataURL('image/jpeg', quality);
const scaledBlob = (img, maxSide, quality) => new Promise((resolve) => drawScaled(img, maxSide, quality).toBlob(resolve, 'image/jpeg', quality));

// EXIF DateTimeOriginal (local time) and GPS position of a JPEG: { takenAt, coords }, each
// null when missing. Reads only the first 128 KB. Phones often strip GPS from photos handed to a
// browser, so coords are a bonus, not something to rely on.
async function exifInfo(file) {
  const none = { takenAt: null, coords: null };
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
        const takenAt = m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
        let coords = null;
        try {
          const gpsPtr = findTag(ifd0, 0x8825);
          if (gpsPtr >= 0) {
            const gps = u32(gpsPtr + 8);
            // Degrees, minutes, seconds as three rationals; the N/S or E/W letter sits in the entry itself.
            const dms = (tag) => {
              const at = findTag(gps, tag);
              if (at < 0) return NaN;
              const off = u32(at + 8);
              let r = 0;
              for (let i = 0; i < 3; i++) {
                const den = u32(off + i * 8 + 4);
                r += (den ? u32(off + i * 8) / den : 0) / 60 ** i;
              }
              return r;
            };
            const ref = (tag) => { const at = findTag(gps, tag); return at < 0 ? '' : String.fromCharCode(v.getUint8(tiff + at + 8)); };
            const lat = dms(2) * (ref(1) === 'S' ? -1 : 1);
            const lon = dms(4) * (ref(3) === 'W' ? -1 : 1);
            if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat || lon)) coords = { lat, lon };
          }
        } catch { /* malformed GPS block */ }
        return { takenAt, coords };
      }
      if (marker === 0xda) break; // image data starts, no EXIF
      p += 2 + size;
    }
  } catch { /* malformed EXIF */ }
  return none;
}

// When the meal was eaten, for preselecting the meal of the day: the photo's EXIF time, else the
// file date (gallery picks on Android), never in the future. A fresh camera shot gives "now".
async function photoMeta(file) {
  const now = Date.now();
  const { takenAt: exif, coords } = await exifInfo(file);
  const takenAt = exif && !Number.isNaN(exif.getTime()) && exif.getTime() <= now + 60000
    ? exif.getTime()
    : file.lastModified && file.lastModified <= now ? file.lastModified : now;
  return { takenAt, coords };
}

const locationOn = () => settings.location !== false;

// Where the meal was eaten: the photo's GPS, else, for a photo taken just now, the phone's
// current position (asked in the background, never blocking the analysis).
function locatePhoto(p, coords) {
  if (!locationOn()) return;
  if (coords) { p.coords = coords; return; }
  if (Date.now() - p.takenAt > 30 * 60000 || !navigator.geolocation) return;
  p.coordsPromise = new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: false, maximumAge: 10 * 60000, timeout: 15000 },
    );
  });
}

async function onPhotoChosen(file) {
  if (!file) return;
  try {
    const { img, url } = await loadImage(file);
    if (photo?.previewUrl) URL.revokeObjectURL(photo.previewUrl);
    const meta = await photoMeta(file);
    photo = {
      base64: scaledDataUrl(img, 1024, 0.8).split(',')[1],
      thumb: scaledDataUrl(img, 120, 0.7),
      view: await scaledBlob(img, 900, 0.75),
      previewUrl: url,
      takenAt: meta.takenAt,
    };
    locatePhoto(photo, meta.coords);
    $('#photo-preview').src = url;
    $('#photo-preview').hidden = false;
    $('#photo-empty').hidden = true;
    $('#photo-drop').classList.add('has-photo');
    $('#clarify').hidden = true;
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
  $('#clarify').hidden = true;
  $('#analyze').disabled = true;
  setStatus($('#status'), '');
  $('#result').hidden = true;
  $('#composer').hidden = false;
  window.scrollTo({ top: 0 });
}

// ---------- analysis ----------

// The AI may ask one question first (duck or chicken?). Any analysis started while it is shown
// counts as the answer, so it is never asked twice in a row.
function showClarify(question, options) {
  $('#clarify-question').textContent = question;
  const box = $('#clarify-options');
  box.textContent = '';
  for (const opt of options) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'chip', textContent: opt });
    b.addEventListener('click', () => {
      const note = $('#note');
      note.value = [note.value.trim(), `${question} ${opt}`].filter(Boolean).join('\n');
      analyze();
    });
    box.appendChild(b);
  }
  // None of the offered answers fits: the user writes it in the note.
  const other = Object.assign(document.createElement('button'), { type: 'button', className: 'chip', textContent: t('clarify.other') });
  other.addEventListener('click', () => {
    const note = $('#note');
    note.value = [note.value.trim(), `${question} `].filter(Boolean).join('\n');
    note.focus();
    note.setSelectionRange(note.value.length, note.value.length);
    setStatus($('#status'), t('clarify.writeAnswer'));
  });
  box.appendChild(other);
  $('#clarify').hidden = false;
}

// Back from the result to the composer with the same photo and note, to correct and analyze again.
function reanalyze() {
  $('#note').value = current.userNote || '';
  $('#result').hidden = true;
  $('#composer').hidden = false;
  setStatus($('#status'), t('result.reanalyzeHint'));
  window.scrollTo({ top: 0 });
  $('#note').focus();
}

async function analyze() {
  if (!photo) return;
  if (!currentKey()) {
    setStatus($('#status'), t('error.noKey', { provider: PROVIDERS[settings.provider].label }), 'error');
    return;
  }
  const btn = $('#analyze');
  btn.disabled = true;
  const allowQuestion = $('#clarify').hidden;
  $('#clarify').hidden = true;
  setStatus($('#status'), t('snap.analyzing', { provider: PROVIDERS[settings.provider].label }), 'busy');
  try {
    const note = $('#note').value.trim();
    const res = await ADAPTERS[settings.provider].analyze({
      key: currentKey(),
      model: currentModel(),
      imageBase64: photo.base64,
      note,
      lang: getLang(),
      allowQuestion,
    });
    if (allowQuestion && res.question) {
      setStatus($('#status'), '');
      showClarify(res.question, res.options);
      return;
    }
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
    // Analyzing the same photo again replaces its earlier breakdown (keeping whether it was logged).
    const prev = history.findIndex((h) => h.id === photo.entryId);
    if (prev >= 0) {
      if (history[prev].kt) current.kt = history[prev].kt;
      if (history[prev].place) current.place = history[prev].place;
      history.splice(prev, 1);
    }
    photo.entryId = current.id;
    history.unshift(current);
    if (photo.view) await photos.put(current.id, photo.view);
    saveHistory();
    if (prev >= 0) photos.prune();
    attachPlace(current, photo);
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
  const tg = $('#total-grams');
  if (document.activeElement !== tg) tg.value = Math.round(totalGrams(current.items));
}

function totalGrams(items) {
  return items.reduce((a, it) => a + (it.grams || 0), 0);
}

// Scales every item from the weights it had when editing started, so typing digit by digit
// (or passing through 0 or an empty field) never loses the ratios. Rounds to whole grams and
// gives the rounding remainder to the largest item so the items add up to the typed total.
function scaleToTotal(base, target) {
  const baseTotal = base.reduce((a, g) => a + g, 0);
  if (!(baseTotal > 0)) return false;
  const grams = base.map((g) => Math.round(g * target / baseTotal));
  const diff = Math.round(target) - grams.reduce((a, g) => a + g, 0);
  if (diff) {
    const big = base.indexOf(Math.max(...base));
    grams[big] = Math.max(0, grams[big] + diff);
  }
  current.items.forEach((it, i) => { it.grams = grams[i]; });
  return true;
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
  $('#reanalyze').hidden = !photo || photo.entryId !== current.id; // only while its photo is still loaded
  $('#result-thumb').hidden = !current.thumb;
  $('#result-thumb').dataset.id = current.id;
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

  const totalInput = $('#total-grams');
  let baseGrams = null; // item weights when the total started being edited
  totalInput.addEventListener('focus', () => { baseGrams = current.items.map((it) => it.grams || 0); });
  totalInput.addEventListener('input', () => {
    const n = parseFloat(String(totalInput.value).replace(',', '.'));
    if (!baseGrams || !Number.isFinite(n) || n < 0) return;
    if (!scaleToTotal(baseGrams, n)) return;
    document.querySelectorAll('#items .item').forEach((li) => {
      const it = current.items[+li.dataset.index];
      $('.grams input', li).value = it.grams;
      updateItemRow(li, it);
    });
    updateTotals();
    persistCurrent();
  });
  totalInput.addEventListener('blur', () => { baseGrams = null; updateTotals(); });
  totalInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') totalInput.blur(); });

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
  $('#reanalyze').addEventListener('click', reanalyze);
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
      const candidates = rankCandidates(results[i], queries[i], it.kcal_100g);
      it.kt = { query: queries[i], candidates, foodId: bestMatch(candidates) };
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

// ---------- place of the meal ----------

// Coordinates become a readable name through OpenStreetMap's Nominatim (max 1 request per second,
// so lookups run one at a time). Meals eaten at the same spot reuse the name already found.
async function attachPlace(entry, p) {
  if (entry.place) { resolvePlace(entry); return; }
  if (!locationOn()) return;
  const coords = p.coords || await p.coordsPromise;
  if (!coords || entry.place || !history.includes(entry)) return;
  entry.place = { lat: coords.lat, lon: coords.lon };
  saveHistory();
  resolvePlace(entry);
}

function distanceM(a, b) {
  const rad = Math.PI / 180;
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.hypot(x, y) * 6371000;
}

async function reverseGeocode({ lat, lon }) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&accept-language=${getLang()}`;
  const res = await withTimeout(fetch(url), 10000);
  if (!res.ok) throw new Error(`nominatim ${res.status}`);
  const d = await res.json();
  const a = d.address || {};
  const town = a.city || a.town || a.village || a.municipality || a.suburb || '';
  const street = a.road ? `${a.road}${a.house_number ? ` ${a.house_number}` : ''}` : '';
  const poi = d.name && d.name !== town && d.name !== a.road ? d.name : '';
  return [poi || street, town].filter(Boolean).join(', ')
    || (d.display_name || '').split(',').slice(0, 2).join(',').trim()
    || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

const placeQueue = [];
let placeBusy = false;
let placeRetryAt = 0; // after a failed lookup, wait before trying again

function resolvePlace(h) {
  if (!h.place || h.place.name || placeQueue.includes(h) || Date.now() < placeRetryAt) return;
  placeQueue.push(h);
  pumpPlaces();
}

async function pumpPlaces() {
  if (placeBusy) return;
  placeBusy = true;
  while (placeQueue.length) {
    const h = placeQueue.shift();
    if (!history.includes(h) || !h.place || h.place.name) continue;
    const near = history.find((x) => x !== h && x.place?.name && distanceM(x.place, h.place) < 75);
    try {
      h.place.name = near ? near.place.name : await reverseGeocode(h.place);
    } catch (e) {
      // Offline or refused: stop for now; unnamed places are retried when History is shown.
      console.warn('Place lookup failed', e);
      placeQueue.length = 0;
      placeRetryAt = Date.now() + 60000;
      break;
    }
    saveHistory();
    if ($('#view-history').classList.contains('active')) renderHistory();
    if (!near) await new Promise((r) => setTimeout(r, 1100));
  }
  placeBusy = false;
}

const mapUrl = ({ lat, lon }) => `https://mapy.com/fnc/v1/showmap?mapset=basic&center=${lon},${lat}&zoom=17&marker=true`;

// ---------- history view ----------

let historyQuery = '';
let historyDays = 30;   // day groups shown; "Show older" adds more
let chartPick = null;   // day selected in the chart
let macroPeriod = store.get('ms.macroPeriod', 7) === 30 ? 30 : 7; // days in the macro breakdown

const locale = () => (getLang() === 'cs' ? 'cs-CZ' : 'en-US');
const fold = (s) => (s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const mealTime = (h) => new Date(h.takenAt || h.date).getTime();

// The day and meal of the day an entry belongs to: as logged to KT, else from when it was eaten
// (just after midnight still counts as the previous evening, the same rule as the KT preselect).
function mealSlot(h) {
  if (h.kt?.date) return { day: h.kt.date, mealId: h.kt.mealId };
  const { date, mealId } = defaultMeal(mealTime(h));
  return { day: isoDate(date), mealId };
}

function entryTotals(h) {
  return h.items.reduce((a, it) => {
    const x = itemTotals(it);
    return { kcal: a.kcal + x.kcal, p: a.p + x.p, c: a.c + x.c, f: a.f + x.f };
  }, { kcal: 0, p: 0, c: 0, f: 0 });
}

const dayDate = (day) => new Date(`${day}T12:00`);
function dayLabel(day, short = false) {
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (!short && day === isoDate(new Date())) return t('history.today');
  if (!short && day === isoDate(y)) return t('history.yesterday');
  const d = dayDate(day);
  const opts = { weekday: 'short', day: 'numeric', month: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return new Intl.DateTimeFormat(locale(), opts).format(d);
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

const PIN_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7Zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5Z"/></svg>';
const TRASH_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12ZM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4Z"/></svg>';

function placeLink(h) {
  if (!h.place) return null;
  const a = el('a', 'place');
  a.href = mapUrl(h.place);
  a.target = '_blank';
  a.rel = 'noopener';
  a.innerHTML = PIN_SVG;
  a.append(el('span', null, h.place.name || t('history.placeLoading')));
  return a;
}

function historyRow(e, timeFmt) {
  const { h } = e;
  const li = el('li', 'card');
  li.dataset.id = h.id;
  li.tabIndex = 0;
  li.setAttribute('role', 'button');
  let media;
  if (h.thumb) {
    media = el('button', 'thumb');
    media.type = 'button';
    media.setAttribute('aria-label', t('history.showPhoto'));
    media.appendChild(Object.assign(document.createElement('img'), { src: h.thumb, alt: '' }));
  } else {
    media = el('div', 'ph');
  }
  const meta = el('div', 'meta');
  const small = el('small', null, `${timeFmt.format(new Date(e.time))} · ${mealName(e.mealId)} · ${t('history.items', { n: h.items.length })}`);
  if (h.kt) small.append(' ', el('span', 'kt-badge', t('history.ktLogged')));
  meta.append(el('strong', null, h.dish || t('history.untitled')), small);
  const place = placeLink(h);
  if (place) meta.append(place);
  const side = el('div', 'side');
  const del = el('button', 'icon-btn small delete');
  del.type = 'button';
  del.innerHTML = TRASH_SVG;
  del.setAttribute('aria-label', t('history.delete'));
  del.title = t('history.delete');
  side.append(el('span', 'kc', `${fmt(e.totals.kcal)} kcal`), del);
  li.append(media, meta, side);
  return li;
}

function lastDays(n) {
  const out = [];
  const d = new Date();
  for (let i = 0; i < n; i++) { out.push(isoDate(d)); d.setDate(d.getDate() - 1); }
  return out;
}

const historyEntries = () => history.map((h) => ({ h, time: mealTime(h), ...mealSlot(h), totals: entryTotals(h) }));

// Day totals { kcal, p, c, f } keyed by ISO day.
function totalsByDay(all) {
  const byDay = new Map();
  for (const e of all) {
    const a = byDay.get(e.day) || { kcal: 0, p: 0, c: 0, f: 0 };
    byDay.set(e.day, { kcal: a.kcal + e.totals.kcal, p: a.p + e.totals.p, c: a.c + e.totals.c, f: a.f + e.totals.f });
  }
  return byDay;
}

function renderSummary(all, days) {
  const byDay = new Map([...days].map(([k, v]) => [k, v.kcal]));
  // Averages count only days with a record: a day without photos is unknown, not zero.
  const avg = (n) => {
    const vals = lastDays(n).filter((k) => byDay.has(k)).map((k) => byDay.get(k));
    return vals.length ? { kcal: vals.reduce((a, b) => a + b, 0) / vals.length, n: vals.length } : null;
  };
  const stat = (id, a) => {
    $(`#${id}`).textContent = a ? fmt(a.kcal) : '–';
    $(`#${id}-days`).textContent = a ? t('overview.summary.days', { n: a.n }) : t('overview.summary.noData');
  };
  stat('sum-avg7', avg(7));
  stat('sum-avg30', avg(30));
  const week = new Set(lastDays(7));
  $('#sum-meals').textContent = fmt(all.filter((e) => week.has(e.day)).length);

  // Last 14 days, oldest on the left, bars scaled to the highest day.
  const last = lastDays(14).reverse();
  const max = Math.max(1, ...last.map((k) => byDay.get(k) || 0));
  const chart = $('#sum-chart');
  chart.textContent = '';
  const today = isoDate(new Date());
  for (const k of last) {
    const v = byDay.get(k) || 0;
    const col = el('button', 'bar-col');
    col.type = 'button';
    col.dataset.day = k;
    col.classList.toggle('picked', chartPick === k);
    col.classList.toggle('today', k === today);
    col.setAttribute('aria-label', `${dayLabel(k, true)}: ${v ? `${fmt(v)} kcal` : t('overview.summary.noRecord')}`);
    const bar = el('span', v ? 'bar' : 'bar none');
    if (v) bar.style.height = `${Math.max(3, (v / max) * 100)}%`;
    const plot = el('span', 'plot');
    plot.append(bar);
    col.append(plot, el('span', 'bar-label', String(dayDate(k).getDate())));
    chart.append(col);
  }
  const picked = last.includes(chartPick) ? chartPick : null;
  $('#sum-readout').textContent = picked
    ? `${dayLabel(picked, true)}: ${byDay.get(picked) ? `${fmt(byDay.get(picked))} kcal` : t('overview.summary.noRecord')}`
    : t('overview.summary.chart', { max: fmt(max) });
}

// Recommended share of energy (%) from each macronutrient per goal, independent of weight,
// height, age or sex. "lose" is the split Kalorické tabulky sets for weight loss (e.g. 139 g
// protein, 213 g carbs, 62.8 g fat = 28 / 43 / 29 %); "maintain" is a balanced split within the
// EFSA/WHO ranges; "gain" adds protein and carbs for building muscle. A share within 5 points of
// the target counts as on target.
const GOALS = {
  lose: { p: 28, c: 43, f: 29 },
  maintain: { p: 20, c: 50, f: 30 },
  gain: { p: 25, c: 50, f: 25 },
};
const MACRO_TOLERANCE = 5;
const currentGoal = () => (GOALS[settings.goal] ? settings.goal : 'lose');
const KCAL_PER_G = { p: 4, c: 4, f: 9 };
const TRACK_MAX = 70; // the bars show 0-70 % of energy

const joinList = (parts) => {
  try { return new Intl.ListFormat(locale(), { type: 'conjunction' }).format(parts); } catch { return parts.join(', '); }
};

function renderMacros(days) {
  const keys = lastDays(macroPeriod).filter((k) => days.has(k));
  document.querySelectorAll('#macro-card .seg button').forEach((b) => {
    b.setAttribute('aria-pressed', String(Number(b.dataset.period) === macroPeriod));
  });
  const rows = $('#macro-rows');
  rows.textContent = '';
  const verdict = $('#macro-verdict');
  verdict.className = 'macro-verdict';
  const sum = keys.reduce((a, k) => {
    const d = days.get(k);
    return { p: a.p + d.p, c: a.c + d.c, f: a.f + d.f };
  }, { p: 0, c: 0, f: 0 });
  const energy = { p: sum.p * KCAL_PER_G.p, c: sum.c * KCAL_PER_G.c, f: sum.f * KCAL_PER_G.f };
  const total = energy.p + energy.c + energy.f;
  const goal = currentGoal();
  const target = GOALS[goal];
  $('#macro-goal').textContent = t('overview.macros.goal', { goal: t(`settings.goal.${goal}`) });
  $('#macro-source').textContent = t(`overview.macros.source.${goal}`, { ...target, tol: MACRO_TOLERANCE });
  $('#macro-days').textContent = keys.length ? t('overview.summary.days', { n: keys.length }) : '';
  if (!keys.length || total <= 0) {
    verdict.textContent = t('overview.macros.noData', { n: macroPeriod });
    return;
  }

  const off = { low: [], high: [] };
  for (const m of ['p', 'c', 'f']) {
    const pct = (energy[m] / total) * 100;
    const [lo, hi] = [target[m] - MACRO_TOLERANCE, target[m] + MACRO_TOLERANCE];
    const state = pct < lo ? 'low' : pct > hi ? 'high' : 'ok';
    if (state !== 'ok') off[state].push(t(`overview.macros.gen.${m}`));
    const name = t(`overview.macros.name.${m}`);
    const grams = `${fmt(sum[m] / keys.length)} ${t('overview.macros.perDay')}`;
    const row = el('div', 'macro-row');
    row.setAttribute('role', 'img');
    row.setAttribute('aria-label', `${name}: ${grams}, ${t('overview.macros.share', { pct: fmt(pct), target: target[m], min: lo, max: hi })}, ${t(`overview.macros.${state}`)}`);
    const line = el('div', 'macro-line');
    const pctEl = el('span', 'macro-pct');
    pctEl.append(el('strong', null, `${fmt(pct)} %`), ' ', el('span', `macro-state ${state}`, t(`overview.macros.${state}`)));
    line.append(el('span', 'macro-name', name), el('span', 'macro-grams', grams), pctEl);
    const track = el('div', 'macro-track');
    const band = el('span', 'macro-band');
    band.style.left = `${(lo / TRACK_MAX) * 100}%`;
    band.style.width = `${((hi - lo) / TRACK_MAX) * 100}%`;
    const mark = el('span', `macro-mark ${state}`);
    mark.style.left = `${(Math.min(pct, TRACK_MAX) / TRACK_MAX) * 100}%`;
    track.append(band, mark);
    row.append(line, track, el('small', 'macro-ref', t('overview.macros.ref', { target: target[m], min: lo, max: hi })));
    rows.append(row);
  }

  const parts = [
    ...off.high.map((what) => t('overview.macros.tooMuch', { what })),
    ...off.low.map((what) => t('overview.macros.tooLittle', { what })),
  ];
  verdict.classList.add(parts.length ? 'off' : 'ok');
  verdict.textContent = parts.length
    ? t('overview.macros.verdict', { list: joinList(parts) })
    : t('overview.macros.verdictOk');
}

function renderOverview() {
  const has = history.length > 0;
  $('#overview-empty').hidden = has;
  $('#overview-summary').hidden = !has;
  $('#macro-card').hidden = !has;
  if (!has) return;
  const all = historyEntries();
  const days = totalsByDay(all);
  renderSummary(all, days);
  renderMacros(days);
}

function wireOverview() {
  // The first tap on a bar shows its value, a second tap opens that day in History.
  $('#sum-chart').addEventListener('click', (e) => {
    const col = e.target.closest('.bar-col');
    if (!col) return;
    const day = col.dataset.day;
    if (chartPick === day) {
      historyQuery = '';
      $('#history-search').value = '';
      showView('history');
      document.getElementById(`day-${day}`)?.scrollIntoView({ block: 'start' });
      return;
    }
    chartPick = day;
    renderOverview();
    document.querySelector(`#sum-chart [data-day="${day}"]`)?.focus();
  });
  $('#macro-card .seg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-period]');
    if (!b) return;
    macroPeriod = Number(b.dataset.period) === 30 ? 30 : 7;
    store.set('ms.macroPeriod', macroPeriod);
    renderOverview();
  });
}

function renderHistory() {
  const list = $('#history-list');
  list.textContent = '';
  const has = history.length > 0;
  $('#history-empty').hidden = has;
  $('#history-clear').hidden = !has;
  $('#history-tools').hidden = !has;
  $('#history-more').hidden = true;
  $('#history-nomatch').hidden = true;
  if (!has) return;

  const all = historyEntries();

  const q = fold(historyQuery.trim());
  const found = q ? all.filter(({ h }) => fold(h.dish).includes(q) || h.items.some((it) => fold(it.name).includes(q))) : all;
  $('#history-found').textContent = q ? t('history.found', { n: found.length }) : '';
  $('#history-nomatch').hidden = found.length > 0;

  const groups = new Map();
  for (const e of found.sort((a, b) => b.time - a.time)) {
    if (!groups.has(e.day)) groups.set(e.day, []);
    groups.get(e.day).push(e);
  }
  const days = [...groups.keys()].sort().reverse();
  const timeFmt = new Intl.DateTimeFormat(locale(), { hour: 'numeric', minute: '2-digit' });
  for (const day of days.slice(0, historyDays)) {
    const entries = groups.get(day);
    const sum = entries.reduce((a, e) => ({
      kcal: a.kcal + e.totals.kcal, p: a.p + e.totals.p, c: a.c + e.totals.c, f: a.f + e.totals.f,
    }), { kcal: 0, p: 0, c: 0, f: 0 });
    const sec = el('section', 'day');
    sec.id = `day-${day}`;
    const head = el('h2', 'day-head');
    const totals = el('span', 'day-totals');
    totals.append(el('strong', null, `${fmt(sum.kcal)} kcal`),
      el('small', null, `${t('macro.p')} ${fmt(sum.p)} · ${t('macro.c')} ${fmt(sum.c)} · ${t('macro.f')} ${fmt(sum.f)} g`));
    head.append(el('span', 'day-title', dayLabel(day)), totals);
    const ul = el('ul', 'history');
    for (const e of entries) {
      ul.append(historyRow(e, timeFmt));
      if (e.h.place && !e.h.place.name && navigator.onLine !== false) resolvePlace(e.h);
    }
    sec.append(head, ul);
    list.append(sec);
  }
  $('#history-more').hidden = days.length <= historyDays;
}

// Deletes one meal (and its photo) after the user confirms. Nothing else ever removes meals.
function deleteEntry(id) {
  const h = history.find((x) => x.id === id);
  if (!h || !confirm(t('history.confirmDelete', { dish: h.dish || t('history.untitled') }))) return false;
  history = history.filter((x) => x !== h);
  saveHistory();
  photos.prune();
  if (current?.id === id) resetComposer();
  return true;
}

function wireHistory() {
  const find = (li) => history.find((x) => x.id === li.dataset.id);
  const open = (li) => {
    const h = find(li);
    if (!h) return;
    current = h;
    showView('snap');
    showResult();
  };
  $('#history-list').addEventListener('click', (e) => {
    if (e.target.closest('a')) return; // the place opens the map
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    if (e.target.closest('.delete')) { if (deleteEntry(li.dataset.id)) renderHistory(); }
    else if (e.target.closest('.thumb')) showPhoto(find(li));
    else open(li);
  });
  $('#history-list').addEventListener('keydown', (e) => {
    if (!e.target.matches('li[data-id]')) return; // buttons and links handle their own keys
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e.target); }
  });
  $('#history-search').addEventListener('input', (e) => {
    historyQuery = e.target.value;
    historyDays = 30;
    renderHistory();
  });
  $('#history-more').addEventListener('click', () => {
    historyDays += 30;
    renderHistory();
  });
  $('#history-clear').addEventListener('click', () => {
    if (!confirm(t('history.confirmClear'))) return;
    history = [];
    saveHistory();
    photos.prune();
    renderHistory();
    if (current) resetComposer();
  });
  $('#delete-current').addEventListener('click', () => {
    if (current) deleteEntry(current.id);
  });
}

// ---------- photo viewer ----------

// Full-screen view of a meal photo; the stored larger photo, else the thumbnail (older meals).
async function showPhoto(h) {
  if (!h?.thumb) return;
  const box = $('#lightbox');
  const img = $('#lightbox-img');
  closePhoto();
  img.src = h.thumb;
  const dateFmt = new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' });
  $('#lightbox-caption').textContent = [h.dish || t('history.untitled'), dateFmt.format(new Date(h.takenAt || h.date)), h.place?.name]
    .filter(Boolean).join(' · ');
  box.showModal();
  const blob = await photos.get(h.id);
  if (blob && box.open) {
    img.dataset.url = URL.createObjectURL(blob);
    img.src = img.dataset.url;
  }
}

function closePhoto() {
  const img = $('#lightbox-img');
  if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
  delete img.dataset.url;
  if ($('#lightbox').open) $('#lightbox').close();
}

function wireLightbox() {
  $('#lightbox').addEventListener('click', closePhoto);
  $('#lightbox').addEventListener('close', closePhoto);
  $('#result-thumb').addEventListener('click', () => showPhoto(current));
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
  const loc = $('#location-toggle');
  loc.checked = locationOn();
  loc.addEventListener('change', () => {
    settings.location = loc.checked;
    saveSettings();
  });
  const goalSel = $('#goal-select');
  goalSel.addEventListener('change', () => {
    settings.goal = goalSel.value;
    saveSettings();
    renderGoals();
  });
  renderGoals();
  const sel = $('#lang-select');
  for (const [code, name] of Object.entries(LANGS)) sel.appendChild(Object.assign(document.createElement('option'), { value: code, textContent: name }));
  sel.addEventListener('change', () => changeLang(sel.value));
}

function renderGoals() {
  const goalSel = $('#goal-select');
  const goal = currentGoal();
  goalSel.textContent = '';
  for (const id of Object.keys(GOALS)) {
    goalSel.appendChild(Object.assign(document.createElement('option'), { value: id, textContent: t(`settings.goal.${id}`) }));
  }
  goalSel.value = goal;
  $('#goal-hint').textContent = t('settings.goalHint', GOALS[goal]);
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
  if (name === 'overview') renderOverview();
  if (name === 'snap' && current && !$('#result').hidden) renderKt();
  window.scrollTo({ top: 0 });
}

async function changeLang(code) {
  await setLang(code);
  $('#lang-select').value = getLang();
  $('#lang-toggle').textContent = getLang() === 'en' ? 'CS' : 'EN';
  renderProviders();
  renderProviderFields();
  renderGoals();
  wireKtSettings.refresh?.();
  if (current && !$('#result').hidden) showResult();
  if ($('#view-history').classList.contains('active')) renderHistory();
  if ($('#view-overview').classList.contains('active')) renderOverview();
}

// ---------- share link ----------

// The app's own address, derived from where it is served, so self-hosted copies share their own URL.
function appUrl() {
  const u = new URL('./', location.href);
  u.search = '';
  u.hash = '';
  return u.href;
}

function wireShareLink() {
  const url = appUrl();
  const input = $('#share-url');
  input.value = url;
  input.addEventListener('focus', () => input.select());
  $('#share-copy').addEventListener('click', () => copyText(url));
  if (navigator.share) {
    const btn = $('#share-native');
    btn.hidden = false;
    btn.addEventListener('click', () => {
      navigator.share({ title: 'Meal Snap', url }).catch(() => {});
    });
  }
}

// ---------- boot ----------

async function init() {
  $('#app-version').textContent = VERSION;
  wireShareLink();
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-goto]');
    if (go) showView(go.dataset.goto);
  });
  $('#lang-toggle').addEventListener('click', () => changeLang(getLang() === 'en' ? 'cs' : 'en'));
  $('#photo-input').addEventListener('change', (e) => onPhotoChosen(e.target.files[0]));
  $('#analyze').addEventListener('click', analyze);
  $('#clarify-skip').addEventListener('click', analyze);

  wireResult();
  wireVoice();
  wireHistory();
  wireOverview();
  wireLightbox();
  wireSettings();
  wireKtSettings();
  $('#kt-send').addEventListener('click', sendToKt);
  await changeLang(initialLang());
  await loadHistory();
  photos.prune();
  navigator.storage?.persist?.().catch(() => {});
  if ($('#view-history').classList.contains('active')) renderHistory();
  if ($('#view-overview').classList.contains('active')) renderOverview();

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
