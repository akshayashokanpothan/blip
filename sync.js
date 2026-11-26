// Blip v2: cross-device sync over Supabase.
//
// The app keeps working exactly as in v1: every change is saved to this
// device first. When you're signed in, this module also
//   1. uploads each change (an "outbox" that survives reloads and offline time),
//   2. pulls changes made on your other devices since the last pull,
//   3. listens for live changes while the app is open (Supabase Realtime).
//
// Conflicts: if two devices edit the same task, the edit made last wins
// (compared by the device's edit time, `updated_at`). Deletes are soft
// (`deleted = true`) so every device hears about them.
//
// The module doesn't touch the DOM. app.js gives it a small "store" adapter,
// which also makes it testable in Node with a fake client.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.createBlipSync = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const PAGE = 1000;
  const FLUSH_DELAY = 800;
  const RETRY_MS = 30_000;
  const OVERLAP_MS = 60_000;

  // ----- row mapping: local objects <-> database rows -----
  const TABLES = {
    tasks: {
      key: 'user_id,id',
      toRow: (t) => ({
        id: t.id,
        text: t.text || '',
        notes: t.notes || '',
        date: t.date || null,
        time: t.time || '',
        end_time: t.endTime || '',
        slot: t.slot || '',
        priority: t.priority || 'medium',
        done: Boolean(t.done),
        reminder: Boolean(t.reminder),
        repeat: t.repeat || 'none',
        created_at: t.created || 0,
        updated_at: t.updatedAt || 0,
        deleted: false,
      }),
      fromRow: (r) => ({
        id: r.id,
        text: r.text || '',
        notes: r.notes || '',
        date: r.date || '',
        time: r.time || '',
        endTime: r.end_time || '',
        slot: r.slot || '',
        priority: r.priority || 'medium',
        done: Boolean(r.done),
        reminder: Boolean(r.reminder),
        repeat: r.repeat || 'none',
        created: Number(r.created_at) || 0,
        updatedAt: Number(r.updated_at) || 0,
      }),
    },
    notes: {
      key: 'user_id,id',
      toRow: (n) => ({
        id: n.id,
        title: n.title || '',
        body: n.body || '',
        created_at: n.created || 0,
        edited_at: n.updated || 0,
        updated_at: n.updatedAt || 0,
        deleted: false,
      }),
      fromRow: (r) => ({
        id: r.id,
        title: r.title || '',
        body: r.body || '',
        created: Number(r.created_at) || 0,
        updated: Number(r.edited_at) || 0,
        updatedAt: Number(r.updated_at) || 0,
      }),
    },
  };

  // What counts as "changed": the synced fields only. Device-only fields such
  // as `notified` (has this device shown the reminder yet?) are left out.
  const fingerprint = (table, item) => {
    const { updated_at: _u, ...rest } = TABLES[table].toRow(item);
    return JSON.stringify(rest);
  };
  const settingsFingerprint = (s) => JSON.stringify([s.displayName || '', s.role || '', s.roleOther || '', s.theme || 'light']);

  return function createBlipSync({ client, storage, store, now = () => Date.now(), onStatus = () => {}, log = () => {} }) {
    let userId = null;
    let state = null;
    let channel = null;
    let flushTimer = null;
    let retryTimer = null;
    let flushing = null;
    let status = 'off';

    const stateKey = () => `blip.sync.${userId}`;
    const emptyState = () => ({
      cursor: { tasks: null, notes: null, user_settings: null },
      snap: { tasks: {}, notes: {}, settings: null },
      outbox: {},
      lastSynced: 0,
    });
    const saveState = () => storage.setItem(stateKey(), JSON.stringify(state));
    const setStatus = (s) => {
      if (s === status) return;
      status = s;
      onStatus(s, state?.lastSynced || 0);
    };

    // ----- local changes -> outbox -----

    // Compares the current list with the last synced snapshot. New or edited
    // items get an edit time and are queued; missing ones become tombstones.
    function diff(table) {
      const list = table === 'tasks' ? store.getTasks() : store.getNotes();
      const snap = state.snap[table];
      const seen = new Set();
      let queued = 0;
      for (const item of list) {
        seen.add(item.id);
        const fp = fingerprint(table, item);
        if (snap[item.id] === fp) continue;
        item.updatedAt = Math.max(now(), (item.updatedAt || 0) + 1);
        state.outbox[`${table}:${item.id}`] = { table, row: { user_id: userId, ...TABLES[table].toRow(item) } };
        snap[item.id] = fp;
        queued++;
      }
      for (const id of Object.keys(snap)) {
        if (seen.has(id)) continue;
        state.outbox[`${table}:${id}`] = { table, row: { user_id: userId, id, deleted: true, updated_at: now() } };
        delete snap[id];
        queued++;
      }
      return queued;
    }

    function diffSettings() {
      const s = store.getSettings();
      const fp = settingsFingerprint(s);
      if (state.snap.settings === fp) return 0;
      state.snap.settings = fp;
      state.settingsUpdatedAt = now();
      state.outbox['user_settings:me'] = {
        table: 'user_settings',
        row: {
          user_id: userId,
          display_name: s.displayName || '',
          role: s.role || '',
          role_other: s.roleOther || '',
          theme: s.theme || 'light',
          updated_at: state.settingsUpdatedAt,
        },
      };
      return 1;
    }

    // app.js calls this from save(), saveNotes() and saveSettings().
    function changed(kind) {
      if (!userId) return;
      const n = kind === 'settings' ? diffSettings() : diff(kind);
      if (!n) return;
      saveState();
      scheduleFlush();
    }

    function scheduleFlush(delay = FLUSH_DELAY) {
      clearTimeout(flushTimer);
      flushTimer = setTimeout(() => { flush(); }, delay);
    }

    // ----- outbox -> server -----
    async function flush() {
      if (!userId) return;
      if (flushing) return flushing;
      const entries = Object.entries(state.outbox);
      if (!entries.length) { setStatus('synced'); return; }
      setStatus('syncing');
      flushing = (async () => {
        // One upload per table and row shape. Deletes carry only a few columns,
        // and a bulk upsert fills columns a row leaves out with NULL, which the
        // database rejects; mixing them with full rows used to fail the whole
        // batch and stall this device's sync for good.
        const byTable = {};
        for (const [k, { table, row }] of entries) {
          const group = `${table}|${row.deleted && !('text' in row || 'title' in row) ? 'delete' : 'full'}`;
          (byTable[group] ||= []).push([k, row]);
        }
        try {
          for (const [group, items] of Object.entries(byTable)) {
            const table = group.split('|')[0];
            const onConflict = table === 'user_settings' ? 'user_id' : TABLES[table].key;
            const { error } = await client.from(table).upsert(items.map(([, r]) => r), { onConflict, defaultToNull: false });
            if (error) throw error;
            // Drop what was sent, unless it was edited again meanwhile.
            for (const [k, r] of items) {
              if (state.outbox[k]?.row.updated_at === r.updated_at) delete state.outbox[k];
            }
          }
          state.lastSynced = now();
          saveState();
          setStatus(Object.keys(state.outbox).length ? 'syncing' : 'synced');
          clearTimeout(retryTimer);
        } catch (err) {
          log('sync upload failed', err);
          setStatus(isOffline() ? 'offline' : 'error');
          clearTimeout(retryTimer);
          retryTimer = setTimeout(flush, RETRY_MS);
        }
      })();
      try { await flushing; } finally { flushing = null; }
      if (userId && Object.keys(state.outbox).length) scheduleFlush();
    }

    const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

    // ----- server -> this device -----

    // Applies one row from the server. Returns true if local data changed.
    function applyRemote(table, row) {
      if (!row || (row.user_id && row.user_id !== userId)) return false;
      if (table === 'user_settings') {
        const mine = state.outbox['user_settings:me'];
        if (mine && mine.row.updated_at >= row.updated_at) return false;
        if ((state.settingsUpdatedAt || 0) > row.updated_at) return false;
        const s = { displayName: row.display_name, role: row.role, roleOther: row.role_other, theme: row.theme };
        state.settingsUpdatedAt = row.updated_at;
        state.snap.settings = settingsFingerprint(s);
        delete state.outbox['user_settings:me'];
        store.applySettings(s);
        return true;
      }
      const map = TABLES[table];
      const key = `${table}:${row.id}`;
      const pending = state.outbox[key];
      if (pending && pending.row.updated_at > row.updated_at) return false; // ours is newer
      const list = table === 'tasks' ? store.getTasks() : store.getNotes();
      const idx = list.findIndex((x) => x.id === row.id);
      const local = idx >= 0 ? list[idx] : null;
      if (local && (local.updatedAt || 0) > row.updated_at) return false;
      delete state.outbox[key];
      if (row.deleted) {
        delete state.snap[table][row.id];
        if (idx < 0) return false;
        list.splice(idx, 1);
      } else {
        const item = map.fromRow(row);
        if (table === 'tasks') item.notified = local ? local.notified : store.alreadyDue(item);
        if (idx >= 0) list[idx] = { ...local, ...item };
        else list.push(item);
        state.snap[table][row.id] = fingerprint(table, item);
      }
      if (table === 'tasks') store.setTasks(list);
      else store.setNotes(list);
      return true;
    }

    async function pull() {
      let touched = new Set();
      for (const table of ['tasks', 'notes', 'user_settings']) {
        // Start a little before the cursor: a write that began before another
        // device's write but committed after it gets an earlier server time,
        // and would otherwise be skipped. Re-applying a row is harmless.
        let from = state.cursor[table] ? new Date(Date.parse(state.cursor[table]) - OVERLAP_MS).toISOString() : null;
        for (;;) {
          let q = client.from(table).select('*').order('server_updated_at', { ascending: true }).limit(PAGE);
          if (from) q = q.gt('server_updated_at', from);
          const { data, error } = await q;
          if (error) throw error;
          for (const row of data) {
            if (applyRemote(table, row)) touched.add(table);
            if (!state.cursor[table] || row.server_updated_at > state.cursor[table]) state.cursor[table] = row.server_updated_at;
          }
          if (data.length < PAGE) break;
          from = data[data.length - 1].server_updated_at;
        }
      }
      saveState();
      if (touched.size) store.remoteChanged([...touched]);
    }

    function subscribe() {
      if (!client.channel) return;
      channel = client.channel(`blip-${userId}`);
      for (const table of ['tasks', 'notes', 'user_settings']) {
        channel.on('postgres_changes', { event: '*', schema: 'public', table, filter: `user_id=eq.${userId}` }, (payload) => {
          const row = payload.new;
          if (!row || !row.server_updated_at) return;
          if (applyRemote(table, row)) {
            if (!state.cursor[table] || row.server_updated_at > state.cursor[table]) state.cursor[table] = row.server_updated_at;
            saveState();
            store.remoteChanged([table]);
          }
        });
      }
      channel.subscribe();
    }

    // ----- lifecycle -----

    // Called after sign-in. On a device's first sign-in for this account, the
    // snapshot is empty, so everything already on the device (guest tasks and
    // notes) is uploaded and merged into the account.
    async function start(id) {
      if (userId === id) return;
      if (userId) await stop();
      userId = id;
      try { state = { ...emptyState(), ...JSON.parse(storage.getItem(stateKey()) || 'null') }; } catch { state = emptyState(); }
      if (!state.snap) state = emptyState();
      setStatus('syncing');
      diff('tasks');
      diff('notes');
      if (!state.cursor.user_settings && !state.snap.settings) {
        // First sign-in here: the account's saved name/theme win over the device's
        // defaults, so don't queue local settings until we've pulled.
      } else {
        diffSettings();
      }
      saveState();
      try {
        await pull();
        if (!state.snap.settings) diffSettings();
        saveState();
        await flush();
      } catch (err) {
        log('sync start failed', err);
        setStatus(isOffline() ? 'offline' : 'error');
        clearTimeout(retryTimer);
        retryTimer = setTimeout(resume, RETRY_MS);
      }
      subscribe();
    }

    // Catch up after being offline or in the background.
    async function resume() {
      if (!userId) return;
      try {
        await pull();
        await flush();
      } catch (err) {
        log('sync resume failed', err);
        setStatus(isOffline() ? 'offline' : 'error');
      }
    }

    // Called on sign-out. Sends anything pending, stops listening and, with
    // clear: true, removes this account's tasks and notes from the device.
    async function stop({ clear = false } = {}) {
      if (!userId) return;
      clearTimeout(flushTimer);
      clearTimeout(retryTimer);
      try { await flush(); } catch { /* best effort */ }
      if (channel && client.removeChannel) client.removeChannel(channel);
      channel = null;
      if (clear) {
        storage.removeItem(stateKey());
        store.setTasks([]);
        store.setNotes([]);
        store.remoteChanged(['tasks', 'notes']);
      }
      userId = null;
      state = null;
      setStatus('off');
    }

    return {
      start,
      stop,
      changed,
      resume,
      flush,
      get status() { return status; },
      get pending() { return state ? Object.keys(state.outbox).length : 0; },
      get lastSynced() { return state?.lastSynced || 0; },
    };
  };
});
