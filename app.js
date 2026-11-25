// Blip: voice or text in, a list for today out.
// Everything lives in localStorage. Parsing uses a local rule-based parser,
// or the Claude API if you add an API key in settings.

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

function setStatus(msg) {
  $('#status').textContent = msg;
}

function syncSend() {
  $('#send').disabled = !$('#input').value.trim();
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

  setStatus('Working…');
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
  setStatus((log.join(' · ') || 'Nothing to add.') + warning);
}

// ---------- voice ----------
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
let listening = false;

function toggleMic() {
  if (!SpeechRec) {
    setStatus('Voice isn’t supported in this browser. Use the keyboard’s dictation button.');
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
    setStatus('Listening… tap the mic again to finish');
  };

  recognizer.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    $('#input').value = (finalText + interim).trim();
    syncSend();
  };

  recognizer.onerror = (e) => setStatus(`Mic error: ${e.error}`);

  recognizer.onend = () => {
    listening = false;
    $('#mic').classList.remove('on');
    const spoken = $('#input').value.trim();
    $('#input').value = '';
    syncSend();
    if (spoken) handleInput(spoken);
  };

  recognizer.start();
}

// ---------- rendering ----------
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

function render() {
  const today = todayKey();

  const todays = tasks
    .filter((t) => t.date === today)
    .sort((a, b) =>
      (a.done - b.done) ||
      ((b.priority === 'high') - (a.priority === 'high')) ||
      (a.created - b.created));

  const carry = tasks.filter((t) => t.date < today && !t.done);

  $('#date').textContent = new Date().toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  const doneCount = todays.filter((t) => t.done).length;
  $('#today-head').textContent = todays.length
    ? `Tasks · ${doneCount} of ${todays.length} done`
    : 'Tasks';

  $('#today').innerHTML = todays.length
    ? todays.map(todayItemHTML).join('')
    : '<li class="empty-row">Nothing yet. Say or type what’s on your day.</li>';

  $('#carry-section').hidden = carry.length === 0;
  $('#carry').innerHTML = carry.map(carryItemHTML).join('');
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
document.body.addEventListener('click', (e) => {
  if (suppressClick) {
    suppressClick = false;
    return;
  }

  const el = e.target.closest('[data-act]');

  // Tapping anywhere else closes open swipe rows.
  document.querySelectorAll('.row.open').forEach((r) => {
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

$('#form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#input').value;
  $('#input').value = '';
  syncSend();
  handleInput(v);
});

$('#input').addEventListener('input', syncSend);
$('#mic').addEventListener('click', toggleMic);

$('#settings').addEventListener('click', () => {
  const key = prompt(
    'Optional: Anthropic API key for smarter parsing. Stored only on this device. Leave blank to use the offline parser.',
    settings.apiKey || '',
  );
  if (key === null) return;
  settings.apiKey = key.trim();
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  setStatus(settings.apiKey ? 'AI parsing is on' : 'Offline parser is on');
});

// Refresh once a minute so the date rolls over at midnight.
// Skip while a task is being edited so the edit isn't wiped.
setInterval(() => {
  if (!document.querySelector('[contenteditable="true"]')) render();
}, 60_000);

render();
syncSend();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js');
}
