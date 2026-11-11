// rules.test.js - the signed rule table, case by case (TD-2 to TD-7). Run: node --test scripts/tests/unit/rules.test.js
// Every closing-table case is its own named test (T01 to T44) with the signed inputs and outputs,
// then the 64 mix proof, the 125 mix sweep and the property sweeps (planned 1 to 6).
// Lined up with blueprint r4.1 (DESIGN 16 B.1 step 0 list, items 1 to 16).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES } from '../../../rules.js';
import {
  validateRules, setDelta, nextWeekSets, startingSets, effortTarget, nextLoadTarget, retargetOnLoad,
  easyWeekPlan, planDay, resizeBlock, applyLiveEdit
} from '../../../engine.js';

const A = RULES.profiles.adaptive;
const F = RULES.profiles.fixed;
const OK = { sleep: [false, false, false], check_yes: false, missed: false, no_added_sets: false, flags_set: true, hand_add: 'none' };
const sig = (pump, soreness, workload, level, more) => ({ pump, soreness, workload, level: level === undefined ? 'top' : level, score_max: null, check_yes: null, missed: false, ...(more || {}) });
// One round for one exercise: the row, then the caps.
function round(s, planned, ctx) {
  const d = setDelta(A, s);
  const n = nextWeekSets(A, planned, d.delta, { ...OK, ...(ctx || {}), row_why: d.why });
  return { ...d, ...n };
}
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------------- validateRules ----------------

test('validateRules is clean on both shipped profiles', () => {
  const r = validateRules(RULES);
  assert.deepEqual(r, { ok: true, errors: [] });
});

test('validateRules: a removed catch-all row is a hole error (M6)', () => {
  const bad = clone(RULES);
  bad.profiles.adaptive.set_rules.rows = bad.profiles.adaptive.set_rules.rows.filter(r => r.id !== 'R11');
  const r = validateRules(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /holes/.test(e)), 'no hole error: ' + r.errors.join('; '));
});

test('validateRules: a crafted __proto__ key is an error', () => {
  const bad = clone(RULES);
  bad.profiles.adaptive.set_rules.rows[0].when = JSON.parse('{"__proto__": [1], "soreness": [4]}');
  assert.equal(validateRules(bad).ok, false);
});

test('validateRules: caps out of order and a bad effort table are errors', () => {
  const bad = clone(RULES);
  bad.profiles.adaptive.caps.start_max = 4;
  bad.profiles.adaptive.effort.reps_left_by_pass['4'] = [1, 2, 1, 8];
  const r = validateRules(bad);
  assert.ok(r.errors.some(e => /caps out of order/.test(e)));
  assert.ok(r.errors.some(e => /rises/.test(e)));
});

// The B.2 literal (DESIGN 16 B.2), written out again apart from rules.js: the shipped table must equal it.
const B2 = (() => {
  const SIGNALS_FIXED = { pump: { scale: [1, 4], asked: 'end' }, soreness: { scale: [1, 4], asked: 'end' }, workload: { scale: [1, 4], asked: 'end' },
    checks: { asked: 'each_set' }, scores: { scale: [0, 10], asked: 'session_end' }, sleep: { asked: 'day_card' } };
  const SIGNALS_ADAPTIVE = { ...SIGNALS_FIXED, soreness: { scale: [1, 4], asked: 'first_tick' } };
  const CAPS = { start_max: 1, add_per_pass_max: 1, cut_per_pass_max: 1, top_sets: 3, min_sets: 1, no_add_after_short_sleep: true,
    short_sleep_hours: 6, no_add_if_check_yes: true, no_add_if_missed: true };
  const START_SETS = { default: 1, by_priority: { top: 1, middle: 1, bottom: 1 } };
  const EFFORT_ADAPTIVE = { reps_left_by_pass: { 4: [2, 1, 1, 8], 5: [3, 2, 1, 1, 8], 6: [3, 2, 2, 1, 1, 8], 7: [3, 2, 2, 2, 1, 1, 8], 8: [3, 2, 2, 2, 1, 1, 1, 8] },
    length_min: 4, length_max: 8, failure_reps_left: 0, short_sleep_failure_reps_left: 2 };
  const EFFORT_FIXED = { reps_left_by_pass: null, length_min: 1, length_max: 100, failure_reps_left: 0, short_sleep_failure_reps_left: 2 };
  const LOAD_ADAPTIVE = { add_when: 'goal_met', step_source: 'exercise', default_steps: { lb: { barbell: [5], machine: [5], cable: [5], dumbbell: [5] }, kg: {} },
    no_step: 'add_rep', rep_floor: 5, rep_ceiling: 30, on_miss: 'done_plus_one', on_two_misses: 'step_down', retarget_band: { lb: 15, kg: 7, reps_per_step: 1 },
    new_sets: 'effort_only', round_1: 'effort_only' };
  const LOAD_FIXED = { ...LOAD_ADAPTIVE, add_when: 'never', on_miss: 'as_written', on_two_misses: 'as_written' };
  const EASY_ADAPTIVE = { auto: true, set_factor: 2, load_factor: 0.9, reps_factor: 0.67, reps_left: 8, drop: [] };
  const EASY_FIXED = { ...EASY_ADAPTIVE, auto: false };
  const CARRY = { added_set: { today: 'no_carry', rest: 'request_plus_1' }, skipped_set: 'keep_effort_only', swapped: 'keep_count_clear_targets', skipped_day: 'as_done_no_answers' };
  const CARRY_FIXED = { ...CARRY, added_set: { today: 'no_carry', rest: 'no_carry' } };
  const LIVE_EDITS = { add_set: 'today', skip_set: 'today', swap: 'rest', move: 'today', remove: 'today', add_exercise: 'rest', relabel: 'rest' };
  const ROWS = [
    { id: 'R1', when: { soreness: [4] }, delta: -1, why: 'why.R1' }, { id: 'R2', when: { workload: [4] }, delta: -1, why: 'why.R2' },
    { id: 'R3', when: { workload: [3] }, delta: 0, why: 'why.R3' }, { id: 'R4', when: { pump: [4] }, delta: 0, why: 'why.R4' },
    { id: 'R5', when: { soreness: [3] }, delta: 0, why: 'why.R5' }, { id: 'R6', when: { score_max: [5, 6, 7, 8, 9, 10] }, delta: 0, why: 'why.R6' },
    { id: 'R7', when: { level: ['bottom'] }, delta: 0, why: 'why.R7' },
    { id: 'R8', when: { level: ['top'], pump: [1, 2], soreness: [1, 2], workload: [1, 2] }, delta: 1, why: 'why.R8' },
    { id: 'R9', when: { level: ['top'], pump: [3], soreness: [1, 2], workload: [1] }, delta: 1, why: 'why.R9' },
    { id: 'R10', when: { level: ['middle'], pump: [1, 2], soreness: [1, 2], workload: [1] }, delta: 1, why: 'why.R10' },
    { id: 'R11', when: {}, delta: 0, why: 'why.R11' }];
  const SET_KINDS = [{ key: 'normal', counts: 1, miss_check: true }, { key: 'failure', counts: 1, miss_check: false }];
  return { rules_version: 'signed-1', set_kinds: SET_KINDS, profiles: {
    fixed: { signals: SIGNALS_FIXED, set_rules: { source: 'newest_for_muscle', rows: [{ id: 'F1', when: {}, delta: 0, why: 'why.plan' }] },
      caps: CAPS, start_sets: START_SETS, effort: EFFORT_FIXED, load: LOAD_FIXED, easy_week: EASY_FIXED, carry_forward: CARRY_FIXED, live_edits: LIVE_EDITS, builder: {} },
    adaptive: { signals: SIGNALS_ADAPTIVE, set_rules: { source: 'newest_for_muscle', rows: ROWS },
      caps: CAPS, start_sets: START_SETS, effort: EFFORT_ADAPTIVE, load: LOAD_ADAPTIVE, easy_week: EASY_ADAPTIVE, carry_forward: CARRY, live_edits: LIVE_EDITS, builder: {} } } };
})();

test('rules.js equals the B.2 literal, key for key and value for value', async () => {
  assert.deepEqual(clone(RULES), B2);
  const m = await import('../../../rules.js');
  assert.deepEqual(clone(m.RULES_BY_VERSION), { 'signed-1': B2 });
  assert.deepEqual(clone(m.RULE_VERSIONS), ['none', 'signed-1']);
  assert.equal(A.effort.short_sleep_failure_reps_left, 2, 'the effort key of record (health-coach verdict item R4-13)');
  assert.equal(F.effort.short_sleep_failure_reps_left, 2);
});

test('validateRules: a removed effort key is an error', () => {
  const bad = clone(RULES);
  delete bad.profiles.adaptive.effort.short_sleep_failure_reps_left;
  assert.ok(validateRules(bad).errors.some(e => /effort failure goals/.test(e)));
});

test('validateRules: a planted hole and a +2 row each name the row', () => {
  const hole = clone(RULES);
  hole.profiles.adaptive.set_rules.rows = hole.profiles.adaptive.set_rules.rows.filter(r => r.id !== 'R11');
  assert.ok(validateRules(hole).errors.some(e => /last row R10 does not catch all/.test(e)));
  const two = clone(RULES);
  two.profiles.adaptive.set_rules.rows[7].delta = 2;
  assert.ok(validateRules(two).errors.some(e => /row R8 delta 2/.test(e)));
});

test('rules.js is frozen deep', () => {
  assert.ok(Object.isFrozen(RULES) && Object.isFrozen(A.caps) && Object.isFrozen(A.set_rules.rows[7].when.pump));
  assert.throws(() => { 'use strict'; A.caps.top_sets = 4; });
});

// ---------------- the closing table, T01 to T44 ----------------

test('T01 pump 1, soreness 4, workload 2, top, planned 3: R1, 2 sets', () => {
  const r = round(sig(1, 4, 2), 3);
  assert.equal(r.row, 'R1'); assert.equal(r.sets, 2);
});
test('T02 pump 2, soreness 2, workload 4, top, planned 2: R2, 1 set', () => {
  const r = round(sig(2, 2, 4), 2);
  assert.equal(r.row, 'R2'); assert.equal(r.sets, 1);
});
test('T03 pump 1, soreness 1, workload 3, top: R3, delta 0', () => {
  const r = setDelta(A, sig(1, 1, 3)); assert.equal(r.row, 'R3'); assert.equal(r.delta, 0);
});
test('T04 pump 4, soreness 1, workload 2, top: R4, delta 0', () => {
  const r = setDelta(A, sig(4, 1, 2)); assert.equal(r.row, 'R4'); assert.equal(r.delta, 0);
});
test('T05 pump 3, soreness 3, workload 2, top: R5, delta 0', () => {
  const r = setDelta(A, sig(3, 3, 2)); assert.equal(r.row, 'R5'); assert.equal(r.delta, 0);
});
test('T06 pump 1, soreness 1, workload 1, top, score 5: R6, delta 0', () => {
  const r = setDelta(A, sig(1, 1, 1, 'top', { score_max: 5 })); assert.equal(r.row, 'R6'); assert.equal(r.delta, 0);
});
test('T07 same, score 4: R8, delta +1', () => {
  const r = setDelta(A, sig(1, 1, 1, 'top', { score_max: 4 })); assert.equal(r.row, 'R8'); assert.equal(r.delta, 1);
});
test('T08 pump 1, soreness 1, workload 1, bottom: R7, delta 0', () => {
  const r = setDelta(A, sig(1, 1, 1, 'bottom')); assert.equal(r.row, 'R7'); assert.equal(r.delta, 0);
});
test('T09 pump 2, soreness 1, workload 2, top, planned 1: R8, 2 sets', () => {
  const r = round(sig(2, 1, 2), 1);
  assert.equal(r.row, 'R8'); assert.equal(r.sets, 2); assert.equal(r.why, 'why.R8');
  assert.equal(round(sig(2, 1, 2), 2).sets, 3, 'planned 2 goes to 3, one set only');
});
test('T10 pump 3, soreness 1, workload 1, top: R9, +1; workload 2: R11, 0', () => {
  assert.deepEqual([setDelta(A, sig(3, 1, 1)).row, setDelta(A, sig(3, 1, 1)).delta], ['R9', 1]);
  assert.deepEqual([setDelta(A, sig(3, 1, 2)).row, setDelta(A, sig(3, 1, 2)).delta], ['R11', 0]);
});
test('T11 pump 2, soreness 2, workload 1, middle: R10, +1; workload 2: R11, 0', () => {
  assert.deepEqual([setDelta(A, sig(2, 2, 1, 'middle')).row, setDelta(A, sig(2, 2, 1, 'middle')).delta], ['R10', 1]);
  assert.deepEqual([setDelta(A, sig(2, 2, 2, 'middle')).row, setDelta(A, sig(2, 2, 2, 'middle')).delta], ['R11', 0]);
});
test('T12 pump 3, soreness 2, workload 2, top: R11, 0', () => {
  const r = setDelta(A, sig(3, 2, 2)); assert.equal(r.row, 'R11'); assert.equal(r.delta, 0);
});
test('T13 all answers null, any level, any score: delta 0 (R11 under 5, R6 at 5 to 10)', () => {
  // Settled (DESIGN 14.5 review R10): delta 0 at every score; row R11 when the score is null or under 5,
  // row R6 at 5 to 10. Level bottom lands on row R7 under 5 (the level is not an answer); still delta 0.
  for (const level of ['top', 'middle', 'bottom', null]) for (const score_max of [null, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const r = setDelta(A, sig(null, null, null, level, { score_max }));
    assert.equal(r.delta, 0);
    const want = score_max !== null && score_max >= 5 ? 'R6' : level === 'bottom' ? 'R7' : 'R11';
    assert.equal(r.row, want, 'level ' + level + ' score ' + score_max);
  }
});
test('T14 soreness 4, pump and workload null: R1, -1', () => {
  const r = setDelta(A, sig(null, 4, null)); assert.equal(r.row, 'R1'); assert.equal(r.delta, -1);
});
test('T15 R8 at planned 3: 3, held at the top', () => {
  const r = round(sig(1, 1, 1), 3); assert.equal(r.sets, 3); assert.equal(r.why, 'why.top');
});
test('T16 R1 at planned 1: 1, held at the floor', () => {
  const r = round(sig(1, 4, 1), 1); assert.equal(r.sets, 1); assert.equal(r.why, 'why.floor');
});
test('T17 R8, one day short sleep true: delta 0', () => {
  const r = round(sig(2, 1, 2), 2, { sleep: [false, true, false] });
  assert.equal(r.sets, 2); assert.equal(r.gate, 'sleep'); assert.equal(r.why, 'why.sleep');
});
test('T18 R8, one day sleep null: delta 0', () => {
  const r = round(sig(2, 1, 2), 2, { sleep: [false, null, false] });
  assert.equal(r.sets, 2); assert.equal(r.gate, 'sleep');
  assert.equal(round(sig(2, 1, 2), 2, { sleep: [] }).sets, 2, 'no answered day at all blocks too');
});
test('T19 R2, short night, planned 2: 1', () => {
  assert.equal(round(sig(2, 2, 4), 2, { sleep: [true, true, true] }).sets, 1);
});
test('T20 R8, yes check on that lift: delta 0; sibling lift +1', () => {
  const r = round(sig(2, 1, 2), 2, { check_yes: true });
  assert.equal(r.sets, 2); assert.equal(r.gate, 'check');
  assert.equal(round(sig(2, 1, 2), 2, { check_yes: false }).sets, 3, 'the other exercise of the same muscle adds');
  assert.equal(round(sig(2, 1, 2), 2, { check_yes: null }).sets, 3, 'an unanswered check does not block');
});
test('T21 R8 on a no_added_sets or unflagged custom lift: delta 0', () => {
  assert.equal(round(sig(2, 1, 2), 1, { no_added_sets: true }).sets, 1);
  assert.equal(round(sig(2, 1, 2), 1, { flags_set: false }).sets, 1);
  assert.equal(round(sig(2, 1, 2), 1, { flags_set: false }).gate, 'flag');
  assert.equal(nextWeekSets(A, 1, 1, { ...OK, flags_set: undefined }).sets, 1, 'a missing flag reads as no-add');
});
test('T22 planned 1, hand add rest, R8: 2, not 3', () => {
  const r = round(sig(2, 1, 2), 1, { hand_add: 'rest' });
  assert.equal(r.sets, 2); assert.equal(r.hand_add_carried, true);
  // added case (health-coach verdict item C13): planned 2, a cut row, a rest hand add, gates open: the cut stands
  const cut = round(sig(1, 4, 1), 2, { hand_add: 'rest' });
  assert.equal(cut.row, 'R1');
  assert.equal(cut.sets, 1, 'a cut row beats a rest hand add (a sum would give 2)');
  assert.equal(cut.hand_add_carried, false);
  assert.equal(cut.why, 'why.R1');
  const cut2 = round(sig(1, 1, 4), 2, { hand_add: 'rest' });
  assert.deepEqual([cut2.row, cut2.sets, cut2.hand_add_carried], ['R2', 1, false]);
  const hold = round(sig(3, 2, 2), 2, { hand_add: 'rest' });
  assert.deepEqual([hold.row, hold.sets, hold.hand_add_carried, hold.why], ['R11', 3, true, 'why.hand_add'], 'the same with row R11 gives 3');
  assert.equal(round(sig(3, 2, 2), 3, { hand_add: 'rest' }).sets, 3, 'planned 3, hand add rest: 3 (the top)');
});
test('T23 planned 1, hand add rest, short night: 1', () => {
  const r = round(sig(3, 2, 2), 1, { hand_add: 'rest', sleep: [false, true] });
  assert.equal(r.sets, 1); assert.equal(r.hand_add_carried, false); assert.equal(r.gate, 'sleep');
});
test('T24 planned 1, hand add today, R11: 1', () => {
  const r = round(sig(3, 2, 2), 1, { hand_add: 'today' });
  assert.equal(r.sets, 1); assert.equal(r.hand_add_carried, false);
  assert.equal(round(sig(3, 2, 2), 1, { hand_add: 'rest' }).sets, 2, 'the same with rest carries');
});
test('T25 block file planned 4, R11: 3', () => {
  assert.equal(round(sig(3, 2, 2), 4).sets, 3);
});
test('T26 injected row asking +2: validateRules error; engine clamps to +1', () => {
  const bad = clone(RULES);
  bad.profiles.adaptive.set_rules.rows.splice(10, 0, { id: 'RX', when: { pump: [1] }, delta: 2, why: 'why.RX' });
  const r = validateRules(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /row RX delta 2 is past the per round cap/.test(e)), r.errors.join('; '));
  assert.equal(nextWeekSets(A, 1, 2, OK).sets, 2, 'the engine clamps +2 to +1');
  const catchAll = clone(RULES);
  catchAll.profiles.adaptive.set_rules.rows[10] = { id: 'R11', when: {}, delta: 2, why: 'why.R11' };
  assert.ok(validateRules(catchAll).errors.some(e => /row R11 delta 2/.test(e)));
});
test('T27 startingSets any level: 1', () => {
  for (const level of ['top', 'middle', 'bottom', null, 'unknown']) assert.equal(startingSets(A, { sets: 3 }, level), 1);
  assert.equal(startingSets(A, null, null), 1);
  assert.equal(startingSets(F, { sets: 3 }, 'top'), 1);
});
test('T28 effortTarget(rules, 3, 4): 1', () => {
  assert.equal(effortTarget(A, 3, 4), 1);
});

// Small made-up blocks for the planDay cases. No real loads, words or keys.
const EX = [
  { id: 'ex_m1', muscle: 'mk_a', muscle_detail: null, equipment: 'machine', weight_steps: null, step_default: 5, machine: true, no_added_sets: false, flags_set: true },
  { id: 'ex_m2', muscle: 'mk_b', muscle_detail: null, equipment: 'machine', weight_steps: null, step_default: 5, machine: true, no_added_sets: false, flags_set: true },
  { id: 'ex_m3', muscle: 'mk_c', muscle_detail: null, equipment: 'machine', weight_steps: null, step_default: 5, machine: true, no_added_sets: false, flags_set: true },
  { id: 'ex_m4', muscle: 'mk_d', muscle_detail: null, equipment: 'machine', weight_steps: null, step_default: 5, machine: true, no_added_sets: false, flags_set: true }
];
const L = (slot, ex, sets, load, more) => ({ slot, exercise_id: ex, sets, rep_low: 10, rep_high: 12, start_load: load, failure_set: false, reps_left_target: 2, warmups: [], sides: 'none', load_basis: 'total', count_label: null, note: '', ...(more || {}) });
function block(lifts1, lifts2, more) {
  return { id: 'bt', unit: 'lb', passes: 4, levels: { mk_a: 'top', mk_b: 'top', mk_c: 'middle', mk_d: 'top' }, exercise_flags: {},
    day_templates: [{ day: 1, label: 'A', lifts: lifts1 }, { day: 2, label: 'B', lifts: lifts2 }], ...(more || {}) };
}
// Play a planned day: every work set done at its target (reps from `reps`), answers from `fb`.
function play(h, plan, opt) {
  const o = opt || {};
  const d = { ...plan.day, status: o.skip ? 'skipped' : 'done', scores: o.scores || {}, short_sleep_since_last: o.sleep === undefined ? false : o.sleep };
  h.days.push(d);
  for (const s of plan.sets) {
    if (o.skip) { h.sets.push({ ...s, status: 'skipped' }); continue; }
    const reps = o.reps ? o.reps(s) : (s.target.rep_low ?? 10);
    const skipped = o.skipSet && o.skipSet(s);
    h.sets.push(skipped ? { ...s, status: 'skipped' } : { ...s, status: 'done', done: { load: s.target.load, reps, reps_left: 2, reps_left_plus: false, failure: false } });
  }
  if (!o.skip) for (const slot of [...new Set(plan.sets.map(s => s.slot))]) {
    const ex = plan.sets.find(s => s.slot === slot).exercise_id;
    const a = (o.fb && o.fb(slot)) || { pump: 3, soreness: 2, workload: 2, checks: {} };
    h.feedback.push({ id: d.id + ':x' + slot, day_id: d.id, exercise_id: ex, muscle: '', pump: a.pump, soreness: a.soreness, workload: a.workload, checks: a.checks || {}, note: '', pending: false });
  }
  return d;
}
const H = () => ({ days: [], sets: [], feedback: [], exercises: EX });
const work = (plan, slot) => plan.sets.filter(s => s.slot === slot && s.kind === 'work');
const lastWork = (plan, slot) => { const w = work(plan, slot); return w.filter(s => s.set_n === Math.max(...w.map(x => x.set_n))); };

test('T29 marked machine failure set, round 3 of 4: 0; a second marked lift is refused', () => {
  const b = block([L(1, 'ex_m1', 1, 100, { failure_set: true }), L(2, 'ex_m2', 1, 100, { failure_set: true })], [L(1, 'ex_m3', 1, 100)]);
  const h = H();
  for (const pass of [1, 2]) for (const day of [1, 2]) play(h, planDay(A, b, h, { pass, day }));
  const p = planDay(A, b, h, { pass: 3, day: 1 });
  assert.deepEqual(lastWork(p, 1).map(s => s.target.reps_left_target), [0]);
  assert.deepEqual(lastWork(p, 2).map(s => s.target.reps_left_target), [1], 'the second marked lift gets the round goal');
  assert.equal(p.notes.find(n => n.slot === 1).failure_set_n !== null, true);
  assert.equal(p.notes.find(n => n.slot === 2).failure_set_n, null);
  // never on a lift that is not a machine for this block
  const nb = { ...b, exercise_flags: { ex_m1: { no_added_sets: false, left_out_of_builder: false, machine: false } } };
  const p2 = planDay(A, nb, h, { pass: 3, day: 1 });
  assert.deepEqual(lastWork(p2, 1).map(s => s.target.reps_left_target), [1]);
  assert.deepEqual(lastWork(p2, 2).map(s => s.target.reps_left_target), [0], 'the next marked machine lift takes the one set');
});
test('T30 effortTarget(rules, 4, 4): 8', () => {
  assert.equal(effortTarget(A, 4, 4), 8);
});
test('T31 135 lb x 10 met on all sets, step 5: 140 x 10', () => {
  const ex = { equipment: 'barbell', weight_steps: null, step_default: 5 };
  const last = { sets: [1, 2, 3].map(n => ({ set_n: n, status: 'done', target: { load: 135, rep_low: 10, rep_high: 10 }, done: { load: 135, reps: 10 } })) };
  const r = nextLoadTarget(A, { exercise: ex, unit: 'lb', template: {} }, last);
  for (const n of [1, 2, 3]) assert.deepEqual(r.targets[n], { load: 140, rep_low: 10, rep_high: 10 });
  assert.equal(r.why, 'why.load_up');
  const r2 = nextLoadTarget(A, { exercise: { ...ex, step_default: 0 }, unit: 'lb', template: {} }, last);
  assert.equal(r2.targets[1].load, 140, 'no own step: the table default 5 lb for barbell');
});
test('T32 60 kg x 8 met, kg list empty: 60 x 9', () => {
  const ex = { equipment: 'machine', weight_steps: null, step_default: 5 };
  const last = { sets: [{ set_n: 1, status: 'done', target: { load: 60, rep_low: 8, rep_high: 8 }, done: { load: 60, reps: 8 } }] };
  const r = nextLoadTarget(A, { exercise: ex, unit: 'kg', template: {} }, last);
  assert.deepEqual(r.targets[1], { load: 60, rep_low: 9, rep_high: 9 });
  assert.equal(r.why, 'why.rep_up');
});
test('T33 goal 11, done 8 at 100 lb: 100 x 9', () => {
  const ex = { equipment: 'machine', weight_steps: null, step_default: 5 };
  const last = { sets: [{ set_n: 1, status: 'done', target: { load: 100, rep_low: 11, rep_high: 12 }, done: { load: 100, reps: 8 } },
    { set_n: 2, status: 'done', target: { load: 100, rep_low: 11, rep_high: 12 }, done: { load: 100, reps: 11 } }] };
  const r = nextLoadTarget(A, { exercise: ex, unit: 'lb', template: {} }, last);
  assert.equal(r.missed, true);
  assert.deepEqual(r.targets[1], { load: 100, rep_low: 9, rep_high: 12 });
  assert.deepEqual(r.targets[2], { load: 100, rep_low: 11, rep_high: 12 }, 'a met set keeps its goal and no load is added');
});
test('T34 planned 140 x 10, typed 130 / 150 / 160: 12 / 8 / effort only', () => {
  const t = { load: 140, rep_low: 10, rep_high: 12, step: { size: 5 }, unit: 'lb' };
  assert.deepEqual(retargetOnLoad(A, t, 130), { rep_low: 12 });
  assert.deepEqual(retargetOnLoad(A, t, 150), { rep_low: 8 });
  assert.deepEqual(retargetOnLoad(A, t, 160), { effort_only: true });
  assert.deepEqual(retargetOnLoad(A, t, 155), { rep_low: 7 }, 'the band edge is inside');
  assert.deepEqual(retargetOnLoad(A, { load: 60, rep_low: 9, rep_high: 9, step: null, unit: 'kg' }, 55), { effort_only: true });
  assert.deepEqual(retargetOnLoad(F, t, 130), { rep_low: 10 }, 'Fixed shows the goal as written');
});
test('T35 easy round from 3 sets at 145 lb x 10: 2 sets, 130 lb, 7 reps, goal 8', () => {
  const t = { load: 145, rep_low: 10, rep_high: 10 };
  const r = easyWeekPlan(A, { slots: [{ slot: 1, muscle: 'mk_a', step: { size: 5 }, sets: 3, targets: { 1: t, 2: t, 3: t } },
    { slot: 2, muscle: 'mk_b', step: null, sets: 1, targets: { 1: { load: 55, rep_low: 9, rep_high: 9 } } }] });
  assert.equal(r.slots[0].sets, 2);
  assert.deepEqual(r.slots[0].targets[1], { load: 130, rep_low: 7, rep_high: 7 });
  assert.equal(r.slots[0].reps_left, 8);
  assert.equal(r.slots[0].failure_set_n, null);
  assert.equal(r.slots[1].sets, 1, '1 set stays 1');
  assert.deepEqual(r.slots[1].targets[1], { load: 50, rep_low: 6, rep_high: 6 }, '55 with no step: 50; 9 reps: 6');
  // and through planDay: round 4 of 4 is the easy round
  const b = block([L(1, 'ex_m1', 3, 145, { rep_low: 10, rep_high: 10 })], [L(1, 'ex_m2', 1, 100)]);
  const h = H();
  for (const pass of [1, 2, 3]) for (const day of [1, 2]) play(h, planDay(A, b, h, { pass, day }), { reps: () => 9 });
  const p = planDay(A, b, h, { pass: 4, day: 1 });
  const w = work(p, 1);
  assert.equal(new Set(w.map(s => s.set_n)).size, 2);
  assert.ok(w.every(s => s.target.reps_left_target === 8 && s.why === 'why.easy'));
});
test('T36 easy round answers "Not gone yet": no set change', () => {
  const b = block([L(1, 'ex_m1', 2, 100)], [L(1, 'ex_m1', 2, 100)], { levels: { mk_a: 'top' } });
  const h = H();
  for (const pass of [1, 2, 3]) for (const day of [1, 2]) play(h, planDay(A, b, h, { pass, day }));
  const e1 = planDay(A, b, h, { pass: 4, day: 1 });
  play(h, e1, { fb: () => ({ pump: 1, soreness: 4, workload: 4, checks: {} }) });
  const e2 = planDay(A, b, h, { pass: 4, day: 2 });
  assert.equal(new Set(work(e2, 1).map(s => s.set_n)).size, 2, 'the easy answers changed no set');
});
test('T37 swap a 2-set lift, scope rest: 2 sets, targets cleared, delta 0 next round', () => {
  const b = block([L(1, 'ex_m1', 2, 100), L(2, 'ex_m3', 1, 50)], [L(1, 'ex_m2', 1, 100)]);
  const h = H();
  play(h, planDay(A, b, h, { pass: 1, day: 1 }));
  play(h, planDay(A, b, h, { pass: 1, day: 2 }));
  const today = planDay(A, b, h, { pass: 2, day: 1 });
  const ed = applyLiveEdit({ rules: A, block: b, today: { day: today.day, sets: today.sets }, later: [{ pass: 3, day: 1, status: 'planned' }], exercises: EX },
    { type: 'swap', slot: 1, exercise_id: 'ex_m4' }, 'rest');
  assert.equal(ed.ok, true);
  const nb = ed.block;
  assert.deepEqual(nb.day_templates[0].lifts[0], { ...b.day_templates[0].lifts[0], exercise_id: 'ex_m4', start_load: null, rep_low: null, rep_high: null });
  assert.deepEqual(ed.replan, [{ pass: 3, day: 1 }]);
  play(h, today, { fb: () => ({ pump: 1, soreness: 1, workload: 1, checks: {} }) });
  play(h, planDay(A, nb, h, { pass: 2, day: 2 }));
  const next = planDay(A, nb, h, { pass: 3, day: 1 });
  const w = work(next, 1);
  assert.equal(new Set(w.map(s => s.set_n)).size, 2, 'count kept');
  assert.ok(w.every(s => s.exercise_id === 'ex_m4' && s.target.load === null && s.target.rep_low === null));
  assert.equal(next.notes.find(n => n.slot === 1).delta, 0);
  assert.equal(next.notes.find(n => n.slot === 1).why, 'why.swap_hold');
});
test('T38 3 planned, 1 skipped, R11: 3, skipped slot effort only', () => {
  // As changed by health-coach (verdict item C12): 3 planned, 1 skipped, R11 gives 3; planned 4 gives 3 (T25).
  const b = block([L(1, 'ex_m1', 3, 100)], [L(1, 'ex_m2', 1, 100)]);
  const h = H();
  play(h, planDay(A, b, h, { pass: 1, day: 1 }), { skipSet: (s) => s.set_n === 3 });
  play(h, planDay(A, b, h, { pass: 1, day: 2 }));
  const p = planDay(A, b, h, { pass: 2, day: 1 });
  const w = work(p, 1);
  assert.equal(new Set(w.map(s => s.set_n)).size, 3);
  assert.deepEqual(w.find(s => s.set_n === 3).target.load, null);
  assert.deepEqual(w.find(s => s.set_n === 3).target.rep_low, null);
  assert.deepEqual([w.find(s => s.set_n === 1).target.load, w.find(s => s.set_n === 1).target.rep_low], [105, 10], 'the done sets still move on (a skipped set never counts)');
  assert.equal(p.notes[0].row, 'R11');
  assert.equal(round(sig(3, 2, 2), 4).sets, 3, 'four planned gives three (T25)');
  assert.equal(round(sig(3, 2, 2), 5).sets, 4, 'five planned gives four: one step down a round');
});
test('T39 R8, missed true, planned 1: 1', () => {
  const r = round(sig(2, 1, 2), 1, { missed: true });
  assert.equal(r.sets, 1); assert.equal(r.gate, 'missed');
  assert.equal(round(sig(2, 1, 2), 1, { missed: false }).sets, 2);
});
test('T40 R2, missed true, planned 2: 1', () => {
  assert.equal(round(sig(2, 2, 4), 2, { missed: true }).sets, 1);
});
test('T41 planned 1, hand add rest, R8, missed true: 1, hand set does not carry', () => {
  const r = round(sig(2, 1, 2), 1, { hand_add: 'rest', missed: true });
  assert.equal(r.sets, 1); assert.equal(r.hand_add_carried, false);
});
test('T42 planned 100 x 10, two misses in a row at 100 lb, step 5: 95 x 10, no add', () => {
  const ex = { equipment: 'machine', weight_steps: null, step_default: 5 };
  const lift = { exercise: ex, unit: 'lb', template: { start_load: 100, rep_low: 10, rep_high: 12 } };
  const first = nextLoadTarget(A, lift, { sets: [{ set_n: 1, status: 'done', target: { load: 100, rep_low: 10, rep_high: 12 }, done: { load: 100, reps: 8 } }], prev_missed: false });
  assert.deepEqual(first.targets[1], { load: 100, rep_low: 9, rep_high: 12 });
  const second = nextLoadTarget(A, lift, { sets: [{ set_n: 1, status: 'done', target: first.targets[1], done: { load: 100, reps: 8 } }], prev_missed: true, goal_before_miss: { 1: 10 } });
  assert.deepEqual(second.targets[1], { load: 95, rep_low: 10, rep_high: 12 });
  assert.equal(second.why, 'why.step_down');
  assert.equal(round(sig(1, 1, 1), 1, { missed: true }).sets, 1, 'no add that round');
  // and through planDay: rounds 1 and 2 both miss
  const b = block([L(1, 'ex_m1', 1, 100, { rep_low: 10 })], [L(1, 'ex_m2', 1, 100)], { passes: 6 });
  const h = H();
  const low = { fb: () => ({ pump: 1, soreness: 1, workload: 1, checks: {} }) };
  play(h, planDay(A, b, h, { pass: 1, day: 1 }), { ...low, reps: () => 8 }); play(h, planDay(A, b, h, { pass: 1, day: 2 }), low);
  play(h, planDay(A, b, h, { pass: 2, day: 1 }), { ...low, reps: () => 8 }); play(h, planDay(A, b, h, { pass: 2, day: 2 }), low);
  const p = planDay(A, b, h, { pass: 3, day: 1 });
  assert.deepEqual(work(p, 1).map(s => [s.target.load, s.target.rep_low]), [[95, 10]]);
  assert.equal(p.notes[0].gate, 'missed');
});
test('T43 marked machine failure set, short sleep card true: reps-left goal 2', () => {
  const b = block([L(1, 'ex_m1', 2, 100, { failure_set: true, reps_left_target: 0 })], [L(1, 'ex_m2', 1, 100)]);
  const h = H();
  for (const pass of [1, 2]) for (const day of [1, 2]) play(h, planDay(A, b, h, { pass, day }));
  const plain = planDay(A, b, h, { pass: 3, day: 1 });
  h.days.push({ ...plain.day, short_sleep_since_last: true });
  const p = planDay(A, b, h, { pass: 3, day: 1 });
  assert.deepEqual(lastWork(p, 1).map(s => s.target.reps_left_target), [2]);
  // Fixed too: the marked set stops 2 short on a short-sleep day, every other set as written
  const hf = H();
  hf.days.push({ ...planDay(F, b, hf, { pass: 1, day: 1 }).day, short_sleep_since_last: true });
  const pf = planDay(F, b, hf, { pass: 1, day: 1 });
  assert.deepEqual(work(pf, 1).map(s => s.target.reps_left_target), [0, 2]);
});
test('T44 failure set done 7 of 10, R8: no miss, add allowed', () => {
  const ex = { equipment: 'machine', weight_steps: null, step_default: 5 };
  const last = { sets: [{ set_n: 1, status: 'done', target: { load: 100, rep_low: 10, rep_high: 12 }, done: { load: 100, reps: 10 } },
    { set_n: 2, status: 'done', failure: true, target: { load: 100, rep_low: 10, rep_high: 12 }, done: { load: 100, reps: 7 } }] };
  const r = nextLoadTarget(A, { exercise: ex, unit: 'lb', template: { rep_low: 10, rep_high: 12 } }, last);
  assert.equal(r.missed, false);
  assert.equal(r.targets[1].load, 105);
  assert.equal(r.targets[2].load, 105, 'the marked set follows the load');
  assert.equal(round(sig(2, 1, 2), 2, { missed: r.missed }).sets, 3);
});

// ---------------- r4.1 cases (DESIGN 16 B.1 step 0 list) ----------------

test('score gate: a rest hand add at top answers with score 7 gives 1 set, gate score (review R4)', () => {
  const r = round(sig(1, 1, 1, 'top', { score_max: 7 }), 1, { hand_add: 'rest', score_max: 7 });
  assert.equal(r.row, 'R6');
  assert.deepEqual([r.sets, r.gate, r.why, r.hand_add_carried], [1, 'score', 'why.score', false]);
  for (const score of [5, 10]) assert.equal(nextWeekSets(A, 1, 0, { ...OK, hand_add: 'rest', score_max: score }).gate, 'score');
  for (const score of [null, 0, 4]) assert.equal(nextWeekSets(A, 1, 0, { ...OK, hand_add: 'rest', score_max: score }).sets, 2, 'score ' + score + ' leaves the gate open');
  assert.equal(nextWeekSets(F, 1, 1, { ...OK, score_max: 9 }).gate, null, 'Fixed has no score row, so the gate never shuts there');
  assert.equal(nextWeekSets(A, 1, 1, { ...OK, check_yes: true, score_max: 9, missed: true }).gate, 'check', 'gate order: check before score');
  assert.equal(nextWeekSets(A, 1, 1, { ...OK, score_max: 9, missed: true }).gate, 'score', 'gate order: score before missed');
});

test('above the top: one step down a round (review R9, health-coach verdict item C12)', () => {
  assert.deepEqual([round(sig(1, 4, 1), 6).sets, round(sig(3, 2, 2), 6).sets], [5, 5], 'planned 6 with row R1 gives 5; with row R11 gives 5');
  assert.equal(round(sig(3, 2, 2), 6).why, 'why.top');
  assert.equal(round(sig(1, 1, 1), 6).sets, 5, 'an add row above the top still steps down');
  assert.deepEqual([round(sig(3, 2, 2), 4).sets, round(sig(3, 2, 2), 5).sets], [3, 4]);
  let n = 6;
  const seen = [];
  for (let i = 0; i < 4; i++) { n = round(sig(3, 2, 2), n).sets; seen.push(n); }
  assert.deepEqual(seen, [5, 4, 3, 3]);
});

test('assist rows never change the assist number (health-coach verdict item C11)', () => {
  const ex = { equipment: 'machine', load_kind: 'assist', weight_steps: [40, 50, 60, 70], step_default: 5 };
  assert.equal(stepForAny(ex), null, 'no step in any read order');
  const met = (load, reps) => ({ sets: [{ set_n: 1, status: 'done', target: { load, rep_low: reps, rep_high: reps }, done: { load, reps } }] });
  const lift = { exercise: ex, unit: 'lb', template: { start_load: 60, rep_low: 10, rep_high: 10 }, flags: { weight_steps: [50, 60, 70], step: 5 } };
  assert.deepEqual(nextLoadTarget(A, lift, met(60, 10)).targets[1], { load: 60, rep_low: 11, rep_high: 11 }, 'met at 60 x 10 gives 60 x 11');
  assert.deepEqual(nextLoadTarget(A, lift, met(60, 30)).targets[1], { load: 60, rep_low: 30, rep_high: 30, effort_only: true }, 'at 30 reps: 60 x 30 with the effort goal');
  const miss = { set_n: 1, status: 'done', target: { load: 60, rep_low: 10, rep_high: 12 }, done: { load: 60, reps: 7 } };
  const two = nextLoadTarget(A, lift, { sets: [miss], prev_missed: true, goal_before_miss: { 1: 10 } });
  assert.equal(two.why, 'why.step_down');
  assert.equal(two.targets[1].load, 60, 'two misses keep the assist');
  const easy = easyWeekPlan(A, { slots: [{ slot: 1, muscle: 'mk_a', step: null, assist: true, sets: 3, targets: { 1: { load: 60, rep_low: 10, rep_high: 12 }, 2: { load: 60, rep_low: 10, rep_high: 12 } } }] });
  assert.deepEqual(easy.slots[0].targets[1], { load: 60, rep_low: 7, rep_high: 8 }, 'the easy round keeps 60, only the rep goal is lighter');
  assert.deepEqual(retargetOnLoad(A, { load: 60, rep_low: 10, rep_high: 12, step: null, unit: 'lb', load_kind: 'assist' }, 70), { rep_low: 10 }, 'a typed 70 shows the planned goal');
});
function stepForAny(ex) {
  // every read order: block list, block size, row list, row size, table default
  const all = [{ weight_steps: [1, 2] }, { step: 5 }, null];
  const r = all.map(f => nextLoadTarget(A, { exercise: ex, unit: 'lb', template: {}, flags: f },
    { sets: [{ set_n: 1, status: 'done', target: { load: 60, rep_low: 10, rep_high: 10 }, done: { load: 60, reps: 10 } }] }).targets[1].load);
  return r.every(x => x === 60) ? null : r;
}

test('the block step size is read right after the block list (r4.1 Q18)', () => {
  const met = { sets: [{ set_n: 1, status: 'done', target: { load: 100, rep_low: 10, rep_high: 10 }, done: { load: 100, reps: 10 } }] };
  const ex = { equipment: 'machine', weight_steps: [100, 110], step_default: 5 };
  assert.equal(nextLoadTarget(A, { exercise: ex, unit: 'lb', template: {}, flags: { step: 2.5 } }, met).targets[1].load, 102.5, 'the block size beats the row list');
  assert.equal(nextLoadTarget(A, { exercise: ex, unit: 'lb', template: {}, flags: { weight_steps: [100, 120], step: 2.5 } }, met).targets[1].load, 120, 'the block list beats the block size');
  assert.equal(nextLoadTarget(A, { exercise: { ...ex, weight_steps: null }, unit: 'kg', template: {}, flags: { step: 2 } }, met).targets[1].load, 102, 'a block size works in a kg block');
  assert.equal(nextLoadTarget(A, { exercise: ex, unit: 'lb', template: {}, flags: { step: 0 } }, met).targets[1].load, 110, 'a size of 0 is no step');
});

// ---------------- signed effort tests 1 to 6 and the load table rows ----------------

test('effort 1 to 4: falling table, open ended gives the lift own goal', () => {
  assert.equal(effortTarget(A, 3, 4), 1);
  assert.equal(effortTarget(A, 4, 4), 8);
  assert.equal(effortTarget(A, 1, 6), 3);
  assert.equal(effortTarget(A, 2, null, { reps_left_target: 2 }), 2);
  assert.equal(effortTarget(F, 3, 4, { reps_left_target: 1 }), 1, 'Fixed always gives the lift own goal');
  assert.equal(effortTarget(A, 5, 4), null, 'past the block: never planned');
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(p => effortTarget(A, p, 8)), [3, 2, 2, 2, 1, 1, 1, 8]);
});
test('effort 6: resizeBlock 4 to 5 spreads to 3, 2, 1, 1, 8; 8 to 9 refused', () => {
  const b = { id: 'bt', passes: 4 };
  const r = resizeBlock(A, b, 1, []);
  assert.equal(r.ok, true);
  assert.deepEqual([1, 2, 3, 4, 5].map(p => effortTarget(A, p, r.block.passes)), [3, 2, 1, 1, 8]);
  assert.equal(resizeBlock(A, { id: 'bt', passes: 8 }, 1, []).ok, false);
});
test('load rows: default step, no step, rep ceiling', () => {
  const met = (load, reps) => ({ sets: [{ set_n: 1, status: 'done', target: { load, rep_low: reps, rep_high: reps }, done: { load, reps } }] });
  assert.equal(nextLoadTarget(A, { exercise: { equipment: 'barbell', weight_steps: null, step_default: 0 }, unit: 'lb', template: {} }, met(135, 10)).targets[1].load, 140);
  assert.deepEqual(nextLoadTarget(A, { exercise: { equipment: 'other', weight_steps: null, step_default: 0 }, unit: 'lb', template: {} }, met(100, 10)).targets[1], { load: 100, rep_low: 11, rep_high: 11 });
  assert.deepEqual(nextLoadTarget(A, { exercise: { equipment: 'machine', weight_steps: null, step_default: 5 }, unit: 'kg', template: {} }, met(60, 30)).targets[1],
    { load: 60, rep_low: 30, rep_high: 30, effort_only: true });
  // the exercise's own list of loads is read first
  assert.equal(nextLoadTarget(A, { exercise: { equipment: 'machine', weight_steps: [90, 105, 120], step_default: 5 }, unit: 'lb', template: {} }, met(90, 10)).targets[1].load, 105);
  assert.equal(nextLoadTarget(A, { exercise: { equipment: 'machine', weight_steps: [90, 105], step_default: 5 }, unit: 'lb', template: {}, flags: { weight_steps: [90, 95] } }, met(90, 10)).targets[1].load, 95);
});

// ---------------- the 64 mix proof ----------------

const ROW_IDS = A.set_rules.rows.map(r => r.id);
function grid(level, score_max) {
  const counts = {}; let cuts = 0;
  for (const pump of [1, 2, 3, 4]) for (const soreness of [1, 2, 3, 4]) for (const workload of [1, 2, 3, 4]) {
    const s = { pump, soreness, workload, level, score_max, check_yes: null, missed: false };
    const hits = A.set_rules.rows.filter(r => Object.keys(r.when).every(k => s[k] !== null && s[k] !== undefined && r.when[k].includes(s[k])));
    assert.ok(hits.length >= 1, 'a mix lands on no row');
    const d = setDelta(A, s);
    assert.equal(d.row, hits[0].id, 'first match wins');
    counts[d.row] = (counts[d.row] || 0) + 1;
    if (d.delta < 0) cuts++;
  }
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 64);
  return { counts, cuts };
}
test('64 mix proof: every mix lands on exactly one row, counts equal the signed table', () => {
  const base = { R1: 16, R2: 12, R3: 12, R4: 6, R5: 6 };
  for (const score of [null, 0, 4]) {
    assert.deepEqual(grid('top', score).counts, { ...base, R8: 8, R9: 2, R11: 2 });
    assert.deepEqual(grid('middle', score).counts, { ...base, R10: 4, R11: 8 });
    assert.deepEqual(grid('bottom', score).counts, { ...base, R7: 12 });
    assert.deepEqual(grid(null, score).counts, { ...base, R11: 12 });
  }
  for (const level of ['top', 'middle', 'bottom', null]) for (const score of [5, 6, 7, 8, 9, 10]) {
    assert.deepEqual(grid(level, score).counts, { ...base, R6: 12 });
  }
  for (const level of ['top', 'middle', 'bottom', null]) for (const score of [null, 4, 5, 10]) assert.equal(grid(level, score).cuts, 28);
  assert.ok(ROW_IDS.length === 11);
});
test('64 mix proof: the five evidence mixes go the signed way', () => {
  assert.equal(setDelta(A, sig(1, 1, 1)).delta, 1, 'all low adds');
  assert.equal(setDelta(A, sig(4, 4, 4)).delta, -1, 'all high cuts 1');
  assert.equal(setDelta(A, sig(3, 3, 2)).delta, 0, 'middle holds');
  assert.equal(setDelta(A, sig(1, 4, 2)).delta, -1, 'mix A cuts 1');
  assert.equal(setDelta(A, sig(4, 1, 2)).delta, 0, 'mix B holds');
});

// ---------------- the 125 mix sweep ----------------

const VALS = [null, 1, 2, 3, 4];
test('125 mix sweep: one row each; any blank answer never adds', () => {
  let n = 0;
  for (const level of ['top', 'middle', 'bottom', null]) for (const pump of VALS) for (const soreness of VALS) for (const workload of VALS) {
    const d = setDelta(A, { pump, soreness, workload, level, score_max: null, check_yes: null, missed: false });
    assert.ok(ROW_IDS.includes(d.row));
    if (pump === null || soreness === null || workload === null) assert.ok(d.delta <= 0, 'a blank answer added a set');
    n++;
  }
  assert.equal(n, 500);
});

// ---------------- property sweeps ----------------

// The add band, written from the signed table text, apart from the rows.
function inAddBand(p, s, w, level) {
  if (level === 'top') return (p <= 2 && s <= 2 && w <= 2) || (p === 3 && s <= 2 && w === 1);
  if (level === 'middle') return p <= 2 && s <= 2 && w === 1;
  return false;
}
const SCORES = [null, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const SLEEPS = [[false, false, false], [false, true, false], [false, null, false]];
const inBand = (score) => score !== null && score >= 5;
test('property sweep: no cap is ever broken, planned 1 to 6 (648,000 cases)', () => {
  let n = 0;
  for (const pump of VALS) for (const soreness of VALS) for (const workload of VALS) for (const score_max of SCORES) {
    for (const check_yes of [true, false, null]) for (const missed of [true, false]) for (const level of ['top', 'middle', 'bottom', null]) {
      const d = setDelta(A, { pump, soreness, workload, score_max, check_yes, missed, level });
      assert.ok(d.row !== null && [-1, 0, 1].includes(d.delta));
      for (const sleep of SLEEPS) for (const planned of [1, 2, 3, 4, 5, 6]) {
        const r = nextWeekSets(A, planned, d.delta, { sleep, check_yes, score_max, missed, no_added_sets: false, flags_set: true, hand_add: 'none' });
        n++;
        const where = () => JSON.stringify({ pump, soreness, workload, score_max, check_yes, missed, level, sleep, planned, sets: r.sets });
        if (Math.abs(r.sets - planned) > 1) assert.fail('moved more than 1 from planned: ' + where());
        if (planned <= 4 && (r.sets < 1 || r.sets > 3)) assert.fail('count out of 1 to 3: ' + where());
        if (planned >= 5 && r.sets !== planned - 1) assert.fail('above the top must step down one: ' + where());
        const present = pump !== null && soreness !== null && workload !== null;
        const may = present && inAddBand(pump, soreness, workload, level) && !inBand(score_max) && missed === false &&
          check_yes !== true && sleep.every(v => v === false) && planned < 3;
        if ((r.sets > planned) !== may) assert.fail('add rule broken: ' + where());
      }
    }
  }
  assert.equal(n, 648000);
  console.log('# property sweep cases: ' + n);
});
test('property sweep: hand adds and flags never break a cap', () => {
  let n = 0;
  const FLAGS = [{ no_added_sets: false, flags_set: true }, { no_added_sets: true, flags_set: true }, { no_added_sets: false, flags_set: false }];
  for (const pump of VALS) for (const soreness of VALS) for (const workload of VALS) for (const score_max of SCORES) {
    for (const check_yes of [true, false, null]) for (const missed of [true, false]) for (const level of ['top', 'middle', 'bottom', null]) {
      const d = setDelta(A, { pump, soreness, workload, score_max, check_yes, missed, level });
      for (const sleep of SLEEPS) for (const fl of FLAGS) for (const planned of [1, 2, 3]) {
        const ctx = { sleep, check_yes, score_max, missed, ...fl };
        const none = nextWeekSets(A, planned, d.delta, { ...ctx, hand_add: 'none' });
        const today = nextWeekSets(A, planned, d.delta, { ...ctx, hand_add: 'today' });
        const rest = nextWeekSets(A, planned, d.delta, { ...ctx, hand_add: 'rest' });
        n += 3;
        const flagShut = fl.no_added_sets || !fl.flags_set;
        const shut = flagShut || !sleep.every(v => v === false) || check_yes === true || inBand(score_max) || missed === true;
        const where = () => JSON.stringify({ pump, soreness, workload, score_max, check_yes, missed, level, sleep, fl, planned, delta: d.delta, none: none.sets, today: today.sets, rest: rest.sets });
        if (rest.sets > 3 || rest.sets - planned > 1) assert.fail('a sum or past the top: ' + where());
        if (today.sets !== none.sets) assert.fail('a today add raised the count: ' + where());
        if (shut && (rest.sets > planned || rest.hand_add_carried)) assert.fail('a shut gate let the hand set carry: ' + where());
        if (flagShut && (none.sets > planned || rest.sets > planned)) assert.fail('a flagged lift gained a set: ' + where());
        if (inBand(score_max) && rest.sets > none.sets) assert.fail('a hand add raised the count at score 5 to 10: ' + where());
        if (d.delta < 0 && (rest.sets !== none.sets || rest.sets > Math.max(1, planned - 1) || rest.hand_add_carried)) assert.fail('a hand add beat a cut row: ' + where());
        if (!shut && d.delta >= 0 && rest.sets !== Math.min(3, planned + 1)) assert.fail('an open hand add did not carry: ' + where());
      }
    }
  }
  assert.equal(n, 2916000);
  console.log('# hand add sweep cases: ' + n);
});
test('the Fixed profile never changes a set', () => {
  for (const pump of VALS) for (const soreness of VALS) for (const workload of VALS) for (const score_max of SCORES) for (const level of ['top', 'middle', 'bottom', null]) {
    assert.equal(setDelta(F, { pump, soreness, workload, score_max, level, check_yes: null, missed: false }).delta, 0);
  }
  const b = block([L(1, 'ex_m1', 4, 100), L(2, 'ex_m2', 1, 50)], [L(1, 'ex_m3', 2, 80)]);
  const h = H();
  for (const pass of [1, 2, 3, 4]) for (const day of [1, 2]) {
    const p = planDay(F, b, h, { pass, day });
    const tpl = b.day_templates[day - 1];
    for (const lift of tpl.lifts) {
      const w = work(p, lift.slot);
      assert.equal(new Set(w.map(s => s.set_n)).size, lift.sets, 'Fixed changed a set count');
      assert.ok(w.every(s => s.target.load === lift.start_load && s.target.rep_low === lift.rep_low && s.target.reps_left_target === lift.reps_left_target));
    }
    play(h, p, { reps: () => 6, fb: () => ({ pump: 1, soreness: 1, workload: 1, checks: {} }) });
  }
});
