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

  root.BlipSummary = { daySummary, summaryAt, DEFAULT_TIME };
  if (typeof module !== 'undefined') module.exports = root.BlipSummary;
})(typeof window !== 'undefined' ? window : globalThis);
