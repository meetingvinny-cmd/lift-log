// store.test.js - whole flows on the fake db with a fake clock (DESIGN 5.7). Run with TZ=America/New_York.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, localDate, NotSaved, checksFor, gridReason } from '../../../store.js';
import { TEMPLATES } from '../../../data/templates.js';
import { buildBackup, validateBackup, validateSnapshotRow } from '../../../backup.js';
import { SEED_EXERCISES, SEED_IDS } from '../../../data/exercises.js';
import { APP_VERSION } from '../../../version.js';
import { createFakeDb, fakeClock } from './fake_db.js';
import { planDay, startingSets } from '../../../engine.js';
import { RULES } from '../../../rules.js';
import { LIMITS } from '../../../backup.js';

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
  'relabelDay', 'addSetBelow', 'deleteSet', 'moveSlot', 'resetDay', 'skipDay', 'saveChecks', 'takeRestoreNote', 'probe',
  // Slice 2 (16 B.4.8, r4.4 R4 c): every new store write joins the list.
  'answerSleep', 'setSetType', 'saveSoreness', 'liveEdit', 'resize', 'switchProfile', 'switchBack', 'changeAnswers', 'endBlock',
  // Slice 3 (17 C.3, r4.4 R22 item 1): every new store write joins the list.
  'setSavedEquipment', 'setCurrentBlock', 'renameBlock', 'setBlockNote', 'deleteBlock',
  // S2: templates, guided builder, levels, copy, tips.
  'saveBlockAsTemplate', 'saveBoardAsTemplate', 'deleteTemplate', 'guidedSave', 'setPriorities', 'copyBlock', 'markTipSeen',
  // Slice 3, track S3 (17 C.3.9 to C.3.16)
  'resizeBlock', 'setBodyWeight', 'markChangedSeen'];
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
  assert.equal(sk.why, 'why.skipped');
  assert.equal(sk.draft, null);
  const nextOpen = (await store.dayView(day.id)).sets.find(s => s.slot === 1 && s.status === 'planned');
  assert.equal(nextOpen.id, v.sets[1].id);
  await store.unskip(skipped);
  assert.equal((await db.get('sets', skipped)).status, 'planned');
  assert.equal((await db.get('sets', skipped)).why, 'why.plan');
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
  assert.ok(left.every(s => s.why === 'why.notdone'));
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
  assert.equal(a.why, 'why.added');
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

test('C.0.2 C.3.16: Erase all keeps the device keys tips_seen and seen_version', async () => {
  const { db, store } = await day3();
  await store.markTipSeen('tip_rest');
  await db.setSetting('seen_version', '0.4.0');
  await store.eraseAll();
  assert.deepEqual(await db.setting('tips_seen', null), { tip_rest: true }, 'tips_seen kept');
  assert.equal(await db.setting('seen_version', null), '0.4.0', 'seen_version kept');
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
  assert.equal(n.why, 'why.added');
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
    assert.ok(['why.plan', 'why.added'].includes(s.why));
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
    assert.equal(s.why, 'why.dayskipped');
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

// ---------------- Slice 2, B.1 step 4: the version 2 upgrade on the fake db (16 B.6.2, B.12, M38) ----------------

const fileV1 = () => JSON.parse(readFileSync(join(FIX, 'backup_v1.json'), 'utf8'));
const fileV1as2 = () => JSON.parse(readFileSync(join(FIX, 'backup_v1_as_v2.json'), 'utf8'));
const KEYS_OF = { settings: 'key' };
const byKey = (s, rows) => [...rows].sort((a, b) => String(a[KEYS_OF[s] || 'id']) < String(b[KEYS_OF[s] || 'id']) ? -1 : 1);
const UPGRADE_AT = '2026-11-14T09:00:00-05:00';

async function upgradeSetup(rows, version = 1) {
  const db = createFakeDb({ version, rows });
  const clock = fakeClock(UPGRADE_AT);
  const store = guarded(db, createStore({ db, now: clock.now, writeLimitMs: 50 }), clock);
  return { db, clock, store };
}

test('upgrade: a schema 1 db opened at version 2 has a before-upgrade copy, every row migrated, counts equal', async () => {
  const f = fileV1();
  const { db, clock } = await upgradeSetup(f.stores);
  await db.ready();
  assert.equal(db.upgradeFailed(), false);
  assert.equal(db.version(), 2);
  assert.equal(db.upgradeSpy.hookCalls, 1);
  const want = fileV1as2().stores;
  for (const s of Object.keys(want)) {
    const rows = await db.all(s);
    assert.equal(rows.length, f.counts[s], 'count of ' + s);
    assert.deepEqual(byKey(s, rows), byKey(s, want[s]), 'rows of ' + s + ' are the MIGRATIONS[1] rows');
  }
  const snaps = await db.all('snapshots');
  assert.equal(snaps.length, 1);
  const c = snaps[0];
  assert.deepEqual(Object.keys(c).sort(), ['data', 'id', 'last_backup_at_then', 'made_at', 'reason']);
  assert.equal(c.reason, 'before-upgrade');
  assert.equal(c.made_at, clock.now());
  assert.equal(c.id, 's' + clock.now());
  assert.equal(c.last_backup_at_then, 1793661269000);
  assert.equal(c.data.schema, 1);
  assert.ok(!('flat_log' in c.data));
  for (const s of Object.keys(f.stores)) assert.deepEqual(byKey(s, c.data.stores[s]), byKey(s, f.stores[s]), 'the copy holds the schema 1 rows of ' + s);
  // The copy reads back through the same allow table as any file, as a schema 2 object.
  const v = validateSnapshotRow(c, { now: clock.now(), seedIds: SEED_IDS });
  assert.equal(v.schema, 2);
});

test('upgrade: the copy trim keeps the newest 3 safety copies', async () => {
  const f = fileV1();
  const old = [1, 2, 3].map(i => ({ id: 's' + (1793000000000 + i), made_at: 1793000000000 + i, reason: 'before-erase', last_backup_at_then: null, data: f }));
  const { db } = await upgradeSetup({ ...f.stores, snapshots: old });
  await db.ready();
  const ids = (await db.all('snapshots')).map(s => s.id).sort();
  assert.equal(ids.length, 3);
  assert.ok(!ids.includes('s1793000000001'), 'the oldest copy is trimmed');
  assert.ok((await db.all('snapshots')).some(s => s.reason === 'before-upgrade'));
});

test('upgrade: a migration that throws leaves schema 1 rows deep-equal (M38)', async () => {
  const f = fileV1();
  // A why text MIGRATIONS[1] does not know, on a set: the step throws half way (after exercises,
  // blocks and days are already migrated in its own copy).
  f.stores.sets[10] = { ...f.stores.sets[10], why: 'A why text no version knows' };
  const { db, store } = await upgradeSetup(f.stores);
  const before = db.dump();
  await assert.rejects(db.ready());
  assert.equal(db.upgradeFailed(), true);
  assert.equal(store.upgradeFailed(), true);
  assert.equal(db.version(), 1, 'the phone stays on version 1');
  assert.equal(db.dump(), before, 'every schema 1 row is as it was');
  assert.equal(db._data.snapshots.size, 0, 'no copy is left behind');
  // Every later call fails too, and writes nothing.
  await assert.rejects(db.all('sets'));
  await assert.rejects(store.setSetting('theme', 'dark'));
  assert.equal(db.dump(), before);
});

test('upgrade: a version 0 open makes the stores fresh and no safety copy', async () => {
  const db = createFakeDb({ version: 0 });
  const clock = fakeClock(UPGRADE_AT);
  const store = createStore({ db, now: clock.now, writeLimitMs: 50 });
  await db.ready();
  assert.equal(db.upgradeSpy.hookCalls, 0, 'the hook is never called on a new phone');
  assert.equal(db.version(), 2);
  assert.equal(db._data.snapshots.size, 0);
  assert.equal(store.upgradeFailed(), false);
});

test('upgrade: Undo of the before-upgrade copy runs migrate on it and ends on schema 2 with the old rows', async () => {
  const f = fileV1();
  const { db, clock, store } = await upgradeSetup(f.stores);
  await db.ready();
  const up = (await store.listSnapshots()).find(s => s.reason === 'before-upgrade');
  assert.ok(up);
  clock.add(MIN);
  await store.eraseAll();
  assert.equal((await db.all('sets')).length, 0);
  clock.add(MIN);
  await store.undoSnapshot(up.id);
  // The old rows as any restore reads them: the frozen MIGRATIONS[1] fixture through the allow table.
  const read2 = validateBackup(JSON.stringify(fileV1as2()), { now: clock.now(), seedIds: SEED_IDS });
  assert.ok(read2.ok, read2.why);
  const want = read2.stores;
  for (const s of ['exercises', 'templates', 'blocks', 'days', 'sets', 'feedback']) {
    assert.deepEqual(byKey(s, await db.all(s)), byKey(s, want[s]), s + ' back as schema 2 rows');
  }
  assert.ok((await db.all('sets')).every(x => x.set_type === 'normal' && x.why.startsWith('why.')));
  assert.equal(await db.setting('last_backup_at'), 1793661269000, 'the marker goes back to the copy\'s');
  const file = await store.backupObject();
  assert.equal(file.schema, 2);
  assert.ok(validateBackup(JSON.stringify(file), { now: clock.now(), seedIds: SEED_IDS }).ok);
});

// ---------------- Slice 2, B.1 step 5 core: planDay takes over, the write guard, sleep, set kind ----------------

const blockV2 = () => JSON.parse(readFileSync(join(FIX, 'block_v2.json'), 'utf8'));
const workOf = (rows, slot) => rows.filter(x => x.slot === slot && x.kind === 'work').sort((a, b) => a.set_n - b.set_n || (a.side < b.side ? -1 : 1));
// An adaptive block as a switch leaves it (16 B.6.1a). The switch call is built later (B.1 step 9),
// so the test writes the block row straight into the fake db.
async function makeAdaptive(db, blockId, switchedAt, more) {
  const b = await db.get('blocks', blockId);
  await db.put('blocks', { ...b, profile: 'adaptive', rules_frozen: { profile: 'adaptive', rules_version: 'signed-1' },
    profile_switch: { switched_at: switchedAt, ticks: [true, true, true], back_at: null }, ...(more || {}) });
}
const ONE_DAY = (lifts, passes) => ({ name: 'One day', passes: passes === undefined ? 4 : passes, day_templates: [{ day: 1, label: 'A', lifts }] });
// Play a planned day: tick every set at its target with reps, then the end answers, then Finish day.
async function playDay(store, clock, dId, reps, answers) {
  const v = await store.dayView(dId);
  for (const x of v.sets) { clock.add(MIN); await store.tick(x.id, V(x.target.load === null ? 50 : x.target.load, reps)); }
  for (const sl of v.slots) { clock.add(MIN); await store.saveFeedback(dId, sl, answers || {}, false); }
  clock.add(MIN);
  await store.finishDay(dId);
  clock.add(2 * 24 * HOUR);
}

test('B.4.1: createBlock plans round 1 through planDay, rows with the schema 2 fields (CW3, FW1)', async () => {
  const { db, store } = await setup(null, { uuid: fixedIds() });
  const b = await store.importBlock(JSON.stringify(blockV1()), true);
  assert.equal(b.profile, 'fixed');
  assert.deepEqual(b.rules_frozen, { profile: 'fixed', rules_version: 'signed-2' });
  assert.equal(b.profile_switch, null);
  const ex = await store.exercisesMap();
  for (const d of b.day_templates) {
    const dId = b.id + ':p1:d' + d.day;
    const day = await db.get('days', dId);
    assert.equal(day.profile, 'fixed');
    assert.equal(day.short_sleep_since_last, null);
    assert.equal(day.body_weight, null);
    const want = planDay(RULES.profiles.fixed, b, { exercises: ex }, { pass: 1, day: d.day });
    const have = (await db.byIndex('sets', 'day_id', dId)).sort((x, y) => x.id < y.id ? -1 : 1);
    assert.deepEqual(have.map(x => x.id), want.sets.map(x => x.id).sort());
    for (const x of have) {
      const w = want.sets.find(y => y.id === x.id);
      const note = want.notes.find(n => n.slot === x.slot);
      const fail = x.kind === 'work' && note.failure_set_n === x.set_n;
      assert.deepEqual(x, { ...w, set_type: fail ? 'failure' : 'normal', set_type_by_hand: false, add_scope: null, target: { ...w.target, failure_set: fail, effort_only: false } });
      assert.equal(x.why, 'why.plan');
    }
  }
  // The machine failure lift (seated_leg_curl, failure_set true) carries the one failure set.
  const curl = workOf(await db.byIndex('sets', 'day_id', b.id + ':p1:d1'), 3);
  assert.deepEqual(curl.map(x => [x.set_n, x.set_type, x.target.failure_set]), [[1, 'normal', false], [2, 'failure', true]]);
  // The builder path (createBlock) plans round 1 the same way.
  const c = await store.createBlock(SPEC());
  for (const d of c.day_templates) {
    const want = planDay(RULES.profiles.fixed, c, { exercises: ex }, { pass: 1, day: d.day }).sets.map(x => x.id).sort();
    const have = (await db.byIndex('sets', 'day_id', c.id + ':p1:d' + d.day));
    assert.deepEqual(have.map(x => x.id).sort(), want);
    assert.ok(have.every(x => x.why === 'why.plan' && x.set_type === 'normal' && x.set_type_by_hand === false && x.add_scope === null && x.target.failure_set === false && x.target.effort_only === false));
  }
});

test('B.4.1: Finish day and Skip day plan the next day through planDay', async () => {
  const { db, clock, store } = await setup();
  const b = await store.createBlock(SPEC());
  await playDay(store, clock, b.id + ':p1:d1', 10);
  const d2 = await db.byIndex('sets', 'day_id', b.id + ':p1:d2');
  assert.ok(d2.length && d2.every(x => x.why === 'why.plan' && x.set_type === 'normal' && x.add_scope === null));
  clock.add(MIN);
  await store.skipDay(b.id + ':p1:d2');
  const r2 = await db.get('days', b.id + ':p2:d1');
  assert.ok(r2 && r2.status === 'planned' && r2.profile === 'fixed');
  assert.equal((await db.byIndex('sets', 'day_id', r2.id)).length, 4);
  assert.equal((await store.currentDay()).id, r2.id, 'currentDay reads the engine position');
});

test('B.4.2: the write guard keeps drafts, done, skipped, added, swapped and hand-picked rows (M16 kept)', async () => {
  const { db, clock, store } = await setup(null, { uuid: fixedIds() });
  const b = await store.importBlock(JSON.stringify(blockV1()), true);
  const d1 = b.id + ':p1:d1', d2 = b.id + ':p1:d2';
  // Day A: done and finished (round 1 day A), so it is never re-planned.
  await playDay(store, clock, d1, 10);
  const doneRows = await db.byIndex('sets', 'day_id', d1);
  // Day B (planned): a set he added, a swap, a skipped set, a hand-picked kind.
  const [addedId] = await store.addSet(d2, 1);
  await store.swapExercise(d2, 3, 'leg_press');
  const skipped = await store.skipSet(d2, 2);
  const s1 = d2 + ':x1:s1:none';
  await store.setSetType(s1, 'failure');
  const keep = Object.fromEntries((await db.byIndex('sets', 'day_id', d2)).filter(x => [addedId, skipped, s1].includes(x.id) || x.origin === 'added').map(x => [x.id, x]));
  const v2 = blockV1();
  v2.version = 2;
  for (const dt of v2.block.day_templates) for (const l of dt.lifts) if (l.start_load !== null) l.start_load += 10;
  clock.add(MIN);
  await store.importBlock(JSON.stringify(v2), false);
  const after = await db.byIndex('sets', 'day_id', d2);
  for (const [id, row] of Object.entries(keep)) assert.deepEqual(after.find(x => x.id === id), row, id + ' is never written by planning');
  // The plan rows that pass the guard took the new loads.
  assert.equal(after.find(x => x.id === d2 + ':x1:s2:none').target.load, 110);
  assert.deepEqual(await db.byIndex('sets', 'day_id', d1), doneRows, 'a done day is never touched');
});

test('B.4.2: a planned day with a typed draft keeps its whole old plan on a block file update', async () => {
  const { db, clock, store } = await setup(null, { uuid: fixedIds() });
  const b = await store.importBlock(JSON.stringify(blockV1()), true);
  const r1 = b.id + ':p1:d1';
  await store.saveDraft(r1 + ':x1:s1:none', { load: 151 });
  const before = await db.byIndex('sets', 'day_id', r1);
  const v3 = blockV1();
  v3.version = 3;
  v3.block.day_templates[0].lifts[0].start_load = 175;
  clock.add(MIN);
  const preview = await store.readBlockFile(JSON.stringify(v3));
  assert.equal(preview.keepDraft.length, 1);
  await store.importBlock(JSON.stringify(v3), false);
  assert.deepEqual(await db.byIndex('sets', 'day_id', r1), before, 'a day with a draft keeps its old targets');
});

test('setSetType: his kind on a work set is his; a re-plan keeps it; a warm-up and a bad kind are refused', async () => {
  const { db, clock, store } = await setup(null, { uuid: fixedIds() });
  const b = await store.importBlock(JSON.stringify(blockV1()), true);
  const dId = b.id + ':p1:d1';
  const row = await store.setSetType(dId + ':x3:s2:none', 'normal');
  assert.equal(row.set_type, 'normal');
  assert.equal(row.set_type_by_hand, true);
  await assert.rejects(store.setSetType(dId + ':x1:w1:none', 'failure'), /not a work set/);
  await assert.rejects(store.setSetType(dId + ':x1:s1:none', 'drop'), /bad kind/);
  // LR: both rows of the set take the kind.
  await store.setSetType(dId + ':x2:s1:L', 'failure');
  assert.equal((await db.get('sets', dId + ':x2:s1:R')).set_type, 'failure');
  clock.add(MIN);
  await store.answerSleep(dId, true);
  const kept = await db.get('sets', dId + ':x3:s2:none');
  assert.equal(kept.set_type, 'normal', 'the re-plan never writes his kind back');
  assert.equal(kept.target.reps_left_target, 0, 'and never writes the set');
});

// ---- sleep (16 B.4.3, T43, R4-13; r4 review R6, R8, R31) ----

const FAIL_LIFT = () => [lift(1, 'leg_press', 2, 150, { failure_set: true, reps_left_target: 1 }), lift(2, 'lat_pulldown', 2, 100)];

test('sleep: answer, clear, then a first tick keeps the answer; the card is gone once the day is open', async () => {
  const { db, clock, store } = await setup();
  const b = await store.createBlock(ONE_DAY(FAIL_LIFT(), 4));
  const dId = b.id + ':p1:d1';
  assert.equal((await store.answerSleep(dId, true)).short_sleep_since_last, true);
  assert.equal((await store.answerSleep(dId, null)).short_sleep_since_last, null, 'a tap on the picked chip clears it');
  await store.answerSleep(dId, false);
  clock.add(MIN);
  await store.tick(dId + ':x1:s1:none', V(150, 10));
  const d = await db.get('days', dId);
  assert.equal(d.status, 'open');
  assert.equal(d.short_sleep_since_last, false, 'the first tick keeps the answer');
  await assert.rejects(store.answerSleep(dId, true), /day is not planned/);
  await assert.rejects(store.answerSleep(dId, 'yes'), /bad answer/);
});

test('sleep: no answer, then a first tick stores null', async () => {
  const { db, clock, store } = await setup();
  const b = await store.createBlock(ONE_DAY(FAIL_LIFT(), 4));
  const dId = b.id + ':p1:d1';
  clock.add(MIN);
  await store.tick(dId + ':x1:s1:none', V(150, 10));
  const d = await db.get('days', dId);
  assert.equal(d.status, 'open');
  assert.equal(d.short_sleep_since_last, null);
});

test('sleep: in Fixed a Yes sets the failure set goal to 2; a No or a clear puts back the written goal (M77)', async () => {
  const { db, store } = await setup();
  const b = await store.createBlock(ONE_DAY(FAIL_LIFT(), 4));
  const dId = b.id + ':p1:d1';
  const goal = async () => workOf(await db.byIndex('sets', 'day_id', dId), 1).map(x => [x.set_type, x.target.reps_left_target]);
  assert.deepEqual(await goal(), [['normal', 1], ['failure', 1]]);
  await store.answerSleep(dId, true);
  assert.deepEqual(await goal(), [['normal', 1], ['failure', 2]], 'a Yes stops the failure set 2 short');
  await store.answerSleep(dId, false);
  assert.deepEqual(await goal(), [['normal', 1], ['failure', 1]], 'a No puts back the written goal');
  await store.answerSleep(dId, true);
  await store.answerSleep(dId, null);
  assert.deepEqual(await goal(), [['normal', 1], ['failure', 1]], 'a clear puts back the written goal');
});

test('sleep: in Adjust each round a Yes sets the failure set goal to 2; a No or a clear puts back 0 (M77)', async () => {
  const { db, clock, store } = await setup('2026-12-02T18:00:00-05:00');
  const b = await store.createBlock(ONE_DAY(FAIL_LIFT(), 4));
  await makeAdaptive(db, b.id, clock.now());
  await playDay(store, clock, b.id + ':p1:d1', 10);
  const dId = b.id + ':p2:d1';
  assert.equal((await db.get('days', dId)).profile, 'adaptive');
  const fail = async () => workOf(await db.byIndex('sets', 'day_id', dId), 1).filter(x => x.set_type === 'failure').map(x => x.target.reps_left_target);
  assert.deepEqual(await fail(), [0]);
  await store.answerSleep(dId, true);
  assert.deepEqual(await fail(), [2]);
  await store.answerSleep(dId, false);
  assert.deepEqual(await fail(), [0]);
  await store.answerSleep(dId, true);
  await store.answerSleep(dId, null);
  assert.deepEqual(await fail(), [0]);
});

test('sleep: R8 day, a Yes on the card brings the planned count back; a No plans the add again (R6, M80)', async () => {
  const { db, clock, store } = await setup('2026-12-02T18:00:00-05:00');
  const b = await store.createBlock(ONE_DAY([lift(1, 'leg_press', 2, 150), lift(2, 'lat_pulldown', 2, 100)], 4));
  await makeAdaptive(db, b.id, clock.now(), { levels: { quads: 'top', back: 'top' } });
  await store.answerSleep(b.id + ':p1:d1', false);
  await playDay(store, clock, b.id + ':p1:d1', 10, { pump: 2, soreness: 2, workload: 2 });
  const dId = b.id + ':p2:d1';
  const count = async () => workOf(await db.byIndex('sets', 'day_id', dId), 1).length;
  assert.equal(await count(), 3, 'row R8 adds a set');
  assert.equal(workOf(await db.byIndex('sets', 'day_id', dId), 1)[0].why, 'why.R8');
  await store.answerSleep(dId, true);
  assert.equal(await count(), 2, 'a Yes on the day drops the add');
  assert.ok(workOf(await db.byIndex('sets', 'day_id', dId), 1).every(x => x.why === 'why.sleep'));
  await store.answerSleep(dId, false);
  assert.equal(await count(), 3, 'a No plans it back');
});

test('rulesFor: a restored adaptive block on 2026-11-30 local plans as Fixed (R11, M83)', async () => {
  // Built at 2026-11-30 3 PM New York, after a switch at 7 AM New York (12:00 UTC, past the earliest instant).
  const { db, clock, store } = await setup('2026-11-30T15:00:00-05:00');
  const b = await store.createBlock(ONE_DAY([lift(1, 'leg_press', 2, 150), lift(2, 'lat_pulldown', 2, 100)], 4));
  await makeAdaptive(db, b.id, Date.UTC(2026, 10, 30, 12), { levels: { quads: 'top', back: 'top' } });
  const text = JSON.stringify(await store.backupObject());
  const r = await setup('2026-11-30T15:00:00-05:00');
  await r.store.restoreFile(text);
  assert.equal((await r.db.get('blocks', b.id)).profile, 'adaptive');
  await r.store.answerSleep(b.id + ':p1:d1', false);
  await playDay(r.store, r.clock, b.id + ':p1:d1', 10, { pump: 2, soreness: 2, workload: 2 });
  // Finish day ran on 2026-11-30, local: the next day is planned as Fixed.
  r.clock.set('2026-11-30T20:00:00-05:00');
  const dId = b.id + ':p2:d1';
  await r.store.answerSleep(dId, false);
  assert.equal((await r.db.get('days', dId)).profile, 'fixed');
  assert.equal(workOf(await r.db.byIndex('sets', 'day_id', dId), 1).length, 2, 'no add before 2026-12-01');
  // From 2026-12-01 00:00 local it plans on its frozen profile.
  r.clock.set('2026-12-01T00:00:00-05:00');
  await r.store.answerSleep(dId, false);
  assert.equal((await r.db.get('days', dId)).profile, 'adaptive');
  assert.equal(workOf(await r.db.byIndex('sets', 'day_id', dId), 1).length, 3);
});

test('rulesFor: an adaptive block at a fake clock of 2026-11-20 plans as Fixed (R11, M83)', async () => {
  // The switch time is ahead of this clock, so no backup of it reads now (the 2-day slack): the
  // store runs without the restore check and the block row is written straight into the db.
  const db = createFakeDb();
  const clock = fakeClock('2026-11-20T18:00:00-05:00');
  const store = createStore({ db, now: clock.now, writeLimitMs: 50 });
  await store.seed();
  const b = await store.createBlock(ONE_DAY([lift(1, 'leg_press', 2, 150), lift(2, 'lat_pulldown', 2, 100)], 4));
  await makeAdaptive(db, b.id, LIMITS.ADJUST_EARLIEST_MS, { levels: { quads: 'top', back: 'top' } });
  await store.answerSleep(b.id + ':p1:d1', false);
  await playDay(store, clock, b.id + ':p1:d1', 10, { pump: 2, soreness: 2, workload: 2 });
  const dId = b.id + ':p2:d1';
  assert.equal((await db.get('days', dId)).profile, 'fixed');
  assert.equal(workOf(await db.byIndex('sets', 'day_id', dId), 1).length, 2);
});

test('R12: delete set 2, tick set 3, Add set: the done row is unchanged', async () => {
  const { db, clock, store } = await setup();
  const b = await store.createBlock(ONE_DAY([lift(1, 'leg_press', 3, 150), lift(2, 'lat_pulldown', 2, 100)], 4));
  const dId = b.id + ':p1:d1';
  await store.deleteSet(dId + ':x1:s2:none');
  clock.add(MIN);
  await store.tick(dId + ':x1:s3:none', V(150, 10));
  const done = await db.get('sets', dId + ':x1:s3:none');
  clock.add(MIN);
  const [nid] = await store.addSet(dId, 1);
  assert.equal(nid, dId + ':x1:s4:none');
  assert.deepEqual(await db.get('sets', dId + ':x1:s3:none'), done, 'the done row is unchanged');
  assert.deepEqual(workOf(await db.byIndex('sets', 'day_id', dId), 1).map(x => x.set_n), [1, 2, 3]);
});

test('R15: a re-plan after Add set on a planned day keeps set_n unique and in order (M86)', async () => {
  const { db, clock, store } = await setup(null, { uuid: fixedIds() });
  const b = await store.importBlock(JSON.stringify(blockV1()), true);
  const dId = b.id + ':p1:d1';
  const [added] = await store.addSet(dId, 1);
  assert.equal(added, dId + ':x1:s4:none');
  const v2 = blockV1();
  v2.version = 2;
  v2.block.day_templates[0].lifts[0].sets = 4;
  clock.add(MIN);
  await store.importBlock(JSON.stringify(v2), false);
  const rows = workOf(await db.byIndex('sets', 'day_id', dId), 1);
  assert.deepEqual(rows.map(x => x.set_n), [1, 2, 3, 4, 5], 'no two rows share a set_n');
  assert.deepEqual(rows.map(x => x.origin), ['plan', 'plan', 'plan', 'plan', 'added'], 'his row stays after the plan rows');
  assert.equal(rows[4].id, added, 'his row keeps its id');
  assert.equal(new Set(rows.map(x => x.id)).size, 5);
});

test('R14: a block file update that changes the failure lift\'s load reaches the planned failure set (M85)', async () => {
  const { db, clock, store } = await setup(null, { uuid: fixedIds() });
  const b = await store.importBlock(JSON.stringify(blockV1()), true);
  const dId = b.id + ':p1:d1';
  const v2 = blockV1();
  v2.version = 2;
  v2.block.day_templates[0].lifts[2].start_load = 80;
  clock.add(MIN);
  await store.importBlock(JSON.stringify(v2), false);
  const curl = workOf(await db.byIndex('sets', 'day_id', dId), 3);
  assert.deepEqual(curl.map(x => [x.set_type, x.target.failure_set, x.target.load]), [['normal', false, 80], ['failure', true, 80]]);
});

// ---- block file update, the fields the file wins (5.3, r4 review R18, M92) ----

async function v2Case(edit) {
  const ctx = await setup(null, { uuid: fixedIds() });
  const b = await ctx.store.importBlock(JSON.stringify(blockV2()), true);
  const f = blockV2();
  f.version = 2;
  edit(f.block);
  ctx.clock.add(MIN);
  await ctx.store.importBlock(JSON.stringify(f), false);
  return { ...ctx, b, after: await ctx.db.get('blocks', b.id) };
}
test('M92: a block file update changes sleep_hint', async () => {
  const { after } = await v2Case((x) => { x.sleep_hint = 'Made-up new sleep hint.'; });
  assert.equal(after.sleep_hint, 'Made-up new sleep hint.');
});
test('M92: a block file update changes switch_conditions', async () => {
  const lines = ['Made-up new line one.', 'Made-up new line two.', 'Made-up new line three.'];
  const { after } = await v2Case((x) => { x.switch_conditions = lines; });
  assert.deepEqual(after.switch_conditions, lines);
});
test('M92: a block file update changes flag_questions', async () => {
  const { after } = await v2Case((x) => { x.flag_questions = { ...x.flag_questions, machine: 'Made-up new machine question?' }; });
  assert.equal(after.flag_questions.machine, 'Made-up new machine question?');
});
test('M92: a block file update keeps edited levels, and fills empty ones from the file', async () => {
  const ctx = await setup(null, { uuid: fixedIds() });
  const b = await ctx.store.importBlock(JSON.stringify(blockV2()), true);
  assert.deepEqual(b.levels, blockV2().block.levels, 'a new block takes the file levels');
  await ctx.db.put('blocks', { ...(await ctx.db.get('blocks', b.id)), levels: { quads: 'middle' } });
  const f = blockV2();
  f.version = 2;
  ctx.clock.add(MIN);
  await ctx.store.importBlock(JSON.stringify(f), false);
  assert.deepEqual((await ctx.db.get('blocks', b.id)).levels, { quads: 'middle' }, 'his edited levels stay');
  await ctx.db.put('blocks', { ...(await ctx.db.get('blocks', b.id)), levels: {} });
  f.version = 3;
  ctx.clock.add(MIN);
  await ctx.store.importBlock(JSON.stringify(f), false);
  assert.deepEqual((await ctx.db.get('blocks', b.id)).levels, blockV2().block.levels, 'empty levels take the file\'s');
});

test('a new block and an imported block are always Fixed; a block file with profile adaptive is refused with every store unchanged', async () => {
  const { db, store } = await setup(null, { uuid: fixedIds() });
  const c = await store.createBlock({ ...SPEC(), profile: 'adaptive', rules_frozen: { profile: 'adaptive', rules_version: 'signed-1' }, profile_switch: { switched_at: 1, ticks: [true, true, true], back_at: null } });
  assert.equal(c.profile, 'fixed');
  assert.deepEqual(c.rules_frozen, { profile: 'fixed', rules_version: 'signed-2' });
  assert.equal(c.profile_switch, null);
  const i = await store.importBlock(JSON.stringify(blockV2()), false);
  assert.equal(i.profile, 'fixed');
  assert.deepEqual(i.rules_frozen, { profile: 'fixed', rules_version: 'signed-2' });
  assert.equal(i.profile_switch, null);
  const before = db.dump();
  const bad = blockV2();
  bad.source_id = 'made-up-other';
  bad.block.profile = 'adaptive';
  bad.block.rules_frozen = { profile: 'adaptive', rules_version: 'signed-1' };
  assert.equal((await store.readBlockFile(JSON.stringify(bad))).ok, false);
  await assert.rejects(store.importBlock(JSON.stringify(bad), true));
  const bad2 = blockV2();
  bad2.source_id = 'made-up-other';
  bad2.block.profile_switch = { switched_at: LIMITS.ADJUST_EARLIEST_MS, ticks: [true, true, true], back_at: null };
  await assert.rejects(store.importBlock(JSON.stringify(bad2), true));
  assert.deepEqual(db.dump(), before, 'every store unchanged');
});

test('R15b: a sleep answer and a first tick on one day land in tap order', async () => {
  const { db, store } = await setup();
  const b = await store.createBlock(SPEC());
  const dId = b.id + ':p1:d1';
  const id = dId + ':x1:s1:none';
  await whileHeld(db, () => store.answerSleep(dId, true), () => store.tick(id, V(150, 9)));
  const d = await db.get('days', dId);
  assert.equal(d.status, 'open', 'the tick opened the day after the answer landed');
  assert.equal(d.short_sleep_since_last, true, 'the answer is kept');
  const s = await db.get('sets', id);
  assert.equal(s.status, 'done', 'the tick is kept');
  assert.equal(s.done.reps, 9);
});

// ---- the schema 2 fixture (16 B.6.3, r4.4 R12): made by the store, read back to the same rows ----

test('backup_v2.json (made by the store) passes the schema 2 checks and round trips through restore', async () => {
  const text = readFileSync(join(FIX, 'backup_v2.json'), 'utf8');
  const f = JSON.parse(text);
  assert.equal(f.schema, 2);
  const { db, store } = await setup('2026-12-03T12:00:00-05:00');
  const v = validateBackup(text, { now: Date.parse('2026-12-03T12:00:00-05:00'), seedIds: SEED_IDS });
  assert.ok(v.ok, v.why);
  assert.equal(v.schema, 2);
  // What the fixture must hold (B.6.3): a sleep answer, a set kind he picked, a hand Add set,
  // the planned failure set, the schema 2 block words, a custom exercise.
  const st = f.stores;
  assert.ok(st.days.some(d => d.short_sleep_since_last === true) && st.days.some(d => d.short_sleep_since_last === false));
  assert.ok(st.sets.some(x => x.set_type === 'failure' && x.set_type_by_hand === true));
  assert.ok(st.sets.some(x => x.origin === 'added' && x.add_scope === 'today'));
  assert.ok(st.sets.some(x => x.set_type === 'failure' && x.target.failure_set === true && x.set_type_by_hand === false));
  assert.ok(st.blocks[0].switch_conditions.length === 3 && st.blocks[0].sleep_hint && Object.keys(st.blocks[0].levels).length === 3);
  assert.ok(st.exercises.some(e => e.custom && e.muscle_detail === null));
  // From B.1 step 5 rest: the switch, a Rest of block add, a Change answers save.
  assert.equal(st.blocks[0].profile, 'adaptive');
  assert.deepEqual(st.blocks[0].profile_switch.ticks, [true, true, true]);
  assert.equal(st.blocks[0].profile_switch.back_at, null);
  assert.ok(st.sets.some(x => x.origin === 'added' && x.add_scope === 'rest'));
  const changed = st.feedback.find(x => x.id.endsWith(':p1:d1:x1'));
  assert.ok(changed && changed.pump === 3 && changed.checks.check_a === true && changed.saved_at > Math.max(...st.feedback.filter(x => x.day_id === changed.day_id && x.id !== changed.id).map(x => x.saved_at)));
  await store.restoreFile(text);
  const back = (await store.backupObject()).stores;
  for (const s of ['exercises', 'templates', 'blocks', 'days', 'sets', 'feedback']) {
    assert.deepEqual(byKey(s, back[s]), byKey(s, v.stores[s]), s + ' round trips');
  }
  assert.ok(db);
});

// ---------------- Slice 2, B.1 step 5 rest: live edits, the switch, Change answers, End block, resize, the reads ----------------

const COND = ['Made-up condition one.', 'Made-up condition two.', 'Made-up condition three.'];
const ADJ = '2026-12-02T18:00:00-05:00';
const T3 = [true, true, true];
const isRefused = (code) => (e) => e.name === 'Refused' && (code === undefined || e.message === code);
// A two-day block he can switch: three condition lines, the leg press screened for added sets.
const SWITCHABLE = (more) => ({ ...SPEC(), switch_conditions: COND, levels: { quads: 'top', back: 'top', chest: 'top' },
  exercise_flags: { leg_press: { no_added_sets: false, left_out_of_builder: false }, chest_press_machine: { no_added_sets: false, left_out_of_builder: false } }, ...(more || {}) });
const slotCount = async (db, dId, slot) => new Set(workOf(await db.byIndex('sets', 'day_id', dId), slot).map(x => x.set_n)).size;

test('switch: refused at 2026-11-30 23:59 local, accepted at 2026-12-01 00:00 local with a stored profile_switch (M27)', async () => {
  const { db, clock, store } = await setup('2026-11-30T23:59:00-05:00');
  const b = await store.createBlock(SWITCHABLE());
  assert.equal(await store.switchAllowed(b.id), false, 'the row is not offered before 2026-12-01');
  const before = db.dump();
  await assert.rejects(store.switchProfile(b.id, T3, 'ADJUST'), isRefused('too early'));
  assert.equal(db.dump(), before, 'nothing written');
  clock.set('2026-12-01T00:00:00-05:00');
  assert.equal(await store.switchAllowed(b.id), true);
  const nb = await store.switchProfile(b.id, T3, 'ADJUST');
  const row = await db.get('blocks', b.id);
  assert.deepEqual(row, nb);
  assert.equal(row.profile, 'adaptive');
  assert.deepEqual(row.rules_frozen, { profile: 'adaptive', rules_version: 'signed-1' });
  assert.deepEqual(row.profile_switch, { switched_at: clock.now(), ticks: [true, true, true], back_at: null });
  for (const d of await db.byIndex('days', 'block_id', b.id)) assert.equal(d.profile, 'adaptive', 'the untouched planned days are planned again');
  assert.equal(await store.switchAllowed(b.id), false, 'an adaptive block shows Back to Fixed instead');
  assert.equal(await store.switchBackAllowed(b.id), true);
});

test('switch: refused with 2 ticks or the word "adjust"; the typed word is exact after trim (M39)', async () => {
  const { db, store } = await setup(ADJ);
  const b = await store.createBlock(SWITCHABLE());
  const before = db.dump();
  for (const [ticks, word] of [[[true, true], 'ADJUST'], [[true, true, false], 'ADJUST'], [[true, true, true, true], 'ADJUST'], [T3, 'adjust'], [T3, 'Adjust'], [T3, 'ADJUST!'], [T3, ''], [T3, null], [null, 'ADJUST']]) {
    await assert.rejects(store.switchProfile(b.id, ticks, word), isRefused(), JSON.stringify([ticks, word]));
  }
  assert.equal(db.dump(), before, 'nothing written');
  await store.switchProfile(b.id, T3, '  ADJUST  ');
  assert.equal((await db.get('blocks', b.id)).profile, 'adaptive');
});

test('switch: no condition lines, a bad rules table or a done block is refused; the switch re-plans and Back to Fixed plans as written', async () => {
  const { db, clock, store } = await setup(ADJ);
  const plain = await store.createBlock(SPEC());
  await assert.rejects(store.switchProfile(plain.id, T3, 'ADJUST'), isRefused('no conditions'));
  const bad = await setup(ADJ, { rulesOk: false });
  const bb = await bad.store.createBlock(SWITCHABLE());
  assert.equal(await bad.store.switchAllowed(bb.id), false, 'a bad table hides the row');
  assert.equal(bad.store.rulesOk(), false);
  await assert.rejects(bad.store.switchProfile(bb.id, T3, 'ADJUST'), isRefused('rules'));
  assert.equal(store.rulesOk(), true);
  // Round 1 day A on Fixed with R8 answers: round 2 day A plans 2 sets, the switch makes it 3.
  const b = await store.createBlock(ONE_DAY([lift(1, 'leg_press', 2, 150), lift(2, 'lat_pulldown', 2, 100)], 4));
  await db.put('blocks', { ...(await db.get('blocks', b.id)), switch_conditions: COND, levels: { quads: 'top', back: 'top' } });
  await store.answerSleep(b.id + ':p1:d1', false);
  await playDay(store, clock, b.id + ':p1:d1', 10, { pump: 2, soreness: 2, workload: 2 });
  const dId = b.id + ':p2:d1';
  await store.answerSleep(dId, false);
  assert.equal(await slotCount(db, dId, 1), 2, 'Fixed plans as written');
  await store.switchProfile(b.id, T3, 'ADJUST');
  assert.equal(await slotCount(db, dId, 1), 3, 'the switch re-plans the planned day (row R8)');
  clock.add(MIN);
  await store.switchBack(b.id);
  const row = await db.get('blocks', b.id);
  assert.equal(row.profile, 'fixed');
  assert.equal(row.rules_frozen.profile, 'fixed');
  assert.equal(row.profile_switch.back_at, clock.now());
  assert.equal((await db.get('days', dId)).profile, 'fixed');
  assert.equal(await slotCount(db, dId, 1), 2, 'Back to Fixed plans as written again');
  await assert.rejects(store.switchBack(b.id), isRefused('not adaptive'));
  // Switching on again needs the full sheet.
  await assert.rejects(store.switchProfile(b.id, T3, 'adjust'), isRefused('word'));
  clock.add(MIN);
  await store.switchProfile(b.id, T3, 'ADJUST');
  assert.deepEqual((await db.get('blocks', b.id)).profile_switch, { switched_at: clock.now(), ticks: [true, true, true], back_at: null });
  // A done block: no switch.
  clock.add(MIN);
  await store.endBlock(plain.id);
  assert.equal(await store.switchAllowed(plain.id), false);
});

test('Change answers never turns a true check into false (M88)', async () => {
  const { db, clock, store, day, slot } = await checkDay();
  const fid = day.id + ':x' + slot;
  await store.saveChecks(day.id, slot, { check_a: true });
  clock.add(MIN);
  await store.saveFeedback(day.id, slot, { pump: 2, soreness: 2, workload: 2, checks: { check_a: true }, note: '' }, false);
  clock.add(MIN);
  const row = await store.changeAnswers(fid, { pump: 3, checks: { check_a: false } });
  assert.equal(row.checks.check_a, true, 'a No never clears a Yes');
  assert.equal((await db.get('feedback', fid)).checks.check_a, true);
  await store.changeAnswers(fid, { checks: { check_a: null } });
  assert.equal((await db.get('feedback', fid)).checks.check_a, true, 'nor does a clear');
  assert.equal((await db.get('feedback', fid)).pump, 3);
  await assert.rejects(store.changeAnswers(fid, { checks: { check_z: true } }), isRefused('bad check'));
  await assert.rejects(store.changeAnswers(fid, { pump: 5 }), isRefused('bad answer'));
  await assert.rejects(store.changeAnswers(fid, { note: 'a' + String.fromCharCode(0x0b) + 'b' }), isRefused('bad text'));
});

test('Change answers writes a new saved_at and re-plans the next untouched day', async () => {
  const { db, clock, store } = await setup(ADJ);
  const b = await store.createBlock({ ...ONE_DAY([lift(1, 'leg_press', 2, 150), lift(2, 'lat_pulldown', 2, 100)], 4), switch_conditions: COND, levels: { quads: 'top', back: 'top' } });
  await store.switchProfile(b.id, T3, 'ADJUST');
  clock.add(MIN);
  await store.answerSleep(b.id + ':p1:d1', false);
  await playDay(store, clock, b.id + ':p1:d1', 10, { pump: 2, soreness: 2, workload: 2 });
  const dId = b.id + ':p2:d1';
  assert.equal(await slotCount(db, dId, 1), 3, 'row R8 adds a set');
  const fid = b.id + ':p1:d1:x1';
  const was = await db.get('feedback', fid);
  clock.add(MIN);
  const row = await store.changeAnswers(fid, { soreness: 4 });
  assert.equal(row.saved_at, clock.now());
  assert.ok(row.saved_at > was.saved_at, 'a new saved_at');
  assert.equal(row.soreness, 4);
  assert.equal(row.muscle, 'quads', 'feedback.muscle is the muscle key');
  assert.ok(await slotCount(db, dId, 1) < 3, 'the next day is planned from the new answers');
  assert.equal(await slotCount(db, dId, 2), 3, 'the other lift keeps its plan');
  // Once the next day has a tick, Change answers changes the answers only.
  const s = workOf(await db.byIndex('sets', 'day_id', dId), 2)[0];
  await store.tick(s.id, V(100, 10));
  const plan = JSON.stringify(await db.byIndex('sets', 'day_id', dId));
  clock.add(MIN);
  await store.changeAnswers(fid, { soreness: 2 });
  assert.equal(JSON.stringify(await db.byIndex('sets', 'day_id', dId)), plan, 'a started day is never planned again');
});

test('End block refused with a day open; planned days stay as they are', async () => {
  const { db, clock, store } = await setup();
  const b = await store.createBlock(SPEC());
  const d1 = b.id + ':p1:d1';
  await store.tick(d1 + ':x1:s1:none', V(150, 10));
  const before = db.dump();
  await assert.rejects(store.endBlock(b.id), isRefused('day open'));
  assert.equal(db.dump(), before, 'nothing written');
  clock.add(MIN);
  await store.finishDay(d1);
  const planned = await db.get('days', b.id + ':p1:d2');
  const nb = await store.endBlock(b.id);
  assert.equal(nb.status, 'done');
  assert.equal((await db.get('blocks', b.id)).status, 'done');
  assert.deepEqual(await db.get('days', b.id + ':p1:d2'), planned, 'a planned day stays as it is');
  await assert.rejects(store.endBlock(b.id), isRefused('block is done'));
});

test("liveEdit: a 'rest' swap after a move keeps the card's place; the template takes the new exercise with no weight", async () => {
  const { db, clock, store } = await setup();
  const b = await store.createBlock(SPEC_3SLOTS());
  const day = await store.currentDay();
  await store.moveSlot(day.id, 3, -1);
  const ns = await store.liveEdit({ type: 'swap', dayId: day.id, slot: 3, exercise_id: 'cable_row' }, 'rest');
  assert.deepEqual((await store.dayView(day.id)).slots, [1, ns, 2, 3]);
  const l = (await db.get('blocks', b.id)).day_templates[0].lifts.find(x => x.slot === 3);
  assert.deepEqual([l.exercise_id, l.start_load, l.rep_low, l.rep_high, l.sets], ['cable_row', null, null, null, 2]);
  // Round 2 day A plans the new exercise with no weight.
  const v = await store.dayView(day.id);
  for (const s of v.sets.filter(x => x.status === 'planned')) { clock.add(MIN); await store.tick(s.id, V(s.target.load === null ? 40 : s.target.load, 10)); }
  clock.add(MIN);
  await store.finishDay(day.id);
  await playDay(store, clock, b.id + ':p1:d2', 10);
  const r2 = workOf(await db.byIndex('sets', 'day_id', b.id + ':p2:d1'), 3);
  assert.ok(r2.length === 2 && r2.every(x => x.exercise_id === 'cable_row' && x.target.load === null));
});

test("liveEdit: a 'rest' swap on a 51-slot day keeps the card order capped", async () => {
  const { db, store, clock, day, spare } = await longDay();
  let target = 1;
  for (let k = 0; k < 21; k++) { clock.add(MIN); target = await store.swapExercise(day.id, target, spare[k % spare.length]); }
  clock.add(MIN);
  const ns = await store.liveEdit({ type: 'swap', dayId: day.id, slot: 2, exercise_id: spare[0] }, 'rest');
  const written = (await db.get('days', day.id)).slot_order;
  assert.ok(written.length <= 50, 'the order holds ' + written.length + ' entries');
  assert.ok(written.includes(ns));
});

test("liveEdit: a done day is deep-equal before and after every 'rest' edit (M37 store half)", async () => {
  const { db, clock, store } = await setup(ADJ);
  const b = await store.createBlock(SWITCHABLE());
  await playDay(store, clock, b.id + ':p1:d1', 10, { pump: 2, soreness: 2, workload: 2 });
  await store.switchProfile(b.id, T3, 'ADJUST');
  const d1 = b.id + ':p1:d1', d2 = b.id + ':p1:d2';
  const doneRows = async () => JSON.stringify([await db.get('days', d1), ...(await db.byIndex('sets', 'day_id', d1)).sort(setOrderOf), ...(await db.byIndex('feedback', 'day_id', d1))]);
  const before = await doneRows();
  const edits = [
    { type: 'add_set', slot: 1 }, { type: 'swap', slot: 2, exercise_id: 'seated_leg_curl' }, { type: 'move', slot: 1, dir: 1 },
    { type: 'relabel', label: 'Z' }, { type: 'add_exercise', exercise_id: 'cable_row', sets: 2 }, { type: 'remove', slot: 1 }];
  for (const e of edits) {
    clock.add(MIN);
    await store.liveEdit({ ...e, dayId: d2 }, 'rest');
    assert.equal(await doneRows(), before, e.type + ' leaves the done day as it was');
  }
  const tpl = (await db.get('blocks', b.id)).day_templates.find(d => d.day === 2);
  assert.equal(tpl.label, 'Z');
  assert.ok(tpl.lifts.some(l => l.exercise_id === 'cable_row' && l.rep_low === null && l.start_load === null), 'Add exercise with Rest of block adds the template lift');
  assert.ok(!tpl.lifts.some(l => l.slot === 1), 'Remove with Rest of block drops the template lift');
  assert.ok((await db.byIndex('sets', 'day_id', d2)).some(x => x.origin === 'added' && x.add_scope === 'rest'), 'Add set with Rest of block is the round hand add');
  await assert.rejects(store.liveEdit({ type: 'add_set', dayId: d1, slot: 1 }, 'rest'), isRefused(), 'a done day refuses');
  assert.equal(await doneRows(), before);
});

test('liveEdit: Add exercise takes 1 set in Fixed (his number when given), startingSets in Adjust each round, refused at LIFTS_PER_DAY', async () => {
  const { db, store } = await setup(ADJ);
  const b = await store.createBlock(SWITCHABLE());
  const d1 = b.id + ':p1:d1';
  assert.equal(await store.addExerciseDefault(d1, 'cable_row'), 1);
  const s1 = await store.liveEdit({ type: 'add_exercise', dayId: d1, exercise_id: 'cable_row' }, 'today');
  assert.equal(await slotCount(db, d1, s1), 1);
  const rows = workOf(await db.byIndex('sets', 'day_id', d1), s1);
  assert.ok(rows.every(x => x.origin === 'added' && x.add_scope === 'today' && x.target.load === null && x.target.rep_low === null && x.why === 'why.added'));
  const s2 = await store.liveEdit({ type: 'add_exercise', dayId: d1, exercise_id: 'cable_row', sets: 4 }, 'today');
  assert.equal(await slotCount(db, d1, s2), 4, 'his number in Fixed');
  assert.equal((await db.get('blocks', b.id)).day_templates[0].lifts.length, 2, 'Today only leaves the template');
  await assert.rejects(store.liveEdit({ type: 'add_exercise', dayId: d1, exercise_id: 'cable_row', sets: 21 }, 'today'), isRefused('bad sets'));
  await store.switchProfile(b.id, T3, 'ADJUST');
  const want = startingSetsOf('top');
  assert.equal(await store.addExerciseDefault(d1, 'cable_row'), want);
  const s3 = await store.liveEdit({ type: 'add_exercise', dayId: d1, exercise_id: 'cable_row', sets: 20 }, 'rest');
  assert.equal(await slotCount(db, d1, s3), want, 'startingSets in Adjust each round');
  const l = (await db.get('blocks', b.id)).day_templates[0].lifts.find(x => x.slot === s3);
  assert.equal(l.sets, want);
  // A full day: LIFTS_PER_DAY exercises.
  const { store: st2, day } = await longDay();
  const before = JSON.stringify(await db.all('sets'));
  await assert.rejects(st2.liveEdit({ type: 'add_exercise', dayId: day.id, exercise_id: 'cable_row' }, 'today'), isRefused('full'));
  await assert.rejects(st2.liveEdit({ type: 'add_exercise', dayId: day.id, exercise_id: 'cable_row' }, 'rest'), isRefused('full'));
  assert.equal(JSON.stringify(await db.all('sets')), before);
});

test('liveEdit: Remove skips every set not done Today only, Rest of block also drops the template lift; the last exercise is refused in both (code last)', async () => {
  const { db, clock, store } = await setup();
  const b = await store.createBlock(SPEC_3SLOTS());
  const d1 = b.id + ':p1:d1';
  await store.tick(d1 + ':x1:s1:none', V(100, 10));
  clock.add(MIN);
  assert.equal(await store.liveEdit({ type: 'remove', dayId: d1, slot: 1 }, 'today'), 1);
  const s1 = workOf(await db.byIndex('sets', 'day_id', d1), 1);
  assert.deepEqual(s1.map(x => [x.status, x.why]), [['done', 'why.plan'], ['skipped', 'why.skipped']]);
  assert.equal((await db.get('blocks', b.id)).day_templates[0].lifts.length, 3, 'Today only keeps the template');
  await store.liveEdit({ type: 'remove', dayId: d1, slot: 2 }, 'rest');
  assert.deepEqual((await db.get('blocks', b.id)).day_templates[0].lifts.map(l => l.slot), [1, 3]);
  // Day B holds one exercise: Remove is refused in both scopes, nothing written.
  const d2 = b.id + ':p1:d2';
  const before = db.dump();
  await assert.rejects(store.liveEdit({ type: 'remove', dayId: d2, slot: 1 }, 'today'), isRefused('last'));
  await assert.rejects(store.liveEdit({ type: 'remove', dayId: d2, slot: 1 }, 'rest'), isRefused('last'));
  assert.equal(db.dump(), before);
});

test('liveEdit: Add set is refused on no_added_sets or flags_set false in both profiles (code flag)', async () => {
  const { db, store } = await setup(ADJ, { uuid: fixedIds() });
  const nb = await store.importBlock(JSON.stringify(blockV1()), true);
  await db.put('blocks', { ...(await db.get('blocks', nb.id)), switch_conditions: COND });
  const d1 = nb.id + ':p1:d1';
  // Slot 2: ex_p, no_added_sets on the block. A new card of his own lift: flags_set false, no block entry.
  const own = await store.addCustomExercise({ name: 'My made-up lift', muscle: 'legs', equipment: 'cable' });
  const s3 = await store.liveEdit({ type: 'add_exercise', dayId: d1, exercise_id: own.id }, 'today');
  const before = db.dump();
  for (const slot of [2, s3]) await assert.rejects(store.liveEdit({ type: 'add_set', dayId: d1, slot }, 'today'), isRefused('flag'), 'Fixed slot ' + slot);
  assert.equal(db.dump(), before);
  await store.switchProfile(nb.id, T3, 'ADJUST');
  for (const slot of [2, s3]) for (const sc of ['today', 'rest']) await assert.rejects(store.liveEdit({ type: 'add_set', dayId: d1, slot }, sc), isRefused('flag'), 'Adjust ' + sc + ' slot ' + slot);
  const ids = await store.liveEdit({ type: 'add_set', dayId: d1, slot: 1 }, 'rest');
  assert.equal((await db.get('sets', ids[0])).add_scope, 'rest');
});

test('R13: a check scoped to a custom lift survives a Rest of block swap and a remove, each through back up and restore (M84, store half)', async () => {
  const { db, clock, store } = await setup(null, { uuid: fixedIds() });
  const f = blockV1();
  f.block.checks[0].lifts = ['ex_p'];
  const nb = await store.importBlock(JSON.stringify(f), true);
  const exP = nb.id_map.ex_p;
  const d1 = nb.id + ':p1:d1';
  const roundTrip = async () => { clock.add(MIN); await store.restoreFile(JSON.stringify(await store.backupObject())); return db.get('blocks', nb.id); };
  let b = await roundTrip();
  assert.equal(checksFor(b, exP).length, 1, 'the check reads the phone id after import');
  clock.add(MIN);
  await store.liveEdit({ type: 'swap', dayId: d1, slot: 2, exercise_id: 'cable_row' }, 'rest');
  b = await roundTrip();
  assert.deepEqual(b.checks[0].lifts, ['cable_row'], 'the swap maps the check to the new lift');
  assert.equal(checksFor(b, 'cable_row').length, 1);
  clock.add(MIN);
  await store.liveEdit({ type: 'remove', dayId: d1, slot: 2 }, 'rest');
  b = await roundTrip();
  assert.deepEqual(b.checks[0].lifts, ['cable_row'], 'a remove leaves the check list as it is');
  assert.equal(checksFor(b, 'cable_row').length, 1);
});

test('R15a: a tick queued right after a Rest of block edit starts lands after it and is kept', async () => {
  const { db, store } = await setup();
  const b = await store.createBlock(SPEC_3SLOTS());
  const dId = b.id + ':p1:d1';
  const id = dId + ':x2:s1:none';
  await whileHeld(db, () => store.liveEdit({ type: 'swap', dayId: dId, slot: 1, exercise_id: 'cable_row' }, 'rest'), () => store.tick(id, V(50, 9)));
  const s = await db.get('sets', id);
  assert.equal(s.status, 'done', 'the tick is kept');
  assert.equal(s.done.reps, 9);
  assert.equal((await db.get('days', dId)).status, 'open', 'the day the tick opened stays open');
  assert.equal((await db.get('blocks', b.id)).day_templates[0].lifts[0].exercise_id, 'cable_row');
});

test('R15c: a tick on the next day queued right after Change answers starts lands after its re-plan and is kept', async () => {
  const { db, clock, store } = await setup();
  const b = await store.createBlock(SPEC());
  await playDay(store, clock, b.id + ':p1:d1', 10, { pump: 2, soreness: 2, workload: 2 });
  const nextId = b.id + ':p1:d2:x1:s1:none';
  await whileHeld(db, () => store.changeAnswers(b.id + ':p1:d1:x1', { pump: 3 }), () => store.tick(nextId, V(85, 8)));
  const s = await db.get('sets', nextId);
  assert.equal(s.status, 'done', 'the tick on the next day is kept');
  assert.equal(s.done.load, 85);
  assert.equal((await db.get('feedback', b.id + ':p1:d1:x1')).pump, 3);
});

test('R15d: a Move queued right after a switch to Adjust each round starts is kept', async () => {
  const { db, store } = await setup(ADJ);
  const b = await store.createBlock(SWITCHABLE());
  const dId = b.id + ':p1:d1';
  await whileHeld(db, () => store.switchProfile(b.id, T3, 'ADJUST'), () => store.moveSlot(dId, 2, -1));
  const d = await db.get('days', dId);
  assert.equal(d.profile, 'adaptive', 'the switch planned the day');
  assert.deepEqual(d.slot_order, [2, 1], 'the Move is kept');
});

test('feedbackPlan: Adjust each round asks soreness alone at the first tick on a muscle trained before; Fixed asks nothing then; the sheet merges', async () => {
  const { db, clock, store } = await setup(ADJ);
  const b = await store.createBlock({ ...ONE_DAY([lift(1, 'leg_press', 2, 150), lift(2, 'lat_pulldown', 2, 100)], 4), switch_conditions: COND });
  const d1 = b.id + ':p1:d1';
  assert.deepEqual(await store.feedbackPlan(d1, 1, 'first_tick'), { ask: [] }, 'Fixed: no first tick sheet');
  assert.deepEqual(await store.feedbackPlan(d1, 1, 'tick'), { ask: ['checks'] });
  await store.switchProfile(b.id, T3, 'ADJUST');
  assert.deepEqual(await store.feedbackPlan(d1, 1, 'first_tick'), { ask: [] }, "never on the muscle's first day of the block");
  await playDay(store, clock, d1, 10, { pump: 2, soreness: 2, workload: 2 });
  const d2 = b.id + ':p2:d1';
  assert.deepEqual(await store.feedbackPlan(d2, 1, 'first_tick'), { ask: ['soreness'] });
  await store.saveChecks(d2, 1, { check_a: true }).catch(() => {});
  await store.saveSoreness(d2, 1, 3);
  const row = await db.get('feedback', d2 + ':x1');
  assert.deepEqual([row.soreness, row.pending, row.muscle], [3, true, 'quads']);
  assert.deepEqual(await store.feedbackPlan(d2, 1, 'first_tick'), { ask: [] }, 'asked once that day');
  assert.deepEqual(await store.feedbackPlan(d2, 1, 'end'), { ask: ['pump', 'workload', 'checks'] });
  assert.deepEqual(await store.feedbackPlan(d2, 1, 'end', { soreness_put_off: true }), { ask: ['pump', 'soreness', 'workload', 'checks'] });
  // The end sheet with no soreness key keeps the first tick answer.
  await store.saveFeedback(d2, 1, { pump: 2, workload: 2, checks: {}, note: '' }, false);
  assert.deepEqual([(await db.get('feedback', d2 + ':x1')).soreness, (await db.get('feedback', d2 + ':x1')).pending], [3, false]);
  await assert.rejects(store.saveSoreness(d2, 1, 5), isRefused('bad answer'));
});

test('slotWhy, retarget and blockOverview: the Why line and the retarget line in Adjust each round only; the overview counts sets by muscle', async () => {
  const { db, clock, store } = await setup(ADJ);
  const b = await store.createBlock({ ...ONE_DAY([lift(1, 'leg_press', 2, 150), lift(2, 'lat_pulldown', 2, 100)], 4), switch_conditions: COND, levels: { quads: 'top', back: 'top' } });
  const d1 = b.id + ':p1:d1';
  assert.deepEqual(await store.slotWhy(d1), {}, 'Fixed: no Why line');
  assert.equal(await store.retarget(d1 + ':x1:s1:none', 160), null, 'Fixed: the goal as written');
  await store.switchProfile(b.id, T3, 'ADJUST');
  await store.answerSleep(d1, false);
  await playDay(store, clock, d1, 10, { pump: 2, soreness: 2, workload: 2 });
  const d2 = b.id + ':p2:d1';
  await store.answerSleep(d2, false);
  assert.equal((await store.slotWhy(d2))[1], 'why.R8');
  const s = (await db.get('sets', d2 + ':x1:s1:none'));
  assert.deepEqual(await store.retarget(s.id, s.target.load), { rep_low: s.target.rep_low });
  assert.deepEqual(await store.retarget(s.id, s.target.load + 1000), { effort_only: true });
  const o = await store.blockOverview(b.id);
  assert.equal(o.round, 2);
  assert.deepEqual(o.rounds.map(r => [r.pass, r.state, r.easy]), [[1, 'done', false], [2, 'now', false], [3, 'later', false], [4, 'later', true]]);
  assert.deepEqual(o.days.map(d => [d.id, d.status, d.now]), [[d2, 'planned', true]]);
  const quads = o.muscles.find(m => m.muscle === 'quads');
  assert.deepEqual([quads.sets, quads.change], [3, 1], 'three sets this round, one more than last round');
});

test('resize: Fixed adds and removes a round through engine.resizeBlock; below the current round and a done block are refused', async () => {
  const { db, clock, store } = await setup();
  const b = await store.createBlock(SPEC());
  assert.equal((await store.resize(b.id, 1)).passes, 4);
  assert.equal((await db.get('blocks', b.id)).passes, 4);
  await store.resize(b.id, -1);
  assert.equal((await db.get('blocks', b.id)).passes, 3);
  await assert.rejects(store.resize(b.id, 2), isRefused('bad request'));
  await playDay(store, clock, b.id + ':p1:d1', 10);
  await playDay(store, clock, b.id + ':p1:d2', 10);
  // Round 1 done, round 2 day A planned: down to 1 round would leave that planned day past the
  // end, and no write deletes a day row (E16), so it is refused with every store unchanged.
  await store.resize(b.id, -1);
  const before = db.dump();
  await assert.rejects(store.resize(b.id, -1), isRefused('day past the end'));
  assert.equal(db.dump(), before);
  await store.endBlock(b.id);
  await assert.rejects(store.resize(b.id, 1), isRefused('block is done'));
});

test('every Slice 2 write of B.4.8 is in the guarded write list (LN1 pattern)', () => {
  for (const name of ['answerSleep', 'setSetType', 'saveSoreness', 'liveEdit', 'resize', 'switchProfile', 'switchBack', 'changeAnswers', 'endBlock']) assert.ok(WRITES.includes(name), name);
});
const setOrderOf = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const startingSetsOf = (level) => startingSets(RULES.profiles.adaptive, {}, level);

// 16 B.1 step 8: the Block tab reads. A shown round gives that round's day rows (each with its
// place id and tally); hard_left counts the places of the rounds before the easy round with no done
// or skipped day (the Easy round stop sheet, B.5 row 4).
test('blockOverview: a shown round gives its day rows with place ids and tallies; hard_left counts the unfinished hard places, a skipped day counts as finished', async () => {
  const { clock, store } = await setup(ADJ);
  const b = await store.createBlock({ ...SPEC(), switch_conditions: COND, levels: { quads: 'top', back: 'top', chest: 'top' } });
  await store.switchProfile(b.id, T3, 'ADJUST');
  const p = (pass, day) => b.id + ':p' + pass + ':d' + day;
  let o = await store.blockOverview(b.id);
  assert.deepEqual(o.rounds.map(r => [r.pass, r.easy]), [[1, false], [2, false], [3, true]]);
  assert.equal(o.hard_left, 4, 'rounds 1 and 2 of a 2-day block');
  assert.equal(o.shown, 1);
  assert.deepEqual(o.days.map(d => [d.ref, d.pass, d.status, d.now, d.done]), [[p(1, 1), 1, 'planned', true, 0], [p(1, 2), 1, 'planned', false, 0]]);
  assert.ok(o.days.every(d => d.total > 0), 'a planned day has its set tally');
  const o3 = await store.blockOverview(b.id, 3);
  assert.equal(o3.shown, 3);
  assert.equal(o3.round, 1, 'the current round stays round 1');
  assert.deepEqual(o3.days.map(d => [d.id, d.ref, d.status, d.total]), [[null, p(3, 1), 'notplanned', 0], [null, p(3, 2), 'notplanned', 0]]);
  assert.equal((await store.blockOverview(b.id, 9)).shown, 1, 'a round past the strip shows this round');
  assert.equal((await store.blockOverview(b.id, '2')).shown, 1, 'only a whole number picks a round');
  await playDay(store, clock, p(1, 1), 10);
  o = await store.blockOverview(b.id);
  assert.equal(o.hard_left, 3);
  assert.equal(o.days[0].done, o.days[0].total, 'a done day shows every set done');
  await store.skipDay(p(1, 2));
  assert.equal((await store.blockOverview(b.id)).hard_left, 2, 'a skipped day is finished');
  const { store: s2 } = await setup();
  const f = await s2.createBlock(SPEC());
  assert.equal((await s2.blockOverview(f.id)).hard_left, 0, 'a Fixed block has no easy round');
});

// 16 B.5 row 2, B.10 item 9: the read-only day view takes an id that passes checkId and names a day
// of a block on the phone (a day row, or a place of the block with no row yet), else null.
test('dayPreview: a day row gives its state; a place with no row is Not planned yet; a bad id is refused and a place past the end or of no block is null', async () => {
  const { clock, store } = await setup();
  const b = await store.createBlock(SPEC());
  const p = (pass, day) => b.id + ':p' + pass + ':d' + day;
  assert.equal((await store.dayPreview(p(1, 1))).state, 'current');
  const later = await store.dayPreview(p(1, 2));
  assert.deepEqual([later.state, later.after], ['later', 'A']);
  const np = await store.dayPreview(p(2, 1));
  assert.deepEqual([np.state, np.after, np.day.status, np.sets.length], ['notplanned', 'B', 'notplanned', 0]);
  assert.deepEqual(np.lifts.map(l => [l.slot, l.exercise_id, l.sets]), [[1, 'leg_press', 2], [2, 'lat_pulldown', 2]]);
  assert.equal(await store.dayPreview(p(4, 1)), null, 'past the last round');
  assert.equal(await store.dayPreview(p(1, 3)), null, 'no such day in the block');
  assert.equal(await store.dayPreview(b.id + ':p01:d1'), null, 'not the id the block would give');
  assert.equal(await store.dayPreview('nope:p1:d1'), null, 'no such block');
  await assert.rejects(store.dayPreview('bad id!'), isRefused('bad id'));
  await assert.rejects(store.dayPreview('__proto__'), isRefused('bad id'));
  const v = await store.dayView(p(1, 1));
  clock.add(MIN);
  await store.tick(v.sets[0].id, V(v.sets[0].target.load, 10));
  assert.equal((await store.dayPreview(p(1, 1))).state, 'open');
  await store.finishDay(p(1, 1));
  assert.equal((await store.dayPreview(p(1, 1))).state, 'done');
  assert.equal((await store.dayPreview(p(1, 2))).state, 'current');
  await store.skipDay(p(1, 2));
  assert.equal((await store.dayPreview(p(1, 2))).state, 'skipped');
});


// ---------------- Slice 3 (17 C.2.5, C.2.7, C.3.1) ----------------

test('C.2.7: a body-load lift saves done.load 0 whatever was typed', async () => {
  const { db, store } = await setup();
  assert.equal((await db.get('exercises', 'push_up')).load_kind, 'body');
  await store.createBlock({ name: 'Body', passes: 2, day_templates: [{ day: 1, label: 'A', lifts: [lift(1, 'push_up', 1, null)] }] });
  const v = await store.dayView((await store.currentDay()).id);
  const row = await store.tick(v.sets[0].id, V(25, 12));
  assert.equal(row.done.load, 0);
  assert.equal(row.done.reps, 12);
});

test('M75: Make my own exercise: three answers with a yes on the machine question give machine true and flags_set true; no questions give flags_set false', async () => {
  const { store } = await setup();
  const none = await store.addCustomExercise({ name: 'Plain move', muscle: 'legs', equipment: 'other', flags: { machine: true, no_added_sets: false, left_out_of_builder: false } });
  assert.equal(none.flags_set, false, 'no block, no question: never screened');
  assert.equal(none.machine, false, 'an answer to a question nobody asked is never read');
  assert.deepEqual(await store.flagQuestions(), []);
  await store.importBlock(JSON.stringify(blockV2()), true);
  const qs = await store.flagQuestions();
  assert.deepEqual(qs.map(q => q.key), ['machine', 'no_added_sets', 'left_out_of_builder']);
  const all = await store.addCustomExercise({ name: 'Seat move', muscle: 'legs', equipment: 'other', flags: { machine: true, no_added_sets: false, left_out_of_builder: false } });
  assert.equal(all.machine, true);
  assert.equal(all.flags_set, true);
  const part = await store.addCustomExercise({ name: 'Half asked', muscle: 'legs', equipment: 'other', flags: { machine: false } });
  assert.equal(part.flags_set, false, 'two questions left open: not screened');
});

test('C.2.5 item 2: a phone-made block takes exercise_flags, checks, scores and rule_notes from his block file block; with none they stay empty', async () => {
  const { db, store } = await setup();
  const bare = await store.createBlock(SPEC());
  assert.deepEqual(bare.exercise_flags, {});
  const file = await store.importBlock(JSON.stringify(blockV2()), false);
  assert.ok(Object.keys(file.exercise_flags).length > 0, 'the file block has flags');
  const made = await store.createBlock(SPEC());
  assert.deepEqual(made.exercise_flags, file.exercise_flags, 'flags from the newest file block');
  assert.deepEqual(made.checks, file.checks);
  assert.deepEqual(made.scores, file.scores);
  assert.deepEqual(made.rule_notes, file.rule_notes);
  assert.equal((await db.all('blocks')).length, 3);
});

test('M74: a new block never takes the Current mark on its own; his yes moves it; with no current block it takes it', async () => {
  const { db, store } = await setup();
  const a = await store.createBlock(SPEC());
  assert.equal(await db.setting('active_block_id'), a.id, 'no block was current: the first block takes the mark');
  const b = await store.createBlock(SPEC());
  assert.equal(await db.setting('active_block_id'), a.id, 'another block is current: the mark stays');
  const c = await store.createBlock(SPEC(), null, { activate: true });
  assert.equal(await db.setting('active_block_id'), c.id, 'his yes moves the mark');
  assert.notEqual(b.id, c.id);
});

test('M66: saved equipment: the key absent reads as every kind; an empty, unknown or repeated list is refused and nothing is stored', async () => {
  const { db, store } = await setup();
  const { EQUIPMENT_DETAILS } = await import('../../../backup.js');
  assert.deepEqual(await store.getSavedEquipment(), [...EQUIPMENT_DETAILS]);
  for (const bad of [[], ['smithy'], ['band', 'band'], null]) {
    await assert.rejects(store.setSavedEquipment(bad), (e) => e.name === 'Refused', JSON.stringify(bad));
  }
  assert.equal(await db.setting('equipment_saved', 'absent'), 'absent', 'a refused list stores nothing');
  assert.deepEqual(await store.setSavedEquipment(['band', 'machine']), ['machine', 'band'], 'kept in list order');
  assert.deepEqual(await store.getSavedEquipment(), ['machine', 'band']);
});

test('C.3.1: a restore takes equipment_saved from the file', async () => {
  const { clock, store } = await setup();
  await store.createBlock(SPEC());
  await store.setSavedEquipment(['cable', 'body']);
  const f = await store.backupObject();
  await store.setSavedEquipment(['machine']);
  clock.add(MIN);
  await store.restoreFile(JSON.stringify(f));
  assert.deepEqual(await store.getSavedEquipment(), ['cable', 'body']);
});

// ---------------- Slice 3 block list (17 C.3.2) ----------------

async function twoBlocks() {
  const box = await setup();
  const a = await box.store.createBlock({ ...SPEC(), name: 'First' });
  box.clock.add(MIN);
  const b = await box.store.createBlock({ ...SPEC(), name: 'Second' });
  return { db: box.db, clock: box.clock, store: box.store, a, b };
}

test('C.3.2: listBlocks gives every block newest first with the Current mark and its days done', async () => {
  const { store, clock, a, b } = await twoBlocks();
  await logDay(store, clock);
  const list = await store.listBlocks();
  assert.deepEqual(list.map(x => x.id), [b.id, a.id]);
  assert.deepEqual(list.map(x => x.current), [false, true]);
  assert.equal(list[1].days_done, 1);
  assert.equal(list[0].days_done, 0);
});

test('C.3.2: Use this block moves the mark on his tap; a finished block is never made current', async () => {
  const { db, store, a, b } = await twoBlocks();
  await store.setCurrentBlock(b.id);
  assert.equal(await db.setting('active_block_id'), b.id);
  await db.put('blocks', { ...(await db.get('blocks', a.id)), status: 'done' });
  await assert.rejects(store.setCurrentBlock(a.id), (e) => e.name === 'Refused');
  assert.equal(await db.setting('active_block_id'), b.id);
});

test('HW4: rename shows on Today and the list; a blank name is refused; the block note saves (L10)', async () => {
  const { store, a } = await twoBlocks();
  await store.renameBlock(a.id, 'Legs first');
  assert.equal((await store.activeBlock()).name, 'Legs first');
  assert.equal((await store.listBlocks()).find(x => x.id === a.id).name, 'Legs first');
  await assert.rejects(store.renameBlock(a.id, '   '), (e) => e.name === 'Refused');
  await store.setBlockNote(a.id, 'Seat 4 on the press');
  assert.equal((await store.listBlocks()).find(x => x.id === a.id).notes, 'Seat 4 on the press');
});

test('M52: deleteBlock removes every day, set and feedback row of that block and nothing else', async () => {
  const { db, store, clock, a, b } = await twoBlocks();
  const d = await store.currentDay();
  const v = await store.dayView(d.id);
  await store.tick(v.sets[0].id, V(150, 10));
  await store.saveFeedback(d.id, v.sets[0].slot, { pump: 2 }, false).catch(() => {});
  assert.ok((await db.all('feedback')).some(f => f.day_id === d.id), 'the block has a feedback row to delete');
  const otherSets = (await db.all('sets')).filter(s => s.block_id === b.id).length;
  await assert.rejects(store.deleteBlock(a.id, 'delete'), (e) => e.name === 'Refused', 'a refused word changes nothing');
  assert.ok(await db.get('blocks', a.id));
  await store.deleteBlock(a.id, 'DELETE');
  assert.equal(await db.get('blocks', a.id), undefined);
  for (const s of ['days', 'sets']) assert.equal((await db.all(s)).filter(r => r.block_id === a.id).length, 0, s);
  assert.equal((await db.all('feedback')).filter(f => f.day_id.startsWith(a.id)).length, 0, 'feedback of the block');
  assert.equal((await db.all('sets')).filter(s => s.block_id === b.id).length, otherSets, 'the other block keeps its sets');
  assert.ok((await db.all('exercises')).length > 0, 'exercises stay');
});

test('M51: a before-delete safety copy exists before the delete and Undo brings every store back', async () => {
  const { db, store, clock, a } = await twoBlocks();
  const keep = ['snapshots', 'settings', 'exercises', 'templates'];
  const before = db.dump(keep);
  clock.add(MIN);
  await store.deleteBlock(a.id, 'DELETE');
  assert.equal((await db.all('snapshots')).length, 1, 'the safety copy is written');
  const snaps = await store.listSnapshots();
  assert.equal(snaps[0].reason, 'before-delete');
  clock.add(MIN);
  await store.undoSnapshot(snaps[0].id);
  // Undo rewrites each row through the restore path, so key order may differ: compare the rows.
  const same = (() => { try { assert.deepStrictEqual(JSON.parse(db.dump(keep)), JSON.parse(before)); return true; } catch (e) { return false; } })();
  assert.ok(same, 'Undo brings blocks, days, sets and feedback back exactly');
  assert.equal(await db.setting('active_block_id'), a.id, 'and the Current mark');
});

test('M53: deleting the current block moves the mark to the other active block (S02, HW6); deleting the last block sets it to null', async () => {
  const { db, store, a, b } = await twoBlocks();
  assert.equal(await db.setting('active_block_id'), a.id);
  await store.deleteBlock(a.id, 'DELETE');
  assert.equal(await db.setting('active_block_id'), b.id);
  await store.deleteBlock(b.id, 'DELETE');
  assert.equal(await db.setting('active_block_id'), null);
  assert.deepEqual(await store.listBlocks(), []);
});

test('M89: a tick held behind a slow write, then a delete: no row names the deleted block afterwards', async () => {
  const { db, store, a } = await twoBlocks();
  const d = await store.currentDay();
  const v = await store.dayView(d.id);
  db.faults.holdBatch = 1;
  const tk = store.tick(v.sets[0].id, V(150, 10));
  await db.spy.batchHeld;
  const del = store.deleteBlock(a.id, 'DELETE');
  await new Promise((res) => setTimeout(res, 30));
  db.releaseBatch();
  await Promise.allSettled([tk, del]);
  for (const s of ['days', 'sets']) assert.deepEqual((await db.all(s)).filter(r => r.block_id === a.id).map(r => r.id), [], s);
  assert.equal(await db.get('blocks', a.id), undefined);
});


// ---------------- S2: templates, guided builder, levels, copy (17 C.3.4 to C.3.8) ----------------

// A block file that screens every list row by the BUILDER item 1 rule (health-coach C2): a spotter
// row is left out of the builder, a laps row gets both flags, every other row both false; extra
// sets the flags of named ids.
function screeningFile(extra) {
  const f = blockV2();
  const flags = {};
  for (const ex of SEED_EXERCISES) {
    const spotter = Array.isArray(ex.tags) && ex.tags.includes('spotter');
    const laps = ex.count_label === 'laps';
    flags[ex.id] = { no_added_sets: laps, left_out_of_builder: laps || spotter };
  }
  for (const [id, v] of Object.entries(f.block.exercise_flags)) if (!(id in flags)) flags[id] = v;
  Object.assign(flags, extra || {});
  f.block.exercise_flags = flags;
  return JSON.stringify(f);
}
const tplIds = (tp) => tp.days.map(d => d.slots.map(s => s.exercise_id));

test('S05: Start from a real template then Save gives a block whose days and exercises equal the template (every slot screened)', async () => {
  const { store } = await setup();
  const tp = TEMPLATES.find(x => x.days_per_rotation === 3);
  // His file screens every exercise this template names as fit for the builder.
  const fit = {};
  for (const d of tp.days) for (const sl of d.slots) fit[sl.exercise_id] = { no_added_sets: false, left_out_of_builder: false };
  await store.importBlock(screeningFile(fit), true);
  assert.ok(tp, 'a 3-day template ships');
  const draft = await store.templateToDraft(tp.id);
  assert.equal(draft.step, 2);
  assert.equal(draft.dropped, 0);
  assert.equal(draft.template_id, tp.id);
  for (const d of draft.days) for (const l of d.lifts) { assert.equal(l.reps_left_target, 2, 'C5: every slot stops 2 short'); assert.equal(l.start_load, null, 'G29'); }
  const { blockSpec } = await import('../../../ui/builder.js');
  const spec = blockSpec(draft);
  const b = await store.createBlock(spec, null, { activate: true });
  assert.deepEqual(b.day_templates.map(d => d.lifts.map(l => l.exercise_id)), tplIds(tp));
  assert.equal(b.template_id, tp.id);
  assert.deepEqual(b.levels, tp.levels);
  assert.equal(b.profile, 'fixed');
});

test('M71: a template slot whose exercise the flag source leaves out of the builder never reaches the block; it is refilled or dropped (C7)', async () => {
  const { store } = await setup();
  const tp = TEMPLATES[0];
  const first = tp.days[0].slots[0].exercise_id;
  await store.importBlock(screeningFile({ [first]: { no_added_sets: false, left_out_of_builder: true } }), true);
  const draft = await store.templateToDraft(tp.id);
  const ids = draft.days.flatMap(d => d.lifts.map(l => l.exercise_id));
  assert.ok(!ids.includes(first), 'the left-out exercise is not in the draft');
  const total = tp.days.reduce((n, d) => n + d.slots.length, 0);
  assert.equal(ids.length + draft.dropped, total, 'every slot is either filled or counted as dropped');
});

test('C.3.4: with no block file, an unscreened list row in a template is refilled by a screened row of its muscle, or dropped and counted', async () => {
  const { store } = await setup();
  const tp = TEMPLATES[0];
  const draft = await store.templateToDraft(tp.id);
  const pool = await store.poolFor(null);
  const byId = new Map(pool.map(r => [r.id, r]));
  for (const d of draft.days) for (const l of d.lifts) assert.ok(byId.get(l.exercise_id).screened, l.exercise_id + ' is screened');
  const total = tp.days.reduce((n, d) => n + d.slots.length, 0);
  assert.equal(draft.days.reduce((n, d) => n + d.lifts.length, 0) + draft.dropped, total);
});

test('S04: listTemplates: Days 3 and a focus narrow the list; search finds by name; Made by mine lists only his', async () => {
  const { store } = await setup();
  const all = await store.listTemplates({});
  assert.equal(all.length, TEMPLATES.length);
  const three = await store.listTemplates({ days: [3] });
  assert.ok(three.length > 0 && three.length < all.length && three.every(x => x.days_per_rotation === 3));
  const focus = TEMPLATES[0].focus_key;
  const f = await store.listTemplates({ focus: [focus] });
  assert.ok(f.length > 0 && f.length < all.length && f.every(x => x.focus_key === focus));
  const name = TEMPLATES[2].name;
  const q = await store.listTemplates({ q: name.slice(0, 12).toUpperCase() });
  assert.ok(q.some(x => x.id === TEMPLATES[2].id), 'search is case blind');
  assert.deepEqual(await store.listTemplates({ author: ['mine'] }), []);
  await store.setSavedEquipment(['dumbbell']);
  const fits = await store.listTemplates({ equipment: 'fits' });
  assert.ok(fits.every(x => x.equipment.every(k => k === 'dumbbell')));
});

test('BW13 HW5: save a block as a template; it lists under Made by mine and starts a block with the same days', async () => {
  const { store, clock } = await setup();
  const a = await store.createBlock(SPEC());
  clock.add(MIN);
  const row = await store.saveBlockAsTemplate(a.id, 'My two days');
  assert.match(row.id, /^m/);
  assert.equal(row.author, 'mine');
  for (const d of row.days) for (const sl of d.slots) assert.deepEqual(Object.keys(sl).sort(), ['exercise_id', 'priority', 'rep_high', 'rep_low', 'sets']);
  const mine = await store.listTemplates({ author: ['mine'] });
  assert.deepEqual(mine.map(x => x.id), [row.id]);
  const draft = await store.templateToDraft(row.id);
  assert.deepEqual(draft.days.map(d => d.lifts.map(l => l.exercise_id)), a.day_templates.map(d => d.lifts.map(l => l.exercise_id)));
  assert.deepEqual(draft.days.map(d => d.lifts.map(l => l.sets)), a.day_templates.map(d => d.lifts.map(l => l.sets)), 'his template keeps its own set counts');
  await assert.rejects(store.saveBlockAsTemplate(a.id, '   '), /bad text/);
});

test('M91: deleting one of his templates keeps a before-delete safety copy and Undo brings it back; ours is refused', async () => {
  const { db, store, clock } = await setup();
  const a = await store.createBlock(SPEC());
  const row = await store.saveBlockAsTemplate(a.id, 'Keep me');
  clock.add(MIN);
  await assert.rejects(store.deleteTemplate(TEMPLATES[0].id), /ours/);
  await store.deleteTemplate(row.id);
  assert.deepEqual(await db.all('templates'), []);
  const snaps = await store.listSnapshots();
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0].reason, 'before-delete');
  clock.add(MIN);
  await store.undoSnapshot(snaps[0].id);
  assert.deepEqual((await db.all('templates')).map(r => r.id), [row.id]);
});

test('C.3.4: a template id is checked by its pattern before any read', async () => {
  const { store } = await setup();
  await assert.rejects(store.getTemplate('../x'), /bad id/);
  await assert.rejects(store.getTemplate('__proto__'), /bad id/);
  assert.equal(await store.getTemplate('t_no_such_one'), null);
});

test('C.3.5: guidedLayout then guidedSave makes a Fixed block with his levels, flags from his file and a reps-left goal of 2 on every lift', async () => {
  const { store } = await setup();
  const file = await store.importBlock(screeningFile(), true);
  const levels = { top: ['quads', 'chest'], middle: ['back'], bottom: ['calves'] };
  const { board } = await store.guidedLayout(3, levels);
  assert.equal(board.length, 3);
  const g = { board, levels, name: 'Guided one', notes: '', passes: 4, unit: null };
  const b = await store.guidedSave(g, { activate: false });
  assert.equal(b.profile, 'fixed');
  assert.deepEqual(b.levels, { chest: 'top', quads: 'top', back: 'middle', calves: 'bottom' });
  assert.deepEqual(b.exercise_flags, file.exercise_flags);
  for (const d of b.day_templates) for (const l of d.lifts) { assert.equal(l.reps_left_target, 2); assert.equal(l.rep_low, null); assert.equal(l.start_load, null); }
  await assert.rejects(store.guidedSave({ ...g, board: [...board, { day: 4, label: 'D', lifts: [] }] }), /empty day/);
});

test('C.2.5 BUILDER item 1: after his block file loads, autofill and autoBuildDays never place a spotter row or a laps row', async () => {
  const { store } = await setup();
  await store.importBlock(screeningFile(), true);
  const bad = new Set(SEED_EXERCISES.filter(e => e.count_label === 'laps' || (Array.isArray(e.tags) && e.tags.includes('spotter'))).map(e => e.id));
  assert.ok(bad.size > 0);
  const levels = { top: ['chest', 'quads', 'abs_core'], middle: ['back', 'glutes', 'forearms_grip'], bottom: ['hamstrings', 'calves', 'shoulders'] };
  for (const days of [2, 3, 4, 5, 6]) {
    const { board } = await store.guidedLayout(days, levels);
    const again = await store.autofill({ board }, { emptyOnly: false });
    for (const bd of [board, again.board]) for (const d of bd) for (const l of d.lifts) assert.ok(!bad.has(l.exercise_id), l.exercise_id + ' placed on ' + days + ' days');
  }
});

test('X04: autofill with Band unpicked never picks a band row; Fill empty slots only leaves a picked slot as it was', async () => {
  const { store } = await setup();
  await store.importBlock(screeningFile(), true);
  const kinds = ['band'];
  const { board } = await store.guidedLayout(2, { top: ['chest', 'back'], middle: [], bottom: [] });
  for (const d of board) for (const l of d.lifts) l.exercise_id = null;
  const onlyBand = await store.autofill({ board }, { equipment: kinds });
  const pool = new Map((await store.poolFor(await store.activeBlock())).map(r => [r.id, r]));
  for (const d of onlyBand.board) for (const l of d.lifts) if (l.exercise_id) assert.equal(pool.get(l.exercise_id).equipment_detail, 'band');
  const noBand = await store.autofill({ board }, { equipment: ['machine', 'cable', 'barbell', 'dumbbell'] });
  for (const d of noBand.board) for (const l of d.lifts) if (l.exercise_id) assert.notEqual(pool.get(l.exercise_id).equipment_detail, 'band');
  const picked = noBand.board.map(d => ({ ...d, lifts: d.lifts.map(l => ({ ...l })) }));
  picked[0].lifts[0].exercise_id = 'chest_press_machine'; picked[0].lifts[0].hand = true;
  const keep = await store.autofill({ board: picked }, { emptyOnly: true });
  assert.equal(keep.board[0].lifts[0].exercise_id, 'chest_press_machine');
});

test('C.3.6: poolFor counts done work sets per exercise and is read again after a write', async () => {
  const { store, clock } = await setup();
  await store.createBlock(SPEC());
  const before = (await store.poolFor(null)).find(r => r.id === 'leg_press').done_count;
  await logDay(store, clock);
  const after = (await store.poolFor(null)).find(r => r.id === 'leg_press').done_count;
  assert.equal(before, 0);
  assert.equal(after, 2);
});

test('M73: a level change mid block writes blocks.levels only; every done and open day and its sets stay deep-equal; one muscle on two levels is refused', async () => {
  const { db, store, clock } = await setup();
  const a = await store.createBlock(SPEC());
  await logDay(store, clock);
  const d = await store.currentDay();
  const v = await store.dayView(d.id);
  await store.tick(v.sets[0].id, V(150, 10));
  const days0 = JSON.stringify(await db.all('days')), sets0 = JSON.stringify(await db.all('sets'));
  const lv = await store.blockLevels(a.id);
  assert.equal(lv.saved, false, 'a block with {} shows unsaved');
  assert.ok(lv.levels.middle.length > 0 && !lv.levels.top.length, 'every muscle it trains on the middle level');
  await store.setPriorities(a.id, { top: ['quads'], middle: ['back'], bottom: ['chest'] });
  assert.deepEqual((await db.get('blocks', a.id)).levels, { back: 'middle', chest: 'bottom', quads: 'top' });
  assert.equal(JSON.stringify(await db.all('days')), days0);
  assert.equal(JSON.stringify(await db.all('sets')), sets0);
  await assert.rejects(store.setPriorities(a.id, { top: ['quads'], middle: ['quads'], bottom: [] }), /two levels/);
  assert.equal((await store.blockLevels(a.id)).saved, true);
});

test('AW4: copying from round 2 gives a block with the same days and exercises, copied_from set, no source_id, Fixed', async () => {
  const { db, store, clock } = await setup();
  const a = await store.createBlock(SPEC());
  for (let i = 0; i < 4; i++) await logDay(store, clock);
  const rounds = await store.copyRounds(a.id);
  assert.deepEqual(rounds.rounds.map(r => r.pass), [1, 2, 3]);
  assert.deepEqual(rounds.rounds.map(r => r.days_done), [2, 2, 0]);
  const c = await store.copyBlock(a.id, 2, { activate: false });
  assert.deepEqual(c.day_templates.map(d => d.lifts.map(l => l.exercise_id)), a.day_templates.map(d => d.lifts.map(l => l.exercise_id)));
  assert.deepEqual(c.copied_from, { block_id: a.id, pass: 2 });
  assert.equal(c.source_id, null);
  assert.equal(c.profile, 'fixed');
  assert.equal(c.passes, a.passes);
  assert.equal(await db.setting('active_block_id'), a.id, 'the copy took no mark (M74)');
});

test('M55: the copy keeps the source unit with settings set to the other unit (B09); start load from the last done set (R4-17)', async () => {
  const { store, clock } = await setup();
  const a = await store.createBlock({ ...SPEC(), unit: 'lb' });
  await logDay(store, clock, (s) => V(s.set_n === 2 ? 155 : 150, 10));
  await store.setSetting('unit', 'kg');
  const pv = await store.copyPreview(a.id, 1);
  assert.equal(pv.unit, 'lb');
  assert.equal(pv.days[0].lifts[0].start_load, 155, 'the load of its last done work set by set number');
  const c = await store.copyBlock(a.id, 1, { activate: true });
  assert.equal(c.unit, 'lb');
});

test('M56: the copy keeps exercise_flags, checks, scores and rule notes of the source; a block file update of the source leaves the copy unchanged', async () => {
  const { db, store } = await setup();
  const src = await store.importBlock(JSON.stringify(blockV2()), true);
  const c = await store.copyBlock(src.id, 1, { activate: false });
  assert.deepEqual(c.exercise_flags, src.exercise_flags);
  assert.deepEqual(c.checks, src.checks);
  assert.deepEqual(c.scores, src.scores);
  assert.deepEqual(c.rule_notes, src.rule_notes);
  assert.equal(c.source_id, null);
  const copyBefore = JSON.stringify(await db.get('blocks', c.id));
  const f = blockV2(); f.version = (f.version || 1) + 1; f.block.notes = 'Changed by a newer file.';
  await store.importBlock(JSON.stringify(f), false).catch(() => null);
  assert.equal(JSON.stringify(await db.get('blocks', c.id)), copyBefore, 'the copy is untouched');
});

test('C.3.16 (minimal, S2): markTipSeen keeps a tip closed and refuses an id not in TIP_IDS', async () => {
  const { store } = await setup();
  assert.deepEqual(await store.tipsSeen(), {});
  await store.markTipSeen('intro_board');
  assert.deepEqual(await store.tipsSeen(), { intro_board: true });
  await assert.rejects(store.markTipSeen('tip_nope'), /bad tip/);
});

// ---------------- Slice 3, track S3 (17 C.3.9 to C.3.16) ----------------

// A 2-round, 2-day block logged to its end (4 days).
async function finishedBlock() {
  const box = await setup();
  const b = await box.store.createBlock({ ...SPEC(), passes: 2 });
  for (let i = 0; i < 4; i++) await logDay(box.store, box.clock);
  return { ...box, b };
}

test('C.3.9 S19: Finish day on the last day of the last round puts status done and finished_at once, in the same write', async () => {
  const box = await setup();
  const b = await box.store.createBlock({ ...SPEC(), passes: 2 });
  for (let i = 0; i < 3; i++) await logDay(box.store, box.clock);
  assert.equal((await box.db.get('blocks', b.id)).finished_at, null, 'not before the last day');
  const n = box.db.spy.batch;
  const last = await logDay(box.store, box.clock);
  const nb = await box.db.get('blocks', b.id);
  assert.equal(nb.status, 'done');
  assert.equal((await box.db.get('days', last.id)).done_at, nb.finished_at, 'finished_at is the time of the day finish');
  assert.ok(box.db.spy.batch - n >= 1);
  const v = await box.store.blockFinishedView(b.id);
  assert.deepEqual({ rounds: v.rounds, days: v.days, skipped: v.skipped, tally: v.tally }, { rounds: 2, days: 4, skipped: 0, tally: 8 });
});

test('C.3.9: Skip day on the last day and End block also set finished_at; an active block has no finished view', async () => {
  const box = await setup();
  const b = await box.store.createBlock({ ...SPEC(), passes: 1 });
  await logDay(box.store, box.clock);
  assert.equal(await box.store.blockFinishedView(b.id), null);
  const d = await box.store.currentDay();
  box.clock.add(MIN);
  await box.store.skipDay(d.id);
  const nb = await box.db.get('blocks', b.id);
  assert.equal(nb.status, 'done');
  assert.equal(nb.finished_at, box.clock.now());
  const v = await box.store.blockFinishedView(b.id);
  assert.deepEqual({ rounds: v.rounds, days: v.days, skipped: v.skipped }, { rounds: 1, days: 1, skipped: 1 });
  const box2 = await setup();
  const c = await box2.store.createBlock({ ...SPEC(), passes: null });
  for (let i = 0; i < 3; i++) await logDay(box2.store, box2.clock);
  assert.equal((await box2.db.get('blocks', c.id)).status, 'active', 'an open-ended block never finishes by itself');
  box2.clock.add(MIN);
  await box2.store.endBlock(c.id);
  assert.equal((await box2.db.get('blocks', c.id)).finished_at, box2.clock.now(), 'End block sets finished_at');
});

test('C.3.10 ZW2: blockSummary mid block gives the day counts, sets per muscle per round and the done exercises by name', async () => {
  const { store, clock, db } = await setup();
  const b = await store.createBlock(SPEC());
  await logDay(store, clock);
  const s = await store.blockSummary(b.id);
  assert.deepEqual(s.counts, { total: 6, done: 1, skipped: 0, not_done: 5 });
  assert.deepEqual(s.muscles.rounds, [1, 2, 3]);
  assert.ok(s.muscles.rows.length >= 2 && s.muscles.rows.every(r => r.cells.length === 3 && r.cells[1] === 0));
  assert.deepEqual(s.exercises.map(e => e.id).sort(), ['lat_pulldown', 'leg_press']);
  assert.equal(await store.blockSummary('nope'), null);
  await assert.rejects(store.blockSummary('@bad'));
});

test('M59: the grid minus is refused without REMOVE typed and changes nothing; plus adds a round', async () => {
  const { db, store, clock } = await setup();
  const b = await store.createBlock(SPEC());
  const before = db.dump(['snapshots']);
  await assert.rejects(store.resizeBlock(b.id, -1, ''), (e) => e.name === 'Refused' && e.message === 'word');
  await assert.rejects(store.resizeBlock(b.id, -1, 'remove'), (e) => e.name === 'Refused');
  assert.equal(db.dump(['snapshots']), before, 'nothing written');
  const r = await store.resizeBlock(b.id, 1);
  assert.equal(r.block.passes, 4);
  await store.resizeBlock(b.id, -1, 'REMOVE');
  assert.equal((await db.get('blocks', b.id)).passes, 3);
});

test('r4.6 Q1: REMOVE at the start of the last round deletes its planned untouched day and finishes the block in one batch', async () => {
  const { db, store, clock } = await setup();
  const b = await store.createBlock(SPEC());
  for (let i = 0; i < 4; i++) await logDay(store, clock);
  const keep = (await db.all('days')).filter(d => d.pass <= 2).map(d => d.id).sort();
  const keepRows = JSON.stringify([...(await db.all('days')).filter(d => d.pass <= 2), ...(await db.all('sets')).filter(s => !s.day_id.includes(':p3:'))].sort((x, y) => (x.id < y.id ? -1 : 1)));
  const g = await store.roundGrid(b.id);
  assert.deepEqual(g.minus, { ok: true, finishes: true });
  const n = db.spy.batch;
  clock.add(MIN);
  const r = await store.resizeBlock(b.id, -1, 'REMOVE');
  assert.equal(db.spy.batch - n, 1, 'one batch');
  assert.equal(r.finished, true);
  const nb = await db.get('blocks', b.id);
  assert.deepEqual([nb.passes, nb.status, nb.finished_at], [2, 'done', clock.now()]);
  assert.deepEqual((await db.all('days')).map(d => d.id).sort(), keep, 'the round 3 day is gone');
  assert.equal((await db.all('sets')).filter(s => s.day_id.includes(':p3:')).length, 0, 'and its sets');
  assert.equal(JSON.stringify([...(await db.all('days')), ...(await db.all('sets'))].sort((x, y) => (x.id < y.id ? -1 : 1))), keepRows, 'rounds 1 and 2 are unchanged');
});

test('M99 (r4.6 Q1): a planned day with a draft set is never deleted by REMOVE, and nothing is written', async () => {
  const { db, store, clock } = await setup();
  const b = await store.createBlock(SPEC());
  for (let i = 0; i < 4; i++) await logDay(store, clock);
  const d = await store.currentDay();
  const s = (await db.byIndex('sets', 'day_id', d.id))[0];
  await db.put('sets', { ...s, draft: { load: 150, reps: 9 } });
  const g = await store.roundGrid(b.id);
  assert.equal(g.minus.ok, false);
  assert.equal(g.minus.reason.key, 'grid.done');
  const before = db.dump(['snapshots']);
  await assert.rejects(store.resizeBlock(b.id, -1, 'REMOVE'), (e) => e.name === 'Refused' && e.message === 'day past the end');
  assert.equal(db.dump(['snapshots']), before);
});

test('C.3.11 r4.6 Q2: the grid on Fixed shows both buttons, grid.min on a 1-round block, grid.done below a started round, grid.cap at the most', async () => {
  const { db, store, clock } = await setup();
  const one = await store.createBlock({ ...SPEC(), passes: 1 });
  let g = await store.roundGrid(one.id);
  assert.equal(g.plus.ok, true);
  assert.deepEqual(g.minus, { ok: false, reason: { key: 'grid.min', vals: {} } });
  assert.deepEqual(g.rounds, [{ pass: 1, goal: null }], 'Fixed shows no goal line');
  assert.deepEqual(g.rows.map(r => r.cells.map(c => c.state)), [['now'], ['planned']]);
  const three = await store.createBlock({ ...SPEC(), passes: RULES.profiles.fixed.effort.length_max }, null, { activate: true });
  g = await store.roundGrid(three.id);
  assert.deepEqual(g.plus, { ok: false, reason: { key: 'grid.cap', vals: { n: RULES.profiles.fixed.effort.length_max } } });
  const two = await store.createBlock({ ...SPEC(), passes: 2 }, null, { activate: true });
  await logDay(store, clock); await logDay(store, clock); await logDay(store, clock);
  g = await store.roundGrid(two.id);
  assert.deepEqual(g.minus, { ok: false, reason: { key: 'grid.done', vals: { r: 2 } } });
  const open = await store.createBlock({ ...SPEC(), passes: null }, null, { activate: true });
  g = await store.roundGrid(open.id);
  assert.equal(g.open, true);
  assert.equal(g.plus, null);
});

test('C.3.11 r4.6 Q6: a refused minus below the fewest rounds reads grid.fewest with length_min; grid.min stays the Fixed 1-round case', () => {
  const adaptive = RULES.profiles.adaptive, fixed = RULES.profiles.fixed;
  assert.deepEqual(gridReason('shorter than the fewest rounds', { passes: adaptive.effort.length_min }, adaptive), { key: 'grid.fewest', vals: { n: adaptive.effort.length_min } });
  assert.deepEqual(gridReason('below the current round', { passes: 1 }, fixed), { key: 'grid.min', vals: {} });
  assert.deepEqual(gridReason('below the current round', { passes: 3 }, fixed), { key: 'grid.done', vals: { r: 3 } });
  assert.deepEqual(gridReason('longer than the most rounds', { passes: 9 }, fixed), { key: 'grid.cap', vals: { n: fixed.effort.length_max } });
});

test('S13 M61: history for one exercise lists both blocks newest first, each with its rounds and trend, the date from done_at', async () => {
  const { db, store, clock } = await setup();
  const a = await store.createBlock({ ...SPEC(), passes: 2, name: 'Old' });
  for (let i = 0; i < 4; i++) await logDay(store, clock, (s) => V(s.target.load === null ? 100 : s.target.load + (s.id.includes(':p2:') ? 5 : 0), 10));
  clock.add(MIN);
  const b = await store.createBlock({ ...SPEC(), passes: 2, name: 'New' }, null, { activate: true });
  await logDay(store, clock);
  const h = await store.exerciseHistory('leg_press');
  assert.deepEqual(h.blocks.map(x => x.name), ['New', 'Old']);
  assert.deepEqual(h.blocks[1].rounds.map(r => r.pass), [1, 2]);
  assert.deepEqual(h.blocks[1].points.map(p => p.pass), [1, 2], 'points in round order');
  assert.ok(h.blocks[1].points[1].value >= h.blocks[1].points[0].value);
  const only = await store.exerciseHistory('leg_press', a.id);
  assert.deepEqual(only.blocks.map(x => x.block_id), [a.id], 'one block only');
  const days = await store.historyDays({ limit: 30 });
  assert.equal(days.rows[0].block.name, 'New', 'newest block first');
  assert.deepEqual(days.rows.slice(1).map(r => [r.day.pass, r.day.day]), [[2, 2], [2, 1], [1, 2], [1, 1]], 'newest position first');
  assert.equal(days.rows[1].sets, 4);
  const page = await store.historyDays({ limit: 2 });
  assert.equal(page.more, true);
  assert.equal((await store.historyDays({ before: page.next, limit: 30 })).rows.length, 3);
  assert.deepEqual((await store.historyExercises()).map(e => e.id).sort(), ['chest_press_machine', 'lat_pulldown', 'leg_extension', 'leg_press']);
  assert.ok(b);
});

test('C.3.12: a day finished after midnight shows under its done_date, with done_at for the time', async () => {
  const { db, store, clock } = await setup('2026-11-02T23:30:00-05:00');
  await store.createBlock(SPEC());
  const d = await store.currentDay();
  const v = await store.dayView(d.id);
  for (const s of v.sets) { clock.add(MIN); await store.tick(s.id, V(s.target.load, 10)); }
  clock.add(40 * MIN);
  await store.finishDay(d.id);
  const row = (await store.historyDays({})).rows[0];
  assert.equal(row.day.done_date, '2026-11-02');
  assert.equal(localDate(row.day.done_at), '2026-11-03');
});

test('C.3.13: loggedExerciseIds ignores a planned or skipped set; listExercises filters and sorts by name', async () => {
  const { db, store, clock } = await setup();
  await store.createBlock(SPEC());
  const d = await store.currentDay();
  const v = await store.dayView(d.id);
  await store.tick(v.sets[0].id, V(150, 10));
  await store.skipExercise(d.id, v.sets.find(s => s.exercise_id === 'lat_pulldown').slot);
  assert.deepEqual(await store.loggedExerciseIds(), ['leg_press']);
  assert.deepEqual((await store.listExercises({ logged: true })).map(e => e.id), ['leg_press']);
  const all = await store.listExercises({});
  assert.equal(all.length, (await db.all('exercises')).length);
  const names = all.map(e => e.name.toLowerCase());
  assert.deepEqual(names, [...names].sort());
  const legs = await store.listExercises({ muscle: ['quads'], equipment: ['machine'] });
  assert.ok(legs.length && legs.every(e => e.muscle_detail === 'quads' && e.equipment_detail === 'machine'));
  assert.deepEqual(await store.listExercises({ mine: true }), []);
  assert.ok((await store.listExercises({ q: 'LEG PRESS' })).some(e => e.id === 'leg_press'));
  const det = await store.exerciseDetail('leg_press');
  assert.equal(det.exercise.id, 'leg_press');
  assert.equal(det.history.blocks.length, 1);
});

test('C.3.15 DW8: body weight saves on an open or planned day, rounds to one decimal, refuses 20 to 1000 outside, shows in flat_log', async () => {
  const { db, store, clock } = await setup();
  await store.createBlock(SPEC());
  const d = await store.currentDay();
  await store.setBodyWeight(d.id, 180.25);
  assert.equal((await db.get('days', d.id)).body_weight, 180.3);
  for (const bad of [19.9, 1001, NaN, '180']) await assert.rejects(store.setBodyWeight(d.id, bad), (e) => e.name === 'Refused');
  assert.equal((await db.get('days', d.id)).body_weight, 180.3, 'the old value stays');
  await store.setBodyWeight(d.id, null);
  assert.equal((await db.get('days', d.id)).body_weight, null, 'Clear writes null');
  await store.setBodyWeight(d.id, 180.3);
  await logDay(store, clock);
  const flat = (await store.backupObject()).flat_log.filter(r => r.date !== undefined);
  assert.ok(flat.length && flat.every(r => r.body_weight === 180.3), 'every flat_log row of that day carries it');
  await assert.rejects(store.setBodyWeight(d.id, 180), (e) => e.name === 'Refused', 'a done day is refused');
});

test('C.3.16: tips_seen takes only TIP_IDS; what changed: first install writes the version silently, an older version is due once', async () => {
  const { db, store, clock } = await setup();
  assert.deepEqual(await store.tipsSeen(), {});
  await store.markTipSeen('tip_rest');
  await assert.rejects(store.markTipSeen('tip_other'), (e) => e.name === 'Refused');
  assert.deepEqual(await store.tipsSeen(), { tip_rest: true });
  assert.equal(await store.changedDue(), null, 'first install: no note');
  assert.equal(await db.setting('seen_version'), APP_VERSION);
  assert.equal(await store.changedDue(), null);
  await db.setSetting('seen_version', '0.3.0');
  assert.equal(await store.changedDue(), APP_VERSION);
  await store.markChangedSeen();
  assert.equal(await store.changedDue(), null);
  await db.setSetting('seen_version', '0.3.0');
  await store.createBlock(SPEC());
  await logDay(store, clock);
  assert.equal(await db.setting('seen_version'), APP_VERSION, 'the next Finish day writes it');
});
