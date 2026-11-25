// Blip reminder rules, shared by the app (local notifications and the push
// schedule) and the tests. "At the time" always rings; people can add up to
// three earlier reminders in Settings. Until they choose, it's 10 minutes before.
(function (root) {
  const OPTIONS = [5, 10, 15, 30, 60, 120, 1440]; // minutes before
  const DEFAULT_EXTRA = [10];
  const MAX_EXTRA = 3;

  // The extra reminders someone picked, cleaned up. null or missing means "not customised".
  function extraOffsets(saved) {
    if (!Array.isArray(saved)) return DEFAULT_EXTRA.slice();
    const clean = [...new Set(saved.map(Number))].filter((m) => OPTIONS.includes(m));
    return clean.sort((a, b) => b - a).slice(0, MAX_EXTRA);
  }

  // Every offset that rings, latest last: e.g. [30, 10, 0].
  const allOffsets = (saved) => [...extraOffsets(saved), 0];

  function offsetLabel(min) {
    if (min === 0) return 'At the time';
    if (min < 60) return `${min} min before`;
    if (min === 1440) return '1 day before';
    const h = min / 60;
    return `${h} hour${h === 1 ? '' : 's'} before`;
  }

  // "in 10 min", "in 1 hour", "tomorrow"
  function leadText(min) {
    if (min < 60) return `in ${min} min`;
    if (min === 1440) return 'in 1 day';
    const h = min / 60;
    return `in ${h} hour${h === 1 ? '' : 's'}`;
  }

  // The notification for one reminder of one task.
  // when: a ready-made label such as "Today at 10:00 AM".
  function reminderText(task, min, when) {
    const head = min === 0 ? `Now · ${when}` : `${leadText(min)[0].toUpperCase()}${leadText(min).slice(1)} · ${when}`;
    const notes = (task.notes || '').replace(/\s+/g, ' ').trim();
    const body = notes ? `${head}\n${notes.length > 140 ? `${notes.slice(0, 138).trim()}…` : notes}` : head;
    return { title: task.text || 'Reminder', body };
  }

  // All the moments a task should ring: [{ min, at }] with at in ms.
  function fireTimes(task, saved, due) {
    if (!task || !task.reminder || task.done || due == null) return [];
    return allOffsets(saved).map((min) => ({ min, at: due - min * 60e3 }));
  }

  const api = { OPTIONS, DEFAULT_EXTRA, MAX_EXTRA, extraOffsets, allOffsets, offsetLabel, leadText, reminderText, fireTimes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BlipReminders = api;
})(typeof window !== 'undefined' ? window : globalThis);
