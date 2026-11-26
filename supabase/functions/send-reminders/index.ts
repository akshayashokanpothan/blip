// Blip: sends due reminders as Web Push notifications.
// Called every minute by pg_cron (see supabase/push.sql). Deploy with:
//   supabase functions deploy send-reminders --no-verify-jwt
// Secrets it needs (supabase secrets set ...): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
// VAPID_SUBJECT (e.g. mailto:you@example.com), CRON_SECRET.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase itself.
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3';

const env = (k: string) => Deno.env.get(k) ?? '';

webpush.setVapidDetails(env('VAPID_SUBJECT'), env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'));

// Signs a reminder so its notification buttons can act on just that task.
async function sign(text: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env('CRON_SECRET')),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Reminders later than this (server was down) are marked sent without ringing.
const STALE_MS = 15 * 60 * 1000;

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== env('CRON_SECRET') || !env('CRON_SECRET')) {
    return new Response('forbidden', { status: 403 });
  }
  const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false },
  });

  const now = Date.now();
  const { data: due, error } = await db
    .from('reminders')
    .select('user_id, task_id, fire_at, offset_min, title, body')
    .eq('sent', false)
    .lte('fire_at', new Date(now + 30_000).toISOString())
    .order('fire_at')
    .limit(500);
  if (error) return new Response(error.message, { status: 500 });
  if (!due?.length) return Response.json({ sent: 0 });

  const users = [...new Set(due.map((r) => r.user_id))];
  const { data: subs } = await db
    .from('push_subscriptions')
    .select('endpoint, user_id, p256dh, auth')
    .in('user_id', users);

  let sent = 0;
  const gone = new Set<string>();
  for (const r of due) {
    const stale = now - new Date(r.fire_at).getTime() > STALE_MS;
    if (!stale) {
      const fireAt = new Date(r.fire_at).toISOString();
      const snooze = r.offset_min < 0; // a snoozed reminder coming back
      const isTask = !String(r.task_id).startsWith('summary-');
      const payload = JSON.stringify({
        title: r.title,
        body: r.body,
        taskId: r.task_id,
        tag: `blip-${r.task_id}-${r.offset_min}`,
        ts: snooze ? new Date(r.fire_at).getTime() : new Date(r.fire_at).getTime() + r.offset_min * 60_000,
        now: r.offset_min <= 0,
        // Lets the Done and Snooze buttons work with Blip closed (see reminder-action).
        ...(isTask ? { act: { uid: r.user_id, fireAt, api: env('SUPABASE_URL'), sig: await sign(`${r.user_id}|${r.task_id}|${fireAt}`) } } : {}),
      });
      for (const s of (subs ?? []).filter((x) => x.user_id === r.user_id && !gone.has(x.endpoint))) {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload,
            { TTL: 600, urgency: 'high' },
          );
          sent++;
        } catch (err) {
          const code = (err as { statusCode?: number }).statusCode;
          // The browser dropped this subscription; forget it.
          if (code === 404 || code === 410) gone.add(s.endpoint);
          else console.error('push failed', code, (err as Error).message);
        }
      }
    }
    await db.from('reminders')
      .update({ sent: true, sent_at: new Date().toISOString() })
      .eq('user_id', r.user_id).eq('task_id', r.task_id).eq('fire_at', r.fire_at);
  }
  if (gone.size) await db.from('push_subscriptions').delete().in('endpoint', [...gone]);
  return Response.json({ due: due.length, sent, removed: gone.size });
});
