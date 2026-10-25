// Meal Snap -> Kalorické tabulky proxy (Cloudflare Worker).
// kaloricketabulky.cz rejects cross-origin requests and keeps its session in an HttpOnly cookie,
// so the browser app cannot write to the diary itself. This worker logs in on each request,
// writes the items to the diary and forgets everything afterwards (no storage).
//
// Endpoints (JSON in, JSON out):
//   POST /search     {queries: string[]}                            -> {ok: true, results: [[candidate]]}
//     candidate: {id, title, brand, kcal (per 100 g/ml), unit: 'g' | 'ml'}; no login needed
//   POST /login-test {email, passwordHash}                          -> {ok: true}
//   POST /log        {email, passwordHash, date, mealId, items[]}   -> {ok: true, results: [{ok, own?, error?}]}
//     date: 'dd.MM.yyyy', mealId: '1'..'6',
//     items: [{title, kcal, protein, carbs, fat, foodId?, grams?}]
//     With foodId the database food is logged in grams (or ml); otherwise, or when the food can't be
//     loaded, an "own food" entry with the given totals is written (own: true).
// Errors: {ok: false, error: 'auth' | 'upstream' | 'badRequest' | 'origin' | 'rateLimited'}
//
// Env: ALLOWED_ORIGINS = comma-separated list of origins allowed to call it,
//      e.g. "https://you.github.io,http://localhost:8000".
//      LOGIN_LIMITER = optional rate limiting binding (see wrangler.toml). The Origin check only
//      stops other websites; anyone can call the worker directly, so this caps requests per IP to keep
//      it from being used to try passwords against kaloricketabulky.cz.
// The KT endpoints are unofficial (read from the site's own frontend) and may change.

const KT = 'https://www.kaloricketabulky.cz';
const MEALS = ['1', '2', '3', '4', '5', '6'];
const MAX_ITEMS = 30;
const MAX_CANDIDATES = 8;
const BASE_UNITS = ['0000000000000001', '0000000000000002']; // 1 g, 1 ml

class ProxyError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin') || '';
  const list = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : '';
}

function json(body, status, origin) {
  const headers = { 'Content-Type': 'application/json', Vary: 'Origin' };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return new Response(JSON.stringify(body), { status, headers });
}

// ---------- kaloricketabulky.cz session ----------

async function ktFetch(session, path, body) {
  const headers = { Accept: 'application/json' };
  if (session.cookie) headers.Cookie = session.cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(KT + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  // Keep the newest JSESSIONID; the site rotates it after login.
  for (const [name, value] of res.headers) {
    if (name.toLowerCase() === 'set-cookie' && value.startsWith('JSESSIONID=')) session.cookie = value.split(';')[0];
  }
  if (res.status >= 300 && res.status < 400) {
    throw new ProxyError((res.headers.get('Location') || '').includes('/login') ? 'auth' : 'upstream');
  }
  if (!res.ok) throw new ProxyError(res.status === 401 || res.status === 403 ? 'auth' : 'upstream');
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { throw new ProxyError('upstream'); }
  // Spring envelope {code, message, data}; code 0 = success. Some routes return the payload bare.
  if (data && typeof data === 'object' && 'code' in data && 'data' in data) {
    if (data.code !== 0) throw new ProxyError('upstream');
    return data.data;
  }
  return data;
}

async function login(email, passwordHash) {
  const session = { cookie: '' };
  try {
    await ktFetch(session, '/login/create?format=json', { email, password: passwordHash });
  } catch (e) {
    throw e.code === 'upstream' ? new ProxyError('auth') : e;
  }
  if (!session.cookie) throw new ProxyError('auth');
  return session;
}

// ---------- search ----------

async function searchOne(query) {
  const rows = await ktFetch({}, `/autocomplete/foodstuff-activity-meal?format=json&query=${encodeURIComponent(query)}`);
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.clazz === 'foodstuff' && r.id)
    .slice(0, MAX_CANDIDATES)
    .map((r) => {
      const v = parseFloat(String(r.value).replace(',', '.')) || 0;
      return {
        id: String(r.id),
        title: String(r.title || ''),
        brand: r.brandName ? String(r.brandName) : '',
        kcal: Math.round(String(r.energyUnit).toLowerCase() === 'kj' ? v / 4.184 : v),
        unit: r.unit === 'ml' ? 'ml' : 'g',
      };
    });
}

// A long query ("kuřecí prsa grilovaná bez kůže") may match nothing; retry with fewer words.
async function search(query) {
  const words = query.trim().split(/\s+/).filter(Boolean);
  for (const n of [words.length, Math.min(2, words.length - 1), 1]) {
    if (n < 1) continue;
    const found = await searchOne(words.slice(0, n).join(' '));
    if (found.length) return found;
    if (n === 1) break;
  }
  return [];
}

// ---------- logging ----------

const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

async function logOwnFood(session, ctx, it) {
  ctx.ownForm ||= await ktFetch(session, '/user/foodstuff/add/form/0?format=json');
  const form = ctx.ownForm;
  if (!form || typeof form !== 'object') throw new ProxyError('upstream');
  const kj = String(form.energyUnit || '').toLowerCase() === 'kj';
  await ktFetch(session, '/user/foodstuff/add?format=json&=', {
    ...form,
    title: String(it.title).slice(0, 200),
    energy: kj ? Math.round(it.kcal * 4.184) : round1(it.kcal),
    protein: round1(it.protein),
    carbohydrate: round1(it.carbs),
    fat: round1(it.fat),
    diaryTimeGuid: ctx.mealId,
    date: ctx.date,
  });
}

// Returns false when the food can't be loaded, so the caller falls back to an own-food entry.
async function logDatabaseFood(session, ctx, it) {
  let form;
  try {
    form = await ktFetch(session, `/foodstuff/detail/form/${encodeURIComponent(it.foodId)}?format=json&default=true`);
  } catch (e) {
    if (e.code === 'auth') throw e;
    return false;
  }
  const units = Array.isArray(form?.unitOptions) ? form.unitOptions : [];
  // The site echoes unknown ids back, so an empty unit list is the reliable "not found" signal.
  if (!form?.guid || !units.length) return false;
  const unit = units.find((u) => BASE_UNITS.includes(u.id)) || units.find((u) => Number(u.multiplier) === 1) || units[0];
  const per = Number(unit.multiplier) || 1;
  await ktFetch(session, '/user/foodstuff/add?format=json&=', {
    ...form,
    multiplier: Math.round((it.grams / per) * 100) / 100,
    unitGuid: unit.id,
    diaryTimeGuid: ctx.mealId,
    date: ctx.date,
  });
  return true;
}

async function logItems(session, { date, mealId, items }) {
  const ctx = { date, mealId, ownForm: null };
  const results = [];
  // One at a time: this is someone else's unofficial API.
  for (const it of items) {
    try {
      if (it.foodId && await logDatabaseFood(session, ctx, it)) {
        results.push({ ok: true });
      } else {
        await logOwnFood(session, ctx, it);
        results.push({ ok: true, own: Boolean(it.foodId) });
      }
    } catch (e) {
      if (e.code === 'auth') throw e;
      results.push({ ok: false, error: e.code || 'upstream' });
    }
  }
  return results;
}

// ---------- request handling ----------

function validCredentials(b) {
  return typeof b.email === 'string' && b.email.includes('@') && /^[0-9a-f]{32}$/.test(b.passwordHash || '');
}

function validItem(it) {
  if (!it || typeof it.title !== 'string' || !it.title.trim() || !Number.isFinite(Number(it.kcal))) return false;
  if (it.foodId === undefined || it.foodId === null) return true;
  return /^[0-9a-zA-Z]{8,40}$/.test(it.foodId) && Number(it.grams) > 0;
}

function validLog(b) {
  return validCredentials(b)
    && /^\d{2}\.\d{2}\.\d{4}$/.test(b.date || '')
    && MEALS.includes(b.mealId)
    && Array.isArray(b.items) && b.items.length > 0 && b.items.length <= MAX_ITEMS
    && b.items.every(validItem);
}

function validSearch(b) {
  return Array.isArray(b.queries) && b.queries.length > 0 && b.queries.length <= MAX_ITEMS
    && b.queries.every((q) => typeof q === 'string' && q.trim() && q.length <= 100);
}

const VALIDATE = { '/search': validSearch, '/login-test': validCredentials, '/log': validLog };

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request, env);
    if (request.method === 'OPTIONS') {
      if (!origin) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
          Vary: 'Origin',
        },
      });
    }
    if (!origin) return json({ ok: false, error: 'origin' }, 403, '');
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST' || !VALIDATE[path]) {
      return json({ ok: false, error: 'badRequest' }, 404, origin);
    }

    if (env.LOGIN_LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.LOGIN_LIMITER.limit({ key: ip });
      if (!success) return json({ ok: false, error: 'rateLimited' }, 429, origin);
    }

    let body;
    try { body = await request.json(); } catch { return json({ ok: false, error: 'badRequest' }, 400, origin); }
    if (!body || !VALIDATE[path](body)) return json({ ok: false, error: 'badRequest' }, 400, origin);

    try {
      if (path === '/search') {
        const results = [];
        for (const q of body.queries) results.push(await search(q));
        return json({ ok: true, results }, 200, origin);
      }
      const session = await login(body.email.trim(), body.passwordHash);
      if (path === '/login-test') return json({ ok: true }, 200, origin);
      const results = await logItems(session, body);
      return json({ ok: true, results }, 200, origin);
    } catch (e) {
      const code = e instanceof ProxyError ? e.code : 'upstream';
      if (!(e instanceof ProxyError)) console.error(e);
      return json({ ok: false, error: code }, code === 'auth' ? 401 : 502, origin);
    }
  },
};
