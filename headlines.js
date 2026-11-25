// Blip home headlines: the big two-line title and the line under it change
// with the time, the day, the person's work, their list, and how they use the app.
// Everything is decided on the device; nothing is sent anywhere.
(function (root) {
  // Time slots. Early mornings count as morning.
  function slotOf(h) {
    if (h < 5) return 'late';
    if (h < 12) return 'morning';
    if (h < 17) return 'afternoon';
    if (h < 21) return 'evening';
    return 'night';
  }

  // Role lines, one per working slot. [line 1, line 2].
  const ROLE_LINES = {
    'engineer': {
      morning: ['Morning, builder.', 'What ships today?'],
      afternoon: ['Deep in the code?', 'Park side tasks here.'],
      evening: ['Logging off?', 'Leave tomorrow a note.'],
    },
    'designer': {
      morning: ['Morning, designer.', 'Sketch the day out loud.'],
      afternoon: ['Mid-critique?', 'Catch the feedback here.'],
      evening: ['Ideas still flowing?', 'Save them for tomorrow.'],
    },
    'data-analyst': {
      morning: ['Morning, analyst.', 'What needs answering today?'],
      afternoon: ['Between queries?', 'Note the next one.'],
      evening: ['Numbers done?', 'Queue tomorrow’s questions.'],
    },
    'business-analyst': {
      morning: ['Morning, analyst.', 'Which requirement first?'],
      afternoon: ['Meetings piling up?', 'Capture the follow-ups.'],
      evening: ['Wrapping up?', 'List tomorrow’s open points.'],
    },
    'product-manager': {
      morning: ['Morning, PM.', 'What moves the roadmap today?'],
      afternoon: ['Too many threads?', 'Say the next step.'],
      evening: ['Day done?', 'Park tomorrow’s priorities.'],
    },
    'student': {
      morning: ['Morning.', 'Which class or deadline first?'],
      afternoon: ['Study break?', 'Note what’s due.'],
      evening: ['Homework time?', 'Say what’s left.'],
    },
    'researcher': {
      morning: ['Morning.', 'What are we finding out today?'],
      afternoon: ['Mid-experiment?', 'Log the next step.'],
      evening: ['Thinking it over?', 'Keep the idea safe.'],
    },
    'doctor': {
      morning: ['Morning, doctor.', 'What’s on the rounds?'],
      afternoon: ['Between patients?', 'Say the follow-up.'],
      evening: ['Shift over?', 'Hand Blip the loose ends.'],
    },
    'healthcare': {
      morning: ['Morning.', 'Ready for the shift?'],
      afternoon: ['Quick moment?', 'Note the follow-up.'],
      evening: ['Shift done?', 'Let Blip hold the rest.'],
    },
    'teacher': {
      morning: ['Morning, teacher.', 'What’s on the lesson plan?'],
      afternoon: ['Between classes?', 'Note what to grade.'],
      evening: ['Done teaching?', 'Plan tomorrow out loud.'],
    },
    'founder': {
      morning: ['Morning.', 'What moves the company today?'],
      afternoon: ['Too many hats?', 'Hand Blip the list.'],
      evening: ['Still going?', 'Park it for tomorrow.'],
    },
    'marketing': {
      morning: ['Morning.', 'Who do you need to reach today?'],
      afternoon: ['Between calls?', 'Say the follow-up.'],
      evening: ['Wrapping up?', 'Queue tomorrow’s outreach.'],
    },
    'freelancer': {
      morning: ['Morning.', 'Which client first?'],
      afternoon: ['Juggling projects?', 'Say the next deliverable.'],
      evening: ['Clocking off?', 'Note what’s owed.'],
    },
  };

  // For people without a role, or for slots a role has no line for.
  const SLOT_LINES = {
    morning: [['Fresh day.', 'Say what’s on it.'], ['Good start.', 'What’s first?']],
    afternoon: [['Halfway there.', 'What’s left?'], ['Afternoon check-in.', 'Say the next thing.']],
    evening: [['Winding down?', 'Park it for tomorrow.'], ['Evening.', 'Clear your head here.']],
    night: [['Late thoughts?', 'Blip will hold them.'], ['Still up?', 'Say it and rest.']],
    late: [['Can’t sleep?', 'Empty your head here.'], ['Quiet hours.', 'Say it, then sleep.']],
  };

  const WEEKEND_LINES = {
    morning: [['Slow morning?', 'Note it, don’t do it.'], ['Weekend mode.', 'Jot it, enjoy the day.']],
    afternoon: [['Weekend mode.', 'Jot it, enjoy the day.'], ['Slow day?', 'Note it, don’t do it.']],
  };
  const SUNDAY_EVENING = [['Week ahead.', 'Get it out of your head.']];
  const MONDAY_MORNING = [['New week.', 'What matters most?']];
  const FRIDAY_EVENING = [['Week’s done.', 'Anything for Monday?']];

  // A steady pick: the same line all through a slot, a different one next time.
  function pick(list, seed) {
    if (!list || !list.length) return null;
    let h = 0;
    for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return list[h % list.length];
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // ctx: { now, role, name, total, done, carry, next: { text, time } | null,
  //        visits: { firstEver, daysAway, opensToday } }
  // Returns { title: [line1, line2], copy, key } where key names the rule used.
  function homeHeadline(ctx) {
    const now = ctx.now || new Date();
    const h = now.getHours();
    const day = now.getDay(); // 0 Sunday
    const slot = slotOf(h);
    const workSlot = slot === 'night' || slot === 'late' ? null : slot;
    const weekend = day === 0 || day === 6;
    const v = ctx.visits || {};
    const total = ctx.total || 0;
    const done = ctx.done || 0;
    const open = total - done;
    const carry = ctx.carry || 0;
    const seed = `${now.toDateString()}|${slot}`;
    const first = (ctx.name || '').trim().split(/\s+/)[0];

    // Their work comes first on weekdays; the day shows up in the line below.
    const roleLine = !weekend && workSlot ? ROLE_LINES[ctx.role]?.[workSlot] || null : null;

    // ---- title: the strongest signal wins ----
    let title = null;
    let key = '';
    if (v.firstEver) {
      title = [first ? `Hi ${first}, I’m Blip.` : 'Hi, I’m Blip.', 'Just say it.']; key = 'first-ever';
    } else if ((v.daysAway || 0) >= 3) {
      title = ['Welcome back.', 'Let’s catch up.']; key = 'back';
    } else if (total > 0 && open === 0 && carry === 0) {
      title = ['All clear.', 'Nice work today.']; key = 'all-done';
    } else if (slot === 'late') {
      title = pick(SLOT_LINES.late, seed); key = 'late';
    } else if (!roleLine && day === 1 && slot === 'morning') {
      title = pick(MONDAY_MORNING, seed); key = 'monday';
    } else if ((!roleLine || slot === 'night') && day === 5 && (slot === 'evening' || slot === 'night')) {
      title = pick(FRIDAY_EVENING, seed); key = 'friday';
    } else if (day === 0 && (slot === 'evening' || slot === 'night')) {
      title = pick(SUNDAY_EVENING, seed); key = 'sunday';
    } else if (weekend && WEEKEND_LINES[slot]) {
      title = pick(WEEKEND_LINES[slot], seed); key = 'weekend';
    } else if (roleLine) {
      title = roleLine; key = `role-${workSlot}`;
    } else {
      title = pick(SLOT_LINES[slot], seed); key = `slot-${slot}`;
    }

    // ---- copy: what the day and the list look like, said together ----
    const parts = [];
    if (key !== 'back' && key !== 'first-ever') {
      if ((v.opensToday || 0) >= 4) parts.push('Back again.');
      else if (key === 'role-morning' && day === 1) parts.push('New week.');
      else if (key === 'role-afternoon' && day === 5) parts.push('Last push of the week.');
      else if (key === 'role-evening' && day === 5) parts.push('Week’s done.');
    }
    if (v.firstEver) {
      parts.push('Tap the mic and say a task. Blip sorts out the date and time.');
    } else if (total === 0 && carry === 0) {
      parts.push(slot === 'evening' || slot === 'night' || slot === 'late'
        ? 'Nothing planned. Say what’s on your mind for tomorrow.'
        : 'Nothing planned yet. Say the first thing.');
    } else {
      if (open > 0) {
        parts.push(`${plural(open, 'task', 'tasks')} left today.`);
        if (ctx.next) parts.push(`Next: ${ctx.next.text}${ctx.next.time ? ` at ${ctx.next.time}` : ''}.`);
      } else if (total > 0) {
        parts.push(total === 1 ? 'Today’s task is done.' : `All ${total} tasks done today.`);
      }
      if (carry > 0) parts.push(`${carry} waiting from before.`);
    }
    return { title, copy: parts.join(' '), key };
  }

  const api = { homeHeadline, slotOf, ROLE_LINES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
