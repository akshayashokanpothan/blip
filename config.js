// Blip runtime config. Safe to commit: the Supabase anon key is meant to be public.
// Leave the values empty to run in preview mode (email is not verified, Google is off).
// Never put a service-role key in this file.
window.BLIP_CONFIG = {
  supabaseUrl: 'https://ukgmeocyybqsmiopzxai.supabase.co',
  supabaseAnonKey: 'sb_publishable_oODhHCHzrPxkLpbalfktAg_FFjaj86Q',
  // Turn on after enabling the Google provider in Supabase.
  googleSignIn: false,
  // Background reminders: paste the VAPID public key here after following
  // docs/push-setup.md. Empty means reminders only ring while Blip is open.
  vapidPublicKey: '',
};
