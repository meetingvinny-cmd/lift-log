// store.test.js - whole flows on the fake db with a fake clock (DESIGN 5.7). Run with TZ=America/New_York.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, localDate, NotSaved } from '../../../store.js';
import { buildBackup, validateBackup, validateSnapshotRow } from '../../../backup.js';
import { SEED_EXERCISES, SEED_IDS } from '../../../data/exercises.js';
import { APP_VERSION } from '../../../version.js';
import { createFakeDb, fakeClock } from './fake_db.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const blockV1 = () => JSON.parse(readFileSync(join(FIX, 'block_v1.json'), 'utf8'));
const MIN = 60000, HOUR = 3600000;

function lift(slot, ex, sets, load, more) {
  return { slot, exercise_id: ex, sets, rep_low: 8, rep_high: 12, start_load: load, failure_set: false, reps_left_target: 2, warmups: [], sides: 'none', load_basis: 'total', count_label: null, note: '', ...(more || {}) };
}
const SPEC = () => ({ name: 'Two day', passes: 3, day_templates: [
  { day: 1, label: 'A', lifts: [lift(1, 'leg_press', 2, 150), lift(2, 'lat_pulldown', 2, 100)] },
  { day: 2, label: 'B', lifts: [lift(1, 'chest_press_machine', 2, 80), lift(2, 'leg_extension', 2, 60)] }] });

// The invariant (review P8, closes the class): after every store write of the scripted flows
// the database must be one its own validator accepts, as a backup file and as each safety copy.
// A write that leaves a state the restore would refuse fails the test that made it.
const WRITES = ['seed', 'setSetting', 'createBlock', 'tick', 'untick', 'saveDraft', 'skipSet', 'unskip', 'skipExercise',
  'stopExercise', 'addSet', 'swapExercise', 'saveFeedback', 'saveExerciseText', 'addCustomExercise', 'finishDay',
  'markBackedUp', 'saveSnapshot', 'restoreFile', 'undoSnapshot', 'eraseAll', 'clearSnapshots', 'importBlock',
  'relabelDay', 'addSetBelow', 'deleteSet', 'moveSlot', 'resetDay', 'skipDay', 'saveChecks', 'takeRestoreNote', 'probe'];
const invariant = { checks: 0 };
async function assertRestorable(db, store, clock, after) {
  const file = await store.backupObject();
  const v = validateBackup(JSON.stringify(file), { now: clock.now(), seedIds: SEED_IDS });
  assert.ok(v.ok, 'after ' + after + ' the backup file is refused: ' + v.why);
  for (const snap of await db.all('snapshots')) {
    try { validateSnapshotRow(snap, { now: clock.now(), seedIds: SEED_IDS }); }
    catch (e) { assert.fail('after ' + after + ' safety copy ' + snap.id + ' is refused: ' + e.message); }
  }
  invariant.checks++;
}
function guarded(db, store, clock) {
  for (const name of WRITES) {
    const fn = store[name];
    store[name] = async (...a) => { const r = await fn(...a); await assertRestorable(db, store, clock, name); return r; };
  }
  return store;
}

async function setup(start, extra) {
  const db = createFakeDb();
  const clock = fakeClock(start || '2026-11-02T18:00:00-05:00');
  const store = guarded(db, createStore({ db, now: clock.now, writeLimitMs: 50, ...(extra || {}) }), clock);
  await store.seed();
  return { db, clock, store };
}
const V = (load, reps) => ({ load, reps, reps_left: 2, reps_left_plus: false, failure: false });

async function logDay(store, clock, values) {
  const day = await store.currentDay();
  const v = await store.dayView(day.id);
  for (const s of v.sets) { clock.add(MIN); await store.tick(s.id, values ? values(s) : V(s.target.load, 10)); }
  clock.add(MIN);
  await store.finishDay(day.id);
  clock.add(2 * 24 * HOUR);
  return day;
}

test('create a block by spec: block, round 1 days and sets, active', async () => {
  const { db, store } = await setup();
  const b = await store.createBlock(SPEC());
  assert.match(b.id, /^b[0-9a-f-]{36}$/);
  assert.equal(b.profile, 'fixed');
  assert.equal(await db.setting('active_block_id'), b.id);
  const days = await db.all('days');
  assert.deepEqual(days.map(d => d.id).sort(), [b.id + ':p1:d1', b.id + ':p1:d2']);
  assert.equal((await db.all('sets')).length, 8);
});

test('the first saved tick opens the day; viewing Today does not', async () => {
  const { db, clock, store } = await setup();
  await store.createBlock(SPEC());
  const day = await store.currentDay();
  await store.dayView(day.id);
  assert.equal((await db.get('days', day.id)).status, 'planned');
  const v = await store.dayView(day.id);
  await store.tick(v.sets[0].id, V(150, 10));
  const d = await db.get('days', day.id);
  assert.equal(d.status, 'open');
  assert.equal(d.started_at, clock.now());
  clock.add(MIN);
  await store.tick(v.sets[1].id, V(150, 9));
  assert.equal((await db.get('days', day.id)).started_at, clock.now() - MIN, 'started_at never changes');
});

test('a new store instance on the same db sees every tick (M12)', async () => {
  const { db, clock, store } = await setup();
  await store.createBlock(SPEC());
  const day = await store.currentDay();
  const v = await store.dayView(day.id);
  for (const s of v.sets.slice(0, 3)) { clock.add(MIN); await store.tick(s.id, V(150, 10)); }
  const fresh = createStore({ db, now: clock.now });
  const v2 = await fresh.dayView(day.id);
  assert.equal(v2.sets.filter(s => s.status === 'done').length, 3);
});

test('a write that fails once ends Done after the retry; one that never completes is Not saved', async () => {
  const { db, store } = await setup();
  await store.createBlock(SPEC());
  const v = await store.dayView((await store.currentDay()).id);
  db.faults.failWrites = 1;
  await store.tick(v.sets[0].id, V(150, 10));
  assert.equal((await db.get('sets', v.sets[0].id)).status, 'done');
  assert.ok(db.spy.resetLink >= 1, 'the link was reset before the retry');
  db.faults.hangWrites = 2;
  await assert.rejects(store.tick(v.sets[1].id, V(150, 10)), NotSaved);
  assert.equal((await db.get('sets', v.sets[1].id)).status, 'planned');
});

test('two quick taps on one row are written in tap order', async () => {
  const { db, clock, store } = await setup();
  await store.createBlock(SPEC());
  const v = await store.dayView((await store.currentDay()).id);
  const id = v.sets[0].id;
  const a = store.saveDraft(id, { load: 155 });
  clock.add(10);
  const b = store.saveDraft(id, { load: 160 });
  await Promise.all([a, b]);
  assert.equal((await db.get('sets', id)).draft.load, 160);
});

test('add, skip, swap, undo and skip set', async () => {
  const { db, clock, store } = await setup();
  await store.createBlock(SPEC());
  const day = await store.currentDay();
  const [added] = await store.addSet(day.id, 1);
  const a = await db.get('sets', added);
  assert.equal(a.origin, 'added');
  assert.equal(a.status, 'planned');
  assert.equal(a.set_n, 3);
  const v = await store.dayView(day.id);
  await store.tick(v.sets[0].id, V(150, 10));
  await store.untick(v.sets[0].id);
  const u = await db.get('sets', v.sets[0].id);
  assert.equal(u.status, 'planned');
  assert.equal(u.done, null);
  // Skip set: the open set (first still planned) is skipped, the draft is cleared, the next one is open.
  await store.saveDraft(v.sets[0].id, { load: 140 });
  const skipped = await store.skipSet(day.id, 1);
  assert.equal(skipped, v.sets[0].id);
  const sk = await db.get('sets', skipped);
  assert.equal(sk.status, 'skipped');
  assert.equal(sk.why, 'Skipped by you');
  assert.equal(sk.draft, null);
  const nextOpen = (await store.dayView(day.id)).sets.find(s => s.slot === 1 && s.status === 'planned');
  assert.equal(nextOpen.id, v.sets[1].id);
  await store.unskip(skipped);
  assert.equal((await db.get('sets', skipped)).status, 'planned');
  assert.equal((await db.get('sets', skipped)).why, 'As written on your block');
  clock.add(MIN);
  const n = await store.skipExercise(day.id, 2);
  assert.equal(n, 2);
});

test('swap after a done set keeps both exercises in flat_log and both feedback rows (M20)', async () => {
  const { db, clock, store } = await setup();
  await store.createBlock(SPEC());
  const day = await store.currentDay();
  const v = await store.dayView(day.id);
  const x = v.sets.find(s => s.slot === 2);
  await store.tick(x.id, V(100, 10));
  await store.saveFeedback(day.id, 2, { pump: 2, soreness: 1, workload: 2, checks: {}, note: '' });
  const ns = await store.swapExercise(day.id, 2, 'cable_row');
  assert.ok(ns !== 2, 'swap never reuses the slot');
  const y = (await store.dayView(day.id)).sets.find(s => s.slot === ns);
  clock.add(MIN);
  await store.tick(y.id, V(90, 10));
  await store.saveFeedback(day.id, ns, { pump: 3, soreness: 1, workload: 2, checks: {}, note: '' });
  clock.add(MIN);
  await store.finishDay(day.id);
  const flat = (await store.backupObject()).flat_log.filter(r => r.status === 'done');
  const names = new Map(SEED_EXERCISES.map(e => [e.id, e.name]));
  assert.ok(flat.some(r => r.lift === names.get('lat_pulldown')), 'the X row is in flat_log');
  assert.ok(flat.some(r => r.lift === names.get('cable_row')), 'the Y row is in flat_log');
  const fb = await db.byIndex('feedback', 'day_id', day.id);
  assert.equal(fb.length, 2);
});

test('re-plan never writes over an added logged set, a skipped set or a draft (M16)', async () => {
  const { db, clock, store } = await setup();
  await store.createBlock(SPEC());
  const day1 = await store.currentDay();
  const b = await store.activeBlock();
  const d2 = b.id + ':p1:d2';
  // On planned day 2: skip one set, add and log nothing yet, type a draft on another.
  const day2Sets = (await store.dayView(d2)).sets;
  await store.skipSet(d2, 1);
  const skippedId = day2Sets.find(s => s.slot === 1).id;
  const draftId = day2Sets.find(s => s.slot === 2).id;
  await store.saveDraft(draftId, { load: 66 });
  // Day 1: add a set and log it, then finish (which re-plans day 2).
  const [added] = await store.addSet(day1.id, 1);
  await store.tick(added, V(150, 8));
  clock.add(MIN);
  await store.finishDay(day1.id);
  assert.equal((await db.get('sets', skippedId)).status, 'skipped', 'the skipped set survives a re-plan');
  assert.equal((await db.get('sets', draftId)).draft.load, 66, 'the draft survives a re-plan');
  assert.equal((await db.get('sets', added)).status, 'done', 'the added logged set survives');
});

test('Finish day: leftovers become skipped Not done, the next day is planned', async () => {
  const { db, clock, store } = await setup();
  const b = await store.createBlock(SPEC());
  const day = await store.currentDay();
  const v = await store.dayView(day.id);
  await store.tick(v.sets[0].id, V(150, 10));
  clock.add(MIN);
  const next = await store.finishDay(day.id);
  assert.deepEqual(next, { pass: 1, day: 2 });
  const left = (await db.byIndex('sets', 'day_id', day.id)).filter(s => s.status === 'skipped');
  assert.equal(left.length, 3);
  assert.ok(left.every(s => s.why === 'Not done'));
  assert.equal((await db.get('days', day.id)).status, 'done');
  assert.equal((await store.currentDay()).id, b.id + ':p1:d2');
  await logDay(store, clock);
  const p2 = await store.currentDay();
  assert.equal(p2.id, b.id + ':p2:d1', 'round 2 day 1 is planned after round 1');
  assert.equal((await db.byIndex('sets', 'day_id', p2.id)).length, 4);
});

test('done_date is the local date of started_at (M24)', async () => {
  for (const [start, end, want] of [
    ['2026-11-09T23:30:00-05:00', '2026-11-10T00:40:00-05:00', '2026-11-09'],
    ['2026-11-09T18:00:00-05:00', '2026-11-10T09:00:00-05:00', '2026-11-09']]) {
    const { db, clock, store } = await setup(start);
    await store.createBlock(SPEC());
    const day = await store.currentDay();
    await store.tick((await store.dayView(day.id)).sets[0].id, V(150, 10));
    clock.set(end);
    await store.finishDay(day.id);
    assert.equal((await db.get('days', day.id)).done_date, want, start + ' to ' + end);
  }
  assert.equal(localDate(Date.parse('2026-11-10T03:30:00Z')), '2026-11-09');
});

test('the 12-hour card shows at 13 hours, not 11', async () => {
  const { clock, store } = await setup();
  await store.createBlock(SPEC());
  const day = await store.currentDay();
  await store.tick((await store.dayView(day.id)).sets[0].id, V(150, 10));
  clock.add(11 * HOUR);
  assert.equal(store.isStale(await store.openDay()), false);
  clock.add(2 * HOUR);
  assert.equal(store.isStale(await store.openDay()), true);
});

test('lastTime: latest earlier done day by position, never by time', async () => {
  const { db, clock, store } = await setup();
  const b = await store.createBlock(SPEC());
  const d1 = await logDay(store, clock, (s) => V(s.target.load, s.set_n === 1 ? 11 : 10));
  await logDay(store, clock);
  const p2d1 = await store.currentDay();
  const last = await store.lastTime('leg_press', p2d1.id);
  assert.deepEqual(last.map(s => [s.day_id, s.set_n, s.done.reps]), [[d1.id, 1, 11], [d1.id, 2, 10]]);
  // A later done_at at an earlier position changes nothing; moving the clock back changes nothing.
  const row = await db.get('days', d1.id);
  await db.put('days', { ...row, done_at: clock.now() + 99 * HOUR });
  assert.equal((await store.lastTime('leg_press', p2d1.id))[0].day_id, d1.id);
  clock.add(-30 * 24 * HOUR);
  assert.equal((await store.lastTime('leg_press', p2d1.id))[0].day_id, d1.id);
  // A skipped day (no done sets of it) is passed over.
  assert.equal((await store.lastTime('chest_press_machine', b.id + ':p2:d2')).length, 2);
});

test('since last set is hidden with no done set, a negative result and over 3 hours', async () => {
  const { clock, store } = await setup();
  await store.createBlock(SPEC());
  const day = await store.currentDay();
  assert.equal(await store.sinceLastSet(day.id), null);
  await store.tick((await store.dayView(day.id)).sets[0].id, V(150, 10));
  clock.add(2 * MIN + 10000);
  assert.equal(await store.sinceLastSet(day.id), 130000);
  clock.add(-10 * MIN);
  assert.equal(await store.sinceLastSet(day.id), null);
  clock.add(4 * HOUR);
  assert.equal(await store.sinceLastSet(day.id), null);
});

test('restore of an invalid file is refused before any write (M9)', async () => {
  const { db, clock, store } = await setup();
  await store.createBlock(SPEC());
  await logDay(store, clock);
  const before = db.dump();
  const spyBefore = { ...db.spy };
  for (const text of ['{', JSON.stringify({ format: 'liftlog-backup', schema: 9 }), '{"format":"liftlog-backup","schema":1,"counts":{},"stores":{}}']) {
    await assert.rejects(store.restoreFile(text));
  }
  assert.equal(db.dump(), before);
  assert.equal(db.spy.replaceAll, spyBefore.replaceAll, 'replaceAll never called');
  assert.equal(db.spy.clear, spyBefore.clear, 'clear never called');
});

test('restore with replaceAll throwing half way leaves data equal to before', async () => {
  const { db, clock, store } = await setup();
  await store.createBlock(SPEC());
  await logDay(store, clock);
  const file = JSON.stringify(await store.backupObject());
  await logDay(store, clock);
  const before = db.dump(['snapshots']);
  // Every try stops half way (the first try and its one retry, R3).
  const real = db.replaceAll.bind(db);
  db.replaceAll = (rows, counts) => { db.faults.replaceAllThrowAfter = 10; return real(rows, counts); };
  await assert.rejects(store.restoreFile(file), NotSaved);
  assert.equal(db.dump(['snapshots']), before);
});

test('a safety copy is saved before restore; the newest 3 are kept', async () => {
  const { clock, store } = await setup();
  await store.createBlock(SPEC());
  const file = JSON.stringify(await store.backupObject());
  for (let i = 0; i < 5; i++) { clock.add(MIN); await store.restoreFile(file); }
  const snaps = await store.listSnapshots();
  assert.equal(snaps.length, 3);
  assert.ok(snaps.every(s => s.reason === 'before-restore'));
  assert.ok(snaps[0].made_at > snaps[1].made_at);
});

test('the backup badge follows edits and restores (M17)', async () => {
  const { clock, store } = await setup();
  await store.createBlock({ ...SPEC(), passes: null });
  for (let i = 0; i < 8; i++) await logDay(store, clock);
  const file8 = JSON.stringify(await store.backupObject());
  for (let i = 0; i < 2; i++) await logDay(store, clock);
  const b10 = await store.backupObject();
  await store.markBackedUp(Date.parse(b10.exported_at));
  assert.equal(await store.backupDue(), false);
  // An edit to a done set after the backup shows the badge.
  clock.add(MIN);
  const anyDone = (await store.backupObject()).stores.sets.find(s => s.status === 'done');
  await store.untick(anyDone.id);
  assert.equal(await store.backupDue(), true);
  // Restore the 8-day file, finish 2 more days: due.
  clock.add(MIN);
  await store.restoreFile(file8);
  await logDay(store, clock);
  await logDay(store, clock);
  assert.equal(await store.backupDue(), true);
  // Restoring a file newer than the old marker sets the marker to the file: not due.
  clock.add(MIN);
  const latest = JSON.stringify(await store.backupObject());
  const { store: s3, clock: c3 } = await setup('2026-12-30T08:00:00-05:00');
  await s3.markBackedUp(Date.parse('2026-11-01T08:00:00-05:00'));
  c3.add(MIN);
  await s3.restoreFile(latest);
  assert.equal(await s3.backupDue(), false, 'the marker is the file time after a restore');
});

test('undo keeps the badge honest after an erase and after a restore (M17b)', async () => {
  for (const how of ['erase', 'restore']) {
    const { db, clock, store } = await setup();
    await store.createBlock(SPEC());
    await logDay(store, clock);
    const file = JSON.stringify(await store.backupObject());
    const b = await store.backupObject();
    await store.markBackedUp(Date.parse(b.exported_at));
    const marker = await db.setting('last_backup_at');
    clock.add(MIN);
    const done = (await db.all('sets')).find(s => s.status === 'done');
    await store.untick(done.id);
    assert.equal(await store.backupDue(), true);
    clock.add(MIN);
    if (how === 'erase') await store.eraseAll(); else await store.restoreFile(file);
    clock.add(MIN);
    const snap = (await store.listSnapshots())[0];
    await store.undoSnapshot(snap.id);
    assert.equal(await db.setting('last_backup_at'), marker, how + ': marker back to its value before');
    assert.equal(await store.backupDue(), true, how + ': the unbacked edit still shows');
  }
});

test('a new source_id makes a new block and leaves existing rows equal', async () => {
  const { db, clock, store } = await setup();
  await store.createBlock(SPEC());
  await logDay(store, clock);
  const before = JSON.stringify({ days: await db.all('days'), sets: await db.all('sets') });
  const pre = await store.readBlockFile(JSON.stringify(blockV1()));
  assert.equal(pre.kind, 'new');
  assert.equal(pre.otherActive, true);
  const nb = await store.importBlock(JSON.stringify(blockV1()), true);
  const after = { days: (await db.all('days')).filter(d => d.block_id !== nb.id), sets: (await db.all('sets')).filter(s => s.block_id !== nb.id) };
  const old = JSON.parse(before);
  assert.deepEqual(after.days.sort((a, b) => a.id < b.id ? -1 : 1), old.days.sort((a, b) => a.id < b.id ? -1 : 1));
  assert.deepEqual(after.sets.sort((a, b) => a.id < b.id ? -1 : 1), old.sets.sort((a, b) => a.id < b.id ? -1 : 1));
  assert.equal(await db.setting('active_block_id'), nb.id);
  assert.equal((await db.all('blocks')).length, 2);
});

test('block update: logged days kept, the next planned day takes the new load, same version refused', async () => {
  const { db, clock, store } = await setup();
  const nb = await store.importBlock(JSON.stringify(blockV1()), true);
  const d1 = await logDay(store, clock);
  const day1Rows = JSON.stringify((await db.byIndex('sets', 'day_id', d1.id)).sort((a, b) => a.id < b.id ? -1 : 1));
  const v2 = blockV1();
  v2.version = 2;
  v2.block.day_templates[1].lifts[0].start_load = 110;
  const pre = await store.readBlockFile(JSON.stringify(v2));
  assert.equal(pre.kind, 'update');
  assert.ok(pre.changes.some(c => c.kind === 'load' && c.from === 100 && c.to === 110));
  await store.importBlock(JSON.stringify(v2), false);
  assert.equal(JSON.stringify((await db.byIndex('sets', 'day_id', d1.id)).sort((a, b) => a.id < b.id ? -1 : 1)), day1Rows, 'day 1 rows unchanged');
  const d2 = await db.get('sets', nb.id + ':p1:d2:x1:s1:none');
  assert.equal(d2.target.load, 110);
  const again = await store.readBlockFile(JSON.stringify(v2));
  assert.equal(again.ok, false);
  assert.equal(again.code, 'old');
});

test('custom exercise update path keeps phone ids, renames, inserts new ones', async () => {
  const { db, clock, store } = await setup();
  const nb = await store.importBlock(JSON.stringify(blockV1()), true);
  const map1 = (await db.get('blocks', nb.id)).id_map;
  const pId = map1.ex_p, qId = map1.ex_q;
  await logDay(store, clock);
  await logDay(store, clock);
  const v2 = blockV1();
  v2.version = 2;
  v2.exercises[1].name = 'Made-up exercise Q renamed';
  v2.exercises.push({ ...v2.exercises[0], id: 'ex_r', name: 'Made-up exercise R' });
  v2.block.day_templates[1].lifts.push(lift(4, 'ex_r', 2, 20));
  const pre = await store.readBlockFile(JSON.stringify(v2));
  assert.ok(pre.changes.some(c => c.kind === 'newex' && c.name === 'Made-up exercise R'));
  await store.importBlock(JSON.stringify(v2), false);
  const b = await db.get('blocks', nb.id);
  assert.equal(b.id_map.ex_p, pId);
  assert.equal(b.id_map.ex_q, qId);
  assert.match(b.id_map.ex_r, /^c-/);
  assert.equal((await db.get('exercises', qId)).name, 'Made-up exercise Q renamed');
  const ex = await db.all('exercises');
  for (const dt of b.day_templates) for (const l of dt.lifts) assert.ok(ex.some(e => e.id === l.exercise_id), 'every exercise id resolves');
  assert.equal(ex.filter(e => e.custom).length, 3, 'no duplicate custom row');
  const cur = await store.currentDay();
  // Last time for Q still finds its v1 sets, under the same phone id (C14).
  const qLast = await store.lastTime(qId, cur.id);
  assert.ok(qLast.length > 0, 'Last time for Q finds its v1 sets');
  assert.ok(qLast.every(x => x.exercise_id === qId), 'every row is Q under its phone id');
  assert.ok(qLast.every(x => x.day_id === nb.id + ':p1:d2'), 'the rows come from the day logged under v1');
  // A v3 that names a file-local id known nowhere is refused, nothing changes.
  const v3 = structuredClone(v2);
  v3.version = 3;
  v3.block.exercise_flags.ex_zz = { no_added_sets: false, left_out_of_builder: false };
  const before = db.dump();
  const r = await store.readBlockFile(JSON.stringify(v3));
  assert.equal(r.ok, false);
  await assert.rejects(store.importBlock(JSON.stringify(v3), false));
  assert.equal(db.dump(), before);
});

test('a block update never re-plans a day he started typing on', async () => {
  const { db, store } = await setup();
  const nb = await store.importBlock(JSON.stringify(blockV1()), true);
  const id = nb.id + ':p1:d2:x1:s1:none';
  await store.saveDraft(id, { load: 105 });
  const v2 = blockV1();
  v2.version = 2;
  v2.block.day_templates[1].lifts[0].start_load = 120;
  const pre = await store.readBlockFile(JSON.stringify(v2));
  assert.deepEqual(pre.keepDraft, ['B']);
  await store.importBlock(JSON.stringify(v2), false);
  const s = await db.get('sets', id);
  assert.equal(s.draft.load, 105);
  assert.equal(s.target.load, 100);
});

test('first_done_at is set by the first tick and never changed after', async () => {
  const { db, clock, store } = await setup();
  await store.createBlock(SPEC());
  const v = await store.dayView((await store.currentDay()).id);
  const id = v.sets[0].id;
  await store.tick(id, V(150, 10));
  const first = (await db.get('sets', id)).first_done_at;
  clock.add(MIN); await store.untick(id);
  clock.add(MIN); await store.tick(id, V(155, 9));
  clock.add(MIN); await store.tick(id, V(160, 9));
  assert.equal((await db.get('sets', id)).first_done_at, first);
});

test('seed: skips an edited row, runs once per version, comes back after Erase all', async () => {
  const { db, clock, store } = await setup();
  const e = await db.get('exercises', 'leg_press');
  await db.put('exercises', { ...e, name: 'My press', edited: true });
  await db.setSetting('seeded_version', '0.0.1');
  assert.equal(await store.seed(), true);
  assert.equal((await db.get('exercises', 'leg_press')).name, 'My press');
  assert.equal(await store.seed(), false, 'once per version');
  assert.equal(await db.setting('seeded_version'), APP_VERSION);
  clock.add(MIN);
  await store.eraseAll();
  const fresh = createStore({ db, now: clock.now });
  await fresh.seed();
  const ids = new Set((await db.all('exercises')).map(r => r.id));
  for (const id of SEED_IDS) assert.ok(ids.has(id), 'seed id back after erase: ' + id);
});

test('the list upsert keeps a phone note and link on a seed row and a list row (17 C.2.6)', async () => {
  const { db, store } = await setup();
  assert.equal((await db.all('exercises')).length, SEED_EXERCISES.length, 'every list row written once');
  const listId = SEED_EXERCISES[SEED_EXERCISES.length - 1].id;
  await store.saveExerciseText('leg_press', 'notes', 'seat 4');
  await store.saveExerciseText(listId, 'link', 'https://example.org/a');
  assert.equal((await db.get('exercises', 'leg_press')).edited, false, 'a note never marks a seed row edited');
  assert.equal((await db.get('exercises', listId)).edited, false, 'a link never marks a list row edited');
  await db.setSetting('seeded_version', '0.0.1');
  assert.equal(await store.seed(), true);
  assert.equal((await db.get('exercises', 'leg_press')).notes, 'seat 4', 'the seed row keeps its note');
  assert.equal((await db.get('exercises', listId)).link, 'https://example.org/a', 'the list row keeps its link');
  assert.equal((await db.get('exercises', listId)).flags_set, false);
});

test('restore keeps the phone device keys and takes the marker from the file', async () => {
  const { db, clock, store } = await setup();
  await store.createBlock(SPEC());
  await store.setSetting('theme', 'dark');
  const f = await store.backupObject();
  f.stores.settings = f.stores.settings.map(r => r.key === 'theme' ? { key: 'theme', value: 'light' } : r);
  clock.add(MIN);
  await store.restoreFile(JSON.stringify(f));
  assert.equal(await db.setting('theme'), 'dark');
  assert.equal(await db.setting('last_backup_at'), Date.parse(f.exported_at));
  assert.ok(buildBackup(f.stores, { now: clock.now() }));
});

// ---------------- review fixes ----------------

// A dump with the backup marker row taken out (undo sets the marker on purpose).
// Keys are sorted, because a copy read back through the file check keeps field order of its allow table.
const canon = (v) => Array.isArray(v) ? v.map(canon) : (v && typeof v === 'object') ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
// The marker and the one-shot restore note are phone keys a restore writes on purpose (A3-R8).
const noMarker = (d) => { const o = JSON.parse(d); o.settings = o.settings.filter(([k]) => k !== 'last_backup_at' && k !== 'restore_note'); return JSON.stringify(canon(o)); };
const race = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('still waiting after ' + ms + ' ms')), ms))]);

test('undo saves a safety copy of the current data first, so an undo can be undone (C1)', async () => {
  const { db, clock, store } = await setup();
  await store.createBlock(SPEC());
  await logDay(store, clock);
  const old = db.dump(['snapshots']);
  clock.add(MIN);
  await store.eraseAll();
  await store.seed();   // the app reloads after an erase, and the boot seeds again
  // After the erase he builds again and logs a set he never backed up.
  clock.add(MIN);
  await store.createBlock(SPEC());
  const v = await store.dayView((await store.currentDay()).id);
  clock.add(MIN);
  await store.tick(v.sets[0].id, V(150, 7));
  const afterErase = db.dump(['snapshots']);
  clock.add(MIN);
  const eraseCopy = (await store.listSnapshots()).find(x => x.reason === 'before-erase');
  await store.undoSnapshot(eraseCopy.id);
  assert.equal(noMarker(db.dump(['snapshots'])), noMarker(old), 'undo brings the old data back');
  const newest = (await store.listSnapshots())[0];
  assert.equal(newest.reason, 'before-undo', 'the newest copy is the one made by the undo');
  clock.add(MIN);
  await store.undoSnapshot(newest.id);
  assert.equal(noMarker(db.dump(['snapshots'])), noMarker(afterErase), 'undoing the undo brings back the set logged after the erase');
});

test('a backup reads every store at once and takes its time before the read (C2)', async () => {
  const { db, clock, store } = await setup();
  await store.createBlock(SPEC());
  const t0 = clock.now();
  const calls = db.spy.allMany || 0;
  db.faults.onAllMany = () => clock.add(5000);
  const b = await store.backupObject();
  db.faults.onAllMany = null;
  assert.equal(db.spy.allMany, calls + 1, 'one read of all 7 stores');
  assert.equal(Date.parse(b.exported_at), t0, 'exported_at is the time before the read, never after it');
});

test('two quick drafts land in tap order even when the first write is slow (C15)', async () => {
  const { db, clock, store } = await setup();
  await store.createBlock(SPEC());
  const v = await store.dayView((await store.currentDay()).id);
  const id = v.sets[0].id;
  db.faults.slowWrites = 1;
  const a = store.saveDraft(id, { load: 155 });
  clock.add(10);
  const b = store.saveDraft(id, { load: 160 });
  await Promise.all([a, b]);
  assert.equal((await db.get('sets', id)).draft.load, 160, 'the second tap is the one kept');
});

test('a draft, a skip or Finish day queued behind a slow tick never undoes it (C3, C36, C37)', async () => {
  for (const after of ['draft', 'skip', 'finish']) {
    const { db, store } = await setup();
    await store.createBlock(SPEC());
    const day = await store.currentDay();
    const v = await store.dayView(day.id);
    const id = v.sets[0].id;
    db.faults.slowWrites = 1;
    const t = store.tick(id, V(150, 10));
    const other = after === 'draft' ? store.saveDraft(id, { load: 99 })
      : after === 'skip' ? store.skipSet(day.id, 1)
        : (async () => { await Promise.resolve(); return store.finishDay(day.id); })();
    await Promise.allSettled([t, other]);
    const s = await db.get('sets', id);
    assert.equal(s.status, 'done', after + ': the ticked set is still done');
    assert.equal(s.done.load, 150, after + ': its logged values are kept');
    if (after === 'skip') assert.equal((await db.get('sets', v.sets[1].id)).status, 'skipped', 'skip took the next planned set');
  }
});

test('Finish day is refused on a day he never started, and on a fully skipped day (C34, R4-02)', async () => {
  const { db, store } = await setup();
  await store.createBlock(SPEC());
  const day = await store.currentDay();
  const before = db.dump();
  await assert.rejects(store.finishDay(day.id), /day is not open/);
  assert.equal(db.dump(), before, 'nothing changed');
  await store.skipExercise(day.id, 1);
  await store.skipExercise(day.id, 2);
  const skipped = db.dump();
  // R4-02 (review R44): a day with zero done sets is never finished; Skip day ends it.
  await assert.rejects(store.finishDay(day.id), /no done set/);
  assert.equal(db.dump(), skipped, 'nothing changed');
  assert.equal((await db.get('days', day.id)).status, 'planned');
});

test('Finish day on a write that never completes ends Not saved, the day stays open (C35)', async () => {
  const { db, store } = await setup();
  await store.createBlock(SPEC());
  const day = await store.currentDay();
  await store.tick((await store.dayView(day.id)).sets[0].id, V(150, 10));
  db.faults.hangWrites = 2;
  await assert.rejects(race(store.finishDay(day.id), 3000), NotSaved);
  assert.equal((await db.get('days', day.id)).status, 'open');
  db.faults.hangWrites = 0;
  db.faults.hangWrites = 2;
  await assert.rejects(race(store.saveExerciseText('leg_press', 'notes', 'x'), 3000), NotSaved);
  assert.equal(store.busy(), false, 'no write is left counted as running');
});

test('re-plan never writes over a set he added or a swap he made on a day not started (C4)', async () => {
  const { db, store } = await setup();
  const nb = await store.importBlock(JSON.stringify(blockV1()), true);
  const dB = nb.id + ':p1:d2';
  const [added] = await store.addSet(dB, 1);
  const newSlot = await store.swapExercise(dB, 3, 'cable_row');
  const v2 = blockV1();
  v2.version = 2;
  v2.block.day_templates[1].lifts[0].sets = 4;
  v2.block.day_templates[1].lifts.push(lift(newSlot, 'leg_extension', 2, 30));
  await store.importBlock(JSON.stringify(v2), false);
  const a = await db.get('sets', added);
  assert.equal(a.origin, 'added', 'the added set is still his');
  assert.equal(a.why, 'Added by you');
  const sw = (await db.byIndex('sets', 'day_id', dB)).filter(s => s.slot === newSlot);
  assert.ok(sw.length > 0 && sw.every(s => s.exercise_id === 'cable_row' && s.origin === 'added'), 'the swap is still his');
});

test('lastTime: the latest earlier done day by position wins, a skipped day is passed over, L before R (C13)', async () => {
  const { db, clock, store } = await setup();
  const spec = { name: 'Three day', passes: 2, day_templates: [
    { day: 1, label: 'A', lifts: [lift(1, 'leg_press', 2, 150), lift(2, 'lat_pulldown', 2, 100, { sides: 'LR' })] },
    { day: 2, label: 'B', lifts: [lift(1, 'leg_press', 2, 160)] },
    { day: 3, label: 'C', lifts: [lift(1, 'leg_press', 2, 170), lift(2, 'leg_extension', 2, 60)] }] };
  const b = await store.createBlock(spec);
  const dA = await logDay(store, clock, (s) => V(s.target.load, 11));
  const dB = await logDay(store, clock, (s) => V(s.target.load, 9));
  // Day C: leg press all skipped, the rest logged.
  const dC = await store.currentDay();
  await store.skipExercise(dC.id, 1);
  for (const s of (await store.dayView(dC.id)).sets.filter(x => x.status === 'planned')) { clock.add(MIN); await store.tick(s.id, V(60, 10)); }
  clock.add(MIN);
  await store.finishDay(dC.id);
  const p2 = b.id + ':p2:d1';
  const last = await store.lastTime('leg_press', p2);
  assert.deepEqual(last.map(s => [s.day_id, s.done.reps]), [[dB.id, 9], [dB.id, 9]], 'day B wins: C is skipped, B is after A');
  // Day A gets the latest done_at of all: position still decides.
  const rowA = await db.get('days', dA.id);
  await db.put('days', { ...rowA, done_at: clock.now() + 99 * HOUR });
  assert.equal((await store.lastTime('leg_press', p2))[0].day_id, dB.id, 'never by time');
  const lr = await store.lastTime('lat_pulldown', p2);
  assert.deepEqual(lr.map(s => s.set_n + s.side), ['1L', '1R', '2L', '2R'], 'set_n first, then L before R');
});

// ---------------- whole-database writes and the day queues (R3, R4, 2026-11-09) ----------------

test('Finish day tapped while the first tick of the day is still saving finishes the day (R4)', async () => {
  const { db, store } = await setup();
  await store.createBlock(SPEC());
  const day = await store.currentDay();
  const v = await store.dayView(day.id);
  db.faults.slowWrites = 1;
  const t = store.tick(v.sets[0].id, V(150, 10));
  const f = store.finishDay(day.id);
  await t;
  assert.deepEqual(await f, { pass: 1, day: 2 }, 'Finish day is not refused');
  assert.equal((await db.get('days', day.id)).status, 'done');
  assert.equal((await db.get('sets', v.sets[0].id)).status, 'done', 'the tick is kept');
});

test('a restore waits for a slow queued set write, so no old row lands on the restored data (R3)', async () => {
  const { db, store } = await setup();
  await store.createBlock(SPEC());
  const day = await store.currentDay();
  const id = (await store.dayView(day.id)).sets[0].id;
  const file = JSON.stringify(await store.backupObject());
  db.faults.slowWrites = 1;
  const t = store.tick(id, V(150, 10));
  const r = store.restoreFile(file);
  await Promise.allSettled([t, r]);
  await r;
  assert.equal((await db.get('sets', id)).status, 'planned', 'the restored row is the one kept');
  assert.equal((await db.get('days', day.id)).status, 'planned');
  const snap = (await db.all('snapshots')).find(s => s.reason === 'before-restore');
  assert.equal(snap.data.stores.sets.find(s => s.id === id).status, 'done', 'the safety copy holds the tick, so undo brings it back');
});

test('a set write tapped while a restore runs waits for it and lands after it (R3)', async () => {
  const { db, store } = await setup();
  await store.createBlock(SPEC());
  const day = await store.currentDay();
  const id = (await store.dayView(day.id)).sets[1].id;
  const file = JSON.stringify(await store.backupObject());
  // The restore's own write is slow: a draft that does not wait would land first and be wiped.
  const real = db.replaceAll.bind(db);
  db.replaceAll = (rows, counts) => new Promise((res) => setTimeout(res, 30)).then(() => real(rows, counts));
  const r = store.restoreFile(file);
  await Promise.resolve();
  const d = store.saveDraft(id, { load: 99 });
  await Promise.all([r, d]);
  assert.equal((await db.get('sets', id)).draft.load, 99, 'the draft is not wiped by the restore');
});

test('whole-database writes and setSetting get the 4 s limit and one retry (R3)', async () => {
  const { db, store } = await setup();
  await store.createBlock(SPEC());
  const file = JSON.stringify(await store.backupObject());
  const links = db.spy.resetLink;
  db.faults.hangWrites = 1;
  await race(store.restoreFile(file), 3000);
  assert.ok(db.spy.resetLink > links, 'the hung write was retried on a fresh link');
  for (const job of [() => store.restoreFile(file), () => store.eraseAll(), () => store.saveSnapshot('before-upgrade'), () => store.setSetting('unit', 'kg')]) {
    db.faults.hangWrites = 2;
    await assert.rejects(race(job(), 3000), NotSaved);
    db.faults.hangWrites = 0;
  }
  assert.equal(store.busy(), false, 'no write is left counted as running');
  await store.setSetting('unit', 'kg');
  assert.equal(await db.setting('unit'), 'kg');
});

// ---------------- Slice 1 polish pass, step 0 (DESIGN 15 P.3 store row; 14.4 A1-1, A1-5, A2-10, A3-R8; R4-04, R4-05) ----------------

import { effectiveExercise, slotsInOrder } from '../../../store.js';

test('a lift with no rep range plans sets with no goal reps; high with no low is refused (A1-1, R4-05)', async () => {
  const { db, store } = await setup();
  const spec = SPEC();
  spec.day_templates[0].lifts[0] = lift(1, 'leg_press', 2, 150, { rep_low: null, rep_high: null, failure_set: true, reps_left_target: 0 });
  spec.day_templates[0].lifts[1] = lift(2, 'lat_pulldown', 2, 100, { rep_low: 8, rep_high: null });
  await store.createBlock(spec);
  const day = await store.currentDay();
  const sets = (await store.dayView(day.id)).sets;
  assert.ok(sets.filter(s => s.slot === 1).every(s => s.target.rep_low === null && s.target.rep_high === null), 'both null gives no goal reps');
  assert.ok(sets.filter(s => s.slot === 2).every(s => s.target.rep_low === 8 && s.target.rep_high === null), 'an open top stays open');
  const before = db.dump();
  const bad = SPEC();
  bad.day_templates[0].lifts[0].rep_low = null;
  await assert.rejects(store.createBlock(bad), /bad rep range/);
  bad.day_templates[0].lifts[0].rep_low = 13;
  await assert.rejects(store.createBlock(bad), /bad rep range/);
  assert.equal(db.dump(), before, 'a refused block writes nothing');
});

test('swap the second of three exercises: the new one shows second, in the same write (A1-5)', async () => {
  const { db, clock, store } = await setup();
  const spec = { name: 'Three', passes: 1, day_templates: [{ day: 1, label: 'A', lifts: [lift(1, 'leg_press', 2, 150), lift(2, 'lat_pulldown', 2, 100), lift(3, 'leg_extension', 2, 60)] }] };
  await store.createBlock(spec);
  const day = await store.currentDay();
  assert.deepEqual((await store.dayView(day.id)).slots, [1, 2, 3], 'no slot_order: slot number order');
  assert.equal((await db.get('days', day.id)).slot_order, null);
  clock.add(MIN);
  const batches = db.spy.batch;
  const ns = await store.swapExercise(day.id, 2, 'cable_row');
  assert.equal(db.spy.batch, batches + 1, 'the swap and the card order land in one write');
  const v = await store.dayView(day.id);
  assert.deepEqual(v.slots, [1, ns, 3, 2], 'the new exercise shows second; the old card goes after');
  assert.deepEqual((await db.get('days', day.id)).slot_order, [1, ns, 3]);
  // The order survives a backup and a restore.
  const file = JSON.stringify(await store.backupObject());
  clock.add(MIN);
  await store.restoreFile(file);
  assert.deepEqual((await store.dayView(day.id)).slots, [1, ns, 3, 2]);
});

test('slotsInOrder: listed slots first, the rest by number, unknown numbers left out (A1-5)', () => {
  const sets = [1, 2, 3, 4].map(slot => ({ slot }));
  assert.deepEqual(slotsInOrder({ slot_order: null }, sets), [1, 2, 3, 4]);
  assert.deepEqual(slotsInOrder({}, sets), [1, 2, 3, 4], 'an old day with no key reads as null');
  assert.deepEqual(slotsInOrder({ slot_order: [3, 9, 1] }, sets), [3, 1, 2, 4]);
});

test('a restore leaves a restore note in the same write; it is read once, and only within 60 s (A3-R8)', async () => {
  const { db, clock, store } = await setup();
  await store.createBlock(SPEC());
  await logDay(store, clock);
  const file = JSON.stringify(await store.backupObject());
  clock.add(MIN);
  const replaces = db.spy.replaceAll;
  const rows = await store.restoreFile(file);
  assert.equal(db.spy.replaceAll, replaces + 1, 'the note rides in the one replaceAll');
  const note = await db.setting('restore_note', null);
  assert.deepEqual(note, { rows, at: clock.now() });
  clock.add(5000);
  assert.equal(await store.takeRestoreNote(), rows, 'read once');
  assert.equal(await store.takeRestoreNote(), null, 'a second reload shows nothing');
  assert.equal(await db.setting('restore_note', null), null);
  // An old note is dropped unseen.
  clock.add(MIN);
  await store.restoreFile(file);
  clock.add(61000);
  assert.equal(await store.takeRestoreNote(), null, 'a note over 60 s old is dropped');
  assert.equal(await db.setting('restore_note', null), null);
});

test('a failed restore leaves no note (A3-R8)', async () => {
  const { db, clock, store } = await setup();
  await store.createBlock(SPEC());
  await logDay(store, clock);
  const file = JSON.stringify(await store.backupObject());
  clock.add(MIN);
  // Every try stops half way (the first try and its one retry), so the restore ends Not saved.
  const real = db.replaceAll.bind(db);
  db.replaceAll = (rows, counts) => { db.faults.replaceAllThrowAfter = 3; return real(rows, counts); };
  await assert.rejects(store.restoreFile(file), NotSaved);
  assert.equal(await db.setting('restore_note', null), null, 'nothing was changed, so no note');
});

test('effectiveExercise: the block machine flag and steps win over the exercise row (R4-04, R4-06)', async () => {
  const row = SEED_EXERCISES.find(e => e.id === 'leg_press');
  assert.equal(row.machine, true);
  const block = { exercise_flags: { leg_press: { no_added_sets: true, left_out_of_builder: false, machine: false, weight_steps: [10, 15] } } };
  const e = effectiveExercise(block, row);
  assert.equal(e.machine, false, 'the block says not a machine seat');
  assert.deepEqual(e.weight_steps, [10, 15], 'the block steps win');
  assert.equal(e.no_added_sets, true);
  assert.equal(row.machine, true, 'the list row itself is never changed');
  assert.equal(effectiveExercise({ exercise_flags: { leg_press: { no_added_sets: false, left_out_of_builder: false } } }, row).machine, true, 'no machine key: the row wins');
  // An entry screens the exercise (R4-15); a step size comes after the block's own list (r4.1 Q18).
  const listRow = SEED_EXERCISES[SEED_EXERCISES.length - 1];
  assert.equal(listRow.flags_set, false);
  const s1 = effectiveExercise({ exercise_flags: { [listRow.id]: { no_added_sets: false, left_out_of_builder: false, step: 15 } } }, listRow);
  assert.equal(s1.flags_set, true, 'a block entry screens a list row');
  assert.equal(s1.step, 15, 'the block step size');
  assert.equal(s1.weight_steps, null, 'the block step comes before the row list');
  assert.equal(s1.step_default, listRow.step_default, 'the row step_default is kept for the stepper to read (lb only)');
  const s2 = effectiveExercise({ exercise_flags: { [listRow.id]: { no_added_sets: false, left_out_of_builder: false, step: 15, weight_steps: [100, 115] } } }, listRow);
  assert.deepEqual(s2.weight_steps, [100, 115], 'the block list comes before the block step');
  assert.equal(effectiveExercise({ exercise_flags: {} }, row), row, 'no entry: the row as it is');
  assert.equal(effectiveExercise(null, row), row);
  const { store } = await setup();
  assert.equal((await store.effectiveExercise(block, 'leg_press')).machine, false, 'the store call reads the row and applies the block');
});

test('a safety copy with a reason not on the list is never made or undone (A2-10)', async () => {
  const { db, clock, store } = await setup();
  await store.createBlock(SPEC());
  await assert.rejects(store.saveSnapshot('before-x'), /bad reason/);
  assert.equal((await db.all('snapshots')).length, 0);
  await store.saveSnapshot('before-reset');
  const [snap] = await db.all('snapshots');
  assert.equal(snap.reason, 'before-reset');
  assert.equal((await store.readSnapshot(snap.id)).ok, true, 'before-reset is read back');
  await db.put('snapshots', { ...snap, reason: 'before-x' });
  clock.add(MIN);
  assert.equal((await store.readSnapshot(snap.id)).ok, false, 'a copy with another reason is refused');
  await assert.rejects(store.undoSnapshot(snap.id));
});

test('a block check asked on some lifts names them by phone id after import (R13)', async () => {
  const { db, store } = await setup();
  const f = blockV1();
  f.block.checks[0].lifts = ['leg_press', 'ex_p'];
  const b = await store.importBlock(JSON.stringify(f), true);
  const lifts = (await db.get('blocks', b.id)).checks[0].lifts;
  assert.equal(lifts[0], 'leg_press', 'a seed id maps to itself');
  assert.equal(lifts[1], b.id_map.ex_p, 'a file-local id becomes its phone id');
  assert.match(lifts[1], /^c-/);
});

test('Last time shows the done work sets only, never the warm-ups (A2-8)', async () => {
  const { clock, store } = await setup();
  const spec = { name: 'Warm', passes: 2, day_templates: [{ day: 1, label: 'A', lifts: [lift(1, 'leg_press', 3, 150, { warmups: [{ reps: 10, load: 50 }, { reps: 5, load: 100 }] })] }] };
  const b = await store.createBlock(spec);
  await logDay(store, clock);
  const last = await store.lastTime('leg_press', b.id + ':p2:d1');
  assert.equal(last.length, 3, 'the 3 work sets');
  assert.ok(last.every(s => s.kind === 'work'));
});

// ---------------- Slice 1 polish pass, stage 2 (DESIGN 15 P.2) ----------------

test('blank block name gets the default name', async () => {
  const { db, store } = await setup();
  const a = await store.createBlock({ ...SPEC(), name: '' });
  assert.equal((await db.get('blocks', a.id)).name, 'Block 1', 'blank with 0 blocks gives 1');
  const b = await store.createBlock({ ...SPEC(), name: '   ' });
  assert.equal((await db.get('blocks', b.id)).name, 'Block 2', 'spaces count as blank');
  const c = await store.createBlock({ ...SPEC(), name: '' });
  assert.equal((await db.get('blocks', c.id)).name, 'Block 3', 'blocks named for 1 and 2 present gives 3');
  const typed = await store.createBlock({ ...SPEC(), name: 'Block 9' });
  assert.equal((await db.get('blocks', typed.id)).name, 'Block 9', 'a typed name is kept');
  assert.equal(await store.defaultBlockName(), 'Block 5');
});

test('blank block name skips a number another block already uses', async () => {
  const { db, store } = await setup();
  await store.createBlock({ ...SPEC(), name: 'Block 2' });
  const b = await store.createBlock({ ...SPEC(), name: '' });
  assert.equal((await db.get('blocks', b.id)).name, 'Block 3');
});

test('a block file with a blank name gets the default name', async () => {
  const { db, store } = await setup();
  const f = blockV1();
  f.block.name = '';
  const b = await store.importBlock(JSON.stringify(f), true);
  assert.equal((await db.get('blocks', b.id)).name, 'Block 1');
});

test('createBlock refuses a day with no exercise', async () => {
  const { db, store } = await setup();
  const spec = SPEC();
  spec.day_templates[1].lifts = [];
  const before = db.dump();
  await assert.rejects(store.createBlock(spec), (e) => e.name === 'Refused' && e.code === 'empty day');
  assert.equal(db.dump(), before, 'nothing written');
});

test('relabel on an open day writes; an empty label is stored as empty', async () => {
  const { db, clock, store } = await setup();
  await store.createBlock(SPEC());
  const day = await store.currentDay();
  const v = await store.dayView(day.id);
  await store.tick(v.sets[0].id, V(150, 10));
  clock.add(MIN);
  await store.relabelDay(day.id, '  Z ');
  const d = await db.get('days', day.id);
  assert.equal(d.label, 'Z', 'spaces trimmed');
  assert.equal(d.saved_at, clock.now());
  assert.equal(d.status, 'open');
  await store.relabelDay(day.id, '');
  assert.equal((await db.get('days', day.id)).label, '', 'no label is a real choice');
  await assert.rejects(store.relabelDay(day.id, 'TOOLONG'), (e) => e.name === 'Refused' && e.code === 'bad label');
  await assert.rejects(store.relabelDay(day.id, 'A\u0007'), (e) => e.name === 'Refused' && e.code === 'bad label');
});

test('relabel refused on a done day', async () => {
  const { db, clock, store } = await setup();
  await store.createBlock(SPEC());
  const day = await logDay(store, clock);
  const before = db.dump();
  await assert.rejects(store.relabelDay(day.id, 'Z'), (e) => e.name === 'Refused');
  assert.equal(db.dump(), before, 'the db is unchanged');
});

test('a day with no label gives a flat_log row with session null', async () => {
  const { store, clock } = await setup();
  await store.createBlock(SPEC());
  const day = await store.currentDay();
  await store.relabelDay(day.id, '');
  await logDay(store, clock);
  const f = await store.backupObject();
  const rows = f.flat_log.filter(r => r.day === 1 && r.pass === 1);
  assert.ok(rows.length > 0);
  assert.ok(rows.every(r => r.session === null), 'session is null, the day field gives the number');
});

// Three work sets of 100 on day 1 slot 1 (and an LR lift with a warm-up in slot 2), for Parts 6 to 10.
const SPEC3 = () => ({ name: 'Three sets', passes: 2, day_templates: [
  { day: 1, label: 'A', lifts: [lift(1, 'leg_press', 3, 100), lift(2, 'lat_pulldown', 3, 50, { sides: 'LR', warmups: [{ reps: 5, load: 30 }] })] },
  { day: 2, label: 'B', lifts: [lift(1, 'leg_extension', 2, 60)] }] });
async function day3(extra) {
  const ctx = await setup(undefined, extra);
  await ctx.store.createBlock(SPEC3());
  const day = await ctx.store.currentDay();
  const sets = async () => (await ctx.store.dayView(day.id)).sets;
  const one = async (slot, kind, n, side) => (await sets()).find(s => s.slot === slot && s.kind === kind && s.set_n === n && s.side === (side || 'none'));
  return { ...ctx, day, sets, one };
}
const D = (load) => ({ load, reps: null, reps_left: null, reps_left_plus: false, failure: false });

test('weight copy fills later sets; a later edit leaves earlier sets alone (Part 6)', async () => {
  const { store, one } = await day3();
  await store.saveDraft((await one(1, 'work', 1)).id, D(105));
  const s2 = await one(1, 'work', 2), s3 = await one(1, 'work', 3);
  assert.equal(s2.draft.load, 105);
  assert.equal(s3.draft.load, 105);
  assert.equal(s2.draft.from_copy, true, 'a copied draft is marked');
  assert.equal(s2.draft.reps, null, 'a copied draft holds only the load');
  assert.equal(s2.status, 'planned', 'not done');
  assert.equal((await one(1, 'work', 1)).draft.from_copy, false, 'the edited set is not a copy');
});

test('weight copy never goes up', async () => {
  const { store, one } = await day3();
  await store.saveDraft((await one(1, 'work', 2)).id, D(110));
  assert.equal((await one(1, 'work', 1)).draft, null, 'set 1 untouched by a change on set 2');
  assert.equal((await one(1, 'work', 3)).draft.load, 110);
});

test('weight copy never over a typed draft', async () => {
  const { store, one } = await day3();
  await store.saveDraft((await one(1, 'work', 1)).id, D(105));
  await store.saveDraft((await one(1, 'work', 2)).id, D(110));
  await store.saveDraft((await one(1, 'work', 1)).id, D(100));
  assert.equal((await one(1, 'work', 2)).draft.load, 110, 'the typed 110 stays');
  assert.equal((await one(1, 'work', 2)).draft.from_copy, false);
  assert.equal((await one(1, 'work', 3)).draft.load, 100, 'set 3 holds a copy, so it follows set 1 (the 15 Part 6 test row)');
});

test('weight copy reaches past a copied draft but not a typed one; a second change copies again', async () => {
  const { store, one } = await day3();
  await store.saveDraft((await one(1, 'work', 1)).id, D(105));
  await store.saveDraft((await one(1, 'work', 1)).id, D(100));
  assert.equal((await one(1, 'work', 2)).draft.load, 100, 'a later change on set 1 copies again over a copied draft');
  assert.equal((await one(1, 'work', 3)).draft.load, 100);
});

test('weight copy skips done sets, warm-ups and the other side', async () => {
  const { store, one, clock } = await day3();
  const s3 = await one(1, 'work', 3);
  await store.tick(s3.id, V(100, 10));
  clock.add(MIN);
  await store.saveDraft((await one(1, 'work', 1)).id, D(105));
  const done3 = await one(1, 'work', 3);
  assert.equal(done3.status, 'done');
  assert.equal(done3.draft, null, 'a done set untouched');
  assert.equal(done3.done.load, 100);
  // A warm-up never copies and is never a target.
  await store.saveDraft((await one(2, 'warmup', 1, 'L')).id, D(35));
  assert.equal((await one(2, 'work', 1, 'L')).draft, null, 'never from a warm-up');
  await store.saveDraft((await one(2, 'work', 1, 'L')).id, D(55));
  assert.equal((await one(2, 'work', 2, 'L')).draft.load, 55, '1L copies to 2L');
  assert.equal((await one(2, 'work', 3, 'L')).draft.load, 55, '1L copies to 3L');
  assert.equal((await one(2, 'work', 2, 'R')).draft, null, 'never to the R rows');
  assert.equal((await one(2, 'warmup', 1, 'L')).draft.load, 35, 'the warm-up keeps its own value');
});

test('weight copy lands in one batch', async () => {
  const { db, store, one } = await day3();
  const n = db.spy.batch;
  await store.saveDraft((await one(1, 'work', 1)).id, D(105));
  assert.equal(db.spy.batch - n, 1, 'the edit and both copies in one write');
  // A write that fails twice leaves no half copy.
  db.faults.failWrites = 2;
  await assert.rejects(store.saveDraft((await one(1, 'work', 1)).id, D(120)));
  assert.equal((await one(1, 'work', 1)).draft.load, 105);
  assert.equal((await one(1, 'work', 2)).draft.load, 105);
  assert.equal((await one(1, 'work', 3)).draft.load, 105);
});

test('carry-down on: later sets at the old weight follow, a typed one included; a different typed weight stays (Part 7)', async () => {
  const { store, one } = await day3();
  await store.setSetting('carry_down', true);
  await store.saveDraft((await one(1, 'work', 3)).id, D(100));
  await store.saveDraft((await one(1, 'work', 1)).id, D(105));
  assert.equal((await one(1, 'work', 2)).draft.load, 105);
  assert.equal((await one(1, 'work', 3)).draft.load, 105, 'the typed 100 follows when the switch is on');
  assert.equal((await one(1, 'work', 3)).draft.from_copy, false, 'it stays a typed draft');
  await store.saveDraft((await one(1, 'work', 3)).id, D(110));
  await store.saveDraft((await one(1, 'work', 1)).id, D(100));
  assert.equal((await one(1, 'work', 3)).draft.load, 110, 'a typed 110 is not the old weight, so it stays');
});

test('carry-down off keeps a typed value', async () => {
  const { store, one } = await day3();
  await store.saveDraft((await one(1, 'work', 3)).id, D(100));
  await store.saveDraft((await one(1, 'work', 1)).id, D(105));
  assert.equal((await one(1, 'work', 3)).draft.load, 100, 'off: the typed 100 stays');
  assert.equal((await one(1, 'work', 2)).draft.load, 105, 'Part 6 still copies');
});

test('carry-down never changes a done set', async () => {
  const { store, one, clock } = await day3();
  await store.setSetting('carry_down', true);
  await store.tick((await one(1, 'work', 2)).id, V(100, 10));
  clock.add(MIN);
  await store.saveDraft((await one(1, 'work', 1)).id, D(105));
  const s2 = await one(1, 'work', 2);
  assert.equal(s2.status, 'done');
  assert.equal(s2.done.load, 100);
  assert.equal(s2.draft, null);
  assert.equal((await one(1, 'work', 3)).draft.load, 105);
});

test('carry-down travels in the backup, comes back on restore and Erase clears it (Part 7)', async () => {
  const { db, store } = await day3();
  await store.setSetting('carry_down', true);
  const f = await store.backupObject();
  assert.ok(f.stores.settings.some(r => r.key === 'carry_down' && r.value === true));
  await store.eraseAll();
  assert.equal(await db.setting('carry_down', null), null, 'Erase clears it');
  await store.restoreFile(JSON.stringify(f));
  assert.equal(await db.setting('carry_down', null), true, 'a restore brings it back');
});

const ns = (rows, slot, kind) => rows.filter(s => s.slot === slot && s.kind === (kind || 'work')).sort((a, b) => a.set_n - b.set_n || (a.side < b.side ? -1 : 1));

test('add set below moves later set numbers', async () => {
  const { store, one, sets, clock, day } = await day3();
  await store.tick((await one(1, 'work', 1)).id, V(100, 10));   // the day is open
  clock.add(MIN);
  const s1 = await one(1, 'work', 1);
  const [nid] = await store.addSetBelow(s1.id);
  const rows = ns(await sets(), 1);
  assert.deepEqual(rows.map(s => s.set_n), [1, 2, 3, 4], 'no two rows share a number');
  assert.deepEqual(rows.map(s => s.id.split(':').slice(-2, -1)[0]), ['s1', 's4', 's2', 's3'], 'the old ids are kept, the new one takes the next number');
  const n = rows[1];
  assert.equal(n.id, nid);
  assert.equal(n.origin, 'added');
  assert.equal(n.status, 'planned');
  assert.deepEqual(n.target, s1.target);
  assert.equal(n.why, 'Added by you');
  // flat_log set_number follows set_n.
  for (const s of ns(await sets(), 1)) if (s.status === 'planned') { clock.add(MIN); await store.tick(s.id, V(100, 10)); }
  for (const s of (await sets()).filter(x => x.slot !== 1 && x.status === 'planned')) { clock.add(MIN); await store.tick(s.id, V(50, 10)); }
  clock.add(MIN);
  await store.finishDay(day.id);
  const f = await store.backupObject();
  const byId = new Map(f.flat_log.map(r => [r.set_id, r.set_number]));
  assert.equal(byId.get(nid), 2);
  assert.equal(byId.get(day.id + ':x1:s3:none'), 4);
});

test('add set below on an LR lift adds the pair; refused on a planned day and on a no-add exercise', async () => {
  const { db, store, one, sets, clock } = await day3();
  await assert.rejects(store.addSetBelow((await one(1, 'work', 1)).id), (e) => e.name === 'Refused' && e.code === 'day is not open');
  await store.tick((await one(2, 'work', 1, 'L')).id, V(50, 10));
  clock.add(MIN);
  const ids = await store.addSetBelow((await one(2, 'work', 1, 'L')).id);
  assert.equal(ids.length, 2);
  const rows = ns(await sets(), 2);
  assert.deepEqual(rows.map(s => s.set_n + s.side), ['1L', '1R', '2L', '2R', '3L', '3R', '4L', '4R']);
  assert.deepEqual(ns(await sets(), 2, 'warmup').map(s => s.set_n), [1, 1], 'warm-ups keep their own numbers');
  // A block that marks the exercise no_added_sets refuses Add set below and Add set.
  const b = await store.activeBlock();
  await db.put('blocks', { ...b, exercise_flags: { leg_press: { no_added_sets: true, left_out_of_builder: false } } });
  const before = db.dump();
  await assert.rejects(store.addSetBelow((await one(1, 'work', 1)).id), (e) => e.code === 'no added sets');
  await assert.rejects(store.addSet((await one(1, 'work', 1)).day_id, 1), (e) => e.code === 'no added sets');
  assert.equal(db.dump(), before);
});

test('delete a planned set: later numbers move down, a done set refused', async () => {
  const { db, store, one, sets, clock } = await day3();
  const s2 = await one(1, 'work', 2);
  await store.deleteSet(s2.id);
  const rows = ns(await sets(), 1);
  assert.deepEqual(rows.map(s => [s.set_n, s.id.split(':').slice(-2, -1)[0]]), [[1, 's1'], [2, 's3']], 'the old set 3 is now set 2');
  assert.equal((await sets()).length, 3 + 2 + 6 - 1, 'the day has one row less (3 work, 2 warm-up and 6 work rows before)');
  await store.tick(rows[0].id, V(100, 10));
  clock.add(MIN);
  const before = db.dump();
  await assert.rejects(store.deleteSet(rows[0].id), (e) => e.name === 'Refused' && e.code === 'done');
  assert.equal(db.dump(), before);
});

test('delete refused on a done set', async () => {
  const { store, one, clock } = await day3();
  const s1 = await one(1, 'work', 1);
  await store.tick(s1.id, V(100, 10));
  clock.add(MIN);
  await assert.rejects(store.deleteSet(s1.id), (e) => e.name === 'Refused' && e.code === 'done');
  await store.skipSet(s1.day_id, 1);
  await assert.rejects(store.deleteSet((await one(1, 'work', 2)).id), (e) => e.code === 'done', 'a skipped set is refused too');
});

test('delete refused on a typed draft and on the last set', async () => {
  const { store, one, sets } = await day3();
  await store.saveDraft((await one(1, 'work', 3)).id, D(120));
  await assert.rejects(store.deleteSet((await one(1, 'work', 3)).id), (e) => e.code === 'draft');
  await store.deleteSet((await one(1, 'work', 2)).id);
  const left = ns(await sets(), 1);
  assert.equal(left.length, 2);
  await store.saveDraft(left[1].id, { ...D(120), reps: 8 });
  await store.deleteSet(left[0].id);
  await assert.rejects(store.deleteSet(ns(await sets(), 1)[0].id), (e) => e.code === 'draft');
  const { deleteReason } = await import('../../../store.js');
  const only = ns(await sets(), 1);
  assert.equal(deleteReason(only, { ...only[0], draft: null }), 'last', 'the last row of a slot keeps its own reason');
});

test('delete allowed on a copied draft', async () => {
  const { store, one, sets } = await day3();
  await store.saveDraft((await one(1, 'work', 1)).id, D(105));
  assert.equal((await one(1, 'work', 3)).draft.from_copy, true);
  await store.deleteSet((await one(1, 'work', 3)).id);
  assert.equal(ns(await sets(), 1).length, 2);
});

test('delete on an LR lift removes the pair together', async () => {
  const { store, one, sets } = await day3();
  await store.deleteSet((await one(2, 'work', 2, 'R')).id);
  assert.deepEqual(ns(await sets(), 2).map(s => s.set_n + s.side), ['1L', '1R', '2L', '2R']);
  await store.saveDraft((await one(2, 'work', 2, 'L')).id, { ...D(60), reps: 9 });
  await assert.rejects(store.deleteSet((await one(2, 'work', 2, 'R')).id), (e) => e.code === 'draft', 'both rows of the pair must pass');
});

test('Add set after a delete keeps the done row', async () => {
  const { db, store, one, sets, clock } = await day3();
  await store.deleteSet((await one(1, 'work', 2)).id);
  const s3 = ns(await sets(), 1)[1];
  await store.tick(s3.id, V(100, 9));
  clock.add(MIN);
  const before = await db.get('sets', s3.id);
  const [added] = await store.addSet(s3.day_id, 1);
  assert.notEqual(added, s3.id, 'the new id never reuses one that exists');
  assert.deepEqual(await db.get('sets', s3.id), before, 'the done row is unchanged');
  assert.deepEqual(ns(await sets(), 1).map(s => s.set_n), [1, 2, 3]);
});

const SPEC_3SLOTS = () => ({ name: 'Three slots', passes: 2, day_templates: [
  { day: 1, label: 'A', lifts: [lift(1, 'leg_press', 2, 100), lift(2, 'lat_pulldown', 2, 50), lift(3, 'leg_extension', 2, 40)] },
  { day: 2, label: 'B', lifts: [lift(1, 'seated_leg_curl', 2, 60)] }] });

test('move the third card up twice gives 3, 1, 2; Move up on the first refused (Part 11)', async () => {
  const { db, store } = await setup();
  await store.createBlock(SPEC_3SLOTS());
  const day = await store.currentDay();
  await store.moveSlot(day.id, 3, -1);
  assert.deepEqual(await store.moveSlot(day.id, 3, -1), [3, 1, 2]);
  assert.deepEqual((await db.get('days', day.id)).slot_order, [3, 1, 2], 'written to the day');
  assert.deepEqual((await store.dayView(day.id)).slots, [3, 1, 2]);
  const before = db.dump();
  await assert.rejects(store.moveSlot(day.id, 3, -1), (e) => e.name === 'Refused');
  await assert.rejects(store.moveSlot(day.id, 2, 1), (e) => e.name === 'Refused', 'Move down on the last refused');
  assert.equal(db.dump(), before);
  const ids = (await db.all('sets')).map(s => s.id).sort();
  const b = await store.activeBlock();
  assert.deepEqual(b.day_templates[0].lifts.map(l => l.slot), [1, 2, 3], 'the block is never changed');
  assert.equal(ids.length, 8, 'no set changes');
});

test('a swap after a move keeps the new slot in the old slot place (Part 11)', async () => {
  const { store } = await setup();
  await store.createBlock(SPEC_3SLOTS());
  const day = await store.currentDay();
  await store.moveSlot(day.id, 3, -1);
  const ns2 = await store.swapExercise(day.id, 3, 'cable_row');
  assert.deepEqual((await store.dayView(day.id)).slots, [1, ns2, 2, 3]);
});

test('move refused on a done day (Part 11)', async () => {
  const { store, clock } = await setup();
  await store.createBlock(SPEC_3SLOTS());
  const day = await logDay(store, clock);
  await assert.rejects(store.moveSlot(day.id, 2, -1), (e) => e.name === 'Refused');
});

// An open day of the v1 block file (it has a block check, check_a), with 3 done and 1 skipped set.
async function resetCase() {
  const ctx = await setup();
  await ctx.store.importBlock(JSON.stringify(blockV1()), true);
  const day = await ctx.store.currentDay();
  const v = await ctx.store.dayView(day.id);
  const slot1 = v.sets.filter(s => s.slot === v.slots[0]);
  for (const s of slot1.slice(0, 3)) { ctx.clock.add(MIN); await ctx.store.tick(s.id, V(s.target.load, 10)); }
  ctx.clock.add(MIN);
  const skipped = v.sets.find(s => s.slot === v.slots[1] && s.kind === 'work');
  await ctx.store.skipSet(day.id, v.slots[1]);
  return { ...ctx, day, slot1, skipped: (await ctx.store.dayView(day.id)).sets.find(s => s.status === 'skipped') || skipped };
}

test('reset an open day: done sets go back to planned, first_done_at kept, skipped stays, answers cleared but a true check (Part 12)', async () => {
  const { db, store, clock, day, slot1 } = await resetCase();
  const firsts = new Map((await db.byIndex('sets', 'day_id', day.id)).filter(s => s.status === 'done').map(s => [s.id, s.first_done_at]));
  assert.ok(firsts.size >= 2);
  await store.saveFeedback(day.id, slot1[0].slot, { pump: 2, soreness: 1, workload: 3, checks: { check_a: false }, note: 'n' }, false);
  const otherSlot = (await store.dayView(day.id)).slots[2];
  await store.saveFeedback(day.id, otherSlot, { pump: 3, checks: { check_a: true } }, false);
  const started = (await db.get('days', day.id)).started_at;
  clock.add(MIN);
  await store.resetDay(day.id);
  const after = await db.byIndex('sets', 'day_id', day.id);
  for (const [id, first] of firsts) {
    const s = after.find(x => x.id === id);
    assert.equal(s.status, 'planned');
    assert.equal(s.done, null);
    assert.equal(s.draft, null);
    assert.equal(s.first_done_at, first, 'first_done_at kept');
    assert.ok(['As written on your block', 'Added by you'].includes(s.why));
  }
  assert.equal(after.filter(s => s.status === 'skipped').length, 1, 'the skipped set stays skipped');
  const d = await db.get('days', day.id);
  assert.equal(d.status, 'open', 'the day stays open');
  assert.equal(d.started_at, started);
  const fbs = await db.byIndex('feedback', 'day_id', day.id);
  assert.equal(fbs.find(f => f.id === day.id + ':x' + slot1[0].slot), undefined, 'a row left holding nothing is deleted');
  const kept = fbs.find(f => f.id === day.id + ':x' + otherSlot);
  assert.deepEqual(kept.checks, { check_a: true }, 'a check answered true stays true');
  assert.equal(kept.pump, null);
  assert.equal(kept.pending, true, 'the questions are asked again');
});

test('reset keeps a check Yes', async () => {
  const { db, store, day, slot1 } = await resetCase();
  await store.saveFeedback(day.id, slot1[0].slot, { pump: 2, checks: { check_a: true } }, false);
  await store.resetDay(day.id);
  assert.equal((await db.get('feedback', day.id + ':x' + slot1[0].slot)).checks.check_a, true);
  // A later save of the same row with No never clears the Yes (sticky Yes).
  await store.saveFeedback(day.id, slot1[0].slot, { pump: 1, checks: { check_a: false } }, false);
  assert.equal((await db.get('feedback', day.id + ':x' + slot1[0].slot)).checks.check_a, true);
});

test('reset saves a safety copy first', async () => {
  const { db, store, day } = await resetCase();
  const before = (await db.byIndex('sets', 'day_id', day.id)).filter(s => s.status === 'done').map(s => s.id).sort();
  await store.resetDay(day.id);
  const snaps = await store.listSnapshots();
  assert.equal(snaps[0].reason, 'before-reset');
  // Undo of that copy brings the done sets back.
  await store.undoSnapshot(snaps[0].id);
  const back = (await db.byIndex('sets', 'day_id', day.id)).filter(s => s.status === 'done').map(s => s.id).sort();
  assert.deepEqual(back, before);
});

test('reset refused on a planned day, nothing written', async () => {
  const { db, store } = await setup();
  await store.createBlock(SPEC());
  const day = await store.currentDay();
  const before = db.dump();
  await assert.rejects(store.resetDay(day.id), (e) => e.name === 'Refused');
  assert.equal(db.dump(), before, 'no safety copy and no change');
});

// ---------------- Part 15: Skip day (R4-02, review R21, R44, R45) ----------------

test('Skip day skips every planned set', async () => {
  const { db, clock, store } = await setup();
  await store.createBlock(SPEC());
  const day = await store.currentDay();
  const v = await store.dayView(day.id);
  await store.saveDraft(v.sets[0].id, V(155, 9));
  clock.add(MIN);
  const next = await store.skipDay(day.id);
  assert.deepEqual(next, { pass: 1, day: 2 });
  const sets = await db.byIndex('sets', 'day_id', day.id);
  assert.equal(sets.length, 4);
  for (const s of sets) {
    assert.equal(s.status, 'skipped');
    assert.equal(s.why, 'Day skipped');
    assert.equal(s.draft, null, 'the draft is cleared');
  }
  const d = await db.get('days', day.id);
  assert.equal(d.status, 'skipped');
  assert.equal(d.done_at, null);
  assert.equal(d.done_date, null);
  assert.equal(d.saved_at, clock.now());
  const cur = await store.currentDay();
  assert.equal(cur.id, day.id.replace(':d1', ':d2'), 'the next day is planned and is Today');
  assert.equal(cur.status, 'planned');
  const file = await store.backupObject();
  assert.equal(file.flat_log.filter(r => r.set_id.startsWith(day.id + ':')).length, 0, 'a skipped day gives no flat_log row');
  // Last time passes over the skipped day.
  const lt = await store.lastTime('leg_press', cur.id);
  assert.deepEqual(lt, []);
});

test('Skip day refused once a set is done', async () => {
  const { db, store } = await setup();
  await store.createBlock(SPEC());
  const day = await store.currentDay();
  const v = await store.dayView(day.id);
  await store.tick(v.sets[0].id, V(150, 10));
  const before = db.dump();
  await assert.rejects(store.skipDay(day.id), (e) => e.name === 'Refused');
  assert.equal(db.dump(), before, 'nothing changed');
  await assert.rejects(store.skipDay('nope:p1:d1'), (e) => e.name === 'Refused', 'no such day');
});

test('Finish day refused with zero done sets', async () => {
  const { db, store } = await setup();
  await store.createBlock(SPEC());
  const day = await store.currentDay();
  const v = await store.dayView(day.id);
  await store.tick(v.sets[0].id, V(150, 10));
  await store.untick(v.sets[0].id);
  await store.skipExercise(day.id, 1);
  await store.skipExercise(day.id, 2);
  assert.equal((await db.get('days', day.id)).status, 'open', 'an open day with every set skipped');
  const before = db.dump();
  await assert.rejects(store.finishDay(day.id), /no done set/);
  assert.equal(db.dump(), before, 'the fake db deep-equals the before state');
});

test('Skip day on the last day ends the block', async () => {
  const { db, store } = await setup();
  const b = await store.createBlock({ name: 'One', passes: 1, day_templates: [{ day: 1, label: 'A', lifts: [lift(1, 'leg_press', 2, 150)] }] });
  const day = await store.currentDay();
  const next = await store.skipDay(day.id);
  assert.equal(next, null);
  assert.equal((await db.get('blocks', b.id)).status, 'done', 'the block is done');
  assert.equal((await db.all('days')).length, 1, 'no new day exists');
  assert.equal(await store.currentDay(), null, 'Today shows the Block finished state');
});

// ---------------- Part 16: breaks on lap sets (R4-14) ----------------

async function lapsDay() {
  const ctx = await setup();
  await ctx.store.createBlock({ name: 'Carry', passes: 2, day_templates: [{ day: 1, label: 'A',
    lifts: [lift(1, 'leg_press', 3, 50, { rep_low: null, rep_high: null, count_label: 'laps' })] }] });
  const day = await ctx.store.currentDay();
  return { ...ctx, day, sets: (await ctx.store.dayView(day.id)).sets };
}

test('breaks not answered saves null', async () => {
  const { db, store, sets } = await lapsDay();
  await store.tick(sets[0].id, { load: 50, reps: 3, reps_left: null, reps_left_plus: false, failure: false });
  assert.equal((await db.get('sets', sets[0].id)).done.breaks, null, 'not answered is null, never 0');
  await store.saveDraft(sets[1].id, { load: 50, reps: 3 });
  assert.equal((await db.get('sets', sets[1].id)).draft.breaks, null);
});

test('breaks: chip 1 saves 1, 3 or more saves 3, the tick copies the draft, a bad count is refused (Part 16)', async () => {
  const { db, store, sets } = await lapsDay();
  await store.saveDraft(sets[0].id, { load: 50, reps: 3, breaks: 1 });
  const d = await db.get('sets', sets[0].id);
  assert.equal(d.draft.breaks, 1);
  await store.tick(sets[0].id, d.draft);
  const t1 = await db.get('sets', sets[0].id);
  assert.equal(t1.status, 'done', 'a set with breaks still saves as done');
  assert.equal(t1.done.breaks, 1);
  await store.tick(sets[1].id, { load: 50, reps: 3, breaks: 3 });
  assert.equal((await db.get('sets', sets[1].id)).done.breaks, 3, 'three or more is stored as 3');
  const file = await store.backupObject();
  assert.equal(file.flat_log.length, 0, 'the day is not finished yet');
  await store.finishDay(sets[0].day_id);
  const f2 = await store.backupObject();
  assert.deepEqual(f2.flat_log.filter(r => r.status === 'done').map(r => r.breaks), [1, 3], 'the backup flat_log row reads the breaks');
  const { store: s2, sets: other } = await lapsDay();
  for (const bad of [4, -1, 1.5, '1']) await assert.rejects(s2.saveDraft(other[0].id, { load: 50, breaks: bad }), (e) => e.name === 'Refused', String(bad));
});

// ---------------- Part 17: block checks after every set (C38, R4-03) ----------------

async function checkDay() {
  const ctx = await setup();
  await ctx.store.importBlock(JSON.stringify(blockV1()), true);
  const day = await ctx.store.currentDay();
  const v = await ctx.store.dayView(day.id);
  return { ...ctx, day, v, slot: v.slots[0] };
}

test('saveChecks keeps a Yes', async () => {
  const { db, store, day, slot } = await checkDay();
  const id = day.id + ':x' + slot;
  const r1 = await store.saveChecks(day.id, slot, { check_a: false });
  assert.equal(r1.pending, true, 'a new row waits as pending');
  assert.deepEqual((await db.get('feedback', id)).checks, { check_a: false });
  await store.saveChecks(day.id, slot, { check_a: true });
  await store.saveChecks(day.id, slot, { check_a: false });
  assert.equal((await db.get('feedback', id)).checks.check_a, true, 'a later No never clears a Yes');
  await store.saveChecks(day.id, slot, { check_a: null });
  assert.equal((await db.get('feedback', id)).checks.check_a, true, 'nor does a clear');
});

test('saveChecks keeps pump, soreness, workload and the note; a key the block does not ask is refused (Part 17)', async () => {
  const { db, store, day, slot } = await checkDay();
  await store.saveFeedback(day.id, slot, { pump: 2, soreness: 3, workload: 1, note: 'n', checks: {} }, false);
  await store.saveChecks(day.id, slot, { check_a: true });
  const f = await db.get('feedback', day.id + ':x' + slot);
  assert.deepEqual([f.pump, f.soreness, f.workload, f.note, f.pending], [2, 3, 1, 'n', false]);
  assert.equal(f.checks.check_a, true);
  const before = db.dump();
  await assert.rejects(store.saveChecks(day.id, slot, { made_up: true }), (e) => e.name === 'Refused');
  await assert.rejects(store.saveChecks(day.id, slot, { check_a: 'yes' }), (e) => e.name === 'Refused');
  assert.equal(db.dump(), before, 'nothing written');
});

test('saveChecks refused on a done day; a later Finish day sheet save keeps the Yes (Part 17, R20)', async () => {
  const { db, clock, store, day, slot } = await checkDay();
  await store.saveChecks(day.id, slot, { check_a: true });
  await store.saveFeedback(day.id, slot, { pump: 1, checks: { check_a: false } }, false);
  assert.equal((await db.get('feedback', day.id + ':x' + slot)).checks.check_a, true);
  const v = await store.dayView(day.id);
  await store.tick(v.sets[0].id, V(v.sets[0].target.load, 10));
  clock.add(MIN);
  await store.finishDay(day.id);
  await assert.rejects(store.saveChecks(day.id, slot, { check_a: false }), (e) => e.name === 'Refused');
});

// ---------------- Part 14: Day done numbers ----------------

test('day totals leave out a swapped-out slot', async () => {
  const { db, clock, store } = await setup();
  await store.createBlock({ name: 'Four', passes: 2, day_templates: [{ day: 1, label: 'A', lifts: [
    lift(1, 'leg_press', 2, 150), lift(2, 'lat_pulldown', 2, 100), lift(3, 'leg_extension', 2, 60), lift(4, 'seated_leg_curl', 2, 50)] }] });
  const day = await store.currentDay();
  let v = await store.dayView(day.id);
  const of = (sl) => v.sets.filter(s => s.slot === sl);
  for (const s of of(1)) { clock.add(MIN); await store.tick(s.id, V(150, 10)); }
  clock.add(MIN); await store.tick(of(2)[0].id, V(100, 10));
  await store.skipExercise(day.id, 3);
  // Slot 4 is swapped out with none done; its swap-in is done once.
  const newSlot = await store.swapExercise(day.id, 4, 'cable_fly');
  v = await store.dayView(day.id);
  clock.add(MIN); await store.tick(v.sets.find(s => s.slot === newSlot).id, V(20, 12));
  clock.add(MIN); await store.finishDay(day.id);
  const r = await store.dayTotals(day.id);
  assert.equal(r.day.id, day.id);
  assert.deepEqual(r.totals, { workDone: 4, exDone: 3, exSkipped: 1 }, 'slot 3 skipped; the swapped-out slot 4 is not counted');
  assert.equal(await store.dayTotals((await store.currentDay()) ? (await store.currentDay()).id : 'x'), null, 'a day not done gives nothing');
  await assert.rejects(store.dayTotals('__proto__'), (e) => e.name === 'Refused', 'the id is checked');
  void db;
});

// ---------------- polish review fixes, stage 1 ----------------

// G1 (review P8): a block update that drops a lift on a planned day the card order was written on.
async function movedThenDropped(prep) {
  const ctx = await setup();
  const nb = await ctx.store.importBlock(JSON.stringify(blockV1()), true);
  const d1 = nb.id + ':p1:d1';
  await prep(ctx.store, d1);
  const v2 = blockV1();
  v2.version = 2;
  v2.block.day_templates[0].lifts = v2.block.day_templates[0].lifts.filter(l => l.slot !== 3);
  await ctx.store.importBlock(JSON.stringify(v2), false);
  return { ...ctx, d1 };
}

test('a block update that drops a moved lift trims the card order; backup and restore pass (G1, P8)', async () => {
  const { db, clock, store, d1 } = await movedThenDropped(async (s, d1) => {
    assert.deepEqual(await s.moveSlot(d1, 3, -1), [1, 3, 2]);
  });
  assert.equal((await db.byIndex('sets', 'day_id', d1)).filter(s => s.slot === 3).length, 0, 'the dropped lift has no set');
  assert.deepEqual((await db.get('days', d1)).slot_order, [1, 2], 'the card order names only slots that hold a set');
  const file = await store.backupObject();
  const v = validateBackup(JSON.stringify(file), { now: clock.now(), seedIds: SEED_IDS });
  assert.ok(v.ok, 'backup validates: ' + v.why);
  clock.add(MIN);
  await store.restoreFile(JSON.stringify(file));
  assert.deepEqual((await db.get('days', d1)).slot_order, [1, 2], 'the restored day keeps the trimmed order');
});

test('a block update after a swap trims the card order too; the safety copy validates (G1, P8)', async () => {
  let ns = null;
  const { db, clock, store, d1 } = await movedThenDropped(async (s, d1) => { ns = await s.swapExercise(d1, 2, 'cable_row'); });
  assert.deepEqual((await db.get('days', d1)).slot_order, [1, ns], 'the swap card keeps its place, slot 3 is gone');
  clock.add(MIN);
  const snap = await store.saveSnapshot('before-upgrade');
  assert.doesNotThrow(() => validateSnapshotRow(snap, { now: clock.now(), seedIds: SEED_IDS }));
  const r = await store.readSnapshot(snap.id);
  assert.equal(r.ok, true, 'the safety copy reads back');
  clock.add(MIN);
  await store.undoSnapshot(snap.id);
});

test('a block update with the same slots leaves a moved day row as it was (G1, P8)', async () => {
  const { db, store } = await setup();
  const nb = await store.importBlock(JSON.stringify(blockV1()), true);
  const d1 = nb.id + ':p1:d1';
  await store.moveSlot(d1, 3, -1);
  const before = JSON.stringify(await db.get('days', d1));
  const v2 = blockV1();
  v2.version = 2;
  v2.block.day_templates[0].lifts[0].start_load = 160;
  await store.importBlock(JSON.stringify(v2), false);
  assert.equal(JSON.stringify(await db.get('days', d1)), before, 'no day write when the order and label hold');
});

test('the restore check ran after every write of the flows above (G1 class invariant)', () => {
  assert.ok(invariant.checks > 100, 'the invariant ran ' + invariant.checks + ' times');
});

// G13 (review P9): the first try commits after the write limit, right before the retry reads.
// Each write must land once: never a doubled row, never a move undone, never a second skip.
const fixedIds = () => { let n = 0; return () => '00000000-0000-4000-8000-' + String(++n).padStart(12, '0'); };
async function lateCase() {
  const ctx = await setup(null, { uuid: fixedIds() });
  await ctx.store.createBlock(SPEC_3SLOTS());
  const day = await ctx.store.currentDay();
  const v = await ctx.store.dayView(day.id);
  return { ...ctx, day, v };
}
const late = (db) => { db.faults.lateWrites = 1; };

test('late first commit: Add set adds one set (G13, P9)', async () => {
  const { db, store, day } = await lateCase();
  const n0 = (await db.byIndex('sets', 'day_id', day.id)).filter(s => s.slot === 1).length;
  late(db);
  const ids = await store.addSet(day.id, 1);
  assert.equal(db.spy.resetLink, 1, 'the retry ran');
  assert.equal((await db.byIndex('sets', 'day_id', day.id)).filter(s => s.slot === 1).length, n0 + 1, 'one set added');
  assert.equal(ids.length, 1);
  assert.ok(await db.get('sets', ids[0]), 'the ids returned are the ids written');
});

test('late first commit: Add set below adds one set and moves the later numbers once (G13, P9)', async () => {
  const { db, store, day, v } = await lateCase();
  await store.tick(v.sets[0].id, V(100, 10));
  late(db);
  const ids = await store.addSetBelow(v.sets[0].id);
  const rows = ns(await db.byIndex('sets', 'day_id', day.id), 1);
  assert.deepEqual(rows.map(s => s.set_n), [1, 2, 3], 'one new row, numbers moved once');
  assert.equal(rows[1].id, ids[0], 'the new row sits right under the tapped one');
});

test('late first commit: Move up moves once and stays moved (G13, P9)', async () => {
  const { db, store, day } = await lateCase();
  late(db);
  assert.deepEqual(await store.moveSlot(day.id, 3, -1), [1, 3, 2]);
  assert.deepEqual((await db.get('days', day.id)).slot_order, [1, 3, 2], 'the retry never swaps it back');
});

test('late first commit: Swap makes one new card (G13, P9)', async () => {
  const { db, store, day } = await lateCase();
  late(db);
  const ns2 = await store.swapExercise(day.id, 2, 'cable_row');
  const slots = [...new Set((await db.byIndex('sets', 'day_id', day.id)).map(s => s.slot))].sort((a, b) => a - b);
  assert.deepEqual(slots, [1, 2, 3, ns2], 'one swap card, never two');
  assert.deepEqual((await db.get('days', day.id)).slot_order, [1, ns2, 3]);
});

test('late first commit: Skip set skips one set (G13, P9)', async () => {
  const { db, store, day } = await lateCase();
  late(db);
  const id = await store.skipSet(day.id, 1);
  const skipped = (await db.byIndex('sets', 'day_id', day.id)).filter(s => s.status === 'skipped');
  assert.deepEqual(skipped.map(s => s.id), [id], 'only the open row is skipped');
});

test('late first commit: a tick from the draft keeps the draft numbers (G13, P9)', async () => {
  const { db, store, v } = await lateCase();
  await store.saveDraft(v.sets[0].id, { load: 105, reps: 7 });
  late(db);
  await store.tick(v.sets[0].id);
  const s = await db.get('sets', v.sets[0].id);
  assert.equal(s.done.load, 105);
  assert.equal(s.done.reps, 7, 'the retry never puts the target numbers over the draft');
});

test('late first commit: the other writes land once and the same (G13, P9)', async () => {
  // Each one is run with the late fault and without it; the rows must come out the same.
  const flows = {
    deleteSet: async (s, d, v) => s.deleteSet(v.sets[1].id),
    relabelDay: async (s, d) => s.relabelDay(d.id, 'Z'),
    skipDay: async (s, d) => s.skipDay(d.id),
    saveChecks: async (s, d) => s.saveChecks(d.id, 1, {}),
    saveDraft: async (s, d, v) => s.saveDraft(v.sets[0].id, { load: 120 }),
    resetDay: async (s, d, v) => { await s.tick(v.sets[0].id, V(100, 10)); return 'late-next'; },
    markSkipExercise: async (s, d) => s.skipExercise(d.id, 2)
  };
  for (const [name, flow] of Object.entries(flows)) {
    const out = [];
    for (const lateOn of [false, true]) {
      const { db, store, day, v } = await lateCase();
      if (name === 'resetDay') {
        // The first commit inside resetDay is the before-reset safety copy. Let it through so the
        // reset batch itself is the late write (stage 4 N1), and prove which write was held.
        await flow(store, day, v);
        const snaps0 = await db.count('snapshots');
        if (lateOn) { db.faults.passWrites = 1; late(db); }
        await store.resetDay(day.id);
        assert.equal(await db.count('snapshots'), snaps0 + 1, 'one before-reset copy, never two');
        if (lateOn) {
          assert.equal(db.spy.resetLink, 1, 'resetDay: the retry ran');
          assert.equal(db.spy.lateStores.length, 1, 'resetDay: one write was held');
          assert.ok(!db.spy.lateStores[0].includes('snapshots') && db.spy.lateStores[0].includes('days'),
            'resetDay: the held write is the reset batch, not the safety copy');
        }
      }
      else { if (lateOn) late(db); await flow(store, day, v); }
      out.push(db.dump(['snapshots']).replace(/"saved_at":\d+/g, '"saved_at":0'));
    }
    assert.equal(out[1], out[0], name + ' lands the same with a late first commit');
  }
});

test('late first commit: a block update lands once (G13, P9)', async () => {
  const out = [];
  for (const lateOn of [false, true]) {
    const { db, store } = await setup(null, { uuid: fixedIds() });
    await store.importBlock(JSON.stringify(blockV1()), true);
    const v2 = blockV1();
    v2.version = 2;
    v2.block.day_templates[1].lifts[0].start_load = 110;
    if (lateOn) late(db);
    await store.importBlock(JSON.stringify(v2), false);
    out.push(db.dump());
  }
  assert.equal(out[1], out[0]);
});

// ---------------- Polish review fixes, stage 2 (DESIGN 14.8) ----------------

// G9 (review P4, P34): batch() runs checkId on every put and delete id, and resetDay and
// deleteSet write only through it. A row read back from the db with a bad id is refused there.
test('G9 (a): resetDay refuses a feedback row with a bad id; no store but the safety copy changes', async () => {
  const { db, store, day } = await resetCase();
  db._data.feedback.set('bad id', { id: 'bad id', day_id: day.id, block_id: day.block_id, pump: 1, soreness: null, workload: null, note: '', checks: {}, pending: false, saved_at: 1 });
  const before = db.dump(['snapshots']);
  const oldIds = new Set((await db.all('snapshots')).map(s => s.id));
  await assert.rejects(store.resetDay(day.id), (e) => e.name === 'Refused' && e.code === 'bad id');
  assert.equal(db.dump(['snapshots']), before, 'every store but snapshots is unchanged');
  // The reset takes its safety copy before the one write (Part 12), so that copy is the only change.
  const added = (await db.all('snapshots')).filter(s => !oldIds.has(s.id));
  assert.deepEqual(added.map(s => s.reason), ['before-reset'], 'the one new row is the before-reset copy');
});

test('G9 (b): deleteSet refuses on the renumber put of a sibling row with a bad id; every store unchanged', async () => {
  const { db, store, one } = await day3();
  const s2 = await one(1, 'work', 2);
  const s3 = await one(1, 'work', 3);
  db._data.sets.set('bad id', { ...s3, id: 'bad id', set_n: 4 });
  const before = db.dump();
  await assert.rejects(store.deleteSet(s2.id), (e) => e.name === 'Refused' && e.code === 'bad id');
  assert.equal(db.dump(), before, 'every store is unchanged');
});

// G15 (review P12): moveSlot and swapExercise never write a slot_order longer than
// LIMITS.SLOT_ORDER. All-skipped slots go first, from the end; the cut is the last step.
async function longDay() {
  const ctx = await setup();
  const ids = SEED_IDS.slice(0, 60);
  const lifts = ids.slice(0, 30).map((ex, i) => lift(i + 1, ex, 1, 50));
  await ctx.store.createBlock({ name: 'Long day', passes: 2, day_templates: [{ day: 1, label: 'A', lifts }] });
  const day = await ctx.store.currentDay();
  return { ...ctx, day, spare: ids.slice(30) };
}
const keepers = (sets) => [...new Set(sets.filter(s => s.status !== 'skipped').map(s => s.slot))];

test('G15: 30 lifts and 21 swaps, then a Move: the written card order holds at most 50 and every live slot keeps its place; the backup validates', async () => {
  const { db, store, clock, day, spare } = await longDay();
  // Swap the card at position 1 again and again: each swap adds a slot, the old one keeps skipped sets.
  let target = 1;
  for (let k = 0; k < 21; k++) { clock.add(MIN); target = await store.swapExercise(day.id, target, spare[k % spare.length]); }
  const sets = await db.byIndex('sets', 'day_id', day.id);
  assert.equal(new Set(sets.map(s => s.slot)).size, 51, 'the day holds 51 slots');
  const live = (await store.dayView(day.id)).slots.filter(sl => keepers(sets).includes(sl));
  clock.add(MIN);
  const order = await store.moveSlot(day.id, live[5], 1);
  const written = (await db.get('days', day.id)).slot_order;
  assert.deepEqual(written, order);
  assert.ok(written.length <= 50, 'the order holds ' + written.length + ' entries');
  const expectLive = live.slice(); [expectLive[5], expectLive[6]] = [expectLive[6], expectLive[5]];
  assert.deepEqual(written.filter(sl => keepers(sets).includes(sl)), expectLive, 'every slot with a planned or done set keeps its place');
  assert.deepEqual((await store.dayView(day.id)).slots.filter(sl => keepers(sets).includes(sl)), expectLive, 'Today shows them in that order');
  // backupObject is buildBackup over one read of every store.
  const v = validateBackup(JSON.stringify(await store.backupObject()), { now: clock.now(), seedIds: SEED_IDS });
  assert.ok(v.ok, 'buildBackup then validateBackup: ' + v.why);
});

test('G15: 30 lifts and 22 swaps: the swap writes at most 50 entries and the backup validates', async () => {
  const { db, store, clock, day, spare } = await longDay();
  let target = 3;
  for (let k = 0; k < 22; k++) { clock.add(MIN); target = await store.swapExercise(day.id, target, spare[k % spare.length]); }
  const written = (await db.get('days', day.id)).slot_order;
  assert.ok(written.length <= 50, 'the order holds ' + written.length + ' entries');
  const sets = await db.byIndex('sets', 'day_id', day.id);
  const live = keepers(sets);
  assert.equal(live.length, 30);
  assert.ok(live.every(sl => written.includes(sl)), 'every live slot is listed');
  assert.equal(written.indexOf(target), 2, 'the last swap holds the third place');
  const file = await store.backupObject();
  const v = validateBackup(JSON.stringify(file), { now: clock.now(), seedIds: SEED_IDS });
  assert.ok(v.ok, 'the backup validates: ' + v.why);
});

test('a kept lb draft saved after the unit setting moved to kg saves as an lb block (stage 4 N3)', async () => {
  const { blockSpec } = await import('../../../ui/builder.js');
  const { db, store } = await setup();
  const b = { step: 4, name: ' Kept ', notes: '', passes: 2, unit: 'lb',
    days: [{ label: 'A', lifts: [{ exercise_id: 'leg_press', sets: 2, rep_low: 8, rep_high: 12, start_load: 135, failure_set: false, note: '' }] }] };
  await db.setSetting('unit', 'kg');
  await store.createBlock(blockSpec(b));
  const blocks = await db.all('blocks');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].unit, 'lb', 'the block takes the unit the steps were made in');
  // Not read yet: the setting at save time, as before.
  const { db: db2, store: s2 } = await setup();
  await db2.setSetting('unit', 'kg');
  await s2.createBlock(blockSpec({ ...b, unit: null }));
  assert.equal((await db2.all('blocks'))[0].unit, 'kg');
});

// ---------------- r4.3 light pass (DESIGN 14.9 H1): every read that feeds a write runs inside
// the queue or the exclusive job that guards every other write of the rows it puts ----------------

const pause = (ms) => new Promise((r) => setTimeout(r, ms || 5));
// Hold the next batch, run the tap while it is held, then let it go. The tap is made only once
// the batch is held, so the old shape loses the write on every run and the fixed shape never does.
async function whileHeld(db, start, tap) {
  db.faults.holdBatch = 1;
  const first = start();
  // Fail fast, never hang: a write that never reaches db.batch is a failure of this test.
  let timer;
  const limit = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('no batch was held within 1 s')), 1000); });
  first.catch(() => {});
  try { await Promise.race([db.spy.batchHeld, limit]); } finally { clearTimeout(timer); db.faults.holdBatch = 0; }
  const second = tap();
  await pause();
  db.releaseBatch();
  return [await first, await second];
}

test('H1: a tick queued right after a block update starts lands after it and is kept', async () => {
  const { db, store } = await setup(null, { uuid: fixedIds() });
  const nb = await store.importBlock(JSON.stringify(blockV1()), true);
  const id = nb.id + ':p1:d1:x1:s1:none';
  const v2 = blockV1();
  v2.version = 2;
  v2.block.day_templates[0].lifts[0].start_load = 160;
  await whileHeld(db, () => store.importBlock(JSON.stringify(v2), false), () => store.tick(id, V(155, 9)));
  const s = await db.get('sets', id);
  assert.equal(s.status, 'done', 'the tick is kept');
  assert.equal(s.done.load, 155);
  assert.equal(s.done.reps, 9);
  assert.equal(s.target.load, 160, 'the set was planned by v2 before the tick landed');
  assert.equal((await db.get('days', nb.id + ':p1:d1')).status, 'open');
});

test('H1: a Move queued right after a block update starts is kept', async () => {
  const { db, store } = await setup(null, { uuid: fixedIds() });
  const nb = await store.importBlock(JSON.stringify(blockV1()), true);
  const dId = nb.id + ':p1:d1';
  const v2 = blockV1();
  v2.version = 2;
  v2.block.day_templates[0].label = 'Z';
  await whileHeld(db, () => store.importBlock(JSON.stringify(v2), false), () => store.moveSlot(dId, 3, -1));
  const d = await db.get('days', dId);
  assert.equal(d.label, 'Z', 'the update put the day row');
  assert.deepEqual(d.slot_order, [1, 3, 2], 'the Move is kept');
});

test('H1: a late first commit of the update batch lands once', async () => {
  const out = [];
  for (const lateOn of [false, true]) {
    const { db, store } = await setup(null, { uuid: fixedIds() });
    await store.importBlock(JSON.stringify(blockV1()), true);
    const v2 = blockV1();
    v2.version = 2;
    v2.block.day_templates[1].lifts[0].start_load = 110;
    v2.exercises.push({ ...v2.exercises[0], id: 'ex_r', name: 'Made-up exercise R' });
    v2.block.day_templates[1].lifts.push(lift(4, 'ex_r', 2, 20));
    if (lateOn) late(db);
    await store.importBlock(JSON.stringify(v2), false);
    if (lateOn) assert.equal(db.spy.resetLink, 1, 'the retry ran');
    assert.equal((await db.all('blocks')).length, 1, 'one block row');
    assert.equal((await db.all('exercises')).filter(e => e.custom).length, 3, 'no second custom row');
    out.push(db.dump());
  }
  assert.equal(out[1], out[0], 'the dump equals a clean run');
});

test('H1: a new block file not made active is one write and the active block stays', async () => {
  const { db, store } = await setup();
  const first = await store.createBlock(SPEC());
  const b0 = db.spy.batch, p0 = db.spy.put;
  const nb = await store.importBlock(JSON.stringify(blockV1()), false);
  assert.equal(db.spy.batch - b0, 1, 'one batch');
  assert.equal(db.spy.put - p0, 0, 'no second setting write');
  assert.equal(await db.setting('active_block_id'), first.id, 'the active block stays');
  assert.ok(await db.get('blocks', nb.id), 'the new block is saved');
  // With no block active, a new file is made active even when not asked.
  const { db: db2, store: s2 } = await setup();
  const nb2 = await s2.importBlock(JSON.stringify(blockV1()), false);
  assert.equal(await db2.setting('active_block_id'), nb2.id);
});

test('H1: a tick on the next day queued right after Finish day lands after the plan and is kept', async () => {
  const { db, clock, store } = await setup();
  const b = await store.createBlock(SPEC());
  const day = await store.currentDay();
  const v = await store.dayView(day.id);
  for (const s of v.sets) { clock.add(MIN); await store.tick(s.id, V(s.target.load, 10)); }
  clock.add(MIN);
  const nextId = b.id + ':p1:d2:x1:s1:none';
  const [next] = await whileHeld(db, () => store.finishDay(day.id), () => store.tick(nextId, V(85, 8)));
  assert.deepEqual(next, { pass: 1, day: 2 });
  const s = await db.get('sets', nextId);
  assert.equal(s.status, 'done', 'the tick on the next day is kept');
  assert.equal(s.done.load, 85);
  assert.equal((await db.get('days', day.id)).status, 'done');
});

test('H1: a note and a link saved in one tick are both kept', async () => {
  const { db, store } = await setup();
  await Promise.all([store.saveExerciseText('leg_press', 'notes', 'seat 4'), store.saveExerciseText('leg_press', 'link', 'https://example.org/a')]);
  const e = await db.get('exercises', 'leg_press');
  assert.equal(e.notes, 'seat 4');
  assert.equal(e.link, 'https://example.org/a');
});

test('H1: a note saved while the seed runs is kept', async () => {
  const { db, store } = await setup();
  await db.setSetting('seeded_version', '0.0.1');
  const [ran] = await whileHeld(db, () => store.seed(), () => store.saveExerciseText('leg_press', 'notes', 'seat 4'));
  assert.equal(ran, true);
  assert.equal((await db.get('exercises', 'leg_press')).notes, 'seat 4', 'the note is kept');
  assert.equal(await db.setting('seeded_version'), APP_VERSION);
});

test('saveFeedback refuses a slot with no set', async () => {
  const { db, store } = await setup();
  await store.createBlock(SPEC());
  const day = await store.currentDay();
  const before = db.dump();
  await assert.rejects(store.saveFeedback(day.id, 99, {}, false), (e) => e.name === 'Refused' && e.code === 'no slot');
  assert.equal(db.dump(), before, 'nothing written');
});

// ---------------- r4.3 light pass (DESIGN 14.9 H8): named tests for built contract rows ----------------

test('S16: a lift he makes is a custom row a block can use', async () => {
  const { db, clock, store } = await setup();
  const row = await store.addCustomExercise({ name: 'My cable fly', muscle: 'chest', equipment: 'machine' });
  assert.match(row.id, /^c-/);
  assert.equal(row.custom, true);
  assert.equal(row.edited, false);
  assert.equal(row.flags_set, false);
  assert.equal(row.machine, true, 'machine only for machine equipment');
  const free = await store.addCustomExercise({ name: 'My curl', muscle: 'arms', equipment: 'dumbbell' });
  assert.equal(free.machine, false);
  assert.deepEqual((await store.exercisesMap()).get(row.id), row, 'the row is in exercisesMap as saved');
  const b = await store.createBlock({ name: 'Mine', passes: 1, day_templates: [{ day: 1, label: 'A', lifts: [lift(1, row.id, 2, 30)] }] });
  assert.equal((await db.byIndex('sets', 'block_id', b.id)).filter(s => s.exercise_id === row.id).length, 2, 'a block using it saves');
  const v = validateBackup(JSON.stringify(await store.backupObject()), { now: clock.now(), seedIds: SEED_IDS });
  assert.ok(v.ok, 'the backup validates: ' + v.why);
});

test('L07: an each-side lift plans L then R for every set', async () => {
  const { clock, store } = await setup();
  await store.createBlock({ name: 'Sides', passes: 1, day_templates: [{ day: 1, label: 'A', lifts: [lift(1, 'leg_press', 2, 50, { sides: 'LR', load_basis: 'per_side' })] }] });
  const day = await store.currentDay();
  const v = await store.dayView(day.id);
  assert.deepEqual(v.sets.map(s => [s.set_n, s.side]), [[1, 'L'], [1, 'R'], [2, 'L'], [2, 'R']], 'setOrder: 1 L, 1 R, 2 L, 2 R');
  for (const s of v.sets) { clock.add(MIN); await store.tick(s.id, V(50, 10)); }
  clock.add(MIN);
  await store.finishDay(day.id);
  const flat = (await store.backupObject()).flat_log.filter(r => r.set_id.startsWith(day.id));
  assert.deepEqual(flat.map(r => [r.set_number, r.side]), [[1, 'L'], [1, 'R'], [2, 'L'], [2, 'R']], 'each flat_log row keeps its side');
});

// ---------------- r4.3 light pass: the security review fixes (SR rows) ----------------

test('SR1, SR10: a restore file with a far or old exported_at is refused and nothing is written; a bad marker is never stored', async () => {
  const { db, clock, store } = await setup();
  await store.createBlock(SPEC());
  const good = await store.backupObject();
  for (const at of ['2099-01-01T00:00:00Z', '2019-06-01T00:00:00Z']) {
    const before = db.dump();
    await assert.rejects(store.restoreFile(JSON.stringify({ ...good, exported_at: at })), (e) => e.name === 'Refused' && e.code === 'bad');
    assert.equal(db.dump(), before, 'nothing written for ' + at);
  }
  await assert.rejects(store.markBackedUp(Date.parse('2099-01-01T00:00:00Z')), (e) => e.name === 'Refused');
  await assert.rejects(store.markBackedUp(1.5), (e) => e.name === 'Refused');
  assert.equal(await db.setting('last_backup_at', null), null, 'no bad marker stored');
  await store.markBackedUp(clock.now());
  assert.equal(await db.setting('last_backup_at', null), clock.now());
});

test('SR2: a block update whose id_map names a list row leaves that row byte for byte the same', async () => {
  const { db, store } = await setup(null, { uuid: fixedIds() });
  const nb = await store.importBlock(JSON.stringify(blockV1()), true);
  // A crafted phone state (as a crafted backup would leave it): ex_p points at a list row.
  const b = await db.get('blocks', nb.id);
  await db.put('blocks', { ...b, id_map: { ...b.id_map, ex_p: 'leg_press' } });
  const seedBefore = JSON.stringify(await db.get('exercises', 'leg_press'));
  const v2 = blockV1();
  v2.version = 2;
  await store.importBlock(JSON.stringify(v2), false);
  assert.equal(JSON.stringify(await db.get('exercises', 'leg_press')), seedBefore, 'the list row is unchanged');
  const after = await db.get('blocks', nb.id);
  assert.match(after.id_map.ex_p, /^c-/, 'ex_p gets a new custom row');
  assert.equal((await db.get('exercises', after.id_map.ex_p)).custom, true);
});

test('SR5, SR6: createBlock refuses a day label with a tab or another control character and writes nothing; relabelDay uses the same rule', async () => {
  const { db, store } = await setup();
  for (const label of ['A\tB', 'A\u0085', '\u2028', 'A\u000b']) {
    const before = db.dump();
    const spec = SPEC();
    spec.day_templates[1].label = label;
    await assert.rejects(store.createBlock(spec), (e) => e.name === 'Refused' && e.code === 'bad label');
    assert.equal(db.dump(), before, 'stores unchanged for ' + JSON.stringify(label));
  }
  await store.createBlock(SPEC());
  const day = await store.currentDay();
  // relabelDay trims first, so a separator at an end is trimmed away; one in the middle is refused.
  await assert.rejects(store.relabelDay(day.id, 'B\u2029C'), (e) => e.code === 'bad label');
  await assert.rejects(store.relabelDay(day.id, 'B\u0085'), (e) => e.code === 'bad label');
  assert.equal((await db.get('days', day.id)).label, 'A');
});

// A pasted vertical tab and a lone surrogate (built from char codes, so the source holds neither).
const VT = 'a' + String.fromCharCode(0x0b) + 'b', LONE = 'a' + String.fromCharCode(0xd800) + 'b';

test('SR3, SR11: typed text the validator would refuse is refused on every store path and nothing is written', async () => {
  const { db, store } = await setup();
  await store.createBlock(SPEC());
  const day = await store.currentDay();
  const isBad = (e) => e.name === 'Refused' && e.code === 'bad text';
  for (const bad of [VT, LONE]) {
    const before = db.dump();
    await assert.rejects(store.saveExerciseText('leg_press', 'notes', bad), isBad, 'saveExerciseText notes');
    await assert.rejects(store.saveExerciseText('leg_press', 'link', 'https://example.org/' + bad), isBad, 'saveExerciseText link');
    await assert.rejects(store.addCustomExercise({ name: bad, muscle: 'chest', equipment: 'machine' }), isBad, 'addCustomExercise name');
    for (const part of ['name', 'notes', 'note', 'short_note', 'goal_line']) {
      const spec = SPEC();
      if (part === 'name' || part === 'notes') spec[part] = bad;
      else spec.day_templates[0].lifts[0][part] = bad;
      await assert.rejects(store.createBlock(spec), isBad, 'createBlock ' + part);
    }
    await assert.rejects(store.saveFeedback(day.id, 1, { note: bad }, false), isBad, 'saveFeedback note');
    assert.equal(db.dump(), before, 'nothing written');
  }
  await assert.rejects(store.addCustomExercise({ name: '', muscle: 'chest', equipment: 'machine' }), isBad, 'an empty name');
  // The same text without the bad character saves on every path.
  await store.saveExerciseText('leg_press', 'notes', 'seat 4\ttwo');
  await store.saveFeedback(day.id, 1, { note: 'fine\nok' }, false);
  assert.equal((await db.get('exercises', 'leg_press')).notes, 'seat 4\ttwo');
});

test('SR14: saveExerciseText refuses a link with a user name, and Today reads the same helper', async () => {
  const { db, store } = await setup();
  await assert.rejects(store.saveExerciseText('leg_press', 'link', 'https://www.youtube.com' + String.fromCharCode(64) + 'other.example/x'), (e) => e.code === 'bad text');
  assert.equal((await db.get('exercises', 'leg_press')).link, '');
  await store.saveExerciseText('leg_press', 'link', 'https://www.youtube.com/watch?v=abc');
  const today = readFileSync(join(FIX, '..', '..', '..', 'ui', 'today.js'), 'utf8');
  assert.ok(!/\bLINK_RE\b/.test(today), 'Today keeps no link pattern of its own');
  assert.equal(today.split('isLink(').length - 1, 2, 'the open link and the link sheet both call isLink');
});

test('SR8: Swap stops at SLOT_MAX, Add set and Add set below stop at SET_N_MAX, and nothing is written', async () => {
  const { db, clock, store } = await setup();
  await store.createBlock(SPEC());
  const day = await store.currentDay();
  const v = await store.dayView(day.id);
  const s1 = v.sets.find(s => s.slot === 1 && s.set_n === 1);
  // A slot of 1000 on the day (the top the restore allows): a swap would need 1001.
  await db.put('sets', { ...s1, id: day.id + ':x1000:s1:none', slot: 1000 });
  let before = db.dump();
  await assert.rejects(store.swapExercise(day.id, 2, 'cable_row'), (e) => e.name === 'Refused' && e.code === 'no slot');
  assert.equal(db.dump(), before, 'swap: nothing written');
  // A work set numbered 1000 on slot 2: Add set would need 1001.
  const s2 = v.sets.find(s => s.slot === 2 && s.set_n === 2);
  await db.put('sets', { ...s2, set_n: 1000 });
  before = db.dump();
  await assert.rejects(store.addSet(day.id, 2), (e) => e.name === 'Refused' && e.code === 'no set');
  assert.equal(db.dump(), before, 'addSet: nothing written');
  // Add set below set 1 of slot 2 would move the 1000 to 1001.
  clock.add(MIN);
  await store.tick(s1.id, V(150, 10));
  before = db.dump();
  const first = v.sets.find(s => s.slot === 2 && s.set_n === 1);
  await assert.rejects(store.addSetBelow(first.id), (e) => e.name === 'Refused' && e.code === 'no set');
  assert.equal(db.dump(), before, 'addSetBelow: nothing written');
});

test('SR9: a block id that holds :x still keys every set write on its own day', async () => {
  const { db, store } = await setup();
  const spec = SPEC();
  spec.id = 'bq:x7';
  await store.createBlock(spec);
  const day = await store.currentDay();
  const v = await store.dayView(day.id);
  const s = v.sets.find(x => x.slot === 1 && x.set_n === 1);
  // The draft write is held, then Skip set on the same slot: one day queue means the skip waits
  // for the draft and lands after it; a wrong key lets the held draft land last and undo the skip.
  await whileHeld(db, () => store.saveDraft(s.id, { load: 155 }), () => store.skipSet(day.id, 1));
  const row = await db.get('sets', s.id);
  assert.equal(row.status, 'skipped', 'the skip landed after the draft');
  assert.equal(row.draft, null);
});

test('SR12: createBlock refuses a repeated day number or a repeated slot in one day, and writes nothing', async () => {
  const { db, store } = await setup();
  const before = db.dump();
  const a = SPEC(); a.day_templates[1].day = 1;
  await assert.rejects(store.createBlock(a), (e) => e.name === 'Refused' && e.code === 'bad block');
  const b = SPEC(); b.day_templates[0].lifts[1].slot = 1;
  await assert.rejects(store.createBlock(b), (e) => e.name === 'Refused' && e.code === 'bad block');
  assert.equal(db.dump(), before);
});

test('SR15: the phone check probe waits for a write in flight, reads its value back and leaves no row', async () => {
  const { db, clock, store } = await setup();
  await store.createBlock(SPEC());
  const v = await store.dayView((await store.currentDay()).id);
  const stamp = clock.now();
  const [, got] = await whileHeld(db, () => store.tick(v.sets[0].id, V(150, 10)), () => store.probe(stamp));
  assert.equal(got, stamp, 'the value reads back');
  assert.equal(db.spy.closeForTest, 1, 'the link was dropped once');
  assert.ok(!db.spy.closedWhileHeld, 'never while a write was in flight');
  assert.equal(await db.get('settings', 'phonecheck_probe'), undefined, 'the probe row is gone');
  assert.equal((await db.get('sets', v.sets[0].id)).status, 'done', 'the tick is kept');
});

// LN3: each hold re-arms spy.batchHeld, so a second whileHeld on the same db waits for its own hold.
test('LN3: a second hold on one fake db re-arms batchHeld and the second whileHeld waits for it', async () => {
  const { db, store } = await setup();
  await store.createBlock(SPEC());
  const day = await store.currentDay();
  const v = await store.dayView(day.id);
  const order = [];
  await whileHeld(db, () => store.tick(v.sets[0].id, V(150, 10)), async () => { order.push(db.spy.holding ? 'tap1-held' : 'tap1-early'); });
  // After the first hold is released, batchHeld must be a fresh promise that is not yet resolved.
  const probe = await Promise.race([db.spy.batchHeld.then(() => 'resolved'), pause(20).then(() => 'pending')]);
  assert.equal(probe, 'pending', 'batchHeld is re-armed after the first hold');
  await whileHeld(db, () => store.tick(v.sets[1].id, V(150, 10)),
    async () => { order.push(db.spy.holding ? 'tap2-held' : 'tap2-early'); });
  // On the old shape batchHeld stayed resolved, so the second tap ran before its batch was held.
  assert.deepEqual(order, ['tap1-held', 'tap2-held']);
  const after = await store.dayView(day.id);
  assert.equal(after.sets.filter(s => s.status === 'done').length, 2, 'both ticks are kept');
});

// LN1: probe is a store write, so the restore invariant runs right after it.
test('LN1: the phone check probe is in the guarded write list', async () => {
  assert.ok(WRITES.includes('probe'));
  const { store, clock } = await setup();
  const before = invariant.checks;
  await store.probe(clock.now());
  assert.ok(invariant.checks > before, 'the restore check ran after probe');
});

// SB3 (security read 2): a made exercise row holds only a muscle and an equipment value the restore accepts.
test('SB3: addCustomExercise refuses a muscle or an equipment value outside the fixed lists, and writes nothing', async () => {
  const { db, store } = await setup();
  const isBad = (e) => e.name === 'Refused' && e.code === 'bad text';
  const before = db.dump();
  for (const [muscle, equipment] of [['glutes', 'machine'], ['chest', 'kettlebell'], [undefined, 'machine'], ['chest', null], ['__proto__', 'machine'], ['Chest', 'machine']]) {
    await assert.rejects(store.addCustomExercise({ name: 'My lift', muscle, equipment }), isBad, String(muscle) + ' ' + String(equipment));
  }
  assert.equal(db.dump(), before, 'nothing written');
  const row = await store.addCustomExercise({ name: 'My lift', muscle: 'legs', equipment: 'bodyweight' });
  assert.deepEqual([row.muscle, row.equipment], ['legs', 'bodyweight']);
});

// SB4 (security read 2): a read that never answers inside a whole-database job must end as Not
// saved, open the gate again, and never write once it answers late (C35).
test('SB4: a Finish day whose read never answers ends as Not saved, a tick after it saves, and the late read writes nothing', { timeout: 10000 }, async () => {
  const { db, clock, store } = await setup();
  await store.createBlock(SPEC());
  const day = await store.currentDay();
  const v = await store.dayView(day.id);
  clock.add(MIN);
  await store.tick(v.sets[0].id, V(150, 10));
  const resets = db.spy.resetLink;
  db.faults.holdReads = 1;
  const t0 = Date.now();
  await assert.rejects(store.finishDay(day.id), (e) => e instanceof NotSaved, 'a held read ends as Not saved');
  assert.ok(Date.now() - t0 < 2000, 'within the read limit, never a silent wait');
  assert.equal(db.spy.readsHeld, 1, 'the job read was the one held');
  assert.ok(db.spy.resetLink > resets, 'the link is reset');
  clock.add(MIN);
  await store.tick(v.sets[1].id, V(150, 9));
  assert.equal((await db.get('sets', v.sets[1].id)).status, 'done', 'a tick tapped after it saves');
  assert.equal(store.busy(), false, 'the gate is open again');
  const before = db.dump();
  const batches = db.spy.batch;
  db.releaseReads();
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(db.spy.batch, batches, 'the late body never reaches a batch');
  assert.equal(db.dump(), before, 'nothing written after the gate opened');
  assert.equal((await db.get('days', day.id)).status, 'open');
  await store.finishDay(day.id);
  assert.equal((await db.get('days', day.id)).status, 'done', 'the next Finish day works');
});

test('SB4: Skip day, a block update, Reset day, the seed, a safety copy and Erase all end as Not saved on a held read', { timeout: 10000 }, async () => {
  const { db, clock, store } = await setup(null, { uuid: fixedIds() });
  const nb = await store.importBlock(JSON.stringify(blockV1()), true);
  const dId = nb.id + ':p1:d1';
  const v2 = blockV1();
  v2.version = 2;
  const jobs = [
    ['skipDay', () => store.skipDay(dId)],
    ['importBlock', () => store.importBlock(JSON.stringify(v2), false)],
    ['seed', () => store.seed()],
    ['saveSnapshot', () => store.saveSnapshot('before-erase')],
    ['eraseAll', () => store.eraseAll()]
  ];
  for (const [name, run] of jobs) {
    const before = db.dump();
    db.faults.holdReads = 1;
    await assert.rejects(run(), (e) => e instanceof NotSaved, name + ' ends as Not saved');
    assert.equal(store.busy(), false, name + ': the gate is open again');
    db.releaseReads();
    await new Promise((res) => setTimeout(res, 150));
    assert.equal(db.dump(), before, name + ': nothing written, even after the read answers');
  }
  const s1 = nb.id + ':p1:d1:x1:s1:none';
  clock.add(MIN);
  await store.tick(s1, V(150, 9));
  const before = db.dump();
  db.faults.holdReads = 1;
  await assert.rejects(store.resetDay(dId), (e) => e instanceof NotSaved, 'resetDay ends as Not saved');
  db.releaseReads();
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(db.dump(), before, 'resetDay: nothing written');
});

// SB5: a block update that drops a lift from a planned day also drops that slot's feedback row.
test('SB5: a check answer on a planned day, then a block update that drops the lift, leaves no feedback row', async () => {
  const { db, store } = await setup(null, { uuid: fixedIds() });
  const nb = await store.importBlock(JSON.stringify(blockV1()), true);
  const dId = nb.id + ':p1:d1';
  await store.saveChecks(dId, 3, { check_a: false });
  assert.ok(await db.get('feedback', dId + ':x3'), 'the check answer made a feedback row');
  await store.saveChecks(dId, 1, { check_a: false });
  const v2 = blockV1();
  v2.version = 2;
  v2.block.day_templates[0].lifts = v2.block.day_templates[0].lifts.filter(l => l.slot !== 3);
  await store.importBlock(JSON.stringify(v2), false);
  assert.equal((await db.byIndex('sets', 'day_id', dId)).filter(s => s.slot === 3).length, 0, 'the slot holds no set');
  assert.equal(await db.get('feedback', dId + ':x3'), undefined, 'its feedback row is gone');
  assert.ok(await db.get('feedback', dId + ':x1'), 'a slot that still holds sets keeps its row');
});
