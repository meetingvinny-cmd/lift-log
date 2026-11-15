// fake_db.js - an in-memory stand-in for db.js with the same calls, for node tests.
// It can be told to fail a write once, to never finish a write, or to throw half way
// through replaceAll. Rows are deep-copied in and out, like IndexedDB does.
// Version 2 upgrade (16 B.6.2): createFakeDb({ version: 1, rows }) holds rows at version 1; the
// first call runs the SAME planUpgrade as db.js with the hook createStore handed in, in one fake
// transaction: all or nothing, so a throw or a count mismatch leaves every row as it was.
import { planUpgrade, DB_VERSION } from '../../../db.js';
const STORES = ['settings', 'exercises', 'templates', 'blocks', 'days', 'sets', 'feedback', 'snapshots'];
const KEY = { settings: 'key' };
const copy = (v) => (v === undefined ? undefined : structuredClone(v));

export function createFakeDb(opts = {}) {
  const data = Object.fromEntries(STORES.map(s => [s, new Map()]));
  for (const [s, rows] of Object.entries(opts.rows || {})) for (const r of rows) data[s].set(r[KEY[s] || 'id'], copy(r));
  let version = opts.version === undefined ? DB_VERSION : opts.version;
  let hook = null, opened = false, openError = null, upgradeFailed = false, versionClosed = false;
  const upgradeSpy = { hookCalls: 0 };
  // The open, run before every call: the upgrade happens once, in one transaction. A failed
  // upgrade fails every later call on this page, as db.js does.
  function ensureOpen() {
    if (opened) return;
    if (upgradeFailed) throw openError;
    if (version === 1) {
      try {
        const rows = Object.fromEntries(STORES.map(s => [s, [...data[s].values()].map(copy)]));
        const { snapshots, ...stores } = rows;
        upgradeSpy.hookCalls++;
        const plan = planUpgrade(stores, snapshots, hook ? (x) => hook(x) : null);
        const staged = Object.fromEntries(STORES.map(s => [s, new Map([...data[s].entries()].map(([k, v]) => [k, copy(v)]))]));
        for (const o of plan.ops) {
          if ('put' in o) staged[o.store].set(keyOf(o.store, o.put), copy(o.put));
          else staged[o.store].delete(o.del);
        }
        for (const [n, want] of Object.entries(plan.counts)) if (staged[n].size !== want) throw new Error('upgrade: count mismatch in ' + n);
        for (const s of STORES) data[s] = staged[s];
      } catch (e) {
        upgradeFailed = true;
        openError = e;
        throw e;
      }
    }
    version = DB_VERSION;
    opened = true;
  }
  const opening = (fn) => { try { ensureOpen(); } catch (e) { return Promise.reject(e); } return fn(); };
  // spy.batchHeld resolves once a batch is held by faults.holdBatch (r4.3 H1).
  let heldNow = null;
  const spy = { replaceAll: 0, clear: 0, batch: 0, put: 0, resetLink: 0, lateStores: [], batchHeld: new Promise((res) => { heldNow = res; }) };
  // passWrites lets the next N commits through untouched before any other fault applies, so a
  // test can make a later write of one call the late one (stage 4 N1: resetDay's reset batch,
  // not its before-reset safety copy).
  // holdBatch holds the next db.batch call until the test calls db.releaseBatch() (r4.3 H1): a
  // test can tap a write while a block update, a Finish day or the seed is half done.
  const faults = { passWrites: 0, failWrites: 0, hangWrites: 0, slowWrites: 0, lateWrites: 0, holdBatch: 0, holdReads: 0, replaceAllThrowAfter: null, onAllMany: null };
  let release = null;
  // holdReads holds the next N reads (get, all, allMany, byIndex, count, setting) until the test
  // calls db.releaseReads() (SB4): a read that never answers inside a whole-database job.
  // spy.readHeld resolves the first time a read is held.
  const heldReads = [];
  let readHeldNow = null;
  spy.readHeld = new Promise((res) => { readHeldNow = res; });
  const read = (fn) => opening(() => readNow(fn));
  const readNow = (fn) => {
    if (faults.holdReads > 0) {
      faults.holdReads--;
      spy.readsHeld = (spy.readsHeld || 0) + 1;
      readHeldNow();
      return new Promise((res, rej) => heldReads.push(() => { try { res(fn()); } catch (e) { rej(e); } }));
    }
    return Promise.resolve().then(fn);
  };
  // A late write is held past the write limit and lands the moment the store resets the link,
  // so the retry reads rows the first try already wrote (review P9).
  const held = [];

  function keyOf(store, row) {
    const k = row[KEY[store] || 'id'];
    if (k === undefined || k === null) throw Object.assign(new Error('no key'), { name: 'DataError' });
    return k;
  }

  // Every write goes through here so faults apply the same way.
  // tag names the stores a write touches; a held write records its tag in spy.lateStores.
  function commit(apply, tag = []) {
    try { ensureOpen(); } catch (e) { return Promise.reject(e); }
    if (faults.passWrites > 0) {
      faults.passWrites--;
      try { apply(); } catch (e) { return Promise.reject(e); }
      return Promise.resolve();
    }
    if (faults.hangWrites > 0) { faults.hangWrites--; return new Promise(() => {}); }
    if (faults.lateWrites > 0) {
      faults.lateWrites--;
      spy.lateStores.push([...new Set(tag)].sort());
      return new Promise((res, rej) => held.push(() => { try { apply(); res(); } catch (e) { rej(e); } }));
    }
    if (faults.failWrites > 0) { faults.failWrites--; return Promise.reject(Object.assign(new Error('write failed'), { name: 'AbortError' })); }
    // A slow write lands 20 ms later, so a later write that does not wait for it lands first.
    if (faults.slowWrites > 0) {
      faults.slowWrites--;
      return new Promise((res, rej) => setTimeout(() => { try { apply(); res(); } catch (e) { rej(e); } }, 20));
    }
    try { apply(); } catch (e) { return Promise.reject(e); }
    return Promise.resolve();
  }

  const db = {
    get _data() { return data; },
    spy, faults, upgradeSpy,
    async ready() { ensureOpen(); return true; },
    setUpgradeHook(fn) { hook = fn; },
    upgradeFailed: () => upgradeFailed,
    versionClosed: () => versionClosed,
    onVersionClosed() {},
    // The version the fake db is at (1 until an upgrade commits).
    version: () => version,
    put(store, row) { spy.put++; return commit(() => data[store].set(keyOf(store, row), copy(row)), [store]); },
    get(store, key) { return read(() => copy(data[store].get(key))); },
    all(store) { return read(() => [...data[store].values()].map(copy)); },
    // One read of several stores, all at the same moment (db.js does it in one transaction).
    allMany(stores) {
      return read(() => {
        spy.allMany = (spy.allMany || 0) + 1;
        const out = Object.fromEntries(stores.map(s => [s, [...data[s].values()].map(copy)]));
        if (faults.onAllMany) faults.onAllMany();
        return out;
      });
    },
    byIndex(store, index, value) { return read(() => [...data[store].values()].filter(r => r[index] === value).map(copy)); },
    count(store) { return read(() => data[store].size); },
    distinctKeys(store, index) { return read(() => [...new Set([...data[store].values()].map(r => r[index]))].sort()); },
    del(store, key) { return commit(() => data[store].delete(key)); },
    setting(key, fallback) { return read(() => { const r = data.settings.get(key); return r === undefined ? fallback : copy(r.value); }); },
    setSetting(key, value) { return this.put('settings', { key, value }); },
    batch(ops) {
      spy.batch++;
      const go = () => commit(() => {
        // All or nothing: every key is checked before the first row is applied.
        const ready = ops.map(o => ('put' in o) ? [o.store, keyOf(o.store, o.put), copy(o.put)] : [o.store, o.del, undefined]);
        for (const [s, k, v] of ready) { if (v === undefined) data[s].delete(k); else data[s].set(k, v); }
      }, ops.map(o => o.store));
      if (faults.holdBatch > 0) {
        faults.holdBatch--;
        const wait = new Promise((res) => { release = res; });
        // LN3: re-arm batchHeld for the next hold before this one resolves, so a second whileHeld
        // on the same db waits for its own hold and never runs on the first hold's promise.
        const now = heldNow;
        spy.batchHeld = new Promise((res) => { heldNow = res; });
        spy.holding = true;
        now();
        return wait.then(go);
      }
      return go();
    },
    // Lets every held read answer, with the rows as they are now (SB4).
    releaseReads() { for (const go of heldReads.splice(0)) go(); },
    // Lets the held batch go on (r4.3 H1).
    releaseBatch() { const r = release; release = null; spy.holding = false; if (r) r(); },
    // db.js drops its live link here; the fake records a drop made while a batch is held (SR15).
    closeForTest() { spy.closeForTest = (spy.closeForTest || 0) + 1; if (release) spy.closedWhileHeld = true; },
    replaceAll(rows, counts) {
      spy.replaceAll++;
      return commit(() => {
        const names = STORES.filter(s => s !== 'snapshots');
        const staged = {};
        let done = 0;
        for (const s of names) {
          spy.clear++;
          staged[s] = new Map();
          for (const r of (rows[s] || [])) {
            if (faults.replaceAllThrowAfter !== null && done >= faults.replaceAllThrowAfter) {
              faults.replaceAllThrowAfter = null;
              throw new Error('replaceAll stopped half way');
            }
            staged[s].set(keyOf(s, r), copy(r));
            done++;
          }
          if (staged[s].size !== counts[s]) throw new Error('replaceAll: count mismatch in ' + s);
        }
        for (const s of names) data[s] = staged[s];
      });
    },
    // db.js deleteBlockRows (17 C.3.2): one all-or-nothing delete of a block, its days and sets by
    // block id, the named feedback rows and the settings puts; counts checked before anything lands.
    deleteBlockRows(blockId, feedbackIds, counts, settingsPuts) {
      spy.deleteBlockRows = (spy.deleteBlockRows || 0) + 1;
      return commit(() => {
        const staged = Object.fromEntries(['blocks', 'days', 'sets', 'feedback', 'settings'].map(s => [s, new Map([...data[s].entries()])]));
        staged.blocks.delete(blockId);
        for (const [k, r] of data.days) if (r.block_id === blockId) staged.days.delete(k);
        for (const [k, r] of data.sets) if (r.block_id === blockId) staged.sets.delete(k);
        for (const k of (feedbackIds || [])) staged.feedback.delete(k);
        for (const r of (settingsPuts || [])) staged.settings.set(keyOf('settings', r), copy(r));
        for (const n of ['blocks', 'days', 'sets', 'feedback']) if (staged[n].size !== counts[n]) throw new Error('deleteBlockRows: count mismatch in ' + n);
        for (const [s, m] of Object.entries(staged)) data[s] = m;
      }, ['blocks', 'days', 'sets', 'feedback', 'settings']);
    },
    clearSnapshots() { return commit(() => data.snapshots.clear()); },
    resetLink() { spy.resetLink++; for (const land of held.splice(0)) land(); },
    // Deep copy of every store, for before and after compares.
    dump(skip = []) {
      return JSON.stringify(Object.fromEntries(STORES.filter(s => !skip.includes(s)).map(s => [s, [...data[s].entries()].sort((a, b) => String(a[0]) < String(b[0]) ? -1 : 1)])));
    }
  };
  return db;
}

// A fake clock the tests move by hand.
export function fakeClock(startIso) {
  let t = Date.parse(startIso);
  return { now: () => t, set: (iso) => { t = Date.parse(iso); }, add: (ms) => { t += ms; } };
}
