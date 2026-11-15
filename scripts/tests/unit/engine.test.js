// engine.test.js - each engine function's edges, Fixed against the Slice 1 planner, and a scripted
// 4 round run on both profiles. Run: TZ=America/New_York node --test scripts/tests/unit/engine.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULES } from '../../../rules.js';
import {
  planDay, applyLiveEdit, feedbackDue, currentPosition, resizeBlock, buildBlock, autoBuildDays,
  fillSlots, sizeWarning, copyStartValues, validateRules,
  nextWeekSets, startingSets, stepFor, easyWeekPlan, effortTarget
} from '../../../engine.js';
import { createStore } from '../../../store.js';
import { createFakeDb, fakeClock } from './fake_db.js';

const A = RULES.profiles.adaptive;
const F = RULES.profiles.fixed;
const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const blockV1 = () => JSON.parse(readFileSync(join(FIX, 'block_v1.json'), 'utf8'));
// The scripted block of B.12 (B.1 step 11, r4.2 fold-in) and its answer script with the expected
// table, one JSON beside the fixture so e2e.py plays and checks the same numbers.
const ROUNDS_TEXT = () => readFileSync(join(FIX, 'block_rounds.json'), 'utf8');
const ROUNDS_SCRIPT = () => JSON.parse(readFileSync(join(FIX, 'block_rounds_script.json'), 'utf8'));
const MIN = 60000, HOUR = 3600000;
const SLICE1_WHY = 'why.plan';
// The store writes planDay's rows with the schema 2 fields (16 B.3.9, r4.1 Q20); the compare
// leaves them out, as the B.12 field list says (set_type, set_type_by_hand, target.failure_set).
const slice1Shape = (s) => {
  const { set_type: _a, set_type_by_hand: _b, add_scope: _c, ...rest } = s;
  const { failure_set: _d, effort_only: _e, ...target } = s.target;
  return { ...rest, target };
};

// ---------------- Fixed equals the Slice 1 planner ----------------

for (const [name, read] of [['block_v1', () => blockV1()], ['block_rounds', () => JSON.parse(ROUNDS_TEXT())]]) test('Fixed planDay deep-equals the Slice 1 rows for every day of 3 rounds (' + name + ')', async () => {
  const db = createFakeDb();
  const clock = fakeClock('2026-11-02T18:00:00-05:00');
  const store = createStore({ db, now: clock.now, writeLimitMs: 50 });
  await store.seed();
  const file = read();
  const block = await store.createBlock({ ...file.block, day_templates: file.block.day_templates });
  let checked = 0;
  for (let i = 0; i < 2 * 3; i++) {
    const day = await store.currentDay();
    const have = (await db.byIndex('sets', 'day_id', day.id)).map(slice1Shape).sort((a, b) => a.id < b.id ? -1 : 1);
    const want = planDay(F, block, {}, { pass: day.pass, day: day.day }).sets.map(s => ({ ...s, why: SLICE1_WHY })).sort((a, b) => a.id < b.id ? -1 : 1);
    assert.deepEqual(have, want, 'round ' + day.pass + ' day ' + day.day + ' differs from Slice 1');
    checked += have.length;
    // round 1 also equals the Adaptive profile: round 1 is planned in full as written
    if (day.pass === 1) assert.deepEqual(planDay(A, block, {}, { pass: 1, day: day.day }).sets.map(s => ({ ...s, why: SLICE1_WHY })).sort((a, b) => a.id < b.id ? -1 : 1), want);
    const v = await store.dayView(day.id);
    for (const s of v.sets) { clock.add(MIN); await store.tick(s.id, { load: s.target.load, reps: 7, reps_left: 2, reps_left_plus: false, failure: false }); }
    clock.add(MIN);
    await store.finishDay(day.id);
    clock.add(2 * 24 * HOUR);
  }
  assert.ok(checked >= (name === 'block_v1' ? 41 : 27), checked + ' rows compared');
});

test('currentPosition gives the same day as the Slice 1 currentDay', async () => {
  const db = createFakeDb();
  const clock = fakeClock('2026-11-02T18:00:00-05:00');
  const store = createStore({ db, now: clock.now, writeLimitMs: 50 });
  await store.seed();
  const block = await store.createBlock(blockV1().block);
  for (let i = 0; i < 3; i++) {
    const want = await store.currentDay();
    assert.equal(currentPosition(block, await db.all('days')), want.id);
    const v = await store.dayView(want.id);
    clock.add(MIN);
    await store.tick(v.sets[0].id, { load: v.sets[0].target.load, reps: 8, reps_left: 2, reps_left_plus: false, failure: false });
    assert.equal(currentPosition(block, await db.all('days')), want.id, 'the open day wins');
    clock.add(MIN);
    await store.finishDay(want.id);
  }
  assert.equal(currentPosition(null, []), null);
  assert.equal(currentPosition({ id: 'bx' }, [{ id: 'bx:p1:d1', block_id: 'bx', pass: 1, day: 1, status: 'done' }]), null);
});

// ---------------- the scripted rounds ----------------

const EX = [
  { id: 'ex_a', muscle: 'mk_a', muscle_detail: null, equipment: 'machine', weight_steps: null, step_default: 5, machine: true, no_added_sets: false, flags_set: true },
  { id: 'ex_b', muscle: 'mk_b', muscle_detail: null, equipment: 'machine', weight_steps: null, step_default: 5, machine: true, no_added_sets: false, flags_set: true },
  { id: 'ex_c', muscle: 'mk_c', muscle_detail: null, equipment: 'machine', weight_steps: null, step_default: 5, machine: true, no_added_sets: false, flags_set: true },
  { id: 'ex_d', muscle: 'mk_a', muscle_detail: null, equipment: 'cable', weight_steps: null, step_default: 5, machine: false, no_added_sets: false, flags_set: true },
  { id: 'ex_e', muscle: 'mk_e', muscle_detail: null, equipment: 'machine', weight_steps: null, step_default: 5, machine: true, no_added_sets: false, flags_set: true },
  { id: 'ex_f', muscle: 'mk_b', muscle_detail: null, equipment: 'cable', weight_steps: null, step_default: 5, machine: false, no_added_sets: false, flags_set: true }
];
const L = (slot, ex, sets, load, more) => ({ slot, exercise_id: ex, sets, rep_low: 10, rep_high: 12, start_load: load, failure_set: false, reps_left_target: 2, warmups: [], sides: 'none', load_basis: 'total', count_label: null, note: '', ...(more || {}) });
const SCRIPT_BLOCK = () => ({
  id: 'bs', unit: 'lb', passes: 4,
  levels: { mk_a: 'top', mk_b: 'middle', mk_c: 'bottom', mk_e: 'top' },
  exercise_flags: { ex_e: { no_added_sets: true, left_out_of_builder: false } },
  day_templates: [
    { day: 1, label: 'A', lifts: [L(1, 'ex_a', 1, 100), L(2, 'ex_b', 1, 80), L(3, 'ex_c', 2, 60, { failure_set: true, reps_left_target: 0 })] },
    { day: 2, label: 'B', lifts: [L(1, 'ex_d', 1, 40), L(2, 'ex_e', 1, 50), L(3, 'ex_f', 1, 30)] }]
});
// The answer script: low answers, every goal met, slept fine, unless named here.
const SCRIPT = {
  '2:1': { sleep: true, fb: { 1: { soreness: 4 } } },
  '2:2': { fb: { 1: { checks: { check_a: true } } } },
  '3:1': { reps: { 2: 5 } }
};
// Expected work set counts per slot, by round and day, worked out by hand from the signed table.
const EXPECT = {
  adaptive: { '1:1': [1, 1, 2], '1:2': [1, 1, 1], '2:1': [2, 2, 2], '2:2': [1, 1, 1], '3:1': [2, 2, 2], '3:2': [1, 1, 2], '4:1': [2, 2, 2], '4:2': [1, 1, 2] },
  fixed: { '1:1': [1, 1, 2], '1:2': [1, 1, 1], '2:1': [1, 1, 2], '2:2': [1, 1, 1], '3:1': [1, 1, 2], '3:2': [1, 1, 1], '4:1': [1, 1, 2], '4:2': [1, 1, 1] }
};
const EXPECT_WHY = { '2:1': ['why.R8', 'why.R10', 'why.R7'], '2:2': ['why.floor', 'why.flag', 'why.sleep'], '3:1': ['why.sleep', 'why.sleep', 'why.R7'], '3:2': ['why.check', 'why.flag', 'why.R10'] };

function play(h, plan, key) {
  const sc = SCRIPT[key] || {};
  const d = { ...plan.day, status: 'done', scores: { score_a: 1 }, short_sleep_since_last: sc.sleep === true };
  h.days.push(d);
  for (const s of plan.sets) {
    const reps = sc.reps && sc.reps[s.slot] !== undefined ? sc.reps[s.slot] : (s.target.rep_low ?? 10);
    h.sets.push({ ...s, status: 'done', done: { load: s.target.load, reps, reps_left: 2, reps_left_plus: false, failure: false } });
  }
  for (const slot of [...new Set(plan.sets.map(s => s.slot))]) {
    const ex = plan.sets.find(s => s.slot === slot).exercise_id;
    const o = (sc.fb && sc.fb[slot]) || {};
    h.feedback.push({ id: d.id + ':x' + slot, day_id: d.id, exercise_id: ex, muscle: '', pump: o.pump ?? 1, soreness: o.soreness ?? 1, workload: o.workload ?? 1, checks: o.checks || { check_a: false }, note: '', pending: false });
  }
}
function runScript(P) {
  const b = SCRIPT_BLOCK();
  const h = { days: [], sets: [], feedback: [], exercises: EX };
  const plans = {};
  for (let pass = 1; pass <= 4; pass++) for (let day = 1; day <= 2; day++) {
    const key = pass + ':' + day;
    plans[key] = planDay(P, b, h, { pass, day });
    play(h, plans[key], key);
  }
  return plans;
}
const counts = (plan) => [1, 2, 3].map(slot => new Set(plan.sets.filter(s => s.slot === slot && s.kind === 'work').map(s => s.set_n)).size);

test('scripted rounds, Adjust each round: every count and why matches the table', () => {
  const plans = runScript(A);
  for (const [k, want] of Object.entries(EXPECT.adaptive)) assert.deepEqual(counts(plans[k]), want, 'counts at ' + k);
  for (const [k, want] of Object.entries(EXPECT_WHY)) assert.deepEqual(plans[k].notes.map(n => n.why), want, 'why at ' + k);
  // loads, goals and the reps-left goal
  const w = (k, slot) => plans[k].sets.filter(s => s.slot === slot && s.kind === 'work');
  assert.deepEqual(w('2:1', 1).map(s => [s.set_n, s.target.load, s.target.rep_low, s.target.reps_left_target]), [[1, 105, 10, 1], [2, null, null, 1]], 'load up one step; the added set has an effort goal only');
  assert.deepEqual(w('2:1', 3).map(s => s.target.reps_left_target), [1, 0], 'the marked machine set gets 0, the rest the round goal');
  assert.deepEqual(w('4:1', 2).map(s => [s.target.rep_low, s.target.reps_left_target, s.why]), [[4, 8, 'why.easy'], [4, 8, 'why.easy']], 'a miss in round 3 sets done plus 1, then the easy round takes two thirds');
  assert.deepEqual(w('4:1', 3).map(s => s.target.reps_left_target), [8, 8], 'no marked set in the easy round');
  assert.deepEqual([w('3:1', 1)[0].target.load, w('4:1', 1)[0].target.load], [110, 105], 'round 3 met at 110 gives 115, then the easy round: 115 times 0.9 to the nearest 5');
});

test('scripted rounds, Fixed: every count as written, no easy round', () => {
  const plans = runScript(F);
  for (const [k, want] of Object.entries(EXPECT.fixed)) assert.deepEqual(counts(plans[k]), want, 'counts at ' + k);
  for (const p of Object.values(plans)) assert.ok(p.sets.every(s => s.why === 'why.plan'));
  const b = SCRIPT_BLOCK();
  for (const p of Object.values(plans)) for (const s of p.sets.filter(x => x.kind === 'work')) {
    const lift = b.day_templates[p.day.day - 1].lifts.find(l => l.slot === s.slot);
    assert.deepEqual([s.target.load, s.target.rep_low, s.target.reps_left_target], [lift.start_load, lift.rep_low, lift.reps_left_target]);
  }
});

// ---------------- the scripted rounds on block_rounds.json (B.12, B.1 step 11) ----------------

// Plays block_rounds.json for 4 rounds through the store on the fake db, by the answer script
// (block_rounds_script.json: the same file e2e.py plays by taps). The plan of each day is read
// after the sleep answer and before the first tick. Returns { plans, db, block }.
async function playRounds(profile) {
  const S = ROUNDS_SCRIPT();
  const text = ROUNDS_TEXT();
  const file = JSON.parse(text);
  const db = createFakeDb();
  const clock = fakeClock(profile === 'fixed' ? S.fixed_clock : S.adaptive_clock);
  const store = createStore({ db, now: clock.now, writeLimitMs: 50 });
  await store.seed();
  await store.setSetting('unit', 'lb');
  const block = await store.importBlock(text, true);
  const plans = {};
  for (let pass = 1; pass <= 4; pass++) for (let day = 1; day <= 2; day++) {
    const key = pass + ':' + day;
    const sc = { ...S.defaults, ...(S.days[key] || {}) };
    if (profile === 'adaptive' && key === S.switch_on) {
      clock.add(MIN);
      await store.switchProfile(block.id, [true, true, true], 'ADJUST');
    }
    const cd = await store.currentDay();
    assert.deepEqual([cd.pass, cd.day], [pass, day], 'the current day at ' + key);
    clock.add(MIN);
    await store.answerSleep(cd.id, sc.sleep);
    let v = await store.dayView(cd.id);
    plans[key] = { day: cd.id, sets: v.sets.map(s => ({ ...s, target: { ...s.target } })) };
    if (sc.add_rest) {
      if (profile === 'adaptive') await store.liveEdit({ type: 'add_set', dayId: cd.id, slot: sc.add_rest }, 'rest');
      else await store.addSet(cd.id, sc.add_rest);   // Fixed: Add set does not ask (Today only)
    }
    v = await store.dayView(cd.id);
    const lifts = file.block.day_templates[day - 1].lifts;
    for (const s of v.sets.slice().sort((a, b) => a.slot - b.slot || a.set_n - b.set_n)) {
      const lift = lifts.find(l => l.slot === s.slot);
      const named = sc.reps && sc.reps[s.slot] && sc.reps[s.slot][s.set_n] !== undefined ? sc.reps[s.slot][s.set_n] : null;
      clock.add(MIN);
      await store.tick(s.id, { load: s.target.load ?? lift.start_load, reps: named ?? s.target.rep_low ?? lift.rep_low, reps_left: null, reps_left_plus: false, failure: false });
    }
    for (const lift of lifts) {
      const fb = { ...S.defaults, ...((sc.fb && sc.fb[lift.slot]) || {}) };
      clock.add(MIN);
      await store.saveFeedback(cd.id, lift.slot, { pump: fb.pump, soreness: fb.soreness, workload: fb.workload, checks: { check_a: fb.check_a }, note: '' }, false);
    }
    clock.add(MIN);
    await store.finishDay(cd.id, { score_a: sc.score_a });
    clock.add(24 * 60 * MIN);
  }
  return { plans, db, block };
}
// One slot of a planned day as the table writes it: the why, then [load, rep_low, rep_high, reps_left_target] per set number.
const tableSlot = (plan, slot) => {
  const w = plan.sets.filter(s => s.slot === slot && s.kind === 'work' && s.origin === 'plan').sort((a, b) => a.set_n - b.set_n);
  return { why: w.length ? w[0].why : null, sets: w.map(s => [s.target.load, s.target.rep_low, s.target.rep_high, s.target.reps_left_target]) };
};

for (const profile of ['adaptive', 'fixed']) {
  test('scripted rounds (block_rounds.json), ' + profile + ': every planned count, load, rep goal and reps-left goal matches the script table', async () => {
    const S = ROUNDS_SCRIPT();
    const { plans } = await playRounds(profile);
    assert.deepEqual(Object.keys(plans), Object.keys(S.expect[profile]));
    for (const [key, slots] of Object.entries(S.expect[profile])) {
      for (const [slot, want] of Object.entries(slots)) assert.deepEqual(tableSlot(plans[key], Number(slot)), want, profile + ' ' + key + ' slot ' + slot);
    }
  });
}

test('scripted rounds (block_rounds.json), Fixed: every round as the block file writes it, no easy round, no why but the plan', async () => {
  const S = ROUNDS_SCRIPT();
  const file = JSON.parse(ROUNDS_TEXT());
  const { plans } = await playRounds('fixed');
  for (const [key, plan] of Object.entries(plans)) {
    const day = Number(key.split(':')[1]);
    for (const lift of file.block.day_templates[day - 1].lifts) {
      const want = Array.from({ length: lift.sets }, () => [lift.start_load, lift.rep_low, lift.rep_high, lift.reps_left_target]);
      assert.deepEqual(tableSlot(plan, lift.slot), { why: 'why.plan', sets: want }, 'Fixed ' + key + ' slot ' + lift.slot);
    }
  }
  assert.ok(Object.values(S.expect.fixed).every(d => Object.values(d).every(x => x.why === 'why.plan')), 'the Fixed table holds no easy round');
});

test('scripted rounds (block_rounds.json), Adjust each round: rounds 2 to 4 hit every rule the script names', async () => {
  const S = ROUNDS_SCRIPT();
  const { plans, db } = await playRounds('adaptive');
  const why = (key, slot) => tableSlot(plans[key], slot).why;
  const n = (key, slot) => tableSlot(plans[key], slot).sets.length;
  const first = (key, slot) => tableSlot(plans[key], slot).sets[0];
  assert.deepEqual([why('2:1', 1), n('1:1', 1), n('2:1', 1)], ['why.R8', 1, 2], 'R8 add');
  assert.deepEqual([why('2:1', 2), n('1:1', 2), n('2:1', 2)], ['why.R1', 2, 1], 'R1 cut (soreness 4 on the bottom muscle)');
  assert.deepEqual([why('2:1', 3), n('2:1', 3)], ['why.top', 3], 'the top of 3');
  assert.deepEqual([why('2:2', 1), n('2:2', 1)], ['why.check', 1], 'the yes check gate');
  assert.deepEqual([why('2:2', 2), n('2:2', 2)], ['why.flag', 1], 'the lift flagged no_added_sets');
  // The hand add with Rest of block on round 2 day A slot 1: the round's one add with the R8 add, held at 3.
  const added = (await db.all('sets')).filter(s => s.day_id === plans['2:1'].day && s.slot === 1 && s.origin === 'added');
  assert.deepEqual(added.map(s => s.add_scope), ['rest']);
  assert.deepEqual([why('3:1', 1), n('2:1', 1), n('3:1', 1)], ['why.R8', 2, 3], 'the hand add counts as the one add, held at 3');
  assert.deepEqual([why('3:1', 3), n('3:1', 3), first('3:1', 3)[1]], ['why.missed', 3, 8], 'the missed gate (a set under goal in round 2): no add, goal done plus 1');
  assert.deepEqual([why('3:2', 1), n('3:2', 1)], ['why.sleep', 1], 'the sleep gate (Yes on the card)');
  assert.deepEqual([first('2:2', 1)[0], first('2:2', 1)[1], first('3:2', 1)[0], first('3:2', 1)[1]], [80, 8, 75, 10], 'two misses in a row: load down one step, the rep goal back to the planned goal');
  assert.deepEqual([why('3:2', 3), n('3:2', 3)], ['why.R6', 1], 'the score 5 gate (score_a 5 on round 3 day A)');
  for (const key of ['4:1', '4:2']) for (const slot of [1, 2, 3]) {
    const t = tableSlot(plans[key], slot);
    assert.equal(t.why, 'why.easy', 'easy round ' + key + ' slot ' + slot);
    assert.ok(t.sets.length <= 2 && t.sets.every(x => x[3] === 8), 'easy round: 2 sets at most, 4 or more reps left');
  }
  assert.deepEqual(S.expect.adaptive['4:1']['1'].sets, [[105, 7, 8, 8], [105, 7, 7, 8]], 'the table agrees: 115 x 0.9 to the nearest 5, reps x 0.67');
});

// ---------------- planDay edges ----------------

test('planDay: a finished or open day, a round past the block and another block give nothing', () => {
  const b = SCRIPT_BLOCK();
  const h = { days: [{ id: 'bs:p1:d1', block_id: 'bs', pass: 1, day: 1, status: 'open' }], sets: [], feedback: [], exercises: EX };
  assert.equal(planDay(A, b, h, { pass: 1, day: 1 }).day, null);
  assert.equal(planDay(A, b, { exercises: EX }, { pass: 5, day: 1 }).day, null);
  assert.equal(planDay(A, b, { exercises: EX }, { pass: 1, day: 9 }).day, null);
  const other = { days: [{ id: 'zz:p1:d1', block_id: 'zz', pass: 1, day: 1, status: 'done', short_sleep_since_last: true }], sets: [], feedback: [], exercises: EX };
  assert.deepEqual(planDay(A, b, other, { pass: 2, day: 1 }).sets.length > 0, true, 'another block is ignored');
});

test('planDay: a skipped workout plans as done with no answers (holds)', () => {
  const b = SCRIPT_BLOCK();
  const h = { days: [], sets: [], feedback: [], exercises: EX };
  play(h, planDay(A, b, h, { pass: 1, day: 1 }), '1:1');
  const d2 = planDay(A, b, h, { pass: 1, day: 2 });
  h.days.push({ ...d2.day, status: 'skipped' });
  for (const s of d2.sets) h.sets.push({ ...s, status: 'skipped' });
  const p = planDay(A, b, h, { pass: 2, day: 2 });
  assert.deepEqual(counts(p), [1, 1, 1]);
  assert.ok(p.sets.filter(s => s.slot === 1 && s.kind === 'work').every(s => s.target.load === 40), 'targets kept from a slot with no done set');
});

test('planDay: two exercises of one muscle on one day, bad news counts', () => {
  const b = SCRIPT_BLOCK();
  b.day_templates[0].lifts = [L(1, 'ex_a', 1, 100), L(2, 'ex_d', 1, 40)];
  b.day_templates[1].lifts = [L(1, 'ex_b', 1, 80)];
  const h = { days: [], sets: [], feedback: [], exercises: EX };
  const p1 = planDay(A, b, h, { pass: 1, day: 1 });
  SCRIPT['x:1'] = { fb: { 2: { soreness: 4 } } };
  play(h, p1, 'x:1');
  delete SCRIPT['x:1'];
  play(h, planDay(A, b, h, { pass: 1, day: 2 }), '1:2');
  const p = planDay(A, b, h, { pass: 2, day: 1 });
  assert.deepEqual(p.notes.map(n => n.row), ['R1', 'R1']);
});

test('planDay: an exercise slot that is new this round starts at startingSets', () => {
  const b = SCRIPT_BLOCK();
  const h = { days: [], sets: [], feedback: [], exercises: EX };
  play(h, planDay(A, b, h, { pass: 1, day: 1 }), '1:1');
  play(h, planDay(A, b, h, { pass: 1, day: 2 }), '1:2');
  const nb = JSON.parse(JSON.stringify(b));
  nb.day_templates[0].lifts.push(L(4, 'ex_d', 3, 40));
  const p = planDay(A, nb, h, { pass: 2, day: 1 });
  assert.equal(p.notes.find(n => n.slot === 4).sets <= 2, true, 'from 1 set, at most one added');
});

test('planDay: sided lifts plan L and R rows, a miss on one side is a miss', () => {
  const b = SCRIPT_BLOCK();
  b.day_templates[0].lifts = [L(1, 'ex_a', 1, 100, { sides: 'LR' })];
  b.day_templates[1].lifts = [L(1, 'ex_b', 1, 80)];
  const h = { days: [], sets: [], feedback: [], exercises: EX };
  const p1 = planDay(A, b, h, { pass: 1, day: 1 });
  assert.deepEqual(p1.sets.map(s => s.side), ['L', 'R']);
  h.days.push({ ...p1.day, status: 'done', scores: {}, short_sleep_since_last: false });
  for (const s of p1.sets) h.sets.push({ ...s, status: 'done', done: { load: 100, reps: s.side === 'L' ? 10 : 7, reps_left: 2, reps_left_plus: false, failure: false } });
  h.feedback.push({ id: p1.day.id + ':x1', day_id: p1.day.id, exercise_id: 'ex_a', pump: 1, soreness: 1, workload: 1, checks: {} });
  play(h, planDay(A, b, h, { pass: 1, day: 2 }), '1:2');
  const p = planDay(A, b, h, { pass: 2, day: 1 });
  assert.equal(p.notes[0].gate, 'missed');
  assert.deepEqual(p.sets.map(s => [s.side, s.target.rep_low]), [['L', 8], ['R', 8]]);
});

// ---------------- nextWeekSets, startingSets, stepFor, easyWeekPlan ----------------

test('nextWeekSets: the hand add names itself, a row add does not', () => {
  const ok = { sleep: [false], check_yes: false, missed: false, no_added_sets: false, flags_set: true };
  assert.equal(nextWeekSets(A, 1, 0, { ...ok, hand_add: 'rest' }).why, 'why.hand_add');
  assert.equal(nextWeekSets(A, 1, 1, { ...ok, hand_add: 'rest', row_why: 'why.R8' }).why, 'why.R8');
  const cut = nextWeekSets(A, 2, -1, { ...ok, hand_add: 'rest', row_why: 'why.R1' });
  assert.deepEqual([cut.sets, cut.why, cut.hand_add_carried], [1, 'why.R1', false], 'a cut row beats a rest hand add (health-coach verdict item C13)');
  assert.equal(nextWeekSets(A, 1, -1, { ...ok, hand_add: 'rest' }).sets, 1, 'at the floor the cut holds at 1');
  assert.equal(nextWeekSets(A, null, 0, ok).sets, 1);
});

test('startingSets: never more than the lift asks', () => {
  assert.equal(startingSets(A, { sets: 0 }, 'top'), 1);
  assert.equal(startingSets(A, {}, 'middle'), 1);
});

test('stepFor: block list, row list, row step in lb only, then the table', () => {
  const ex = { equipment: 'barbell', weight_steps: [20, 30], step_default: 5 };
  assert.deepEqual(stepFor(A, ex, 'lb', { weight_steps: [7, 3] }), { list: [3, 7] });
  assert.deepEqual(stepFor(A, ex, 'lb', null), { list: [20, 30] });
  assert.deepEqual(stepFor(A, { ...ex, weight_steps: null }, 'lb', null), { size: 5 });
  assert.equal(stepFor(A, { ...ex, weight_steps: null }, 'kg', null), null, 'no kg step');
  assert.deepEqual(stepFor(A, { ...ex, weight_steps: null, step_default: 0 }, 'lb', null), { size: 5 });
  assert.equal(stepFor(A, { equipment: 'bodyweight', weight_steps: null, step_default: 0 }, 'lb', null), null);
});

test('easyWeekPlan: Fixed never makes an easy round; a muscle in drop is left out', () => {
  const plan = { slots: [{ slot: 1, muscle: 'mk_a', step: null, sets: 3, targets: { 1: { load: 50, rep_low: 10, rep_high: 10 } } }] };
  assert.equal(easyWeekPlan(F, plan), plan);
  const dropped = easyWeekPlan({ ...A, easy_week: { ...A.easy_week, drop: ['mk_a'] } }, plan);
  assert.deepEqual(dropped.slots, []);
  assert.deepEqual(easyWeekPlan(A, { slots: [{ slot: 1, muscle: 'x', step: null, sets: 2, targets: {} }] }).slots[0].targets[1], { load: null, rep_low: null, rep_high: null });
});

// ---------------- resizeBlock, buildBlock, autoBuildDays ----------------

const dayRow = (pass, day, status) => ({ id: 'bt:p' + pass + ':d' + day, block_id: 'bt', pass, day, status });
test('resizeBlock: refused once the easy round started, below 4 and on open ended blocks', () => {
  const b = { id: 'bt', passes: 5 };
  assert.equal(resizeBlock(A, b, 1, [dayRow(5, 1, 'open')]).ok, false);
  assert.equal(resizeBlock(A, { id: 'bt', passes: 4 }, -1, []).ok, false);
  assert.equal(resizeBlock(A, b, -1, [dayRow(4, 1, 'done')]).ok, false, 'the last hard round has started');
  assert.equal(resizeBlock(A, { id: 'bt', passes: null }, 1, []).ok, false);
  const r = resizeBlock(A, b, -1, [dayRow(1, 1, 'done'), dayRow(4, 1, 'planned'), dayRow(5, 1, 'planned')]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.replan, [{ pass: 4, day: 1 }], 'a done day is never in the replan');
  assert.deepEqual(r.remove, [{ pass: 5, day: 1 }]);
  assert.deepEqual([1, 2, 3, 4].map(p => effortTarget(A, p, r.block.passes)), [2, 1, 1, 8]);
});
test('resizeBlock, Fixed: refused below the current round, no effort change', () => {
  assert.equal(resizeBlock(F, { id: 'bt', passes: 3 }, -1, [dayRow(3, 1, 'done')]).ok, false);
  const r = resizeBlock(F, { id: 'bt', passes: 3 }, 1, [dayRow(1, 1, 'done')]);
  assert.equal(r.ok, true); assert.equal(r.block.passes, 4);
  assert.equal(effortTarget(F, 2, 4, { reps_left_target: 2 }), 2);
});

test('buildBlock: always Fixed, frozen on the rules version', () => {
  const b = buildBlock(RULES, { id: 'b1', created_at: 5, name: 'N', profile: 'adaptive', day_templates: [], levels: { mk_a: 'top' } });
  assert.equal(b.profile, 'fixed');
  assert.deepEqual(b.rules_frozen, { profile: 'fixed', rules_version: RULES.rules_version });
  assert.equal(RULES.rules_version, 'signed-2', 'a new block freezes signed-2 (r4.4 R17)');
  assert.equal(b.profile_switch, null);
  assert.deepEqual(b.levels, { mk_a: 'top' });
  assert.deepEqual(b.switch_conditions, []);
});

// ---------------- applyLiveEdit ----------------

function editPlan(P, more) {
  const b = SCRIPT_BLOCK();
  const today = planDay(P, b, { exercises: EX }, { pass: 1, day: 1 });
  return { rules: P, block: b, today: { day: today.day, sets: today.sets }, exercises: EX,
    later: [{ pass: 1, day: 2, status: 'planned' }, { pass: 2, day: 1, status: 'planned' }, { pass: 0, day: 2, status: 'done' }], ...(more || {}) };
}
test('live edit add set: today adds one, rest carries, flags refuse in both profiles', () => {
  const r = applyLiveEdit(editPlan(F), { type: 'add_set', slot: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.today_ops.length, 1);
  assert.deepEqual([r.today_ops[0].put.set_n, r.today_ops[0].put.origin, r.today_ops[0].put.add_scope, r.today_ops[0].put.target.load], [2, 'added', 'today', 100]);
  assert.equal(r.carry, null);
  assert.equal(applyLiveEdit(editPlan(F), { type: 'add_set', slot: 1 }, 'rest').ok, false, 'rest needs Adjust each round');
  const rr = applyLiveEdit(editPlan(A), { type: 'add_set', slot: 1 }, 'rest');
  assert.deepEqual(rr.carry, { slot: 1, hand_add: 'rest' });
  const flagged = editPlan(F);
  flagged.today.sets = flagged.today.sets.map(s => (s.slot === 1 ? { ...s, exercise_id: 'ex_e' } : s));
  assert.equal(applyLiveEdit(flagged, { type: 'add_set', slot: 1 }).error, 'flag');
  const unscreened = editPlan(A, { exercises: EX.map(e => (e.id === 'ex_a' ? { ...e, flags_set: false } : e)) });
  assert.equal(applyLiveEdit(unscreened, { type: 'add_set', slot: 1 }).error, 'flag');
});
test('live edit skip set: only the next set in line', () => {
  const p = editPlan(A);
  assert.equal(applyLiveEdit(p, { type: 'skip_set', slot: 3, set_n: 2 }).ok, false);
  const r = applyLiveEdit(p, { type: 'skip_set', slot: 3, set_n: 1 });
  assert.deepEqual(r.today_ops.map(o => [o.put.set_n, o.put.status, o.put.why]), [[1, 'skipped', 'why.skipped']]);
  assert.equal(applyLiveEdit(p, { type: 'skip_set', slot: 3, set_n: 1 }, 'rest').ok, false);
});
test('live edit swap: today keeps the block, rest rewrites the slot and re-plans later planned days only', () => {
  const t = applyLiveEdit(editPlan(A), { type: 'swap', slot: 2, exercise_id: 'ex_f' }, 'today');
  assert.deepEqual(t.block, editPlan(A).block, 'Today only leaves the block as it was');
  assert.deepEqual(t.replan, []);
  assert.ok(t.today_ops.some(o => o.put.exercise_id === 'ex_f' && o.put.slot === 4 && o.put.target.load === null), 'the new exercise takes a new slot');
  assert.ok(t.today_ops.some(o => o.put.slot === 2 && o.put.status === 'skipped' && o.put.why === 'why.swapped'));
  const r = applyLiveEdit(editPlan(A), { type: 'swap', slot: 2, exercise_id: 'ex_f' }, 'rest');
  assert.equal(r.block.day_templates[0].lifts[1].exercise_id, 'ex_f');
  assert.deepEqual(r.replan, [{ pass: 1, day: 2 }, { pass: 2, day: 1 }], 'a done day is never re-planned');
});
test('live edit move, remove, add exercise, relabel: both scopes', () => {
  const mv = applyLiveEdit(editPlan(A), { type: 'move', slot: 1, dir: 1 }, 'rest');
  assert.deepEqual(mv.today_ops[0].put.slot_order, [2, 1, 3]);
  assert.deepEqual(mv.block.day_templates[0].lifts.map(l => l.slot), [2, 1, 3]);
  assert.equal(applyLiveEdit(editPlan(A), { type: 'move', slot: 3, dir: 1 }).ok, false);
  const one = editPlan(A);
  one.today.sets = one.today.sets.filter(s => s.slot === 1);
  one.block.day_templates[0].lifts = one.block.day_templates[0].lifts.slice(0, 1);
  assert.equal(applyLiveEdit(one, { type: 'remove', slot: 1 }, 'today').error, 'last');
  assert.equal(applyLiveEdit(one, { type: 'remove', slot: 1 }, 'rest').error, 'last');
  const rm = applyLiveEdit(editPlan(A), { type: 'remove', slot: 2 }, 'rest');
  assert.deepEqual(rm.block.day_templates[0].lifts.map(l => l.slot), [1, 3]);
  const ax = applyLiveEdit(editPlan(A), { type: 'add_exercise', exercise_id: 'ex_d', sets: 3 });
  assert.equal(ax.block.day_templates[0].lifts.at(-1).sets, 1, 'Adjust each round starts at 1 set');
  assert.ok(ax.today_ops.every(o => o.put.target.load === null && o.put.target.rep_low === null));
  const axf = applyLiveEdit(editPlan(F), { type: 'add_exercise', exercise_id: 'ex_d', sets: 3 }, 'rest');
  assert.equal(axf.block.day_templates[0].lifts.at(-1).sets, 3, 'Fixed takes his number');
  const rl = applyLiveEdit(editPlan(A), { type: 'relabel', label: 'Z' });
  assert.equal(rl.block.day_templates[0].label, 'Z');
  assert.equal(applyLiveEdit(editPlan(A), { type: 'relabel', label: 'Z' }, 'today').block.day_templates[0].label, 'A');
});
test('live edit: a done day is never touched (M37)', () => {
  const p = editPlan(A);
  const before = JSON.stringify(p);
  for (const e of [{ type: 'swap', slot: 1, exercise_id: 'ex_d' }, { type: 'remove', slot: 2 }, { type: 'relabel', label: 'Q' }, { type: 'add_exercise', exercise_id: 'ex_b' }]) {
    const r = applyLiveEdit(p, e, 'rest');
    assert.ok(!r.replan.some(d => d.pass === 0), 'a done day is in the replan');
    assert.ok(r.today_ops.every(o => !o.put || !String(o.put.id).startsWith('bs:p0')));
  }
  assert.equal(JSON.stringify(p), before, 'the input plan is never changed');
  const done = editPlan(A);
  done.today.day = { ...done.today.day, status: 'done' };
  assert.equal(applyLiveEdit(done, { type: 'relabel', label: 'Q' }, 'rest').ok, false);
});

// ---------------- feedbackDue ----------------

test('feedbackDue: soreness alone at the first tick only in Adjust each round, never on a first day', () => {
  const first = (P, c) => feedbackDue(P, null, 'mk_a', { moment: 'first_tick', ...c }).ask;
  assert.deepEqual(first(A, { trained_before: true }), ['soreness'], 'round 2 day A first tick');
  assert.deepEqual(first(A, { trained_before: false }), [], 'the muscle first day of the block');
  assert.deepEqual(first(A, { trained_before: true, soreness_asked_today: true }), [], 'a second exercise of the same muscle that day');
  assert.deepEqual(first(A, { trained_before: true, one_set: true }), [], 'a one-set exercise waits for the one end sheet');
  assert.deepEqual(first(F, { trained_before: true }), [], 'Fixed: nothing at the first tick');
  const end = (P, c) => feedbackDue(P, null, 'mk_a', { moment: 'end', ...c }).ask;
  assert.deepEqual(end(F, { trained_before: true }), ['pump', 'soreness', 'workload', 'checks']);
  assert.deepEqual(end(A, { trained_before: true, soreness_asked_today: true }), ['pump', 'workload', 'checks']);
  assert.deepEqual(end(A, { trained_before: true, soreness_asked_today: true, soreness_put_off: true }), ['pump', 'soreness', 'workload', 'checks']);
  assert.deepEqual(end(A, { trained_before: true, one_set: true, soreness_asked_today: true }), ['pump', 'soreness', 'workload', 'checks']);
  assert.deepEqual(feedbackDue(A, null, 'mk_a', { moment: 'tick' }).ask, ['checks'], 'checks after every saved tick');
  assert.deepEqual(feedbackDue(F, null, 'mk_a', { moment: 'tick', has_planned_set: false }).ask, []);
});

// ---------------- r4.1 line-up cases (DESIGN 16 B.1 step 0 list) ----------------

// Play one planned day with named answers per slot: { fb: { <slot>: {...} }, reps: { <slot>: n }, sleep, edit(row) }.
function playDay(h, plan, o) {
  const opt = o || {};
  const d = { ...plan.day, status: 'done', scores: opt.scores || { score_a: 1 }, short_sleep_since_last: opt.sleep === true };
  h.days.push(d);
  for (const s of plan.sets) {
    const reps = opt.reps && opt.reps[s.slot] !== undefined ? opt.reps[s.slot] : (s.target.rep_low ?? 10);
    let row = { ...s, status: 'done', done: { load: s.target.load, reps, reps_left: 2, reps_left_plus: false, failure: false } };
    if (opt.edit) row = opt.edit(row);
    h.sets.push(row);
  }
  for (const slot of [...new Set(plan.sets.map(s => s.slot))]) {
    const ex = plan.sets.find(s => s.slot === slot).exercise_id;
    const a = (opt.fb && opt.fb[slot]) || {};
    h.feedback.push({ id: d.id + ':x' + slot, day_id: d.id, exercise_id: ex, muscle: '', pump: a.pump ?? 1, soreness: a.soreness ?? 1, workload: a.workload ?? 1, checks: a.checks || { check_a: false }, note: '', pending: false });
  }
  return d;
}
const H = () => ({ days: [], sets: [], feedback: [], exercises: EX });
const slotCount = (plan, slot) => new Set(plan.sets.filter(s => s.slot === slot && s.kind === 'work').map(s => s.set_n)).size;
const ABC = () => ({
  id: 'bw', unit: 'lb', passes: 4, levels: { mk_a: 'top', mk_b: 'middle', mk_c: 'bottom', mk_e: 'top' }, exercise_flags: {},
  day_templates: [
    { day: 1, label: 'A', lifts: [L(1, 'ex_a', 1, 100), L(2, 'ex_b', 1, 80)] },
    { day: 2, label: 'B', lifts: [L(1, 'ex_c', 1, 60)] },
    { day: 3, label: 'C', lifts: [L(1, 'ex_a', 1, 100), L(2, 'ex_f', 1, 30)] }]
});

test('the window: a yes check on lift X on day C shuts round 2 day A, a missed goal too (review R5, M79)', () => {
  const run = (dayC) => {
    const b = ABC();
    const h = H();
    playDay(h, planDay(A, b, h, { pass: 1, day: 1 }));
    playDay(h, planDay(A, b, h, { pass: 1, day: 2 }));
    playDay(h, planDay(A, b, h, { pass: 1, day: 3 }), dayC);
    return planDay(A, b, h, { pass: 2, day: 1 });
  };
  const yes = run({ fb: { 1: { checks: { check_a: true } } } });
  assert.deepEqual([yes.notes[0].row, yes.notes[0].gate, slotCount(yes, 1)], ['R8', 'check', 1]);
  const miss = run({ reps: { 1: 6 } });
  assert.deepEqual([miss.notes[0].row, miss.notes[0].gate, slotCount(miss, 1)], ['R8', 'missed', 1]);
  const fine = run({});
  assert.deepEqual([fine.notes[0].row, fine.notes[0].gate, slotCount(fine, 1)], ['R8', null, 2], 'a clean round adds');
  // the load step stays on the same day and slot: day A met its goal, so its load still moves up
  assert.equal(miss.sets.find(s => s.slot === 1 && s.set_n === 1).target.load, 105);
});

test('a set picked To failure by hand that misses is a miss; the planned failure set is not (review R7, M81)', () => {
  const b = { ...SCRIPT_BLOCK(), day_templates: [
    { day: 1, label: 'A', lifts: [L(1, 'ex_a', 2, 100)] }, { day: 2, label: 'B', lifts: [L(1, 'ex_b', 1, 80)] }] };
  const run = (failureSet) => {
    const h = H();
    playDay(h, planDay(A, b, h, { pass: 1, day: 1 }), { edit: (r) => (r.set_n === 2
      ? { ...r, set_type: 'failure', set_type_by_hand: !failureSet, target: { ...r.target, failure_set: failureSet }, done: { ...r.done, reps: 7 } }
      : { ...r, set_type: 'normal', set_type_by_hand: false, target: { ...r.target, failure_set: false } }) });
    playDay(h, planDay(A, b, h, { pass: 1, day: 2 }));
    return planDay(A, b, h, { pass: 2, day: 1 });
  };
  const byHand = run(false);
  assert.deepEqual([byHand.notes[0].row, byHand.notes[0].gate, slotCount(byHand, 1)], ['R8', 'missed', 2], 'hand-picked 7 of 10: no add, gate missed');
  const planned = run(true);
  assert.deepEqual([planned.notes[0].row, planned.notes[0].gate, slotCount(planned, 1)], ['R8', null, 3], 'planned failure set 7 of 10: no miss, the add goes through');
});

test('a row with no failure_set field takes the position rule; set_type and done.failure no longer skip the check (item 8)', () => {
  const b = { ...SCRIPT_BLOCK(), levels: { mk_a: 'top', mk_b: 'middle', mk_c: 'top', mk_e: 'top' } };
  const h = H();
  // round 1 day A: slot 3 (the marked machine lift, 2 sets) misses on its last set only, written as schema 1 rows
  playDay(h, planDay(A, b, h, { pass: 1, day: 1 }), { edit: (r) => (r.slot === 3 && r.set_n === 2 ? { ...r, done: { ...r.done, reps: 4 } } : r) });
  playDay(h, planDay(A, b, h, { pass: 1, day: 2 }));
  const p = planDay(A, b, h, { pass: 2, day: 1 });
  assert.deepEqual([p.notes.find(n => n.slot === 3).row, p.notes.find(n => n.slot === 3).gate, slotCount(p, 3)], ['R8', null, 3],
    'the last set of the marked slot is the failure set by position, so its miss does not block the add');
  const h2 = H();
  playDay(h2, planDay(A, b, h2, { pass: 1, day: 1 }), { edit: (r) => (r.slot === 1 ? { ...r, set_type: 'failure', done: { ...r.done, reps: 4, failure: true } } : r) });
  playDay(h2, planDay(A, b, h2, { pass: 1, day: 2 }));
  assert.equal(planDay(A, b, h2, { pass: 2, day: 1 }).notes.find(n => n.slot === 1).gate, 'missed', 'a hand failure mark on a non-marked slot still counts');
});

test("the day's own sleep Yes shuts an engine add; a blank on the day is not counted (review R6)", () => {
  const b = SCRIPT_BLOCK();
  const h = H();
  playDay(h, planDay(A, b, h, { pass: 1, day: 1 }));
  playDay(h, planDay(A, b, h, { pass: 1, day: 2 }));
  const open = planDay(A, b, h, { pass: 2, day: 1 });
  assert.equal(slotCount(open, 1), 2, 'R8 adds with every night fine');
  const withYes = { ...h, days: [...h.days, { ...open.day, short_sleep_since_last: true }] };
  const y = planDay(A, b, withYes, { pass: 2, day: 1 });
  assert.deepEqual([y.notes[0].gate, slotCount(y, 1)], ['sleep', 1]);
  assert.deepEqual(y.sets.filter(s => s.slot === 3 && s.kind === 'work').map(s => s.target.reps_left_target), [1, 2], 'and the marked set stops 2 short');
  const withBlank = { ...h, days: [...h.days, { ...open.day, short_sleep_since_last: null }] };
  assert.equal(slotCount(planDay(A, b, withBlank, { pass: 2, day: 1 }), 1), 2);
});

test('the rep ceiling: 30 kept, the set named in notes effort_only_set_n, rows keep the schema 1 shape (r4.1 Q15, Q20)', () => {
  const b = { ...SCRIPT_BLOCK(), unit: 'kg', day_templates: [
    { day: 1, label: 'A', lifts: [L(1, 'ex_g', 1, 60, { rep_low: 30, rep_high: 30 })] }, { day: 2, label: 'B', lifts: [L(1, 'ex_b', 1, 80)] }] };
  const h = { days: [], sets: [], feedback: [], exercises: [...EX, { id: 'ex_g', muscle: 'mk_g', muscle_detail: null, equipment: 'other', weight_steps: null, step_default: 0, machine: false, no_added_sets: false, flags_set: true }] };
  playDay(h, planDay(A, b, h, { pass: 1, day: 1 }), { fb: { 1: { pump: 3, soreness: 2, workload: 2 } } });
  playDay(h, planDay(A, b, h, { pass: 1, day: 2 }));
  const p = planDay(A, b, h, { pass: 2, day: 1 });
  assert.deepEqual(p.notes[0].effort_only_set_n, [1]);
  const row = p.sets.find(s => s.kind === 'work');
  assert.deepEqual([row.target.load, row.target.rep_low], [60, 30]);
  assert.deepEqual(Object.keys(row.target).sort(), ['count_label', 'load', 'load_basis', 'rep_high', 'rep_low', 'reps_left_target'], 'no schema 2 field on the row');
  assert.ok(planDay(F, b, h, { pass: 2, day: 1 }).notes.every(n => Array.isArray(n.effort_only_set_n) && n.effort_only_set_n.length === 0));
});

test('the easy round takes the count as it stands: a cut answer in round 3 moves nothing (r4.1 Q16)', () => {
  const b = SCRIPT_BLOCK();
  const h = H();
  for (const pass of [1, 2]) for (const day of [1, 2]) playDay(h, planDay(A, b, h, { pass, day }));
  const r3 = planDay(A, b, h, { pass: 3, day: 1 });
  playDay(h, r3, { fb: { 1: { soreness: 4 }, 2: { workload: 4 } } });
  playDay(h, planDay(A, b, h, { pass: 3, day: 2 }));
  const e = planDay(A, b, h, { pass: 4, day: 1 });
  assert.deepEqual([1, 2].map(s => slotCount(e, s)), [1, 2].map(s => Math.min(2, slotCount(r3, s))), 'the round 3 count, made lighter, no cut');
  assert.ok(e.notes.every(n => n.why === 'why.easy' && n.delta === 0));
});

test('Fixed equals the Slice 1 rows on the B.12 field list for 3 rounds; a sleep Yes changes only the failure set goal (review R41)', () => {
  const b = SCRIPT_BLOCK();
  const h = H();
  const fields = (rows) => rows.filter(r => r.kind === 'work').map(r => [r.slot, r.set_n, r.target.load, r.target.rep_low, r.target.rep_high, r.target.reps_left_target]);
  for (let pass = 1; pass <= 3; pass++) for (let day = 1; day <= 2; day++) {
    const p = planDay(F, b, h, { pass, day });
    const want = [];
    for (const l of b.day_templates[day - 1].lifts) for (let n = 1; n <= l.sets; n++) want.push([l.slot, n, l.start_load, l.rep_low, l.rep_high, l.reps_left_target]);
    assert.deepEqual(fields(p.sets), want, 'round ' + pass + ' day ' + day);
    playDay(h, p, { reps: { 1: 3 }, fb: { 1: { soreness: 4 } } });
  }
  const plain = planDay(F, b, h, { pass: 4, day: 1 });
  const yes = planDay(F, b, { ...h, days: [...h.days, { ...plain.day, short_sleep_since_last: true }] }, { pass: 4, day: 1 });
  const diff = plain.sets.map((r, i) => (JSON.stringify(r) === JSON.stringify(yes.sets[i]) ? null : [r.slot, r.set_n])).filter(Boolean);
  assert.deepEqual(diff, [[3, 2]], 'only the marked set differs');
  assert.deepEqual([plain.sets.find(r => r.slot === 3 && r.set_n === 2 && r.kind === 'work').target.reps_left_target,
    yes.sets.find(r => r.slot === 3 && r.set_n === 2 && r.kind === 'work').target.reps_left_target], [0, 2]);
});

test('add set: the new id takes 1 plus the highest number used in the slot (review R12)', () => {
  const p = editPlan(A);
  const b = p.block;
  b.day_templates[0].lifts[0] = { ...b.day_templates[0].lifts[0], sets: 2 };
  const t = planDay(A, b, { exercises: EX }, { pass: 1, day: 1 });
  const s2 = t.sets.find(s => s.slot === 1 && s.set_n === 2);
  s2.id = s2.id.replace(':s2:', ':s3:');   // set s2 was deleted earlier, so set_n 2 now holds id s3
  const r = applyLiveEdit({ ...p, block: b, today: { day: t.day, sets: t.sets } }, { type: 'add_set', slot: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual([r.today_ops[0].put.id.split(':').slice(-2).join(':'), r.today_ops[0].put.set_n], ['s4:none', 3]);
});

test("a rest swap maps the block checks to the new exercise; a rest remove leaves them; Today only leaves them (review R13, M84)", () => {
  const withChecks = (P) => {
    const p = editPlan(P);
    p.block.checks = [{ key: 'check_a', ask: 'Made-up?', stop_note: 'Made-up.', lifts: ['ex_b', 'ex_d'] }, { key: 'check_b', ask: 'Made-up?', stop_note: 'Made-up.', lifts: null }];
    return p;
  };
  const r = applyLiveEdit(withChecks(A), { type: 'swap', slot: 2, exercise_id: 'ex_f' }, 'rest');
  assert.deepEqual(r.block.checks.map(c => c.lifts), [['ex_f', 'ex_d'], null]);
  const t = applyLiveEdit(withChecks(A), { type: 'swap', slot: 2, exercise_id: 'ex_f' }, 'today');
  assert.deepEqual(t.block.checks.map(c => c.lifts), [['ex_b', 'ex_d'], null]);
  const rm = applyLiveEdit(withChecks(A), { type: 'remove', slot: 2 }, 'rest');
  assert.deepEqual(rm.block.checks.map(c => c.lifts), [['ex_b', 'ex_d'], null], 'never set to null by machine');
  const p = withChecks(A);
  const before = JSON.stringify(p.block);
  applyLiveEdit(p, { type: 'swap', slot: 2, exercise_id: 'ex_f' }, 'rest');
  assert.equal(JSON.stringify(p.block), before, 'the input block is never changed');
});

test('assist row through planDay: same assist, plus 1 rep; the easy round keeps it (health-coach verdict item C11)', () => {
  const ex = [...EX, { id: 'ex_h', muscle: 'mk_h', muscle_detail: null, equipment: 'machine', load_kind: 'assist', weight_steps: [40, 50, 60, 70], step_default: 5, machine: true, no_added_sets: false, flags_set: true }];
  const b = { ...SCRIPT_BLOCK(), levels: { mk_h: 'bottom' }, day_templates: [
    { day: 1, label: 'A', lifts: [L(1, 'ex_h', 2, 60)] }, { day: 2, label: 'B', lifts: [L(1, 'ex_b', 1, 80)] }] };
  const h = { days: [], sets: [], feedback: [], exercises: ex };
  for (const pass of [1, 2, 3]) for (const day of [1, 2]) {
    const p = planDay(A, b, h, { pass, day });
    if (day === 1 && pass > 1) assert.ok(p.sets.filter(s => s.kind === 'work').every(s => s.target.load === 60 && s.target.rep_low === 9 + pass), 'round ' + pass);
    playDay(h, p);
  }
  const e = planDay(A, b, h, { pass: 4, day: 1 });
  assert.ok(e.sets.filter(s => s.kind === 'work').every(s => s.target.load === 60), 'the easy round keeps the assist');
});


// ---------------- the guided builder (17 C.3.5, C.3.6) ----------------

const DETAILS = ['chest', 'back', 'traps_neck', 'shoulders', 'biceps', 'triceps', 'forearms_grip', 'abs_core', 'quads', 'hamstrings', 'glutes', 'calves'];
const CHIP_OF = { chest: 'chest', back: 'back', traps_neck: 'back', shoulders: 'shoulders', biceps: 'arms', triceps: 'arms', forearms_grip: 'arms', abs_core: 'core', quads: 'legs', hamstrings: 'legs', glutes: 'legs', calves: 'legs' };
const KINDS = ['machine', 'smith', 'cable', 'barbell', 'landmine', 'dumbbell', 'kettlebell', 'band', 'body', 'other'];
// A seeded made-up generator (no Math.random): the same 200 pools every run.
function lcg(seed) { let x = seed >>> 0; return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; }; }
function madePool(rnd, size) {
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  return Array.from({ length: size }, (_, i) => {
    const md = pick(DETAILS);
    return { id: 'pe_' + i, name: 'Made-up ' + String(1000 + Math.floor(rnd() * 9000)), muscle_detail: md, muscle: CHIP_OF[md], equipment_detail: pick(KINDS),
      screened: rnd() < 0.7, left_out_of_builder: rnd() < 0.25, done_count: Math.floor(rnd() * 5) };
  });
}
function madeBoard(rnd) {
  const n = 2 + Math.floor(rnd() * 5);
  return Array.from({ length: n }, (_, i) => ({ day: i + 1, label: String.fromCharCode(65 + i),
    lifts: Array.from({ length: 1 + Math.floor(rnd() * 6) }, (_, k) => ({ slot: k + 1, muscle_detail: DETAILS[Math.floor(rnd() * DETAILS.length)], level: 'middle', exercise_id: null })) }));
}
const eachPick = (days, fn) => { for (const d of days) for (const l of d.lifts) if (l.exercise_id) fn(l, d); };

test('fillSlots property sweep, 200 made-up pools: never a lift left out of the builder (M44), never an unscreened one (M45), never outside the picked kinds (M47)', () => {
  const rnd = lcg(20261114);
  let picks = 0;
  for (let i = 0; i < 200; i++) {
    const pool = madePool(rnd, 5 + Math.floor(rnd() * 60));
    const kinds = KINDS.filter(() => rnd() < 0.6);
    const byId = new Map(pool.map(p => [p.id, p]));
    for (const emptyOnly of [true, false]) {
      const r = fillSlots(F, madeBoard(rnd), pool, { emptyOnly, equipment: kinds });
      assert.equal(r.ok, true);
      eachPick(r.days, (l, d) => {
        const ex = byId.get(l.exercise_id);
        picks++;
        assert.equal(ex.left_out_of_builder, false, 'M44: pool ' + i + ' placed a lift left out of the builder');
        assert.equal(ex.screened, true, 'M45: pool ' + i + ' placed an unscreened lift');
        assert.ok(kinds.includes(ex.equipment_detail), 'M47: pool ' + i + ' placed a kind not picked');
        assert.equal(ex.muscle_detail, l.muscle_detail, 'the slot muscle');
        assert.equal(d.lifts.filter(x => x.exercise_id === l.exercise_id).length, 1, 'never the same exercise twice in a day');
      });
    }
  }
  assert.ok(picks > 500, picks + ' picks checked');
});

test('fillSlots with Fill empty slots only leaves every picked slot as it was (M46, B08)', () => {
  const rnd = lcg(7);
  for (let i = 0; i < 50; i++) {
    const pool = madePool(rnd, 40);
    const board = madeBoard(rnd);
    for (const d of board) for (const l of d.lifts) if (rnd() < 0.4) { l.exercise_id = 'his_pick_' + d.day + '_' + l.slot; l.hand = true; }
    const before = JSON.stringify(board);
    const r = fillSlots(F, board, pool, { emptyOnly: true, equipment: KINDS });
    assert.equal(JSON.stringify(board), before, 'the input is never changed');
    for (const d of board) for (const l of d.lifts) {
      const got = r.days.find(x => x.day === d.day).lifts.find(x => x.slot === l.slot);
      if (l.exercise_id) assert.equal(got.exercise_id, l.exercise_id, 'M46: a picked slot was refilled');
    }
  }
  // emptyOnly false refills every slot but a hand pick on this board
  const pool = [{ id: 'q1', name: 'Q one', muscle_detail: 'chest', muscle: 'chest', equipment_detail: 'machine', screened: true, left_out_of_builder: false, done_count: 0 }];
  const board = [{ day: 1, label: 'A', lifts: [{ slot: 1, muscle_detail: 'chest', exercise_id: 'old', hand: false }, { slot: 2, muscle_detail: 'chest', exercise_id: 'mine', hand: true }] }];
  const all = fillSlots(F, board, pool, { emptyOnly: false, equipment: ['machine'] });
  assert.deepEqual(all.days[0].lifts.map(l => l.exercise_id), ['q1', 'mine']);
});

test('fillSlots order: most done sets first, then name, then id (R4-18); a chip slot takes any row of its chip', () => {
  const row = (id, name, done, md) => ({ id, name, muscle_detail: md || 'quads', muscle: 'legs', equipment_detail: 'machine', screened: true, left_out_of_builder: false, done_count: done });
  const pool = [row('z1', 'Alpha', 1), row('z2', 'Beta', 4), row('z3', 'Alpha', 4), row('z0', 'Alpha', 4), row('h1', 'Ham', 9, 'hamstrings')];
  const board = [{ day: 1, label: 'A', lifts: [1, 2, 3, 4].map(slot => ({ slot, muscle_detail: 'quads', exercise_id: null })) }];
  assert.deepEqual(fillSlots(F, board, pool, { equipment: ['machine'] }).days[0].lifts.map(l => l.exercise_id), ['z0', 'z3', 'z2', 'z1']);
  const chip = [{ day: 1, label: 'A', lifts: [{ slot: 1, muscle_detail: null, muscle: 'legs', exercise_id: null }] }];
  assert.equal(fillSlots(F, chip, pool, { equipment: ['machine'] }).days[0].lifts[0].exercise_id, 'h1');
  assert.deepEqual(fillSlots(F, board, pool, { equipment: ['machine'] }), fillSlots(F, board, pool, { equipment: ['machine'] }), 'same in, same out');
  const none = fillSlots(F, board, pool, { equipment: ['band'] });
  assert.equal(none.filled, 0);
  assert.ok(none.days[0].lifts.every(l => l.exercise_id === null), 'no fit leaves the slot empty');
});

test('recommend (fillSlots only): that muscle, a picked kind, never a left-out lift; again moves to the next (IW6)', () => {
  const pool = [
    { id: 'r1', name: 'Aa', muscle_detail: 'back', muscle: 'back', equipment_detail: 'cable', screened: true, left_out_of_builder: false, done_count: 3 },
    { id: 'r2', name: 'Bb', muscle_detail: 'back', muscle: 'back', equipment_detail: 'cable', screened: true, left_out_of_builder: true, done_count: 9 },
    { id: 'r3', name: 'Cc', muscle_detail: 'back', muscle: 'back', equipment_detail: 'band', screened: true, left_out_of_builder: false, done_count: 9 },
    { id: 'r4', name: 'Dd', muscle_detail: 'back', muscle: 'back', equipment_detail: 'cable', screened: true, left_out_of_builder: false, done_count: 1 },
    { id: 'r5', name: 'Ee', muscle_detail: 'chest', muscle: 'chest', equipment_detail: 'cable', screened: true, left_out_of_builder: false, done_count: 9 }];
  const board = [{ day: 1, label: 'A', lifts: [{ slot: 1, muscle_detail: 'back', exercise_id: null }, { slot: 2, muscle_detail: 'back', exercise_id: null }] }];
  const one = fillSlots(F, board, pool, { only: { day: 1, slot: 2 }, equipment: ['cable'] });
  assert.deepEqual(one.days[0].lifts.map(l => l.exercise_id), [null, 'r1'], 'IW6: only that slot, never r2 (left out) or r3 (band)');
  assert.equal(fillSlots(F, board, pool, { only: { day: 1, slot: 2 }, equipment: ['cable'], index: 1 }).days[0].lifts[1].exercise_id, 'r4');
  assert.equal(fillSlots(F, board, pool, { only: { day: 1, slot: 2 }, equipment: ['cable'], index: 2 }).days[0].lifts[1].exercise_id, 'r1', 'wraps');
});

test('autoBuildDays: a top muscle gets more slots per rotation than a middle one at every length 2 to 6 (M48, BW4, CW2)', () => {
  for (const n of [2, 3, 4, 5, 6]) {
    const r = autoBuildDays(F, { top: ['chest'], middle: ['back'], bottom: ['calves'] }, n, []);
    assert.equal(r.ok, true);
    const count = (m) => r.days.reduce((a, d) => a + d.lifts.filter(l => l.muscle_detail === m).length, 0);
    assert.ok(count('chest') > count('back'), 'M48: at ' + n + ' days top ' + count('chest') + ' vs middle ' + count('back'));
    assert.ok(count('back') >= count('calves'));
    assert.deepEqual([count('chest'), count('back'), count('calves')], [F.builder.slots_per_rotation.top[n], F.builder.slots_per_rotation.middle[n], F.builder.slots_per_rotation.bottom[n]]);
    assert.deepEqual(r.days.map(d => d.label), ['A', 'B', 'C', 'D', 'E', 'F'].slice(0, n));
  }
});

test('autoBuildDays: spread on different days, top before middle before bottom, his rank inside a level, same in same out', () => {
  const lv = { top: ['quads', 'chest'], middle: ['back', 'shoulders'], bottom: ['calves'] };
  const r = autoBuildDays(F, lv, 3, []);
  for (const m of ['quads', 'chest', 'back', 'shoulders']) {
    const on = r.days.filter(d => d.lifts.some(l => l.muscle_detail === m)).length;
    const total = r.days.reduce((a, d) => a + d.lifts.filter(l => l.muscle_detail === m).length, 0);
    assert.equal(on, total, m + ' never twice in one day when its slots fit the days');
  }
  const rank = { quads: 0, chest: 1, back: 2, shoulders: 3, calves: 4 };
  for (const d of r.days) {
    assert.deepEqual(d.lifts.map(l => l.slot), d.lifts.map((_, i) => i + 1));
    for (let i = 1; i < d.lifts.length; i++) assert.ok(rank[d.lifts[i - 1].muscle_detail] < rank[d.lifts[i].muscle_detail], 'order in day ' + d.label);
  }
  assert.deepEqual(autoBuildDays(F, lv, 3, []), autoBuildDays(F, lv, 3, []));
  // 6 top slots at 6 days vs 4 for a top muscle: a muscle with more slots than days repeats
  assert.equal(autoBuildDays(F, { top: ['chest'] }, 6, []).days.every(d => d.lifts.length === 1) === false, true, '4 slots on 6 days: 4 days hold it');
});

test('autoBuildDays: refuses 1 or 7 days and a muscle on two levels (M50 engine half)', () => {
  assert.equal(autoBuildDays(F, { top: ['chest'] }, 1, []).ok, false);
  assert.equal(autoBuildDays(F, { top: ['chest'] }, 7, []).ok, false);
  assert.equal(autoBuildDays(F, { top: ['chest'], middle: ['chest'] }, 3, []).ok, false);
});

test('autoBuildDays: the hard cap of 8 a day; a slot with no room goes on the dropped list, never a silent drop (R4-16)', () => {
  const lv = { top: DETAILS.slice(0, 10), middle: [], bottom: [] };    // 10 top muscles x 2 slots on 2 days = 20 slots, room 16
  const r = autoBuildDays(F, lv, 2, []);
  assert.ok(r.days.every(d => d.lifts.length <= 8));
  const placed = r.days.reduce((a, d) => a + d.lifts.length, 0);
  assert.equal(placed + r.dropped.length, 20);
  assert.equal(r.dropped.length, 4);
  assert.deepEqual(r.dropped.map(x => x.muscle_detail), ['quads', 'quads', 'hamstrings', 'hamstrings']);
});

test('autoBuildDays fills from the pool through the same gate: never a left-out or unscreened lift', () => {
  const pool = [
    { id: 'p1', name: 'P1', muscle_detail: 'chest', muscle: 'chest', equipment_detail: 'machine', screened: true, left_out_of_builder: true, done_count: 0 },
    { id: 'p2', name: 'P2', muscle_detail: 'chest', muscle: 'chest', equipment_detail: 'machine', screened: false, left_out_of_builder: false, done_count: 0 },
    { id: 'p3', name: 'P3', muscle_detail: 'chest', muscle: 'chest', equipment_detail: 'machine', screened: true, left_out_of_builder: false, done_count: 0 }];
  const r = autoBuildDays(F, { top: ['chest'], middle: ['back'] }, 2, pool);
  assert.deepEqual(r.days.map(d => d.lifts.map(l => l.exercise_id)), [['p3', null], ['p3']]);
  assert.ok(autoBuildDays(F, { top: ['chest'] }, 3, []).days.every(d => d.lifts.every(l => l.exercise_id === null)), 'an empty pool leaves every slot empty');
});

test('sizeWarning: past 6 exercises or 10 work sets a day warns; at the line it does not (B07, R4-16)', () => {
  const day = (n, sets) => ({ lifts: Array.from({ length: n }, (_, i) => ({ slot: i + 1, sets })) });
  assert.equal(sizeWarning(F, day(6, 1)), false);
  assert.equal(sizeWarning(F, day(7, 1)), true);
  assert.equal(sizeWarning(F, { lifts: [{ sets: 5 }, { sets: 5 }] }), false, '10 work sets');
  assert.equal(sizeWarning(F, { lifts: [{ sets: 5 }, { sets: 6 }] }), true, '11 work sets');
  assert.equal(sizeWarning(F, day(6, null)), false, 'no set count: its starting sets (1)');
});

// ---------------- copyStartValues (17 C.3.8, R4-17) ----------------

const cs = (n, status, load, o) => ({ kind: 'work', origin: 'plan', set_n: n, side: 'none', exercise_id: 'ex_a', status, done: status === 'done' ? { load, reps: 8 } : null, target: { load: 90 }, ...(o || {}) });
test('copyStartValues: done sets 100, 100, 105 start at 105; sets = the planned count (R4-17)', () => {
  const r = copyStartValues(F, { exercise_id: 'ex_a', sets: 2, rep_low: 8, rep_high: 10, start_load: 80 }, [cs(1, 'done', 100), cs(2, 'done', 100), cs(3, 'done', 105)]);
  assert.deepEqual(r, { sets: 3, start_load: 105, rep_low: 8, rep_high: 10 });
});
test('copyStartValues: no done set starts at the round target load', () => {
  const r = copyStartValues(F, { exercise_id: 'ex_a', sets: 2, rep_low: 8, rep_high: 10, start_load: 80 }, [cs(1, 'planned'), cs(2, 'skipped')]);
  assert.deepEqual(r, { sets: 2, start_load: 90, rep_low: 8, rep_high: 10 });
  assert.equal(copyStartValues(F, { exercise_id: 'ex_a', sets: 2, start_load: 80 }, []).start_load, 80, 'no round rows: the lift start load');
});
test('copyStartValues: a hand-added set is not counted, for sets or load', () => {
  const r = copyStartValues(F, { exercise_id: 'ex_a', sets: 2, rep_low: 8, rep_high: 10 },
    [cs(1, 'done', 100), cs(2, 'done', 100), cs(3, 'done', 130, { origin: 'added' })]);
  assert.deepEqual([r.sets, r.start_load], [2, 100]);
  const lr = copyStartValues(F, { exercise_id: 'ex_a', sets: 1 }, [cs(1, 'done', 40, { side: 'L' }), cs(1, 'done', 40, { side: 'R' })]);
  assert.equal(lr.sets, 1, 'an L and R pair is one set');
});

// ---------------- E15: a level change mid block (17 C.3.7) ----------------

test('E15: after a level change from middle to top, the next round uses the top rule row (Adjust each round)', () => {
  const ex = [{ id: 'ex_q', muscle: 'legs', muscle_detail: 'quads', equipment: 'machine', load_kind: 'external', weight_steps: null, step_default: 5, machine: true, no_added_sets: false, flags_set: true }];
  const blk = (level) => ({ id: 'be', passes: 4, unit: 'lb', levels: { quads: level }, exercise_flags: {}, day_templates: [
    { day: 1, label: 'A', lifts: [{ slot: 1, exercise_id: 'ex_q', sets: 1, rep_low: 8, rep_high: 12, start_load: 100, reps_left_target: 2, warmups: [], sides: 'none', load_basis: 'total', count_label: null, failure_set: false, note: '' }] }] });
  const h = { days: [], sets: [], feedback: [], exercises: ex };
  const p1 = planDay(A, blk('middle'), h, { pass: 1, day: 1 });
  h.days.push({ ...p1.day, status: 'done', scores: {}, short_sleep_since_last: false });
  for (const s of p1.sets) h.sets.push({ ...s, status: 'done', done: { load: 100, reps: 12, reps_left: 2, reps_left_plus: false, failure: false } });
  h.feedback.push({ id: p1.day.id + ':x1', day_id: p1.day.id, exercise_id: 'ex_q', pump: 1, soreness: 1, workload: 2, checks: {} });
  const mid = planDay(A, blk('middle'), h, { pass: 2, day: 1 });
  const top = planDay(A, blk('top'), h, { pass: 2, day: 1 });
  assert.equal(mid.notes[0].row, 'R11', 'on middle these answers hold');
  assert.equal(top.notes[0].row, 'R8', 'E15: on top the same answers take the top row');
  assert.equal(top.notes[0].sets, 2);
  assert.equal(planDay(F, blk('top'), h, { pass: 2, day: 1 }).notes[0].sets, 1, 'on Fixed nothing he lifts changes');
});
