// Blip: the evening "Your day, summarized" card and notification.
// Pure functions only; app.js decides when to show it.
(function (root) {
  const DEFAULT_TIME = '19:00';

  // A line to end the day on, picked by how the day went. Same day, same line.
  const LINES = {
    all: [
      'Every task done. Enjoy your evening, you earned it.',
      'A clean sweep today. That’s how it’s done.',
      'Nothing left on the list. Rest well.',
    ],
    most: [
      'Most of the list is done. Strong work today.',
      'Solid progress. Tomorrow picks up the rest.',
      'You got the important things moving. Well done.',
    ],
    some: [
      'Every step counts. Tomorrow’s another go.',
      'You made progress today. Keep the momentum.',
      'Some done, some to go. That’s a normal, good day.',
    ],
    none: [
      'Not every day is a ticking-off day. Tomorrow’s a fresh start.',
      'Tough day? Pick one small thing for tomorrow morning.',
      'Rest tonight. The list will still be here, and so will you.',
    ],
    empty: [
      'Plan tomorrow in a few words before you sleep.',
      'Nothing on the list today. Say what tomorrow needs.',
    ],
  };

  const pick = (list, seed) => list[[...seed].reduce((n, c) => n + c.charCodeAt(0), 0) % list.length];

  // tasks: Blip tasks; today/tomorrow: YYYY-MM-DD keys; name: first name or ''.
  // lite (Blip 2.0): the facts only, without the personal line or a look at tomorrow.
  function daySummary(tasks, today, tomorrow, name = '', { lite = false } = {}) {
    const todays = tasks.filter((t) => t.date === today);
    const done = todays.filter((t) => t.done);
    const open = todays.filter((t) => !t.done);
    const older = tasks.filter((t) => t.date < today && !t.done);
    const next = tasks.filter((t) => t.date === tomorrow && !t.done)
      .sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
    const total = todays.length;
    const mood = !total ? 'empty' : done.length === total ? 'all'
      : done.length / total >= 0.6 ? 'most' : done.length ? 'some' : 'none';
    const titles = {
      all: ['Every task,', 'done.'],
      most: ['A strong', 'day.'],
      some: ['Progress', 'made.'],
      none: ['Tomorrow’s a', 'fresh start.'],
      empty: ['A quiet', 'day.'],
    };
    const line = pick(LINES[mood], today);
    const hi = name ? `, ${name}` : '';
    const left = open.length + older.length;
    const body = !total
      ? `A quiet day${hi}. ${line}`
      : `You finished ${done.length} of ${total} task${total === 1 ? '' : 's'}${hi}.${left ? ` ${left} still open.` : ''} ${line}`;
    if (lite) {
      return {
        mood, total, done, open, older, next, lite,
        title: ['Today', 'at a glance'],
        line: '',
        notifTitle: 'Your day, summarized',
        notifBody: total ? `${done.length} of ${total} done.${left ? ` ${left} still open.` : ''}` : 'Nothing on the list today.',
      };
    }
    return {
      mood, total, done, open, older, next, lite,
      title: titles[mood],
      line,
      notifTitle: mood === 'all' ? 'Your day, summarized 🎉' : 'Your day, summarized',
      notifBody: body,
    };
  }

  // The moment today's summary is due, or null when it's off.
  function summaryAt(time, now = new Date()) {
    if (!time || time === 'off') return null;
    const [h, m] = String(time).split(':').map(Number);
    if (!Number.isFinite(h)) return null;
    const at = new Date(now);
    at.setHours(h, m || 0, 0, 0);
    return at;
  }


  // ---------- morning plan ----------
  // The partner to the evening summary: what today holds, sent each morning.
  const MORNING_TIME = '08:00';
  const MORNING_LINES = {
    busy: [
      'A full day. Take it one task at a time.',
      'Lots on today. Start with the first one and keep rolling.',
      'Big day ahead. You’ve got this.',
    ],
    steady: [
      'A good, doable day. Let’s go.',
      'A clear plan for today. Enjoy it.',
      'Nicely sized day. Start strong.',
    ],
    carry: [
      'A few things waited from before. Today’s a good day to clear them.',
      'Some leftovers from earlier. Fold them into today.',
    ],
    empty: [
      'Nothing planned yet. Say what today needs.',
      'A blank page today. Add the one thing that matters most.',
    ],
  };
  const byTime = (a, b) => (a.time || a.slotTime || '99').localeCompare(b.time || b.slotTime || '99');

  // tasks: Blip tasks; day: YYYY-MM-DD of the plan; name: first name or ''.
  // lite (Blip 2.0): counts and the first task only.
  function morningPlan(tasks, day, name = '', { lite = false, slotTime = {}, fmt = (x) => x } = {}) {
    const withSlot = (t) => ({ ...t, slotTime: !t.time && t.slot ? slotTime[t.slot] || '' : '' });
    const todays = tasks.filter((t) => t.date === day && !t.done).map(withSlot).sort(byTime);
    const carried = tasks.filter((t) => t.date < day && !t.done).sort((a, b) => b.date.localeCompare(a.date));
    const timed = todays.filter((t) => t.time);
    const first = timed[0] || null;
    const urgent = todays.filter((t) => t.priority === 'high');
    const total = todays.length;
    const mood = !total && !carried.length ? 'empty' : carried.length && total < 4 ? 'carry' : total >= 6 ? 'busy' : 'steady';
    const line = pick(MORNING_LINES[mood], day);
    const n = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
    const facts = [];
    facts.push(total ? `${n(total, 'task')} today${first ? `, first at ${fmt(first.time)}` : ''}.` : 'Nothing planned for today yet.');
    if (carried.length) facts.push(`${carried.length} carried over.`);
    const hi = name ? `, ${name}` : '';
    const base = { mood, total, todays, carried, timed, first, urgent, lite, day };
    if (lite) {
      return {
        ...base,
        title: ['Today', 'at a glance'],
        line: '',
        gist: total ? `${n(total, 'task')}${first ? ` · first at ${fmt(first.time)}` : ''}` : carried.length ? `${carried.length} carried over` : 'Nothing planned yet',
        notifTitle: 'Your morning plan',
        notifBody: facts.join(' '),
      };
    }
    if (urgent.length) facts.push(`${urgent.length} urgent.`);
    return {
      ...base,
      title: [`Good morning${hi}.`],
      line,
      gist: total ? `${n(total, 'task')}${first ? ` · first at ${fmt(first.time)}` : ''}` : carried.length ? `${carried.length} carried over` : 'Nothing planned yet',
      notifTitle: `Good morning${hi} ☀️`,
      notifBody: `${facts.join(' ')} ${line}`.trim(),
    };
  }

  // Shown on Home from the plan time until noon (or for 3 hours when it's
  // later than 9 AM), and never past the evening summary.
  function morningWindow(time, now = new Date()) {
    const at = summaryAt(time, now);
    if (!at) return null;
    const noon = new Date(now); noon.setHours(12, 0, 0, 0);
    const until = new Date(Math.max(noon.getTime(), at.getTime() + 3 * 3600e3));
    return { at, until };
  }

  root.BlipSummary = { daySummary, summaryAt, DEFAULT_TIME, morningPlan, morningWindow, MORNING_TIME };
  if (typeof module !== 'undefined') module.exports = root.BlipSummary;
})(typeof window !== 'undefined' ? window : globalThis);
