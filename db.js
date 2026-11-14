// db.js - the ONLY file that touches IndexedDB.
// Database "liftlog". Everything the app remembers lives here, on this device only.
// Nothing in here is ever sent anywhere.
//
// Rules (DESIGN 4.2 db.js):
// - Every write resolves only on transaction complete; a request success is never "saved".
// - A lost link is reset and the call is tried once more (close event, or the lost-link errors).
// - replaceAll is one transaction over every store but snapshots, counted inside it.
// - clearSnapshots is the only call that clears snapshots. There is no wipe-all.
// - Version 2 (16 B.6.2): a version 1 db is upgraded inside the upgrade transaction through the
//   hook createStore hands in (this file imports nothing and reads no clock). Any error or a count
//   mismatch aborts it, so the phone stays on version 1 and the open fails (upgradeFailed()).

const DB_NAME = 'liftlog';
export const DB_VERSION = 2;

// All 8 stores exist from the first version, so the version 2 upgrade adds no store and no index.
export const STORES = {
  settings:  { keyPath: 'key' },
  exercises: { keyPath: 'id', indexes: { muscle: 'muscle', equipment: 'equipment' } },
  templates: { keyPath: 'id' },
  blocks:    { keyPath: 'id', indexes: { status: 'status' } },
  days:      { keyPath: 'id', indexes: { block_id: 'block_id', done_date: 'done_date' } },
  sets:      { keyPath: 'id', indexes: { day_id: 'day_id', block_id: 'block_id', exercise_id: 'exercise_id' } },
  feedback:  { keyPath: 'id', indexes: { day_id: 'day_id', exercise_id: 'exercise_id' } },
  snapshots: { keyPath: 'id', indexes: { made_at: 'made_at' } }
};

// Every store replaceAll writes (all but snapshots), in a fixed order.
const DATA_STORES = Object.keys(STORES).filter(n => n !== 'snapshots');

let _db = null;
let _openError = null;
let _versionClosed = false;     // set after a versionchange close: never reconnect
let _upgradeFailed = false;     // set when the version 2 upgrade aborted: never try again on this page
let _upgradeHook = null;        // (stores) => {snapshot, stores2}, from createStore (16 B.6.2)
const _closeListeners = [];
const _stats = { opens: 0, retries: 0 };
const KEEP_SNAPSHOTS = 3;

const keyOf = (store, row) => row[STORES[store].keyPath];

// The pure half of the version 1 to 2 upgrade, shared with the fake db of the unit tests.
// data: the seven data stores as read; snapshots: the snapshot rows as read. Calls the hook once
// and returns the writes to make and the row count each store must hold after them. Throws on a
// missing hook, a hook that throws, a snapshot that is not a before-upgrade copy, or migrated
// stores that do not hold exactly the rows that were read (same keys, same count).
export function planUpgrade(data, snapshots, hook) {
  if (typeof hook !== 'function') throw new Error('upgrade: no upgrade hook');
  const out = hook(data);
  const snapshot = out && out.snapshot;
  const stores2 = out && out.stores2;
  if (!snapshot || typeof snapshot.id !== 'string' || snapshot.reason !== 'before-upgrade' || !Number.isFinite(snapshot.made_at)) {
    throw new Error('upgrade: no before-upgrade copy');
  }
  if (!stores2) throw new Error('upgrade: no migrated stores');
  const ops = [];
  const counts = {};
  for (const n of DATA_STORES) {
    const was = data[n] || [];
    const next = stores2[n];
    if (!Array.isArray(next) || next.length !== was.length) throw new Error('upgrade: count mismatch in ' + n);
    const old = new Map(was.map(r => [keyOf(n, r), JSON.stringify(r)]));
    for (const r of next) {
      const k = keyOf(n, r);
      if (!old.has(k)) throw new Error('upgrade: a migrated row has a new key in ' + n);
      if (old.get(k) !== JSON.stringify(r)) ops.push({ store: n, put: r });
      old.delete(k);
    }
    if (old.size) throw new Error('upgrade: a row was lost in ' + n);
    counts[n] = was.length;
  }
  // The copy, then the newest 3 kept (the same trim as every other safety copy).
  const rest = (snapshots || []).filter(s => s.id !== snapshot.id).sort((a, b) => b.made_at - a.made_at);
  ops.push({ store: 'snapshots', put: snapshot });
  for (const s of rest.slice(KEEP_SNAPSHOTS - 1)) ops.push({ store: 'snapshots', del: s.id });
  counts.snapshots = (rest.length < KEEP_SNAPSHOTS - 1 ? rest.length : KEEP_SNAPSHOTS - 1) + 1;
  return { ops, counts };
}

// Inside the upgrade transaction, request callbacks only (no await, so it stays alive): read
// every store, plan, write, recount. Any error aborts the transaction: nothing changes.
function upgradeFrom1(tx) {
  const names = [...DATA_STORES, 'snapshots'];
  const got = {};
  let left = names.length;
  let failed = false;
  const fail = (e) => {
    if (failed) return;
    failed = true;
    _upgradeFailed = true;
    _openError = e || new Error('upgrade failed');
    try { tx.abort(); } catch (_) { /* already aborted */ }
  };
  const apply = () => {
    let plan;
    try {
      const { snapshots, ...data } = got;
      plan = planUpgrade(data, snapshots, _upgradeHook);
    } catch (e) {
      return fail(e);
    }
    try {
      for (const o of plan.ops) {
        const os = tx.objectStore(o.store);
        const r = ('put' in o) ? os.put(o.put) : os.delete(o.del);
        r.onerror = (ev) => fail(ev.target.error);
      }
      // Requests of one transaction run in order, so these counts see every write above.
      for (const [n, want] of Object.entries(plan.counts)) {
        const c = tx.objectStore(n).count();
        c.onsuccess = () => { if (c.result !== want) fail(new Error('upgrade: count mismatch in ' + n)); };
        c.onerror = (ev) => fail(ev.target.error);
      }
    } catch (e) {
      fail(e);
    }
  };
  for (const n of names) {
    const r = tx.objectStore(n).getAll();
    r.onsuccess = () => { got[n] = r.result; if (--left === 0 && !failed) apply(); };
    r.onerror = (ev) => fail(ev.target.error);
  }
}

function open() {
  if (_db) return Promise.resolve(_db);
  if (_versionClosed) return Promise.reject(new Error('Database closed for a newer version'));
  if (_upgradeFailed) return Promise.reject(_openError || new Error('upgrade failed'));
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      _openError = e;
      return reject(e);
    }
    let upgrading = false;
    req.onupgradeneeded = (ev) => {
      const conn = ev.target.result;
      // oldVersion 0: a new phone, the stores are made fresh and the hook is never called.
      for (const [name, spec] of Object.entries(STORES)) {
        const store = conn.objectStoreNames.contains(name)
          ? ev.target.transaction.objectStore(name)
          : conn.createObjectStore(name, { keyPath: spec.keyPath });
        for (const [idxName, idxKey] of Object.entries(spec.indexes || {})) {
          if (!store.indexNames.contains(idxName)) store.createIndex(idxName, idxKey);
        }
      }
      if (ev.oldVersion === 1) {
        upgrading = true;
        try { upgradeFrom1(ev.target.transaction); } catch (e) {
          _upgradeFailed = true;
          _openError = e;
          try { ev.target.transaction.abort(); } catch (_) { /* already aborted */ }
        }
      }
    };
    req.onsuccess = () => {
      const conn = req.result;
      // The browser can close the link on its own (storage pressure, the app sent
      // to the background). Forget it so the next call reopens.
      conn.addEventListener('close', () => { if (_db === conn) { _db = null; try { conn.close(); } catch (_) { /* gone */ } } });
      // A newer version asks for the db: close, never reconnect, and tell the page (db.reopen).
      conn.onversionchange = () => {
        conn.close(); _versionClosed = true; if (_db === conn) _db = null;
        for (const fn of _closeListeners) { try { fn(); } catch (_) { /* a screen error never stops the close */ } }
      };
      _db = conn;
      _openError = null;
      _stats.opens++;
      resolve(conn);
    };
    req.onerror = () => {
      if (upgrading) _upgradeFailed = true;
      if (!_upgradeFailed || !_openError) _openError = req.error;
      reject(_openError || req.error);
    };
    req.onblocked = () => reject(new Error('Database blocked by another open window'));
  });
}

function isDeadLink(e) {
  if (!e) return false;
  if (e.name === 'InvalidStateError' || e.name === 'TransactionInactiveError' || e.name === 'UnknownError') return true;
  const m = String(e.message || '');
  return m.includes('Connection') && m.includes('lost');
}

// Run one call on the link. If the link turns out dead, drop it, reopen and try once more.
async function withLink(fn) {
  const conn = await open();
  try {
    return await fn(conn);
  } catch (e) {
    if (!isDeadLink(e)) throw e;
    if (_db === conn) _db = null;
    _stats.retries++;
    return await fn(await open());
  }
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Resolves only when the transaction has committed.
function done(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  });
}

function read(store, mode, ask) {
  return withLink((conn) => wrap(ask(conn.transaction([store], mode).objectStore(store))));
}

function write(store, act) {
  return withLink((conn) => {
    const t = conn.transaction([store], 'readwrite');
    const finished = done(t);
    act(t.objectStore(store));
    return finished;
  });
}

export const db = {
  openError: () => _openError,

  // The version 2 upgrade hook (16 B.6.2). Set by createStore before the first open.
  setUpgradeHook(fn) { _upgradeHook = fn; },
  // True after the upgrade aborted on this page (the page shows db.upgradefail).
  upgradeFailed: () => _upgradeFailed,
  // True after a newer version closed this link (the page shows db.reopen).
  versionClosed: () => _versionClosed,
  onVersionClosed(fn) { _closeListeners.push(fn); },

  async ready() { await open(); return true; },

  put(store, value) { return write(store, (os) => os.put(value)); },

  get(store, key) { return read(store, 'readonly', (os) => os.get(key)); },

  all(store) { return read(store, 'readonly', (os) => os.getAll()); },

  byIndex(store, index, value) { return read(store, 'readonly', (os) => os.index(index).getAll(value)); },

  count(store) { return read(store, 'readonly', (os) => os.count()); },

  // Several stores read in ONE readonly transaction, so the rows agree with each other.
  // Resolves on complete with {store: rows}.
  allMany(stores) {
    return withLink((conn) => new Promise((resolve, reject) => {
      const t = conn.transaction(stores, 'readonly');
      const out = {};
      for (const s of stores) { const r = t.objectStore(s).getAll(); r.onsuccess = () => { out[s] = r.result; }; }
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Transaction aborted'));
    }));
  },

  del(store, key) { return write(store, (os) => os.delete(key)); },

  // Several puts and deletes in ONE transaction: [{store, put: row} | {store, del: key}].
  // Resolves only on commit; any failed request aborts all of them.
  batch(ops) {
    const names = [...new Set(ops.map(o => o.store))];
    if (!names.length) return Promise.resolve();
    return withLink((conn) => {
      const t = conn.transaction(names, 'readwrite');
      const finished = done(t);
      try {
        for (const o of ops) {
          const os = t.objectStore(o.store);
          const req = ('put' in o) ? os.put(o.put) : os.delete(o.del);
          req.onerror = () => { try { t.abort(); } catch (_) { /* already aborted */ } };
        }
      } catch (e) {
        try { t.abort(); } catch (_) { /* already aborted */ }
      }
      return finished;
    });
  },

  async setting(key, fallback) {
    const row = await this.get('settings', key);
    return row === undefined ? fallback : row.value;
  },

  setSetting(key, value) { return this.put('settings', { key, value }); },

  // Replace every store except snapshots in ONE transaction. Any thrown error, any
  // failed request, or a store whose count after the puts is not counts[store]
  // aborts the whole transaction: then nothing changed. The caller validates first.
  async replaceAll(data, counts) {
    data = data || {};
    for (const n of Object.keys(data)) {
      if (!DATA_STORES.includes(n)) throw new Error('replaceAll: unknown store ' + n);
    }
    for (const n of DATA_STORES) {
      if (!counts || typeof counts[n] !== 'number') throw new Error('replaceAll: no count for ' + n);
    }
    return withLink((conn) => new Promise((resolve, reject) => {
      const t = conn.transaction(DATA_STORES, 'readwrite');
      let failure = null;
      const fail = (e) => {
        if (!failure) failure = e || new Error('replaceAll failed');
        try { t.abort(); } catch (_) { /* already aborted */ }
      };
      t.oncomplete = () => (failure ? reject(failure) : resolve(true));
      t.onabort = () => reject(failure || t.error || new Error('Transaction aborted'));
      const fill = () => {
        for (const n of DATA_STORES) {
          const os = t.objectStore(n);
          os.clear().onerror = (ev) => fail(ev.target.error);
          for (const row of (data[n] || [])) os.put(row).onerror = (ev) => fail(ev.target.error);
          const c = os.count();
          c.onsuccess = () => { if (c.result !== counts[n]) fail(new Error('replaceAll: count mismatch in ' + n)); };
        }
      };
      try {
        fill();
      } catch (e) {
        fail(e);
      }
    }));
  },

  // The only call that clears snapshots (used only by "Also delete safety copies").
  clearSnapshots() { return write('snapshots', (os) => os.clear()); },

  // Drop the cached handle so the next call reopens (the store.js write limit, Slice 1).
  resetLink() { _db = null; },

  // Test helpers. Neither changes data.
  // closeForTest closes the live link and keeps the cached handle, so only the
  // error retry can recover.
  closeForTest() { if (_db) _db.close(); },
  // simulateDrop fires a close event on the live link, so only the close
  // listener can recover.
  simulateDrop() { if (_db) _db.dispatchEvent(new Event('close')); },
  // How many times a link was opened and a call was retried (tests read this).
  linkStats() { return { ..._stats }; }
};
