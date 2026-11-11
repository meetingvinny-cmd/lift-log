// backup.test.js - the backup file and every file check (DESIGN 5.7). Run with TZ=America/New_York.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { LIMITS, STORE_NAMES, validateBackup, validateBlock, buildBackup, isoLocal, minOf, maxOf } from '../../../backup.js';
import { SEED_IDS } from '../../../data/exercises.js';
import { createStore } from '../../../store.js';
import { createFakeDb, fakeClock } from './fake_db.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, '..', 'fixtures');
const NOW = Date.parse('2026-11-09T12:00:00-05:00');
const fixtureText = () => readFileSync(join(FIX, 'backup_v1.json'), 'utf8');
const fixture = () => JSON.parse(fixtureText());
const check = (obj) => validateBackup(JSON.stringify(obj), { now: NOW });
const refused = (obj, why) => { const r = check(obj); assert.equal(r.ok, false, why + ' should be refused'); return r; };

// The health-coach field set of a flat_log row (5.4), check_ and score_ columns aside.
export const FLAT_FIELDS = ['date', 'session', 'lift', 'weight', 'unit', 'load_basis', 'reps', 'count_label', 'set_number',
  'side', 'kind', 'status', 'origin', 'failure', 'reps_left', 'reps_left_plus', 'reps_left_target', 'breaks',
  'pump', 'soreness', 'workload', 'notes', 'block', 'pass', 'day', 'set_id', 'saved_at', 'first_done_at'];
const ISO_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

test('build then validate is ok (the v1 fixture)', () => {
  const r = validateBackup(fixtureText(), { now: NOW });
  assert.equal(r.ok, true, r.why);
  const f = fixture();
  const again = buildBackup(f.stores, { now: NOW });
  assert.equal(check(again).ok, true);
});

test('every flat_log row has every field and a date (M15)', () => {
  const f = fixture();
  const rows = buildBackup(f.stores, { now: NOW }).flat_log;
  assert.ok(rows.length > 0);
  for (const r of rows) {
    for (const k of FLAT_FIELDS) assert.ok(Object.prototype.hasOwnProperty.call(r, k), 'flat_log row lacks ' + k);
    assert.ok(r.date !== null && /^\d{4}-\d{2}-\d{2}$/.test(r.date), 'flat_log date');
    assert.ok('check_check_a' in r && 'score_score_a' in r, 'check_ and score_ columns from the block keys');
  }
  assert.ok(rows.some(r => r.origin === 'added' && r.status === 'done'), 'one added and logged set');
  assert.ok(rows.some(r => r.status === 'skipped'), 'one skipped set');
});

test('flat_log times and flat_log_since use the isoLocal form', () => {
  const b = buildBackup(fixture().stores, { now: NOW });
  assert.match(b.exported_at, ISO_LOCAL);
  assert.match(b.flat_log_since, ISO_LOCAL);
  for (const r of b.flat_log) { assert.match(r.first_done_at, ISO_LOCAL); if (r.saved_at !== null) assert.match(r.saved_at, ISO_LOCAL); }
  assert.equal(isoLocal(Date.parse('2026-11-09T23:40:05.000Z')), '2026-11-09T18:40:05.000-05:00');
});

test('a day ticked but never finished gives no flat_log rows; its sets stay in stores', () => {
  const f = fixture();
  const day = f.stores.days.find(d => d.status === 'planned');
  day.status = 'open'; day.started_at = NOW - 60000; day.saved_at = NOW - 60000;
  const s = f.stores.sets.find(x => x.day_id === day.id);
  Object.assign(s, { status: 'done', first_done_at: NOW - 60000, saved_at: NOW - 60000, done: { load: 1, reps: 1, reps_left: null, reps_left_plus: false, failure: false, unit: 'lb', breaks: null } });
  const b = buildBackup(f.stores, { now: NOW });
  assert.equal(b.flat_log.filter(r => r.set_id.startsWith(day.id)).length, 0);
  assert.ok(b.stores.sets.some(x => x.id === s.id && x.status === 'done'));
  assert.equal(check(b).ok, true);
});

test('newer schema refused with the newer-version code (M8)', () => {
  const f = fixture(); f.schema = 2;
  assert.equal(refused(f, 'schema 2').code, 'toonew');
});

test('wrong stores, counts and shapes are refused', () => {
  let f = fixture(); f.stores.extra = []; refused(f, 'unknown store');
  f = fixture(); f.counts.extra = 0; refused(f, 'a counts key that is not a store');
  f = fixture(); f.counts.sets += 1; refused(f, 'counts mismatch');
  f = fixture(); f.stores.sets[0].set_n = 'one'; refused(f, 'bad type');
  f = fixture(); f.stores.exercises[0].name = 'x'.repeat(121); refused(f, 'long string');
  f = fixture(); f.stores.sets[0].id = 'bad id!'; refused(f, 'bad id');
  f = fixture(); f.stores.sets[1].id = f.stores.sets[0].id; refused(f, 'two rows share one id');
  f = fixture(); f.stores.sets.find(s => s.status === 'done').done = null; refused(f, 'done status with done null');
  f = fixture(); f.stores.exercises[0].link = 'javascript:alert(1)'; refused(f, 'javascript link');
  f = fixture(); f.stores.blocks[0].profile = 'adaptive'; refused(f, 'adaptive profile');
  f = fixture(); f.stores.templates.push({ id: 't1' }); f.counts.templates = 1; refused(f, 'a templates row');
  f = fixture(); f.stores.sets[0].day_id = 'nope'; refused(f, 'a set naming a missing day');
  f = fixture(); f.stores.feedback[0].checks = { not_in_block: true }; refused(f, 'a feedback check key not in its block');
  f = fixture(); const d = f.stores.sets.find(s => s.status !== 'planned'); d.draft = { load: 1, reps: 1, reps_left: null, reps_left_plus: false, failure: false }; refused(f, 'a done or skipped set with a draft');
  f = fixture(); const p = f.stores.sets.find(s => s.status === 'planned'); p.draft = { load: 1, reps: 1, reps_left: 5, reps_left_plus: false, failure: false }; refused(f, 'a draft with reps_left 5');
  f = fixture(); f.stores.blocks[0].day_templates[0].lifts[0].warmups = Array(6).fill({ reps: 5, load: 10 }); refused(f, 'six warmups');
  f = fixture(); f.stores.blocks[0].day_templates[0].lifts[0].warmups[0].load = 2001; refused(f, 'warmup load 2001');
  f = fixture(); f.stores.blocks[0].day_templates[0].lifts[0].failure_set = 'no'; refused(f, 'failure_set no');
});

test('unknown keys and __proto__ are dropped, never stored', () => {
  const text = fixtureText().replace('"format": "liftlog-backup"', '"format": "liftlog-backup"').replace(/"name": "Test block"/, '"name": "Test block", "__proto__": {"polluted": 1}, "sneaky": 2');
  const r = validateBackup(text, { now: NOW });
  assert.equal(r.ok, true, r.why);
  const b = r.stores.blocks[0];
  assert.ok(!Object.prototype.hasOwnProperty.call(b, 'sneaky'));
  assert.ok(!Object.prototype.hasOwnProperty.call(b, '__proto__'));
  assert.equal(({}).polluted, undefined);
  assert.equal(b.polluted, undefined);
});

test('exercises flags_set is required and kept (M15b)', () => {
  let f = fixture(); delete f.stores.exercises[0].flags_set; refused(f, 'no flags_set');
  f = fixture(); f.stores.exercises[0].flags_set = 'yes'; refused(f, 'flags_set yes');
  f = fixture(); f.stores.exercises[0].flags_set = true;
  const r = check(f);
  assert.equal(r.ok, true);
  assert.equal(r.stores.exercises[0].flags_set, true);
  const custom = r.stores.exercises.find(e => e.custom);
  assert.ok(custom && 'flags_set' in custom);
});

test('block_v1 with 2 warmups and a failure set is accepted with both kept', () => {
  const r = validateBlock(readFileSync(join(FIX, 'block_v1.json'), 'utf8'), { now: NOW, seedIds: SEED_IDS });
  assert.equal(r.ok, true, r.why);
  const l = r.block.day_templates[0].lifts;
  assert.equal(l[0].warmups.length, 2);
  assert.equal(l[2].failure_set, true);
  const f = JSON.parse(readFileSync(join(FIX, 'block_v1.json'), 'utf8'));
  f.block.day_templates[0].lifts[0].exercise_id = 'nobody_knows';
  const r2 = validateBlock(JSON.stringify(f), { now: NOW, seedIds: SEED_IDS });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'badref');
});

test('a block lift with no rep range (a pure failure set) is accepted; a bad one is refused', () => {
  const f = JSON.parse(readFileSync(join(FIX, 'block_v1.json'), 'utf8'));
  f.block.day_templates[0].lifts[2].rep_low = null;
  f.block.day_templates[0].lifts[2].rep_high = null;
  assert.equal(validateBlock(JSON.stringify(f), { now: NOW, seedIds: SEED_IDS }).ok, true);
  f.block.day_templates[0].lifts[2].rep_low = 'ten';
  assert.equal(validateBlock(JSON.stringify(f), { now: NOW, seedIds: SEED_IDS }).ok, false);
});

// ---------------- size caps (5.5) ----------------

const BIG = 1.2345678901234567e-300;            // a valid number with the longest JSON form
const W = (n) => '€'.repeat(n);            // 3 bytes each in UTF-8, the widest a valid text char gets
const ID = (i = 0) => ('a'.repeat(LIMITS.ID) + i).slice(-LIMITS.ID);
const KEYN = (i) => ('k'.repeat(LIMITS.KEY) + i).slice(-LIMITS.KEY);
const T = 9999999999999;
// 40 rising loads with the longest JSON forms (r4.1 Q14: a list of loads rises with no repeats).
const LOADS40 = Array.from({ length: LIMITS.STEPS }, (_, i) => BIG * (i + 1));

function largestRows() {
  const lift = { slot: LIMITS.SLOT_MAX, exercise_id: ID(), sets: LIMITS.SETS_MAX, rep_low: LIMITS.REPS_MAX, rep_high: LIMITS.REPS_MAX,
    start_load: BIG, failure_set: false, reps_left_target: 4, warmups: Array(LIMITS.WARMUPS).fill({ reps: LIMITS.REPS_MAX, load: BIG }),
    sides: 'none', load_basis: 'per_side', count_label: 'seconds', note: W(LIMITS.NOTE),
    short_note: W(LIMITS.WORDS), goal_line: W(LIMITS.WORDS) };
  const many = (n, fn) => Object.fromEntries(Array.from({ length: n }, (_, i) => fn(i)));
  const block = { id: ID(), source_id: ID(), version: LIMITS.BLOCK_VERSION_MAX, id_map: many(LIMITS.ID_MAP, i => [ID(i), ID(i)]),
    name: W(LIMITS.NAME), created_at: T, unit: 'lb', profile: 'fixed', rules_frozen: { profile: 'fixed', rules_version: 'none' },
    passes: LIMITS.PASSES_MAX, notes: W(LIMITS.NOTE),
    checks: Array.from({ length: LIMITS.CHECKS }, (_, i) => ({ key: KEYN(i), ask: W(LIMITS.WORDS), stop_note: W(LIMITS.WORDS),
      lifts: Array.from({ length: LIMITS.CHECK_LIFTS }, (_, j) => ID(j)) })),
    scores: Array.from({ length: LIMITS.SCORES }, (_, i) => ({ key: KEYN(i), label: W(LIMITS.WORDS), min: 0, max: 10 })),
    rule_notes: { one_failure_set: W(LIMITS.WORDS), failure_on_machine: W(LIMITS.WORDS) },
    exercise_flags: many(LIMITS.FLAGS, i => [ID(i), { no_added_sets: false, left_out_of_builder: false, machine: false, weight_steps: LOADS40, step: 123.45678901234568 }]),
    day_templates: Array.from({ length: LIMITS.DAYS_PER_BLOCK }, () => ({ day: LIMITS.DAY_MAX, label: W(LIMITS.LABEL), lifts: Array(LIMITS.LIFTS_PER_DAY).fill(lift) })),
    status: 'active' };
  const d5 = { load: BIG, reps: LIMITS.REPS_MAX, reps_left: 4, reps_left_plus: false, failure: false };
  return {
    settings: [{ key: 'active_block_id', value: ID() }, { key: 'seeded_version', value: W(LIMITS.VERSION_STR) },
      { key: 'restore_note', value: { rows: Number.MAX_SAFE_INTEGER, at: T } }],
    exercises: [{ id: ID(), name: W(LIMITS.NAME), muscle: 'shoulders', equipment: 'bodyweight', count_label: 'seconds',
      weight_steps: LOADS40, step_default: BIG, unilateral: false, machine: false, no_added_sets: false,
      left_out_of_builder: false, flags_set: false, link: 'https://' + W(500), notes: W(LIMITS.NOTE), custom: false, edited: false }],
    templates: [{}],
    blocks: [block],
    days: [{ id: ID(), block_id: ID(), pass: LIMITS.PASS_MAX, day: LIMITS.DAY_MAX, label: W(LIMITS.LABEL), status: 'planned',
      started_at: T, done_at: T, done_date: '2026-11-09', scores: many(LIMITS.SCORES, i => [KEYN(i), 10]), notes: W(LIMITS.NOTE), saved_at: T,
      slot_order: Array.from({ length: LIMITS.SLOT_ORDER }, (_, i) => LIMITS.SLOT_MAX - i) }],
    sets: [{ id: ID(), day_id: ID(), block_id: ID(), exercise_id: ID(), slot: LIMITS.SLOT_MAX, set_n: LIMITS.SET_N_MAX, side: 'none',
      kind: 'warmup', target: { load: BIG, rep_low: LIMITS.REPS_MAX, rep_high: LIMITS.REPS_MAX, load_basis: 'per_side', count_label: 'seconds', reps_left_target: 4 },
      draft: d5, done: { ...d5, unit: 'lb', breaks: null }, status: 'planned', origin: 'added', saved_at: T, first_done_at: T, why: 'Stopped by a block check' }],
    feedback: [{ id: ID(), day_id: ID(), exercise_id: ID(), muscle: 'shoulders', pump: 4, soreness: 4, workload: 4,
      checks: many(LIMITS.CHECKS, i => [KEYN(i), false]), note: W(LIMITS.NOTE), pending: false, saved_at: T, label_set: 'w1' }]
  };
}

function largestFlatRow() {
  const iso = '2026-11-09T18:40:05.000-05:00';
  const r = { date: '2026-11-09', session: W(LIMITS.LABEL), lift: W(LIMITS.NAME), weight: BIG, unit: 'lb', load_basis: 'per_side', reps: LIMITS.REPS_MAX,
    count_label: 'seconds', set_number: LIMITS.SET_N_MAX, side: 'none', kind: 'warmup', status: 'skipped', origin: 'added', failure: false,
    reps_left: 4, reps_left_plus: false, reps_left_target: 4, breaks: null };
  for (let i = 0; i < LIMITS.CHECKS; i++) r['check_' + KEYN(i)] = false;
  for (let i = 0; i < LIMITS.SCORES; i++) r['score_' + KEYN(i)] = 10;
  Object.assign(r, { pump: 4, soreness: 4, workload: 4, notes: W(LIMITS.NOTE) + ' | ' + W(LIMITS.NOTE), block: ID(), pass: LIMITS.PASS_MAX,
    day: LIMITS.DAY_MAX, set_id: ID(), saved_at: iso, first_done_at: iso });
  return r;
}

export function computeCaps() {
  const big = largestRows();
  let stores = 0;
  for (const s of STORE_NAMES) {
    const one = Math.max(...big[s].map(r => Buffer.byteLength(JSON.stringify(r))));
    // Each row plus its comma, plus the two brackets.
    stores += LIMITS.ROWS[s] * (one + 1) + 2;
  }
  const flat = Buffer.byteLength(JSON.stringify(largestFlatRow()));
  const raw = stores + LIMITS.FLAT_LOG_ROWS * (flat + 1) + 2 + 64 * 1024;
  return { stores, raw };
}

test('size caps are worked out from the row caps, never lower', () => {
  const { stores, raw } = computeCaps();
  const mb = (n) => (n / 1048576).toFixed(1);
  console.log('size caps: stores ' + stores + ' (' + mb(stores) + ' MB), raw ' + raw + ' (' + mb(raw) + ' MB); LIMITS: stores ' + LIMITS.MAX_STORES_BYTES + ', raw ' + LIMITS.MAX_RAW_BYTES);
  assert.ok(LIMITS.MAX_STORES_BYTES >= stores, 'MAX_STORES_BYTES is lower than the computed ' + stores);
  assert.ok(LIMITS.MAX_RAW_BYTES >= raw, 'MAX_RAW_BYTES is lower than the computed ' + raw);
  assert.ok(LIMITS.MAX_RAW_BYTES > LIMITS.MAX_STORES_BYTES);
});

test('a file one byte over the raw cap is refused before parsing', () => {
  const keep = LIMITS.MAX_RAW_BYTES;
  try {
    LIMITS.MAX_RAW_BYTES = 1000;
    const r = validateBackup('x'.repeat(1001), { now: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.why, 'file too large');
    const r2 = validateBackup('€'.repeat(334), { now: NOW });
    assert.equal(r2.why, 'file too large', 'the cap counts bytes, not characters');
  } finally { LIMITS.MAX_RAW_BYTES = keep; }
});

test('one store at its row cap passes and one row over is refused', () => {
  const f = fixture();
  const base = f.stores.exercises.find(e => e.custom);
  const extra = LIMITS.ROWS.exercises - f.stores.exercises.length;
  for (let i = 0; i < extra; i++) f.stores.exercises.push({ ...base, id: 'c-cap' + i });
  f.counts.exercises = f.stores.exercises.length;
  assert.equal(check(f).ok, true, 'at the cap');
  f.stores.exercises.push({ ...base, id: 'c-over' });
  f.counts.exercises++;
  refused(f, 'one row over the cap');
});

test('scale: 3 years at 4 days a week, 25 sets a day, full notes, fits and passes', async () => {
  const db = createFakeDb();
  const clock = fakeClock('2023-11-06T18:00:00-05:00');
  const store = createStore({ db, now: clock.now });
  await store.seed();
  const ids = SEED_IDS.slice(0, 5);
  const lifts = ids.map((id, i) => ({ slot: i + 1, exercise_id: id, sets: 5, rep_low: 8, rep_high: 12, start_load: 100, failure_set: false, reps_left_target: 2, warmups: [], sides: 'none', load_basis: 'total', count_label: null, note: W(LIMITS.NOTE) }));
  await store.createBlock({ name: 'Scale', passes: null, day_templates: [{ day: 1, label: 'A', lifts }] });
  const note = W(LIMITS.NOTE);
  for (let d = 0; d < 3 * 52 * 4; d++) {
    const day = await store.currentDay();
    const v = await store.dayView(day.id);
    for (const s of v.sets) { clock.add(1000); await store.tick(s.id, { load: 100, reps: 10, reps_left: 2, reps_left_plus: false, failure: false }); }
    for (let slot = 1; slot <= 5; slot++) await store.saveFeedback(day.id, slot, { pump: 2, soreness: 2, workload: 2, checks: {}, note });
    await store.finishDay(day.id);
    clock.add(36 * 3600 * 1000);
  }
  const b = await store.backupObject();
  assert.equal(b.flat_log.length, 3 * 52 * 4 * 25);
  const text = JSON.stringify(b);
  const r = validateBackup(text, { now: clock.now() });
  assert.equal(r.ok, true, r.why);
  console.log('scale case: ' + (Buffer.byteLength(text) / 1048576).toFixed(1) + ' MB for ' + b.flat_log.length + ' set rows');
});

test('one id of each kind survives build, validate and restore', async () => {
  const db = createFakeDb();
  const clock = fakeClock('2026-11-02T18:00:00-05:00');
  const store = createStore({ db, now: clock.now });
  await store.seed();
  const r0 = await store.restoreFile(fixtureText());
  assert.ok(r0 > 0);
  clock.add(1000);
  await store.saveSnapshot('before-upgrade');
  const ex = await db.all('exercises');
  const ids = {
    block: (await db.all('blocks'))[0].id, custom: ex.find(e => e.custom).id, seed: ex.find(e => !e.custom).id,
    day: (await db.all('days'))[0].id, set: (await db.all('sets'))[0].id, snap: (await store.listSnapshots())[0].id
  };
  const text = JSON.stringify(await store.backupObject());
  const db2 = createFakeDb();
  const store2 = createStore({ db: db2, now: clock.now });
  await store2.restoreFile(text);
  assert.ok(await db2.get('blocks', ids.block));
  assert.ok(await db2.get('exercises', ids.custom));
  assert.ok(await db2.get('exercises', ids.seed));
  assert.ok(await db2.get('days', ids.day));
  assert.ok(await db2.get('sets', ids.set));
  assert.match(ids.snap, /^s\d+$/);
  assert.ok((await store.readSnapshot(ids.snap)).ok);
});

// ---------------- check_backup.mjs --since (5.6) ----------------

test('check_backup --since prints one NEW and one EDIT, and offset forms agree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'liftlog-since-'));
  const f = fixture();
  const since = f.exported_at;
  const sinceMs = Date.parse(since);
  const doneDay = f.stores.days.find(d => d.status === 'done');
  const sets = f.stores.sets.filter(s => s.day_id === doneDay.id && s.status === 'done');
  // One older set edited after the time.
  sets[0].saved_at = sinceMs + 5000;
  // One set planned before the time and first ticked after it.
  const late = f.stores.sets.find(s => s.day_id === doneDay.id && s.status === 'skipped');
  Object.assign(late, { status: 'done', first_done_at: sinceMs + 6000, saved_at: sinceMs + 6000, why: 'As written on your block',
    done: { load: 1, reps: 1, reps_left: null, reps_left_plus: false, failure: false, unit: 'lb', breaks: null } });
  const b = buildBackup(f.stores, { now: sinceMs + 10000 });
  const file = join(dir, 'second.json');
  writeFileSync(file, JSON.stringify(b));
  const tool = join(HERE, '..', 'check_backup.mjs');
  const run = (t) => execFileSync('node', [tool, file, '--since', t], { encoding: 'utf8', env: { ...process.env, TZ: 'America/New_York' } });
  const out = run(since);
  const news = out.split('\n').filter(l => l.startsWith('NEW ')), edits = out.split('\n').filter(l => l.startsWith('EDIT '));
  assert.deepEqual(news, ['NEW ' + late.id]);
  assert.deepEqual(edits, ['EDIT ' + sets[0].id]);
  const z = new Date(sinceMs).toISOString();
  assert.equal(run(z), out, 'a Z time and the same instant with an offset give the same result');
});

// ---------------- review fixes (C9, C10, C11) ----------------

test('a block file whose exercise id is __proto__ or constructor is refused (C9)', async () => {
  for (const bad of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const f = JSON.parse(readFileSync(join(FIX, 'block_v1.json'), 'utf8'));
    f.exercises[0].id = bad;
    f.block.day_templates[0].lifts[1].exercise_id = bad;
    const r = validateBlock(JSON.stringify(f), { now: NOW, seedIds: SEED_IDS });
    assert.equal(r.ok, false, bad + ' must be refused as an exercise id');
  }
  // The same name as a flag key, or a backup row id, is refused too.
  const f2 = JSON.parse(readFileSync(join(FIX, 'block_v1.json'), 'utf8'));
  f2.block.exercise_flags = JSON.parse('{"__proto__": {"no_added_sets": false, "left_out_of_builder": false}}');
  assert.equal(validateBlock(JSON.stringify(f2), { now: NOW, seedIds: SEED_IDS }).ok, false);
  const b = fixture();
  b.stores.exercises[0].id = 'constructor';
  assert.equal(check(b).ok, false, 'a backup row id of constructor is refused');
  // The good fixture still imports, and its next backup still restores.
  const db = createFakeDb();
  const clock = fakeClock('2026-11-09T10:00:00-05:00');
  const store = createStore({ db, now: clock.now, writeLimitMs: 50 });
  await store.seed();
  const nb = await store.importBlock(readFileSync(join(FIX, 'block_v1.json'), 'utf8'), true);
  for (const dt of nb.day_templates) for (const l of dt.lifts) assert.equal(typeof l.exercise_id, 'string');
  assert.equal(validateBackup(JSON.stringify(await store.backupObject()), { now: clock.now() }).ok, true);
});

test('app_version from a file is shown only when it is a plain version (C10)', () => {
  const f = fixture();
  assert.match(check(f).app_version, /^\d+\.\d+\.\d+$/);
  for (const v of ['Type RESTORE now', '1.2.3\nTap Restore', 'x'.repeat(5000), 12, null]) {
    const g = fixture();
    g.app_version = v;
    const r = check(g);
    assert.equal(r.ok, true, 'a strange version alone never refuses the file');
    assert.equal(r.app_version, '', 'a strange version is shown as nothing: ' + String(v).slice(0, 20));
  }
});

test('a block file over its own small cap is refused before it is parsed (C11)', () => {
  assert.ok(LIMITS.MAX_BLOCK_BYTES < LIMITS.MAX_RAW_BYTES / 100, 'the block cap is far below the backup cap');
  const fx = readFileSync(join(FIX, 'block_v1.json'), 'utf8');
  assert.ok(fx.length * 100 < LIMITS.MAX_BLOCK_BYTES, 'the fixture is far below the block cap');
  const big = fx.replace('{', '{"pad":"' + 'x'.repeat(LIMITS.MAX_BLOCK_BYTES) + '",');
  const r = validateBlock(big, { now: NOW, seedIds: SEED_IDS });
  assert.equal(r.ok, false);
  assert.equal(r.why, 'file too large');
});

// ---------------- Slice 1 polish pass, step 0 (DESIGN 15 P.3 backup row; 14.4 A1-1, A1-5, A2-5, A2-10, A3-R2, A3-R8, A4-1; R4-04, R4-05) ----------------

import { backupBig, validateSnapshotRow, SNAPSHOT_REASONS } from '../../../backup.js';

const blockFile = () => JSON.parse(readFileSync(join(FIX, 'block_v1.json'), 'utf8'));
const blockOk = (f) => validateBlock(JSON.stringify(f), { now: NOW, seedIds: SEED_IDS });

test('open top rep range accepted and kept (R4-05)', () => {
  const f = blockFile();
  const l = f.block.day_templates[0].lifts[0];
  l.rep_low = 8; l.rep_high = null;
  const r = blockOk(f);
  assert.equal(r.ok, true, r.why);
  assert.equal(r.block.day_templates[0].lifts[0].rep_low, 8);
  assert.equal(r.block.day_templates[0].lifts[0].rep_high, null, 'the open top stays open');
  l.rep_low = null;
  assert.equal(blockOk(f).ok, true, 'both null is accepted');
});

test('rep range pair rule: high with no low refused, low above high refused (A1-1)', () => {
  const f = blockFile();
  const l = f.block.day_templates[0].lifts[0];
  l.rep_low = null; l.rep_high = 12;
  assert.equal(blockOk(f).ok, false, 'low null with high 12 refused');
  l.rep_low = 12; l.rep_high = 8;
  assert.equal(blockOk(f).ok, false, 'low 12 high 8 refused');
  const b = fixture();
  const lift = b.stores.blocks[0].day_templates[0].lifts[0];
  lift.rep_low = null; lift.rep_high = 12;
  refused(b, 'a backup with high and no low');
});

test('block caps: 15 days, 31 lifts or 501 exercises refused; the largest block file fits the cap (A2-5)', () => {
  const f = blockFile();
  const d0 = f.block.day_templates[0];
  f.block.day_templates = Array.from({ length: 15 }, (_, i) => ({ ...d0, day: i + 1 }));
  assert.equal(blockOk(f).ok, false, '15 days refused');
  const g = blockFile();
  g.block.day_templates[0].lifts = Array.from({ length: 31 }, (_, i) => ({ ...g.block.day_templates[0].lifts[0], slot: i + 1 }));
  assert.equal(blockOk(g).ok, false, '31 lifts refused');
  g.block.day_templates[0].lifts.pop();
  assert.equal(blockOk(g).ok, true, '30 lifts accepted');
  const h = blockFile();
  h.exercises = Array.from({ length: 501 }, (_, i) => ({ ...h.exercises[0], id: 'ex_' + i, name: 'Made up ' + i }));
  assert.equal(blockOk(h).ok, false, '501 exercises refused');
  // The largest block file the caps and the 5.5a limits allow.
  const big = largestRows().blocks[0];
  const exRow = largestRows().exercises[0];
  const exercises = Array.from({ length: LIMITS.BLOCK_EXERCISES }, (_, i) => ({ ...exRow, id: ID(i), name: W(LIMITS.NAME - 4) + String(i).padStart(4, '0') }));
  const lift0 = big.day_templates[0].lifts[0];
  const body = { ...big, day_templates: big.day_templates.map((d, di) => ({ ...d, day: di + 1, lifts: Array.from({ length: LIMITS.LIFTS_PER_DAY }, (_, i) => ({ ...lift0, slot: i + 1, exercise_id: ID(i) })) })) };
  for (const k of ['id', 'source_id', 'version', 'id_map', 'created_at', 'status']) delete body[k];
  // Every flag key must name a known exercise: his 500 rows first (the longest ids), then list ids.
  const flagKeys = [...exercises.map(e => e.id), ...SEED_IDS].slice(0, LIMITS.FLAGS);
  assert.equal(flagKeys.length, LIMITS.FLAGS, 'the list and his rows hold enough ids to fill the flags cap');
  const flag0 = Object.values(big.exercise_flags)[0];
  body.exercise_flags = Object.fromEntries(flagKeys.map(k => [k, flag0]));
  body.checks = body.checks.map(ck => ({ ...ck, lifts: exercises.slice(0, LIMITS.CHECK_LIFTS).map(e => e.id) }));
  const file = { format: 'liftlog-block', schema: 1, source_id: ID(), version: LIMITS.BLOCK_VERSION_MAX, block: body, exercises };
  const bytes = Buffer.byteLength(JSON.stringify(file));
  console.log('# largest block file: ' + bytes + ' bytes (' + (bytes / 1048576).toFixed(1) + ' MB), cap ' + LIMITS.MAX_BLOCK_BYTES);
  assert.ok(bytes < LIMITS.MAX_BLOCK_BYTES, 'MAX_BLOCK_BYTES is below the largest valid block file');
  const r = validateBlock(JSON.stringify(file), { now: NOW, seedIds: SEED_IDS });
  assert.equal(r.ok, true, 'the largest block file is valid: ' + r.why);
});

test('his block fields: check lifts, machine and weight steps, short note and goal line (R4-04)', () => {
  const f = blockFile();
  let r = blockOk(f);
  assert.equal(r.block.checks[0].lifts, null, 'a check with no lifts key is asked on every exercise');
  assert.equal(r.block.day_templates[0].lifts[0].short_note, '', 'a missing short note is empty');
  assert.equal(r.block.day_templates[0].lifts[0].goal_line, '', 'a missing goal line is empty');
  assert.ok(!('machine' in r.block.exercise_flags.leg_press), 'a missing machine flag stays out');
  f.block.checks[0].lifts = ['leg_press', 'ex_p'];
  f.block.exercise_flags.leg_press.machine = false;
  f.block.exercise_flags.leg_press.weight_steps = [10, 15];
  f.block.day_templates[0].lifts[0].short_note = 'Made-up short note';
  f.block.day_templates[0].lifts[0].goal_line = 'Made-up goal line';
  r = blockOk(f);
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(r.block.checks[0].lifts, ['leg_press', 'ex_p']);
  assert.deepEqual(r.block.exercise_flags.leg_press, { no_added_sets: false, left_out_of_builder: false, machine: false, weight_steps: [10, 15] });
  assert.equal(r.block.day_templates[0].lifts[0].goal_line, 'Made-up goal line');
  const bad = (mut, why) => { const g = JSON.parse(JSON.stringify(f)); mut(g); assert.equal(blockOk(g).ok, false, why); };
  bad(g => { g.block.checks[0].lifts = ['not_on_the_list']; }, 'a check naming an unknown exercise');
  bad(g => { g.block.checks[0].lifts = []; }, 'an empty lifts list');
  bad(g => { g.block.checks[0].lifts = ['leg_press', 'leg_press']; }, 'a lift named twice');
  bad(g => { g.block.exercise_flags.leg_press.weight_steps = [15, 10]; }, 'loads that do not rise');
  bad(g => { g.block.exercise_flags.leg_press.weight_steps = [10, 10]; }, 'a load twice');
  bad(g => { g.block.exercise_flags.leg_press.weight_steps = Array.from({ length: 41 }, (_, i) => i + 1); }, '41 loads');
  bad(g => { g.block.exercise_flags.leg_press.step = 0.4; }, 'a step under 0.5');
  bad(g => { g.block.exercise_flags.leg_press.step = 201; }, 'a step over 200');
  bad(g => { g.block.exercise_flags.leg_press.machine = 'no'; }, 'a machine flag that is not a boolean');
  bad(g => { g.block.day_templates[0].lifts[0].short_note = 'two\nlines'; }, 'a short note with a new line');
  bad(g => { g.block.day_templates[0].lifts[0].goal_line = 'x'.repeat(121); }, 'a goal line over 120 chars');
  assert.equal(blockOk(f).block.checks[0].lifts.length, 2);
  // r4.1 Q18: one step size of his own, kept as written.
  f.block.exercise_flags.ex_p.step = 15;
  assert.equal(blockOk(f).block.exercise_flags.ex_p.step, 15);
  // r4.1 Q41: a list row's own loads also rise with no repeats.
  f.exercises[0].weight_steps = [20, 10];
  assert.equal(blockOk(f).ok, false, 'an exercise row with loads that do not rise');
  f.exercises[0].weight_steps = [];
  assert.equal(blockOk(f).ok, false, 'an empty load list');
});

test('a backup check may name a seed id, a row of the file or an id_map value, never another id (R13)', () => {
  const b = fixture();
  const blk = b.stores.blocks[0];
  blk.checks[0].lifts = [blk.day_templates[0].lifts[0].exercise_id];
  assert.equal(check(b).ok, true, check(b).why);
  blk.checks[0].lifts = ['made_up_missing_id'];
  refused(b, 'a check naming a missing exercise');
});

test('a day card order: null, missing or real slots accepted; a duplicate, a 0 or an empty slot refused (A1-5)', () => {
  const b = fixture();
  const day = b.stores.days.find(d => b.stores.sets.some(s => s.day_id === d.id));
  const slots = [...new Set(b.stores.sets.filter(s => s.day_id === day.id).map(s => s.slot))];
  assert.equal(check(b).ok, true, 'a file with no slot_order key reads');
  assert.equal(check(b).stores.days.find(d => d.id === day.id).slot_order, null, 'a missing slot_order restores as null');
  day.slot_order = [...slots].reverse();
  assert.equal(check(b).ok, true, check(b).why);
  assert.deepEqual(check(b).stores.days.find(d => d.id === day.id).slot_order, [...slots].reverse());
  day.slot_order = [slots[0], slots[0]];
  refused(b, 'a slot named twice');
  day.slot_order = [0];
  refused(b, 'a slot 0');
  day.slot_order = [999];
  refused(b, 'a slot with no set on that day');
  day.slot_order = 'first';
  refused(b, 'a slot order that is not a list');
});

test('a day label may be empty (15 Part 1)', () => {
  const b = fixture();
  b.stores.days[0].label = '';
  b.stores.blocks[0].day_templates[0].label = '';
  assert.equal(check(b).ok, true, check(b).why);
});

test('a label holding a tab or a new line is refused in a backup and a block file (G14, P.4 item 1)', () => {
  for (const bad of ['A\tB', 'A\nB', '\n', 'A\r']) {
    const d = fixture();
    d.stores.days[0].label = bad;
    assert.equal(check(d).ok, false, 'days label ' + JSON.stringify(bad) + ' refused');
    const t = fixture();
    t.stores.blocks[0].day_templates[0].label = bad;
    assert.equal(check(t).ok, false, 'day_templates label ' + JSON.stringify(bad) + ' refused');
    const f = JSON.parse(readFileSync(join(FIX, 'block_v1.json'), 'utf8'));
    f.block.day_templates[0].label = bad;
    assert.equal(validateBlock(JSON.stringify(f), { now: NOW, seedIds: SEED_IDS }).ok, false, 'block file label ' + JSON.stringify(bad) + ' refused');
  }
  const ok = fixture();
  ok.stores.days[0].label = 'Up';
  assert.equal(check(ok).ok, true, 'a plain label still passes');
});

test('unknown settings key dropped, never refusing the file; a known key is still checked (15 settings rule)', () => {
  const b = fixture();
  b.stores.settings.push({ key: 'made_up_later_key', value: { any: 'thing' } });
  b.counts.settings++;
  const r = check(b);
  assert.equal(r.ok, true, r.why);
  assert.ok(!r.stores.settings.some(x => x.key === 'made_up_later_key'), 'the unknown row is dropped');
  const c2 = fixture();
  c2.stores.settings.find(x => x.key === 'unit').value = 'stone';
  refused(c2, 'a known key with a bad value');
  const c3 = fixture();
  c3.stores.settings.push({ key: 7, value: 1 });
  c3.counts.settings++;
  refused(c3, 'a settings row whose key is not text');
});

test('restore_note never taken from a file (A3-R8)', () => {
  const b = fixture();
  b.stores.settings.push({ key: 'restore_note', value: { rows: 5, at: NOW } });
  b.counts.settings++;
  const r = check(b);
  assert.equal(r.ok, true, r.why);
  assert.ok(!r.stores.settings.some(x => x.key === 'restore_note'), 'a file never brings a restore note');
});

test('safety copy reasons: before-undo and before-reset pass, any other is refused (A2-10)', () => {
  const data = buildBackup(fixture().stores, { now: NOW });
  delete data.flat_log;
  const row = (reason) => ({ id: 's' + NOW, made_at: NOW, reason, last_backup_at_then: null, data });
  for (const r of ['before-undo', 'before-reset', ...SNAPSHOT_REASONS]) assert.doesNotThrow(() => validateSnapshotRow(row(r), { now: NOW, seedIds: SEED_IDS }), r);
  assert.throws(() => validateSnapshotRow(row('before-x'), { now: NOW }), /not allowed/);
  assert.throws(() => validateSnapshotRow({ ...row('before-undo'), made_at: 'yesterday' }, { now: NOW }));
});

test('the pick cap is 64 MiB, below the raw cap; the backup is big from 48 MiB (A3-R2, A4-1)', () => {
  assert.equal(LIMITS.MAX_PICK_BYTES, 67108864);
  assert.ok(LIMITS.MAX_PICK_BYTES < LIMITS.MAX_RAW_BYTES, 'MAX_PICK_BYTES below MAX_RAW_BYTES');
  assert.equal(LIMITS.BACKUP_BIG_BYTES, LIMITS.MAX_PICK_BYTES * 0.75);
  assert.equal(backupBig(49 * 1048576), true, 'a 49 MiB backup is big');
  assert.equal(backupBig(47 * 1048576), false, 'a 47 MiB backup is not');
  assert.equal(backupBig(NaN), false);
});

test('draft.from_copy: true and false read, a file without it reads false, any other value refused (15 Part 6)', () => {
  const f = fixture();
  const ps = f.stores.sets.filter(s => s.status === 'planned');
  ps[0].draft = { load: 105, reps: null, reps_left: null, reps_left_plus: false, failure: false, from_copy: true };
  ps[1].draft = { load: 110, reps: 8, reps_left: null, reps_left_plus: false, failure: false };
  const r = check(f);
  assert.equal(r.ok, true, r.why);
  assert.equal(r.stores.sets.find(s => s.id === ps[0].id).draft.from_copy, true);
  assert.equal(r.stores.sets.find(s => s.id === ps[1].id).draft.from_copy, false, 'an old file without the field reads false');
  const g = fixture();
  g.stores.sets.find(s => s.status === 'planned').draft = { load: 1, reps: null, reps_left: null, reps_left_plus: false, failure: false, from_copy: 'yes' };
  refused(g, 'a from_copy that is not a boolean');
});

test('carry_down is a known settings key and must be a boolean (15 Part 7)', () => {
  const b = fixture();
  b.stores.settings.push({ key: 'carry_down', value: true });
  b.counts.settings++;
  const r = check(b);
  assert.equal(r.ok, true, r.why);
  assert.ok(r.stores.settings.some(x => x.key === 'carry_down' && x.value === true));
  const c = fixture();
  c.stores.settings.push({ key: 'carry_down', value: 'on' });
  c.counts.settings++;
  refused(c, 'a carry_down that is not a boolean');
});

test('rep_ask is a known settings key and must be a boolean (15 Part 8)', () => {
  const b = fixture();
  b.stores.settings.push({ key: 'rep_ask', value: false });
  b.counts.settings++;
  const r = check(b);
  assert.equal(r.ok, true, r.why);
  assert.ok(r.stores.settings.some(x => x.key === 'rep_ask' && x.value === false));
  const c = fixture();
  c.stores.settings.push({ key: 'rep_ask', value: 0 });
  c.counts.settings++;
  refused(c, 'a rep_ask that is not a boolean');
});

test('breaks: 0 to 3 or null on a draft and a done set, breaks 4 refused, a draft without it reads null (15 Part 16)', () => {
  const f = fixture();
  const done = f.stores.sets.find(s => s.status === 'done');
  const planned = f.stores.sets.filter(s => s.status === 'planned');
  done.done.breaks = 3;
  planned[0].draft = { load: 10, reps: null, reps_left: null, reps_left_plus: false, failure: false, from_copy: false, breaks: 2 };
  planned[1].draft = { load: 10, reps: null, reps_left: null, reps_left_plus: false, failure: false };
  const r = check(f);
  assert.equal(r.ok, true, r.why);
  assert.equal(r.stores.sets.find(s => s.id === done.id).done.breaks, 3);
  assert.equal(r.stores.sets.find(s => s.id === planned[0].id).draft.breaks, 2);
  assert.equal(r.stores.sets.find(s => s.id === planned[1].id).draft.breaks, null, 'an old draft without breaks reads null');
  for (const bad of [4, -1, 1.5, '1']) {
    const g = fixture();
    g.stores.sets.find(s => s.status === 'done').done.breaks = bad;
    refused(g, 'breaks ' + bad);
  }
});

test('a skipped day has no done dates; why Day skipped is allowed (15 Part 15, R4-29)', () => {
  const f = fixture();
  const day = f.stores.days.find(d => d.status === 'planned') || f.stores.days[f.stores.days.length - 1];
  const planned = f.stores.sets.filter(s => s.day_id === day.id && s.status === 'planned');
  day.status = 'skipped'; day.done_at = null; day.done_date = null;
  for (const s of planned) { s.status = 'skipped'; s.why = 'Day skipped'; s.draft = null; }
  const r = check(f);
  assert.equal(r.ok, true, r.why);
  const g = JSON.parse(JSON.stringify(f));
  g.stores.days.find(d => d.id === day.id).done_date = '2026-11-01';
  refused(g, 'a skipped day with a done date');
  const h = fixture();
  h.stores.sets.find(s => s.status === 'skipped' || s.status === 'planned').why = 'Gone fishing';
  refused(h, 'a why that is not on the list');
});

test('the polish fixture: every polish field filled, read clean and kept through a restore (15 P.1 step 5)', async () => {
  const text = readFileSync(join(FIX, 'backup_v1_polish.json'), 'utf8');
  const r = validateBackup(text, { now: NOW });
  assert.equal(r.ok, true, r.why);
  const f = JSON.parse(text);
  assert.equal(f.app_version, '0.2.4');
  const st = r.stores;
  const setting = (k) => (st.settings.find(x => x.key === k) || {}).value;
  assert.equal(setting('carry_down'), true);
  assert.equal(setting('rep_ask'), false);
  assert.ok(st.days.some(d => Array.isArray(d.slot_order)), 'a day card order');
  assert.ok(st.days.some(d => d.label === ''), 'a day with no label');
  assert.ok(st.days.some(d => d.status === 'skipped' && d.done_date === null && d.done_at === null), 'a skipped day');
  assert.ok(st.sets.some(s => s.why === 'Day skipped'));
  assert.ok(st.sets.some(s => s.draft && s.draft.from_copy === true), 'a copied draft');
  assert.ok(st.sets.some(s => s.draft && s.draft.breaks === 1), 'a draft with breaks');
  assert.ok(st.sets.some(s => s.done && s.done.breaks === 3), 'a done set with three or more breaks');
  const b = st.blocks[0];
  assert.ok(b.checks.some(c => c.lifts === null) && b.checks.some(c => Array.isArray(c.lifts)), 'checks for every lift and for some');
  const fl = Object.values(b.exercise_flags);
  assert.ok(fl.some(x => typeof x.machine === 'boolean') && fl.some(x => Array.isArray(x.weight_steps)) && fl.some(x => typeof x.step === 'number'));
  const lifts = b.day_templates.flatMap(d => d.lifts);
  assert.ok(lifts.some(l => l.short_note) && lifts.some(l => l.goal_line) && lifts.some(l => l.rep_low !== null && l.rep_high === null));
  assert.ok(st.feedback.some(x => x.checks && Object.values(x.checks).includes(true)), 'a check Yes');
  assert.ok(f.flat_log.some(x => x.breaks === 2), 'flat_log carries breaks');
  // A restore onto a fresh phone keeps every row the same.
  const store = createStore({ db: createFakeDb(), now: () => NOW, writeLimitMs: 50 });
  await store.seed();
  await store.restoreFile(text);
  const again = await store.backupObject();
  for (const s of ['blocks', 'days', 'sets', 'feedback']) assert.deepEqual(again.stores[s], f.stores[s], s + ' kept');
  const out = execFileSync('node', [join(HERE, '..', 'check_backup.mjs'), join(FIX, 'backup_v1_polish.json')], { encoding: 'utf8', env: { ...process.env, TZ: 'America/New_York' } });
  assert.match(out, /^ok$/m, 'check_backup.mjs exit 0');
});

// ---------------- r4.3 light pass (DESIGN 14.9 H8) ----------------

test('L09: a set kind other than warmup or work is refused', () => {
  assert.equal(check(fixture()).ok, true);
  for (const kind of ['superset', 'drop', 'Work', 'warm-up', '', null]) {
    // A work set, whose id letter s fits any kind but warmup: only the kind check can refuse it
    // (on a warm-up row the SR9 id check would refuse it first and hide a missing kind check).
    const f = fixture();
    f.stores.sets.find(x => x.kind === 'work').kind = kind;
    refused(f, 'set kind ' + JSON.stringify(kind));
  }
  // A block file names no set kind: a stray kind key on a lift is dropped, never stored.
  const b = JSON.parse(readFileSync(join(FIX, 'block_v1.json'), 'utf8'));
  b.block.day_templates[0].lifts[0].kind = 'superset';
  const r = validateBlock(JSON.stringify(b), { now: NOW, seedIds: SEED_IDS });
  assert.equal(r.ok, true, r.why);
  assert.ok(!('kind' in r.block.day_templates[0].lifts[0]), 'the stray kind key is dropped');
});

// ---------------- r4.3 light pass: the security review fixes (SR rows) ----------------

test('SR1, SR10: an exported_at outside the time range refuses the file', () => {
  for (const at of ['2099-01-01T00:00:00Z', '2019-12-31T23:59:59Z', '2000-01-01T00:00:00Z']) {
    const f = fixture();
    f.exported_at = at;
    const r = refused(f, 'exported_at ' + at);
    assert.equal(r.code, 'bad');
  }
  const f = fixture();
  f.exported_at = isoLocal(NOW + LIMITS.FUTURE_SLACK - 1000);
  assert.equal(check(f).ok, true, 'a time inside the slack still reads');
});

test('SR2: an id_map value that names a list row or a row that is not custom refuses the file', () => {
  const f = fixture();
  const b = f.stores.blocks.find(x => Object.keys(x.id_map).length);
  assert.ok(b, 'the fixture holds a block with an id_map');
  const k = Object.keys(b.id_map)[0];
  const seedRow = f.stores.exercises.find(e => SEED_IDS.includes(e.id));
  b.id_map[k] = seedRow.id;
  refused(f, 'id_map naming a seed id');
  const g = fixture();
  const gb = g.stores.blocks.find(x => Object.keys(x.id_map).length);
  const target = g.stores.exercises.find(e => e.id === gb.id_map[Object.keys(gb.id_map)[0]]);
  target.custom = false;
  const r = validateBackup(JSON.stringify(g), { now: NOW, seedIds: SEED_IDS });
  assert.equal(r.ok, false, 'id_map naming a row that is not custom');
});

test('SR6: a day label, a short note and a goal line holding NEL or a line or paragraph separator refuse the file', () => {
  for (const ch of ['\u0085', '\u2028', '\u2029', '\u009f']) {
    const f = fixture();
    f.stores.days[0].label = 'A' + ch;
    refused(f, 'day label with U+' + ch.charCodeAt(0).toString(16));
    for (const field of ['short_note', 'goal_line']) {
      const g = fixture();
      g.stores.blocks[0].day_templates[0].lifts[0][field] = 'go' + ch + 'on';
      refused(g, field + ' with U+' + ch.charCodeAt(0).toString(16));
      const b = JSON.parse(readFileSync(join(FIX, 'block_v1.json'), 'utf8'));
      b.block.day_templates[0].lifts[0][field] = 'go' + ch + 'on';
      assert.equal(validateBlock(JSON.stringify(b), { now: NOW, seedIds: SEED_IDS }).ok, false, 'block file ' + field);
    }
    const b = JSON.parse(readFileSync(join(FIX, 'block_v1.json'), 'utf8'));
    b.block.day_templates[0].label = 'A' + ch;
    assert.equal(validateBlock(JSON.stringify(b), { now: NOW, seedIds: SEED_IDS }).ok, false, 'block file label');
  }
  // A note may still hold a tab and a new line (BAD_TEXT is unchanged).
  const f = fixture();
  f.stores.days[0].notes = 'a\tb\nc';
  assert.equal(check(f).ok, true);
});

test('SR14: a link that shows one site and opens another is refused; a plain https link reads', async () => {
  const { isLink } = await import('../../../backup.js');
  const AT = String.fromCharCode(64);   // the at sign, so no line here reads as an address
  for (const ok of ['https://www.youtube.com/watch?v=abc', 'https://example.org/a', 'https://vimeo.com/1#t=30']) assert.equal(isLink(ok), true, ok);
  const bad = ['https://www.youtube.com' + AT + 'other.example/x', 'https://user:pw' + AT + 'example.org/x', 'https://:pw' + AT + 'example.org/', 'http://example.org/',
    'https://' + String.fromCharCode(0xd800) + '.org/', 'https://exa mple.org/', 'javascript:alert(1)', ''];
  for (const v of bad) assert.equal(isLink(v), false, JSON.stringify(v));
  const f = fixture();
  const row = f.stores.exercises.find(e => e.custom) || f.stores.exercises[0];
  row.link = 'https://www.youtube.com' + AT + 'other.example/x';
  refused(f, 'a link with a user name');
});

test('SR7, SR15: a backup holds only known settings keys; restore_note and the phone check probe never ride out', () => {
  const f = fixture();
  const settings = [...f.stores.settings, { key: 'restore_note', value: { rows: 3, at: NOW } }, { key: 'phonecheck_probe', value: NOW }];
  const out = buildBackup({ ...f.stores, settings }, { now: NOW });
  assert.ok(!out.stores.settings.some(r => r.key === 'restore_note' || r.key === 'phonecheck_probe'));
  assert.equal(out.counts.settings, out.stores.settings.length);
  assert.equal(out.stores.settings.length, f.stores.settings.length, 'every known key is kept');
  assert.equal(check(out).ok, true);
});

test('SR9: a day, set or feedback id that does not match its own fields refuses the file', () => {
  const base = fixture();
  assert.ok(base.stores.sets.length && base.stores.feedback.length, 'the fixture holds sets and feedback');
  const cases = {
    'day id round': (f) => { const d = f.stores.days[0]; d.pass = d.pass + 1; },
    'set id slot': (f) => { const s = f.stores.sets[0]; f.stores.sets[0] = { ...s, slot: s.slot + 7 }; },
    'set id kind': (f) => { const s = f.stores.sets.find(x => x.kind === 'work'); s.id = s.id.replace(/:s(\d+):/, ':w$1:'); },
    'set id side': (f) => { const s = f.stores.sets.find(x => x.side === 'none'); s.id = s.id.replace(/:none$/, ':L'); },
    'set id of another day': (f) => { const s = f.stores.sets[0]; const other = f.stores.days.find(d => d.id !== s.day_id); s.id = other.id + s.id.slice(s.day_id.length); },
    'set block': (f) => { const s = f.stores.sets[0]; const b2 = { ...f.stores.blocks[0], id: 'bzz9' }; f.stores.blocks.push(b2); f.counts.blocks++; s.block_id = 'bzz9'; },
    'feedback slot 0': (f) => { const r = f.stores.feedback[0]; r.id = r.day_id + ':x0'; },
    'feedback slot word': (f) => { const r = f.stores.feedback[0]; r.id = r.day_id + ':xab'; },
    'feedback of another day': (f) => { const r = f.stores.feedback[0]; const other = f.stores.days.find(d => d.id !== r.day_id); r.id = other.id + ':x1'; },
    'feedback slot above the cap': (f) => { const r = f.stores.feedback[0]; r.id = r.day_id + ':x' + (LIMITS.SLOT_MAX + 1); }
  };
  for (const [name, plant] of Object.entries(cases)) {
    const f = fixture();
    plant(f);
    refused(f, name);
  }
});

test('SR12: a repeated day number or a repeated slot in one day refuses a backup and a block file', () => {
  const plants = {
    'day number': (blk) => { blk.day_templates[1].day = blk.day_templates[0].day; },
    'slot in one day': (blk) => { blk.day_templates[0].lifts[1].slot = blk.day_templates[0].lifts[0].slot; }
  };
  for (const [name, plant] of Object.entries(plants)) {
    const b = JSON.parse(readFileSync(join(FIX, 'block_v1.json'), 'utf8'));
    plant(b.block);
    assert.equal(validateBlock(JSON.stringify(b), { now: NOW, seedIds: SEED_IDS }).ok, false, 'block file: ' + name);
    const f = fixture();
    const blk = f.stores.blocks.find(x => x.day_templates.length > 1 && x.day_templates[0].lifts.length > 1);
    assert.ok(blk, 'the fixture holds a block with two days and two lifts');
    plant(blk);
    refused(f, 'backup: ' + name);
  }
  // The same slot number on two different days is fine.
  const ok = JSON.parse(readFileSync(join(FIX, 'block_v1.json'), 'utf8'));
  assert.equal(ok.block.day_templates[0].lifts[0].slot, ok.block.day_templates[1].lifts[0].slot);
  assert.equal(validateBlock(JSON.stringify(ok), { now: NOW, seedIds: SEED_IDS }).ok, true);
});

// 14.10 J9 (SR13): one entry per logged set, up to 100,000; a spread into Math.min would pass each as an argument.
test('SR13: a backup builds from a log of 100,000 sets, and minOf and maxOf take a list of 1,000,000', () => {
  const f = fixture();
  const st = f.stores;
  const doneDays = new Set(st.days.filter(d => d.status === 'done').map(d => d.id));
  const proto = st.sets.find(x => doneDays.has(x.day_id) && x.status === 'done' && x.first_done_at);
  assert.ok(proto, 'the fixture needs a done set on a done day');
  const base = Date.parse('2026-10-01T09:00:00-04:00');
  const sets = [];
  for (let i = 0; i < 100000; i++) {
    const at = isoLocal(base + ((i * 7919) % 100000) * 1000);
    sets.push({ ...proto, id: proto.id + ':big' + i, first_done_at: at, saved_at: base + i });
  }
  const b = buildBackup({ ...st, sets }, { now: NOW });
  assert.equal(b.flat_log.length, 100000);
  const earliest = base;   // i = 0 gives the earliest of the made-up times
  assert.equal(b.flat_log_since, isoLocal(earliest));
  const big = Array.from({ length: 1000000 }, (_, i) => (i * 104729) % 1000000);
  assert.equal(minOf(big), 0);
  assert.equal(maxOf(big), 999999);
  assert.equal(minOf([]), null);
  assert.equal(maxOf([]), null);
});

// SB2 (security read 2): a block file's own exercise may never take a list id.
test('SB2: a block file whose own exercise uses a list id is refused as badref', () => {
  const f = JSON.parse(readFileSync(join(FIX, 'block_v1.json'), 'utf8'));
  assert.ok(f.exercises.length >= 1, 'the fixture holds a local exercise');
  const old = f.exercises[0].id;
  const listId = SEED_IDS[0];
  f.exercises[0].id = listId;
  const swap = (id) => id === old ? listId : id;
  for (const dt of f.block.day_templates) for (const l of dt.lifts) l.exercise_id = swap(l.exercise_id);
  for (const ck of f.block.checks) if (ck.lifts) ck.lifts = ck.lifts.map(swap);
  if (f.block.exercise_flags && Object.prototype.hasOwnProperty.call(f.block.exercise_flags, old)) {
    f.block.exercise_flags[listId] = f.block.exercise_flags[old]; delete f.block.exercise_flags[old];
  }
  const r = validateBlock(JSON.stringify(f), { now: NOW, seedIds: SEED_IDS });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'badref');
  assert.equal(validateBlock(readFileSync(join(FIX, 'block_v1.json'), 'utf8'), { now: NOW, seedIds: SEED_IDS }).ok, true, 'the fixture itself still reads');
});

// SB5, the validator side: schema 1 keeps reading a file that holds a pending feedback row on a
// slot with no set (made before the store fix), since the app now passes such a row over.
test('SB5: a backup holding a pending feedback row on a slot with no set still reads', () => {
  const f = fixture();
  const day = f.stores.days.find(d => d.status === 'done');
  const slots = new Set(f.stores.sets.filter(s => s.day_id === day.id).map(s => s.slot));
  let n = 1;
  while (slots.has(n)) n++;
  const proto = f.stores.feedback[0];
  assert.ok(proto, 'the fixture holds a feedback row');
  f.stores.feedback.push({ ...proto, id: day.id + ':x' + n, day_id: day.id, pending: true });
  f.counts.feedback = f.stores.feedback.length;
  const r = check(f);
  assert.equal(r.ok, true, r.why);
});
