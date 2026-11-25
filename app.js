// Blip: voice or text in, a list for today out.
// Everything lives in localStorage. Parsing uses a local rule-based parser,
// or the Claude API if you add an API key in Settings.

const TASKS_KEY = 'blip.tasks.v1';
const SETTINGS_KEY = 'blip.settings.v1';
const MODEL = 'claude-haiku-5-5';

// ---------- storage ----------
function loadJSON(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

let tasks = loadJSON(TASKS_KEY, []);
const settings = loadJSON(SETTINGS_KEY, {});

function save() {
  localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
}

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function todayKey(d = new Date()) {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2600);
}

function haptic() {
  if (navigator.vibrate) navigator.vibrate(8);
}

// ---------- matching ----------
const STOPWORDS = new Set(['the', 'a', 'an', 'to', 'my', 'for', 'of', 'and', 'with', 'at', 'on', 'in', 'is', 'it', 'that', 'this']);
const words = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOPWORDS.has(w));

// Finds the task that best matches a spoken or typed phrase.
function findTask(query) {
  const q = new Set(words(query));
  let best = null;
  let bestScore = 0;
  for (const t of tasks) {
    const tw = words(t.text);
    if (!tw.length || !q.size) continue;
    const hits = tw.filter((w) => q.has(w)).length;
    const score = hits / Math.min(tw.length, q.size);
    if (score > bestScore) {
      best = t;
      bestScore = score;
    }
  }
  return bestScore >= 0.6 ? best : null;
}

// ---------- local parser (no API key needed) ----------
const FILLER = /^(ok(ay)?|so|hey|um+|uh+|please|i\s+(need|have|want|should|got|must)\s+to|i'?m\s+gonna|gonna|remind\s+me\s+to|add|todo|to\s+do)\s+/i;

function splitItems(text) {
  return text
    .split(/\n|;|,|\bthen\b|\balso\b|\bafter that\b|\band then\b/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseLocal(input) {
  const actions = [];
  for (const raw of splitItems(input)) {
    const s = raw.replace(/[.!?]+$/, '').trim();
    let m;

    if ((m = s.match(/^rename\s+(.+?)\s+to\s+(.+)$/i))) {
      actions.push({ type: 'rename', match: m[1], text: m[2] });
      continue;
    }
    if ((m = s.match(/^(?:mark\s+)?(.+?)\s+(?:as\s+)?(?:done|finished|complete)$/i))) {
      actions.push({ type: 'done', match: m[1] });
      continue;
    }
    if ((m = s.match(/^(?:i'?m\s+|i\s+am\s+)?(?:done|finished)\s+(?:with\s+)?(.+)$/i))) {
      actions.push({ type: 'done', match: m[1] });
      continue;
    }
    if ((m = s.match(/^(?:delete|remove|cancel|drop)\s+(?:the\s+)?(.+)$/i))) {
      actions.push({ type: 'delete', match: m[1] });
      continue;
    }

    const priority = /\b(urgent|asap|important)\b/i.test(s) ? 'high' : 'normal';
    let text = s.replace(/\b(urgent|asap|important)\b/gi, '').replace(/\s+/g, ' ').trim();
    for (let i = 0; i < 2; i++) text = text.replace(FILLER, '');
    text = text.replace(/^./, (c) => c.toUpperCase()).trim();
    if (text) actions.push({ type: 'add', text, priority });
  }
  return actions;
}

// ---------- Claude-powered parser (optional) ----------
async function parseWithLLM(input, apiKey) {
  const open = tasks.filter((t) => !t.done && t.date === todayKey()).map((t) => t.text);
  const system = [
    'You convert a short typed or speech-recognized to-do note into JSON actions for a personal daily to-do app.',
    'Return ONLY a JSON object: {"actions":[...]}.',
    'Action types:',
    '{"type":"add","text":"short task, under 10 words","priority":"normal"|"high"}',
    '{"type":"done","match":"words identifying an existing task"}',
    '{"type":"delete","match":"words identifying an existing task"}',
    '{"type":"rename","match":"existing task","text":"new text"}',
    'Split separate tasks into separate add actions. Fix obvious speech-recognition errors. Mark urgent or important items as high priority.',
    `Today is ${todayKey()}.`,
  ].join('\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 800,
      system,
      messages: [{
        role: 'user',
        content: `Note: ${input}\n\nOpen tasks today: ${JSON.stringify(open)}`,
      }],
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}`);

  const data = await res.json();
  const text = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  return Array.isArray(json.actions) ? json.actions : [];
}

// ---------- applying actions ----------
function applyActions(actions) {
  const today = todayKey();
  const log = [];

  for (const a of actions) {
    if (a.type === 'add') {
      tasks.push({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        text: a.text,
        priority: a.priority === 'high' ? 'high' : 'normal',
        done: false,
        date: today,
        created: Date.now(),
      });
      log.push(`Added “${a.text}”`);
      continue;
    }

    const t = findTask(a.match || '');
    if (!t) {
      log.push(`No task matches “${a.match}”`);
      continue;
    }

    if (a.type === 'done') {
      t.done = true;
      log.push(`Done: ${t.text}`);
    } else if (a.type === 'delete') {
      tasks = tasks.filter((x) => x !== t);
      log.push(`Deleted: ${t.text}`);
    } else if (a.type === 'rename' && a.text) {
      log.push(`Renamed “${t.text}” → “${a.text}”`);
      t.text = a.text;
    }
  }

  save();
  render();
  return log;
}

async function handleInput(text) {
  text = text.trim();
  if (!text) return;

  toast('Working…');
  let actions;
  let warning = '';

  if (settings.apiKey) {
    try {
      actions = await parseWithLLM(text, settings.apiKey);
    } catch (err) {
      warning = ` (AI parse failed: ${err.message}; used offline parser)`;
      actions = parseLocal(text);
    }
  } else {
    actions = parseLocal(text);
  }

  const log = applyActions(actions);
  toast((log.join(' · ') || 'Nothing to add.') + warning);
}

// ---------- voice ----------
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
let listening = false;

function toggleMic() {
  if (!SpeechRec) {
    toast('Voice isn’t supported here. Use the keyboard’s dictation button.');
    return;
  }
  if (listening) {
    recognizer.stop();
    return;
  }

  recognizer = new SpeechRec();
  recognizer.lang = 'en-IN';
  recognizer.interimResults = true;
  recognizer.continuous = false;

  let finalText = '';

  recognizer.onstart = () => {
    listening = true;
    $('#mic').classList.add('on');
    toast('Listening… tap the mic again to finish');
  };

  recognizer.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    $('#input').value = (finalText + interim).trim();
  };

  recognizer.onerror = (e) => toast(`Mic error: ${e.error}`);

  // Leave the words in the sheet so you can check them, then tap Add.
  recognizer.onend = () => {
    listening = false;
    $('#mic').classList.remove('on');
    if ($('#input').value.trim()) toast('Check the words, then tap Add');
  };

  recognizer.start();
}

// ---------- rendering ----------
const sortTasks = (a, b) =>
  (a.done - b.done) ||
  ((b.priority === 'high') - (a.priority === 'high')) ||
  (a.created - b.created);

function todayItemHTML(t) {
  return `
    <li class="swipe" data-id="${t.id}">
      <div class="row${t.done ? ' done' : ''}${t.priority === 'high' ? ' high' : ''}">
        <button class="circle" data-act="toggle" aria-label="Mark done"></button>
        <span class="text" data-act="edit">${esc(t.text)}</span>
        <button class="x-del" data-act="delete" aria-label="Delete task"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg></button>
      </div>
    </li>`;
}

function carryItemHTML(t) {
  return `
    <li class="swipe" data-id="${t.id}">
      <div class="row">
        <span class="text">${esc(t.text)}</span>
        <button class="move" data-act="move">Move to today</button>
        <button class="x-del" data-act="delete" aria-label="Delete task"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg></button>
      </div>
    </li>`;
}

// Search and filter state for the Home view.
const ui = { view: 'home', filter: 'all', query: '' };

const matchesQuery = (t) => !ui.query || t.text.toLowerCase().includes(ui.query);

function renderHome() {
  const today = todayKey();

  const all = tasks.filter((t) => t.date === today);
  const allDone = all.filter((t) => t.done).length;
  $('#stat-total').textContent = all.length;
  $('#stat-done').textContent = allDone;
  $('#stat-open').textContent = all.length - allDone;
  $('#stat-carry').textContent = tasks.filter((t) => t.date < today && !t.done).length;

  let list = tasks.filter((t) => t.date === today && matchesQuery(t));
  if (ui.filter === 'open') list = list.filter((t) => !t.done);
  if (ui.filter === 'done') list = list.filter((t) => t.done);
  list.sort(sortTasks);

  $('#greeting').textContent = greeting();
  $('#date').textContent = new Date().toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  let empty = 'Nothing here yet. Tap + to add what’s on your day.';
  if (ui.query) empty = `No tasks match “${ui.query}”.`;
  else if (ui.filter === 'done') empty = 'Nothing finished yet today.';

  $('#today').innerHTML = list.length
    ? list.map(todayItemHTML).join('')
    : `<li class="empty-row">${esc(empty)}</li>`;

  const carry = tasks.filter((t) => t.date < today && !t.done && matchesQuery(t));
  $('#carry-section').hidden = carry.length === 0;
  $('#carry').innerHTML = carry.map(carryItemHTML).join('');
}

function renderDone() {
  const list = tasks
    .filter((t) => t.done && matchesQuery(t))
    .sort((a, b) => b.created - a.created);

  $('#done').innerHTML = list.length
    ? list.map(todayItemHTML).join('')
    : '<li class="empty-row">Finished tasks will show here.</li>';
}

function renderSettings() {
  $('#api-key').value = settings.apiKey || '';
  $('#mode-hint').textContent = settings.apiKey
    ? 'AI parsing is on. Claude Haiku reads your notes.'
    : 'Offline parsing is on. Add a key for smarter parsing.';
}

function render() {
  renderHome();
  renderDone();
}

// ---------- account and onboarding ----------
// Real sign-in runs on Supabase (email link + Google) when config.js has keys.
// Without keys, the app runs in preview mode: email sign-in is not verified.
const PROFILE_KEY = 'blip.profile.v1';
const INSTALL_DISMISS_KEY = 'blip.installDismissed.v1';
const CFG = window.BLIP_CONFIG || {};
let profile = loadJSON(PROFILE_KEY, null);
let sb = null;
let onboardSlide = 0;

function setProfile(p) {
  profile = p;
  if (p) localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
  else localStorage.removeItem(PROFILE_KEY);
  renderProfile();
}

function renderProfile() {
  $('#avatar').innerHTML = profile?.avatar
    ? `<img class="photo" src="${esc(profile.avatar)}" alt="">`
    : '<img src="assets/logo/symbol-color.svg" alt="">';
  $('#profile-name').textContent = profile?.name || 'Blip';
  $('#profile-sub').textContent = profile?.email || 'Say it. Get it done.';
  $('#account-line').textContent = !profile
    ? 'Not signed in'
    : profile.mode === 'guest'
      ? 'Guest. Tasks are saved on this device.'
      : `Signed in as ${profile.email || profile.name}`;
  $('#signout').textContent = profile && profile.mode !== 'guest'
    ? 'Sign out'
    : 'Sign in or create account';
}

const authMsg = (msg) => { $('#auth-msg').textContent = msg; };
const redirectUrl = () => location.origin + location.pathname;

async function fromSession(session) {
  const u = session.user;
  const meta = u.user_metadata || {};
  setProfile({
    mode: u.app_metadata?.provider === 'google' ? 'google' : 'email',
    email: u.email || '',
    name: meta.full_name || meta.name || (u.email || 'Friend').split('@')[0],
    avatar: meta.avatar_url || null,
  });
  finishOnboarding();
}

async function signInWithEmail(email) {
  if (!sb) {
    setProfile({ mode: 'email', email, name: email.split('@')[0], avatar: null });
    finishOnboarding();
    return;
  }
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirectUrl() },
  });
  if (error) throw error;
  authMsg('Check your inbox for a sign-in link.');
}

async function signInWithGoogle() {
  if (!sb) {
    authMsg('Google sign-in needs Supabase set up in config.js. Use email or skip for now.');
    return;
  }
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: redirectUrl() },
  });
  if (error) throw error;
}

function showOnboarding(authOnly = false) {
  $('#onboarding').hidden = false;
  $('#ob-intro').hidden = authOnly;
  $('#ob-auth').hidden = !authOnly;
  showSlide(0);
}

function showSlide(i) {
  onboardSlide = i;
  $$('.slide').forEach((s, idx) => s.classList.toggle('on', idx === i));
  $$('.dot').forEach((d, idx) => d.classList.toggle('on', idx === i));
  $('#ob-next').textContent = i === 2 ? 'Get started' : 'Next';
}

function showAuthStep() {
  $('#ob-intro').hidden = true;
  $('#ob-auth').hidden = false;
}

function finishOnboarding() {
  if ($('#onboarding').hidden) return;
  $('#onboarding').hidden = true;
  renderProfile();
  setTimeout(maybeShowInstall, 700);
}

// ---------- install assistant ----------
let deferredPrompt = null;
const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isIOSSafari = () =>
  isIOS() && /safari/i.test(navigator.userAgent) && !/crios|fxios|edgios/i.test(navigator.userAgent);
const installSupported = () => !isStandalone() && (deferredPrompt !== null || isIOS());

function recentlyDismissed() {
  const t = Number(localStorage.getItem(INSTALL_DISMISS_KEY) || 0);
  return Date.now() - t < 7 * 24 * 3600 * 1000;
}

function refreshInstallEntries() {
  const show = installSupported();
  $('#drawer-install').hidden = !show;
  $('#install-settings').hidden = !show;
  $('#side-install').hidden = !show;
}

function openInstall() {
  if (!installSupported()) {
    toast('Blip is already installed, or this browser can’t install it.');
    return;
  }
  const text = $('#install-text');
  const steps = $('#install-steps');
  const go = $('#install-go');

  if (deferredPrompt) {
    text.textContent = 'Add Blip to your home screen for one-tap access and a full-screen app view.';
    steps.hidden = true;
    go.hidden = false;
  } else if (isIOSSafari()) {
    text.textContent = 'Add Blip to your home screen in three quick steps.';
    steps.innerHTML = '<li>Tap the Share button at the bottom of Safari.</li>'
      + '<li>Scroll down and tap “Add to Home Screen”.</li>'
      + '<li>Tap Add in the top-right corner.</li>';
    steps.hidden = false;
    go.hidden = true;
  } else if (isIOS()) {
    text.textContent = 'Blip installs from Safari on iPhone. Open this page in Safari, then add it to your home screen.';
    steps.innerHTML = '<li>Copy this address and open it in Safari.</li>'
      + '<li>Tap Share, then “Add to Home Screen”.</li>';
    steps.hidden = false;
    go.hidden = true;
  } else {
    // Desktop and Android browsers that don't expose the install prompt.
    text.textContent = 'Look for the install icon in your browser’s address bar, or open the browser menu and choose “Install Blip”.';
    steps.hidden = true;
    go.hidden = true;
  }

  $('#install-sheet').classList.add('open');
  $('#scrim').classList.add('show');
}

async function runInstall() {
  if (!deferredPrompt) return;
  const prompt = deferredPrompt;
  prompt.prompt();
  const { outcome } = await prompt.userChoice;
  deferredPrompt = null;
  closeAll();
  refreshInstallEntries();
  toast(outcome === 'accepted' ? 'Installing Blip…' : 'You can install Blip anytime from the menu.');
}

function dismissInstall() {
  localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now()));
  closeAll();
}

// Offer install once per session, right after sign-in, unless dismissed recently.
function maybeShowInstall() {
  if (!profile || !installSupported() || recentlyDismissed()) return;
  if (sessionStorage.getItem('blip.installShown')) return;
  sessionStorage.setItem('blip.installShown', '1');
  openInstall();
}

function initAccountAndInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    refreshInstallEntries();
    if (profile) maybeShowInstall();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    refreshInstallEntries();
    toast('Blip is installed. Open it from your home screen.');
  });

  $('#install-go').addEventListener('click', runInstall);
  $('#install-later').addEventListener('click', dismissInstall);
  $('#install-settings').addEventListener('click', openInstall);
  $('#side-install').addEventListener('click', openInstall);

  $('#ob-next').addEventListener('click', () => {
    if (onboardSlide < 2) showSlide(onboardSlide + 1);
    else showAuthStep();
  });
  $('#ob-skip').addEventListener('click', showAuthStep);

  $('#google-btn').addEventListener('click', () => {
    signInWithGoogle().catch((err) => authMsg(err.message));
  });
  $('#email-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#email').value.trim();
    if (!/^\S+@\S+\.\S+$/.test(v)) {
      authMsg('Enter a valid email address.');
      return;
    }
    signInWithEmail(v).catch((err) => authMsg(err.message));
  });
  $('#skip-auth').addEventListener('click', () => {
    setProfile({ mode: 'guest', name: 'Guest', email: '', avatar: null });
    finishOnboarding();
  });

  $('#signout').addEventListener('click', async () => {
    if (!profile || profile.mode === 'guest') {
      showOnboarding(true);
      return;
    }
    if (sb) await sb.auth.signOut();
    setProfile(null);
    showOnboarding(true);
  });

  refreshInstallEntries();
}

async function initAuth() {
  if (CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase) {
    sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
    const { data } = await sb.auth.getSession();
    if (data.session) await fromSession(data.session);
    sb.auth.onAuthStateChange((_event, session) => {
      if (session) fromSession(session);
    });
  }
  renderProfile();
  authMsg(sb ? '' : 'Preview mode: connect Supabase in config.js to verify email and enable Google.');
  if (!profile) showOnboarding();
}

// ---------- device, viewport and desktop ----------
// Layout is chosen by CSS media queries (width). Behavior is chosen here by
// data attributes on <html>: layout (phone | tablet | desktop), pointer
// (touch | mouse), os, and orientation.
const root = document.documentElement;
const mqDesktop = window.matchMedia('(min-width: 1024px)');
const mqTablet = window.matchMedia('(min-width: 768px)');
const mqFine = window.matchMedia('(pointer: fine)');

function detectOS() {
  const ua = navigator.userAgent;
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  if (/android/i.test(ua)) return 'android';
  if (/macintosh|mac os x/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'macos';
  if (/windows/i.test(ua)) return 'windows';
  if (/cros/i.test(ua)) return 'chromeos';
  if (/linux/i.test(ua)) return 'linux';
  return 'other';
}

function applyDevice() {
  root.dataset.layout = mqDesktop.matches ? 'desktop' : mqTablet.matches ? 'tablet' : 'phone';
  root.dataset.pointer = mqFine.matches ? 'mouse' : 'touch';
  root.dataset.os = detectOS();
  root.dataset.orientation = window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
}

function initDevice() {
  applyDevice();
  let lastLayout = root.dataset.layout;

  let timer;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      applyDevice();
      // Dialogs and the drawer belong to the phone layout; close them on desktop.
      if (root.dataset.layout !== lastLayout && root.dataset.layout === 'desktop') closeAll();
      lastLayout = root.dataset.layout;
    }, 120);
  });
  mqFine.addEventListener?.('change', applyDevice);

  $('#quick-add').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#quick-input');
    const v = input.value.trim();
    if (!v) return;
    input.value = '';
    handleInput(v);
  });

  // Desktop shortcuts. They never fire while typing.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAll();
      return;
    }
    const typing = /input|textarea|select/i.test(e.target.tagName) || e.target.isContentEditable;
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!mqDesktop.matches) return;

    if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      showView('home');
      $('#quick-input').focus();
    } else if (e.key === '/') {
      e.preventDefault();
      showView('home');
      $('#search').focus();
    }
  });
}

// ---------- themes ----------
const THEMES = ['green', 'classic', 'modern', 'claude', 'meld'];

function setTheme(name, quiet = false) {
  if (!THEMES.includes(name)) name = 'green';
  document.documentElement.dataset.theme = name;
  if (settings.theme !== name) {
    settings.theme = name;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }
  markTheme();
  if (!quiet) toast(`Theme: ${name[0].toUpperCase()}${name.slice(1)}`);
}

function markTheme() {
  for (const b of $$('[data-theme-pick]')) {
    b.setAttribute('aria-pressed', String(b.dataset.themePick === settings.theme));
  }
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

// ---------- views, drawer, sheet ----------
function showView(name) {
  ui.view = name;
  for (const v of $$('.view')) v.hidden = v.id !== `view-${name}`;
  for (const t of $$('[data-tab]')) t.classList.toggle('on', t.dataset.tab === name);
  if (name === 'done') renderDone();
  if (name === 'settings') renderSettings();
  window.scrollTo({ top: 0 });
}

function openDrawer() {
  $('#drawer').classList.add('open');
  $('#scrim').classList.add('show');
}

function openSheet() {
  $('#sheet').classList.add('open');
  $('#scrim').classList.add('show');
  setTimeout(() => $('#input').focus(), 300);
}

function closeAll() {
  $('#drawer').classList.remove('open');
  $('#sheet').classList.remove('open');
  $('#install-sheet').classList.remove('open');
  $('#scrim').classList.remove('show');
  $('#input').blur();
}

// ---------- inline edit ----------
function startEdit(el) {
  if (el.isContentEditable) return;
  el.contentEditable = 'true';
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  el.addEventListener('blur', () => finishEdit(el), { once: true });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      el.blur();
    }
  });
}

function finishEdit(el) {
  el.contentEditable = 'false';
  const id = el.closest('[data-id]')?.dataset.id;
  const t = tasks.find((x) => x.id === id);
  const v = el.textContent.trim();
  if (t && v) t.text = v;
  save();
  render();
}

// ---------- events ----------

// Row actions: toggle, edit, delete, move.
document.body.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;

  const id = el.closest('[data-id]')?.dataset.id;
  const t = tasks.find((x) => x.id === id);
  if (!t) return;

  switch (el.dataset.act) {
    case 'edit':
      startEdit(el);
      return;
    case 'toggle':
      t.done = !t.done;
      haptic();
      break;
    case 'delete':
      tasks = tasks.filter((x) => x.id !== id);
      break;
    case 'move':
      t.date = todayKey();
      break;
  }

  save();
  render();
});

// Bottom tabs.
for (const tab of $$('[data-tab]')) {
  tab.addEventListener('click', () => showView(tab.dataset.tab));
}

// Segmented filter on Home.
for (const seg of $$('.seg')) {
  seg.addEventListener('click', () => {
    ui.filter = seg.dataset.filter;
    for (const s of $$('.seg')) s.classList.toggle('on', s === seg);
    renderHome();
  });
}

// Search.
$('#search').addEventListener('input', (e) => {
  ui.query = e.target.value.trim().toLowerCase();
  render();
});

// Floating add button and add sheet.
$('#fab').addEventListener('click', openSheet);
$('#mic').addEventListener('click', toggleMic);
$('#add-btn').addEventListener('click', () => {
  const v = $('#input').value.trim();
  if (!v) {
    toast('Type or say something first');
    return;
  }
  $('#input').value = '';
  closeAll();
  handleInput(v);
});

// Menu drawer.
$('#menu').addEventListener('click', openDrawer);
$('#scrim').addEventListener('click', closeAll);

for (const item of $$('.drawer-item')) {
  item.addEventListener('click', () => {
    const action = item.dataset.drawer;
    closeAll();
    if (action === 'settings' || action === 'themes') showView('settings');
    else if (action === 'install') openInstall();
    else toast('Coming soon');
  });
}

// Settings view.
$('#save-key').addEventListener('click', () => {
  settings.apiKey = $('#api-key').value.trim();
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  renderSettings();
  toast(settings.apiKey ? 'API key saved on this device' : 'Offline parsing is on');
});

$('#clear-data').addEventListener('click', () => {
  if (!confirm('Delete all tasks on this device?')) return;
  tasks = [];
  save();
  render();
  toast('All tasks deleted');
});

// Theme picker.
for (const b of $$('[data-theme-pick]')) {
  b.addEventListener('click', () => setTheme(b.dataset.themePick));
}

// Refresh once a minute so the date rolls over at midnight.
// Skip while a task is being edited so the edit isn't wiped.
setInterval(() => {
  if (!document.querySelector('[contenteditable="true"]')) render();
}, 60_000);

setTheme(settings.theme || 'green', true);
showView('home');
render();
initAccountAndInstall();
initAuth();
initDevice();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js');
}
