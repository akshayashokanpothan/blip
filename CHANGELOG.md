# Changelog

## 2.0.0 (in progress, not released)

Accounts that sync across devices.

- Tasks, notes, name, work and theme sync between your devices when you're signed in (Supabase).
- Changes appear live on your other open devices. Offline changes upload when you reconnect.
- Guest data on a device is merged into the account on its first sign-in.
- Settings shows the sync status under Account.
- New files: `sync.js`, `supabase/schema.sql`, `docs/v2-architecture.md` and `tests/sync.test.js`.

## 1.0.0

Everything up to commit `0b92ac3` on `main`.

- Voice or text capture with a review step: an editable transcript, start and end times, three priorities (Urgent, Moderate, Low) and notes with dictation.
- Voice waits 3 seconds after your last word, and repeated words on Android are merged.
- Reminder notifications 10 minutes before a task's time, while the app is open or in the background.
- Light and dark themes, a card-style composer, and a home screen that fits the phone above the tab bar.
- Profile setup (name and work) from Settings.
- Onboarding with permission rows. On desktop it opens as a dialog.
- Offline rule-based parsing, or Claude parsing with your own API key.
