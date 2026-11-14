// migrate.test.js - schema 1 migrates to schema 2 with every store and every row kept (DESIGN 5.7,
// M7; 16 B.6.2, B.6.3, B.12; r4.4 R11, R12).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, MIGRATIONS, STORE_NAMES, validateBackup, WHY, WHY_KEY_OF, WHY_KEYS, exerciseDefaults2, BadFile } from '../../../backup.js';
import { SCHEMA } from '../../../version.js';

const FIXDIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const FIX = join(FIXDIR, 'backup_v1.json');
const NOW = Date.parse('2026-11-09T12:00:00Z');
const load = (name) => JSON.parse(readFileSync(join(FIXDIR, name), 'utf8'));
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

test('the v1 fixture has a row in every store but snapshots and templates', () => {
  const f = JSON.parse(readFileSync(FIX, 'utf8'));
  for (const s of STORE_NAMES.filter(x => x !== 'templates')) assert.ok(f.stores[s].length > 0, s + ' is empty in the fixture');
});

test('migrate keeps every store, every count and every row (M7)', () => {
  const v = validateBackup(readFileSync(FIX, 'utf8'), { now: NOW });
  assert.equal(v.ok, true, v.why);
  assert.equal(v.schema, SCHEMA, 'a schema 1 file comes back as this schema');
  const out = migrate(structuredClone(v.stores), v.schema);
  assert.deepEqual(Object.keys(out).sort(), [...STORE_NAMES].sort());
  for (const s of STORE_NAMES) {
    assert.ok(Array.isArray(out[s]), 'migrate lost ' + s);
    assert.equal(out[s].length, v.stores[s].length, s + ' row count');
  }
  assert.deepEqual(out, v.stores);
  // The 1 to 2 step itself keeps every store and every row (M7 over the v2 path).
  for (const name of ['backup_v1.json', 'backup_v1_polish.json']) {
    const f = load(name);
    const m = migrate(structuredClone(f.stores), 1);
    for (const s of STORE_NAMES) assert.equal(m[s].length, f.stores[s].length, name + ' ' + s + ' row count after the 1 to 2 step');
  }
});

test('MIGRATIONS[1](backup_v1) deep-equals backup_v1_as_v2.json', () => {
  const f = load('backup_v1.json'), want = load('backup_v1_as_v2.json');
  assert.deepEqual(MIGRATIONS[1](structuredClone(f.stores)), want.stores);
  assert.equal(want.schema, 2);
  assert.deepEqual({ ...want, stores: null, schema: 1 }, { ...f, stores: null }, 'the header is never touched');
});

test('MIGRATIONS[1](backup_v1_polish) deep-equals backup_v1_polish_as_v2.json; breaks, from_copy, slot_order and Day skipped kept (R32)', () => {
  const f = load('backup_v1_polish.json'), want = load('backup_v1_polish_as_v2.json');
  const out = MIGRATIONS[1](structuredClone(f.stores));
  assert.deepEqual(out, want.stores);
  // The polish fields ride through as they were.
  const done = f.stores.sets.filter(x => x.done && x.done.breaks !== null);
  assert.ok(done.length > 0, 'the polish fixture holds breaks');
  for (const x of done) assert.equal(out.sets.find(y => y.id === x.id).done.breaks, x.done.breaks, x.id + ' done.breaks');
  const copied = f.stores.sets.filter(x => x.draft && own(x.draft, 'from_copy'));
  assert.ok(copied.length > 0, 'the polish fixture holds a draft with from_copy');
  for (const x of copied) assert.deepEqual(out.sets.find(y => y.id === x.id).draft, x.draft, x.id + ' draft');
  const ordered = f.stores.days.filter(d => Array.isArray(d.slot_order));
  assert.ok(ordered.length > 0, 'the polish fixture holds a card order');
  for (const d of ordered) assert.deepEqual(out.days.find(y => y.id === d.id).slot_order, d.slot_order);
  const skipped = f.stores.sets.filter(x => x.why === 'Day skipped');
  assert.ok(skipped.length > 0, 'the polish fixture holds a Day skipped set');
  for (const x of skipped) assert.equal(out.sets.find(y => y.id === x.id).why, 'why.dayskipped');
});

test('every B.6.1 default, row by row, on both fixtures (r4.4 R12)', () => {
  for (const name of ['backup_v1.json', 'backup_v1_polish.json']) {
    const f = load(name);
    const out = MIGRATIONS[1](structuredClone(f.stores));
    const w = (s, r) => name + ' ' + s + ' ' + r.id;
    // Sets: kind normal, not by hand, add scope today exactly on added sets, why text to key,
    // no failure_set or effort_only key added, every other field the same.
    f.stores.sets.forEach((x, i) => {
      const y = out.sets[i];
      assert.equal(y.set_type, 'normal', w('sets', x));
      assert.equal(y.set_type_by_hand, false, w('sets', x));
      assert.equal(y.add_scope, x.origin === 'added' ? 'today' : null, w('sets', x) + ' add_scope');
      assert.equal(y.why, WHY_KEY_OF[x.why], w('sets', x) + ' why');
      assert.ok(!own(y.target, 'failure_set') && !own(y.target, 'effort_only'), w('sets', x) + ' target gained a key');
      const { set_type, set_type_by_hand, add_scope, why, ...rest } = y;
      const { why: oldWhy, ...restOld } = x;
      assert.deepEqual(rest, restOld, w('sets', x) + ': an id, a text or a time changed');
    });
    // Exercises: exactly the row through exerciseDefaults2, muscle_detail null on every row.
    f.stores.exercises.forEach((e, i) => {
      assert.deepEqual(out.exercises[i], exerciseDefaults2(e), w('exercises', e));
      assert.equal(out.exercises[i].muscle_detail, null, w('exercises', e) + ' muscle_detail');
      assert.deepEqual(out.exercises[i].tags, [], w('exercises', e) + ' tags');
    });
    // Days: the three new fields, nothing else changed.
    f.stores.days.forEach((d, i) => {
      assert.deepEqual(out.days[i], { ...d, short_sleep_since_last: null, body_weight: null, profile: 'fixed' }, w('days', d));
    });
    // Blocks: profile and rules_frozen kept; the new fields at their defaults; lift set_type normal.
    f.stores.blocks.forEach((b, i) => {
      const y = out.blocks[i];
      assert.equal(y.profile, b.profile);
      assert.deepEqual(y.rules_frozen, b.rules_frozen);
      assert.deepEqual([y.profile_switch, y.template_id, y.copied_from, y.finished_at], [null, null, null, null], w('blocks', b));
      assert.deepEqual([y.levels, y.switch_conditions, y.sleep_hint], [{}, [], ''], w('blocks', b));
      assert.deepEqual(y.flag_questions, { machine: '', no_added_sets: '', left_out_of_builder: '' });
      b.day_templates.forEach((dt, di) => dt.lifts.forEach((l, li) => assert.deepEqual(y.day_templates[di].lifts[li], { ...l, set_type: 'normal' })));
      for (const k of Object.keys(b)) if (k !== 'day_templates') assert.deepEqual(y[k], b[k], w('blocks', b) + ' ' + k);
    });
    // Settings, feedback and templates untouched.
    for (const s of ['settings', 'feedback', 'templates']) assert.deepEqual(out[s], f.stores[s], name + ' ' + s);
  }
});

test('exerciseDefaults2 gives the 17 C.0.2 defaults and keeps a field the row holds', () => {
  const row = (id, equipment) => ({ id, equipment });
  assert.deepEqual(exerciseDefaults2(row('x', 'machine')), { id: 'x', equipment: 'machine', muscle_detail: null, equipment_detail: 'machine', load_kind: 'external', tags: [] });
  assert.equal(exerciseDefaults2(row('x', 'bodyweight')).equipment_detail, 'body');
  assert.equal(exerciseDefaults2(row('x', 'bodyweight')).load_kind, 'body');
  assert.equal(exerciseDefaults2(row('assisted_pull_up', 'machine')).load_kind, 'assist');
  for (const e of ['cable', 'barbell', 'dumbbell', 'other']) assert.equal(exerciseDefaults2(row('x', e)).equipment_detail, e);
  assert.deepEqual(exerciseDefaults2({ id: 'x', equipment: 'machine', muscle_detail: 'quads', equipment_detail: 'smith', load_kind: 'body_plus', tags: ['spotter'] }),
    { id: 'x', equipment: 'machine', muscle_detail: 'quads', equipment_detail: 'smith', load_kind: 'body_plus', tags: ['spotter'] });
});

test('backup_v1 reads as schema 2 rows that pass every B.6.1a check', () => {
  // The fixture as it is, and a copy carrying each of the seven Slice 1 why texts.
  const f = load('backup_v1.json');
  f.stores.sets.forEach((x, i) => { x.why = WHY[i % WHY.length]; });
  assert.ok(WHY.every(t => f.stores.sets.some(x => x.why === t)), 'the copy holds all seven texts');
  for (const [name, text] of [['as it is', readFileSync(FIX, 'utf8')], ['all seven texts', JSON.stringify(f)]]) {
    const v = validateBackup(text, { now: NOW });
    assert.equal(v.ok, true, name + ': ' + v.why);
    assert.equal(v.schema, 2);
    for (const x of v.stores.sets) assert.ok(WHY_KEYS.includes(x.why), name + ': ' + x.why + ' is not a why key');
    for (const x of v.stores.sets) assert.ok(['normal', 'failure'].includes(x.set_type));
    for (const d of v.stores.days) assert.ok(own(d, 'short_sleep_since_last') && own(d, 'body_weight') && own(d, 'profile'));
    for (const e of v.stores.exercises) assert.ok(own(e, 'equipment_detail') && own(e, 'load_kind') && Array.isArray(e.tags));
  }
  // The seven map to seven different keys, all in WHY_KEYS.
  assert.deepEqual(Object.keys(WHY_KEY_OF).sort(), [...WHY].sort());
  assert.equal(new Set(Object.values(WHY_KEY_OF)).size, 7);
  for (const k of Object.values(WHY_KEY_OF)) assert.ok(WHY_KEYS.includes(k), k);
});

test('a v2 file passes through unchanged', () => {
  for (const [v1, v2] of [['backup_v1.json', 'backup_v1_as_v2.json'], ['backup_v1_polish.json', 'backup_v1_polish_as_v2.json']]) {
    const a = validateBackup(readFileSync(join(FIXDIR, v2), 'utf8'), { now: NOW });
    assert.equal(a.ok, true, v2 + ': ' + a.why);
    assert.equal(a.schema, 2);
    assert.deepEqual(migrate(structuredClone(a.stores), a.schema), a.stores, v2 + ': migrate at schema 2 changes nothing');
    for (const s of STORE_NAMES) assert.equal(a.stores[s].length, a.counts[s]);
    // Reading the schema 1 file gives the same rows as reading its frozen schema 2 twin.
    const b = validateBackup(readFileSync(join(FIXDIR, v1), 'utf8'), { now: NOW });
    assert.deepEqual(b.stores, a.stores, v1 + ' and ' + v2 + ' read to the same rows');
  }
});

test('MIGRATIONS[1] is pure and throws on a why text it does not know', () => {
  const f = load('backup_v1.json');
  const before = structuredClone(f.stores);
  MIGRATIONS[1](f.stores);
  assert.deepEqual(f.stores, before, 'the input was changed');
  f.stores.sets[0].why = 'Some other words';
  assert.throws(() => MIGRATIONS[1](f.stores), BadFile);
  assert.throws(() => migrate(f.stores, 1), BadFile);
});
