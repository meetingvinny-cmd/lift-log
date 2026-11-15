// backup.test.js - the backup file and every file check (DESIGN 5.7). Run with TZ=America/New_York.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { LIMITS, STORE_NAMES, validateBackup, validateBlock, buildBackup, isoLocal, minOf, maxOf, MUSCLE_DETAILS, EQUIPMENT_DETAILS, TIP_IDS } from '../../../backup.js';
import { SEED_IDS } from '../../../data/exercises.js';
import { createStore } from '../../../store.js';
import { createFakeDb, fakeClock } from './fake_db.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, '..', 'fixtures');
const NOW = Date.parse('2026-11-09T12:00:00-05:00');
const fixtureText = () => readFileSync(join(FIX, 'backup_v1.json'), 'utf8');
const fixture = () => JSON.parse(fixtureText());
// The same file as schema 2 rows (16 B.6.3: the frozen result of MIGRATIONS[1] on backup_v1.json).
// A backup built from stores is a schema 2 file, so its stores must hold schema 2 rows.
const fixture2 = () => JSON.parse(readFileSync(join(FIX, 'backup_v1_as_v2.json'), 'utf8'));
const check = (obj) => validateBackup(JSON.stringify(obj), { now: NOW });
const refused = (obj, why) => { const r = check(obj); assert.equal(r.ok, false, why + ' should be refused'); return r; };

// The health-coach field set of a flat_log row (5.4), check_ and score_ columns aside.
export const FLAT_FIELDS = ['date', 'session', 'lift', 'weight', 'unit', 'load_basis', 'reps', 'count_label', 'set_number',
  'side', 'kind', 'status', 'origin', 'failure', 'reps_left', 'reps_left_plus', 'reps_left_target', 'breaks',
  'pump', 'soreness', 'workload', 'notes', 'block', 'pass', 'day', 'set_id', 'saved_at', 'first_done_at',
  // Schema 2 columns (R4-26, 16 B.6.4, 17 C.0.2).
  'set_type', 'why', 'goal_load', 'goal_reps_low', 'goal_reps_high', 'goal_failure_set', 'met', 'exercise_id', 'done_at',
  'short_sleep_since_last', 'body_weight', 'profile'];
const ISO_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

test('build then validate is ok (the v1 fixture)', () => {
  const r = validateBackup(fixtureText(), { now: NOW });
  assert.equal(r.ok, true, r.why);
  const f = fixture2();
  const again = buildBackup(f.stores, { now: NOW });
  assert.equal(check(again).ok, true);
});

test('every flat_log row has every field and a date (M15)', () => {
  const f = fixture2();
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
  const b = buildBackup(fixture2().stores, { now: NOW });
  assert.match(b.exported_at, ISO_LOCAL);
  assert.match(b.flat_log_since, ISO_LOCAL);
  for (const r of b.flat_log) { assert.match(r.first_done_at, ISO_LOCAL); if (r.saved_at !== null) assert.match(r.saved_at, ISO_LOCAL); }
  assert.equal(isoLocal(Date.parse('2026-11-09T23:40:05.000Z')), '2026-11-09T18:40:05.000-05:00');
});

test('a day ticked but never finished gives no flat_log rows; its sets stay in stores', () => {
  const f = fixture2();
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
  const f = fixture2(); f.schema = 3;
  assert.equal(refused(f, 'schema 3').code, 'toonew');
  assert.equal(check(fixture2()).ok, true, 'schema 2 reads');
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
    short_note: W(LIMITS.WORDS), goal_line: W(LIMITS.WORDS), set_type: 'failure' };
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
    status: 'active',
    // Schema 2 block fields at their longest (16 B.6.1a, 17 C.0.3). Shape only: the bytes are the point.
    profile_switch: { switched_at: T, ticks: [true, true, true], back_at: T },
    levels: Object.fromEntries(MUSCLE_DETAILS.map(k => [k, 'middle'])),
    switch_conditions: [W(LIMITS.WORDS), W(LIMITS.WORDS), W(LIMITS.WORDS)], sleep_hint: W(LIMITS.WORDS),
    flag_questions: { machine: W(LIMITS.FLAG_Q), no_added_sets: W(LIMITS.FLAG_Q), left_out_of_builder: W(LIMITS.FLAG_Q) },
    template_id: ID(), copied_from: { block_id: ID(), pass: LIMITS.PASS_MAX }, finished_at: T };
  block.profile = 'adaptive';
  block.rules_frozen = { profile: 'adaptive', rules_version: 'signed-1' };
  const slot = { exercise_id: ID(), rep_low: LIMITS.REPS_MAX, rep_high: LIMITS.REPS_MAX, priority: 'middle', sets: LIMITS.SETS_MAX };
  const template = { id: 'm' + 'a'.repeat(60), author: 'mine', name: W(LIMITS.NAME), made_at: T, from_block_id: ID(),
    days: Array.from({ length: LIMITS.DAYS_PER_BLOCK }, () => ({ label: W(LIMITS.LABEL), slots: Array(LIMITS.LIFTS_PER_DAY).fill(slot) })) };
  const d5 = { load: BIG, reps: LIMITS.REPS_MAX, reps_left: 4, reps_left_plus: false, failure: false };
  return {
    settings: [{ key: 'active_block_id', value: ID() }, { key: 'seeded_version', value: W(LIMITS.VERSION_STR) },
      { key: 'restore_note', value: { rows: Number.MAX_SAFE_INTEGER, at: T } },
      { key: 'equipment_saved', value: [...EQUIPMENT_DETAILS] }, { key: 'tips_seen', value: Object.fromEntries(TIP_IDS.map(k => [k, true])) },
      { key: 'seen_version', value: '1234.1234.1234' }],
    exercises: [{ id: ID(), name: W(LIMITS.NAME), muscle: 'shoulders', equipment: 'bodyweight', count_label: 'seconds',
      weight_steps: LOADS40, step_default: BIG, unilateral: false, machine: false, no_added_sets: false,
      left_out_of_builder: false, flags_set: false, link: 'https://' + W(500), notes: W(LIMITS.NOTE), custom: false, edited: false,
      // Longest words, not a valid pair (the block caps test makes a valid copy).
      muscle_detail: 'forearms_grip', equipment_detail: 'kettlebell', load_kind: 'body_plus', tags: ['overhead', 'spotter'] }],
    templates: [template],
    blocks: [block],
    days: [{ id: ID(), block_id: ID(), pass: LIMITS.PASS_MAX, day: LIMITS.DAY_MAX, label: W(LIMITS.LABEL), status: 'planned',
      started_at: T, done_at: T, done_date: '2026-11-09', scores: many(LIMITS.SCORES, i => [KEYN(i), 10]), notes: W(LIMITS.NOTE), saved_at: T,
      slot_order: Array.from({ length: LIMITS.SLOT_ORDER }, (_, i) => LIMITS.SLOT_MAX - i),
      short_sleep_since_last: false, profile: 'adaptive', body_weight: 999.9 }],
    sets: [{ id: ID(), day_id: ID(), block_id: ID(), exercise_id: ID(), slot: LIMITS.SLOT_MAX, set_n: LIMITS.SET_N_MAX, side: 'none',
      kind: 'warmup', target: { load: BIG, rep_low: LIMITS.REPS_MAX, rep_high: LIMITS.REPS_MAX, load_basis: 'per_side', count_label: 'seconds', reps_left_target: 4,
        failure_set: false, effort_only: false },
      // The longest why is the schema 1 text: a schema 2 key is shorter, so this bounds both.
      draft: d5, done: { ...d5, unit: 'lb', breaks: null }, status: 'planned', origin: 'added', saved_at: T, first_done_at: T, why: 'Stopped by a block check',
      set_type: 'failure', set_type_by_hand: false, add_scope: 'today' }],
    feedback: [{ id: ID(), day_id: ID(), exercise_id: ID(), muscle: 'forearms_grip', pump: 4, soreness: 4, workload: 4,
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
    day: LIMITS.DAY_MAX, set_id: ID(), saved_at: iso, first_done_at: iso,
    set_type: 'failure', why: 'why.dayskipped', goal_load: BIG, goal_reps_low: LIMITS.REPS_MAX, goal_reps_high: LIMITS.REPS_MAX,
    goal_failure_set: false, met: false, exercise_id: ID(), done_at: iso, short_sleep_since_last: false, body_weight: 999.9, profile: 'adaptive' });
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
  const f = fixture2();
  const since = f.exported_at;
  const sinceMs = Date.parse(since);
  const doneDay = f.stores.days.find(d => d.status === 'done');
  const sets = f.stores.sets.filter(s => s.day_id === doneDay.id && s.status === 'done');
  // One older set edited after the time.
  sets[0].saved_at = sinceMs + 5000;
  // One set planned before the time and first ticked after it.
  const late = f.stores.sets.find(s => s.day_id === doneDay.id && s.status === 'skipped');
  Object.assign(late, { status: 'done', first_done_at: sinceMs + 6000, saved_at: sinceMs + 6000, why: 'why.plan',
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
  // The size row pairs the longest words; a valid row pairs each detail with its own group.
  const exRow = { ...largestRows().exercises[0], muscle: 'arms', equipment: 'other' };
  const exercises = Array.from({ length: LIMITS.BLOCK_EXERCISES }, (_, i) => ({ ...exRow, id: ID(i), name: W(LIMITS.NAME - 4) + String(i).padStart(4, '0') }));
  const lift0 = big.day_templates[0].lifts[0];
  const body = { ...big, day_templates: big.day_templates.map((d, di) => ({ ...d, day: di + 1, lifts: Array.from({ length: LIMITS.LIFTS_PER_DAY }, (_, i) => ({ ...lift0, slot: i + 1, exercise_id: ID(i) })) })) };
  for (const k of ['id', 'source_id', 'version', 'id_map', 'created_at', 'status', 'profile_switch', 'template_id', 'copied_from', 'finished_at']) delete body[k];
  // A block file is Fixed only, and a level names a muscle its own lifts train (16 B.6.4, 17 C.0.3).
  body.profile = 'fixed';
  body.rules_frozen = { profile: 'fixed', rules_version: 'signed-1' };
  body.levels = { [exRow.muscle_detail]: 'middle' };
  // Every flag key must name a known exercise: his 500 rows first (the longest ids), then list ids.
  // 17 C.0.2: FLAGS is 5000, above every id a block file can name (the list plus his 500 rows),
  // so the largest file flags every one of them.
  const flagKeys = [...exercises.map(e => e.id), ...SEED_IDS].slice(0, LIMITS.FLAGS);
  assert.equal(flagKeys.length, Math.min(LIMITS.FLAGS, LIMITS.BLOCK_EXERCISES + SEED_IDS.length), 'every id a block file can name is flagged');
  assert.ok(LIMITS.FLAGS >= LIMITS.BLOCK_EXERCISES + SEED_IDS.length, 'the flags cap holds the whole list plus his own rows (17 C.0.2)');
  const flag0 = Object.values(big.exercise_flags)[0];
  body.exercise_flags = Object.fromEntries(flagKeys.map(k => [k, flag0]));
  body.checks = body.checks.map(ck => ({ ...ck, lifts: exercises.slice(0, LIMITS.CHECK_LIFTS).map(e => e.id) }));
  const file = { format: 'liftlog-block', schema: 2, source_id: ID(), version: LIMITS.BLOCK_VERSION_MAX, block: body, exercises };
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
  const data = buildBackup(fixture2().stores, { now: NOW });
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
  assert.ok(st.sets.some(s => s.why === 'why.dayskipped'), 'Day skipped comes back as its key');
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
  for (const s of ['blocks', 'days', 'sets', 'feedback']) assert.deepEqual(again.stores[s], r.stores[s], s + ' kept');
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
  const f = fixture2();
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

// ---------------- schema 2 (DESIGN 16 B.1 step 3, B.6, B.12; 17 C.0.2, C.0.3; r4.4 R11, R12, R14) ----------------

import { SCHEMA } from '../../../version.js';
import { exerciseDefaults2, WHY_KEYS } from '../../../backup.js';
import { SEED_EXERCISES } from '../../../data/exercises.js';

// A clock after the earliest switch day, so a stored switch to Adjust each round is in range.
const NOW2 = Date.parse('2026-12-05T12:00:00-05:00');
const check2 = (obj) => validateBackup(JSON.stringify(obj), { now: NOW2, seedIds: SEED_IDS });
const SET0 = 'b00000000-0000-4000-8000-000000000003:p1:d1:x1:';
const DAY1 = 'b00000000-0000-4000-8000-000000000003:p1:d1';
// A store-shaped schema 2 object with every new field filled at least once (made-up data only).
function full2() {
  // Rows as the store holds them: read once, so every optional schema 1 field has its value.
  const st = check(fixture2()).stores;
  const b = st.blocks[0];
  Object.assign(b, {
    profile: 'adaptive', rules_frozen: { profile: 'adaptive', rules_version: 'signed-1' },
    profile_switch: { switched_at: LIMITS.ADJUST_EARLIEST_MS + 60000, ticks: [true, true, true], back_at: null },
    levels: { quads: 'top', biceps: 'middle' }, switch_conditions: ['Made-up line one.', 'Made-up line two.', 'Made-up line three.'],
    sleep_hint: 'Made-up hint.', flag_questions: { machine: 'Made-up one?', no_added_sets: 'Made-up two?', left_out_of_builder: '' },
    template_id: 'mtpl-1', copied_from: { block_id: 'bold-block', pass: 2 }, finished_at: null
  });
  b.day_templates[0].lifts[0].set_type = 'failure';
  const day = st.days.find(d => d.id === DAY1);
  Object.assign(day, { short_sleep_since_last: true, body_weight: 180.5, profile: 'adaptive' });
  const set = (tail) => st.sets.find(x => x.id === SET0 + tail);
  Object.assign(set('s3:none'), { set_type: 'failure', set_type_by_hand: false });
  set('s3:none').target.failure_set = true;
  Object.assign(set('s2:none'), { set_type: 'failure', set_type_by_hand: true });
  set('s1:none').target.failure_set = false;
  set('s1:none').target.effort_only = true;
  set('s4:none').add_scope = 'rest';
  set('s4:none').why = 'why.hand_add';
  st.feedback[0].muscle = 'quads';
  const ex = st.exercises.find(e => e.id === 'c-00000000-0000-4000-8000-000000000001');
  Object.assign(ex, { muscle_detail: 'biceps', equipment_detail: 'dumbbell', tags: ['overhead'] });
  st.templates = [{ id: 'mtpl-1', author: 'mine', name: 'Made-up template', made_at: NOW2 - 60000, from_block_id: b.id,
    days: [{ label: 'A', slots: [{ exercise_id: st.exercises[0].id, rep_low: 8, rep_high: 12, priority: 'top', sets: 3 }] }] }];
  st.settings.push({ key: 'equipment_saved', value: ['machine', 'cable'] }, { key: 'tips_seen', value: { tip_warmup: true } },
    { key: 'seen_version', value: '0.3.0' });
  return buildBackup(st, { now: NOW2 });
}

test('schema 2 round trip: a store-shaped object with every new field builds and reads back unchanged', () => {
  const f = full2();
  assert.equal(f.schema, SCHEMA);
  assert.equal(SCHEMA, 2);
  const r = check2(f);
  assert.equal(r.ok, true, r.why);
  assert.equal(r.schema, 2);
  for (const s of STORE_NAMES) assert.deepEqual(r.stores[s], f.stores[s], s + ' came back changed');
  const again = buildBackup(r.stores, { now: NOW2 });
  assert.deepEqual(check2(again).stores, r.stores, 'a second round trip changes nothing');
});

test('a schema 1 file and a before-upgrade copy of one restore through migrate as schema 2 rows', async () => {
  const v = validateBackup(fixtureText(), { now: NOW });
  assert.equal(v.ok, true, v.why);
  assert.equal(v.schema, 2);
  assert.ok(v.stores.sets.every(x => WHY_KEYS.includes(x.why) && x.set_type === 'normal'));
  // The before-upgrade copy (16 B.6.2): data is the schema 1 backup object as it was.
  const data = fixture();
  delete data.flat_log;
  const snap = validateSnapshotRow({ id: 's' + NOW, made_at: NOW, reason: 'before-upgrade', last_backup_at_then: null, data }, { now: NOW, seedIds: SEED_IDS });
  assert.equal(snap.schema, 2);
  assert.deepEqual(snap.stores, v.stores);
  // A schema 1 file restored onto a phone: the stored rows are the migrated rows.
  const db = createFakeDb();
  const store = createStore({ db, now: () => NOW, writeLimitMs: 50 });
  await store.seed();
  await store.restoreFile(fixtureText());
  const byId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  for (const s of ['blocks', 'days', 'sets', 'feedback']) assert.deepEqual((await db.all(s)).sort(byId), v.stores[s].slice().sort(byId), s);
});

test('an unknown why text in a schema 1 file refuses it; a schema 1 text in a schema 2 file refuses it', () => {
  const f = fixture(); f.stores.sets[0].why = 'Some other words';
  assert.equal(check(f).ok, false);
  const g = fixture2(); g.stores.sets[0].why = 'As written on your block';
  assert.equal(check(g).ok, false);
  const h = fixture2(); h.stores.sets[0].why = 'why.not_done';
  assert.equal(check(h).ok, false, 'a key not in WHY_KEYS');
});

test('after the bump a schema 1 file still refuses: SR9 id ties, SR12 repeats, a control character, an exported_at of 2099', () => {
  const cases = [
    ['a set id that does not match its slot', f => { const s = f.stores.sets.find(x => x.kind === 'work'); s.slot += 1; }],
    ['a day id that does not match its round', f => { f.stores.days[0].pass = 2; }],
    ['a feedback id with slot 0', f => { f.stores.feedback[0].id = f.stores.feedback[0].day_id + ':x0'; }],
    ['a repeated day number', f => { const dt = f.stores.blocks[0].day_templates; dt[1].day = dt[0].day; }],
    ['a repeated slot in one day', f => { const l = f.stores.blocks[0].day_templates[0].lifts; l[1].slot = l[0].slot; }],
    ['a control character in a note', f => { f.stores.days[0].notes = 'a\u0001b'; }],
    ['an exported_at of 2099', f => { f.exported_at = '2099-01-01T00:00:00.000-05:00'; }]
  ];
  assert.equal(check(fixture()).ok, true);
  for (const [why, mut] of cases) { const f = fixture(); mut(f); assert.equal(f.schema, 1); refused(f, why); }
});

test('a schema 2 file must carry every new field: a missing one refuses it', () => {
  const miss = [['exercises', 'tags'], ['exercises', 'load_kind'], ['blocks', 'levels'], ['blocks', 'profile_switch'], ['blocks', 'finished_at'],
    ['days', 'profile'], ['days', 'body_weight'], ['sets', 'set_type'], ['sets', 'add_scope'], ['sets', 'set_type_by_hand']];
  for (const [s, k] of miss) { const f = full2(); delete f.stores[s][0][k]; assert.equal(check2(f).ok, false, s + '.' + k + ' missing'); }
  const f = full2(); delete f.stores.blocks[0].day_templates[0].lifts[0].set_type; assert.equal(check2(f).ok, false, 'lift set_type missing');
  const g = full2(); delete g.stores.sets[0].target.failure_set; delete g.stores.sets[0].target.effort_only;
  assert.equal(check2(g).ok, true, 'target.failure_set and effort_only may be missing');
});

// One case per B.6.1a row: [name, bad value(s) that refuse, edge value(s) that read].
const blk = (f) => f.stores.blocks[0];
const exC = (f) => f.stores.exercises.find(e => e.id === 'c-00000000-0000-4000-8000-000000000001');
const dayD = (f) => f.stores.days.find(d => d.id === DAY1);
const setS = (f, tail) => f.stores.sets.find(x => x.id === SET0 + tail);
const warm = (f) => f.stores.sets.find(x => x.kind === 'warmup');
const tpl = (f) => f.stores.templates[0];
const setting = (f, k) => f.stores.settings.find(x => x.key === k);
const ROWS2 = [
  ['exercises.muscle_detail', [f => { exC(f).muscle_detail = 'quadz'; }, f => { exC(f).muscle_detail = 'quads'; }],
    [f => { exC(f).muscle_detail = null; }, f => { exC(f).muscle_detail = 'forearms_grip'; }]],
  ['exercises.equipment_detail', [f => { exC(f).equipment_detail = 'smithy'; }, f => { exC(f).equipment_detail = 'cable'; }, f => { exC(f).equipment_detail = null; }],
    [f => { exC(f).equipment = 'other'; exC(f).equipment_detail = 'kettlebell'; }]],
  ['exercises.load_kind', [f => { exC(f).load_kind = 'heavy'; }], [f => { exC(f).load_kind = 'assist'; }, f => { exC(f).load_kind = 'body_plus'; }]],
  ['exercises.tags', [f => { exC(f).tags = ['heavy']; }, f => { exC(f).tags = ['overhead', 'overhead']; }, f => { exC(f).tags = ['overhead', 'spotter', 'overhead']; }, f => { exC(f).tags = null; }],
    [f => { exC(f).tags = []; }, f => { exC(f).tags = ['overhead', 'spotter']; }]],
  ['blocks.profile', [f => { blk(f).profile = 'auto'; }], [f => { blk(f).profile = 'fixed'; blk(f).rules_frozen.profile = 'fixed'; blk(f).profile_switch.back_at = NOW2 - 1000; }]],
  ['blocks.rules_frozen', [f => { blk(f).rules_frozen.profile = 'fixed'; }, f => { blk(f).rules_frozen.rules_version = 'signed-3'; }, f => { blk(f).rules_frozen.rules_version = 'none'; },
    f => { blk(f).rules_frozen = { profile: 'adaptive' }; }],
    [f => { Object.assign(blk(f), { profile: 'fixed', profile_switch: null, rules_frozen: { profile: 'fixed', rules_version: 'none' } }); },
     f => { blk(f).rules_frozen.rules_version = 'signed-2'; }]],
  ['blocks.profile_switch', [f => { blk(f).profile_switch.switched_at = LIMITS.ADJUST_EARLIEST_MS - 1; }, f => { blk(f).profile_switch.ticks = [true, true]; },
    f => { blk(f).profile_switch.ticks = [true, true, false]; }, f => { blk(f).profile_switch.back_at = blk(f).profile_switch.switched_at; },
    f => { blk(f).profile_switch.back_at = NOW2 - 1000; }, f => { blk(f).profile_switch = null; },
    f => { Object.assign(blk(f), { profile: 'fixed', rules_frozen: { profile: 'fixed', rules_version: 'signed-1' } }); }],
    [f => { blk(f).profile_switch.switched_at = LIMITS.ADJUST_EARLIEST_MS; }]],
  ['blocks.levels', [f => { blk(f).levels = { legs: 'top' }; }, f => { blk(f).levels = { quads: 'high' }; }, f => { blk(f).levels = { __proto__: null, constructor: 'top' }; }],
    [f => { blk(f).levels = {}; }, f => { blk(f).levels = Object.fromEntries(MUSCLE_DETAILS.map(k => [k, 'bottom'])); }]],
  ['blocks.switch_conditions', [f => { blk(f).switch_conditions = ['one', 'two']; }, f => { blk(f).switch_conditions = ['one', '', 'three']; },
    f => { blk(f).switch_conditions = ['x'.repeat(121), 'two', 'three']; }, f => { blk(f).switch_conditions = ['one\ntwo', 'two', 'three']; }],
    [f => { blk(f).switch_conditions = []; }, f => { blk(f).switch_conditions = ['x'.repeat(120), 'y', 'z']; }]],
  ['blocks.sleep_hint', [f => { blk(f).sleep_hint = 'x'.repeat(121); }, f => { blk(f).sleep_hint = 'a\nb'; }], [f => { blk(f).sleep_hint = 'x'.repeat(120); }, f => { blk(f).sleep_hint = ''; }]],
  ['blocks.flag_questions', [f => { delete blk(f).flag_questions.machine; }, f => { blk(f).flag_questions.machine = 'x'.repeat(201); }, f => { blk(f).flag_questions = null; }],
    [f => { blk(f).flag_questions.left_out_of_builder = 'x'.repeat(200); }]],
  ['blocks lift set_type', [f => { blk(f).day_templates[0].lifts[0].set_type = 'drop'; }], [f => { blk(f).day_templates[0].lifts[0].set_type = 'normal'; }]],
  ['blocks.template_id', [f => { blk(f).template_id = 'bad id!'; }, f => { blk(f).template_id = '__proto__'; }], [f => { blk(f).template_id = null; }]],
  ['blocks.copied_from', [f => { blk(f).copied_from.pass = 0; }, f => { blk(f).copied_from.pass = LIMITS.PASS_MAX + 1; }, f => { delete blk(f).copied_from.block_id; }, f => { blk(f).copied_from.pass = 1.5; }],
    [f => { blk(f).copied_from.pass = LIMITS.PASS_MAX; }, f => { blk(f).copied_from = null; }]],
  ['blocks.finished_at', [f => { blk(f).finished_at = NOW2 - 1000; }, f => { blk(f).status = 'done'; blk(f).finished_at = 'yesterday'; }],
    [f => { blk(f).status = 'done'; blk(f).finished_at = NOW2 - 1000; }, f => { blk(f).status = 'done'; blk(f).finished_at = null; }]],
  ['days.short_sleep_since_last', [f => { dayD(f).short_sleep_since_last = 'yes'; }], [f => { dayD(f).short_sleep_since_last = null; }, f => { dayD(f).short_sleep_since_last = false; }]],
  ['days.profile', [f => { dayD(f).profile = 'auto'; }, f => { dayD(f).profile = null; }], [f => { dayD(f).profile = 'fixed'; }]],
  ['days.body_weight', [f => { dayD(f).body_weight = 19.9; }, f => { dayD(f).body_weight = 1000.1; }, f => { dayD(f).body_weight = 180.55; }, f => { dayD(f).body_weight = '180'; }],
    [f => { dayD(f).body_weight = 20; }, f => { dayD(f).body_weight = 1000; }, f => { dayD(f).body_weight = 999.9; }, f => { dayD(f).body_weight = null; }]],
  ['sets.set_type', [f => { setS(f, 's1:none').set_type = 'drop'; }, f => { warm(f).set_type = 'failure'; }], [f => { setS(f, 's1:none').set_type = 'failure'; }]],
  ['sets.set_type_by_hand', [f => { setS(f, 's1:none').set_type_by_hand = 'no'; }, f => { warm(f).set_type_by_hand = true; }], [f => { setS(f, 's1:none').set_type_by_hand = true; }]],
  ['sets.add_scope', [f => { setS(f, 's1:none').add_scope = 'today'; }, f => { setS(f, 's4:none').add_scope = null; }, f => { setS(f, 's4:none').add_scope = 'later'; }],
    [f => { setS(f, 's4:none').add_scope = 'today'; }]],
  ['sets.why', [f => { setS(f, 's1:none').why = 'why.nope'; }, f => { setS(f, 's1:none').why = 'As written on your block'; }], [f => { setS(f, 's1:none').why = 'why.swap_hold'; }]],
  ['sets.target.failure_set', [f => { warm(f).target.failure_set = true; }, f => { setS(f, 's1:none').target.failure_set = 'yes'; }],
    [f => { warm(f).target.failure_set = false; }, f => { delete setS(f, 's3:none').target.failure_set; }]],
  ['sets.target.effort_only', [f => { setS(f, 's1:none').target.effort_only = 'yes'; }], [f => { delete setS(f, 's1:none').target.effort_only; }, f => { warm(f).target.effort_only = false; }]],
  ['feedback.muscle', [f => { f.stores.feedback[0].muscle = 'quadz'; }], [f => { f.stores.feedback[0].muscle = 'calves'; }, f => { f.stores.feedback[0].muscle = 'core'; }]],
  ['templates rows', [f => { tpl(f).author = 'ours'; }, f => { tpl(f).id = 'xtpl-1'; }, f => { tpl(f).name = ''; }, f => { tpl(f).days[0].label = 'ABCDE'; },
    f => { tpl(f).days = []; }, f => { tpl(f).days[0].slots = []; }, f => { tpl(f).days[0].slots[0].exercise_id = 'nobody_knows'; },
    f => { tpl(f).days[0].slots[0].rep_low = 13; }, f => { tpl(f).days[0].slots[0].priority = 'high'; }, f => { tpl(f).days[0].slots[0].sets = LIMITS.SETS_MAX + 1; },
    f => { tpl(f).made_at = 'today'; }, f => { tpl(f).from_block_id = 'bad id!'; },
    f => { const t0 = tpl(f); f.stores.templates = Array.from({ length: LIMITS.ROWS.templates + 1 }, (_, i) => ({ ...t0, id: 'm' + i })); f.counts.templates = f.stores.templates.length; }],
    [f => { tpl(f).name = 'x'.repeat(120); tpl(f).days[0].label = ''; tpl(f).days[0].slots[0] = { ...tpl(f).days[0].slots[0], rep_low: null, rep_high: null, priority: null, sets: null }; },
      f => { const t0 = tpl(f); f.stores.templates = Array.from({ length: LIMITS.ROWS.templates }, (_, i) => ({ ...t0, id: 'm' + i })); f.counts.templates = f.stores.templates.length; }]],
  ['settings.equipment_saved', [f => { setting(f, 'equipment_saved').value = []; }, f => { setting(f, 'equipment_saved').value = ['machine', 'machine']; },
    f => { setting(f, 'equipment_saved').value = ['smithy']; }, f => { setting(f, 'equipment_saved').value = [...EQUIPMENT_DETAILS, 'machine']; }],
    [f => { setting(f, 'equipment_saved').value = [...EQUIPMENT_DETAILS]; }, f => { setting(f, 'equipment_saved').value = ['band']; }]],
  ['settings.tips_seen', [f => { setting(f, 'tips_seen').value = { tip_x: true }; }, f => { setting(f, 'tips_seen').value = { tip_rest: 1 }; }, f => { setting(f, 'tips_seen').value = { tip_rest: false }; }],
    [f => { setting(f, 'tips_seen').value = {}; }, f => { setting(f, 'tips_seen').value = Object.fromEntries(TIP_IDS.map(k => [k, true])); }]],
  ['settings.seen_version', [f => { setting(f, 'seen_version').value = '1.2'; }, f => { setting(f, 'seen_version').value = '0.3.0 new'; }, f => { setting(f, 'seen_version').value = '12345.1.1'; }],
    [f => { setting(f, 'seen_version').value = '1234.1234.1234'; }]]
];

for (const [name, bads, edges] of ROWS2) {
  test('B.6.1a ' + name + ': a bad value refuses the file, the edge reads', () => {
    assert.equal(check2(full2()).ok, true, 'the base object reads');
    bads.forEach((mut, i) => { const f = full2(); mut(f); assert.equal(check2(f).ok, false, name + ' bad case ' + (i + 1) + ' should be refused'); });
    edges.forEach((mut, i) => { const f = full2(); mut(f); const r = check2(f); assert.equal(r.ok, true, name + ' edge case ' + (i + 1) + ': ' + r.why); });
  });
}

test('B.6.1a snapshots.reason: before-delete is a safety copy reason', () => {
  assert.ok(SNAPSHOT_REASONS.includes('before-delete'));
  const data = buildBackup(fixture2().stores, { now: NOW });
  delete data.flat_log;
  assert.doesNotThrow(() => validateSnapshotRow({ id: 's' + NOW, made_at: NOW, reason: 'before-delete', last_backup_at_then: null, data }, { now: NOW, seedIds: SEED_IDS }));
});

test('buildBackup keeps equipment_saved, tips_seen and seen_version (SR7 filter, 17 C.0.2)', () => {
  const f = full2();
  for (const k of ['equipment_saved', 'tips_seen', 'seen_version']) assert.ok(f.stores.settings.some(r => r.key === k), k + ' dropped from the file');
  const r = check2(f);
  assert.deepEqual(r.stores.settings.find(x => x.key === 'tips_seen').value, { tip_warmup: true });
});

test('flat_log has every schema 2 column with its value (M15, R4-26)', () => {
  const f = full2();
  const row = (tail) => f.flat_log.find(r => r.set_id === SET0 + tail);
  const day = f.stores.days.find(d => d.id === DAY1);
  for (const r of f.flat_log) for (const k of FLAT_FIELDS) assert.ok(Object.prototype.hasOwnProperty.call(r, k), 'flat_log row lacks ' + k);
  const s3 = row('s3:none'), s2 = row('s2:none'), s1 = row('s1:none'), w1 = row('w1:none'), s4 = row('s4:none');
  assert.equal(s3.set_type, 'failure');
  assert.equal(s3.goal_failure_set, true);
  assert.equal(s3.met, null, 'the planned failure set has no met mark');
  assert.equal(s1.goal_failure_set, false);
  assert.equal(s1.met, null, 'an effort-only set has no met mark');
  assert.equal(w1.met, null, 'a warm-up has no met mark');
  assert.equal(row('s1:none').exercise_id, f.stores.sets.find(x => x.id === SET0 + 's1:none').exercise_id);
  assert.equal(s4.why, 'why.hand_add');
  const plain = f.stores.sets.find(x => x.id === SET0 + 's2:none');
  assert.equal(s2.met, plain.done.reps >= plain.target.rep_low);
  assert.equal(s2.goal_load, plain.target.load);
  assert.equal(s2.goal_reps_low, plain.target.rep_low);
  assert.equal(s2.goal_reps_high, plain.target.rep_high);
  assert.equal(s2.goal_failure_set, null, 'a target with no failure_set key reads null');
  assert.equal(s2.done_at, isoLocal(day.done_at));
  assert.equal(s2.short_sleep_since_last, true);
  assert.equal(s2.body_weight, 180.5);
  assert.equal(s2.profile, 'adaptive');
  // A missed goal reads false.
  const st = check2(f).stores;
  const x = st.sets.find(y => y.id === SET0 + 's2:none');
  x.done.reps = x.target.rep_low - 1;
  assert.equal(buildBackup(st, { now: NOW2 }).flat_log.find(r => r.set_id === x.id).met, false);
  const skipped = f.flat_log.find(r => r.status === 'skipped');
  assert.equal(skipped.met, null, 'a skipped set has no met mark');
});

// ---------------- the block file, schema 2 (16 B.6.4, 17 C.0.3) ----------------

const block2 = () => JSON.parse(readFileSync(join(FIX, 'block_v2.json'), 'utf8'));
const blockOk2 = (f) => validateBlock(JSON.stringify(f), { now: NOW, seedIds: SEED_IDS, seedRows: SEED_EXERCISES });

test('block_v2 reads and round trips: levels, condition lines, lift set_type, the four exercise fields', () => {
  const f = block2();
  const r = blockOk2(f);
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(r.block.levels, f.block.levels);
  assert.deepEqual(r.block.switch_conditions, f.block.switch_conditions);
  assert.equal(r.block.sleep_hint, f.block.sleep_hint);
  assert.deepEqual(r.block.flag_questions, f.block.flag_questions);
  assert.ok(r.block.day_templates.flatMap(d => d.lifts).some(l => l.set_type === 'failure'));
  assert.equal(r.block.profile_switch, null);
  for (const e of r.exercises) for (const k of ['muscle_detail', 'equipment_detail', 'load_kind', 'tags']) assert.deepEqual(e[k], f.exercises.find(x => x.id === e.id)[k], e.id + ' ' + k);
  const again = blockOk2({ ...f, block: r.block, exercises: r.exercises.map(({ custom, ...e }) => ({ ...e, custom: true })) });
  assert.equal(again.ok, true, again.why);
  assert.deepEqual(again.block, r.block, 'a second read changes nothing');
});

test('block_v1 reads through validateBlock as schema 2 rows', () => {
  const r = blockOk2(blockFile());
  assert.equal(r.ok, true, r.why);
  assert.deepEqual([r.block.levels, r.block.switch_conditions, r.block.sleep_hint], [{}, [], '']);
  assert.deepEqual(r.block.flag_questions, { machine: '', no_added_sets: '', left_out_of_builder: '' });
  assert.ok(r.block.day_templates.every(d => d.lifts.every(l => l.set_type === 'normal')));
  for (const e of r.exercises) assert.deepEqual(e, { ...exerciseDefaults2(blockFile().exercises.find(x => x.id === e.id)), custom: true });
});

test('a block file never sets a profile or a switch, and a level names only a muscle its lifts train', () => {
  const bad = (mut, why) => { const f = block2(); mut(f); assert.equal(blockOk2(f).ok, false, why); };
  bad(f => { f.block.profile = 'adaptive'; f.block.rules_frozen.profile = 'adaptive'; }, 'an adaptive block file');
  bad(f => { f.block.profile_switch = { switched_at: NOW, ticks: [true, true, true], back_at: null }; }, 'a block file with a switch');
  bad(f => { f.block.rules_frozen.rules_version = 'signed-9'; }, 'an unknown rules version');
  bad(f => { f.block.levels = { calves: 'top' }; }, 'a level on a muscle no lift trains');
  bad(f => { f.block.levels = { legs: 'top' }; }, 'a level keyed by a chip group');
  bad(f => { f.block.day_templates[0].lifts[0].set_type = 'drop'; }, 'a lift kind not on the list');
  bad(f => { f.exercises[0].muscle_detail = 'quads'; }, 'a custom exercise detail outside its muscle group');
  bad(f => { delete f.exercises[0].load_kind; }, 'a custom exercise with no load kind');
  bad(f => { f.block.switch_conditions = ['only one']; }, 'one condition line');
  // A list lift's muscle is read from seedRows: without them, a level on it refuses.
  const f = block2();
  assert.equal(validateBlock(JSON.stringify(f), { now: NOW, seedIds: SEED_IDS }).ok, false, 'no seedRows: a level on a list lift refuses');
  f.block.levels = { biceps: 'top' };
  assert.equal(validateBlock(JSON.stringify(f), { now: NOW, seedIds: SEED_IDS }).ok, true, 'a level on a file exercise needs no seedRows');
  const g = block2(); g.block.profile_switch = null; assert.equal(blockOk2(g).ok, true, 'a null switch reads');
  const h = block2(); delete h.block.profile_switch; assert.equal(blockOk2(h).ok, true, 'no switch key reads');
  const k = block2(); k.block.template_id = 'mtpl-1'; k.block.finished_at = NOW;
  const rk = blockOk2(k);
  assert.ok(rk.ok && !('template_id' in rk.block) && !('finished_at' in rk.block), 'template_id and finished_at never ride in from a block file');
});

test('a block file of schema 3 is refused as too new', () => {
  const f = block2(); f.schema = 3;
  assert.equal(blockOk2(f).code, 'toonew');
});
