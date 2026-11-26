// Blip: the Done and Snooze buttons on a reminder notification, when Blip is closed.
// The service worker calls this with the signature that send-reminders put in
// the push, so no sign-in is needed and only that one reminder can be acted on.
// Deploy with:
//   supabase functions deploy reminder-action --no-verify-jwt
// Uses the CRON_SECRET secret (already set for send-reminders) to check signatures.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase itself.
import { createClient } from 'npm:@supabase/supabase-js@2';

const env = (k: string) => Deno.env.get(k) ?? '';
const SNOOZE_MIN = 10;
const MAX_AGE_MS = 2 * 864e5; // a notification older than two days can't be acted on

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });

async function sign(text: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env('CRON_SECRET')),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const addDays = (key: string, n: number) => {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST' || !env('CRON_SECRET')) return reply({ error: 'not allowed' }, 405);

  let b: Record<string, string>;
  try { b = await req.json(); } catch { return reply({ error: 'bad body' }, 400); }
  const { action, uid: userId, taskId, fireAt, sig } = b;
  if (!['done', 'snooze'].includes(action) || !userId || !taskId || !fireAt || !sig) return reply({ error: 'missing fields' }, 400);
  if (sig !== await sign(`${userId}|${taskId}|${fireAt}`)) return reply({ error: 'bad signature' }, 403);
  if (Date.now() - new Date(fireAt).getTime() > MAX_AGE_MS) return reply({ error: 'too old' }, 410);

  const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

  if (action === 'snooze') {
    // offset_min -10 marks a snooze, so the app keeps it when it tidies the schedule.
    const at = new Date(Math.ceil((Date.now() + SNOOZE_MIN * 60e3) / 1000) * 1000).toISOString();
    const { error } = await db.from('reminders').upsert({
      user_id: userId,
      task_id: taskId,
      fire_at: at,
      offset_min: -SNOOZE_MIN,
      title: String(b.title || 'Blip reminder').slice(0, 200),
      body: String(b.body || '').slice(0, 400),
      sent: false,
    }, { onConflict: 'user_id,task_id,fire_at' });
    if (error) return reply({ error: error.message }, 500);
    return reply({ ok: true, action, at });
  }

  // Done: tick the task, and drop its reminders still to come.
  const { data: t, error: getErr } = await db.from('tasks')
    .select('*').eq('user_id', userId).eq('id', taskId).maybeSingle();
  if (getErr) return reply({ error: getErr.message }, 500);
  if (t && !t.done && !t.deleted) {
    const now = Date.now();
    const { error } = await db.from('tasks').update({ done: true, updated_at: now })
      .eq('user_id', userId).eq('id', taskId);
    if (error) return reply({ error: error.message }, 500);
    // A repeating task leaves its next occurrence behind, as in the app.
    if (t.repeat && t.repeat !== 'none' && t.date) {
      await db.from('tasks').insert({
        user_id: userId, id: uid(), text: t.text, notes: t.notes, date: addDays(t.date, t.repeat === 'weekly' ? 7 : 1),
        time: t.time, end_time: t.end_time, slot: t.slot, priority: t.priority, done: false,
        reminder: t.reminder, repeat: t.repeat, created_at: now, updated_at: now, deleted: false,
      });
    }
  }
  await db.from('reminders').delete().eq('user_id', userId).eq('task_id', taskId).eq('sent', false);
  return reply({ ok: true, action });
});
