# Moving Blip: landing page on blip., app on app.blip.

| Address | Shows | Vercel project | Git branch |
|---|---|---|---|
| blip.akshayashokanpothan.com | Landing page | **blip-landing** (new, root folder `landing`) | main |
| blippreview.akshayashokanpothan.com | Preview landing page | blip-landing | v2 |
| app.blip.akshayashokanpothan.com | The app | existing Blip project | main |
| apppreview.blip.akshayashokanpothan.com | Preview app | existing Blip project | v2 |

One repo, same two branches. The landing page is the `landing/` folder. Each project skips a build
when its own files didn't change (`ignoreCommand` in `vercel.json` and `landing/vercel.json`).

Do every step on **preview first** (blippreview / apppreview), check on phone and tablet, then repeat for production.

## 1. New app addresses (nothing changes for users yet)

1. DNS for akshayashokanpothan.com: add a `CNAME` record `app.blip` → `cname.vercel-dns.com`, and `apppreview.blip` → `cname.vercel-dns.com`.
   (Vercel shows the exact record when you add the domain; use what it shows.)
2. Vercel → existing Blip project → Settings → Domains:
   - Add `app.blip.akshayashokanpothan.com` (Production).
   - Add `apppreview.blip.akshayashokanpothan.com`, then Edit → Git Branch → `v2`.
   - Keep `blip.` and `blippreview.` on this project for now.
3. Supabase → Authentication → URL Configuration:
   - Redirect URLs: add `https://app.blip.akshayashokanpothan.com/**` and `https://apppreview.blip.akshayashokanpothan.com/**`. Keep the old ones until step 4 is done.
   - Site URL: change to `https://app.blip.akshayashokanpothan.com` (sign-up emails then open the app).
4. Open both new addresses, sign in, install, allow notifications. Everything should work as before.

## 2. Landing project

1. Vercel → Add New → Project → import `akshayashokanpothan/blip`.
2. Name `blip-landing`, Framework Preset **Other**, Root Directory **`landing`**, no build command, output directory `.`.
3. Settings → Git → Production Branch `main`. Check the `*.vercel.app` address it gets.

## 3. Tell people (a few days before the switch)

Set `moveNotice: true` in `config.js` and release. On the old addresses, Blip shows a
"Blip has a new home" sheet once a day: it checks this device is synced, then links to the new address.

## 4. Switch

1. Existing Blip project → Domains: remove `blippreview.akshayashokanpothan.com` (preview) / `blip.akshayashokanpothan.com` (production).
2. blip-landing → Domains: add the same address. For `blippreview.`, Edit → Git Branch → `v2`.
3. What happens to people on the old address:
   - The old offline cache is cleared by `landing/sw.js`, so the landing page loads.
   - Anyone who used Blip there, the installed app, and links from notifications, shares,
     home screen shortcuts and emails are sent straight on to the app's new address
     (invite and `utm_` links stay on the landing page).
   - They sign in once, install Blip again and allow notifications. Old push subscriptions
     expire, and send-reminders deletes them on the first 404/410.
4. After a couple of weeks, remove the old addresses from Supabase Redirect URLs.

## When the new domain arrives

The same steps again with the new names. The addresses live in: `landing/index.html` (app URL + live check),
`index.html` (live check), `app.js` (`NEW_HOME`, `INVITE_URL`), and the email templates.
