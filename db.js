// db.js - the ONLY file that touches IndexedDB.
// Database "liftlog". Everything the app remembers lives here, on this device only.
// Nothing in here is ever sent anywhere.
//
// Rules (DESIGN 4.2 db.js):
// - Every write resolves only on transaction complete; a request success is never "saved".
// - A lost link is reset and the call is tried once more (close event, or the lost-link errors).
// - replaceAll is one transaction over every store but snapshots, counted inside it.
// - clearSnapshots is the only call that clears snapshots. There is no wipe-all.

const DB_NAME = 'liftlog';
const DB_VERSION = 1;

// Schema 1. All 8 stores exist from the first version, so later slices need no upgrade.
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
const _stats = { opens: 0, retries: 0 };

function open() {
  if (_db) return Promise.resolve(_db);
  if (_versionClosed) return Promise.reject(new Error('Database closed for a newer version'));
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      _openError = e;
      return reject(e);
    }
    req.onupgradeneeded = (ev) => {
      const conn = ev.target.result;
      for (const [name, spec] of Object.entries(STORES)) {
        const store = conn.objectStoreNames.contains(name)
          ? ev.target.transaction.objectStore(name)
          : conn.createObjectStore(name, { keyPath: spec.keyPath });
        for (const [idxName, idxKey] of Object.entries(spec.indexes || {})) {
          if (!store.indexNames.contains(idxName)) store.createIndex(idxName, idxKey);
        }
      }
    };
    req.onsuccess = () => {
      const conn = req.result;
      // The browser can close the link on its own (storage pressure, the app sent
      // to the background). Forget it so the next call reopens.
      conn.addEventListener('close', () => { if (_db === conn) { _db = null; try { conn.close(); } catch (_) { /* gone */ } } });
      conn.onversionchange = () => { conn.close(); _versionClosed = true; if (_db === conn) _db = null; };
      _db = conn;
      _openError = null;
      _stats.opens++;
      resolve(conn);
    };
    req.onerror = () => { _openError = req.error; reject(req.error); };
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
