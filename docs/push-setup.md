# Background reminders: one-time setup

Blip rings reminders on its own while it's open. To make them arrive with Blip
**closed**, Supabase sends them as Web Push notifications. This takes about
15 minutes, once. Nothing here goes in the app except the **public** key in step 6.

What you'll create:

- two tables (`push_subscriptions`, `reminders`)
- one Edge Function (`send-reminders`)
- a job that runs that function every minute

## 1. Make a VAPID key pair

These keys prove the notifications come from you. On any computer with Node:

```
npx web-push generate-vapid-keys
```

Keep both values. The **private** key is a secret: it goes only into Supabase
(step 3), never into the app or GitHub.

## 2. Pick a cron secret

Any long random string, for example from a password manager. It stops anyone
else from triggering the sender. You'll use it in steps 3 and 4.

## 3. Deploy the function

Supabase dashboard → **Edge Functions** → **Deploy a new function** → **Via editor**.

- Name: `send-reminders`
- Paste the code from `supabase/functions/send-reminders/index.ts`
- Deploy, then open the function's **Details** and turn **Enforce JWT verification** off
  (the cron secret protects it instead)

Then **Edge Functions → Secrets** and add:

| Name | Value |
|---|---|
| `VAPID_PUBLIC_KEY` | public key from step 1 |
| `VAPID_PRIVATE_KEY` | private key from step 1 |
| `VAPID_SUBJECT` | `mailto:` followed by your email |
| `CRON_SECRET` | the string from step 2 |

## 4. Store two values for the job

**SQL Editor** → New query → run (with your values):

```sql
select vault.create_secret('https://YOUR-PROJECT.supabase.co', 'blip_project_url');
select vault.create_secret('THE-CRON-SECRET-FROM-STEP-2', 'blip_cron_secret');
```

## 5. Create the tables and the every-minute job

**Database → Extensions**: turn on `pg_cron` and `pg_net`.

Then in the **SQL Editor** run all of `supabase/push.sql`.

## 6. Turn it on in the app

Put the **public** key from step 1 into `config.js`:

```js
vapidPublicKey: 'B...your public key...',
```

Commit and deploy. On each device: sign in, then Settings → Reminders and
notifications → Allow. That device now gets reminders even with Blip closed.

## Checking it works

- Settings shows "On. Reminders arrive even when Blip is closed."
- Table `push_subscriptions` has a row for the device.
- Add a task 15 minutes from now, close Blip, and wait for the 10-minute reminder.
- **Edge Functions → send-reminders → Logs** shows a call every minute.

## Notes

- **iPhone:** push only works when Blip is installed to the Home Screen (iOS 16.4+).
- **Guests** (not signed in) keep in-app reminders only, since the server needs the account.
- Reminders are scheduled up to 14 days ahead and refreshed whenever tasks change.
