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
  vapidPublicKey: 'BJySr1boLzAOnAWQbakE3d7kOAEL1jb3c7frLP8sEfAYRn_AISrLab7txKQflfdmrmHiWRRr6P7nnfd9DC2fOKs',
  // AI title polish: set to true after deploying the tidy-titles function (docs/ai-titles-setup.md).
  aiTitles: false,
  // Moving day: when true, the old addresses (blip. and blippreview.) show a
  // "Blip has a new home" sheet that sends people to app.blip / apppreview.blip.
  // Turn on once those new addresses work; see docs/landing-move.md.
  moveNotice: false,
};
