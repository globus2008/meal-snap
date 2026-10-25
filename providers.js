// AI provider adapters. Every provider exposes the same surface:
//   analyze({ key, model, imageBase64, note, lang }) -> normalized result
//   transcribe({ key, model, wavBlob, lang })        -> string   (only if `audio`)
//   listModels({ key })                               -> string[] (also validates the key)
// Calls go straight from the browser to the provider with the user's own key.

export const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    free: true,
    audio: true,
    defaultModel: 'gemini-flash-latest',
    suggestedModels: ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-2.5-pro'],
    keyUrl: 'https://aistudio.google.com/app/apikey',
  },
  claude: {
    label: 'Anthropic Claude',
    free: false,
    audio: false,
    defaultModel: 'claude-haiku-5-5',
    suggestedModels: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  openai: {
    label: 'OpenAI',
    free: false,
    audio: true,
    defaultModel: 'gpt-5-mini',
    suggestedModels: ['gpt-5-mini', 'gpt-5', 'gpt-4.1-mini'],
    keyUrl: 'https://platform.openai.com/api-keys',
  },
};

export class ProviderError extends Error {
  // code: noKey | invalidKey | quota | busy | refused | badResponse | network | timeout | noAudio | audio | http
  constructor(code, detail = '') {
    super(detail || code);
    this.code = code;
    this.detail = detail;
  }
}

// ---------- shared prompt + schema ----------

const NUM = { type: 'number' };
export const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    dish: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          search_cs: { type: 'string' },
          grams: NUM,
          kcal_100g: NUM,
          protein_100g: NUM,
          carbs_100g: NUM,
          fat_100g: NUM,
        },
        required: ['name', 'search_cs', 'grams', 'kcal_100g', 'protein_100g', 'carbs_100g', 'fat_100g'],
        additionalProperties: false,
      },
    },
    note: { type: 'string' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['dish', 'items', 'note', 'confidence'],
  additionalProperties: false,
};

const LANG_RULES = {
  en: 'Write the dish name, ingredient names and the note in English.',
  cs: 'Write the dish name, ingredient names and the note in Czech. Use ingredient names the way Czech nutrition databases such as "Kalorické tabulky" list them (e.g. "rýže jasmínová vařená", "kuřecí prsa grilovaná", "olej řepkový").',
};

export function buildPrompt(note, lang) {
  return `You are a nutrition assistant. Look at the photo of a meal and break it down into the individual ingredients a person would log separately in a calorie-tracking app.

Rules:
- Use generic food names and include the preparation state (e.g. "rice, cooked", "chicken breast, grilled", "potatoes, boiled").
- Estimate the weight in grams of each ingredient as it is on the plate (cooked weight). Use the plate, cutlery and other objects for scale.
- Include hidden ingredients that are typically used: cooking oil, butter, sauces, dressings, sugar, breading.
- For each ingredient give typical nutrition values per 100 g in that preparation state: kcal, protein, carbohydrates, fat (grams).
- "search_cs": always in Czech, whatever the language below: a short search term (1–3 words) for finding the ingredient in the Czech food database "Kalorické tabulky", main word first, e.g. "rýže vařená", "kuřecí prsa", "olej řepkový", "brambory vařené".
- One line per ingredient; do not list the whole dish as one item unless it cannot be split (e.g. a packaged product).
- "note": one or two short sentences on assumptions or uncertainty (portion size, hidden fat...).
- "confidence": low / medium / high.
- If there is no food in the photo, return an empty "items" array and explain in "note".
- ${LANG_RULES[lang] || LANG_RULES.en}
${note ? `\nAdditional information from the user (trust it over the photo): """${note}"""\n` : ''}
Respond with JSON only, matching this JSON Schema:
${JSON.stringify(RESULT_SCHEMA)}`;
}

// ---------- helpers ----------

const REQUEST_TIMEOUT_MS = 90_000;

async function request(url, options) {
  let res;
  try {
    res = await fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (e) {
    if (e.name === 'TimeoutError') throw new ProviderError('timeout');
    throw new ProviderError('network', e.message);
  }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const msg = body?.error?.message || body?.message || text.slice(0, 300) || `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403 || /api[ _-]?key/i.test(msg)) throw new ProviderError('invalidKey', msg);
    if (res.status === 429) throw new ProviderError('quota', msg);
    if (res.status === 503 || res.status === 529) throw new ProviderError('busy', msg);
    throw new ProviderError('http', `${res.status}: ${msg}`);
  }
  return body;
}

function round(n, digits = 1) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function parseResult(text) {
  if (!text) throw new ProviderError('badResponse', 'empty response');
  let s = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  let data;
  try { data = JSON.parse(s); } catch { throw new ProviderError('badResponse', text.slice(0, 300)); }
  const items = Array.isArray(data.items) ? data.items : [];
  return {
    dish: String(data.dish || '').trim(),
    note: String(data.note || '').trim(),
    confidence: ['low', 'medium', 'high'].includes(data.confidence) ? data.confidence : 'medium',
    items: items
      .filter((it) => it && String(it.name || '').trim())
      .map((it) => ({
        name: String(it.name).trim(),
        search: String(it.search_cs || '').trim(),
        grams: Math.round(num(it.grams)),
        kcal_100g: round(num(it.kcal_100g), 0),
        protein_100g: round(num(it.protein_100g)),
        carbs_100g: round(num(it.carbs_100g)),
        fat_100g: round(num(it.fat_100g)),
      })),
  };
}

function requireKey(key) {
  if (!key) throw new ProviderError('noKey');
}

const TRANSCRIBE_PROMPT = (lang) =>
  `Transcribe this voice note verbatim${lang === 'cs' ? ' (it is most likely in Czech)' : ''}. Output only the transcript text, nothing else.`;

// ---------- Google Gemini ----------

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';

async function geminiGenerate(key, model, parts, json) {
  const body = await request(`${GEMINI}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: json ? { responseMimeType: 'application/json' } : {},
    }),
  });
  const cand = body?.candidates?.[0];
  if (!cand) {
    const reason = body?.promptFeedback?.blockReason;
    throw new ProviderError(reason ? 'refused' : 'badResponse', reason || JSON.stringify(body).slice(0, 300));
  }
  if (cand.finishReason === 'SAFETY' || cand.finishReason === 'PROHIBITED_CONTENT') throw new ProviderError('refused', cand.finishReason);
  return (cand.content?.parts || []).map((p) => p.text || '').join('');
}

const gemini = {
  async analyze({ key, model, imageBase64, note, lang }) {
    requireKey(key);
    const text = await geminiGenerate(key, model, [
      { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } },
      { text: buildPrompt(note, lang) },
    ], true);
    return parseResult(text);
  },
  async transcribe({ key, model, wavBlob, lang }) {
    requireKey(key);
    const data = await blobToBase64(wavBlob);
    const text = await geminiGenerate(key, model, [
      { inline_data: { mime_type: 'audio/wav', data } },
      { text: TRANSCRIBE_PROMPT(lang) },
    ], false);
    return text.trim();
  },
  async listModels({ key }) {
    requireKey(key);
    const body = await request(`${GEMINI}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
    return (body?.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini/i.test(m.name))
      .map((m) => m.name.replace(/^models\//, ''));
  },
};

// ---------- Anthropic Claude ----------

const ANTHROPIC = 'https://api.anthropic.com/v1';
const claudeHeaders = (key) => ({
  'Content-Type': 'application/json',
  'x-api-key': key,
  'anthropic-version': '2023-06-01',
  // Required for calls made directly from a browser page (the key is the user's own).
  'anthropic-dangerous-direct-browser-access': 'true',
});

const claude = {
  async analyze({ key, model, imageBase64, note, lang }) {
    requireKey(key);
    const body = await request(`${ANTHROPIC}/messages`, {
      method: 'POST',
      headers: claudeHeaders(key),
      body: JSON.stringify({
        model,
        max_tokens: 16000,
        output_config: { format: { type: 'json_schema', schema: RESULT_SCHEMA } },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
            { type: 'text', text: buildPrompt(note, lang) },
          ],
        }],
      }),
    });
    if (body?.stop_reason === 'refusal') throw new ProviderError('refused', body?.stop_details?.explanation || '');
    const text = (body?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    return parseResult(text);
  },
  async transcribe() {
    throw new ProviderError('noAudio');
  },
  async listModels({ key }) {
    requireKey(key);
    const body = await request(`${ANTHROPIC}/models?limit=100`, { headers: claudeHeaders(key) });
    return (body?.data || []).map((m) => m.id);
  },
};

// ---------- OpenAI ----------

const OPENAI = 'https://api.openai.com/v1';

const openai = {
  async analyze({ key, model, imageBase64, note, lang }) {
    requireKey(key);
    const body = await request(`${OPENAI}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_schema', json_schema: { name: 'meal', strict: true, schema: RESULT_SCHEMA } },
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: buildPrompt(note, lang) },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
          ],
        }],
      }),
    });
    const msg = body?.choices?.[0]?.message;
    if (msg?.refusal) throw new ProviderError('refused', msg.refusal);
    return parseResult(msg?.content);
  },
  async transcribe({ key, wavBlob, lang }) {
    requireKey(key);
    const form = new FormData();
    // wavBlob may also be the raw recording (webm/ogg/mp4) when WAV conversion failed.
    const ext = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4', 'audio/mpeg': 'mp3' }[wavBlob.type.split(';')[0]] || 'wav';
    form.append('file', wavBlob, `note.${ext}`);
    form.append('model', 'gpt-4o-mini-transcribe');
    if (lang) form.append('language', lang);
    const body = await request(`${OPENAI}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    return String(body?.text || '').trim();
  },
  async listModels({ key }) {
    requireKey(key);
    const body = await request(`${OPENAI}/models`, { headers: { Authorization: `Bearer ${key}` } });
    return (body?.data || []).map((m) => m.id).filter((id) => /^(gpt|o\d|chatgpt)/.test(id)).sort();
  },
};

export const ADAPTERS = { gemini, claude, openai };

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
