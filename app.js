// Blip: say it, get it done.
// Tasks and notes live in localStorage. Parsing uses a local rule-based parser,
// or the Claude API if you add an API key in Settings. Voice uses the browser's
// speech recognition. Nothing is sent anywhere unless you add a key.

const TASKS_KEY = 'blip.tasks.v1';
const NOTES_KEY = 'blip.notes.v1';
const SETTINGS_KEY = 'blip.settings.v1';
const PROFILE_KEY = 'blip.profile.v1';
const INSTALL_DISMISS_KEY = 'blip.installDismissed.v1';
const SPLASH_KEY = 'blip.splashShown';
const MODEL = 'claude-haiku-5-5';
// Only one theme for now. More are coming later.
const THEME = 'default';

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
    priority: 'normal',
    done: false,
    ...t,
  };
}

let tasks = loadJSON(TASKS_KEY, []).map(normalizeTask);
let notes = loadJSON(NOTES_KEY, []);
const settings = loadJSON(SETTINGS_KEY, {});
settings.theme = THEME; // every older theme choice maps to the one theme

function save() { localStorage.setItem(TASKS_KEY, JSON.stringify(tasks)); }
function saveNotes() { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)); }
function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }

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
  if (t.time) parts.push(fmtTime(t.time));
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
const FILLER = /^(ok(ay)?|so|hey|um+|uh+|please|i\s+(need|have|want|should|got|must)\s+to|i'?m\s+gonna|gonna|remind\s+me\s+to|add|todo|to\s+do)\s+/i;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function splitItems(text) {
  return text
    .split(/\n|;|,|\b(?:and\s+)?also\b|\b(?:and\s+)?then\b|\bafter that\b/i)
    .map((s) => s.trim())
    .filter(Boolean);
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

  const tm = text.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/i)
    || text.match(/\bat\s+(\d{1,2})(?::(\d{2}))?()\b/i);
  if (tm) {
    let h = Number(tm[1]);
    const min = Number(tm[2] || 0);
    const mer = (tm[3] || '').toLowerCase().replace(/\./g, '');
    if (h <= 12 && min < 60) {
      if (mer.startsWith('p') && h < 12) h += 12;
      else if (mer.startsWith('a') && h === 12) h = 0;
      else if (!mer && h >= 1 && h <= 6) h += 12; // "at 6" means 6 pm
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

  return { text, date, time, slot: time ? '' : slot };
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
    const withoutPriority = s.replace(/\b(urgent|asap|important)\b/gi, ' ');
    const when = extractWhen(withoutPriority);
    let text = when.text.replace(/\s+/g, ' ').replace(/^\s*(on|by|at|in)\s+/i, '').trim();
    for (let i = 0; i < 2; i++) text = text.replace(FILLER, '');
    text = text.replace(/^./, (c) => c.toUpperCase()).trim();
    if (text) {
      actions.push({
        type: 'add',
        text,
        priority,
        date: when.date || todayKey(),
        time: when.time,
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
    'Return ONLY a JSON object: {"actions":[...]}.',
    'Action types:',
    '{"type":"add","text":"short task, under 10 words","priority":"normal"|"high","date":"YYYY-MM-DD or null","time":"HH:MM 24-hour or null","slot":"morning"|"afternoon"|"evening"|null}',
    '{"type":"done","match":"words identifying an existing task"}',
    '{"type":"delete","match":"words identifying an existing task"}',
    '{"type":"rename","match":"existing task","text":"new text"}',
    'Split separate tasks into separate add actions. Fix obvious speech-recognition errors. Mark urgent or important items as high priority.',
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
    priority: p.priority === 'high' ? 'high' : 'normal',
    done: false,
    date,
    time,
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
  captureOpen = false;
  if (recognizer && listening) {
    try { recognizer.abort(); } catch { /* already stopped */ }
  }
  listening = false;
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

function startListening() {
  setCapTitle('Voice');
  showCapPanel('listen');
  buildWave();
  $('#cap-live').textContent = '';
  let finalText = '';
  let latest = '';
  let handled = false;

  recognizer = new SpeechRec();
  recognizer.lang = 'en-IN';
  recognizer.interimResults = true;
  recognizer.continuous = false;

  recognizer.onstart = () => {
    listening = true;
    haptic();
  };

  recognizer.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    latest = (finalText + interim).trim();
    $('#cap-live').textContent = latest;
  };

  recognizer.onerror = (e) => {
    if (e.error === 'not-allowed') toast('Allow microphone access in your browser settings.');
    else if (e.error !== 'no-speech' && e.error !== 'aborted') toast(`Mic error: ${e.error}`);
  };

  recognizer.onend = () => {
    listening = false;
    if (!captureOpen || handled) return;
    handled = true;
    if (latest) processText(latest);
    else {
      toast('I didn’t catch that. Try again or type it.');
      openTextPanel();
    }
  };

  $('#cap-stop').onclick = () => {
    if (recognizer && listening) recognizer.stop();
  };

  try {
    recognizer.start();
  } catch {
    openTextPanel();
    toast('Couldn’t start the mic. Type instead.');
  }
}

// Turns what was said or typed into tasks, then shows them for review.
async function processText(text) {
  text = text.trim();
  if (!text) return;
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
  cap.items = adds.map((a) => ({
    id: uid(),
    text: a.text,
    priority: a.priority === 'high' ? 'high' : 'normal',
    date: a.date || todayKey(),
    time: a.time || '',
    slot: a.time ? '' : (a.slot || ''),
  }));
  setCapTitle('Review');
  renderConfirm();
  showCapPanel('confirm');
  if (warning) toast(warning.trim());
}

const SLOT_OPTIONS = [['', 'Any time'], ['morning', 'Morning'], ['afternoon', 'Afternoon'], ['evening', 'Evening']];

function renderConfirm() {
  $('#cap-transcript').textContent = `“${cap.transcript}”`;
  $('#cap-items').innerHTML = cap.items.map((it, i) => `
    <li class="cap-item" data-idx="${i}">
      <div class="cap-row">
        <input type="text" data-f="text" value="${esc(it.text)}" aria-label="Task ${i + 1} title">
        <button class="icon-btn" type="button" data-act="edit-cap" aria-label="Edit task ${i + 1}" style="width:36px;height:36px">${ICON.pencil}</button>
      </div>
      <div class="cap-fields">
        <label>Date<input type="date" data-f="date" value="${esc(it.date)}"></label>
        <label>Time<input type="time" data-f="time" value="${esc(it.time)}"></label>
        <label>Part of day<select data-f="slot">${SLOT_OPTIONS.map(([v, l]) =>
          `<option value="${v}"${it.slot === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      <div class="cap-meta">
        <button class="chip${it.priority === 'high' ? ' on' : ''}" type="button" data-act="priority-cap">${it.priority === 'high' ? 'Urgent' : 'Mark urgent'}</button>
      </div>
    </li>`).join('');
}

// Review screen edits update the data in place, so typing never loses focus.
$('#cap-items').addEventListener('input', (e) => {
  const li = e.target.closest('[data-idx]');
  const field = e.target.dataset.f;
  if (!li || !field) return;
  cap.items[Number(li.dataset.idx)][field] = e.target.value;
});
$('#cap-items').addEventListener('change', (e) => {
  const li = e.target.closest('[data-idx]');
  const field = e.target.dataset.f;
  if (!li || !field) return;
  const it = cap.items[Number(li.dataset.idx)];
  it[field] = e.target.value;
  if (field === 'time' && e.target.value) it.slot = '';
  if (field === 'slot' && e.target.value) it.time = '';
  if (field === 'time' || field === 'slot') renderConfirm();
});
$('#cap-items').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const li = btn.closest('[data-idx]');
  const it = cap.items[Number(li.dataset.idx)];
  if (btn.dataset.act === 'edit-cap') {
    li.querySelector('input[data-f="text"]').focus();
  } else if (btn.dataset.act === 'priority-cap') {
    it.priority = it.priority === 'high' ? 'normal' : 'high';
    renderConfirm();
  }
});

$('#cap-add').addEventListener('click', () => {
  const items = cap.items.filter((i) => i.text.trim());
  if (!items.length && !cap.other.length) {
    toast('Nothing to add yet.');
    return;
  }
  for (const it of items) {
    tasks.push(makeTask({
      text: it.text.trim(),
      priority: it.priority,
      date: it.date || todayKey(),
      time: it.time,
      slot: it.slot,
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
  // Detach the handler first, so aborting doesn't send half-heard words on.
  if (recognizer && listening) {
    recognizer.onend = null;
    recognizer.abort();
  }
  listening = false;
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
  ((b.priority === 'high') - (a.priority === 'high')) ||
  (timeKey(a).localeCompare(timeKey(b))) ||
  (a.created - b.created);

function taskHTML(t, { carry = false } = {}) {
  const bell = t.reminder && t.time ? `<span title="Reminder on" aria-label="Reminder on">${ICON.bell}</span>` : '';
  const high = t.priority === 'high' ? '<span class="tag-high">High</span>' : '';
  const repeat = t.repeat && t.repeat !== 'none' ? '<span>· Repeats</span>' : '';
  return `
    <li class="task${t.done ? ' done' : ''}" data-id="${t.id}">
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
let tfPriority = 'normal';
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
  $('#greeting').textContent = `${greeting()} · ${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}`;
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
  $('#tf-reminder').checked = Boolean(t.reminder && t.time);
  $('#tf-repeat').value = t.repeat || 'none';
  $('#tf-notes').value = t.notes || '';
  setPriority(t.priority);
}

function setPriority(p) {
  tfPriority = p === 'high' ? 'high' : 'normal';
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
  renderNotifButton();
}

function renderNotifButton() {
  const btn = $('#notif-btn');
  const hint = $('#notif-hint');
  if (!('Notification' in window)) {
    btn.disabled = true;
    btn.textContent = 'Unavailable';
    hint.textContent = 'This browser can’t show notifications.';
  } else if (Notification.permission === 'granted') {
    btn.disabled = true;
    btn.textContent = 'On';
    hint.textContent = 'Reminders show while Blip is open.';
  } else if (Notification.permission === 'denied') {
    btn.disabled = true;
    btn.textContent = 'Blocked';
    hint.textContent = 'Allow notifications in your browser settings.';
  } else {
    btn.disabled = false;
    btn.textContent = 'Allow';
    hint.textContent = 'Reminders show while Blip is open.';
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
// Reminders fire while Blip is open. Closed-app notifications need a server.
function notify(t) {
  const body = `${t.text} · ${whenText(t)}`;
  toast(`Reminder: ${t.text}`);
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = { body, icon: 'icons/app-icon-192.png', tag: t.id };
  if (navigator.serviceWorker?.ready) {
    navigator.serviceWorker.ready
      .then((reg) => reg.showNotification('Blip', opts))
      .catch(() => new Notification('Blip', opts));
  } else {
    new Notification('Blip', opts);
  }
}

function checkReminders() {
  const now = Date.now();
  let changed = false;
  for (const t of tasks) {
    if (!t.reminder || t.done || t.notified) continue;
    const due = dueAt(t);
    if (due === null || now < due) continue;
    t.notified = true;
    changed = true;
    // Only remind for things due in the last six hours; older ones are stale.
    if (now - due < 6 * 3600e3) notify(t);
  }
  if (changed) save();
}

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
  const photo = profile?.avatar ? `<img src="${esc(profile.avatar)}" alt="">` : PERSON_ICON;
  const initial = (profile?.name || '').trim().charAt(0).toUpperCase();
  $('#avatar').innerHTML = photo;
  $('#settings-avatar').innerHTML = profile?.avatar ? photo : (initial || PERSON_ICON);
  $('#settings-name').textContent = profile?.name || 'Blip';
  $('#settings-sub').textContent = profile?.email || 'Say it. Get it done.';
  $('#account-line').textContent = !profile
    ? 'Not signed in.'
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

// Onboarding has three steps: welcome, permissions, sign-in.
function showOnboardStep(step) {
  $('#onboarding').hidden = false;
  $('#ob-welcome').hidden = step !== 'welcome';
  $('#ob-perms').hidden = step !== 'perms';
  $('#ob-auth').hidden = step !== 'auth';
  if (step === 'perms') renderPerms();
}

function showOnboarding(step = 'welcome') {
  showOnboardStep(step);
}

function finishOnboarding() {
  if ($('#onboarding').hidden) return;
  $('#onboarding').hidden = true;
  renderProfile();
  setTimeout(maybeShowInstall, 700);
}

async function permState(name) {
  try {
    const r = await navigator.permissions.query({ name });
    return r.state;
  } catch {
    return 'unknown';
  }
}

function setPermRow(id, state, label) {
  const row = $(`#${id}`);
  const btn = row.querySelector('[data-perm]');
  row.classList.toggle('ok', state === 'granted');
  if (btn) {
    btn.hidden = state === 'granted';
  }
  let st = row.querySelector('.perm-state');
  if (!st) {
    st = document.createElement('span');
    st.className = 'perm-state';
    row.append(st);
  }
  if (state === 'granted') {
    st.textContent = 'Allowed';
    row.querySelector('.check-ic')?.remove();
  } else {
    st.textContent = label;
  }
}

async function renderPerms() {
  const mic = await permState('microphone');
  setPermRow('perm-mic', mic, mic === 'denied' ? 'Blocked in browser settings' : 'Not allowed yet');
  const notif = 'Notification' in window ? Notification.permission : 'unsupported';
  setPermRow('perm-notif', notif === 'granted' ? 'granted' : 'prompt',
    notif === 'denied' ? 'Blocked in browser settings' : notif === 'unsupported' ? 'Not supported here' : 'Not allowed yet');
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
  toast(outcome === 'accepted' ? 'Installing Blip…' : 'You can install Blip anytime from Settings.');
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

  // Onboarding
  $('#ob-start').addEventListener('click', () => showOnboardStep('perms'));
  $('#ob-skip').addEventListener('click', () => showOnboardStep('auth'));
  $('#perm-continue').addEventListener('click', () => showOnboardStep('auth'));
  for (const b of $$('[data-perm]')) {
    b.addEventListener('click', () => {
      if (b.dataset.perm === 'mic') askMic();
      else askNotifications();
    });
  }

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
      showOnboarding('auth');
      return;
    }
    if (sb) await sb.auth.signOut();
    setProfile(null);
    showOnboarding('auth');
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
  if (!profile) showOnboarding('welcome');
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

  // Desktop shortcuts. They never fire while typing.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#capture').hidden) closeCapture();
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
      showView('tasks');
      openSearch('#search-row', '#search');
    }
  });
}

// ---------- themes ----------
function setTheme() {
  root.dataset.theme = THEME;
  if (settings.theme !== THEME) {
    settings.theme = THEME;
    saveSettings();
  }
}

// ---------- views ----------
// Which tab is highlighted for each view.
const VIEW_TAB = {
  home: 'home', tasks: 'tasks', task: 'tasks',
  notes: 'notes', note: 'notes',
  calendar: 'calendar',
  integrations: 'integrations', settings: 'settings',
};

function showView(name) {
  ui.view = name;
  root.dataset.view = name;
  for (const v of $$('.view')) v.hidden = v.id !== `view-${name}`;
  const tab = VIEW_TAB[name];
  for (const t of $$('[data-nav]')) {
    t.classList.toggle('on', t.dataset.nav === tab);
  }
  if (name !== 'home') closeMenus();
  renderView(name);
  window.scrollTo({ top: 0 });
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
  t.text = title;
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

// Settings.
$('#profile-card').addEventListener('click', () => {
  if (!profile || profile.mode === 'guest') showOnboarding('auth');
  else toast(`Signed in as ${profile.email || profile.name}`);
});

$('#save-key').addEventListener('click', () => {
  settings.apiKey = $('#api-key').value.trim();
  saveSettings();
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

$('#notif-btn').addEventListener('click', askNotifications);

// Keep the date and reminders current. Skip re-rendering while typing, and
// on the detail and note screens, where a re-render would wipe unsaved edits.
setInterval(() => {
  checkReminders();
  const typing = document.activeElement && /input|textarea|select/i.test(document.activeElement.tagName);
  const editing = ui.view === 'task' || ui.view === 'note';
  if (!typing && !editing) render();
}, 30_000);

setTheme();
runSplash();
showView('home');
render();
initAccountAndInstall();
initAuth();
initDevice();
checkReminders();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js');
}
