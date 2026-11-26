# AI title cleanup: setup

Blip tidies spoken task titles in two layers:

1. **Offline rules (already on):** these fix common patterns right away.
   - "home concrete of Akshay" becomes "Akshay's home concrete".
   - "pick up medicines of dad" becomes "Pick up dad's medicines".
   - Doubled words are removed, and "i" becomes "I".
   - Spoken filler ("um", "so basically", "and stuff", "okay") and dangling words like a trailing "before" are dropped.
2. **AI cleanup (needs this setup):** only titles that still look messy after the rules (7+ words, or words like "maybe", "something", "stuff") go to the AI, about 1 in 6 tasks in testing. For those, Blip sends the sentence and the titles to a Supabase Edge Function. The function asks Claude for grammatical titles. Only titles change: dates, times and priorities never go through it. If the function is slow (over 2.5 s), missing or offline, the offline titles stay, and adding a task works the same.

Guests and people who added their own API key in Settings don't use this function.

## Steps (about 5 minutes)

1. **Get an Anthropic API key.** Go to console.anthropic.com → API Keys → Create key. Add a small amount of credit, and set a monthly spend limit under Billing → Limits.
2. **Add it as a Supabase secret.** Go to Supabase → Edge Functions → Secrets → Add new secret, and fill in:
   - Name: `ANTHROPIC_API_KEY`
   - Value: the key from step 1

   The key only lives here. It never goes in the app or on GitHub.
3. **Turn on the daily limit.** Go to Supabase → SQL Editor, paste everything from `supabase/ai-usage.sql`, and Run. Each person then gets 30 AI calls a day. To change that, add a secret `AI_DAILY_LIMIT` (for example `20`). Without this step the function never calls Claude.
4. **Create the function.** Go to Supabase → Edge Functions → Deploy a new function → Via editor, and fill in:
   - Name: `tidy-titles` (exactly this)
   - Code: paste everything from `supabase/functions/tidy-titles/index.ts`
   - Keep **Verify JWT** on, then Deploy.

   With the CLI instead: `supabase functions deploy tidy-titles`.
5. **Tell me it's deployed.** I switch on `aiTitles: true` in `config.js`. Until then the app never calls the function.
6. **Test it.** Sign in on blippreview and say "something about the insurance renewal before friday". The review card should show a clean title. Edge Functions → tidy-titles → Logs shows each call.

## Cost and limits

The function uses Claude Haiku 5.5, which costs $0.10 per million input tokens and $0.50 per million output tokens.

- One AI call is about 350 input tokens and 40 output tokens, so roughly $0.00006. That works out to about 15,000 calls per $1.
- Only messy titles are sent, about 1 in 6 tasks. For example, 100 people adding 10 tasks a day sends about 5,000 calls a month, or roughly $0.30 a month.
- **Worst case per person:** the daily limit (30) means at most about $0.06 per person per month, even if someone adds tasks nonstop.
- Only signed-in users can call the function, and each request is capped at 600 characters and 10 titles.
- The spend limit you set in the Anthropic console is the overall hard cap. If credit runs out or someone hits their daily limit, Blip keeps the offline titles.

If you skip this setup, nothing breaks. The offline rules still work for free, and the app stops trying the AI after the first failed call in each session.
