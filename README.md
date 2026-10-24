# Meal Snap

Take a photo of a meal and get it broken down into individual foods with estimated grams, calories and macros. That makes it easy to log each food separately in a calorie tracker such as *Kalorické tabulky*.

- Installable web app (PWA). Works on iPhone with no App Store and no Mac: open it in Safari, then Share → Add to Home Screen.
- English and Czech UI.
- Pick an AI provider: **Google Gemini** (free tier), **Anthropic Claude** or **OpenAI** (paid). Each user enters their own API key, which is stored only in their browser.
- Edit the grams and recalculate calories, copy single food names or the whole list, and keep a history of the last 30 meals.
- Voice note: live dictation where the browser supports it. In iOS home-screen apps the recording is transcribed by the AI provider instead.

The in-app user guide is in [help.html](help.html).

## How it works

Static HTML/CSS/JS with no build step and no backend. The photo is downscaled to 1024 px in the browser and sent directly to the selected provider together with a prompt that asks for strict JSON (dish, items with grams and nutrition per 100 g, note, confidence).

| File | Purpose |
|---|---|
| `index.html`, `style.css` | UI |
| `app.js` | Photo handling, analysis flow, result editing, history, settings |
| `providers.js` | Gemini / Claude / OpenAI adapters with one interface (`analyze`, `transcribe`, `listModels`) |
| `voice.js` | Web Speech dictation, MediaRecorder fallback and WAV conversion |
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

When you change any file, bump `CACHE` in `sw.js` (and `VERSION` in `app.js`) so installed apps pick up the update.
