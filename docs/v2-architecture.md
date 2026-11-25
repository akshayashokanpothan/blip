# Blip v2: one account across phone and desktop

**Status:** built locally on the `v2` branch, not committed or pushed. Waiting for Akshay's approval.
**Version line:** v1.0.0 is everything on `main` up to commit `0b92ac3`. v2.0.0 adds accounts that sync across devices.

## Goal

Sign in with the same email on your phone and your laptop and see the same tasks, notes, name and theme on both. Changes show up on the other device within a second or two while it's open. Blip keeps working offline, as it does now.

## Pieces

```
 Phone (PWA)                 Supabase                     Laptop (browser/PWA)
 ┌───────────────┐   HTTPS   ┌──────────────────────┐     ┌───────────────┐
 │ app.js (UI)   │──────────▶│ Auth (email link,    │◀────│ app.js (UI)   │
 │ localStorage  │           │  Google)             │     │ localStorage  │
 │ sync.js       │──upsert──▶│ Postgres             │◀────│ sync.js       │
 │  • outbox     │◀──pull────│  tasks, notes,       │────▶│  • outbox     │
 │  • snapshot   │◀─realtime─│  user_settings + RLS │─────│  • snapshot   │
 └───────────────┘           │ Realtime (websocket) │     └───────────────┘
                             └──────────────────────┘
```

| Piece | File | Job |
|---|---|---|
| Sign-in | `app.js` (already in v1) | Email magic link and Google through Supabase Auth. Off until `config.js` has keys. |
| Database | `supabase/schema.sql` | Three tables with Row Level Security, server timestamps and Realtime. Run once in the Supabase SQL editor. |
| Sync engine | `sync.js` | Outbox, pull, live updates and conflict handling. It has no UI, so it can be tested in Node. |
| Glue | `app.js` ("sync (v2)" section) | Starts sync on sign-in and stops it on sign-out. Every `save()` tells sync what changed. |
| Tests | `tests/sync.test.js` | Two simulated devices against a fake backend. |

## Data model

Every row has `user_id`, which defaults to the signed-in user. Row Level Security only lets a user read or write their own rows.

- **tasks:** `id`, `text`, `notes`, `date`, `time`, `end_time`, `priority` (high, medium or low), `done`, `reminder`, `repeat`, `created_at`, `updated_at`, `deleted`, `server_updated_at`.
- **notes:** `id`, `title`, `body`, `created_at`, `edited_at`, `updated_at`, `deleted`, `server_updated_at`.
- **user_settings:** one row per user, with `display_name`, `role`, `role_other`, `theme` and `updated_at`.

Not synced, on purpose:
- **The Anthropic API key** stays on each device, because it's a secret.
- **`notified`** is per device: has this device already shown the reminder? It isn't shared.

IDs are generated on the device (as in v1), so a task can be created offline and uploaded later without renumbering.

## How sync works

1. **Local first.** Every change is saved to `localStorage` straight away, exactly as in v1. The UI never waits on the network.
2. **Outbox.** `save()` calls `sync.changed('tasks')`. Sync compares the list with its last snapshot. New and edited items get an edit time (`updated_at`) and go into an outbox. Missing items become tombstones (`deleted = true`). The outbox is stored, so it survives reloads and offline time.
3. **Upload.** The outbox is sent in batches 0.8 seconds after the last change. If the upload fails, Blip retries every 30 seconds, when the network comes back, and when the app returns to the foreground.
4. **Pull.** On sign-in and on resume, Blip asks for rows whose `server_updated_at` is later than its last pull. That timestamp is set by the database, so device clocks don't matter for finding changes.
5. **Live.** While the app is open, Supabase Realtime pushes changes from your other devices.
6. **Conflicts.** If two devices change the same item, the edit made last wins, compared by `updated_at`. This is simple and predictable for a personal app. The cost: if two devices edit the same task within seconds while one is offline, one of the edits is dropped. Field-by-field merging could be added later if that ever matters.

## Account lifecycle

- **First sign-in on a device:** anything already on that device, such as guest tasks and notes, is uploaded and merged into the account. Then the account's data is pulled down. If the account already has a name and theme, those win over the device's defaults.
- **Signing in on another device:** it pulls everything and then stays live.
- **Sign-out:** pending changes are sent first. Then this account's tasks and notes are removed from the device, so the next person can't see them. Nothing is deleted on the server.
- **Guest mode and no keys:** nothing changes from v1. Sync only starts after a real Supabase sign-in.

## Setup steps for you (Supabase)

1. Create a project at supabase.com (the free tier is enough).
2. In **SQL Editor**, paste `supabase/schema.sql` and run it.
3. Under **Authentication → Providers**, check that Email is on. Turn on Google if you want it (it needs a Google OAuth client).
4. Under **Authentication → URL Configuration**, set the Site URL to Blip's domain and add it to the redirect URLs. Add `http://localhost:8080` too for local testing.
5. Under **Settings → API**, copy the **Project URL** and the **anon public** key into `config.js`. Never use the `service_role` key in the app.

## Later in v2 (not built yet)

- **Push reminders for a closed app:** this needs Web Push. A `push_subscriptions` table, a Supabase Edge Function that sends notifications, and a scheduled job (pg_cron) that runs every minute and finds tasks due in 10 minutes.
- **Sharing and collaboration:** a `lists` table with `list_members` (owner, editor), and tasks get an optional `list_id`. The RLS policies widen from "my rows" to "rows in lists I belong to". The current schema leaves room for this without changing existing rows.
- **Account deletion:** a "Delete my account" button that calls an Edge Function to remove the user and, through the cascade, all their rows.

## Testing

- `node tests/sync.test.js` covers seven scenarios: merging guest data, a second device's first pull, live adds, edits and deletes, conflicts, offline queueing and recovery, and sign-out followed by sign-in.
- Without keys, the app runs as v1. I re-ran the existing browser checks for profile setup and notes with no errors.
- **Not tested yet:** a real Supabase project. Once you create it, I'll run the same scenarios against it.
