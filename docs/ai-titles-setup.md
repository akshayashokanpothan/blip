# AI title cleanup: setup

Blip tidies spoken task titles in two layers:

1. **Offline rules (already on):** these fix common patterns right away.
   - "home concrete of Akshay" becomes "Akshay's home concrete".
   - "pick up medicines of dad" becomes "Pick up dad's medicines".
   - Doubled words are removed, and "i" becomes "I".
2. **AI cleanup (needs this setup):** for signed-in users, Blip sends the sentence and the titles it found to a Supabase Edge Function. The function asks Claude for grammatical titles. Only titles change: dates, times and priorities never go through it. If the function is slow (over 2.5 s), missing or offline, the offline titles stay, and adding a task works the same.

Guests and people who added their own API key in Settings don't use this function.

## Steps (about 5 minutes)

1. **Get an Anthropic API key.** Go to console.anthropic.com → API Keys → Create key. Add a small amount of credit, and set a monthly spend limit under Billing → Limits.
2. **Add it as a Supabase secret.** Go to Supabase → Edge Functions → Secrets → Add new secret, and fill in:
   - Name: `ANTHROPIC_API_KEY`
   - Value: the key from step 1

   The key only lives here. It never goes in the app or on GitHub.
3. **Create the function.** Go to Supabase → Edge Functions → Deploy a new function → Via editor, and fill in:
   - Name: `tidy-titles` (exactly this)
   - Code: paste everything from `supabase/functions/tidy-titles/index.ts`
   - Keep **Verify JWT** on, then Deploy.

   With the CLI instead: `supabase functions deploy tidy-titles`.
4. **Test it.** Sign in on blippreview and say "home concrete of Akshay tomorrow at 2 pm". The review card should show a clean title. Edge Functions → tidy-titles → Logs shows each call.

## Cost and limits

- Each call sends one short sentence to a small, fast model with at most 400 output tokens, so a call costs a tiny fraction of a cent.
- Only signed-in users can call the function, and each request is capped at 600 characters and 10 titles.
- The spend limit you set in the Anthropic console is the hard cap.
