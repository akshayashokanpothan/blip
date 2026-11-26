// Blip: turns spoken task titles into clean, grammatical ones with Claude.
// Signed-in users only. The app sends what was said plus the titles its
// offline parser found; this returns the same number of tidied titles.
// Dates, times and priorities never pass through here, so nothing else changes.
// Deploy (JWT check on):
//   supabase functions deploy tidy-titles
// Secret it needs: ANTHROPIC_API_KEY (supabase secrets set ANTHROPIC_API_KEY=...).
// Optional secret: AI_DAILY_LIMIT, AI calls per person per day (default 30).
// Needs supabase/ai-usage.sql run once; without it the function never calls Claude.
// SUPABASE_URL and SUPABASE_ANON_KEY are provided by Supabase itself.
import { createClient } from 'npm:@supabase/supabase-js@2';

const env = (k: string) => Deno.env.get(k) ?? '';
const MODEL = 'claude-haiku-5-5';
const DAILY_LIMIT = Math.max(1, Number(env('AI_DAILY_LIMIT')) || 30);
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

const SYSTEM = [
  'You tidy task titles for a voice to-do app. People speak naturally, so titles come out in spoken word order.',
  'You get what the person said and the titles found in it. Return ONLY {"titles":[...]} with exactly one title per input title, in the same order.',
  'Each title: natural, grammatical, short (under 10 words), in the speaker\'s language, starting with a capital letter, no full stop.',
  'Reorder awkward phrasing: "home concrete of Akshay" -> "Akshay\'s home concrete"; "birthday of mom" -> "Mom\'s birthday"; "medicines of dad pick up" -> "Pick up dad\'s medicines".',
  'Fix an obvious speech-recognition slip only when the context makes it clear. Keep names, places and meaning exactly.',
  'Never add details that were not said, and never put dates, times or priority words in the title.',
  'If a title is already fine, return it unchanged.',
].join('\n');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);

  // Only signed-in Blip users.
  const auth = req.headers.get('authorization') ?? '';
  const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    global: { headers: { authorization: auth } },
    auth: { persistSession: false },
  });
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return json({ error: 'sign in' }, 401);

  let body: { text?: unknown; titles?: unknown };
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const text = typeof body.text === 'string' ? body.text.slice(0, 600) : '';
  const titles = Array.isArray(body.titles)
    ? body.titles.filter((t): t is string => typeof t === 'string').slice(0, 10).map((t) => t.slice(0, 160))
    : [];
  if (!text || !titles.length) return json({ error: 'empty' }, 400);
  if (!env('ANTHROPIC_API_KEY')) return json({ titles }, 200);

  // Daily limit per person. If the quota check fails for any reason, don't call Claude.
  const { data: allowed, error: quotaErr } = await sb.rpc('use_ai_quota', { p_limit: DAILY_LIMIT });
  if (quotaErr) return json({ titles, note: 'quota unavailable' });
  if (allowed !== true) return json({ titles, capped: true });

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env('ANTHROPIC_API_KEY'),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        // Simple rewrite: keep thinking light so it stays fast and cheap.
        output_config: { effort: 'low' },
        system: SYSTEM,
        messages: [{ role: 'user', content: `Said: ${text}\nTitles: ${JSON.stringify(titles)}` }],
      }),
    });
    if (!res.ok) return json({ titles, note: `model ${res.status}` });
    const data = await res.json();
    const out = (data.content ?? []).filter((c: { type?: string }) => c.type === 'text').map((c: { text?: string }) => c.text ?? '').join('');
    const parsed = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
    const tidy = Array.isArray(parsed.titles) ? parsed.titles : [];
    // Same count, sensible strings; otherwise keep what the app already had.
    const ok = tidy.length === titles.length && tidy.every((t: unknown) => typeof t === 'string' && t.trim() && t.length <= 160);
    return json({ titles: ok ? tidy.map((t: string) => t.trim().replace(/[.]$/, '')) : titles });
  } catch {
    return json({ titles });
  }
});
