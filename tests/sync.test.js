// Tests sync.js with two simulated devices sharing a fake Supabase backend.
// Run: node tests/sync.test.js
const assert = require('assert');
const createBlipSync = require('../sync.js');

// ----- fake backend: tables, server timestamps, realtime fan-out -----
const NOT_NULL = {
  tasks: ['text', 'notes', 'time', 'end_time', 'slot', 'priority', 'done', 'reminder', 'repeat', 'created_at', 'updated_at', 'deleted'],
  notes: ['title', 'body', 'created_at', 'edited_at', 'updated_at', 'deleted'],
};
function fakeServer() {
  const tables = { tasks: new Map(), notes: new Map(), user_settings: new Map() };
  const listeners = [];
  let tick = 0;
  let down = false;
  const stamp = () => new Date(Date.UTC(2026, 0, 1) + ++tick * 1000).toISOString();

  function client() {
    return {
      from(table) {
        const t = tables[table];
        return {
          async upsert(rows, opts = {}) {
            if (down) return { error: new Error('network down') };
            // Like PostgREST: a bulk upsert sends the union of all rows' columns,
            // and a column a row leaves out becomes NULL unless defaultToNull is false.
            const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
            if (opts.defaultToNull !== false) {
              for (const r of rows) for (const c of cols) {
                if (!(c in r) && NOT_NULL[table]?.includes(c)) {
                  return { error: new Error(`null value in column "${c}" of relation "${table}" violates not-null constraint`) };
                }
              }
            }
            // Like Postgres: one row breaking a check constraint fails the whole statement.
            if (rows.some((r) => r.priority && !['high', 'medium', 'low'].includes(r.priority))) {
              return { error: { code: '23514', message: 'new row for relation "tasks" violates check constraint "tasks_priority_check"' } };
            }
            for (const r of rows) {
              const key = table === 'user_settings' ? r.user_id : `${r.user_id}:${r.id}`;
              const row = { ...(t.get(key) || {}), ...r, server_updated_at: stamp() };
              t.set(key, row);
              for (const l of listeners) if (l.table === table) l.cb({ new: { ...row } });
            }
            return { error: null };
          },
          select() {
            const q = { cursor: null };
            const b = {
              order() { return b; },
              limit() { return b; },
              gt(_c, v) { q.cursor = v; return b; },
              then(res, rej) {
                if (down) return Promise.resolve({ data: null, error: new Error('network down') }).then(res, rej);
                const data = [...t.values()]
                  .filter((r) => !q.cursor || r.server_updated_at > q.cursor)
                  .sort((a, c) => (a.server_updated_at < c.server_updated_at ? -1 : 1));
                return Promise.resolve({ data, error: null }).then(res, rej);
              },
            };
            return b;
          },
        };
      },
      channel() {
        const ch = {
          on(_e, opts, cb) { listeners.push({ table: opts.table, cb, ch }); return ch; },
          subscribe() { return ch; },
        };
        return ch;
      },
      removeChannel(ch) {
        for (let i = listeners.length - 1; i >= 0; i--) if (listeners[i].ch === ch) listeners.splice(i, 1);
      },
    };
  }
  return { client, tables, setDown: (v) => { down = v; } };
}

// ----- a "device": its own storage and app state -----
function device(server, name) {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  const app = { tasks: [], notes: [], settings: { theme: 'light' }, renders: 0 };
  const sync = createBlipSync({
    client: server.client(),
    storage,
    store: {
      getTasks: () => app.tasks,
      getNotes: () => app.notes,
      getSettings: () => app.settings,
      setTasks: (l) => { app.tasks = l; },
      setNotes: (l) => { app.notes = l; },
      applySettings: (s) => Object.assign(app.settings, s),
      alreadyDue: () => false,
      remoteChanged: () => { app.renders++; },
    },
  });
  app.sync = sync;
  app._mem = mem;
  app.name = name;
  return app;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => wait(1000); // longer than the flush debounce

(async () => {
  const server = fakeServer();
  const phone = device(server, 'phone');
  const laptop = device(server, 'laptop');

  // 1. Guest data on the phone is merged into the account on first sign-in.
  phone.tasks.push({ id: 't1', text: 'Buy milk', date: '2026-11-25', priority: 'medium', created: 1 });
  phone.notes.push({ id: 'n1', title: 'Ideas', body: 'Voice notes', created: 1, updated: 1 });
  phone.settings.displayName = 'Akshay';
  await phone.sync.start('user-1');
  await settle();
  assert.strictEqual(server.tables.tasks.size, 1, 'guest task uploaded');
  assert.strictEqual(server.tables.notes.size, 1, 'guest note uploaded');

  // 2. A second device signing in gets everything, including the name.
  await laptop.sync.start('user-1');
  await settle();
  assert.deepStrictEqual(laptop.tasks.map((t) => t.text), ['Buy milk']);
  assert.deepStrictEqual(laptop.notes.map((n) => n.title), ['Ideas']);
  assert.strictEqual(laptop.settings.displayName, 'Akshay', 'settings follow the account');

  // 3. Live: an add on the laptop shows up on the phone without a pull.
  laptop.tasks.push({ id: 't2', text: 'Gym', date: '2026-11-25', time: '18:00', priority: 'high', created: 2 });
  laptop.sync.changed('tasks');
  await settle();
  assert.deepStrictEqual(phone.tasks.map((t) => t.text).sort(), ['Buy milk', 'Gym'], 'realtime add');
  assert.strictEqual(phone.tasks.find((t) => t.id === 't2').priority, 'high');

  // 4. Edits and deletes travel too.
  phone.tasks.find((t) => t.id === 't1').done = true;
  phone.sync.changed('tasks');
  phone.notes = [];
  phone.sync.changed('notes');
  await settle();
  assert.strictEqual(laptop.tasks.find((t) => t.id === 't1').done, true, 'edit synced');
  assert.strictEqual(laptop.notes.length, 0, 'delete synced');

  // 5. Conflict: both edit the same task; the later edit wins on both.
  phone.tasks.find((t) => t.id === 't2').text = 'Gym (phone)';
  phone.sync.changed('tasks');
  await wait(20);
  laptop.tasks.find((t) => t.id === 't2').text = 'Gym (laptop)';
  laptop.sync.changed('tasks');
  await settle();
  assert.strictEqual(phone.tasks.find((t) => t.id === 't2').text, 'Gym (laptop)', 'last edit wins on phone');
  assert.strictEqual(laptop.tasks.find((t) => t.id === 't2').text, 'Gym (laptop)', 'last edit wins on laptop');

  // 6. Offline: changes queue up and go out when the network is back.
  server.setDown(true);
  phone.tasks.push({ id: 't3', text: 'Call mom', date: '2026-11-26', priority: 'low', created: 3 });
  phone.sync.changed('tasks');
  await settle();
  assert.strictEqual(phone.sync.pending, 1, 'queued while offline');
  assert.ok(['error', 'offline'].includes(phone.sync.status));
  server.setDown(false);
  await phone.sync.resume();
  await settle();
  assert.strictEqual(phone.sync.pending, 0, 'outbox drained');
  assert.ok(laptop.tasks.some((t) => t.id === 't3'), 'offline change arrived');

  // 7. Sign-out clears this device; signing back in restores from the account.
  await phone.sync.stop({ clear: true });
  assert.strictEqual(phone.tasks.length, 0, 'cleared on sign-out');
  await phone.sync.start('user-1');
  await settle();
  assert.deepStrictEqual(phone.tasks.map((t) => t.id).sort(), ['t1', 't2', 't3'], 'restored on sign-in');
  assert.ok(server.tables.tasks.size === 3 && [...server.tables.tasks.values()].every((r) => !r.deleted), 'sign-out did not delete server data');

  // 8. A delete and an edit in the same upload (e.g. tapping the bin, then
  // ticking another task) must both reach the other device.
  phone.tasks = phone.tasks.filter((t) => t.id !== 't3');
  phone.tasks.find((t) => t.id === 't1').text = 'Buy oat milk';
  phone.sync.changed('tasks');
  await settle();
  assert.strictEqual(phone.sync.pending, 0, 'mixed upload drained');
  assert.ok(!laptop.tasks.some((t) => t.id === 't3'), 'delete arrived');
  assert.strictEqual(laptop.tasks.find((t) => t.id === 't1').text, 'Buy oat milk', 'edit arrived with the delete');

  // 9. One row the database refuses must not hold back the others.
  phone.tasks.push({ id: 'bad', text: 'Broken', date: '2026-11-26', priority: 'urgent!!', created: 9 });
  phone.tasks.push({ id: 't4', text: 'Return earphone case', date: '2026-11-26', priority: 'high', created: 9 });
  phone.sync.changed('tasks');
  await settle();
  assert.ok(laptop.tasks.some((t) => t.id === 't4'), 'good row arrived despite a bad one');
  assert.ok(!server.tables.tasks.has('user-1:bad'), 'bad row refused');
  assert.ok(/check constraint/.test(phone.sync.lastError), 'refusal is reported');
  phone.tasks = phone.tasks.filter((t) => t.id !== 'bad');
  phone.sync.changed('tasks');
  await settle();

  // 10. Repair: a device whose snapshot says "uploaded" for rows the account
  // never got (the stuck-sync case) re-sends them, and newer server edits win.
  laptop.tasks.push({ id: 'lost', text: 'Democrats creation', date: '2026-11-26', priority: 'medium', created: 10, updatedAt: 10 });
  // Pretend it was marked synced without reaching the server:
  await laptop.sync.stop();
  const mem = laptop._mem;
  const key = [...mem.keys()].find((k) => k.startsWith('blip.sync.'));
  const state = JSON.parse(mem.get(key));
  const fpRow = { id: 'lost', text: 'Democrats creation', notes: '', date: '2026-11-26', time: '', end_time: '', slot: '', priority: 'medium', done: false, reminder: false, repeat: 'none', created_at: 10, deleted: false };
  state.snap.tasks.lost = JSON.stringify(fpRow);
  mem.set(key, JSON.stringify(state));
  await laptop.sync.start('user-1');
  await settle();
  assert.ok(!server.tables.tasks.has('user-1:lost'), 'stuck row is not sent by a normal sync');
  phone.tasks.find((t) => t.id === 't4').done = true; // newer edit on the phone
  phone.sync.changed('tasks');
  await settle();
  const res = await laptop.sync.repair();
  await settle();
  assert.ok(res.ok, 'repair finished');
  assert.ok(server.tables.tasks.has('user-1:lost'), 'repair uploaded the missing task');
  assert.ok(phone.tasks.some((t) => t.id === 'lost'), 'and the phone got it');
  assert.strictEqual(laptop.tasks.find((t) => t.id === 't4').done, true, 'newer phone edit kept');
  assert.strictEqual(server.tables.tasks.get('user-1:t4').done, true, 'repair did not overwrite newer data');

  console.log('All 10 sync scenarios passed.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
