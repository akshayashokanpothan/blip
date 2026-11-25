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
      </div>
      <button class="swipe-del" data-act="delete">Delete</button>
    </li>`;
}

function carryItemHTML(t) {
  return `
    <li class="swipe" data-id="${t.id}">
      <div class="row">
        <span class="text">${esc(t.text)}</span>
        <button class="move" data-act="move">Move to today</button>
      </div>
      <button class="swipe-del" data-act="delete">Delete</button>
    </li>`;
}

// Search and filter state for the Home view.
const ui = { view: 'home', filter: 'all', query: '' };

const matchesQuery = (t) => !ui.query || t.text.toLowerCase().includes(ui.query);

function renderHome() {
  const today = todayKey();

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

// ---------- themes ----------
const THEMES = ['green', 'classic', 'modern', 'claude'];

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
  for (const t of $$('.tab')) t.classList.toggle('on', t.dataset.tab === name);
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
  $('#scrim').classList.remove('show');
  $('#input').blur();
}

// ---------- swipe to delete ----------
let swipe = null;
let suppressClick = false;

document.addEventListener('pointerdown', (e) => {
  suppressClick = false;
  const row = e.target.closest('.row');
  if (!row || e.target.closest('.circle, .move, [contenteditable="true"]')) return;
  swipe = { row, x: e.clientX, dx: 0, moved: false };
});

document.addEventListener('pointermove', (e) => {
  if (!swipe) return;
  const delta = e.clientX - swipe.x;
  if (!swipe.moved && Math.abs(delta) < 8) return;
  swipe.moved = true;
  swipe.row.classList.add('dragging');
  const base = swipe.row.classList.contains('open') ? -96 : 0;
  swipe.dx = Math.max(-96, Math.min(0, base + delta));
  swipe.row.style.transform = `translateX(${swipe.dx}px)`;
});

function endSwipe() {
  if (!swipe) return;
  const { row, moved, dx } = swipe;
  swipe = null;
  row.classList.remove('dragging');
  row.style.transform = '';
  if (moved) {
    suppressClick = true;
    row.classList.toggle('open', dx < -48);
  }
}
document.addEventListener('pointerup', endSwipe);
document.addEventListener('pointercancel', endSwipe);

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
  if (suppressClick) {
    suppressClick = false;
    return;
  }

  const el = e.target.closest('[data-act]');

  // Tapping anywhere else closes open swipe rows.
  $$('.row.open').forEach((r) => {
    if (!el || el.closest('.swipe') !== r.closest('.swipe')) r.classList.remove('open');
  });

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
for (const tab of $$('.tab')) {
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

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js');
}
