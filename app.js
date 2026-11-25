// Blip: say it, get it done.
// Tasks and notes live in localStorage. Parsing uses a local rule-based parser,
// or the Claude API if you add an API key in Settings. Voice uses the browser's
// speech recognition. Nothing is sent anywhere unless you add a key.
// v2: when you sign in (Supabase keys in config.js), sync.js also keeps tasks,
// notes and profile settings in step across your devices.

const APP_VERSION = '2.0.0';

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
const FILLER = /^(ok(ay)?|so|hey|um+|uh+|please|i\s+(need|have|want|should|got|must)\s+to|i'?m\s+gonna|gonna|remind\s+me(\s+to)?|(create|creative|set\s+up|set|add|make)\s+(a\s+|an\s+)?(new\s+)?(reminder|task|to-?do)(\s+(to|for|that))?|add|todo|to\s+do)\s+/i;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// Words that say when something happens. Used to tell "buy apples at 6 and
// medicines at 9" (two tasks) from "call mom and dad at 6" (one task).
const WHEN_CUE = /\b(\d{1,2}(:\d{2})?\s*(a\.?m\.?|p\.?m\.?|o\s*['’]?\s*clock)|\d{1,2}:\d{2}|(at|by)\s+\d{1,2}|(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+o\s*['’]?\s*clock|today|tonight|tomorrow|morning|afternoon|evening|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i;

function splitItems(text) {
  const parts = text
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
    date = addDays(base, 2);
    text = text.replace(/\bday after tomorrow\b/gi, ' ');
  } else if (/\btomorrow\b/i.test(text)) {
    date = addDays(base, 1);
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
  const dayPart = (text.match(/\b(morning|afternoon|evening|night|tonight)\b/i) || [])[1]?.toLowerCase() || '';
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

    const HIGH = /\b(urgent|urgently|asap|important|high priority)\b/gi;
    const LOW = /\b(low priority|no rush|whenever|not urgent|sometime)\b/gi;
    const priority = HIGH.test(s) ? 'high' : LOW.test(s) ? 'low' : 'medium';
    const withoutPriority = s.replace(HIGH, ' ').replace(LOW, ' ');
    const when = extractWhen(withoutPriority);
    let text = when.text.replace(/\s+/g, ' ').replace(/^\s*(on|by|at|in)\s+/i, '')
      .replace(/\s+(on|by|at|in|for)\s*$/i, '').trim();
    for (let i = 0; i < 2; i++) text = text.replace(FILLER, '');
    text = text.replace(/^./, (c) => c.toUpperCase()).trim();
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
async function processText(text) {
  text = text.trim();
  if (!text || processing) return;
  processing = true;
  try {
    await runProcess(text);
  } finally {
    processing = false;
  }
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
  try {
    actions = settings.apiKey ? await parseWithLLM(text, settings.apiKey) : parseLocal(text);
  } catch (err) {
    warning = ` (AI parse failed: ${err.message}; used the offline parser)`;
    actions = parseLocal(text);
  }
  await wait(Math.max(0, 600 - (Date.now() - started)));
  if (!captureOpen) return;

  const adds = actions.filter((a) => a.type === 'add' && a.text);
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
  }));
  cap.editing = false;
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
  const d = { ta, btn, carried: '', heard: '', timer: null, rec: null };
  dictation = d;
  btn.classList.toggle('on', true);
  btn.setAttribute('aria-pressed', 'true');

  const write = () => {
    const spoken = [d.carried, d.heard].filter(Boolean).join(' ');
    const text = spoken ? spoken.charAt(0).toUpperCase() + spoken.slice(1) : '';
    const sep = base && text ? (/[.!?]$/.test(base) ? ' ' : '. ') : '';
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
  $('#api-key').value = settings.apiKey || '';
  $('#mode-hint').textContent = settings.apiKey
    ? 'AI parsing is on. Claude Haiku reads what you say or type.'
    : 'Offline parsing is on. Add a key for smarter parsing.';
  markTheme();
  renderNotifButton();
}

function renderNotifButton() {
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
    hint.textContent = 'You get a notification 10 minutes before each timed task.';
    $('#notif-test-row').hidden = false;
  } else if (Notification.permission === 'denied') {
    btn.disabled = true;
    btn.textContent = 'Blocked';
    hint.textContent = 'Allow notifications in your browser settings.';
  } else {
    btn.disabled = false;
    btn.textContent = 'Allow';
    hint.textContent = 'Allow this to get a notification 10 minutes before each timed task.';
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
// Each timed task with its reminder on gets a notification 10 minutes before
// its time. Timers run while Blip is open or in the background; a phone that
// has fully closed the app needs a push server to wake it.
const REMIND_BEFORE_MS = 10 * 60 * 1000;
// Reminders more than this late (the app was closed) are skipped as stale.
const REMIND_GRACE_MS = 30 * 60 * 1000;
let reminderTimer = null;

const remindAt = (t) => {
  const due = dueAt(t);
  return due === null ? null : due - REMIND_BEFORE_MS;
};

function reminderBody(t, now = Date.now()) {
  const due = dueAt(t);
  const mins = Math.round((due - now) / 60000);
  const day = t.date === todayKey() ? 'Today' : dateLabel(t.date);
  const when = `${day} at ${fmtTime(t.time)}`;
  if (mins <= 0) return `${when} · now`;
  return `${when} · in ${mins} min`;
}

function notify(t) {
  const body = reminderBody(t);
  toast(`${t.text} · ${fmtTime(t.time)}`);
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = {
    body,
    icon: 'icons/app-icon-192.png',
    badge: 'icons/app-icon-192.png',
    tag: `blip-${t.id}`,
    renotify: true,
    requireInteraction: true,
    vibrate: [200, 100, 200],
    timestamp: dueAt(t),
    data: { taskId: t.id },
  };
  const fallback = () => { try { new Notification(t.text, opts); } catch { /* page-level notifications unsupported */ } };
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready
      .then((reg) => reg.showNotification(t.text, opts))
      .catch(fallback);
  } else {
    fallback();
  }
}

function checkReminders() {
  const now = Date.now();
  let changed = false;
  for (const t of tasks) {
    if (!t.reminder || t.done || t.notified) continue;
    const at = remindAt(t);
    if (at === null || now < at) continue;
    t.notified = true;
    changed = true;
    if (now - dueAt(t) < REMIND_GRACE_MS) notify(t);
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
    if (!t.reminder || t.done || t.notified) continue;
    const at = remindAt(t);
    if (at !== null && at < next) next = at;
  }
  if (next === Infinity) return;
  // Browsers cap timers near 24.8 days; re-arm at most daily.
  const delay = Math.min(Math.max(next - Date.now(), 0), 24 * 3600e3);
  reminderTimer = setTimeout(checkReminders, delay);
}

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
  const meta = u.user_metadata || {};
  setProfile({
    mode: u.app_metadata?.provider === 'google' ? 'google' : 'email',
    email: u.email || '',
    name: meta.full_name || meta.name || '',
    avatar: meta.avatar_url || null,
    hasPassword: Boolean(meta.has_password),
  });
  // An avatar picked on another device comes with the account.
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
  if (justFinished && wasOpen) {
    showView('home');
    const first = displayName().split(/\s+/)[0];
    toast(first ? `You’re all set, ${first}.` : 'You’re all set.');
    // First time on this device: play the product tour once. It can be closed.
    if (!onboard.tour) setTimeout(openTour, 500);
  }
}

// ---------- product tour ----------
// Phones get the portrait video, larger screens the landscape one.
const tourSrc = () => (mqDesktopTour.matches ? 'tour/blip-tour-desktop.mp4' : 'tour/blip-tour-phone.mp4');
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

  $('#signout').addEventListener('click', async () => {
    if (!profile || profile.mode === 'guest') {
      setProfile(null);
      showOnboarding();
      return;
    }
    await stopSync();
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

async function initAuth() {
  if (CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase) {
    sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
    const { data } = await sb.auth.getSession();
    if (data.session) await fromSession(data.session);
    sb.auth.onAuthStateChange((event, session) => {
      if (session) fromSession(session);
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

function syncStatusText(status, last) {
  if (status === 'syncing') return 'Syncing…';
  if (status === 'offline') return 'Offline. Changes will sync when you’re back online.';
  if (status === 'error') return 'Couldn’t sync. Blip will try again shortly.';
  if (status === 'synced') {
    const mins = Math.round((Date.now() - last) / 60000);
    return mins < 1 ? 'Synced just now' : `Synced ${mins} min ago`;
  }
  return '';
}

function renderSyncLine(status, last) {
  const el = $('#sync-line');
  if (!el) return;
  const text = syncStatusText(status, last);
  el.textContent = text;
  el.hidden = !text;
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
          const at = remindAt(t);
          return at !== null && at <= Date.now();
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
  }
  return blipSync.start(userId);
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
  $('#composer-plus').addEventListener('click', () => composerInput.focus());
  $('#composer-pill').addEventListener('click', () => composerInput.focus());
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
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', name === 'dark' ? '#262624' : '#1B3B2B');
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
}

for (const b of $$('[data-theme-pick]')) {
  b.addEventListener('click', () => {
    setTheme(b.dataset.themePick);
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
  $('#scrim').classList.remove('show');
  closeMenus();
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
  const at = new Date(Date.now() + REMIND_BEFORE_MS);
  notify({
    id: 'test',
    text: 'Test reminder',
    date: todayKey(at),
    time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
  });
});

// Catch up as soon as the app comes back to the foreground.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkReminders();
});

// Tapping a notification opens that task.
function openTaskFromNotification(id) {
  if (!tasks.some((x) => x.id === id)) return;
  editingId = id;
  ui.backTo = 'home';
  showView('task');
}
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'open-task') openTaskFromNotification(e.data.taskId);
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
checkReminders();
{
  const openId = new URLSearchParams(location.search).get('task');
  if (openId) {
    history.replaceState(null, '', location.pathname);
    openTaskFromNotification(openId);
  }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js');
}

markPreview();
