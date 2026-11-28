// Blip landing page: theme, scroll reveals, the live hero demo, the sentence parser,
// the scroll story, sort and model switches, and install. No dependencies.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- Theme ----------
  const themeBtn = $('#theme-btn');
  const syncThemeBtn = () => themeBtn.setAttribute('aria-label', root.dataset.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  syncThemeBtn();
  themeBtn.addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('blipLandingTheme', root.dataset.theme);
    syncThemeBtn();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (localStorage.getItem('blipLandingTheme')) return;
    root.dataset.theme = e.matches ? 'dark' : 'light';
    syncThemeBtn();
  });

  // ---------- Nav state ----------
  const nav = $('#nav');
  const onScroll = () => nav.classList.toggle('scrolled', scrollY > 12);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  const navLinks = $$('.nav-links a');
  const sectionSpy = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) {
      for (const a of navLinks) a.classList.toggle('on', a.getAttribute('href') === '#' + e.target.id);
    }
  }, { rootMargin: '-45% 0px -50% 0px' });
  for (const id of ['how', 'day', 'features', 'models']) { const el = document.getElementById(id); if (el) sectionSpy.observe(el); }

  // ---------- Reveal on scroll ----------
  const revealer = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); revealer.unobserve(e.target); }
  }, { threshold: 0.15, rootMargin: '0px 0px -6% 0px' });
  $$('.reveal').forEach((el) => revealer.observe(el));

  // ---------- Hero: pointer glow and phone tilt ----------
  const hero = $('.hero');
  const tilt = $('#hero-phone');
  if (!reduced && matchMedia('(hover: hover)').matches) {
    hero.addEventListener('pointermove', (e) => {
      const r = hero.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      hero.style.setProperty('--mx', x * 100 + '%');
      hero.style.setProperty('--my', y * 100 + '%');
      tilt.style.transform = `rotateY(${(x - 0.5) * 10}deg) rotateX(${(0.5 - y) * 8}deg)`;
    });
    hero.addEventListener('pointerleave', () => { tilt.style.transform = ''; });

    // Magnetic buttons
    for (const b of $$('.magnetic')) {
      b.addEventListener('pointermove', (e) => {
        const r = b.getBoundingClientRect();
        b.style.transform = `translate(${(e.clientX - r.left - r.width / 2) * 0.18}px, ${(e.clientY - r.top - r.height / 2) * 0.3}px)`;
      });
      b.addEventListener('pointerleave', () => { b.style.transform = ''; });
    }
    // Spotlight on feature tiles
    for (const t of $$('.tile')) {
      t.addEventListener('pointermove', (e) => {
        const r = t.getBoundingClientRect();
        t.style.setProperty('--tx', e.clientX - r.left + 'px');
        t.style.setProperty('--ty', e.clientY - r.top + 'px');
      });
    }
  }

  // Today's date in the mock phone
  $('#hero-date').textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  // ---------- Hero: live voice demo ----------
  const heroLines = [
    { said: 'Call mom tomorrow at 6, it\'s urgent', title: 'Call mom', meta: 'Tomorrow · 6:00 PM', tag: ['urgent', 'Urgent'] },
    { said: 'Pay rent on the first, every month', title: 'Pay rent', meta: '1st · Repeats monthly', tag: ['moderate', 'Moderate'] },
    { said: 'Dentist Thursday at 4, no wait, 5', title: 'Dentist', meta: 'Thursday · 5:00 PM', tag: ['bell', 'Reminder'] },
    { said: 'Buy milk, eggs and bread on the way home', title: 'Buy milk, eggs and bread', meta: 'Today · on the way home', tag: ['low', 'Low'] },
  ];
  const list = $('#hero-list'), voice = $('#hero-voice'), said = $('#hero-said'), fab = $('#hero-fab');
  const taskEl = (l) => {
    const d = document.createElement('div');
    d.className = 'task new';
    d.innerHTML = `<span class="chk"></span><div><div class="t-title"></div><div class="t-meta"><span></span><b class="tag ${l.tag[0]}"></b></div></div>`;
    d.querySelector('.t-title').textContent = l.title;
    d.querySelector('.t-meta span').textContent = l.meta;
    d.querySelector('.tag').textContent = l.tag[1];
    return d;
  };
  let heroVisible = true;
  new IntersectionObserver(([e]) => { heroVisible = e.isIntersecting; }).observe(tilt);

  async function typeInto(el, text, speed = 38) {
    el.innerHTML = '';
    const span = document.createElement('span');
    const caret = document.createElement('i'); caret.className = 'caret';
    el.append(span, caret);
    for (let i = 1; i <= text.length; i++) { span.textContent = text.slice(0, i); await sleep(speed + Math.random() * 30); }
    caret.remove();
  }

  async function heroLoop() {
    if (reduced) { list.prepend(taskEl(heroLines[0])); return; }
    await sleep(1200);
    for (let i = 0; ; i = (i + 1) % heroLines.length) {
      while (!heroVisible || document.hidden) await sleep(400);
      const l = heroLines[i];
      fab.classList.add('press'); await sleep(180); fab.classList.remove('press');
      fab.classList.add('listening');
      voice.classList.add('show', 'listening');
      await sleep(350);
      await typeInto(said, l.said);
      await sleep(500);
      voice.classList.remove('listening');
      await sleep(250);
      voice.classList.remove('show');
      fab.classList.remove('listening');
      for (const t of $$('.task.new', list)) t.classList.remove('new');
      list.prepend(taskEl(l));
      while (list.children.length > 4) list.lastElementChild.remove();
      await sleep(2600);
      said.innerHTML = '&nbsp;';
    }
  }
  heroLoop();

  // ---------- Parser ----------
  const parses = [
    { said: 'Call mom tomorrow at 6, it\'s urgent', title: 'Call mom', when: 'Tomorrow, 6:00 PM', priority: ['urgent', 'Urgent'], remind: '10 min before', repeat: null, note: 'Heard “urgent”, so it goes to the top.' },
    { said: 'Pay rent on the 1st every month', title: 'Pay rent', when: '1st of the month', priority: ['moderate', 'Moderate'], remind: 'Morning of', repeat: 'Monthly', note: 'Heard “every month”, so it repeats.' },
    { said: 'Dentist Thursday at <s>4</s>, no wait, 5', title: 'Dentist', when: 'Thursday, 5:00 PM', priority: ['moderate', 'Moderate'], remind: '10 min before', repeat: null, note: 'Changed your mind? Blip keeps the last time you said.' },
    { said: 'Groceries: milk, eggs and bread', title: 'Groceries', when: 'Today', priority: ['low', 'Low'], remind: null, repeat: null, note: 'Lists become bullet points: • Milk • Eggs • Bread' },
  ];
  const parseBox = $('.parse'), parseSaid = $('#parse-said'), parseNote = $('#parse-note');
  const fields = Object.fromEntries($$('.field').map((f) => [f.dataset.k, f]));
  let parseRun = 0;
  async function runParse(i) {
    const run = ++parseRun;
    const p = parses[i];
    for (const f of Object.values(fields)) { f.classList.remove('set', 'empty'); }
    parseNote.classList.remove('show');
    parseBox.classList.add('talking');
    const plain = p.said.replace(/<\/?s>/g, '');
    if (reduced) parseSaid.innerHTML = '“' + p.said + '”';
    else {
      parseSaid.textContent = '';
      for (let c = 1; c <= plain.length; c++) {
        if (run !== parseRun) return;
        parseSaid.textContent = '“' + plain.slice(0, c);
        await sleep(32);
      }
      parseSaid.innerHTML = '“' + p.said + '”';
    }
    parseBox.classList.remove('talking');
    const vals = { title: p.title, when: p.when, priority: p.priority, remind: p.remind, repeat: p.repeat };
    for (const k of Object.keys(fields)) {
      if (!reduced) await sleep(170);
      if (run !== parseRun) return;
      const v = fields[k].querySelector('.f-v');
      const val = vals[k];
      if (k === 'priority') v.innerHTML = `<b class="tag ${val[0]}">${val[1]}</b>`;
      else v.textContent = val || (k === 'repeat' ? 'Once' : 'None');
      fields[k].classList.add(val ? 'set' : 'empty');
    }
    parseNote.textContent = p.note;
    parseNote.classList.add('show');
  }
  const chips = $$('.chip');
  let parseIdx = 0, parseTimer = null, parseStarted = false;
  const selectChip = (i, user) => {
    parseIdx = i;
    chips.forEach((c, j) => { c.classList.toggle('on', i === j); c.setAttribute('aria-selected', i === j); });
    runParse(i);
    clearInterval(parseTimer);
    if (!user && !reduced) parseTimer = setInterval(() => selectChip((parseIdx + 1) % parses.length, false), 6000);
  };
  chips.forEach((c) => c.addEventListener('click', () => selectChip(+c.dataset.i, true)));
  new IntersectionObserver(([e]) => {
    if (e.isIntersecting && !parseStarted) { parseStarted = true; selectChip(0, false); }
  }, { threshold: 0.4 }).observe(parseBox);

  // ---------- Story ----------
  const storyPhone = $('#story-phone');
  const screens = $$('.screen', storyPhone);
  const bars = $$('.story-progress i');
  const clock = $('.sp-clock', storyPhone);
  const times = ['8:00', '10:50', '2:15', '7:00'];
  const steps = $$('.step');
  const setStep = (n) => {
    storyPhone.dataset.active = n;
    screens.forEach((s, i) => s.classList.toggle('on', i === n));
    bars.forEach((b, i) => b.classList.toggle('on', i === n));
    steps.forEach((s, i) => s.classList.toggle('active', i === n));
    clock.textContent = times[n];
  };
  setStep(0);
  const storyIO = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) setStep(+e.target.dataset.step);
  }, { rootMargin: '-48% 0px -48% 0px' });
  steps.forEach((s) => storyIO.observe(s));

  // Small screens: each step gets its own phone with its screen.
  steps.forEach((step, i) => {
    const holder = $('.step-visual', step);
    const ph = document.createElement('div');
    ph.className = 'phone';
    ph.innerHTML = `<div class="phone-screen"><div class="ps-status"><span>${times[i]}</span><span class="ps-icons"><i></i><i></i><i></i></span></div></div>`;
    const sc = screens[i].cloneNode(true);
    sc.classList.add('on');
    ph.firstElementChild.append(sc);
    const tabs = document.createElement('div'); tabs.className = 'ps-tabs'; tabs.setAttribute('aria-hidden', 'true');
    tabs.innerHTML = '<i class="on"></i><i></i><i></i><i></i>';
    if (i !== 1) ph.firstElementChild.append(tabs);
    else ph.querySelector('.ps-status').style.cssText = 'position:relative;z-index:2;color:#fff';
    ph.setAttribute('aria-hidden', 'true');
    holder.append(ph);
    // Restart the clone's animations when it scrolls into view
    sc.classList.remove('on');
    new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { holder.classList.add('in'); sc.classList.add('on'); }
    }, { threshold: 0.35 }).observe(holder);
  });

  // ---------- Sort demo ----------
  const sortModes = [['p', 'Priority'], ['t', 'Time'], ['n', 'Newest'], ['a', 'A–Z']];
  let sortI = 0;
  const sortItems = $$('#sort-list li');
  const sortLabel = $('#sort-label');
  const applySort = () => {
    const [k, label] = sortModes[sortI];
    sortLabel.textContent = label;
    for (const li of sortItems) li.style.top = (+li.dataset[k] - 1) * 55 + 'px';
  };
  applySort();
  const sortTile = $('.t-sort');
  const nextSort = () => { sortI = (sortI + 1) % sortModes.length; applySort(); };
  sortTile.addEventListener('click', nextSort);
  sortTile.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nextSort(); } });
  if (!reduced) {
    let sortTimer = null;
    new IntersectionObserver(([e]) => {
      clearInterval(sortTimer);
      if (e.isIntersecting) sortTimer = setInterval(nextSort, 2400);
    }).observe(sortTile);
  }

  // ---------- Models ----------
  const tiers = [
    { name: 'Blip 1.0', desc: 'The basics, done well. To-dos, reminders and notes.' },
    { name: 'Blip 2.0', desc: 'Adds a short morning plan, day summary and bullet lists.' },
    { name: 'Blip 2.3', desc: 'Everything Blip can do. Your full morning plan and evening summary.' },
  ];
  const tierCard = $('#tier-card'), tierSwitch = $('.tier-switch');
  const tierBtns = $$('.tier-switch button');
  const setTier = (t) => {
    tierSwitch.style.setProperty('--t', t);
    tierBtns.forEach((b, i) => { b.classList.toggle('on', i === t); b.setAttribute('aria-selected', i === t); });
    tierCard.dataset.tier = t;
    $('#tier-name').textContent = tiers[t].name;
    $('#tier-desc').textContent = tiers[t].desc;
    $$('.tier-list li').forEach((li) => li.classList.toggle('off', +li.dataset.min > t));
  };
  tierBtns.forEach((b) => b.addEventListener('click', () => setTier(+b.dataset.tier)));
  setTier(2);

  // ---------- App links ----------
  for (const a of $$('a[data-app]')) a.href = window.BLIP_APP_URL + '/';
})();
