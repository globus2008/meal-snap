// Meal Snap -> Kalorické tabulky proxy (Cloudflare Worker).
// kaloricketabulky.cz rejects cross-origin requests and keeps its session in an HttpOnly cookie,
// so the browser app cannot write to the diary itself. This worker logs in on each request,
// writes the items as "own food" diary entries and forgets everything afterwards (no storage).
//
// Endpoints (JSON in, JSON out):
//   POST /login-test {email, passwordHash}                          -> {ok: true}
//   POST /log        {email, passwordHash, date, mealId, items[]}   -> {ok: true, results: [{ok, error?}]}
//     date: 'dd.MM.yyyy', mealId: '1'..'6', items: [{title, kcal, protein, carbs, fat}]
// Errors: {ok: false, error: 'auth' | 'upstream' | 'badRequest' | 'origin' | 'rateLimited'}
//
// Env: ALLOWED_ORIGINS = comma-separated list of origins allowed to call it,
//      e.g. "https://you.github.io,http://localhost:8000".
//      LOGIN_LIMITER = optional rate limiting binding (see wrangler.toml). The Origin check only
//      stops other websites; anyone can call the worker directly, so this caps logins per IP to keep
//      it from being used to try passwords against kaloricketabulky.cz.
// The KT endpoints are unofficial (read from the site's own frontend) and may change.

const KT = 'https://www.kaloricketabulky.cz';
const MEALS = ['1', '2', '3', '4', '5', '6'];
const MAX_ITEMS = 30;

class ProxyError extends Error {
  constructor(code, status = 502) {
    super(code);
    this.code = code;
    this.status = status;
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

const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

async function logItems(session, { date, mealId, items }) {
  const form = await ktFetch(session, '/user/foodstuff/add/form/0?format=json');
  if (!form || typeof form !== 'object') throw new ProxyError('upstream');
  const kj = String(form.energyUnit || '').toLowerCase() === 'kj';
  const results = [];
  // One at a time: this is someone else's unofficial API.
  for (const it of items) {
    try {
      await ktFetch(session, '/user/foodstuff/add?format=json&=', {
        ...form,
        title: String(it.title).slice(0, 200),
        energy: kj ? Math.round(it.kcal * 4.184) : round1(it.kcal),
        protein: round1(it.protein),
        carbohydrate: round1(it.carbs),
        fat: round1(it.fat),
        diaryTimeGuid: mealId,
        date,
      });
      results.push({ ok: true });
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

function validLog(b) {
  return validCredentials(b)
    && /^\d{2}\.\d{2}\.\d{4}$/.test(b.date || '')
    && MEALS.includes(b.mealId)
    && Array.isArray(b.items) && b.items.length > 0 && b.items.length <= MAX_ITEMS
    && b.items.every((it) => it && typeof it.title === 'string' && it.title.trim() && Number.isFinite(Number(it.kcal)));
}

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
    if (request.method !== 'POST' || !['/login-test', '/log'].includes(path)) {
      return json({ ok: false, error: 'badRequest' }, 404, origin);
    }

    if (env.LOGIN_LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.LOGIN_LIMITER.limit({ key: ip });
      if (!success) return json({ ok: false, error: 'rateLimited' }, 429, origin);
    }

    let body;
    try { body = await request.json(); } catch { return json({ ok: false, error: 'badRequest' }, 400, origin); }
    if (!(path === '/log' ? validLog(body) : validCredentials(body))) {
      return json({ ok: false, error: 'badRequest' }, 400, origin);
    }

    try {
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
