// Kalorické tabulky export. The site can't be called from the browser (no CORS, HttpOnly session),
// so requests go through the user's own proxy (worker/kt-proxy.js), which logs in and writes
// each item as an "own food" diary entry.
//   ktTest(cfg)                         -> resolves if the login works
//   ktLog(cfg, { date, mealId, items }) -> [{ ok, error? }] per item
// cfg = { proxy, email, passwordHash }. Only the MD5 hash of the password is stored: that is what
// the site itself sends at login (so it still unlocks the account, but the password isn't kept as text).

import { withTimeout } from './voice.js';

// diaryTimeGuid values on kaloricketabulky.cz
export const MEALS = ['1', '2', '3', '4', '5', '6']; // breakfast, morning snack, lunch, afternoon snack, dinner, second dinner

// Proxy run by the app's author; users can point the app at their own deployment instead.
export const DEFAULT_PROXY = 'https://meal-snap-kt.globus-01e.workers.dev';

export class KtError extends Error {
  // code: notConfigured | auth | network | timeout | upstream | proxy | rateLimited
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export const ktProxy = (cfg) => cfg?.proxy || DEFAULT_PROXY;
export const ktConfigured = (cfg) => Boolean(cfg?.email && cfg.passwordHash);

// Meal of the day preselected from the time the meal was eaten. Just after midnight still counts
// as the previous day's second dinner.
export function defaultMeal(when) {
  const d = new Date(when);
  const m = d.getHours() * 60 + d.getMinutes();
  if (m < 4 * 60) {
    d.setDate(d.getDate() - 1);
    return { date: d, mealId: '6' };
  }
  const mealId = m < 10 * 60 ? '1' : m < 11 * 60 + 30 ? '2' : m < 14 * 60 ? '3' : m < 17 * 60 ? '4' : m < 20 * 60 + 30 ? '5' : '6';
  return { date: d, mealId };
}

const pad = (n) => String(n).padStart(2, '0');
export const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const ktDate = (iso) => iso.split('-').reverse().join('.'); // yyyy-MM-dd -> dd.MM.yyyy

async function call(cfg, path, body, needsLogin = true) {
  if (needsLogin && !ktConfigured(cfg)) throw new KtError('notConfigured');
  let res;
  try {
    res = await withTimeout(fetch(`${ktProxy(cfg).replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(needsLogin ? { email: cfg.email, passwordHash: cfg.passwordHash, ...body } : body),
    }), 60000);
  } catch (e) {
    throw new KtError(e.message === 'timeout' ? 'timeout' : 'network');
  }
  let data = null;
  try { data = await res.json(); } catch { /* not our proxy */ }
  if (!data || typeof data.ok !== 'boolean') throw new KtError('proxy');
  if (!data.ok) throw new KtError(['auth', 'upstream', 'rateLimited'].includes(data.error) ? data.error : 'proxy');
  return data;
}

export const ktTest = (cfg) => call(cfg, '/login-test', {});

// Database candidates for each query: [[{id, title, brand, kcal, unit}]]. Needs no login.
export async function ktSearch(cfg, queries) {
  const data = await call(cfg, '/search', { queries }, false);
  return data.results;
}

// ---------- picking the database food ----------
// The database also lists whole dishes ("Barbecue pečené kuřecí stehno dušená rýže"), which must
// not be logged for a single ingredient: the other parts of the plate are separate items already.

const words = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .split(/[^a-z0-9%]+/).filter(Boolean);
const STOP = new Set(['bez', 'pro', 'the', 'cca', 'typ', 'kus', 'ks']);
const LINKS = new Set(['s', 'se', 'a', 'with', 'and']);
// Side dishes, sauces and the like: a title adding one of these is a meal, not one food.
const SIDES = ['ryz', 'bramb', 'hranol', 'knedl', 'testov', 'spaget', 'nudl', 'kase', 'omack', 'zeli', 'salat',
  'chleb', 'peciv', 'rohl', 'kusk', 'bulgur', 'kroket', 'rizot', 'zelen', 'dresink', 'kecup', 'tatar', 'menu', 'porce'];
const stem = (w) => w.slice(0, 4);

function judge(c, query) {
  const title = words(c.title);
  const extra = title.filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d/.test(w) && !query.stems.has(stem(w)));
  const linked = title.some((w) => LINKS.has(w)) || /\+/.test(c.title);
  return {
    dish: extra.length >= 3 || extra.some((w) => SIDES.some((s) => w.startsWith(s))) || (linked && extra.length >= 2),
    // "Párek v rohlíku" is about something else than "rohlík"
    offLead: Boolean(title.length && query.lead && stem(title[0]) !== query.lead),
    // a raw food for a cooked portion is a worse fit than another extra word
    extra: extra.length + extra.filter((w) => /^(syrov|surov)/.test(w)).length,
  };
}

// Candidates in the order to offer them: single foods before dishes, energy close to the AI
// estimate, title led by the query's main word, fewest words beyond the query, then the site's
// own ranking. Each gets `dish: true|false`.
export function rankCandidates(candidates, query, kcal100) {
  const q = words(query);
  const qinfo = { stems: new Set(q.map(stem)), lead: q[0] && stem(q[0]) };
  const far = (c) => kcal100 > 0 && !(c.kcal > 0 && Math.abs(c.kcal - kcal100) / kcal100 <= 0.35);
  return (candidates || [])
    .map((c, i) => ({ c, i, far: far(c), ...judge(c, qinfo) }))
    .sort((a, b) => a.dish - b.dish || a.far - b.far || a.offLead - b.offLead || a.extra - b.extra || a.i - b.i)
    .map(({ c, dish }) => ({ ...c, dish }));
}

// The id to preselect from ranked candidates, or null for own food (when there are only dishes).
export const bestMatch = (ranked) => (ranked?.[0] && !ranked[0].dish ? ranked[0].id : null);

export async function ktLog(cfg, { date, mealId, items }) {
  const data = await call(cfg, '/log', { date: ktDate(date), mealId, items });
  return data.results;
}

// ---------- MD5 (RFC 1321) of the UTF-8 string, lowercase hex ----------

export function md5(str) {
  const bytes = new TextEncoder().encode(str);
  const len = bytes.length;
  const words = new Uint32Array((((len + 8) >>> 6) + 1) * 16);
  for (let i = 0; i < len; i++) words[i >> 2] |= bytes[i] << ((i % 4) * 8);
  words[len >> 2] |= 0x80 << ((len % 4) * 8);
  words[words.length - 2] = len * 8;
  words[words.length - 1] = Math.floor(len / 0x20000000);

  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  for (let off = 0; off < words.length; off += 16) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      const r = i >> 4;
      let f, g;
      if (r === 0) { f = (b & c) | (~b & d); g = i; }
      else if (r === 1) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (r === 2) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const tmp = d;
      d = c;
      c = b;
      const x = (a + f + K[i] + words[off + g]) >>> 0;
      const s = S[r * 4 + (i % 4)];
      b = (b + ((x << s) | (x >>> (32 - s)))) >>> 0;
      a = tmp;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  return [a0, b0, c0, d0]
    .map((w) => [0, 8, 16, 24].map((sh) => ((w >>> sh) & 0xff).toString(16).padStart(2, '0')).join(''))
    .join('');
}
