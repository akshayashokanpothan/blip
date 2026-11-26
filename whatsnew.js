// What's New: short announcements shown from the top bar. Newest first.
// Add an entry at the top when a release ships. `id` must be unique and only ever grow.
// action: { label, go } where go is 'settings', 'tour' or a view name.
const WHATS_NEW = [
  { id: 8, date: '2026-11-26', tag: 'Update', title: 'Tablets, any way up',
    body: 'Blip now rotates with your device. Tablets in landscape get the full layout, and phones on their side get a two-column home.' },
  { id: 7, date: '2026-11-26', tag: 'Feature', title: 'Cleaner task titles',
    body: 'Say "birthday of mom" and Blip writes "Mom\'s birthday". Repeated words and filler like "um" or "and stuff" are tidied too.' },
  { id: 6, date: '2026-11-26', tag: 'Fix', title: 'Sync is more reliable',
    body: 'Tasks you add or delete on one device now show up on your others, even if a sync got stuck before.' },
  { id: 5, date: '2026-11-26', tag: 'Feature', title: 'Long reminder tones',
    body: 'Marimba, Pulse and Escalate keep ringing until you tap, so urgent reminders are hard to miss.',
    action: { label: 'Try them', go: 'settings' } },
  { id: 4, date: '2026-11-25', tag: 'Feature', title: 'A new product tour',
    body: 'A one-minute film of everything Blip can do, on phone and laptop.',
    action: { label: 'Watch', go: 'tour' } },
  { id: 3, date: '2026-11-25', tag: 'Update', title: 'Dark mode by default',
    body: 'Blip now starts dark. Prefer light? Switch any time in Settings.' },
  { id: 2, date: '2026-11-25', tag: 'Feature', title: 'Fix it as you speak',
    body: 'Say "tomorrow, sorry, today" and Blip keeps only the correction.' },
  { id: 1, date: '2026-11-25', tag: 'Feature', title: 'Pick your Blip version',
    body: 'Switch between Blip 2.0 and 1.0 from the pill next to the mic, now on desktop too.' },
];
