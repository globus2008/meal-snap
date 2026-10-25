# Meal Snap

Take a photo of a meal and get it broken down into individual foods with estimated grams, calories and macros. That makes it easy to log each food separately in a calorie tracker such as *Kalorické tabulky*.

- Installable web app (PWA). Works on iPhone with no App Store and no Mac: open it in Safari, then Share → Add to Home Screen.
- English and Czech UI.
- Pick an AI provider: **Google Gemini** (free tier), **Anthropic Claude** or **OpenAI** (paid). Each user enters their own API key, which is stored only in their browser.
- Edit the grams and recalculate calories, copy single food names or the whole list, and keep a history of the last 30 meals.
- Voice note: live dictation where the browser supports it. In iOS home-screen apps the recording is transcribed by the AI provider instead.
- Log the breakdown straight into the *Kalorické tabulky* food diary (one-way), with the date and meal of the day (breakfast … second dinner) preselected from the time of the photo. This needs a small proxy, see below.

The in-app user guide is in [help.html](help.html).

## How it works

Static HTML/CSS/JS with no build step and no backend. The photo is downscaled to 1024 px in the browser and sent directly to the selected provider together with a prompt that asks for strict JSON (dish, items with grams and nutrition per 100 g, note, confidence).

| File | Purpose |
|---|---|
| `index.html`, `style.css` | UI |
| `app.js` | Photo handling, analysis flow, result editing, history, settings |
| `providers.js` | Gemini / Claude / OpenAI adapters with one interface (`analyze`, `transcribe`, `listModels`) |
| `voice.js` | Web Speech dictation, MediaRecorder fallback and WAV conversion |
| `kt.js` | Kalorické tabulky export: calls the proxy, preselects the meal of the day, MD5 of the password |
| `worker/` | Cloudflare Worker proxy that logs in to kaloricketabulky.cz and writes diary entries |
| `i18n.js`, `locales/*.json` | Translations. To add a language, add a JSON file and an entry in `LANGS`. |
| `sw.js`, `manifest.webmanifest`, `icons/` | PWA install and offline shell |

## Run locally

```sh
npx serve .
# or: python -m http.server 8000
```

Open the printed URL. The camera and the service worker need `localhost` or HTTPS.

## Deploy (GitHub Pages)

1. Push this folder to a GitHub repository, for example `meal-snap`.
2. In the repository, go to Settings → Pages → Source: *Deploy from a branch*, then select `main` / root.
3. The app is then available at `https://<user>.github.io/meal-snap/`.

## Kalorické tabulky proxy

kaloricketabulky.cz has no public API, rejects cross-origin requests and keeps its session in an HttpOnly cookie, so the app can't write to the diary from the browser. `worker/kt-proxy.js` is a stateless Cloudflare Worker that does it instead:

- `/search` looks up every item in the KT food database in one request (anonymous `/autocomplete/foodstuff-activity-meal`). The AI returns a Czech search term (`search_cs`) for this, and the app preselects the best match whose kcal is close to the AI's estimate.
- `/log` logs in (`POST /login/create`, password as MD5 hex) and posts every item to `/user/foodstuff/add` with `diaryTimeGuid` 1–6 (breakfast … second dinner) and the date as `dd.MM.yyyy`. A matched database food is sent with its detail form in the base unit (1 g or 1 ml, ids `…0001` / `…0002`); anything else becomes an "own food" entry with the totals from the analysis.

The meal of the day is preselected from the photo's EXIF capture time, falling back to the file date. These endpoints are unofficial (mapped from the site's frontend, see [kt-mcp](https://github.com/honzajscz/kt-mcp)) and may change without notice.

```sh
cd worker
# set ALLOWED_ORIGINS in wrangler.toml to the app's origin, e.g. https://<user>.github.io
npx wrangler dev      # local, http://localhost:8787
npx wrangler deploy   # https://meal-snap-kt.<account>.workers.dev
```

The app uses the author's deployment (`DEFAULT_PROXY` in `kt.js`) unless the user enters another URL in Settings → Kalorické tabulky. `wrangler deploy` also sets up the `LOGIN_LIMITER` binding (10 requests per minute per IP), which keeps the publicly reachable worker from being used to try passwords. Without wrangler, paste `kt-proxy.js` into a new Worker in the Cloudflare dashboard and add the `ALLOWED_ORIGINS` variable (the in-app help has the click-by-click steps). The limiter can't be set up that way; the worker then runs without it. The app stores only the MD5 hash of the password.

When you change any file, bump `CACHE` in `sw.js` (and `VERSION` in `app.js`) so installed apps pick up the update.
