# Blip

A personal, voice-or-text to-do list for today, styled after iOS. Say or type what's on your day and it becomes a list. Update it later: "done with milk", "delete the call", "rename gym to gym at 6".

Plain HTML, CSS and JavaScript as a progressive web app. No build step, no backend, data stays in the browser.

## Run it locally

Voice input and offline install need `localhost` or HTTPS.

```bash
cd daytodo
python3 -m http.server 8080
# open http://localhost:8080
```

## Put it on your iPhone or Android

Host the folder on any static host (GitHub Pages, Netlify, Vercel, Cloudflare Pages), open the HTTPS URL on your phone, then:

- **iPhone / Safari:** Share → "Add to Home Screen"
- **Android / Chrome:** menu → "Install app"

## Using it

- **Add:** type or tap the mic and speak. Commas, "then", and new lines split a note into separate tasks. Voice waits about 3 seconds after your last word before it stops, so short pauses don't cut you off. Every task has a start time (required), an optional end time, and a priority: Urgent (red), Moderate (yellow) or Low (green). Words like "urgent" or "asap" set Urgent, and "no rush" sets Low.
- **Complete:** tap the circle.
- **Edit:** tap the task text, type, press return.
- **Delete:** swipe left, then tap Delete.
- **Update by voice or text:** "done with milk", "delete the call", "rename gym to gym at 6".
- **Reminders:** a task with a time and its reminder on sends a notification 10 minutes before, showing the task and its time. Allow notifications in Settings, and use "Send test" to check it works. Tapping the notification opens the task.
- **Share into Blip (Android):** share a message or link from any app and pick Blip. It opens the review screen with the task filled in; links go to the task's notes. Long-press the app icon for New voice task, Plan tomorrow, Summarize today and New note. Installed before this? Reinstall Blip to pick these up.
- **Unfinished tasks** from earlier days appear in their own section with a "Move to today" button.

## Parsing modes

- **Offline (default):** rule-based. No key needed. Less forgiving of messy speech.
- **Claude-powered:** open Settings and paste an Anthropic API key. Each entry goes to Claude Haiku, which handles messy speech, multiple tasks in one sentence, and fuzzy references to existing tasks. The key is stored only in this browser's localStorage. Anyone with access to this browser profile can read it, so use a key with a spending limit.

## Voice notes

- Uses the browser's Web Speech API, set to `en-IN`. Change `recognizer.lang` in `app.js` if you want another accent or language.
- Works in Chrome, Edge, and Android Chrome. iPhone Safari has limited support, so use the keyboard's dictation button there; it still fills the text field.

## Files

| File | Purpose |
|---|---|
| `index.html` | Layout: nav bar, grouped task list, bottom composer |
| `styles.css` | iOS-style design: system font, grouped inset lists, dark mode |
| `app.js` | Storage, parsing (offline and Claude), voice, swipe, inline edit |
| `sw.js` | Offline caching. Bump `CACHE` when you change app files |
| `manifest.webmanifest` | Install metadata |
| `icon.svg` | App icon |

## Known gaps

- Reminders fire while Blip is open or in the background. If the phone has fully closed the app, the reminder shows the next time Blip opens (up to 30 minutes late), because waking a closed app needs a push server.
- One device only. No sync between phone and laptop yet.
- iOS home-screen icons prefer a 180px PNG (`apple-touch-icon`). Generate one from `icon.svg` if the icon looks off.
- Chrome's install prompt wants 192px and 512px PNG icons.
