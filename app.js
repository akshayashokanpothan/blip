// Blip: say it, get it done.
// Tasks and notes live in localStorage. Parsing uses a local rule-based parser,
// or the Claude API if you add an API key in Settings. Voice uses the browser's
// speech recognition. Nothing is sent anywhere unless you add a key.
// v2: when you sign in (Supabase keys in config.js), sync.js also keeps tasks,
// notes and profile settings in step across your devices.

const APP_VERSION = '2.3';

const TASKS_KEY = 'blip.tasks.v1';
const NOTES_KEY = 'blip.notes.v1';
const SETTINGS_KEY = 'blip.settings.v1';
const PROFILE_KEY = 'blip.profile.v1';
const INSTALL_DISMISS_KEY = 'blip.installDismissed.v1';
const SPLASH_KEY = 'blip.splashShown';
// Version 2 starts every device fresh, once: earlier test data, sign-ins and
// onboarding progress are removed so everyone goes through the new flow.
const RESET_FLAG = 'blip.reset.v2';
function wipeDevice() {
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith('blip.') || k.startsWith('sb-')) localStorage.removeItem(k);
  }
}
if (!localStorage.getItem(RESET_FLAG)) {
  wipeDevice();
  localStorage.setItem(RESET_FLAG, '1');
}
// Anywhere but the live address (preview link, Vercel branch builds, localhost)
// shows a "Preview" badge so test builds are easy to spot.
// The check itself runs early in index.html (it also swaps the install name and icon).
const IS_PREVIEW = document.documentElement.dataset.env === 'preview';
function markPreview() {
  if (!IS_PREVIEW) return;
  document.documentElement.dataset.env = 'preview';
  for (const el of document.querySelectorAll('.brand, .side-brand')) {
    const b = document.createElement('span');
    b.className = 'env-badge';
    b.textContent = 'Preview';
    el.after(b);
  }
  document.title = 'Blip (Preview)';
  const v = document.getElementById('about-version');
  if (v) v.textContent = `Version ${APP_VERSION} · Preview`;
}
const MODEL = 'claude-haiku-5-5';
const THEMES = ['light', 'dark'];
const PALETTES = ['blip', 'meld'];

// ---------- storage ----------
function loadJSON(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

// Older tasks lack the newer fields; fill them so every task has the same shape.
function normalizeTask(t) {
  return {
    time: '',
    slot: '',
    reminder: false,
    repeat: 'none',
    notes: '',
    notified: false,
    priority: 'medium',
    done: false,
    endTime: '',
    ...t,
    priority: normPriority(t.priority),
  };
}

// Three priorities: Urgent (red), Moderate (yellow), Low (green).
// Older tasks used 'normal', which maps to Moderate.
const PRIORITIES = [['high', 'Urgent'], ['medium', 'Moderate'], ['low', 'Low']];
const PRIORITY_LABEL = Object.fromEntries(PRIORITIES);
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
function normPriority(p) {
  return PRIORITY_RANK[p] !== undefined ? p : 'medium';
}

let tasks = loadJSON(TASKS_KEY, []).map(normalizeTask);
let notes = loadJSON(NOTES_KEY, []);
const settings = loadJSON(SETTINGS_KEY, {});
const S = window.BlipSummary; // summary.js

// ---------- Blip models ----------
// The model picker decides which features are on. Blip 1.0 and 1.0 beta are the
// basics (to-dos by voice or text, reminders, notes). Blip 2.0 adds the day
// summary and smart extras. Blip 2.3 has the full summary and Plan tomorrow.
const MODELS = [
  ['blip-2.3', 'Blip 2.3', 'Latest · full summaries'],
  ['blip-2.0', 'Blip 2.0', 'Summaries and extras'],
  ['blip-1.0', 'Blip 1.0', 'Basics · to-dos, reminders'],
  ['blip-1.0-beta', 'Blip 1.0 beta', 'Early preview · basics'],
];
const MODEL_FEATURES = {
  'blip-2.3': { summary: 'full', morning: 'full', plan: true, move: true, bullets: true },
  'blip-2.0': { summary: 'lite', morning: 'lite', plan: false, move: true, bullets: true },
  'blip-1.0': { summary: false, morning: false, plan: false, move: false, bullets: false },
  'blip-1.0-beta': { summary: false, morning: false, plan: false, move: false, bullets: false },
};
// The first model, newest first, that has a feature, for "Needs Blip 2.0" labels.
const FEATURE_MIN = { summary: 'blip-2.0', morning: 'blip-2.0', move: 'blip-2.0', bullets: 'blip-2.0', plan: 'blip-2.3' };
const modelId = () => (MODEL_FEATURES[settings.model] ? settings.model : MODELS[0][0]);
const modelName = (id = modelId()) => (MODELS.find((m) => m[0] === id) || MODELS[0])[1];
const can = (feature) => Boolean(MODEL_FEATURES[modelId()][feature]);
let renderModelPickers = () => {};
// Switch model and redraw everything a model changes (summary, + menu, Settings, push).
function setModel(id) {
  if (!MODEL_FEATURES[id] || id === modelId()) return;
  settings.model = id;
  saveSettings();
  renderModelPickers();
  if (!can('summary')) { summaryOpen = false; summaryAnytime = false; summaryBuild = null; clearTimeout(summaryBuildTimer); }
  morningBuild = null; clearTimeout(morningBuildTimer);
  renderSummaryOptions();
  renderMorningOptions();
  scheduleNextReminder();
  render();
  toast(`Switched to ${modelName(id)}`);
}
if (settings.theme === 'default' || settings.theme === 'green') settings.theme = 'light';
if (!THEMES.includes(settings.theme)) settings.theme = 'light';

function save() {
  syncChanged('tasks');
  localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
  if (typeof scheduleNextReminder === 'function') scheduleNextReminder();
}
function saveNotes() {
  syncChanged('notes');
  localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
}
function saveSettings() {
  syncChanged('settings');
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
// Set up in the sync section once signed in; a no-op before that.
let syncChanged = () => {};

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const pad = (n) => String(n).padStart(2, '0');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const root = document.documentElement;

// Dates are local calendar days stored as YYYY-MM-DD.
function keyFrom(d) {
  return [d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate())].join('-');
}
const todayKey = (d = new Date()) => keyFrom(d);
function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return keyFrom(new Date(y, m - 1, d + n));
}
function dateLabel(key) {
  const t = todayKey();
  if (key === t) return 'Today';
  if (key === addDays(t, 1)) return 'Tomorrow';
  if (key === addDays(t, -1)) return 'Yesterday';
  return parseKey(key).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtTime(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`;
}
const SLOTS = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening' };
const SLOT_TIME = { morning: '08:00', afternoon: '13:00', evening: '18:00' };
function whenText(t) {
  const parts = [dateLabel(t.date)];
  if (t.time) parts.push(t.endTime ? `${fmtTime(t.time)} – ${fmtTime(t.endTime)}` : fmtTime(t.time));
  else if (t.slot) parts.push(SLOTS[t.slot]);
  return parts.join(' · ');
}
// Sort key: the exact time, else the part of the day, else last.
const timeKey = (t) => t.time || SLOT_TIME[t.slot] || '99:99';

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2800);
}

function haptic() {
  if (navigator.vibrate) navigator.vibrate(8);
}

const ICON = {
  check: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  clock: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  bell: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0"/></svg>',
  trash: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  mic: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  pencil: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
};

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
const FILLER = /^(ok(ay)?|so|hey|um+|uh+|please|actually|sorry|oops|wait|well|right|i\s+(need|have|want|should|got|must)\s+to|i'?m\s+gonna|gonna|remind\s+me(\s+to)?|(create|creative|set\s+up|set|add|make)\s+(a\s+|an\s+)?(new\s+)?(reminder|task|to-?do)(\s+(to|for|that))?|add|todo|to\s+do)\s+/i;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// Words that say when something happens. Used to tell "buy apples at 6 and
// medicines at 9" (two tasks) from "call mom and dad at 6" (one task).
const WHEN_CUE = /\b(\d{1,2}(:\d{2})?\s*(a\.?m\.?|p\.?m\.?|o\s*['’]?\s*clock)|\d{1,2}:\d{2}|(at|by)\s+\d{1,2}|(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+o\s*['’]?\s*clock|today|tonight|tomorrow|morning|afternoon|evening|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i;

// ---------- self-corrections ----------
// People fix themselves mid-sentence: "tomorrow, sorry, today at 10",
// "at 5 no 6 pm", "on Monday actually Tuesday", "not tomorrow but today".
// The later day or time wins, and the slip and the "sorry" leave the title.
const DAY_WORDS = 'day after tomorrow|tomorrow|tonight|today|sunday|monday|tuesday|wednesday|thursday|friday|saturday';
const NUM_TIME = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';
const DATE_RX = new RegExp(`\\b(?:(?:on|for|this|next)\\s+)?(?:${DAY_WORDS})\\b`, 'gi');
const TIME_RX = new RegExp([
  `\\b(?:(?:at|by|for|around)\\s+)?\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?|o\\s*['’]?\\s*clock)(?![a-z])`,
  `\\b(?:(?:at|by|for|around)\\s+)?(?:${NUM_TIME})\\s+o\\s*['’]?\\s*clock\\b`,
  `\\b(?:(?:at|by|for|around)\\s+)?\\d{1,2}:\\d{2}\\b`,
  `\\b(?:at|by|around)\\s+\\d{1,2}\\b`,
].join('|'), 'gi');
const PART_RX = /\b(?:in the\s+)?(?:morning|afternoon|evening|night)\b/gi;
const CORRECTION = /\s*[,.;]?\s*\b(?:sorry|oops|no+|nope|wait|i mean|i meant|actually|rather|correction|scratch that|make (?:it|that)|change (?:it|that) to)\b[,.]?\s*(?:(?:it'?s|it is|make it|make that|i mean)\b[,.]?\s*)?/gi;
// A bare number after a correction ("at 5 no 6") is a time when a time came before it.
const BARE_NUM = /^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\b(?!\s*(?:a\.?m|p\.?m|o\s*['’]?\s*clock|:))/i;

const rxHas = (rx, s) => { rx.lastIndex = 0; const r = rx.test(s); rx.lastIndex = 0; return r; };
const rxStarts = (rx, s) => { rx.lastIndex = 0; const m = rx.exec(s); rx.lastIndex = 0; return Boolean(m && m.index === 0); };
const rxStrip = (rx, s) => s.replace(rx, ' ');

function applyCorrections(input) {
  let text = input;
  // "not tomorrow but today", "not at 5, at 6": drop the negated part.
  text = text.replace(new RegExp(`\\bnot\\s+((?:(?:on|for|at|by)\\s+)?(?:${DAY_WORDS}|\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?|o\\s*['’]?\\s*clock)?))\\s*[,.]?\\s*(?:but\\s+)?(?=\\S)`, 'gi'), '');
  for (let guard = 0; guard < 5; guard++) {
    CORRECTION.lastIndex = 0;
    let m;
    let changed = false;
    while ((m = CORRECTION.exec(text))) {
      const before = text.slice(0, m.index);
      let after = text.slice(m.index + m[0].length);
      // Only a correction when a day or time follows straight away ("no sugar" stays).
      const bare = rxHas(TIME_RX, before) && !rxStarts(TIME_RX, after) && after.match(BARE_NUM);
      if (!rxStarts(DATE_RX, after) && !rxStarts(TIME_RX, after) && !rxStarts(PART_RX, after) && !bare) continue;
      let b = before;
      if (rxHas(DATE_RX, after)) b = rxStrip(DATE_RX, b);
      if (rxHas(TIME_RX, after) || bare) {
        // Keep "evening" from "at 5 in the evening, sorry 6" by moving it after.
        const part = (b.match(PART_RX) || [])[0];
        b = rxStrip(TIME_RX, b);
        if (bare) {
          // Reuse the am/pm or o'clock that went with the first time.
          const unit = (before.match(/(a\.?m\.?|p\.?m\.?|o\s*['’]?\s*clock)(?![a-z])/i) || [])[1] || '';
          after = after.replace(BARE_NUM, (w, h, mm) => `at ${h}${mm ? `:${mm}` : ''}${unit ? ` ${unit}` : ''}`);
        }
        if (part && !rxHas(PART_RX, after)) after = `${after} ${part}`;
      }
      if (rxHas(PART_RX, after)) b = rxStrip(PART_RX, b);
      text = `${b.replace(/[\s,.;]+$/, '')} ${after}`.replace(/\s+/g, ' ').trim();
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return text;
}

function splitItems(text) {
  const parts = applyCorrections(text)
    .split(/\n|;|,|\b(?:and\s+)?also\b|\b(?:and\s+)?then\b|\bafter that\b/i)
    .map((s) => s.trim())
    .filter(Boolean);
  // Split on "and" only when both sides say their own time or day.
  const out = [];
  for (const part of parts) {
    const pieces = part.split(/\s+and\s+/i);
    let cur = pieces[0];
    for (const next of pieces.slice(1)) {
      if (WHEN_CUE.test(cur) && WHEN_CUE.test(next)) { out.push(cur); cur = next; }
      else cur += ' and ' + next;
    }
    out.push(cur);
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

// Review order: earliest day first, then by time; untimed tasks follow,
// morning before afternoon before evening.
const SLOT_RANK = { morning: '08:00', afternoon: '13:00', evening: '18:00' };
function byWhen(a, b) {
  const ka = `${a.date || ''} ${a.time || SLOT_RANK[a.slot] || '99:99'}`;
  const kb = `${b.date || ''} ${b.time || SLOT_RANK[b.slot] || '99:99'}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

// Pulls "tomorrow", "on friday", "at 6 pm", "evening" out of one item.
function extractWhen(s, now = new Date()) {
  let text = s;
  let date = null;
  let time = '';
  let slot = '';
  const base = todayKey(now);
  let m;

  if (/\bday after tomorrow\b/i.test(text)) {
    date = addDays(base, now.getHours() < 4 ? 1 : 2);
    text = text.replace(/\bday after tomorrow\b/gi, ' ');
  } else if (/\btomorrow\b/i.test(text)) {
    // Before 4 AM, "tomorrow" still means the coming day, which is already today's date.
    date = now.getHours() < 4 ? base : addDays(base, 1);
    text = text.replace(/\btomorrow\b/gi, ' ');
  } else if (/\btonight\b/i.test(text)) {
    date = base;
    slot = 'evening';
    text = text.replace(/\btonight\b/gi, ' ');
  } else if (/\btoday\b/i.test(text)) {
    date = base;
    text = text.replace(/\btoday\b/gi, ' ');
  } else if ((m = text.match(/\b(?:on\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i))) {
    const target = WEEKDAYS.indexOf(m[1].toLowerCase());
    const diff = ((target - now.getDay() + 7) % 7) || 7;
    date = addDays(base, diff);
    text = text.replace(m[0], ' ');
  }

  // A range like "from 6 to 7 pm" or "6-7:30pm" sets a start and end time.
  let endTime = '';
  const rg = text.match(/\b(?:from\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:-|–|to|till|until)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/i);
  if (rg) {
    const merEnd = rg[6].toLowerCase().replace(/\./g, '');
    const merStart = (rg[3] || '').toLowerCase().replace(/\./g, '') || merEnd;
    const to24 = (h, m, mer) => {
      h = Number(h);
      if (h > 12 || Number(m || 0) > 59) return '';
      if (mer.startsWith('p') && h < 12) h += 12;
      else if (mer.startsWith('a') && h === 12) h = 0;
      return `${pad(h)}:${pad(Number(m || 0))}`;
    };
    time = to24(rg[1], rg[2], merStart);
    endTime = to24(rg[4], rg[5], merEnd);
    if (time && endTime && endTime <= time && !rg[3]) time = to24(rg[1], rg[2], merEnd === 'pm' ? 'am' : 'pm');
    if (!time || !endTime || endTime <= time) endTime = '';
    text = text.replace(rg[0], ' ');
  }

  // Single times: "4 pm", "4:30pm", "at 4", "4 o'clock", "16:00", "four o'clock".
  const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  text = text.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?=\s*(?:o\s*['’]?\s*clock|a\.?m\.?|p\.?m\.?)(?![a-z]))/gi,
    (w) => String(NUM_WORDS[w.toLowerCase()]));
  const dayPart = (text.match(/\b(morning|afternoon|evening|night|tonight)\b/i) || [])[1]?.toLowerCase() || (slot === 'evening' ? 'evening' : '');
  const tm = !time && (
    text.match(/\b(?:at\s+|by\s+|for\s+|@\s*)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/i)
    || text.match(/\b(?:at\s+|by\s+|for\s+|@\s*)?(\d{1,2})(?::(\d{2}))?\s*o\s*['’]?\s*clock\b()/i)
    || text.match(/\b(?:at\s+|by\s+|for\s+|@\s*)?([01]?\d|2[0-3]):([0-5]\d)\b()/i)
    || text.match(/\b(?:at|by|@)\s*(\d{1,2})(?::(\d{2}))?()\b/i));
  if (tm) {
    let h = Number(tm[1]);
    const min = Number(tm[2] || 0);
    const mer = (tm[3] || '').toLowerCase().replace(/\./g, '');
    if (h <= 23 && min < 60) {
      if (mer.startsWith('p') && h < 12) h += 12;
      else if (mer.startsWith('a') && h === 12) h = 0;
      else if (!mer && h >= 1 && h <= 12) {
        // No am/pm: use the part of day if said, else 1-6 means afternoon or evening.
        if (dayPart === 'morning') h = h === 12 ? 0 : h;
        else if (dayPart) h = h < 12 ? h + 12 : h;
        else if (h <= 6) h += 12;
      }
      time = `${pad(h)}:${pad(min)}`;
    }
    text = text.replace(tm[0], ' ');
  }

  const sm = text.match(/\b(?:in the\s+)?(morning|afternoon|evening|night)\b/i);
  if (sm) {
    const word = sm[1].toLowerCase();
    slot = word === 'night' ? 'evening' : word;
    text = text.replace(sm[0], ' ');
  }

  return { text, date, time, endTime, slot: time ? '' : slot };
}

// ---------- title tidy-up ----------
// Light offline grammar fixes for spoken titles: "home concrete of Akshay" ->
// "Akshay's home concrete", "birthday of mom" -> "Mom's birthday", doubled
// words, and "i" -> "I". Only safe, common patterns; the AI path handles the rest.
const KIN = 'mom|mum|mother|dad|father|parents|sister|brother|sis|bro|wife|husband|son|daughter|kids|baby|grandma|grandpa|grandmother|grandfather|uncle|aunt|aunty|auntie|cousin|nephew|niece|friend|boss|manager|team|client|neighbour|neighbor|teacher|doctor';
const OWNED = new Set(('home house flat apartment room office place car bike scooter phone laptop computer bag keys wallet birthday party wedding anniversary '
  + 'gift present cake appointment meeting interview exam test results report project presentation documents docs files paperwork papers '
  + 'bill bills rent salary invoice payment fees school class homework assignment medicine medicines prescription tablets ticket tickets '
  + 'passport visa license licence insurance loan account order parcel package delivery dog cat pet plants garden concrete construction '
  + 'renovation repair repairs plumbing wiring painting work job resume cv portfolio website app design proposal contract agreement').split(' '));
const VERBS = new Set(('call text message email mail ping ring meet see visit buy get order pick collect drop send pay book check fix clean wash '
  + 'finish complete submit review prepare plan schedule cancel renew sign print bring take make write read update share confirm remind ask tell '
  + 'start continue arrange organise organize sort file return deliver attend join celebrate wish').split(' '));
// Spoken filler that never belongs in a title, so most messy titles are fixed for free.
const FILLER_ANY = /,?\s*\b(?:um+|uh+|erm+|hmm+|you know|I mean)\b,?/gi;
const FILLER_LEAD = /^(?:so|basically|like|yeah|yes|okay|ok|well|actually|just|and|then|also)\b[\s,]*/i;
const FILLER_TAIL = /[\s,]*\b(?:okay|ok|please|yeah|and stuff|and things|or something|and all that|and everything|before|by|until|till|on|at|from)$/i;
function stripFiller(s) {
  s = s.replace(FILLER_ANY, ' ').replace(/\s+/g, ' ').trim();
  for (let prev = ''; prev !== s;) { prev = s; s = s.replace(FILLER_LEAD, '').replace(FILLER_TAIL, '').trim(); }
  return s;
}
function tidyTitle(text) {
  let s = text.replace(/\b(\w+)(\s+\1\b)+/gi, '$1').replace(/\bi\b/g, 'I').replace(/\s+/g, ' ').trim();
  const cleaned = stripFiller(s);
  if (cleaned) s = cleaned;
  const m = s.match(new RegExp(`^(.*?)\\b((?:\\w+\\s+){0,2}\\w+)\\s+of\\s+(my\\s+|our\\s+)?(${KIN}|[A-Z][a-z]+)$`, 'i'));
  if (m) {
    const [, before, thing, mine = '', owner] = m;
    const isKin = new RegExp(`^(${KIN})$`, 'i').test(owner);
    const isName = /^[A-Z]/.test(owner) && !isKin;
    let words = thing.split(/\s+/);
    let verb = before.trim();
    // Keep a leading action word in front: "buy gift of mom" -> "Buy mom's gift".
    if (!verb && VERBS.has(words[0].toLowerCase()) && words.length > 1) {
      const n = /^(up|off|out|in)$/i.test(words[1]) && words.length > 2 ? 2 : 1;
      verb = words.slice(0, n).join(' '); words = words.slice(n);
    }
    const owns = words.some((w) => OWNED.has(w.toLowerCase())) && words.every((w) => /^[a-z]/.test(w) || words.length === 1);
    if (owns && (isKin || isName) && !/^(the|a|an)$/i.test(words[0])) {
      const who = isKin ? owner.toLowerCase() : owner;
      const poss = isKin && /s$/i.test(who) ? `${who}'` : `${who}'s`;
      s = `${verb ? verb + ' ' : ''}${mine.toLowerCase()}${poss} ${words.join(' ')}`;
    }
  }
  return s.replace(/^./, (c) => c.toUpperCase());
}

function parseLocal(input, { whole = false } = {}) {
  const actions = [];
  // Shared text is one thing to do, so it isn't split on commas or "and".
  for (const raw of whole ? [applyCorrections(input)] : splitItems(input)) {
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

    const HIGH = /\b(urgent|urgently|asap|important|high priority)\b/gi;
    const LOW = /\b(low priority|no rush|whenever|not urgent|sometime)\b/gi;
    const priority = HIGH.test(s) ? 'high' : LOW.test(s) ? 'low' : 'medium';
    const withoutPriority = s.replace(HIGH, ' ').replace(LOW, ' ');
    const when = extractWhen(withoutPriority);
    let text = when.text.replace(/\s+/g, ' ').replace(/^\s*(on|by|at|in)\s+/i, '')
      .replace(/\s+(on|by|at|in|for)\s*$/i, '').trim();
    for (let i = 0; i < 2; i++) text = text.replace(FILLER, '');
    text = tidyTitle(text.trim());
    if (text) {
      actions.push({
        type: 'add',
        text,
        priority,
        date: when.date || todayKey(),
        time: when.time,
        endTime: when.endTime,
        slot: when.slot,
      });
    }
  }
  return actions;
}

// ---------- Claude-powered parser (optional) ----------
async function parseWithLLM(input, apiKey) {
  const today = todayKey();
  const open = tasks.filter((t) => !t.done && t.date === today).map((t) => t.text);
  const system = [
    'You convert a short typed or speech-recognized note into JSON actions for a personal to-do app.',
    ...(roleLabel() ? [`The user works as: ${roleLabel()}. Use that to read their jargon, but don't add words they didn't say.`] : []),
    'Return ONLY a JSON object: {"actions":[...]}.',
    'Action types:',
    '{"type":"add","text":"short task, under 10 words","priority":"high"|"medium"|"low","date":"YYYY-MM-DD or null","time":"HH:MM 24-hour start time or null","endTime":"HH:MM 24-hour end time or null","slot":"morning"|"afternoon"|"evening"|null}',
    '{"type":"done","match":"words identifying an existing task"}',
    '{"type":"delete","match":"words identifying an existing task"}',
    '{"type":"rename","match":"existing task","text":"new text"}',
    'Split separate tasks into separate add actions. Fix obvious speech-recognition errors. Mark urgent or important items as high priority, things with no rush as low, and everything else as medium.',
    'Only set date, time or slot when the speaker said them. Never guess a time. Use null when unsure.',
    'Task text is a clean, natural, grammatical title in the speaker\'s language: reorder awkward speech ("home concrete of Akshay" -> "Akshay\'s home concrete", "birthday of mom" -> "Mom\'s birthday"), drop filler, keep names and meaning, never add details that weren\'t said.',
    'Speakers correct themselves ("tomorrow, sorry, today", "at 5 no 6", "Monday actually Tuesday", "not today but tomorrow"): the later value wins, and the slip and words like "sorry" never go in the task text.',
    ...(new Date().getHours() < 4 ? ['It is past midnight: "tomorrow" means the coming day, which is today\'s date, and "tonight" means today.'] : []),
    `Today is ${today}. Tomorrow is ${addDays(today, 1)}.`,
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
  const actions = Array.isArray(json.actions) ? json.actions : [];

  // Keep only well-formed values from the model.
  return actions.map((a) => {
    if (a.type !== 'add') return a;
    return {
      ...a,
      date: /^\d{4}-\d{2}-\d{2}$/.test(a.date || '') ? a.date : today,
      time: /^\d{2}:\d{2}$/.test(a.time || '') ? a.time : '',
      endTime: /^\d{2}:\d{2}$/.test(a.endTime || '') && /^\d{2}:\d{2}$/.test(a.time || '') && a.endTime > a.time ? a.endTime : '',
      priority: normPriority(a.priority === 'normal' ? 'medium' : a.priority),
      slot: SLOTS[a.slot] ? a.slot : '',
    };
  });
}

// ---------- tasks ----------
function makeTask(p) {
  const time = p.time || '';
  const date = p.date || todayKey();
  const task = normalizeTask({
    id: uid(),
    text: p.text,
    priority: normPriority(p.priority),
    done: false,
    date,
    time,
    endTime: time && p.endTime && p.endTime > time ? p.endTime : '',
    slot: time ? '' : (p.slot || ''),
    reminder: Boolean(time),
    repeat: p.repeat || 'none',
    notes: p.notes || '',
    created: Date.now(),
  });
  task.notified = dueAt(task) !== null && dueAt(task) <= Date.now();
  return task;
}

function dueAt(t) {
  if (!t.time || !t.date) return null;
  return new Date(`${t.date}T${t.time}:00`).getTime();
}

// Marks a task done. Repeating tasks leave the next occurrence behind.
function completeTask(t) {
  t.done = true;
  if (t.repeat && t.repeat !== 'none') {
    const days = t.repeat === 'weekly' ? 7 : 1;
    tasks.push(makeTask({
      text: t.text,
      priority: t.priority,
      date: addDays(t.date, days),
      time: t.time,
      endTime: t.endTime,
      slot: t.slot,
      repeat: t.repeat,
      notes: t.notes,
    }));
  }
}

// ---------- applying actions (done, delete, rename, add) ----------
function applyActions(actions) {
  const log = [];

  for (const a of actions) {
    if (a.type === 'add') {
      tasks.push(makeTask(a));
      log.push(`Added “${a.text}”`);
      continue;
    }

    const t = findTask(a.match || '');
    if (!t) {
      log.push(`No task matches “${a.match}”`);
      continue;
    }

    if (a.type === 'done') {
      if (!t.done) completeTask(t);
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

// ---------- voice + capture ----------
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
const cap = { items: [], other: [], transcript: '' };
let recognizer = null;
let listening = false;
let captureOpen = false;

function setCapTitle(text) { $('#cap-title').textContent = text; }

function showCapPanel(name) {
  for (const p of ['listen', 'text', 'process', 'confirm']) {
    $(`#cap-${p}`).hidden = p !== name;
  }
  // Boxes measured while hidden stay one line tall; size them now they show.
  requestAnimationFrame(() => { for (const ta of $$(`#cap-${name} textarea[data-autogrow]`)) autoGrow(ta); });
}

function openCapture(mode = 'voice') {
  captureOpen = true;
  cap.items = [];
  cap.other = [];
  cap.transcript = '';
  $('#capture').hidden = false;
  if (mode === 'text' || !SpeechRec) {
    if (mode === 'voice') toast('Voice isn’t supported in this browser. Type instead.');
    openTextPanel();
  } else {
    startListening();
  }
}

function closeCapture() {
  planTomorrow = false;
  shared = null;
  stopDictation();
  captureOpen = false;
  cancelVoice();
  $('#capture').hidden = true;
}

function openTextPanel() {
  setCapTitle('Type');
  showCapPanel('text');
  $('#cap-input').value = '';
  setTimeout(() => $('#cap-input').focus(), 250);
}

// Fills the wave bars once, with a different height and speed for each.
function buildWave() {
  const wave = $('#wave');
  if (wave.childElementCount) return;
  const heights = [34, 62, 46, 84, 56, 92, 50, 78, 40, 66, 30];
  wave.innerHTML = heights.map((h, i) =>
    `<span style="--h:${h}px;animation-delay:${(-i * 0.13).toFixed(2)}s"></span>`).join('');
}

// How long Blip waits after the last heard word before it treats you as done.
const SILENCE_MS = 3000;
// Stops the current listening session without sending what was heard.
let cancelVoice = () => {};

// Joins recognition results into one transcript. Android Chrome repeats
// earlier words inside later results, so a result that already contains the
// previous text replaces it instead of being appended.
function joinResults(results) {
  let text = '';
  for (let i = 0; i < results.length; i++) {
    const part = results[i][0].transcript.trim();
    if (!part) continue;
    const prev = text.toLowerCase();
    const cur = part.toLowerCase();
    if (prev && cur.startsWith(prev)) text = part;
    else if (prev.endsWith(cur)) continue;
    else text = text ? `${text} ${part}` : part;
  }
  return text.trim();
}

function startListening() {
  setCapTitle('Voice');
  showCapPanel('listen');
  buildWave();
  $('#cap-live').textContent = '';
  $('#cap-listen h2').textContent = 'Listening…';

  // Text from earlier recognition sessions, if the browser ended one early.
  let carried = '';
  let latest = '';
  let handled = false;
  let silenceTimer = null;
  let wantStop = false;
  let rec = null;

  const finish = () => {
    if (handled || !captureOpen) return;
    handled = true;
    clearTimeout(silenceTimer);
    listening = false;
    if (rec) {
      rec.onend = null;
      rec.onresult = null;
      try { rec.stop(); } catch { /* already stopped */ }
    }
    if (latest) processText(latest);
    else {
      toast('I didn’t catch that. Try again or type it.');
      openTextPanel();
    }
  };

  const armSilence = () => {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(finish, SILENCE_MS);
  };

  const begin = () => {
    rec = new SpeechRec();
    recognizer = rec;
    rec.lang = 'en-IN';
    rec.interimResults = true;
    rec.continuous = true;

    rec.onstart = () => {
      if (!listening) haptic();
      listening = true;
    };

    rec.onresult = (e) => {
      const heard = joinResults(e.results);
      latest = [carried, heard].filter(Boolean).join(' ').trim();
      $('#cap-live').textContent = latest;
      // Every new word restarts the countdown, so pauses don't cut you off.
      armSilence();
    };

    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        wantStop = true;
        toast('Allow microphone access in your browser settings.');
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        toast(`Mic error: ${e.error}`);
      }
    };

    // Phones often end a session on a short pause. Unless you tapped stop or
    // the silence window has passed, start listening again and keep the text.
    rec.onend = () => {
      if (handled || !captureOpen) return;
      carried = latest;
      if (wantStop) { finish(); return; }
      try { begin(); } catch { finish(); }
    };

    rec.start();
  };

  $('#cap-stop').onclick = () => {
    wantStop = true;
    finish();
  };

  cancelVoice = () => {
    handled = true;
    clearTimeout(silenceTimer);
    listening = false;
    if (rec) {
      rec.onend = null;
      rec.onresult = null;
      try { rec.abort(); } catch { /* already stopped */ }
    }
  };

  try {
    begin();
    // If nothing is said at all, give up after a longer wait.
    silenceTimer = setTimeout(finish, 8000);
  } catch {
    openTextPanel();
    toast('Couldn’t start the mic. Type instead.');
  }
}

// Turns what was said or typed into tasks, then shows them for review.
let processing = false;
const HAS_DAY = /\b(today|tonight|tomorrow|tmrw|yesterday|mon|tues?|wed(nes)?|thu(rs)?|fri|sat(ur)?|sun)(day)?\b|\b(next|this) (week|month|year)\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b\d{1,2}(st|nd|rd|th)\b|\bin \d+ days?\b/i;
let planTomorrow = false;
let shared = null; // text shared into Blip from another app: { text, notes, from }
let planAll = false; // this text said no day: every task goes on tomorrow
async function processText(text) {
  text = text.trim();
  planAll = planTomorrow && Boolean(text) && !HAS_DAY.test(text);
  if (!text || processing) return;
  processing = true;
  try {
    await runProcess(text);
  } finally {
    processing = false;
  }
}

// Signed-in users get grammar-tidied titles from Blip's server (Claude), but only
// for titles the offline rules couldn't clean up: most tasks never leave the phone.
// It only rewrites titles, never dates or times, and if it's slow, missing, over
// the daily limit or offline, the offline titles stay as they are.
const AI_CAP_KEY = 'blip.ai.capped';
const MESSY_WORDS = /\b(um+|uh+|erm|hmm+|like|basically|actually|literally|kinda|kind of|sort of|gonna|wanna|gotta|you know|i mean|stuff|thingy?|something|whatever|okay|ok|yeah|please)\b/i;
const MESSY_START = /^(to|that|and|so|then|also|maybe|just|remember|remind|don'?t forget|need|have)\b/i;
function needsPolish(title) {
  const words = title.trim().split(/\s+/);
  return words.length >= 7 || MESSY_WORDS.test(title) || MESSY_START.test(title);
}
let tidyOff = false;
const utcDay = () => new Date().toISOString().slice(0, 10);
async function tidyWithAI(text, actions) {
  if (!window.BLIP_CONFIG?.aiTitles || tidyOff || !sb || !profile || profile.mode === 'guest' || !navigator.onLine) return;
  if (localStorage.getItem(AI_CAP_KEY) === utcDay()) return; // daily limit reached; try again tomorrow
  const adds = actions.filter((a) => a.type === 'add' && a.text && needsPolish(a.text));
  if (!adds.length) return;
  try {
    const call = sb.functions.invoke('tidy-titles', { body: { text, titles: adds.map((a) => a.text) } });
    const res = await Promise.race([call, wait(2500).then(() => null)]);
    if (!res) return;
    if (res.error) { if ([401, 404].includes(res.error.context?.status)) tidyOff = true; return; }
    if (res.data?.capped) localStorage.setItem(AI_CAP_KEY, utcDay());
    const out = res.data?.titles;
    if (Array.isArray(out) && out.length === adds.length) {
      adds.forEach((a, i) => { if (typeof out[i] === 'string' && out[i].trim()) a.text = out[i].trim(); });
    }
  } catch { /* keep the offline titles */ }
}

async function runProcess(text) {
  captureOpen = true;
  $('#capture').hidden = false;
  setCapTitle('Creating');
  showCapPanel('process');
  $('#cap-quote').textContent = `“${text}”`;

  const started = Date.now();
  let actions;
  let warning = '';
  const share = shared && shared.text === text ? shared : null;
  try {
    // Shared text always uses the offline rules, and can only add tasks: a message
    // that starts "delete…" or "done…" never touches the tasks you already have.
    if (share) {
      actions = parseLocal(text, { whole: true }).filter((a) => a.type === 'add');
      if (!actions.length) actions = [{ type: 'add', text: tidyTitle(text.replace(/[.!?]+$/, '')), priority: 'medium', date: todayKey() }];
    } else {
      actions = settings.apiKey ? await parseWithLLM(text, settings.apiKey) : parseLocal(text);
    }
  } catch (err) {
    warning = ` (AI parse failed: ${err.message}; used the offline parser)`;
    actions = parseLocal(text);
  }
  if (!settings.apiKey && !share) await tidyWithAI(text, actions);
  await wait(Math.max(0, 600 - (Date.now() - started)));
  if (!captureOpen) return;

  const adds = actions.filter((a) => a.type === 'add' && a.text);
  if (planAll) for (const a of adds) a.date = addDays(todayKey(), 1);
  const other = actions.filter((a) => a.type !== 'add');

  if (!adds.length && !other.length) {
    closeCapture();
    toast('Nothing to add.');
    return;
  }
  if (!adds.length) {
    const log = applyActions(other);
    closeCapture();
    toast((log.join(' · ') || 'Done.') + warning);
    return;
  }

  cap.transcript = text;
  cap.other = other;
  cap.items = [...adds].sort(byWhen).map((a) => ({
    id: uid(),
    text: a.text,
    priority: normPriority(a.priority),
    date: a.date || todayKey(),
    time: a.time || '',
    endTime: a.time && a.endTime ? a.endTime : '',
    notes: share?.notes || '',
  }));
  cap.editing = false;
  $('#cap-said-label').textContent = share ? `Shared${share.from ? ` from ${share.from}` : ''}` : 'You said';
  setCapTitle('Review');
  renderConfirm();
  showCapPanel('confirm');
  if (warning) toast(warning.trim());
}

function priorityChips(current) {
  return PRIORITIES.map(([v, l]) =>
    `<button class="prio-chip p-${v}${current === v ? ' on' : ''}" type="button" data-act="prio-cap" data-v="${v}" aria-pressed="${current === v}"><span class="dot"></span>${l}</button>`).join('');
}

function renderConfirm() {
  renderTranscript();
  $('#cap-items').innerHTML = cap.items.map((it, i) => `
    <li class="cap-item" data-idx="${i}">
      ${cap.items.length > 1 ? `<p class="cap-num">Task ${i + 1}</p>` : ''}
      <div class="cap-row">
        <textarea class="cap-task-title" data-f="text" data-autogrow data-oneline rows="1" aria-label="Task ${i + 1} title">${esc(it.text)}</textarea>
        <button class="icon-btn" type="button" data-act="edit-cap" aria-label="Edit task ${i + 1}" style="width:36px;height:36px">${ICON.pencil}</button>
      </div>
      <div class="cap-fields three">
        <label class="full">Date<input type="date" data-f="date" value="${esc(it.date)}"></label>
        <label>Start time<input type="time" data-f="time" value="${esc(it.time)}"></label>
        <label>End time<input type="time" data-f="endTime" value="${esc(it.endTime)}"></label>
      </div>
      <div class="prio-row" role="group" aria-label="Priority">${priorityChips(it.priority)}</div>
      ${notesField(`data-f="notes" aria-label="Notes for task ${i + 1}"`, it.notes)}
    </li>`).join('');
  for (const ta of $$('#cap-items textarea')) autoGrow(ta);
}

// A two-line notes box that grows as you type, with a mic for dictation.
function notesField(attrs, value = '') {
  return `<div class="notes-field">
      <textarea ${attrs} rows="2" data-autogrow placeholder="Add notes">${esc(value)}</textarea>
      <button class="dictate" type="button" data-dictate aria-label="Speak notes" aria-pressed="false">${ICON.mic}</button>
    </div>`;
}

function autoGrow(ta) {
  // Hidden boxes measure as 0; leave them at their two-line default.
  if (!ta.offsetParent) { ta.style.height = ''; return; }
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + 2}px`;
}
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.matches?.('textarea[data-oneline]') && /\n/.test(t.value)) {
    const at = t.selectionStart;
    t.value = t.value.replace(/\s*\n+\s*/g, ' ');
    t.setSelectionRange(Math.min(at, t.value.length), Math.min(at, t.value.length));
  }
  if (t.matches?.('textarea[data-autogrow]')) autoGrow(t);
});
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (!t.matches?.('textarea[data-oneline]') || e.key !== 'Enter' || e.isComposing) return;
  e.preventDefault();
  if (t.id === 'nf-title') $('#nf-body').focus();
  else t.blur();
});
// The task title wraps like a heading, but Enter still saves instead of adding a line.
document.addEventListener('keydown', (e) => {
  if (e.target.id === 'tf-title' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#task-form').requestSubmit();
  }
});

// ---------- dictation into a text box ----------
// Tap the mic next to a notes box and speak; the words are added to the box.
// Stops on a second tap, or 3 seconds after the last word.
let dictation = null;

// Spoken lists ("milk onion bread biscuits", "milk, eggs and bread") become bullets.
// Only when every piece is short and it reads like items, not a sentence.
const BULLET = '• ';
const LIST_STOP = /^(the|a|an|to|is|are|was|be|for|with|at|on|in|of|my|our|your|his|her|their|i|we|you|he|she|it|they|that|this|please|need|needs|want|should|must|will|can|could|would|have|has|had|do|does|did|if|but|because|so|about|from|before|after|when|then|call|tell|ask|send|remind|check|make|go|come|meet|pay)$/i;
const LIST_PAIRS = new Set(('peanut butter|ice cream|olive oil|coconut oil|sunflower oil|toilet paper|tissue paper|paper towels|green chilli|green chillies|red chilli|curry leaves|spring onion|spring onions|brown bread|white bread|brown rice|basmati rice|soy sauce|tomato sauce|tomato ketchup|baking soda|baking powder|cream cheese|sour cream|whipped cream|fresh cream|corn flakes|dish soap|hand wash|body wash|face wash|tooth paste|tooth brush|garbage bags|bin bags|aluminium foil|cling film|orange juice|apple juice|coconut milk|almond milk|oat milk|green tea|black pepper|sea salt|chicken breast|frozen peas|sweet potato|bell pepper|lady finger|bitter gourd|bottle gourd|ground nut|ground nuts|cashew nuts|dry fruits|cat food|dog food|phone charger|aa batteries|light bulb').split('|'));
function listItems(text) {
  const raw = text.replace(/[.!?]+$/, '').trim();
  if (!raw || /\n/.test(raw)) return null;
  // Words to items, keeping common two-word items together ("olive oil").
  const tokens = (part) => {
    const words = part.split(/\s+/), out = [];
    for (let i = 0; i < words.length; i++) {
      if (LIST_PAIRS.has(`${words[i]} ${words[i + 1] || ''}`.toLowerCase())) { out.push(`${words[i]} ${words[i + 1]}`); i++; } else out.push(words[i]);
    }
    return out;
  };
  const words = raw.split(/\s+/);
  if (words.length > 30 || words.some((w) => LIST_STOP.test(w))) return null;
  const pieces = raw.split(/\s*,\s*|\s+(?:and|then|also|plus)\s+/i).filter(Boolean);
  let parts;
  if (pieces.length < 2) {
    // No separators: every word is an item, so it has to look like a shopping list.
    if (words.length < 3 || words.some((w) => /\d/.test(w))) return null;
    parts = tokens(raw);
  } else {
    // "tomatoes potatoes onions and green chillies": split runs of single words too.
    parts = pieces.flatMap((p) => { const t = tokens(p); return t.length >= 3 ? t : [p]; });
  }
  if (parts.length < 3 || parts.some((p) => p.split(/\s+/).length > 4)) return null;
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1));
}
const bullets = (items) => items.map((i) => BULLET + i).join('\n');

// Enter on a bullet line starts the next bullet; Enter on an empty bullet ends the list.
document.addEventListener('keydown', (e) => {
  const ta = e.target;
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing || !ta.closest?.('.notes-field')) return;
  const start = ta.selectionStart;
  const lineStart = ta.value.lastIndexOf('\n', start - 1) + 1;
  const line = ta.value.slice(lineStart, start);
  if (!line.startsWith(BULLET)) return;
  e.preventDefault();
  if (line.trim() === BULLET.trim()) {
    ta.setRangeText('', lineStart, start, 'end');
  } else {
    ta.setRangeText('\n' + BULLET, start, ta.selectionEnd, 'end');
  }
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  autoGrow(ta);
});

function stopDictation() {
  if (!dictation) return;
  const d = dictation;
  dictation = null;
  clearTimeout(d.timer);
  d.btn.classList.toggle('on', false);
  d.btn.setAttribute('aria-pressed', 'false');
  if (d.rec) {
    d.rec.onend = null;
    d.rec.onresult = null;
    try { d.rec.stop(); } catch { /* already stopped */ }
  }
  // A spoken list becomes bullets, added under anything already in the box.
  const spoken = [d.carried, d.heard].filter(Boolean).join(' ').trim();
  const items = can('bullets') && spoken && listItems(spoken);
  if (items) {
    d.ta.value = d.base + (d.base ? '\n' : '') + bullets(items);
    autoGrow(d.ta);
  }
  d.ta.dispatchEvent(new Event('input', { bubbles: true }));
}

function startDictation(ta, btn) {
  if (dictation?.ta === ta) { stopDictation(); return; }
  stopDictation();
  if (!SpeechRec) {
    toast('Voice isn’t supported in this browser. Use the keyboard’s mic.');
    return;
  }
  const base = ta.value.replace(/\s+$/, '');
  const d = { ta, btn, base, carried: '', heard: '', timer: null, rec: null };
  dictation = d;
  btn.classList.toggle('on', true);
  btn.setAttribute('aria-pressed', 'true');

  const write = () => {
    const spoken = [d.carried, d.heard].filter(Boolean).join(' ');
    const text = spoken ? spoken.charAt(0).toUpperCase() + spoken.slice(1) : '';
    const sep = base && text ? (/(^|\n)• [^\n]*$/.test(base) ? '\n' : /[.!?]$/.test(base) ? ' ' : '. ') : '';
    ta.value = base + sep + text;
    autoGrow(ta);
  };
  const arm = (ms) => {
    clearTimeout(d.timer);
    d.timer = setTimeout(() => { if (dictation === d) stopDictation(); }, ms);
  };
  const begin = () => {
    const rec = new SpeechRec();
    d.rec = rec;
    rec.lang = 'en-IN';
    rec.interimResults = true;
    rec.continuous = true;
    rec.onresult = (e) => {
      d.heard = joinResults(e.results);
      write();
      arm(SILENCE_MS);
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        toast('Allow microphone access in your browser settings.');
        stopDictation();
      }
    };
    // Phones end sessions on short pauses; keep going until the silence timer.
    rec.onend = () => {
      if (dictation !== d) return;
      d.carried = [d.carried, d.heard].filter(Boolean).join(' ');
      d.heard = '';
      try { begin(); } catch { stopDictation(); }
    };
    rec.start();
  };
  try {
    begin();
    arm(8000);
    haptic();
  } catch {
    stopDictation();
    toast('Couldn’t start the mic.');
  }
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest?.('[data-dictate]');
  if (!btn) return;
  const ta = btn.closest('.notes-field').querySelector('textarea');
  startDictation(ta, btn);
});

// The "You said" box: read-only quote with an edit button, or a text area.
function renderTranscript() {
  $('#cap-transcript').hidden = cap.editing;
  $('#cap-transcript-edit').hidden = !cap.editing;
  $('#cap-transcript').textContent = `“${cap.transcript}”`;
  $('#cap-edit-said').textContent = cap.editing ? 'Cancel' : 'Edit';
}

$('#cap-edit-said').addEventListener('click', () => {
  cap.editing = !cap.editing;
  renderTranscript();
  if (cap.editing) {
    const box = $('#cap-said-input');
    box.value = cap.transcript;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }
});
$('#cap-said-update').addEventListener('click', () => {
  const text = $('#cap-said-input').value.trim();
  if (!text) {
    toast('Type what you want to add');
    return;
  }
  cap.editing = false;
  processText(text);
});

// Review screen edits update the data in place, so typing never loses focus.
$('#cap-items').addEventListener('input', (e) => {
  const li = e.target.closest('[data-idx]');
  const field = e.target.dataset.f;
  if (!li || !field) return;
  const it = cap.items[Number(li.dataset.idx)];
  it[field] = field === 'text' ? e.target.value.replace(/\s*\n+\s*/g, ' ') : e.target.value;
});
$('#cap-items').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const li = btn.closest('[data-idx]');
  const it = cap.items[Number(li.dataset.idx)];
  if (btn.dataset.act === 'edit-cap') {
    const ta = li.querySelector('[data-f="text"]');
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  } else if (btn.dataset.act === 'prio-cap') {
    it.priority = btn.dataset.v;
    for (const c of li.querySelectorAll('.prio-chip')) {
      const on = c.dataset.v === it.priority;
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', String(on));
    }
  }
});

$('#cap-add').addEventListener('click', () => {
  const items = cap.items.filter((i) => i.text.trim());
  if (!items.length && !cap.other.length) {
    toast('Nothing to add yet.');
    return;
  }
  // Times are optional. An end time only counts with a start time before it.
  if (items.some((i) => i.endTime && !i.time)) {
    toast('Set a start time to go with the end time');
    return;
  }
  if (items.some((i) => i.endTime && i.endTime <= i.time)) {
    toast('End time must be after the start time');
    return;
  }
  for (const it of items) {
    tasks.push(makeTask({
      text: it.text.trim(),
      priority: it.priority,
      date: it.date || todayKey(),
      time: it.time,
      endTime: it.endTime,
      notes: (it.notes || '').trim(),
    }));
  }
  const log = applyActions(cap.other);
  save();
  const parts = [];
  if (items.length) parts.push(`Added ${items.length} task${items.length === 1 ? '' : 's'}`);
  parts.push(...log);
  closeCapture();
  showView('tasks');
  toast(parts.join(' · '));
  haptic();
  if (items.length) playAddedSound();
});

$('#cap-cancel').addEventListener('click', closeCapture);
$('#cap-close').addEventListener('click', closeCapture);
$('#cap-type').addEventListener('click', () => {
  // Cancel first, so stopping doesn't send half-heard words on.
  cancelVoice();
  openTextPanel();
});
$('#cap-speak').addEventListener('click', () => startListening());
$('#cap-continue').addEventListener('click', () => {
  processText($('#cap-input').value);
});
$('#cap-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) processText($('#cap-input').value);
});

// ---------- rendering ----------
const sortTasks = (a, b) =>
  (a.done - b.done) ||
  (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]) ||
  (timeKey(a).localeCompare(timeKey(b))) ||
  (a.created - b.created);

function taskHTML(t, { carry = false } = {}) {
  const bell = t.reminder && t.time ? `<span title="Reminder on" aria-label="Reminder on">${ICON.bell}</span>` : '';
  const high = `<span class="tag-prio p-${t.priority}"><span class="dot"></span>${PRIORITY_LABEL[t.priority]}</span>`;
  const repeat = t.repeat && t.repeat !== 'none' ? '<span>· Repeats</span>' : '';
  return `
    <li class="task${t.done ? ' done' : ''}${carry ? ' carry' : ''}" data-id="${t.id}">
      <button class="check" type="button" data-act="toggle" aria-label="${t.done ? 'Mark not done' : 'Mark done'}">${ICON.check}</button>
      <button class="task-body" type="button" data-act="open" aria-label="Open ${esc(t.text)}">
        <span class="task-title">${esc(t.text)}</span>
        <span class="task-meta">${ICON.clock}<span>${esc(whenText(t))}</span>${repeat}${bell}${high}</span>
      </button>
      ${carry ? '<button class="pill-btn sm" type="button" data-act="move">Move to today</button>' : ''}
      <button class="x-del" type="button" data-act="delete" aria-label="Delete task">${ICON.trash}</button>
    </li>`;
}

// Search and filter state.
const ui = { view: 'home', filter: 'all', query: '', noteQuery: '', backTo: 'tasks' };
let editingId = null;
let editingNote = null;
let tfPriority = 'medium';
let calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let calSelected = todayKey();

const greeting = () => {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
};

function renderHome() {
  const today = todayKey();
  const todays = tasks.filter((t) => t.date === today);
  const doneCount = todays.filter((t) => t.done).length;
  $('#stat-total').textContent = todays.length;
  $('#stat-done').textContent = doneCount;
  $('#stat-open').textContent = todays.length - doneCount;
  $('#stat-carry').textContent = tasks.filter((t) => t.date < today && !t.done).length;
  const first = displayName().split(/\s+/)[0];
  $('#greeting').textContent = `${greeting()}${first ? `, ${first}` : ''} · ${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}`;
  renderHeadline(todays, doneCount);
  renderDaySummary();
  renderMorningPlan();
}

// ---------- day summary ----------
// After the summary time (7 PM unless changed in Settings), Home shows how the
// day went, between the headline and the mic, until midnight.
const SUMMARY_HIDE_KEY = 'blip.summary.hidden';
const SUMMARY_SEEN_KEY = 'blip.summary.seen';
const summaryTime = () => (can('summary') ? settings.summaryTime || S.DEFAULT_TIME : 'off');
function summaryDue(now = new Date()) {
  const at = S.summaryAt(summaryTime(), now);
  return Boolean(at && now >= at);
}
function todaySummary() {
  const today = todayKey();
  return S.daySummary(tasks, today, addDays(today, 1), displayName().split(/\s+/)[0], { lite: MODEL_FEATURES[modelId()].summary === 'lite' });
}
// Collapsed to a pill by default; tap to open the full summary.
let summaryOpen = false;
let summaryAnytime = false; // opened from the + menu before the usual time
// "Summarize today" and the first open of the day walk through a few steps
// (reading tasks, checking done and open, writing) before the summary appears.
let summaryBuild = null; // { step, steps } while building
let summaryReveal = false; // fade the finished summary in once
let summaryBuildTimer = 0;
function summarySteps() {
  const s = todaySummary();
  const left = s.open.length + s.older.length;
  const steps = [
    { doing: s.total ? `Reading your ${s.total} task${s.total === 1 ? '' : 's'} for today` : 'Reading your list for today', done: s.total ? `Read ${s.total} task${s.total === 1 ? '' : 's'}` : 'Nothing on today’s list' },
    { doing: 'Checking what’s done and what’s open', done: `${s.done.length} done · ${left} open` },
  ];
  if (!s.lite) steps.push({ doing: 'Looking ahead to tomorrow', done: s.next.length ? `${s.next.length} planned for tomorrow` : 'Tomorrow is clear' });
  steps.push({ doing: 'Writing your summary', done: 'Summary written' });
  if (!s.lite) steps.push({ doing: 'Finalizing your day', done: 'All set' });
  return steps;
}
function buildSummary() {
  clearTimeout(summaryBuildTimer);
  summaryOpen = true;
  summaryReveal = false;
  const quick = matchMedia('(prefers-reduced-motion: reduce)').matches;
  summaryBuild = { step: 0, steps: summarySteps() };
  const tick = () => {
    if (!summaryBuild) return;
    summaryBuild.step++;
    if (summaryBuild.step >= summaryBuild.steps.length) {
      summaryBuild = null;
      summaryReveal = true;
      renderDaySummary();
      summaryBuildTimer = setTimeout(() => { summaryReveal = false; }, 900);
      return;
    }
    renderDaySummary();
    summaryBuildTimer = setTimeout(tick, quick ? 250 : 600 + Math.random() * 350);
  };
  renderDaySummary();
  summaryBuildTimer = setTimeout(tick, quick ? 250 : 750);
}
function renderDaySummary() {
  const box = $('#day-summary');
  const today = todayKey();
  const show = can('summary') && (summaryDue() || summaryAnytime) && localStorage.getItem(SUMMARY_HIDE_KEY) !== today;
  box.hidden = !show;
  $('#view-home').classList.toggle('summary-on', show);
  if (!show) { $('#view-home').classList.remove('summary-expanded'); return false; }
  const s = todaySummary();
  box.classList.toggle('open', summaryOpen);
  $('#view-home').classList.toggle('summary-expanded', summaryOpen);
  const fresh = localStorage.getItem(SUMMARY_SEEN_KEY) !== today;
  box.classList.toggle('fresh', fresh);
  const li = (t) => `<li>${esc(t.text)}${t.time ? ` <span class="muted">· ${esc(fmtTime(t.time))}</span>` : ''}</li>`;
  const more = (list, n) => (list.length > n ? `<li class="muted">and ${list.length - n} more</li>` : '');
  const left = s.open.length + s.older.length;
  const n = s.next[0];
  const gist = summaryBuild ? 'Summarizing your day…' : s.total ? `${s.done.length} of ${s.total} done` : 'A quiet day';
  box.classList.toggle('building', Boolean(summaryBuild));
  if (summaryBuild) {
    const b = summaryBuild;
    const tick = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>';
    box.innerHTML = `
    <button class="ds-pill" type="button" aria-expanded="true" disabled>
      <span class="ds-spark" aria-hidden="true"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l1.9 5.1L19 11l-5.1 1.9L12 18l-1.9-5.1L5 11l5.1-1.9z"/></svg></span>
      <span class="ds-pill-text"><b>Your day, summarized</b><span>${esc(gist)}</span></span>
    </button>
    <div class="ds-body">
      <ol class="ds-build" aria-live="polite">
        ${b.steps.map((st, i) => `<li class="${i < b.step ? 'done' : i === b.step ? 'now' : 'next'}">
          <span class="ds-step-ic">${i < b.step ? tick : i === b.step ? '<span class="ds-spin"></span>' : ''}</span>
          <span>${esc(i < b.step ? st.done : st.doing)}${i === b.step ? '<span class="ds-dots"><i></i><i></i><i></i></span>' : ''}</span>
        </li>`).join('')}
      </ol>
      <div class="ds-bar"><span style="width:${Math.round((b.step / b.steps.length) * 100)}%"></span></div>
    </div>`;
    return true;
  }
  box.innerHTML = `
    <button class="ds-pill" type="button" data-ds="toggle" aria-expanded="${summaryOpen}">
      <span class="ds-spark" aria-hidden="true"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l1.9 5.1L19 11l-5.1 1.9L12 18l-1.9-5.1L5 11l5.1-1.9z"/></svg></span>
      <span class="ds-pill-text"><b>Your day, summarized</b><span>${esc(gist)}</span></span>
      ${fresh && !summaryOpen ? '<span class="ds-new" aria-label="New"></span>' : ''}
      <svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <div class="ds-body${summaryReveal ? ' reveal' : ''}"${summaryOpen ? '' : ' hidden'}>
    <h3 class="ds-title">${esc(s.title.join(' '))}</h3>
    ${s.line ? `<p class="ds-line">${esc(s.line)}</p>` : ''}
    <div class="ds-stats${s.lite ? ' two' : ''}">
      <div class="ds-stat good"><b>${s.done.length}</b><span>Done</span></div>
      <div class="ds-stat"><b>${left}</b><span>Still open</span></div>
      ${s.lite ? '' : `<div class="ds-stat"><b>${s.next.length}</b><span>Tomorrow</span></div>`}
    </div>
    ${s.done.length ? `<p class="ds-label">Done today</p><ul class="ds-list done">${s.done.slice(0, 3).map(li).join('')}${more(s.done, 3)}</ul>` : ''}
    ${s.open.length ? `<p class="ds-label">Still open</p><ul class="ds-list">${s.open.slice(0, 3).map(li).join('')}${more(s.open, 3)}</ul>` : ''}
    ${n && !s.lite ? `<p class="ds-label">First up tomorrow</p><p class="ds-next">${esc(n.text)}${n.time ? ` <span class="muted">· ${esc(fmtTime(n.time))}</span>` : ''}</p>` : ''}
    <div class="ds-actions">
      ${s.open.length && !s.lite ? `<button class="ds-btn primary" type="button" data-ds="move"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h12M12 6l6 6-6 6"/><path d="M20 5v14"/></svg>Move ${s.open.length} to tomorrow</button>` : ''}
      <button class="ds-btn" type="button" data-ds="hide"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-2.7 3.3M6.6 6.6C4.3 8.1 3 12 3 12s4 6 9 6c1.5 0 2.9-.5 4.1-1.2"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>Hide for today</button>
    </div>
    </div>`;
  return true;
}
$('#day-summary').addEventListener('click', (e) => {
  const act = e.target.closest('[data-ds]')?.dataset.ds;
  if (act === 'toggle') {
    // The first open of the day builds the summary; after that it opens straight away.
    const first = !summaryOpen && localStorage.getItem(SUMMARY_SEEN_KEY) !== todayKey();
    localStorage.setItem(SUMMARY_SEEN_KEY, todayKey());
    if (first) { buildSummary(); return; }
    summaryOpen = !summaryOpen;
    renderDaySummary();
  } else if (act === 'hide') {
    summaryAnytime = false;
    summaryBuild = null;
    clearTimeout(summaryBuildTimer);
    localStorage.setItem(SUMMARY_HIDE_KEY, todayKey());
    renderHome();
  } else if (act === 'move') {
    const today = todayKey();
    const tomorrow = addDays(today, 1);
    let n = 0;
    for (const t of tasks) {
      if (t.date === today && !t.done) { t.date = tomorrow; t.notified = false; t.updatedAt = Date.now(); n++; }
    }
    save();
    render();
    toast(`Moved ${n} task${n === 1 ? '' : 's'} to tomorrow`);
  }
});

function notifySummary() {
  const s = todaySummary();
  toast('Your day is summarized on Home');
  if (document.visibilityState === 'visible') { playChime(); }
  if (ui.view === 'home') renderHome();
  if (pushCovers()) return; // the server sends it
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = {
    body: s.notifBody,
    icon: 'icons/app-icon-192.png',
    badge: 'icons/app-icon-192.png',
    tag: `blip-summary-${todayKey()}`,
    data: { taskId: `summary-${todayKey()}` },
  };
  navigator.serviceWorker?.ready.then((reg) => reg.showNotification(s.notifTitle, opts)).catch(() => {});
}

// Settings: Off, a few evening times, or any time.
const SUMMARY_CHOICES = ['off', '18:00', '19:00', '20:00', '21:00'];
function renderSummaryOptions() {
  const cur = summaryTime();
  const locked = !can('summary');
  $('#summary-opts').closest('.setting-row').classList.toggle('locked', locked);
  if (locked) {
    $('#summary-opts').innerHTML = '<button type="button" class="remind-chip" data-model-up="blip-2.3">Switch to Blip 2.3</button>';
    $('#summary-time').value = '';
    $('#summary-hint').textContent = `Day summaries come with Blip 2.0 and 2.3. You’re on ${modelName()}, which keeps to the basics: to-dos and reminders.`;
    return;
  }
  $('#summary-opts').innerHTML = SUMMARY_CHOICES.map((v) => {
    const on = v === cur;
    return `<button type="button" class="remind-chip${on ? ' on' : ''}" data-summary="${v}" aria-pressed="${on}">${v === 'off' ? 'Off' : fmtTime(v)}</button>`;
  }).join('');
  $('#summary-time').value = cur === 'off' ? '' : cur;
  $('#summary-hint').textContent = cur === 'off'
    ? 'Off. Turn it on to see how your day went each evening.'
    : `Every day at ${fmtTime(cur)}, Blip sums up your day on Home and sends you a notification.${can('plan') ? '' : ' Blip 2.3 adds a personal note and a look at tomorrow.'}`;
}
function saveSummaryTime(v) {
  settings.summaryTime = v;
  saveSettings();
  renderSummaryOptions();
  scheduleNextReminder();
  if (ui.view === 'home') renderHome();
  if (sb && profile && profile.mode !== 'guest') sb.auth.updateUser({ data: { blip_summary: v } }).catch(() => {});
  toast(v === 'off' ? 'Day summary off' : `Day summary at ${fmtTime(v)}`);
}
$('#summary-opts').addEventListener('click', (e) => {
  const up = e.target.closest('[data-model-up]')?.dataset.modelUp;
  if (up) { setModel(up); return; }
  const v = e.target.closest('[data-summary]')?.dataset.summary;
  if (v) saveSummaryTime(v);
});
$('#summary-time').addEventListener('change', (e) => {
  if (/^\d\d:\d\d$/.test(e.target.value)) saveSummaryTime(e.target.value);
});

// ---------- morning plan ----------
// The partner to the day summary. From the plan time (8 AM unless changed)
// until noon, Home shows what today holds, and a notification says so.
// Blip 2.3 gets the full plan; Blip 2.0 a short one; Blip 1.x none.
const MORNING_HIDE_KEY = 'blip.morning.hidden';
const MORNING_SEEN_KEY = 'blip.morning.seen';
// Pushes use a summary- id so the server sends them without Done and Snooze.
const MORNING_PREFIX = 'summary-morning-';
const morningTime = () => (can('morning') ? settings.morningTime || S.MORNING_TIME : 'off');
function morningPlanFor(day = todayKey()) {
  return S.morningPlan(tasks, day, displayName().split(/\s+/)[0], {
    lite: MODEL_FEATURES[modelId()].morning === 'lite', slotTime: SLOT_TIME, fmt: fmtTime,
  });
}
let morningOpen = false;
let morningAnytime = false; // opened from a notification or the + menu outside its hours
let morningBuild = null;
let morningReveal = false;
let morningBuildTimer = 0;
function morningShown(now = new Date()) {
  if (!can('morning') || localStorage.getItem(MORNING_HIDE_KEY) === todayKey()) return false;
  if (!$('#day-summary').hidden) return false; // the evening summary wins
  if (morningAnytime) return true;
  const w = S.morningWindow(morningTime(), now);
  return Boolean(w && now >= w.at && now < w.until);
}
function morningSteps() {
  const m = morningPlanFor();
  const steps = [
    { doing: 'Reading today’s list', done: m.total ? `${m.total} task${m.total === 1 ? '' : 's'} today` : 'Nothing planned yet' },
    { doing: 'Checking for leftovers', done: m.carried.length ? `${m.carried.length} carried over` : 'Nothing left over' },
  ];
  if (!m.lite) steps.push({ doing: 'Putting your day in order', done: m.first ? `First up at ${fmtTime(m.first.time)}` : 'No fixed times today' });
  steps.push({ doing: 'Writing your plan', done: 'Plan ready' });
  return steps;
}
function buildMorning() {
  clearTimeout(morningBuildTimer);
  morningOpen = true;
  morningReveal = false;
  const quick = matchMedia('(prefers-reduced-motion: reduce)').matches;
  morningBuild = { step: 0, steps: morningSteps() };
  const tick = () => {
    if (!morningBuild) return;
    morningBuild.step++;
    if (morningBuild.step >= morningBuild.steps.length) {
      morningBuild = null;
      morningReveal = true;
      renderMorningPlan();
      morningBuildTimer = setTimeout(() => { morningReveal = false; }, 900);
      return;
    }
    renderMorningPlan();
    morningBuildTimer = setTimeout(tick, quick ? 250 : 600 + Math.random() * 350);
  };
  renderMorningPlan();
  morningBuildTimer = setTimeout(tick, quick ? 250 : 750);
}
const SUN_ICON = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></svg>';
function renderMorningPlan() {
  const box = $('#morning-plan');
  if (!box) return false;
  const show = morningShown();
  box.hidden = !show;
  if (!show) return false;
  const home = $('#view-home');
  home.classList.add('summary-on');
  home.classList.toggle('summary-expanded', morningOpen);
  const m = morningPlanFor();
  const today = todayKey();
  box.classList.toggle('open', morningOpen);
  const fresh = localStorage.getItem(MORNING_SEEN_KEY) !== today;
  box.classList.toggle('fresh', fresh);
  box.classList.toggle('building', Boolean(morningBuild));
  const when = (t) => (t.time ? fmtTime(t.time) : t.slot ? SLOTS[t.slot] : '');
  const li = (t) => `<li class="${t.priority === 'high' ? 'urgent' : ''}"><span class="mp-when">${esc(when(t) || 'Any time')}</span><span class="mp-text">${esc(t.text)}</span></li>`;
  const ago = (t) => { const d = Math.round((parseKey(today) - parseKey(t.date)) / 864e5); return d === 1 ? 'yesterday' : `${d} days ago`; };
  const more = (list, n) => (list.length > n ? `<li class="muted mp-more">and ${list.length - n} more</li>` : '');
  const gist = morningBuild ? 'Planning your morning…' : m.gist;
  const head = (expanded, btn) => `
    <button class="ds-pill" type="button" ${btn} aria-expanded="${expanded}">
      <span class="ds-spark mp-sun" aria-hidden="true">${SUN_ICON}</span>
      <span class="ds-pill-text"><b>Your morning plan</b><span>${esc(gist)}</span></span>
      ${btn.includes('data-mp') ? `${fresh && !morningOpen ? '<span class="ds-new" aria-label="New"></span>' : ''}<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>` : ''}
    </button>`;
  if (morningBuild) {
    const b = morningBuild;
    const tick = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>';
    box.innerHTML = `${head(true, 'disabled')}
    <div class="ds-body">
      <ol class="ds-build" aria-live="polite">
        ${b.steps.map((st, i) => `<li class="${i < b.step ? 'done' : i === b.step ? 'now' : 'next'}">
          <span class="ds-step-ic">${i < b.step ? tick : i === b.step ? '<span class="ds-spin"></span>' : ''}</span>
          <span>${esc(i < b.step ? st.done : st.doing)}${i === b.step ? '<span class="ds-dots"><i></i><i></i><i></i></span>' : ''}</span>
        </li>`).join('')}
      </ol>
      <div class="ds-bar"><span style="width:${Math.round((b.step / b.steps.length) * 100)}%"></span></div>
    </div>`;
    return true;
  }
  const n = m.first;
  const rest = m.todays.filter((t) => t !== n && t.id !== n?.id);
  box.innerHTML = `${head(morningOpen, 'data-mp="toggle"')}
    <div class="ds-body${morningReveal ? ' reveal' : ''}"${morningOpen ? '' : ' hidden'}>
    <h3 class="ds-title">${esc(m.title.join(' '))}</h3>
    ${m.line ? `<p class="ds-line">${esc(m.line)}</p>` : ''}
    <div class="ds-stats${m.lite ? ' two' : ''}">
      <div class="ds-stat good"><b>${m.total}</b><span>Today</span></div>
      <div class="ds-stat"><b>${m.carried.length}</b><span>Carried</span></div>
      ${m.lite ? '' : `<div class="ds-stat${m.urgent.length ? ' hot' : ''}"><b>${m.urgent.length}</b><span>Urgent</span></div>`}
    </div>
    ${n ? `<div class="mp-first"><span class="ds-label">First up</span><p><b>${esc(fmtTime(n.time))}</b> ${esc(n.text)}</p></div>` : ''}
    ${!m.lite && rest.length ? `<p class="ds-label">${n ? 'Later today' : 'Today’s plan'}</p><ul class="ds-list mp-list">${rest.slice(0, 5).map(li).join('')}${more(rest, 5)}</ul>` : ''}
    ${!m.lite && m.carried.length ? `<p class="ds-label">Carried over</p><ul class="ds-list">${m.carried.slice(0, 3).map((t) => `<li>${esc(t.text)} <span class="muted">· ${esc(ago(t))}</span></li>`).join('')}${more(m.carried, 3)}</ul>` : ''}
    ${!m.total && !m.carried.length ? '<p class="ds-line">Tap the mic and say what today needs.</p>' : ''}
    <div class="ds-actions">
      ${m.carried.length && !m.lite ? `<button class="ds-btn primary" type="button" data-mp="bring"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12H8M12 6l-6 6 6 6"/><path d="M4 5v14"/></svg>Bring ${m.carried.length} to today</button>` : ''}
      <button class="ds-btn" type="button" data-mp="hide"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-2.7 3.3M6.6 6.6C4.3 8.1 3 12 3 12s4 6 9 6c1.5 0 2.9-.5 4.1-1.2"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>Hide for today</button>
    </div>
    </div>`;
  return true;
}
function openMorning() {
  if (!can('morning')) return;
  morningAnytime = true;
  if (localStorage.getItem(MORNING_HIDE_KEY) === todayKey()) localStorage.removeItem(MORNING_HIDE_KEY);
  const first = localStorage.getItem(MORNING_SEEN_KEY) !== todayKey();
  localStorage.setItem(MORNING_SEEN_KEY, todayKey());
  showView('home');
  renderHome();
  if (first) buildMorning(); else { morningOpen = true; renderMorningPlan(); }
}
$('#morning-plan').addEventListener('click', (e) => {
  const act = e.target.closest('[data-mp]')?.dataset.mp;
  if (act === 'toggle') {
    const first = !morningOpen && localStorage.getItem(MORNING_SEEN_KEY) !== todayKey();
    localStorage.setItem(MORNING_SEEN_KEY, todayKey());
    if (first) { buildMorning(); return; }
    morningOpen = !morningOpen;
    renderMorningPlan();
  } else if (act === 'hide') {
    morningAnytime = false;
    morningOpen = false;
    morningBuild = null;
    clearTimeout(morningBuildTimer);
    localStorage.setItem(MORNING_HIDE_KEY, todayKey());
    renderHome();
  } else if (act === 'bring') {
    const today = todayKey();
    let n = 0;
    for (const t of tasks) {
      if (t.date < today && !t.done) { t.date = today; t.notified = false; t.updatedAt = Date.now(); n++; }
    }
    save();
    render();
    toast(`Brought ${n} task${n === 1 ? '' : 's'} to today`);
  }
});

function notifyMorning() {
  const m = morningPlanFor();
  toast('Your morning plan is on Home');
  if (document.visibilityState === 'visible') playChime();
  if (ui.view === 'home') renderHome();
  if (pushCovers()) return; // the server sends it
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const id = `${MORNING_PREFIX}${todayKey()}`;
  const opts = { body: m.notifBody, icon: 'icons/app-icon-192.png', badge: 'icons/app-icon-192.png', tag: `blip-${id}`, data: { taskId: id } };
  navigator.serviceWorker?.ready.then((reg) => reg.showNotification(m.notifTitle, opts)).catch(() => {});
}
// The next two mornings' notifications for the server to send, so tomorrow's
// plan arrives even if Blip isn't opened before then.
function morningPushes(now = Date.now()) {
  const out = [];
  for (let i = 0; i < 2; i++) {
    const day = addDays(todayKey(), i);
    const at = S.summaryAt(morningTime(), parseKey(day));
    if (!at || at.getTime() <= now) continue;
    const m = morningPlanFor(day);
    out.push({ task_id: `${MORNING_PREFIX}${day}`, fire_at: at.toISOString(), offset_min: 0, title: m.notifTitle, body: m.notifBody });
  }
  return out;
}

const MORNING_CHOICES = ['off', '06:00', '07:00', '08:00', '09:00'];
function renderMorningOptions() {
  const cur = morningTime();
  const opts = $('#morning-opts');
  opts.closest('.setting-row').classList.toggle('locked', !can('morning'));
  if (!can('morning')) {
    opts.innerHTML = '<button type="button" class="remind-chip" data-model-up="blip-2.3">Switch to Blip 2.3</button>';
    $('#morning-time').value = '';
    $('#morning-hint').textContent = `The morning plan comes with Blip 2.0 and 2.3. You’re on ${modelName()}, which keeps to the basics: to-dos and reminders.`;
    return;
  }
  opts.innerHTML = MORNING_CHOICES.map((v) => {
    const on = v === cur;
    return `<button type="button" class="remind-chip${on ? ' on' : ''}" data-morning="${v}" aria-pressed="${on}">${v === 'off' ? 'Off' : fmtTime(v)}</button>`;
  }).join('');
  $('#morning-time').value = cur === 'off' ? '' : cur;
  $('#morning-hint').textContent = cur === 'off'
    ? 'Off. Turn it on to start each day knowing what’s ahead.'
    : `Every morning at ${fmtTime(cur)}, Blip tells you what today holds and what’s carried over.${can('plan') ? '' : ' Blip 2.3 adds your full list, urgent tasks and Bring to today.'}`;
}
function saveMorningTime(v) {
  settings.morningTime = v;
  saveSettings();
  renderMorningOptions();
  scheduleNextReminder();
  if (ui.view === 'home') renderHome();
  if (sb && profile && profile.mode !== 'guest') sb.auth.updateUser({ data: { blip_morning: v } }).catch(() => {});
  toast(v === 'off' ? 'Morning plan off' : `Morning plan at ${fmtTime(v)}`);
}
$('#morning-opts').addEventListener('click', (e) => {
  const up = e.target.closest('[data-model-up]')?.dataset.modelUp;
  if (up) { setModel(up); return; }
  const v = e.target.closest('[data-morning]')?.dataset.morning;
  if (v) saveMorningTime(v);
});
$('#morning-time').addEventListener('change', (e) => {
  if (/^\d\d:\d\d$/.test(e.target.value)) saveMorningTime(e.target.value);
});

// ---------- home headline ----------
// Counts app opens so the headline can tell a first visit, a return after a
// break, and a busy day apart. Kept on this device only.
const VISITS_KEY = 'blip.visits.v1';
const visits = { firstEver: false, daysAway: 0, opensToday: 1 };
function countOpen() {
  const now = Date.now();
  const today = todayKey();
  const prev = loadJSON(VISITS_KEY, null);
  if (!prev) {
    // People updating from an older Blip already have tasks or notes; they aren't new.
    visits.firstEver = !loadJSON(TASKS_KEY, []).length && !loadJSON(NOTES_KEY, []).length;
    visits.daysAway = 0;
    visits.opensToday = 1;
  } else {
    visits.daysAway = Math.floor((now - (prev.lastSeen || now)) / 864e5);
    visits.opensToday = prev.lastDay === today ? (prev.opens || 0) + 1 : 1;
  }
  localStorage.setItem(VISITS_KEY, JSON.stringify({ first: prev?.first || now, lastDay: today, lastSeen: now, opens: visits.opensToday }));
}
countOpen();
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  // Coming back after 10 minutes away counts as opening the app again.
  if (hiddenAt && Date.now() - hiddenAt > 10 * 60e3) {
    visits.firstEver = false;
    countOpen();
    if (ui.view === 'home') renderHome();
  }
});

function renderHeadline(todays, doneCount) {
  const nowHM = `${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`;
  const open = todays.filter((t) => !t.done);
  const timed = open.filter((t) => t.time).sort((a, b) => a.time.localeCompare(b.time));
  const nextT = timed.find((t) => t.time >= nowHM) || (timed.length ? null : open[0]) || null;
  const short = (s) => (s.length > 42 ? `${s.slice(0, 40).trim()}…` : s);
  const h = homeHeadline({
    now: new Date(),
    role: settings.role || '',
    name: displayName(),
    total: todays.length,
    done: doneCount,
    carry: tasks.filter((t) => t.date < todayKey() && !t.done).length,
    next: nextT ? { text: short(nextT.text), time: fmtTime(nextT.time) } : null,
    visits,
  });
  $('#hero-title').innerHTML = `${esc(h.title[0])}<br>${esc(h.title[1])}`;
  $('#hero-copy').textContent = h.copy;
  $('#hero-title').dataset.key = h.key;
}

function renderTasks() {
  $('#tasks-date').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const q = ui.query;
  const matches = (t) => !q || t.text.toLowerCase().includes(q) || (t.notes || '').toLowerCase().includes(q);
  const today = todayKey();
  const f = ui.filter;
  let html = '';

  const section = (label, list, { empty = '', carry = false } = {}) => {
    const body = list.length
      ? `<ul class="task-list">${list.map((t) => taskHTML(t, { carry })).join('')}</ul>`
      : `<p class="empty">${esc(empty)}</p>`;
    return `<p class="section-label">${label}</p>${body}`;
  };

  if (f === 'done') {
    const list = tasks.filter((t) => t.done && matches(t)).sort((a, b) => b.created - a.created);
    html += section('Finished', list, { empty: q ? `No finished tasks match “${q}”.` : 'Nothing finished yet.' });
  } else {
    const todayList = tasks.filter((t) => t.date === today && matches(t) && (f === 'all' || !t.done)).sort(sortTasks);
    const carry = tasks.filter((t) => t.date < today && !t.done && matches(t)).sort(sortTasks);
    const upcoming = tasks.filter((t) => t.date > today && !t.done && matches(t))
      .sort((a, b) => a.date.localeCompare(b.date) || timeKey(a).localeCompare(timeKey(b)));

    html += section('Today', todayList, {
      empty: q ? `No tasks match “${q}”.` : 'Nothing for today yet. Tap the mic to add it.',
    });
    if (carry.length) html += section('Unfinished from before', carry, { carry: true });
    if (upcoming.length) html += section('Upcoming', upcoming);
  }

  $('#tasks-list').innerHTML = html;
}

function renderTaskDetail() {
  const t = tasks.find((x) => x.id === editingId);
  if (!t) {
    showView(ui.backTo || 'tasks');
    return;
  }
  $('#tf-title').value = t.text;
  $('#tf-done').setAttribute('aria-pressed', String(t.done));
  $('#tf-done-label').textContent = t.done ? 'Completed · tap to reopen' : 'Mark complete';
  $('#tf-date').value = t.date;
  $('#tf-time').value = t.time || '';
  $('#tf-end').value = t.endTime || '';
  $('#tf-reminder').checked = Boolean(t.reminder && t.time);
  $('#tf-repeat').value = t.repeat || 'none';
  $('#tf-notes').value = t.notes || '';
  autoGrow($('#tf-notes'));
  requestAnimationFrame(() => autoGrow($('#tf-title')));
  setPriority(t.priority);
}

function setPriority(p) {
  tfPriority = normPriority(p);
  for (const b of $$('[data-prio]')) b.classList.toggle('on', b.dataset.prio === tfPriority);
}

function renderNotes() {
  const q = ui.noteQuery;
  const list = notes
    .filter((n) => !q || `${n.title} ${n.body}`.toLowerCase().includes(q))
    .sort((a, b) => b.updated - a.updated);
  $('#notes-list').innerHTML = list.length
    ? list.map((n) => `
        <button class="note-card" type="button" data-act="open-note" data-note-id="${n.id}">
          <h3>${esc(n.title || 'Untitled')}</h3>
          <p>${esc(n.body || 'No text yet')}</p>
          <time>${esc(dateLabel(todayKey(new Date(n.updated))))}</time>
        </button>`).join('')
    : `<p class="empty" style="grid-column:1/-1">${q ? `No notes match “${esc(q)}”.` : 'No notes yet. Tap + to write one.'}</p>`;
}

function renderNoteEditor() {
  const n = notes.find((x) => x.id === editingNote);
  if (!n) {
    showView('notes');
    return;
  }
  $('#nf-title').value = n.title;
  requestAnimationFrame(() => autoGrow($('#nf-title')));
  $('#nf-body').value = n.body;
}

function renderCalendar() {
  const y = calMonth.getFullYear();
  const m = calMonth.getMonth();
  $('#cal-title').textContent = calMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const counts = {};
  for (const t of tasks) counts[t.date] = (counts[t.date] || 0) + 1;
  const today = todayKey();
  const dows = Array.from({ length: 7 }, (_, i) =>
    new Date(2026, 0, 4 + i).toLocaleDateString(undefined, { weekday: 'narrow' }));

  let cells = dows.map((d) => `<span class="cal-dow" aria-hidden="true">${d}</span>`).join('');
  for (let i = 0; i < calMonth.getDay(); i++) cells += '<span class="cal-cell" aria-hidden="true"></span>';
  const days = new Date(y, m + 1, 0).getDate();
  for (let d = 1; d <= days; d++) {
    const key = keyFrom(new Date(y, m, d));
    const cls = ['cal-day', key === calSelected ? 'sel' : '', key === today ? 'today' : ''].join(' ').trim();
    cells += `<button class="${cls}" type="button" data-act="cal-day" data-key="${key}"
      aria-label="${parseKey(key).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}${counts[key] ? `, ${counts[key]} tasks` : ''}"
      aria-pressed="${key === calSelected}"><span>${d}</span>${counts[key] ? '<i class="dot" aria-hidden="true"></i>' : ''}</button>`;
  }
  $('#cal-grid').innerHTML = cells;

  $('#cal-day-head').textContent = parseKey(calSelected).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const list = tasks.filter((t) => t.date === calSelected).sort(sortTasks);
  $('#cal-list').innerHTML = list.length
    ? list.map((t) => taskHTML(t)).join('')
    : '<li class="empty-row">Nothing scheduled for this day.</li>';
}

function renderSettings() {
  renderProfile();
  renderSyncLine();
  $('#api-key').value = settings.apiKey || '';
  $('#mode-hint').textContent = settings.apiKey
    ? 'AI parsing is on. Claude Haiku reads what you say or type.'
    : 'Offline parsing is on. Add a key for smarter parsing.';
  markTheme();
  renderNotifButton();
}

function renderNotifButton() {
  renderRemindOptions();
  const btn = $('#notif-btn');
  const hint = $('#notif-hint');
  $('#notif-test-row').hidden = true;
  if (!('Notification' in window)) {
    btn.disabled = true;
    btn.textContent = 'Unavailable';
    hint.textContent = 'This browser can’t show notifications.';
  } else if (Notification.permission === 'granted') {
    btn.disabled = true;
    btn.textContent = 'On';
    hint.textContent = pushCovers()
      ? 'On. Reminders arrive even when Blip is closed.'
      : profile && profile.mode !== 'guest' && CFG.vapidPublicKey
        ? 'On. Reminders arrive while Blip is open or in the background.'
        : 'On. Sign in so reminders arrive even when Blip is closed.';
    $('#notif-test-row').hidden = false;
  } else if (Notification.permission === 'denied') {
    btn.disabled = true;
    btn.textContent = 'Blocked';
    hint.textContent = 'Allow notifications in your browser settings.';
  } else {
    btn.disabled = false;
    btn.textContent = 'Allow';
    hint.textContent = 'Allow this to get a notification for each timed task.';
  }
}

function render() {
  renderHome();
  renderView(ui.view);
}

function renderView(name) {
  switch (name) {
    case 'home': renderHome(); break;
    case 'tasks': renderTasks(); break;
    case 'task': renderTaskDetail(); break;
    case 'notes': renderNotes(); break;
    case 'note': renderNoteEditor(); break;
    case 'calendar': renderCalendar(); break;
    case 'settings': renderSettings(); break;
    default: break;
  }
}

// ---------- reminders ----------
// Every timed task with its reminder on rings at its time, plus up to three
// earlier reminders picked in Settings (10 minutes before until changed).
// While Blip is open, timers here ring them. When push is set up and the
// person is signed in, the server sends them too, so they arrive with Blip closed.
const R = window.BlipReminders;
// Reminders more than this late (the app was closed) are skipped as stale.
const REMIND_GRACE_MS = 30 * 60 * 1000;
const SENT_KEY = 'blip.remindSent.v1';
let reminderTimer = null;
let remindSent = loadJSON(SENT_KEY, {});

const remindOffsets = () => R.extraOffsets(settings.remindOffsets);
const sentKey = (t, f) => `${t.id}|${dueAt(t)}|${f.min}`;
const firesOf = (t) => (t.notified ? [] : R.fireTimes(t, settings.remindOffsets, dueAt(t)));

function whenLabel(t) {
  const day = t.date === todayKey() ? 'Today' : dateLabel(t.date);
  return `${day} at ${fmtTime(t.time)}`;
}

// Push from the server already covers this device, so only show a toast here.
const pushCovers = () => Boolean(push?.endpoint && profile && profile.mode !== 'guest');

function notify(t, min = 0, snoozed = false) {
  const { title, body } = snoozed ? snoozeText(t) : R.reminderText(t, min, whenLabel(t));
  toast(`${title} · ${snoozed ? 'snoozed' : min === 0 ? fmtTime(t.time) : R.leadText(min)}`);
  if (document.visibilityState === 'visible') { playChime(); buzz(); }
  if (pushCovers() && t.id !== 'test') return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = {
    body,
    icon: 'icons/app-icon-192.png',
    badge: 'icons/app-icon-192.png',
    tag: `blip-${t.id}-${snoozed ? 'snooze' : min}`,
    renotify: true,
    requireInteraction: min === 0,
    vibrate: BUZZ,
    timestamp: snoozed ? Date.now() : dueAt(t) ?? Date.now(),
    actions: REMIND_ACTIONS,
    data: { taskId: t.id },
  };
  const fallback = () => { try { new Notification(title, opts); } catch { /* page-level notifications unsupported */ } };
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready
      .then((reg) => reg.showNotification(title, opts))
      .catch(fallback);
  } else {
    fallback();
  }
}

function checkReminders() {
  const now = Date.now();
  let changed = false;
  let sentChanged = false;
  for (const t of tasks) {
    for (const f of firesOf(t)) {
      if (now < f.at || remindSent[sentKey(t, f)]) continue;
      remindSent[sentKey(t, f)] = now;
      sentChanged = true;
      // An early heads-up ("in 30 min") is pointless once late; only the
      // at-the-time reminder still rings when Blip comes back within 30 minutes.
      const grace = f.min === 0 ? REMIND_GRACE_MS : 2 * 60e3;
      if (now - f.at < grace) notify(t, f.min);
      if (f.min === 0) { t.notified = true; changed = true; }
    }
  }
  for (const [id, at] of Object.entries(snoozes || {})) {
    const t = tasks.find((x) => x.id === id);
    if (t && !t.done && now < at) continue;
    delete snoozes[id];
    saveSnoozes();
    if (t && !t.done && now - at < REMIND_GRACE_MS) notify(t, 0, true);
  }
  const sumAt = S.summaryAt(summaryTime());
  const sumKey = `summary|${todayKey()}`;
  if (sumAt && now >= sumAt.getTime() && !remindSent[sumKey]) {
    remindSent[sumKey] = now;
    sentChanged = true;
    if (now - sumAt.getTime() < REMIND_GRACE_MS) notifySummary();
    else if (ui.view === 'home') renderHome();
  }
  const mornAt = S.summaryAt(morningTime());
  const mornKey = `morning|${todayKey()}`;
  if (mornAt && now >= mornAt.getTime() && !remindSent[mornKey]) {
    remindSent[mornKey] = now;
    sentChanged = true;
    if (now - mornAt.getTime() < REMIND_GRACE_MS) notifyMorning();
    else if (ui.view === 'home') renderHome();
  }
  if (sentChanged) {
    // Forget marks older than two days so the list stays small.
    for (const [k, v] of Object.entries(remindSent)) if (now - v > 2 * 864e5) delete remindSent[k];
    localStorage.setItem(SENT_KEY, JSON.stringify(remindSent));
  }
  if (changed) save();
  scheduleNextReminder();
}

// Arms one timer for the soonest pending reminder, so it fires on the minute
// instead of waiting for the 30-second sweep.
function scheduleNextReminder() {
  clearTimeout(reminderTimer);
  let next = Infinity;
  for (const t of tasks) {
    for (const f of firesOf(t)) {
      if (!remindSent[sentKey(t, f)] && f.at < next) next = f.at;
    }
  }
  for (const at of Object.values(snoozes || {})) if (at < next) next = at;
  const sumAt = S.summaryAt(summaryTime());
  if (sumAt && !remindSent[`summary|${todayKey()}`] && sumAt.getTime() < next) next = sumAt.getTime();
  const mornAt = S.summaryAt(morningTime());
  if (mornAt && !remindSent[`morning|${todayKey()}`] && mornAt.getTime() < next) next = mornAt.getTime();
  queuePushSchedule();
  if (next === Infinity) return;
  // Browsers cap timers near 24.8 days; re-arm at most daily.
  const delay = Math.min(Math.max(next - Date.now(), 0), 24 * 3600e3);
  reminderTimer = setTimeout(checkReminders, delay);
}

// ---------- Done and Snooze on a reminder ----------
// Notifications carry two buttons. With Blip open, the service worker hands the
// tap to this page; with Blip closed, the reminder-action function does it.
const SNOOZE_MIN = 10;
const SNOOZE_KEY = 'blip.snoozes.v1';
const REMIND_ACTIONS = [{ action: 'done', title: 'Done' }, { action: 'snooze', title: `Snooze ${SNOOZE_MIN} min` }];
var snoozes = loadJSON(SNOOZE_KEY, {}); // { taskId: ms when it rings again }
const saveSnoozes = () => localStorage.setItem(SNOOZE_KEY, JSON.stringify(snoozes));
const clockOf = (ms) => { const d = new Date(ms); return fmtTime(`${pad(d.getHours())}:${pad(d.getMinutes())}`); };

function snoozeText(t) {
  return { title: t.text || 'Reminder', body: `Snoozed · was due ${whenLabel(t)}` };
}

function reminderAction(action, id) {
  if (id === 'test') {
    toast(action === 'done' ? 'Done works. That was only a test.' : `Snooze works. It would ring again at ${clockOf(Date.now() + SNOOZE_MIN * 60e3)}.`);
    return true;
  }
  const t = tasks.find((x) => x.id === id);
  if (!t) return false;
  if (action === 'done') {
    delete snoozes[id];
    saveSnoozes();
    if (!t.done) completeTask(t);
    save();
    render();
    toast(`Done: ${t.text}`);
  } else if (!t.done) {
    snoozes[id] = Math.ceil((Date.now() + SNOOZE_MIN * 60e3) / 1000) * 1000;
    saveSnoozes();
    scheduleNextReminder();
    queuePushSchedule(0);
    toast(`Snoozed until ${clockOf(snoozes[id])}`);
  }
  return true;
}

// Opened from a button while Blip was closed and the server couldn't be
// reached: do it once the task is here (sync may still be bringing it in).
function runPendingAction(action, id, tries = 0) {
  if (reminderAction(action, id) || tries >= 6) return;
  setTimeout(() => runPendingAction(action, id, tries + 1), 5000);
}

// ---------- background push ----------
// The device subscribes once; its upcoming reminders are copied to Supabase,
// and a server job sends each one at its minute. Needs a signed-in account,
// notifications allowed, and config.js to carry the push key.
const PUSH_KEY = 'blip.push.v1';
var push = loadJSON(PUSH_KEY, { endpoint: '' }); // var: save() may run before this line
const PUSH_HORIZON_MS = 14 * 864e5;
let pushTimer = null;

const pushReady = () => Boolean(
  sb && CFG.vapidPublicKey && profile && profile.mode !== 'guest' &&
  'serviceWorker' in navigator && 'PushManager' in window &&
  'Notification' in window && Notification.permission === 'granted'
);

// Any signed-in device keeps the account's reminder schedule up to date, even one
// without notifications turned on (a laptop), so a task added there still
// reaches the phone's notifications with Blip closed.
const scheduleReady = () => Boolean(sb && CFG.vapidPublicKey && profile && profile.mode !== 'guest');

function b64ToBytes(b64) {
  const pad64 = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad64).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function enablePush() {
  if (!pushReady()) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(CFG.vapidPublicKey) });
    }
    const j = sub.toJSON();
    const { error } = await sb.from('push_subscriptions').upsert({
      endpoint: j.endpoint,
      p256dh: j.keys.p256dh,
      auth: j.keys.auth,
      user_agent: navigator.userAgent.slice(0, 200),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'endpoint' });
    if (error) throw error;
    push.endpoint = j.endpoint;
    localStorage.setItem(PUSH_KEY, JSON.stringify(push));
    queuePushSchedule(0);
    renderNotifButton();
    return true;
  } catch (err) {
    console.warn('[Blip push]', err);
    return false;
  }
}

async function disablePush() {
  const endpoint = push.endpoint;
  push.endpoint = '';
  localStorage.setItem(PUSH_KEY, JSON.stringify(push));
  try {
    const reg = await navigator.serviceWorker?.ready;
    const sub = await reg?.pushManager?.getSubscription();
    if (sub) await sub.unsubscribe();
    if (sb && endpoint) await sb.from('push_subscriptions').delete().eq('endpoint', endpoint);
  } catch { /* already gone */ }
}

// Waits for edits to settle, then copies upcoming reminders to the server.
function queuePushSchedule(ms = 2000) {
  try {
    if (!scheduleReady()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(syncPushSchedule, ms);
  } catch { /* called during startup, before sign-in is set up */ }
}

async function syncPushSchedule() {
  if (!scheduleReady() || !navigator.onLine) return;
  const now = Date.now();
  const want = new Map();
  for (const t of tasks) {
    for (const f of firesOf(t)) {
      if (f.at <= now || f.at > now + PUSH_HORIZON_MS) continue;
      const { title, body } = R.reminderText(t, f.min, whenLabel(t));
      const fireAt = new Date(f.at).toISOString();
      want.set(`${t.id}|${fireAt}`, { task_id: t.id, fire_at: fireAt, offset_min: f.min, title, body });
    }
  }
  for (const [id, at] of Object.entries(snoozes || {})) {
    const t = tasks.find((x) => x.id === id);
    if (!t || t.done || at <= now) continue;
    const fireAt = new Date(at).toISOString();
    want.set(`${id}|${fireAt}`, { task_id: id, fire_at: fireAt, offset_min: -SNOOZE_MIN, ...snoozeText(t) });
  }
  const sumAt = S.summaryAt(summaryTime());
  if (sumAt && sumAt.getTime() > now) {
    const s = todaySummary();
    const fireAt = sumAt.toISOString();
    want.set(`summary-${todayKey()}|${fireAt}`, { task_id: `summary-${todayKey()}`, fire_at: fireAt, offset_min: 0, title: s.notifTitle, body: s.notifBody });
  }
  for (const r of morningPushes(now)) want.set(`${r.task_id}|${r.fire_at}`, r);
  try {
    const { data: have, error } = await sb.from('reminders')
      .select('task_id, fire_at, offset_min').eq('sent', false).gt('fire_at', new Date(now).toISOString());
    if (error) throw error;
    // A snooze tapped with Blip closed was made by the server (offset_min < 0):
    // keep it unless its task is done or gone.
    const keepSnooze = (r) => r.offset_min < 0 && tasks.some((t) => t.id === r.task_id && !t.done);
    const stale = (have || []).filter((r) => !want.has(`${r.task_id}|${new Date(r.fire_at).toISOString()}`) && !keepSnooze(r));
    for (const r of stale) {
      await sb.from('reminders').delete().eq('task_id', r.task_id).eq('fire_at', r.fire_at).eq('sent', false);
    }
    if (want.size) {
      const { error: upErr } = await sb.from('reminders')
        .upsert([...want.values()], { onConflict: 'user_id,task_id,fire_at' });
      if (upErr) throw upErr;
    }
  } catch (err) {
    console.warn('[Blip push] schedule', err);
  }
}

// ---------- reminder sound and buzz ----------
// Blip's own chime plays when a reminder fires while Blip is open. The sound
// of a closed-app notification is the phone's; the buzz pattern goes with it.
const BUZZ = [120, 80, 120, 80, 360]; // short, short, long
const BUZZ_LONG = [400, 200, 400, 200, 700, 500, 400, 200, 400, 200, 700]; // about 4 s
// Builds a repeated phrase: [freq, at, len, gain] notes, played `times` times.
const repeatPhrase = (phrase, every, times, gains = []) => {
  const out = [];
  for (let i = 0; i < times; i++) for (const [f, at, len, g = 1] of phrase) out.push([f, at + i * every, len, g * (gains[i] ?? 1)]);
  return out;
};
const CHIMES = {
  blip:    { label: 'Blip',   notes: [[880, 0, 0.09], [1320, 0.11, 0.16]], wave: 'sine', gain: 0.22 },
  soft:    { label: 'Soft',   notes: [[523, 0, 0.22], [784, 0.2, 0.34]], wave: 'triangle', gain: 0.2 },
  bright:  { label: 'Bright', notes: [[1047, 0, 0.08], [1319, 0.09, 0.08], [1568, 0.18, 0.2]], wave: 'sine', gain: 0.18 },
  // Long tones: a few seconds each, for reminders you can't miss.
  marimba: { label: 'Marimba', long: true, wave: 'marimba', gain: 0.24,
    notes: repeatPhrase([[659, 0, 0.5], [784, 0.17, 0.5], [880, 0.34, 0.5], [784, 0.51, 0.5], [659, 0.68, 0.5], [523, 0.85, 0.9]], 1.6, 4, [0.7, 0.85, 1, 1]) },
  pulse:   { label: 'Pulse', long: true, wave: 'sine', gain: 0.52,
    notes: repeatPhrase([[1047, 0, 0.12], [1319, 0.15, 0.2]], 0.8, 8, [0.45, 0.55, 0.65, 0.75, 0.85, 1, 1, 1]) },
  // A rising three-note call that speeds up and gets louder.
  escalate: { label: 'Escalate', long: true, wave: 'triangle', gain: 0.52, notes: (() => {
    const out = []; let t = 0; let gap = 0.75;
    for (let i = 0; i < 9; i++) { const g = 0.5 + i * 0.07; out.push([659, t, 0.14, g], [880, t + 0.12, 0.14, g], [1319, t + 0.24, 0.22, g]); t += gap; gap = Math.max(0.5, gap - 0.04); }
    return out;
  })() },
  off:     { label: 'Off', notes: [] },
};
let audioCtx = null;
// Browsers only allow sound after a tap, so warm the audio up on the first one.
addEventListener('pointerdown', () => {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* no Web Audio */ }
}, { once: false, passive: true });

// Extra partials (ratio, level, decay speed) give the bell and marimba their colour.
const VOICES = {
  bell: [[1, 1, 1], [2.76, 0.35, 2.5], [5.4, 0.12, 5]],
  marimba: [[1, 1, 1], [3.9, 0.25, 6], [10, 0.06, 12]],
};
let chimeNodes = [];
function stopChime() {
  for (const o of chimeNodes) { try { o.stop(); } catch { /* already stopped */ } }
  chimeNodes = [];
}
function playChime(name = settings.chime || 'blip') {
  const c = CHIMES[name] || CHIMES.blip;
  if (!c || !c.notes.length) return;
  stopChime();
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = audioCtx.currentTime + 0.02;
    const partials = VOICES[c.wave] || [[1, 1, 1]];
    for (const [freq, at, len, mul = 1] of c.notes) {
      for (const [ratio, level, speed] of partials) {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = VOICES[c.wave] ? 'sine' : c.wave;
        o.frequency.value = freq * ratio;
        const end = t0 + at + len / speed;
        g.gain.setValueAtTime(0.0001, t0 + at);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0002, c.gain * mul * level), t0 + at + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, end);
        o.connect(g).connect(audioCtx.destination);
        o.start(t0 + at);
        o.stop(end + 0.05);
        chimeNodes.push(o);
      }
    }
    // A long tone stops with any tap, or when Blip goes to the background.
    if (c.long) {
      setTimeout(() => {
        const stop = () => { stopChime(); removeEventListener('pointerdown', stop, true); };
        addEventListener('pointerdown', stop, true);
        setTimeout(() => removeEventListener('pointerdown', stop, true), 10000);
      }, 300);
    }
  } catch { /* sound unavailable */ }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) stopChime(); });

// A quick, bright "pop-ding" when tasks are added from the review screen.
const ADDED_SOUND = { notes: [[587, 0, 0.07], [880, 0.065, 0.1], [1175, 0.14, 0.22]], wave: 'sine', gain: 0.16 };
function playAddedSound() {
  if (settings.addSound === false) return;
  CHIMES._added = ADDED_SOUND;
  playChime('_added');
  delete CHIMES._added;
}

function renderAddSoundOptions() {
  const on = settings.addSound !== false;
  $('#addsound-opts').innerHTML = [['on', 'On'], ['off', 'Off']].map(([k, l]) => {
    const sel = (k === 'on') === on;
    return `<button type="button" class="remind-chip${sel ? ' on' : ''}" data-addsound="${k}" aria-pressed="${sel}">${l}</button>`;
  }).join('');
}
$('#addsound-opts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-addsound]');
  if (!b) return;
  settings.addSound = b.dataset.addsound === 'on';
  saveSettings();
  renderAddSoundOptions();
  playAddedSound();
});

function buzz() {
  try { navigator.vibrate?.(CHIMES[settings.chime]?.long ? BUZZ_LONG : BUZZ); } catch { /* not supported */ }
}

function renderChimeOptions() {
  const cur = CHIMES[settings.chime] ? settings.chime : 'blip';
  const chip = ([k, c]) => `<button type="button" class="remind-chip${k === cur ? ' on' : ''}" data-chime="${k}" aria-pressed="${k === cur}">${c.label}</button>`;
  const all = Object.entries(CHIMES).filter(([k]) => k !== 'off');
  $('#chime-opts').innerHTML = `<span class="chip-group">Short</span>${all.filter(([, c]) => !c.long).map(chip).join('')}`
    + `<span class="chip-group">Long</span>${all.filter(([, c]) => c.long).map(chip).join('')}`
    + chip(['off', CHIMES.off]);
}
$('#chime-opts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-chime]');
  if (!b) return;
  settings.chime = b.dataset.chime;
  saveSettings();
  renderChimeOptions();
  playChime(settings.chime);
  if (settings.chime !== 'off') buzz();
});

// ---------- reminder settings ----------
function renderRemindOptions() {
  renderSummaryOptions();
  renderMorningOptions();
  renderChimeOptions();
  renderAddSoundOptions();
  const picked = remindOffsets();
  const custom = Array.isArray(settings.remindOffsets);
  $('#remind-opts').innerHTML = [0, ...R.OPTIONS].map((min) => {
    const on = min === 0 || picked.includes(min);
    const label = min === 0 ? 'At the time' : R.offsetLabel(min).replace(' before', '');
    return `<button type="button" class="remind-chip${on ? ' on' : ''}" data-remind="${min}" aria-pressed="${on}"${min === 0 ? ' disabled' : ''}>${label}</button>`;
  }).join('');
  const list = [...picked].sort((a, b) => b - a).map((m) => R.offsetLabel(m).replace(' before', ''));
  const before = list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]} before, and ` : list.length ? `${list[0]} before, and ` : '';
  $('#remind-hint').textContent = `You’ll get a reminder ${before}at the time.${custom ? '' : ' This is the default.'} Pick up to ${R.MAX_EXTRA} extra.`;
  $('#remind-reset').hidden = !custom;
}

function saveRemindOffsets(list) {
  if (list === null) delete settings.remindOffsets;
  else settings.remindOffsets = list;
  saveSettings();
  renderRemindOptions();
  scheduleNextReminder();
  if (sb && profile && profile.mode !== 'guest') {
    sb.auth.updateUser({ data: { blip_remind: list } }).catch(() => {});
  }
}

$('#remind-opts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-remind]');
  if (!b || b.disabled) return;
  const min = Number(b.dataset.remind);
  const cur = remindOffsets();
  if (cur.includes(min)) saveRemindOffsets(cur.filter((m) => m !== min));
  else if (cur.length >= R.MAX_EXTRA) toast(`Up to ${R.MAX_EXTRA} reminders before the time. Remove one first.`);
  else saveRemindOffsets([...cur, min]);
});
$('#remind-reset').addEventListener('click', () => saveRemindOffsets(null));

// ---------- profile: name and work ----------
// Kept in settings, separate from sign-in, so it works for guests too.
const ROLES = {
  'engineer': 'Engineer',
  'designer': 'Designer',
  'data-analyst': 'Data analyst',
  'business-analyst': 'Business analyst',
  'product-manager': 'Product manager',
  'student': 'Student',
  'researcher': 'Researcher',
  'doctor': 'Doctor',
  'healthcare': 'Nurse or healthcare',
  'teacher': 'Teacher',
  'founder': 'Founder or business owner',
  'marketing': 'Marketing or sales',
  'freelancer': 'Freelancer',
  'other': 'Something else',
};

function displayName() {
  const fromAccount = profile && profile.mode !== 'guest' ? profile.name : '';
  return (settings.displayName ?? fromAccount ?? '').trim();
}
function roleLabel() {
  if (!settings.role) return '';
  return settings.role === 'other' ? (settings.roleOther || '').trim() : ROLES[settings.role] || '';
}

const ps = { step: 'name', role: '', onboarding: false };

function openProfileSetup(step = 'name', { onboarding = false } = {}) {
  ps.onboarding = onboarding;
  for (const el of $$('.ps-step')) el.hidden = !onboarding;
  ps.role = settings.role || '';
  $('#ps-name-input').value = displayName();
  ps.avatar = settings.avatar || '';
  renderAvatarPicker();
  $('#ps-role-other').value = settings.roleOther || '';
  markRole();
  showProfileStep(step);
  $('#profile-setup').hidden = false;
}

function showProfileStep(step) {
  ps.step = step;
  $('#ps-name').hidden = step !== 'name';
  $('#ps-role').hidden = step !== 'role';
  for (const d of $$('[data-ps-dot]')) d.classList.toggle('on', d.dataset.psDot === step);
  $('#ps-back').style.visibility = ps.onboarding && step === 'name' ? 'hidden' : '';
  if (step === 'name') {
    sayHello();
    setTimeout(() => $('#ps-name-input').focus(), 200);
  }
}

function renderAvatarPicker() {
  $('#ps-avatars').innerHTML = AVATAR_IDS.map((id) => {
    const on = id === ps.avatar;
    return `<button type="button" class="ps-av${on ? ' on' : ''}" role="radio" aria-checked="${on}" data-avatar="${id}" aria-label="${AVATARS[id].label}">${avatarSVG(id, { size: 56, title: false })}</button>`;
  }).join('');
}

// Saves the avatar on this device, and on the account so other devices see it.
function saveAvatar(id) {
  if (id) settings.avatar = id;
  else delete settings.avatar;
  saveSettings();
  renderProfile();
  if (sb && profile && profile.mode !== 'guest') {
    sb.auth.updateUser({ data: { blip_avatar: id || null } }).catch(() => {});
  }
}

function sayHello() {
  const first = $('#ps-name-input').value.trim().split(/\s+/)[0];
  $('#ps-hello').textContent = first ? `Nice to meet you, ${first}.` : '';
}

function markRole() {
  for (const b of $$('.ps-role')) {
    const on = b.dataset.role === ps.role;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
  $('#ps-role-other').hidden = ps.role !== 'other';
}

function saveProfileSetup() {
  settings.displayName = $('#ps-name-input').value.trim();
  settings.role = ps.role;
  settings.roleOther = ps.role === 'other' ? $('#ps-role-other').value.trim() : '';
  saveSettings();
}

function closeProfileSetup() {
  $('#profile-setup').hidden = true;
  renderProfile();
  renderHome();
  if (ps.onboarding) {
    ps.onboarding = false;
    onboard.profile = true;
    nextOnboardingStep();
  }
}

$('#profile-card').addEventListener('click', () => openProfileSetup('name'));
$('#ps-name-input').addEventListener('input', sayHello);
$('#ps-avatars').addEventListener('click', (e) => {
  const b = e.target.closest('.ps-av');
  if (!b) return;
  ps.avatar = ps.avatar === b.dataset.avatar ? '' : b.dataset.avatar;
  for (const x of $$('.ps-av')) {
    const on = x.dataset.avatar === ps.avatar;
    x.classList.toggle('on', on);
    x.setAttribute('aria-checked', String(on));
  }
  saveAvatar(ps.avatar);
});
$('#ps-name-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#ps-next').click(); }
});
$('#ps-next').addEventListener('click', () => {
  settings.displayName = $('#ps-name-input').value.trim();
  saveSettings();
  showProfileStep('role');
});
$('#ps-roles').addEventListener('click', (e) => {
  const b = e.target.closest('.ps-role');
  if (!b) return;
  ps.role = ps.role === b.dataset.role ? '' : b.dataset.role;
  markRole();
  if (ps.role === 'other') $('#ps-role-other').focus();
});
$('#ps-done').addEventListener('click', () => {
  const during = ps.onboarding;
  saveProfileSetup();
  closeProfileSetup();
  if (!during) {
    const first = displayName().split(/\s+/)[0];
    toast(first ? `Saved. Hi, ${first}!` : 'Saved');
  }
});
$('#ps-skip').addEventListener('click', () => {
  if (ps.step === 'name') showProfileStep('role');
  else { saveProfileSetup(); closeProfileSetup(); }
});
$('#ps-back').addEventListener('click', () => {
  if (ps.step === 'role') showProfileStep('name');
  else closeProfileSetup();
});

// ---------- account and onboarding ----------
// Real sign-in runs on Supabase (email link + Google) when config.js has keys.
// Without keys, the app runs in preview mode: email sign-in is not verified.
const CFG = window.BLIP_CONFIG || {};
let profile = loadJSON(PROFILE_KEY, null);
let sb = null;

function setProfile(p) {
  profile = p;
  if (p) localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
  else localStorage.removeItem(PROFILE_KEY);
  renderProfile();
}

const PERSON_ICON = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.5" r="4"/><path d="M4.5 20.5c1.4-3.6 4.2-5.5 7.5-5.5s6.1 1.9 7.5 5.5"/></svg>';

function renderProfile() {
  const picked = settings.avatar && AVATARS[settings.avatar] ? settings.avatar : '';
  const photo = profile?.avatar ? `<img src="${esc(profile.avatar)}" alt="">` : PERSON_ICON;
  const name = displayName();
  const initial = name.charAt(0).toUpperCase();
  $('#avatar').innerHTML = picked ? avatarSVG(picked, { title: false }) : photo;
  $('#settings-avatar').innerHTML = picked ? avatarSVG(picked, { title: false }) : profile?.avatar ? photo : (initial || PERSON_ICON);
  $('#avatar-btn').classList.toggle('has-av', Boolean(picked));
  $('#settings-avatar').classList.toggle('has-av', Boolean(picked));
  $('#settings-name').textContent = name || 'Add your name';
  $('#settings-sub').textContent = roleLabel() || profile?.email || 'Tell Blip a little about you';
  $('#account-line').textContent = !profile
    ? 'Not signed in.'
    : profile.mode === 'guest'
      ? 'Guest. Tasks are saved on this device.'
      : `Signed in as ${profile.email || profile.name}`;
  $('#signout').textContent = profile && profile.mode !== 'guest'
    ? 'Sign out'
    : 'Sign in or create account';
  // Password settings only make sense for a real Supabase account.
  $('#pw-row').hidden = !(sb && profile && profile.mode !== 'guest');
  $('#pw-row-label').textContent = profile?.hasPassword ? 'Change password' : 'Set a password';
}

const authMsg = (msg) => { $('#auth-msg').textContent = msg; };
const redirectUrl = () => location.origin + location.pathname;

async function fromSession(session) {
  const u = session.user;
  signingOut = false;
  if (syncLost) { syncLost = false; $('#onboarding').hidden = true; onboardStep = null; }
  const meta = u.user_metadata || {};
  setProfile({
    mode: u.app_metadata?.provider === 'google' ? 'google' : 'email',
    email: u.email || '',
    name: meta.full_name || meta.name || '',
    avatar: meta.avatar_url || null,
    hasPassword: Boolean(meta.has_password),
  });
  // An avatar picked on another device comes with the account.
  // Reminder choices follow the account too.
  if (typeof meta.blip_summary === 'string' && meta.blip_summary !== settings.summaryTime) {
    settings.summaryTime = meta.blip_summary;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }
  if (typeof meta.blip_morning === 'string' && meta.blip_morning !== settings.morningTime) {
    settings.morningTime = meta.blip_morning;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    if (typeof renderMorningOptions === 'function') renderMorningOptions();
  }
  if (Array.isArray(meta.blip_remind) && !Array.isArray(settings.remindOffsets)) {
    settings.remindOffsets = R.extraOffsets(meta.blip_remind);
    saveSettings();
  }
  // Signed in with notifications allowed: make sure this device gets pushes.
  setTimeout(() => { if (pushReady()) enablePush(); queuePushSchedule(0); }, 1500);
  if (meta.blip_avatar && AVATARS[meta.blip_avatar] && !settings.avatar) {
    settings.avatar = meta.blip_avatar;
    saveSettings();
    renderProfile();
  }
  // Pull the account's name and work before deciding whether to ask for them.
  if (!onboard.done) {
    await Promise.race([startSync(u.id), wait(4000)]);
    nextOnboardingStep();
  } else {
    startSync(u.id);
  }
}

// Email sign-in has three paths on one form:
//   no password       -> magic link (as before)
//   password, sign in -> signInWithPassword
//   password, create  -> signUp (Supabase emails a confirmation link)
let authMode = 'signin';

function renderAuthForm() {
  const pw = $('#password').value;
  const create = authMode === 'create';
  $('#password').placeholder = create ? 'Choose a password' : 'Password (optional)';
  $('#password').autocomplete = create ? 'new-password' : 'current-password';
  $('#email-submit').textContent = create ? 'Create account' : pw ? 'Sign in' : 'Email me a sign-in link';
  $('#auth-mode').textContent = create ? 'Have an account? Sign in' : 'New here? Create an account';
  $('#forgot-pw').hidden = create;
}

function friendlyAuthError(err) {
  const m = (err?.message || '').toLowerCase();
  if (m.includes('invalid login')) return 'Wrong email or password. If you’ve only used email links so far, sign in with a link, then set a password in Settings.';
  if (m.includes('email not confirmed')) return 'Confirm your email first: open the link we sent you.';
  if (m.includes('already registered')) return 'That email already has an account. Sign in instead.';
  if (m.includes('rate limit')) return 'Too many emails just now. Wait a few minutes and try again.';
  if (m.includes('password should') || m.includes('weak')) return 'That password is too weak. Use at least 8 characters with a letter and a number.';
  return err?.message || 'Something went wrong. Try again.';
}

async function signInWithPassword(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  authMsg('');
}

async function createAccount(email, password) {
  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: redirectUrl(), data: { has_password: true } },
  });
  if (error) throw error;
  // Supabase answers "success" for an email that already has an account, but
  // sends no mail. It shows up as a user with no identities.
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    authMsg('This email already has an account. Sign in, or use Forgot password.');
    return;
  }
  if (!data.session) authMsg('Check your inbox to confirm your email, then sign in.');
}

async function sendPasswordReset(email) {
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: redirectUrl() });
  if (error) throw error;
  authMsg('Check your inbox for a link to reset your password.');
}

async function signInWithEmail(email) {
  if (!sb) {
    setProfile({ mode: 'email', email, name: '', avatar: null });
    nextOnboardingStep();
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

// ---------- onboarding ----------
// First run, in order: 1 sign in, 2 name and work, 3 install, 4 permissions,
// then home. Each step is remembered, so the flow never repeats a finished
// step, and it only runs again after signing out (and then only the sign-in
// step, plus anything still missing). Name and work come from the account
// when they were already set on another device.
const ONBOARD_KEY = 'blip.onboarding.v2';
const onboard = loadJSON(ONBOARD_KEY, { profile: false, install: false, perms: false, done: false });
const saveOnboard = () => localStorage.setItem(ONBOARD_KEY, JSON.stringify(onboard));
let onboardStep = null;

function showOnboardStep(step) {
  onboardStep = step;
  $('#onboarding').hidden = !['auth', 'install', 'perms'].includes(step);
  $('#ob-auth').hidden = step !== 'auth';
  $('#ob-install').hidden = step !== 'install';
  $('#ob-perms').hidden = step !== 'perms';
  if (step === 'perms') renderPerms();
  if (step === 'install') renderInstallStep();
}

// Works out which step is still needed and shows it. Safe to call any time.
function nextOnboardingStep() {
  if (!profile) { showOnboardStep('auth'); return; }
  if (onboard.done) { closeOnboarding(); return; }
  if (!onboard.profile && (displayName() || roleLabel())) onboard.profile = true;
  if (!onboard.install && (isStandalone() || !installSupported())) onboard.install = true;
  saveOnboard();
  if (!onboard.profile) {
    if (onboardStep !== 'profile') {
      showOnboardStep('profile');
      openProfileSetup('name', { onboarding: true });
    }
    return;
  }
  if (!onboard.install) { showOnboardStep('install'); return; }
  if (!onboard.perms) { showOnboardStep('perms'); return; }
  onboard.done = true;
  saveOnboard();
  closeOnboarding(true);
}

function closeOnboarding(justFinished = false) {
  const wasOpen = onboardStep !== null;
  onboardStep = null;
  $('#onboarding').hidden = true;
  renderProfile();
  setTimeout(runLaunch, justFinished && wasOpen ? 900 : 300);
  if (justFinished && wasOpen) {
    // Dark is the default look once onboarding is done, unless the person
    // already picked a theme in Settings on this device.
    if (!settings.themePicked) setTheme('dark');
    showView('home');
    const first = displayName().split(/\s+/)[0];
    toast(first ? `You’re all set, ${first}.` : 'You’re all set.');
    // First time on this device: play the product tour once. It can be closed.
    if (!onboard.tour) setTimeout(openTour, 500);
  }
}

// ---------- product tour ----------
// Phones get the portrait video, larger screens the landscape one.
const tourSrc = () => (mqDesktopTour.matches ? 'tour/blip-tour-desktop.mp4?v=2' : 'tour/blip-tour-phone.mp4?v=2');
const mqDesktopTour = window.matchMedia('(min-width: 1024px)');

function openTour() {
  const v = $('#tour-video');
  const src = tourSrc();
  if (v.getAttribute('src') !== src) v.setAttribute('src', src);
  v.currentTime = 0;
  $('#tour').hidden = false;
  onboard.tour = true;
  saveOnboard();
  // Sound needs a recent tap; if the browser blocks it, the play button stays.
  v.play().catch(() => {});
  setTimeout(() => $('#tour-close').focus(), 50);
}

function closeTour() {
  const v = $('#tour-video');
  v.pause();
  $('#tour').hidden = true;
}

$('#tour-close').addEventListener('click', closeTour);
$('#tour-done').addEventListener('click', closeTour);
$('#tour-video').addEventListener('ended', () => { $('#tour-done').focus(); });
$('#tour').addEventListener('click', (e) => { if (e.target.id === 'tour') closeTour(); });
$('#tour-row').addEventListener('click', openTour);

// Kept for callers that just want the sign-in screen (sign out, Settings).
function showOnboarding() {
  onboard.done = false;
  saveOnboard();
  nextOnboardingStep();
}

function renderInstallStep() {
  const text = $('#ob-install-text');
  const steps = $('#ob-install-steps');
  const go = $('#ob-install-go');
  const skip = $('#ob-install-skip');
  skip.textContent = 'Not now';
  if (deferredPrompt) {
    text.textContent = 'Open Blip in one tap, full screen, like any other app.';
    steps.hidden = true;
    go.hidden = false;
  } else if (isIOSSafari()) {
    text.textContent = 'Three quick steps in Safari:';
    steps.innerHTML = '<li>Tap the Share button at the bottom of the screen.</li>'
      + '<li>Scroll down and tap “Add to Home Screen”.</li>'
      + '<li>Tap Add in the top-right corner.</li>';
    steps.hidden = false;
    go.hidden = true;
    skip.textContent = 'Done';
  } else if (isIOS()) {
    text.textContent = 'On iPhone, Blip installs from Safari. Open this page in Safari, tap Share, then “Add to Home Screen”.';
    steps.hidden = true;
    go.hidden = true;
    skip.textContent = 'Continue';
  } else {
    text.textContent = 'Look for the install icon in your browser’s address bar, or open the browser menu and choose “Install Blip”.';
    steps.hidden = true;
    go.hidden = true;
    skip.textContent = 'Continue';
  }
}

async function permState(name) {
  try {
    const r = await navigator.permissions.query({ name });
    return r.state;
  } catch {
    return 'unknown';
  }
}

// Each permission row shows one thing on the right: an Allow button while
// Blip can still ask, or a short status once it can't. Longer advice goes
// under the title, so the row never crowds on a phone.
function setPermRow(id, state, why) {
  const row = $(`#${id}`);
  const btn = row.querySelector('[data-perm]');
  const sub = row.querySelector('.why');
  if (sub && !sub.dataset.base) sub.dataset.base = sub.textContent;
  row.classList.toggle('ok', state === 'granted');
  row.classList.toggle('blocked', state === 'denied' || state === 'unsupported');
  if (btn) btn.hidden = state !== 'prompt';
  let st = row.querySelector('.perm-state');
  if (!st) {
    st = document.createElement('span');
    st.className = 'perm-state';
    row.append(st);
  }
  const status = { granted: 'Allowed', denied: 'Blocked', unsupported: 'Not available' }[state] || '';
  st.textContent = status;
  st.hidden = !status;
  if (sub) sub.textContent = state === 'denied' || state === 'unsupported' ? why : sub.dataset.base;
}

async function renderPerms() {
  const mic = await permState('microphone');
  setPermRow('perm-mic', mic === 'granted' || mic === 'denied' ? mic : 'prompt', 'Turn it on in your browser’s site settings');
  const notif = 'Notification' in window ? Notification.permission : 'unsupported';
  setPermRow('perm-notif', notif === 'default' ? 'prompt' : notif,
    notif === 'unsupported' ? 'This browser can’t show notifications' : 'Turn them on in your browser’s site settings');
}

async function askMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    toast('Microphone is on.');
  } catch {
    toast('Microphone was blocked. You can allow it in browser settings.');
  }
  renderPerms();
}

async function askNotifications() {
  if (!('Notification' in window)) {
    toast('This browser can’t show notifications.');
    return;
  }
  await Notification.requestPermission();
  if (Notification.permission === 'granted') enablePush();
  renderPerms();
  renderNotifButton();
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
  // Settings → Help always offers install, so people who removed the app can get it back.
  $('#install-settings-label').textContent = isStandalone() ? 'Blip app is installed' : 'Install the Blip app';
  $('#side-install').hidden = !show;
}

function openInstall() {
  if (isStandalone()) {
    toast('You’re already using the installed Blip app.');
    return;
  }
  // The browser offers a one-step install: show its confirmation straight away.
  if (deferredPrompt) {
    runInstall();
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
    // The browser isn't offering install right now. Usually Blip is already
    // installed on this device, or the browser installs from its own menu.
    text.textContent = 'If Blip is already on this device, open it from your home screen or app list. Otherwise open the browser menu (⋮) and choose “Install app” or “Add to Home screen”.';
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
  toast(outcome === 'accepted' ? 'Installing Blip…' : 'You can install Blip anytime from Settings.');
}

function dismissInstall() {
  localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now()));
  closeAll();
}


function initAccountAndInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    refreshInstallEntries();
    if (onboardStep === 'install') renderInstallStep();
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
  refreshInstallEntries();

  // Onboarding
  $('#ob-install-go').addEventListener('click', async () => {
    if (deferredPrompt) {
      const prompt = deferredPrompt;
      prompt.prompt();
      await prompt.userChoice.catch(() => null);
      deferredPrompt = null;
      refreshInstallEntries();
    }
    onboard.install = true;
    nextOnboardingStep();
  });
  $('#ob-install-skip').addEventListener('click', () => {
    onboard.install = true;
    nextOnboardingStep();
  });
  $('#perm-continue').addEventListener('click', () => {
    onboard.perms = true;
    nextOnboardingStep();
  });
  for (const b of $$('[data-perm]')) {
    b.addEventListener('click', () => {
      if (b.dataset.perm === 'mic') askMic();
      else askNotifications();
    });
  }

  $('#google-btn').addEventListener('click', () => {
    signInWithGoogle().catch((err) => authMsg(err.message));
  });
  $('#email-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = $('#email').value.trim();
    const pw = $('#password').value;
    if (!/^\S+@\S+\.\S+$/.test(v)) {
      authMsg('Enter a valid email address.');
      return;
    }
    if (authMode === 'create' && pw.length < 8) {
      authMsg('Choose a password of at least 8 characters.');
      return;
    }
    const btn = $('#email-submit');
    btn.disabled = true;
    try {
      if (!sb || (!pw && authMode !== 'create')) await signInWithEmail(v);
      else if (authMode === 'create') await createAccount(v, pw);
      else await signInWithPassword(v, pw);
    } catch (err) {
      authMsg(friendlyAuthError(err));
    } finally {
      btn.disabled = false;
    }
  });
  $('#password').addEventListener('input', renderAuthForm);
  $('#pw-show').addEventListener('click', () => {
    const show = $('#password').type === 'password';
    $('#password').type = show ? 'text' : 'password';
    $('#pw-show').textContent = show ? 'Hide' : 'Show';
    $('#pw-show').setAttribute('aria-pressed', String(show));
  });
  $('#auth-mode').addEventListener('click', () => {
    authMode = authMode === 'create' ? 'signin' : 'create';
    authMsg('');
    renderAuthForm();
  });
  $('#forgot-pw').addEventListener('click', () => {
    const v = $('#email').value.trim();
    if (!/^\S+@\S+\.\S+$/.test(v)) {
      authMsg('Enter your email above, then tap “Forgot password?” again.');
      $('#email').focus();
      return;
    }
    if (!sb) { authMsg('Password reset needs Supabase set up in config.js.'); return; }
    sendPasswordReset(v).catch((err) => authMsg(friendlyAuthError(err)));
  });
  renderAuthForm();
  $('#skip-auth').addEventListener('click', () => {
    setProfile({ mode: 'guest', name: '', email: '', avatar: null });
    nextOnboardingStep();
  });

  $('#sync-now').addEventListener('click', syncNow);
  $('#signout').addEventListener('click', async () => {
    signingOut = true;
    syncLost = false;
    if (!profile || profile.mode === 'guest') {
      setProfile(null);
      showOnboarding();
      return;
    }
    await stopSync();
    await disablePush();
    if (sb) await sb.auth.signOut();
    setProfile(null);
    // Name and work belonged to that account; the next person sets their own.
    delete settings.displayName;
    delete settings.role;
    delete settings.roleOther;
    saveSettings();
    onboard.profile = false;
    showOnboarding();
  });

  refreshInstallEntries();
}

// The profile on this device says "signed in", but Supabase has no session:
// the sign-in expired or was ended elsewhere. Without this, Blip would look
// signed in while nothing syncs.
function markSyncLost() {
  if (!profile || profile.mode === 'guest' || signingOut) return;
  syncLost = true;
  renderSyncLine();
  toast('Sync is paused. Sign in again to keep your devices in step.');
}

async function initAuth() {
  if (CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase) {
    sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
    const { data } = await sb.auth.getSession();
    if (data.session) await fromSession(data.session);
    else markSyncLost();
    sb.auth.onAuthStateChange((event, session) => {
      if (session) { syncLost = false; fromSession(session); }
      else if (event === 'SIGNED_OUT') markSyncLost();
      // Opened from a "reset password" email: ask for the new password now.
      if (event === 'PASSWORD_RECOVERY') openPasswordSetup('reset');
    });
  }
  renderProfile();
  const google = Boolean(sb && CFG.googleSignIn);
  $('#google-btn').hidden = !google;
  $('#google-or').hidden = !google;
  authMsg(sb ? '' : 'Preview mode: email isn’t verified until Supabase is connected.');
  nextOnboardingStep();
}

// ---------- password (v2) ----------
// One password per account, so it works on every device. Set it here after
// signing in with a link, change it later, or set a new one from a reset email.
let pwMode = 'set';

function openPasswordSetup(mode = profile?.hasPassword ? 'change' : 'set') {
  pwMode = mode;
  $('#pw-title').textContent = { set: 'Set a password', change: 'Change password', reset: 'Set a new password' }[mode];
  $('#pw-copy').textContent = mode === 'reset'
    ? 'Choose a new password for your Blip account. You’ll use it on all your devices.'
    : 'Use it with your email to sign in to Blip on any device, without waiting for a link.';
  $('#pw-username').value = profile?.email || '';
  $('#pw-new').value = '';
  $('#pw-confirm').value = '';
  $('#pw-msg').textContent = '';
  checkPasswordRules();
  $('#pw-setup').hidden = false;
  setTimeout(() => $('#pw-new').focus(), 200);
}

function checkPasswordRules() {
  const a = $('#pw-new').value;
  const b = $('#pw-confirm').value;
  const ok = { len: a.length >= 8, mix: /[a-z]/i.test(a) && /\d/.test(a), match: Boolean(a) && a === b };
  for (const li of $$('#pw-rules li')) li.classList.toggle('ok', ok[li.dataset.rule]);
  $('#pw-save').disabled = !(ok.len && ok.mix && ok.match);
  return ok;
}

$('#pw-row').addEventListener('click', () => openPasswordSetup());
$('#pw-back').addEventListener('click', () => { $('#pw-setup').hidden = true; });
$('#pw-new').addEventListener('input', checkPasswordRules);
$('#pw-confirm').addEventListener('input', checkPasswordRules);
$('#pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!sb) return;
  const ok = checkPasswordRules();
  if (!(ok.len && ok.mix && ok.match)) return;
  $('#pw-save').disabled = true;
  $('#pw-msg').textContent = 'Saving…';
  const { error } = await sb.auth.updateUser({ password: $('#pw-new').value, data: { has_password: true } });
  if (error) {
    const m = error.message.toLowerCase();
    $('#pw-msg').textContent = m.includes('reauthentication') || m.includes('recent')
      ? 'For safety, sign out and sign back in with an email link, then set the password again.'
      : m.includes('same') ? 'That’s your current password. Choose a different one.'
      : friendlyAuthError(error);
    $('#pw-save').disabled = false;
    return;
  }
  if (profile) setProfile({ ...profile, hasPassword: true });
  $('#pw-setup').hidden = true;
  toast(pwMode === 'change' ? 'Password changed' : 'Password saved. Use it to sign in on any device.');
});

// ---------- sync (v2) ----------
// Runs only when signed in with Supabase. Guests and preview mode behave as v1.
let blipSync = null;
let signingOut = false;
// One full check per device after this update, so devices that drifted apart converge.
const REPAIR_KEY = 'blip.sync.repaired.v1';

let syncLost = false; // the app thinks you're signed in, but the sign-in has expired
function syncStatusText(status, last, err) {
  if (syncLost) return 'Sync is paused: your sign-in expired on this device. Sign in again to sync.';
  if (status === 'syncing') return 'Syncing…';
  if (status === 'offline') return 'Offline. Changes will sync when you’re back online.';
  if (status === 'error') return `Couldn’t sync${err ? ` (${err})` : ''}. Blip will try again shortly.`;
  if (status === 'synced') {
    const mins = Math.round((Date.now() - last) / 60000);
    return mins < 1 ? 'Synced just now' : `Synced ${mins} min ago`;
  }
  return '';
}

function renderSyncLine(status = blipSync?.status, last = blipSync?.lastSynced, err = blipSync?.lastError) {
  const el = $('#sync-line');
  if (!el) return;
  const text = syncStatusText(status, last, err);
  el.textContent = text;
  el.hidden = !text;
  el.classList.toggle('danger', syncLost || status === 'error');
  // Details, so two devices can be compared at a glance.
  const on = Boolean(blipSync?.userId) && !syncLost;
  const detail = $('#sync-detail');
  if (detail) {
    const open = tasks.filter((t) => !t.done).length;
    const waiting = blipSync?.pending || 0;
    detail.textContent = on
      ? `Account ${blipSync.userId.slice(0, 8)} · ${tasks.length} tasks on this device (${open} open)${waiting ? ` · ${waiting} waiting to upload` : ''}`
      : '';
    detail.hidden = !on;
  }
  const btn = $('#sync-now');
  if (btn) {
    btn.hidden = !(on || syncLost);
    btn.querySelector('span').textContent = syncLost ? 'Sign in again' : 'Sync now';
  }
}

async function syncNow() {
  if (syncLost) { openSignIn(); return; }
  if (!blipSync?.userId) return;
  const btn = $('#sync-now');
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Checking everything…';
  const res = await blipSync.repair();
  btn.disabled = false;
  renderSyncLine();
  render();
  toast(res.ok
    ? `In sync: ${res.tasks} tasks here, ${res.server} in your account${res.requeued ? `, ${res.requeued} sent up` : ''}`
    : `Couldn’t sync${res.error ? `: ${res.error}` : ''}`);
}

// Back to the sign-in step, keeping this device's tasks so they can sync after.
function openSignIn() {
  showOnboardStep('auth');
}

function startSync(userId) {
  if (!sb || !window.createBlipSync) return Promise.resolve();
  if (!blipSync) {
    blipSync = window.createBlipSync({
      client: sb,
      storage: localStorage,
      onStatus: renderSyncLine,
      log: (...a) => console.warn('[Blip sync]', ...a),
      store: {
        getTasks: () => tasks,
        getNotes: () => notes,
        getSettings: () => settings,
        // Writes from the server go straight to storage, not back through sync.
        setTasks: (list) => {
          tasks = list.map(normalizeTask);
          localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
          scheduleNextReminder();
        },
        setNotes: (list) => {
          notes = list;
          localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
        },
        applySettings: (s) => {
          Object.assign(settings, s);
          if (!THEMES.includes(settings.theme)) settings.theme = 'light';
          localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
          setTheme(settings.theme);
          renderProfile();
        },
        // A task arriving from another device that is already past its
        // reminder time shouldn't ring here too.
        alreadyDue: (t) => {
          const due = dueAt(t);
          return due !== null && due <= Date.now();
        },
        // Re-render, but not over a form the user is editing.
        remoteChanged: () => {
          const editing = ui.view === 'task' || ui.view === 'note';
          if (!editing) render();
          else renderHome();
        },
      },
    });
    syncChanged = (kind) => blipSync.changed(kind);
    window.addEventListener('online', () => blipSync.resume());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') blipSync.resume();
    });
    // A desktop window can stay visible all day, so also catch up when it gets
    // focus and every minute while it's on screen, in case a live update is missed.
    window.addEventListener('focus', () => blipSync.resume());
    setInterval(() => { if (document.visibilityState === 'visible') blipSync.resume(); }, 60_000);
    // Every 15 minutes, and when you come back after 15 minutes or more, run the
    // same full check as "Sync now", so devices that drifted apart converge on their own.
    const FULL_EVERY = 15 * 60_000;
    let lastFull = Date.now();
    const fullCheck = async () => {
      if (!blipSync.userId || syncLost || document.visibilityState !== 'visible') return;
      if (Date.now() - lastFull < FULL_EVERY) return;
      lastFull = Date.now();
      await blipSync.repair(); // pulled changes re-render through remoteChanged
      renderSyncLine();
    };
    setInterval(fullCheck, 60_000);
    document.addEventListener('visibilitychange', fullCheck);
  }
  return blipSync.start(userId).then(async () => {
    if (localStorage.getItem(REPAIR_KEY) === userId) return;
    const res = await blipSync.repair();
    if (res.ok) localStorage.setItem(REPAIR_KEY, userId);
    renderSyncLine();
    render();
  });
}

async function stopSync() {
  if (!blipSync) return;
  await blipSync.stop({ clear: true });
}

// ---------- splash ----------
function runSplash() {
  const splash = $('#splash');
  if (sessionStorage.getItem(SPLASH_KEY)) {
    splash.hidden = true;
    return;
  }
  sessionStorage.setItem(SPLASH_KEY, '1');
  setTimeout(() => {
    splash.classList.add('gone');
    setTimeout(() => { splash.hidden = true; }, 380);
  }, 1400);
}

// ---------- device, viewport and desktop ----------
// Layout is chosen by CSS media queries (width). Behavior is chosen here by
// data attributes on <html>: layout (phone | tablet | desktop), pointer
// (touch | mouse), os, and orientation.
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
    requestAnimationFrame(fitHome);
    clearTimeout(timer);
    timer = setTimeout(() => {
      applyDevice();
      // The drawer-style sheets belong to the phone layout; close them on desktop.
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
    processText(v);
  });

  // Phone home: the text box under the mic sends typed tasks through the same review step.
  const composerInput = $('#composer-input');
  const sizeComposer = () => {
    composerInput.style.height = 'auto';
    composerInput.style.height = composerInput.scrollHeight + 'px';
  };
  composerInput.addEventListener('input', sizeComposer);
  // Enter sends; Shift+Enter starts a new line.
  composerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#home-composer').requestSubmit();
    }
  });
  $('#home-composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = composerInput.value.trim();
    if (!v) return;
    composerInput.value = '';
    sizeComposer();
    processText(v);
  });
  initPlusMenus();
  // Model pickers (phone composer and desktop quick-add). The model decides
  // which features are on: see MODEL_FEATURES.
  const pickers = [...document.querySelectorAll('.model-pick:not(.plus-pick)')].map((el) => ({
    el, pill: el.querySelector('.model-btn'), menu: el.querySelector('.model-menu'), name: el.querySelector('.model-name'),
  }));
  const currentModel = () => (MODELS.find((m) => m[0] === modelId()) || MODELS[0]);
  const renderModels = () => {
    const cur = currentModel();
    pickers.forEach((p) => {
      p.name.textContent = cur[1];
      p.menu.innerHTML = MODELS.map(([id, name, sub]) => `
      <li role="option" class="model-opt${id === cur[0] ? ' on' : ''}" data-model="${id}" aria-selected="${id === cur[0]}" tabindex="-1">
        <span><b>${name}</b><small>${sub}</small></span>
        <svg class="i model-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>
      </li>`).join('');
    });
  };
  const setMenu = (p, open) => {
    p.menu.hidden = !open;
    p.pill.setAttribute('aria-expanded', String(open));
    if (open) p.menu.querySelector('.on')?.focus();
  };
  renderModels();
  renderModelPickers = renderModels;
  pickers.forEach((p) => {
    p.pill.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); setMenu(p, p.menu.hidden); });
    p.menu.addEventListener('click', (e) => {
      const li = e.target.closest('[data-model]');
      if (!li) return;
      setMenu(p, false);
      setModel(li.dataset.model);
    });
    p.menu.addEventListener('keydown', (e) => {
      const items = [...p.menu.querySelectorAll('[data-model]')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.activeElement.click(); }
      else if (e.key === 'Escape') { e.stopPropagation(); setMenu(p, false); p.pill.focus(); }
    });
  });
  document.addEventListener('click', (e) => {
    pickers.forEach((p) => { if (!p.menu.hidden && !p.el.contains(e.target)) setMenu(p, false); });
  });
  $('#composer-mic').addEventListener('click', () => openCapture('voice'));

  // Desktop shortcuts. They never fire while typing.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#tour').hidden) { closeTour(); return; }
      if (!$('#capture').hidden) closeCapture();
      closeAll();
      return;
    }
    const typing = /input|textarea|select/i.test(e.target.tagName) || e.target.isContentEditable;
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!mqDesktop.matches) return;

    if (e.code === 'Space' || e.key === ' ') {
      // Space starts speaking, and pressing it again while listening stops.
      // Left alone while a dialog, sheet, or the review screen is open.
      if (e.repeat) { e.preventDefault(); return; }
      const listening = !$('#capture').hidden && !$('#cap-listen').hidden;
      if (listening) { e.preventDefault(); $('#cap-stop').click(); return; }
      const blocked = !$('#capture').hidden || !$('#tour').hidden
        || document.querySelector('.onboard:not([hidden]), .sheet.open');
      if (blocked) return;
      e.preventDefault();
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      openCapture('voice');
    } else if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      showView('home');
      $('#quick-input').focus();
    } else if (e.key === '/') {
      e.preventDefault();
      showView('tasks');
      openSearch('#search-row', '#search');
    }
  });
}

// ---------- themes ----------
function setTheme(name = settings.theme) {
  if (!THEMES.includes(name)) name = 'light';
  root.dataset.theme = name;
  const pal = PALETTES.includes(settings.palette) ? settings.palette : 'blip';
  root.dataset.palette = pal;
  const meta = document.querySelector('meta[name="theme-color"]');
  const bar = pal === 'meld' ? (name === 'dark' ? '#121214' : '#BC4989') : (name === 'dark' ? '#262624' : '#1B3B2B');
  if (meta) meta.setAttribute('content', bar);
  if (settings.theme !== name) {
    settings.theme = name;
    saveSettings();
  }
  markTheme();
}

function markTheme() {
  for (const b of $$('[data-theme-pick]')) {
    b.setAttribute('aria-pressed', String(b.dataset.themePick === settings.theme));
  }
  const pal = PALETTES.includes(settings.palette) ? settings.palette : 'blip';
  for (const b of $$('[data-palette-pick]')) {
    b.setAttribute('aria-pressed', String(b.dataset.palettePick === pal));
  }
}

for (const b of $$('[data-palette-pick]')) {
  b.addEventListener('click', () => {
    settings.palette = b.dataset.palettePick;
    saveSettings();
    setTheme();
    toast(`Style: ${settings.palette === 'meld' ? 'Meld' : 'Blip'}`);
  });
}

for (const b of $$('[data-theme-pick]')) {
  b.addEventListener('click', () => {
    settings.themePicked = true;
    setTheme(b.dataset.themePick);
    saveSettings();
    toast(`Theme: ${b.dataset.themePick === 'dark' ? 'Dark' : 'Light'}`);
  });
}

// ---------- views ----------
// Which tab is highlighted for each view.
const VIEW_TAB = {
  home: 'home', tasks: 'tasks', task: 'tasks',
  notes: 'notes', note: 'notes',
  calendar: 'calendar',
  integrations: 'integrations', settings: 'settings',
};

// On phones the home screen should fit without scrolling, with the text box
// sitting just above the floating tab bar. Screen heights vary (gesture bars,
// installed vs browser), so measure instead of guessing.
function fitHome() {
  const main = $('#view-home .home-main');
  const bar = $('.tabbar');
  if (!main) return;
  const page = document.querySelector('main');
  if (!bar || getComputedStyle(bar).display === 'none' || ui.view !== 'home') {
    main.style.minHeight = '';
    page.style.paddingBottom = '';
    return;
  }
  const top = main.getBoundingClientRect().top + window.scrollY;
  const barTop = bar.getBoundingClientRect().top;
  // Fill down to 20px above the bar, and leave exactly the bar's space below,
  // so the page fits the screen. Taller content still scrolls clear of the bar.
  main.style.minHeight = `${Math.max(0, Math.floor(barTop - top - 20))}px`;
  page.style.paddingBottom = `${Math.ceil(window.innerHeight - barTop + 20)}px`;
}

function showView(name) {
  ui.view = name;
  root.dataset.view = name;
  for (const v of $$('.view')) v.hidden = v.id !== `view-${name}`;
  requestAnimationFrame(() => { for (const ta of $$(`#view-${name} textarea[data-autogrow]`)) autoGrow(ta); });
  const tab = VIEW_TAB[name];
  for (const t of $$('[data-nav]')) {
    t.classList.toggle('on', t.dataset.nav === tab);
  }
  if (name !== 'home') closeMenus();
  renderView(name);
  window.scrollTo({ top: 0 });
  if (name === 'home') requestAnimationFrame(fitHome);
}

function openSearch(rowSel, inputSel) {
  $(rowSel).hidden = false;
  $(inputSel).focus();
}

function closeMenus() {
  $('#more-menu').hidden = true;
  $('#more-btn').setAttribute('aria-expanded', 'false');
}

function closeAll() {
  $('#install-sheet').classList.remove('open');
  $('#invite-sheet')?.classList.remove('open');
  closeNews();
  $('#scrim').classList.remove('show', 'clear');
  closeMenus();
}

// ---------- what's new ----------
const NEWS_KEY = 'blip.news.seen';
const newsSeen = () => Number(localStorage.getItem(NEWS_KEY)) || 0;
const newsLatest = () => (typeof WHATS_NEW !== 'undefined' && WHATS_NEW[0] ? WHATS_NEW[0].id : 0);
function renderNewsDot() {
  const unread = newsLatest() > newsSeen();
  for (const d of $$('.news-dot')) d.hidden = !unread;
  for (const b of [$('#news-btn'), $('#news-pill')]) b?.setAttribute('aria-label', unread ? "What's new, new updates" : "What's new");
}
function renderNews() {
  const seen = newsSeen();
  const fmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
  $('#news-list').innerHTML = (typeof WHATS_NEW !== 'undefined' ? WHATS_NEW : []).map((n) => `
    <li class="news-item${n.id > seen ? ' unseen' : ''}">
      <div class="news-meta"><span class="news-tag">${n.id > seen ? 'New' : esc(n.tag || 'Update')}</span><span>${fmt.format(new Date(n.date + 'T12:00'))}</span></div>
      <h3>${esc(n.title)}</h3>
      <p>${esc(n.body)}</p>
      ${n.action ? `<button class="news-go" type="button" data-news-go="${esc(n.action.go)}">${esc(n.action.label)}</button>` : ''}
    </li>`).join('');
}
function openNews() {
  closeMenus();
  renderNews();
  $('#news-sheet').classList.add('open');
  $('#scrim').classList.add('show');
  $('#scrim').classList.toggle('clear', mqDesktop.matches);
  $('#news-pill').setAttribute('aria-expanded', 'true');
  localStorage.setItem(NEWS_KEY, String(newsLatest()));
  renderNewsDot();
}
function closeNews() {
  $('#news-sheet').classList.remove('open');
  $('#news-pill')?.setAttribute('aria-expanded', 'false');
}
function initNews() {
  renderNewsDot();
  $('#news-btn').addEventListener('click', openNews);
  $('#news-pill').addEventListener('click', () => ($('#news-sheet').classList.contains('open') ? closeAll() : openNews()));
  $('#news-close').addEventListener('click', closeAll);
  $('#scrim').addEventListener('click', closeAll);
  $('#news-list').addEventListener('click', (e) => {
    const go = e.target.closest('[data-news-go]')?.dataset.newsGo;
    if (!go) return;
    closeAll();
    if (go === 'tour') openTour();
    else showView(go);
  });
}

// ---------- invite friends ----------
// Always links to the live app, even from the preview.
const INVITE_URL = 'https://blip.akshayashokanpothan.com/?ref=invite';
function inviteText() {
  const name = displayName();
  return `${name ? `${name} invited you to try Blip` : 'Try Blip'}, a voice-first to-do app. Just say it, and Blip writes it down.`;
}
async function nativeShare() {
  try {
    await navigator.share({ title: 'Blip', text: inviteText(), url: INVITE_URL });
    toast('Thanks for sharing Blip');
    return true;
  } catch (err) {
    return err?.name === 'AbortError'; // closed the share menu: that's fine
  }
}
function openInviteSheet() {
  closeMenus();
  const msg = `${inviteText()} ${INVITE_URL}`;
  $('#invite-url').value = INVITE_URL;
  $('#invite-wa').href = `https://wa.me/?text=${encodeURIComponent(msg)}`;
  $('#invite-sms').href = `sms:?&body=${encodeURIComponent(msg)}`;
  $('#invite-mail').href = `mailto:?subject=${encodeURIComponent('Try Blip')}&body=${encodeURIComponent(msg)}`;
  $('#invite-more').hidden = !navigator.share;
  $('#invite-sheet').classList.add('open');
  $('#scrim').classList.add('show');
}
async function invite() {
  // Phones: the system share menu (WhatsApp, Instagram, anything). Desktop: Blip's own sheet.
  if (navigator.share && !mqDesktop.matches && (await nativeShare())) return;
  openInviteSheet();
}
function initInvite() {
  for (const id of ['#invite-card', '#invite-row', '#side-invite']) $(id)?.addEventListener('click', invite);
  $('#invite-close').addEventListener('click', closeAll);
  $('#invite-more').addEventListener('click', async () => { if (await nativeShare()) closeAll(); });
  $('#invite-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(`${inviteText()} ${INVITE_URL}`); }
    catch { $('#invite-url').select(); document.execCommand('copy'); }
    toast('Invite link copied');
  });
}

// ---------- share into Blip and app icon shortcuts ----------
// Android lists Blip in the share sheet (share_target in the manifest), which opens
// ./?share_text=…&share_url=…&share_title=…. Long-pressing the app icon offers
// shortcuts that open ./?go=voice|tomorrow|summary|note. Either is kept until Blip
// is ready (signed in, onboarding done), then runs once.
const LAUNCH_KEY = 'blip.launch';
const SHARE_URL_RE = /\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'’]/gi;
const SHARE_OPENER = /^\s*(?:(?:hi|hello|hey|dear|good (?:morning|afternoon|evening))\b[^!.,:\n]{0,20}[!.,:]+|(?:reminder|fyi|note|update|pls|please note|important)\s*[:!-]+)\s*/i;
const LAUNCH_GO = ['voice', 'tomorrow', 'summary', 'note'];

function readLaunch(q) {
  const go = q.get('go');
  const share = ['share_title', 'share_text', 'share_url'].some((k) => q.get(k));
  if (!share && !LAUNCH_GO.includes(go)) return;
  const launch = share
    ? { share: { title: q.get('share_title') || '', text: q.get('share_text') || '', url: q.get('share_url') || '' } }
    : { go };
  sessionStorage.setItem(LAUNCH_KEY, JSON.stringify(launch));
  history.replaceState(null, '', location.pathname);
}

// Turns what another app shared into the text Blip parses and the notes it keeps.
// Links go to notes. A long or multi-line message is kept whole in the notes and
// only its first line becomes the task.
function sharedTask({ title = '', text = '', url = '' }) {
  const links = [...new Set([url, ...(`${text} ${title}`.match(SHARE_URL_RE) || [])].map((u) => u.trim()).filter(Boolean))];
  const clean = (s) => s.replace(SHARE_URL_RE, ' ').replace(/[ \t]+/g, ' ').replace(/^[ \t\-–—:|]+|[ \t\-–—:|]+$/gm, '').trim();
  let body = clean(text);
  // A page title's site name ("… | BBC Good Food", "… - YouTube") isn't part of the task.
  const head = clean(title).replace(/\s+[|–—-]\s+[^|–—-]{2,40}$/, '').trim();
  if (!body) body = head;
  let host = '';
  try { host = links[0] ? new URL(links[0]).hostname.replace(/^www\./, '') : ''; } catch { /* not a URL */ }
  const notes = [];
  let line = body.split(/\n+/).map((l) => l.trim()).find(Boolean) || '';
  if (body.includes('\n') || body.length > 120) {
    notes.push(text.trim() || body);
    // Group-chat openers ("Hi all!", "Reminder:") go, then the first sentence is the task.
    line = line.replace(SHARE_OPENER, '').replace(SHARE_OPENER, '');
    line = (line.match(/^.+?[.!?](?=\s|$)/) || [line])[0].replace(/[.!?]+$/, '');
    if (line.length > 90) line = `${line.slice(0, 90).replace(/\s+\S*$/, '')}…`;
  }
  notes.push(...links.filter((l) => !notes[0]?.includes(l)));
  line = line.charAt(0).toUpperCase() + line.slice(1);
  if (!line) line = host ? `Check link from ${host}` : 'Check shared link';
  return { text: line, notes: notes.join('\n'), from: host };
}

let launchBusy = false;
function runLaunch() {
  const raw = sessionStorage.getItem(LAUNCH_KEY);
  if (!raw || launchBusy) return;
  // Not ready yet: signing in, setting up, or splash still up. Try again shortly.
  if (!onboard.done || onboardStep !== null || !$('#onboarding').hidden || !$('#splash').hidden) {
    if (onboard.done) setTimeout(runLaunch, 800);
    return;
  }
  sessionStorage.removeItem(LAUNCH_KEY);
  let launch;
  try { launch = JSON.parse(raw); } catch { return; }
  closeAll();
  if (launch.share) {
    const s = sharedTask(launch.share);
    showView('home');
    shared = { ...s };
    processText(s.text);
    return;
  }
  const need = { tomorrow: 'plan', summary: 'summary' }[launch.go];
  if (launch.go === 'voice') { showView('home'); openCapture('voice'); return; }
  runPlus(launch.go, need && !can(need) ? FEATURE_MIN[need] : undefined);
}

// ---------- + shortcuts ----------
const PLUS_ICONS = {
  summary: '<path d="M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4z"/><path d="M18 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  tomorrow: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4M10 15h4M12 13v4"/>',
  note: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
  move: '<path d="M4 12h12M12 6l6 6-6 6"/><path d="M20 5v14"/>',
};
function plusItems() {
  const today = todayKey();
  const open = tasks.filter((t) => t.date === today && !t.done).length;
  const items = [
    { id: 'summary', need: 'summary', label: 'Summarize today', sub: can('plan') ? 'See how your day is going' : 'Done and open at a glance' },
    { id: 'tomorrow', need: 'plan', label: 'Plan tomorrow', sub: 'Speak, and it all goes on tomorrow' },
    { id: 'note', label: 'New note', sub: 'Dictate a note instead of a task' },
    { id: 'move', need: 'move', label: 'Move unfinished to tomorrow', sub: open ? `${open} open task${open === 1 ? '' : 's'} today` : 'Nothing open today', off: !open },
  ];
  // Features this model doesn't have sit at the bottom, locked, naming the model that has them.
  for (const it of items) {
    if (it.need && !can(it.need)) Object.assign(it, { locked: FEATURE_MIN[it.need], off: false, sub: `Needs ${modelName(FEATURE_MIN[it.need])}${it.need === 'plan' ? '' : ' or later'}` });
  }
  return [...items.filter((i) => !i.locked), ...items.filter((i) => i.locked)];
}
function closePlusMenus() {
  for (const b of $$('#composer-plus, #quick-plus')) b.setAttribute('aria-expanded', 'false');
  for (const m of $$('.plus-menu')) m.hidden = true;
}
function togglePlusMenu(btn) {
  const menu = btn.parentElement.querySelector('.plus-menu');
  const open = menu.hidden;
  closePlusMenus();
  if (!open) return;
  menu.innerHTML = plusItems().map((it) => `
    <li class="model-opt plus-opt${it.off ? ' off' : ''}${it.locked ? ' locked' : ''}" role="menuitem" tabindex="0" data-plus="${it.id}"${it.locked ? ` data-locked="${it.locked}"` : ''}${it.off ? ' aria-disabled="true"' : ''}>
      <span class="plus-ic"><svg class="i" viewBox="0 0 24 24" aria-hidden="true">${PLUS_ICONS[it.id]}</svg></span>
      <span><b>${esc(it.label)}</b><small>${esc(it.sub)}</small></span>
      ${it.locked ? `<span class="plus-lock" aria-label="Locked"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg></span>` : ''}
    </li>`).join('');
  menu.querySelector('.plus-opt.locked')?.insertAdjacentHTML('beforebegin', `<li class="plus-sep" role="presentation">With ${esc(modelName('blip-2.3'))}</li>`);
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  menu.querySelector('[data-plus]')?.focus();
}
function runPlus(id, locked) {
  closePlusMenus();
  // A locked shortcut moves you up to the model that has it, then runs it.
  if (locked) setModel('blip-2.3');
  const today = todayKey();
  if (id === 'summary') {
    summaryAnytime = true;
    localStorage.setItem(SUMMARY_SEEN_KEY, today);
    if (localStorage.getItem(SUMMARY_HIDE_KEY) === today) localStorage.removeItem(SUMMARY_HIDE_KEY);
    showView('home');
    renderHome();
    buildSummary();
    $('#day-summary').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else if (id === 'tomorrow') {
    openCapture('voice');
    planTomorrow = true;
    const planned = tasks.filter((t) => t.date === addDays(today, 1) && !t.done);
    if (!$('#cap-listen').hidden) $('#cap-listen h2').textContent = 'What’s on for tomorrow?';
    else setCapTitle('Plan tomorrow');
    $('#cap-live').textContent = planned.length
      ? `Already planned: ${planned.slice(0, 3).map((t) => t.text).join(', ')}${planned.length > 3 ? ` and ${planned.length - 3} more` : ''}`
      : 'Nothing planned yet. Say everything for tomorrow.';
  } else if (id === 'note') {
    newNote();
    if (SpeechRec) setTimeout(() => startDictation($('#nf-body'), $('#nf-mic')), 150);
  } else if (id === 'move') {
    const tomorrow = addDays(today, 1);
    let n = 0;
    for (const t of tasks) {
      if (t.date === today && !t.done) { t.date = tomorrow; t.notified = false; t.updatedAt = Date.now(); n++; }
    }
    if (!n) { toast('Nothing open today'); return; }
    save();
    render();
    toast(`Moved ${n} task${n === 1 ? '' : 's'} to tomorrow`);
  }
}
function initPlusMenus() {
  for (const btn of $$('#composer-plus, #quick-plus')) {
    btn.addEventListener('click', (e) => { e.stopPropagation(); togglePlusMenu(btn); });
  }
  for (const menu of $$('.plus-menu')) {
    menu.addEventListener('click', (e) => {
      const li = e.target.closest('[data-plus]');
      if (li && li.getAttribute('aria-disabled') !== 'true') runPlus(li.dataset.plus, li.dataset.locked);
    });
    menu.addEventListener('keydown', (e) => {
      const li = e.target.closest('[data-plus]');
      if (e.key === 'Escape') { closePlusMenus(); return; }
      if ((e.key === 'Enter' || e.key === ' ') && li) { e.preventDefault(); if (li.getAttribute('aria-disabled') !== 'true') runPlus(li.dataset.plus, li.dataset.locked); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = [...menu.querySelectorAll('[data-plus]')];
        const i = items.indexOf(li);
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }
    });
  }
  document.addEventListener('click', (e) => { if (!e.target.closest('.plus-pick')) closePlusMenus(); });
  $('#nf-mic').addEventListener('click', () => startDictation($('#nf-body'), $('#nf-mic')));
}

// ---------- tasks: open, edit, save ----------
function openTask(id) {
  editingId = id;
  ui.backTo = ui.view;
  showView('task');
}

function setDoneState(t) {
  if (!t.done) completeTask(t);
  else t.done = false;
  save();
  render();
}

// ---------- notes: open, create, edit ----------
function openNote(id) {
  editingNote = id;
  ui.backTo = ui.view;
  showView('note');
}

function newNote() {
  const now = Date.now();
  const n = { id: uid(), title: '', body: '', created: now, updated: now };
  notes.push(n);
  saveNotes();
  openNote(n.id);
  setTimeout(() => $('#nf-title').focus(), 50);
}

// ---------- events ----------

// Row and card actions. Each action reads its task or note by the nearest data-id.
document.body.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  if (el.closest('#cap-items')) return; // handled by the review list

  const act = el.dataset.act;
  const id = el.closest('[data-id]')?.dataset.id;
  const t = id ? tasks.find((x) => x.id === id) : null;

  switch (act) {
    case 'toggle':
      if (!t) return;
      setDoneState(t);
      haptic();
      return;
    case 'open':
      if (t) openTask(t.id);
      return;
    case 'delete':
      if (!t) return;
      tasks = tasks.filter((x) => x.id !== t.id);
      save();
      render();
      toast('Task deleted');
      return;
    case 'move':
      if (!t) return;
      t.date = todayKey();
      save();
      render();
      return;
    case 'open-note':
      openNote(el.dataset.noteId);
      return;
    case 'cal-day':
      calSelected = el.dataset.key;
      renderCalendar();
      return;
    default:
      return;
  }
});

// Bottom tabs, sidebar, and avatar.
document.body.addEventListener('click', (e) => {
  const el = e.target.closest('[data-nav]');
  if (!el) return;
  e.preventDefault();
  if (el.dataset.nav === 'home' && ui.view === 'home') return;
  // Integrations is opened from Settings, so its back button returns there.
  if (el.dataset.nav === 'integrations') ui.backTo = 'settings';
  showView(el.dataset.nav);
});

// Back buttons return to where you came from.
for (const b of $$('[data-back]')) {
  b.addEventListener('click', () => showView(ui.backTo || 'tasks'));
}

// Home: the big mic, the floating mic, and the desktop mic all start voice capture.
$('#home-mic').addEventListener('click', () => openCapture('voice'));
$('#quick-mic').addEventListener('click', () => openCapture('voice'));
$('#fab').addEventListener('click', () => openCapture('voice'));

// Tasks: filters, search, more menu.
for (const seg of $$('.seg')) {
  seg.addEventListener('click', () => {
    ui.filter = seg.dataset.filter;
    for (const s of $$('.seg')) s.classList.toggle('on', s === seg);
    renderTasks();
  });
}

$('#search-toggle').addEventListener('click', () => {
  const row = $('#search-row');
  const open = row.hidden;
  row.hidden = !open;
  $('#search-toggle').setAttribute('aria-expanded', String(open));
  if (open) $('#search').focus();
  else {
    $('#search').value = '';
    ui.query = '';
    renderTasks();
  }
});

$('#search').addEventListener('input', (e) => {
  ui.query = e.target.value.trim().toLowerCase();
  renderTasks();
});

$('#more-btn').addEventListener('click', () => {
  const menu = $('#more-menu');
  const open = menu.hidden;
  menu.hidden = !open;
  $('#more-btn').setAttribute('aria-expanded', String(open));
});

$('#more-menu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-menu]');
  if (!b) return;
  closeMenus();
  if (b.dataset.menu === 'clear-done') {
    const n = tasks.filter((t) => t.done).length;
    tasks = tasks.filter((t) => !t.done);
    save();
    render();
    toast(n ? `Cleared ${n} finished task${n === 1 ? '' : 's'}` : 'Nothing finished to clear');
  }
});

// Task detail form.
for (const b of $$('[data-prio]')) {
  b.addEventListener('click', () => setPriority(b.dataset.prio));
}

// Completing from here updates only the toggle, so typed edits stay in the form.
$('#tf-done').addEventListener('click', () => {
  const t = tasks.find((x) => x.id === editingId);
  if (!t) return;
  if (!t.done) completeTask(t);
  else t.done = false;
  save();
  $('#tf-done').setAttribute('aria-pressed', String(t.done));
  $('#tf-done-label').textContent = t.done ? 'Completed · tap to reopen' : 'Mark complete';
});

$('#task-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = tasks.find((x) => x.id === editingId);
  if (!t) return;
  const title = $('#tf-title').value.trim();
  if (!title) {
    toast('Give the task a title');
    return;
  }
  const time = $('#tf-time').value || '';
  const end = $('#tf-end').value || '';
  if (end && (!time || end <= time)) {
    toast(time ? 'End time must be after the start time' : 'Set a start time first');
    return;
  }
  t.text = title;
  t.endTime = end;
  t.date = $('#tf-date').value || todayKey();
  t.time = time;
  t.slot = time ? '' : t.slot;
  t.reminder = $('#tf-reminder').checked && Boolean(time);
  t.repeat = $('#tf-repeat').value;
  t.notes = $('#tf-notes').value;
  t.priority = tfPriority;
  const due = dueAt(t);
  t.notified = due !== null && due <= Date.now();
  save();
  toast('Saved');
  showView(ui.backTo || 'tasks');
});

$('#tf-delete').addEventListener('click', () => {
  tasks = tasks.filter((x) => x.id !== editingId);
  save();
  showView(ui.backTo || 'tasks');
  toast('Task deleted');
});

// Notes.
$('#note-new').addEventListener('click', newNote);

$('#notes-search-toggle').addEventListener('click', () => {
  const row = $('#notes-search-row');
  const open = row.hidden;
  row.hidden = !open;
  $('#notes-search-toggle').setAttribute('aria-expanded', String(open));
  if (open) $('#note-search').focus();
  else {
    $('#note-search').value = '';
    ui.noteQuery = '';
    renderNotes();
  }
});

$('#note-search').addEventListener('input', (e) => {
  ui.noteQuery = e.target.value.trim().toLowerCase();
  renderNotes();
});

$('#nf-title').addEventListener('input', (e) => {
  const n = notes.find((x) => x.id === editingNote);
  if (!n) return;
  n.title = e.target.value;
  n.updated = Date.now();
  saveNotes();
});

$('#nf-body').addEventListener('input', (e) => {
  const n = notes.find((x) => x.id === editingNote);
  if (!n) return;
  n.body = e.target.value;
  n.updated = Date.now();
  saveNotes();
});

$('#nf-delete').addEventListener('click', () => {
  notes = notes.filter((x) => x.id !== editingNote);
  saveNotes();
  showView('notes');
  toast('Note deleted');
});

// Calendar navigation.
function moveMonth(delta) {
  calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + delta, 1);
  const today = new Date();
  const inMonth = today.getFullYear() === calMonth.getFullYear() && today.getMonth() === calMonth.getMonth();
  calSelected = inMonth ? todayKey(today) : keyFrom(calMonth);
  renderCalendar();
}
$('#cal-prev').addEventListener('click', () => moveMonth(-1));
$('#cal-next').addEventListener('click', () => moveMonth(1));

// Settings. The profile card opens profile setup (see the profile section).

$('#save-key').addEventListener('click', () => {
  settings.apiKey = $('#api-key').value.trim();
  saveSettings();
  renderSettings();
  toast(settings.apiKey ? 'API key saved on this device' : 'Offline parsing is on');
});

$('#reset-device').addEventListener('click', async () => {
  if (!confirm('Reset Blip on this device? This signs you out and removes tasks, notes, your name and setup from this device. Anything synced to your account stays there.')) return;
  try { await stopSync(); } catch {}
  try { await disablePush(); } catch {}
  try { if (sb) await sb.auth.signOut(); } catch {}
  wipeDevice();
  localStorage.setItem(RESET_FLAG, '1');
  location.reload();
});

$('#clear-data').addEventListener('click', () => {
  if (!confirm('Delete all tasks on this device?')) return;
  tasks = [];
  save();
  render();
  toast('All tasks deleted');
});

$('#notif-btn').addEventListener('click', askNotifications);
$('#notif-test').addEventListener('click', () => {
  const at = new Date(Date.now() + 10 * 60e3);
  notify({
    id: 'test',
    text: 'Test reminder',
    notes: 'This is how your task notes will show.',
    date: todayKey(at),
    time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
  }, 10);
});

// Catch up as soon as the app comes back to the foreground.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkReminders();
});

// Tapping a notification opens that task.
function openTaskFromNotification(id) {
  if (String(id).startsWith(MORNING_PREFIX)) { openMorning(); return; }
  if (String(id).startsWith('summary-')) { summaryOpen = true; showView('home'); renderHome(); return; }
  if (!tasks.some((x) => x.id === id)) return;
  editingId = id;
  ui.backTo = 'home';
  showView('task');
}
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'open-task') openTaskFromNotification(e.data.taskId);
  if (e.data?.type === 'task-action') runPendingAction(e.data.action, e.data.taskId);
});

// Keep the date and reminders current. Skip re-rendering while typing, and
// on the detail and note screens, where a re-render would wipe unsaved edits.
setInterval(() => {
  checkReminders();
  const typing = document.activeElement && /input|textarea|select/i.test(document.activeElement.tagName);
  const editing = ui.view === 'task' || ui.view === 'note';
  if (!typing && !editing) render();
}, 30_000);

window.addEventListener('load', fitHome);
document.fonts?.ready.then(fitHome);
setTheme(settings.theme);
runSplash();
showView('home');
render();
initAccountAndInstall();
initAuth();
initDevice();
initNews();
initInvite();
checkReminders();
{
  const q = new URLSearchParams(location.search);
  const openId = q.get('task');
  const act = q.get('act');
  if (openId) {
    history.replaceState(null, '', location.pathname);
    if (act === 'done' || act === 'snooze') runPendingAction(act, openId);
    else openTaskFromNotification(openId);
  }
  readLaunch(q);
  // Wait for the splash; runLaunch also runs when onboarding or sign-in closes.
  setTimeout(runLaunch, $('#splash').hidden ? 250 : 1700);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js');
}

markPreview();
