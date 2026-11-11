// today.test.js - the pure helpers of the screens, run in node with no page (DESIGN 15 P.3, review R36).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeLift, buildDays, hasDraft, stepStart, cancelBuild, pickerGroups } from '../../../ui/builder.js';
import { MUSCLES } from '../../../backup.js';

const lift = (ex) => ({ exercise_id: ex, sets: 3, rep_low: 8, rep_high: 12, start_load: null, failure_set: false, note: '' });

test('builder remove takes the lift out of the build, and slots follow the order left', () => {
  const b = { step: 3, name: '', notes: '', passes: '', days: [{ label: 'A', lifts: [lift('leg_press'), lift('lat_pulldown'), lift('leg_extension')] }] };
  removeLift(b.days[0], 1);
  const days = buildDays(b);
  assert.deepEqual(days[0].lifts.map(l => [l.slot, l.exercise_id]), [[1, 'leg_press'], [2, 'leg_extension']]);
  removeLift(b.days[0], 5);
  assert.equal(b.days[0].lifts.length, 2, 'a stray index removes nothing');
});

test('a draft counts once a field is typed or an exercise is picked', () => {
  const fresh = { step: 1, name: '', notes: '', passes: '', days: [{ label: 'A', lifts: [] }] };
  assert.equal(hasDraft(null), false);
  assert.equal(hasDraft(fresh), false, 'an empty draft opens the builder with no ask');
  assert.equal(hasDraft({ ...fresh, name: '  ' }), false, 'spaces are not a typed name');
  assert.equal(hasDraft({ ...fresh, name: 'Mine' }), true);
  assert.equal(hasDraft({ ...fresh, passes: 4 }), true);
  assert.equal(hasDraft({ ...fresh, days: [{ label: 'A', lifts: [lift('leg_press')] }] }), true);
});

test('a day with no label shows the numbered name; the menu offers Relabel only on a planned or open day', async () => {
  const { dayTitle, dayMenuRows } = await import('../../../ui/today.js');
  assert.equal(dayTitle({ label: 'A', day: 2 }), 'A');
  assert.equal(dayTitle({ label: '', day: 2 }), 'Day 2');
  assert.ok(dayMenuRows({ status: 'planned' }).includes('relabel'));
  assert.ok(dayMenuRows({ status: 'open' }).includes('relabel'));
  const doneSet = [{ status: 'done' }];
  assert.deepEqual(dayMenuRows({ status: 'open' }, doneSet), ['relabel', 'reset'], 'Reset day on an open day only (Part 12)');
  assert.ok(!dayMenuRows({ status: 'planned' }).includes('reset'));
  assert.deepEqual(dayMenuRows({ status: 'done' }), []);
  assert.deepEqual(dayMenuRows({ status: 'skipped' }), []);
});

const work = (target) => ({ kind: 'work', target: { load: null, rep_low: 8, rep_high: 12, load_basis: 'total', count_label: null, reps_left_target: null, ...target } });

test('helper line with no load: the range line plus the effort part (Part 5)', async () => {
  const { helperLine } = await import('../../../ui/today.js');
  assert.equal(helperLine(work({ reps_left_target: 2 })), 'no weight yet, 8-12 reps, stop 2 short');
  assert.equal(helperLine(work({ rep_low: null, rep_high: null, reps_left_target: 0 })), 'no weight yet, to failure');
  assert.equal(helperLine({ ...work({ reps_left_target: 2, rep_low: 5, rep_high: 5 }), kind: 'warmup' }), 'no weight yet, 5-5 reps', 'a warm-up gets no effort part');
});

test('helper line with an open top (Part 5, R38)', async () => {
  const { helperLine } = await import('../../../ui/today.js');
  assert.equal(helperLine(work({ rep_high: null })), 'no weight yet, 8 or more reps');
  assert.equal(helperLine(work({ load: 100, rep_high: null, reps_left_target: 1 })), 'goal 100 x 8 or more, stop 1 short');
  assert.equal(helperLine(work({ load: 100 })), 'goal 100 x 8-12', 'a load with a range keeps the built goal line');
});

test('helper line reads the target, never a draft (Part 5)', async () => {
  const { helperLine } = await import('../../../ui/today.js');
  const s = { ...work({}), draft: { load: 105, reps: 9, reps_left: null, reps_left_plus: false, failure: false, from_copy: true } };
  assert.equal(helperLine(s), 'no weight yet, 8-12 reps');
});

test('rep range ask: below and above a range ask, inside does not, a warm-up never asks (Part 8)', async () => {
  const { rangeAsk } = await import('../../../ui/today.js');
  const s = work({ load: 100 });
  assert.deepEqual(rangeAsk(s, 5), { key: 'range.line', vals: { reps: 5, low: 8, high: 12 } });
  assert.deepEqual(rangeAsk(s, 16), { key: 'range.line', vals: { reps: 16, low: 8, high: 12 } });
  assert.equal(rangeAsk(s, 8), null);
  assert.equal(rangeAsk(s, 12), null);
  assert.equal(rangeAsk({ ...s, kind: 'warmup' }, 3), null, 'a warm-up with 3 reps never asks');
  assert.equal(rangeAsk(s, null), null, 'reps null never asks');
  assert.equal(rangeAsk(work({ rep_low: null, rep_high: null }), 3), null, 'no range, no ask');
});

test('rep range ask with an open top asks only below (Part 8, R38)', async () => {
  const { rangeAsk } = await import('../../../ui/today.js');
  const s = work({ load: 100, rep_high: null });
  assert.equal(rangeAsk(s, 20), null);
  assert.deepEqual(rangeAsk(s, 5), { key: 'range.line.open', vals: { reps: 5, low: 8 } });
});

test('break chips only on a laps work set: never a reps lift, never a warm-up (Part 16, R42)', async () => {
  const { breaksShown } = await import('../../../ui/today.js');
  const laps = { ...work({ count_label: 'laps' }) };
  assert.equal(breaksShown(laps, { count_label: 'reps' }), true, 'the set count word wins');
  assert.equal(breaksShown(work({}), { count_label: 'laps' }), true, 'else the exercise count word');
  assert.equal(breaksShown(work({}), { count_label: 'reps' }), false, 'a reps lift shows no chips');
  assert.equal(breaksShown(work({ count_label: 'seconds' }), { count_label: 'laps' }), false);
  assert.equal(breaksShown({ ...laps, kind: 'warmup' }, { count_label: 'laps' }), false, 'a warm-up on a laps lift shows no chips');
});

test('the day menu offers Skip day on a planned or open day with no done set (Part 15)', async () => {
  const { dayMenuRows } = await import('../../../ui/today.js');
  const planned = [{ status: 'planned' }, { status: 'skipped' }];
  assert.deepEqual(dayMenuRows({ status: 'planned' }, planned), ['relabel', 'skip']);
  assert.deepEqual(dayMenuRows({ status: 'open' }, planned), ['relabel', 'reset', 'skip'], 'Skip day is the last row, after the hairline');
  assert.ok(!dayMenuRows({ status: 'open' }, [...planned, { status: 'done' }]).includes('skip'), 'left out once a set is done');
  assert.deepEqual(dayMenuRows({ status: 'skipped' }, planned), [], 'never on a skipped day');
});

test('checksFor keeps a check to its lifts', async () => {
  const { checksFor } = await import('../../../store.js');
  const block = { checks: [{ key: 'all', lifts: null }, { key: 'x_only', lifts: ['x'] }, { key: 'old' }] };
  assert.deepEqual(checksFor(block, 'x').map(c => c.key), ['all', 'x_only', 'old']);
  assert.deepEqual(checksFor(block, 'y').map(c => c.key), ['all', 'old'], 'a check with a lifts list is not asked on another exercise');
  assert.deepEqual(checksFor({ checks: [] }, 'x'), []);
  assert.deepEqual(checksFor(null, 'x'), []);
});

test('a row the card inset made is still owed its questions; one he put off is not (Part 17)', async () => {
  const { checksOnlyRow } = await import('../../../ui/today.js');
  const f = { id: 'd:x1', pending: true, pump: null, soreness: null, workload: null, note: '', checks: { a: false } };
  assert.equal(checksOnlyRow(f), true);
  assert.equal(checksOnlyRow(f, new Set(['d:x1'])), false, 'Ask me later waits for Finish day');
  assert.equal(checksOnlyRow({ ...f, checks: {} }), false, 'an Ask me later row holds no answer');
  assert.equal(checksOnlyRow({ ...f, pending: false }), false);
  assert.equal(checksOnlyRow({ ...f, pump: 2 }), false);
  assert.equal(checksOnlyRow(undefined), false);
});

test('goal_line only without a rep range', async () => {
  const { helperLine } = await import('../../../ui/today.js');
  const lift = { goal_line: 'Made-up goal words', short_note: '' };
  assert.equal(helperLine(work({ load: 50, rep_low: null, rep_high: null, reps_left_target: 2 }), lift), 'Made-up goal words, stop 2 short', 'the goal part, then the effort part');
  assert.equal(helperLine(work({ load: null, rep_low: null, rep_high: null }), lift), 'Made-up goal words');
  assert.equal(helperLine(work({ load: 100 }), lift), 'goal 100 x 8-12', 'a lift with a range ignores goal_line');
  assert.equal(helperLine(work({ load: 50, rep_low: null, rep_high: null }), { goal_line: '' }), '', 'no goal line, as built');
});

test('the stepper step order: block list, block step, row list, row step_default in lb only, then 5 lb or 1 kg (Part 18)', async () => {
  const { loadStep, stepLoad } = await import('../../../ui/today.js');
  const { effectiveExercise } = await import('../../../store.js');
  const row = { id: 'r', equipment: 'machine', weight_steps: [100, 110, 120], step_default: 5, machine: true, flags_set: false };
  const blk = (f) => ({ exercise_flags: { r: { no_added_sets: false, left_out_of_builder: false, ...f } } });
  const both = effectiveExercise(blk({ weight_steps: [170, 185, 200], step: 10 }), row);
  assert.deepEqual(loadStep(both, 'lb'), { list: [170, 185, 200] }, 'the block list beats the block step');
  assert.equal(stepLoad(both, 185, 1, 'lb'), 200);
  assert.equal(stepLoad(both, 185, -1, 'lb'), 170);
  const st = effectiveExercise(blk({ step: 15 }), row);
  assert.deepEqual(loadStep(st, 'lb'), { size: 15 }, 'the block step beats the row list');
  assert.equal(stepLoad(st, 185, 1, 'lb'), 200);
  assert.deepEqual(loadStep(st, 'kg'), { size: 15 }, 'the block step is read in a kg block too');
  assert.deepEqual(loadStep(row, 'lb'), { list: [100, 110, 120] }, 'no block entry: the row list');
  const noList = { ...row, weight_steps: null };
  assert.deepEqual(loadStep(noList, 'lb'), { size: 5 }, 'the row step_default in an lb block');
  assert.deepEqual(loadStep({ ...noList, step_default: 2.5 }, 'kg'), { size: 1 }, 'step_default is a pound step, passed over in a kg block');
  assert.deepEqual(loadStep({ ...noList, step_default: 0, equipment: 'barbell' }, 'lb'), { size: 5 }, 'lb barbell: 5, the same as the signed default');
  assert.deepEqual(loadStep({ ...noList, step_default: 0, equipment: 'bodyweight' }, 'lb'), { size: 5 }, 'no step anywhere: 5 lb');
  assert.deepEqual(loadStep(null, 'kg'), { size: 1 }, 'no step anywhere: 1 kg');
  assert.equal(effectiveExercise(blk({}), row).flags_set, true, 'a block entry screens the lift');
});

test('day progress counts every set row, done or skipped, and never a row still saving (Part 13)', async () => {
  const { dayProgress } = await import('../../../ui/today.js');
  const sets = [{ id: 'a', status: 'done' }, { id: 'b', status: 'skipped' }, { id: 'c', status: 'planned' }, { id: 'd', status: 'done' }];
  assert.deepEqual(dayProgress(sets, new Map()), { done: 3, total: 4 });
  assert.deepEqual(dayProgress(sets, new Map([['d', 'saving']])), { done: 2, total: 4 }, 'a write not yet committed never moves the line');
  assert.deepEqual(dayProgress(sets.slice(2, 3), new Map()), { done: 0, total: 1 });
  assert.deepEqual(dayProgress([], new Map()), { done: 0, total: 0 }, 'a day with no sets: hidden');
});

test('builder start weight steps in the unit of the build: kg plus on a step_default 5 row gives 1 (G8, P3, P16)', () => {
  const ex = { step_default: 5, weight_steps: null };
  assert.equal(stepStart({ unit: 'kg' }, ex, null, 1), 1, 'a kg build steps 1 kg');
  assert.equal(stepStart({ unit: 'kg' }, ex, 1, -1), 0);
  assert.equal(stepStart({ unit: 'lb' }, ex, null, 1), 5, 'an lb build takes the row step');
  assert.equal(stepStart({ unit: null }, ex, null, 1), 5, 'not read yet steps as lb, the default unit');
  assert.equal(stepStart({ unit: 'kg' }, { weight_steps: [10, 20] }, null, 1), 10, 'his own steps win in any unit');
});

test('the card menu order of record: Notes, then Checks, then Video link (G16, review P18)', async () => {
  const { CARD_MENU_ORDER } = await import('../../../ui/today.js');
  assert.deepEqual(CARD_MENU_ORDER, [0, 1, 2, 3, 'up', 'down', 4, 'checks', 5]);
  const { t } = await import('../../../ui/strings.js');
  assert.equal(t('menu')[4], 'Notes', 'code index 4 is menu[5] Notes');
  assert.equal(t('menu')[5], 'Video link', 'code index 5 is menu[6] Video link');
});

test('numSplit gives the range line with each number on its own, and joins back to t() (G18 a, review P21 a)', async () => {
  const { numSplit, t } = await import('../../../ui/strings.js');
  const vals = { reps: 5, low: 8, high: 12 };
  const parts = numSplit('range.line', vals);
  assert.deepEqual(parts.filter(p => p.num !== undefined).map(p => p.num), ['5', '8', '12']);
  assert.equal(parts.map(p => (p.num !== undefined ? p.num : p.text)).join(''), t('range.line', vals));
  const open = numSplit('range.line.open', { reps: 3, low: 8 });
  assert.deepEqual(open.filter(p => p.num !== undefined).map(p => p.num), ['3', '8']);
  assert.equal(open.map(p => (p.num !== undefined ? p.num : p.text)).join(''), t('range.line.open', { reps: 3, low: 8 }));
  assert.throws(() => numSplit('no.such.key', {}), 'a missing key throws, as t() does');
});

test('Cancel on the builder keeps a typed draft and drops an empty one (G4, review P13)', () => {
  const went = [];
  const typed = { step: 2, name: 'Kept draft', notes: '', passes: '', days: [{ label: 'A', lifts: [] }] };
  const ctx = { build: typed, go: (r) => went.push(r) };
  cancelBuild(ctx);
  assert.equal(ctx.build, typed, 'a typed draft stays in memory, at its step');
  assert.equal(ctx.build.step, 2);
  const empty = { step: 1, name: '', notes: '', passes: '', days: [{ label: 'A', lifts: [] }] };
  const ctx2 = { build: empty, go: (r) => went.push(r) };
  cancelBuild(ctx2);
  assert.equal(ctx2.build, null, 'an empty draft is dropped');
  const ctx3 = { build: { ...empty, days: [{ label: 'A', lifts: [lift('leg_press')] }] }, go: (r) => went.push(r) };
  cancelBuild(ctx3);
  assert.notEqual(ctx3.build, null, 'a picked exercise is a draft too');
  assert.deepEqual(went, ['#/today', '#/today', '#/today'], 'Cancel always goes to Today');
});

test('the card menu Checks row shows only while the exercise still has a planned set (G10, review P5, P17)', async () => {
  const { cardMenuKeep } = await import('../../../ui/today.js');
  const block = { checks: [{ id: 'check_a', lifts: ['leg_press'] }] };
  const ex = { id: 'leg_press' };
  const row = (slot, status) => ({ slot, status, exercise_id: slot === 1 ? 'leg_press' : 'lat_pulldown' });
  const view = (statuses) => ({ day: { status: 'open' }, block, slots: [1, 2], sets: [...statuses.map(st => row(1, st)), row(2, 'planned')] });
  assert.equal(cardMenuKeep(view(['done', 'planned']), 1, ex, 'checks'), true, 'mid exercise the row shows');
  assert.equal(cardMenuKeep(view(['done', 'done']), 1, ex, 'checks'), false, 'after the last set is done the row is left out');
  assert.equal(cardMenuKeep(view(['done', 'skipped']), 1, ex, 'checks'), false, 'after the last set is skipped the row is left out');
  assert.equal(cardMenuKeep(view(['planned', 'planned']), 2, { id: 'lat_pulldown' }, 'checks'), false, 'no check on this exercise, no row');
  assert.equal(cardMenuKeep({ ...view(['planned']), day: { status: 'done' } }, 1, ex, 'checks'), false, 'a done day has no Checks row');
  assert.equal(cardMenuKeep(view(['done', 'done']), 1, ex, 4), true, 'Notes stays');
});

test('blockSpec carries the build unit to createBlock, and leaves it out when not read yet (stage 4 N3)', async () => {
  const { blockSpec } = await import('../../../ui/builder.js');
  const b = { step: 4, name: ' X ', notes: 'n', passes: '', unit: 'lb', days: [{ label: 'A', lifts: [lift('leg_press')] }] };
  const s = blockSpec(b);
  assert.equal(s.unit, 'lb');
  assert.equal(s.name, 'X');
  assert.equal(s.passes, null);
  assert.equal(s.day_templates.length, 1);
  assert.equal(blockSpec({ ...b, unit: null }).unit, undefined);
});

test('a toast that wraps shows for the long time; one line shows for the short time (stage 4 B4, LOOK 3.7)', async () => {
  const { toastWraps, toastTime } = await import('../../../ui/dom.js');
  assert.equal(toastWraps(21, 21), false, 'one line of 15px at 1.4');
  assert.equal(toastWraps(42, 21), true, 'two lines');
  assert.equal(toastWraps(63, 21), true, 'three lines');
  assert.equal(toastWraps(NaN, 21), false, 'an unreadable height is one line');
  assert.equal(toastTime(false, 3000, 6000), 3000);
  assert.equal(toastTime(true, 3000, 6000), 6000);
});

test('the tally draws groups of five: four strokes, then the slash; a new group after five (stage 4 B3, LOOK 3.9)', async () => {
  const { tallyGroups } = await import('../../../ui/today.js');
  const shape = (flags) => tallyGroups(flags).map(g => g.map(m => (m.slash ? '/' : '|') + (m.done ? '' : '.')).join(''));
  assert.deepEqual(shape([true, true, true, true]), ['||||']);
  assert.deepEqual(shape([true, true, true, true, true]), ['||||/'], 'the fifth is the slash');
  assert.deepEqual(shape([true, true, true, true, true, true, false]), ['||||/', '||.'], 'a new group after five, ghosts kept in place');
  assert.deepEqual(shape(Array(10).fill(true)), ['||||/', '||||/']);
  assert.deepEqual(shape([true, false, false, false, false]), ['||.|.|./.'], 'a planned fifth set is a ghost slash');
  assert.deepEqual(shape([]), []);
  for (const n of [0, 1, 4, 5, 6, 9, 10, 11, 23]) assert.equal(tallyGroups(Array(n).fill(true)).flat().length, n, n + ' marks, one per set');
});

// ---------------- r4.3 light pass (DESIGN 14.9 H8): the picker list ----------------

const pr = (id, name, muscle, equipment, more) => ({ id, name, muscle, equipment, left_out_of_builder: false, ...(more || {}) });

test('X01: the picker groups lifts by muscle in list order', () => {
  const rows = [pr('r1', 'Leg press', 'legs', 'machine'), pr('r2', 'Plank', 'core', 'bodyweight'), pr('r3', 'Chest press', 'chest', 'machine'),
    pr('r4', 'Row', 'back', 'cable'), pr('r5', 'Hidden lift', 'chest', 'machine', { left_out_of_builder: true }), pr('r6', 'Curl', 'arms', 'dumbbell')];
  const g = pickerGroups(rows, '', null);
  assert.deepEqual(g.map(x => x.muscle), MUSCLES.filter(m => rows.some(r => r.muscle === m && !r.left_out_of_builder)), 'groups in MUSCLES order');
  for (const x of g) for (const r of x.rows) assert.equal(r.muscle, x.muscle, r.id + ' sits only in its own muscle group');
  assert.equal(g.reduce((n, x) => n + x.rows.length, 0), 5, 'every shown row once');
  assert.ok(!g.some(x => x.rows.some(r => r.id === 'r5')), 'a left out row is never shown');
  assert.deepEqual(pickerGroups(rows, '  PRESS ', null).map(x => x.rows.map(r => r.id)), [['r3'], ['r1']], 'the search is trimmed and case blind');
  assert.deepEqual(pickerGroups(rows, '', ['machine']).flatMap(x => x.rows.map(r => r.id)), ['r3', 'r1'], 'a chip keeps its equipment only');
  assert.deepEqual(pickerGroups(rows, 'zzz', null), [], 'no match gives no group');
});

test('Q06: inside a muscle the picker sorts by name, never by answers (R4-18)', () => {
  // The id order and the order of the answer counts both differ from the name order.
  const rows = [pr('a1', 'Seated row', 'back', 'cable', { pump_answers: 9 }), pr('a2', 'Lat pulldown', 'back', 'cable', { pump_answers: 1 }),
    pr('a3', 'Assisted pull-up', 'back', 'machine', { pump_answers: 5 }), pr('a4', 'Back extension', 'back', 'bodyweight', { pump_answers: 7 })];
  const feedback = [{ id: 'd:x1', exercise_id: 'a1', pump: 4 }, { id: 'd:x2', exercise_id: 'a2', pump: 1 }];
  const g = pickerGroups(rows, '', null, feedback);
  assert.deepEqual(g[0].rows.map(r => r.name), ['Assisted pull-up', 'Back extension', 'Lat pulldown', 'Seated row']);
});

// SB1 and SB6 (security read 2): a refused backup marker must never leave the share stuck.
test('SB1: a backup marker that throws still ends the share, and the failure words show once', async () => {
  const { markSaved } = await import('../../../ui/dom.js');
  for (const err of [Object.assign(new Error('bad'), { name: 'Refused', code: 'bad' }), Object.assign(new Error('not saved'), { name: 'NotSaved' })]) {
    const backup = { sharing: true };
    let fails = 0;
    const store = { markBackedUp: async () => { throw err; } };
    const ok = await markSaved(store, 1, () => { backup.sharing = false; }, () => { fails++; });
    assert.equal(ok, false, err.name + ': the marker was not written');
    assert.equal(backup.sharing, false, err.name + ': the share flag goes off');
    assert.equal(fails, 1, err.name + ': the failure words show once');
  }
  const backup = { sharing: true };
  let seen = null, fails = 0;
  const ok = await markSaved({ markBackedUp: async (ms) => { seen = ms; } }, 42, () => { backup.sharing = false; }, () => { fails++; });
  assert.deepEqual([ok, seen, backup.sharing, fails], [true, 42, false, 0]);
});

// SB5 (security read 2): a pending feedback row on a slot with no set (an old file or an old safety
// copy) never holds Finish day. Store-free: a stub store, no page.
test('SB5: Finish day passes over a pending feedback row whose slot holds no set and finishes the day', async () => {
  const { finishFlow, feedbackSheet } = await import('../../../ui/today.js');
  const dId = 'b1:p1:d1';
  const v = {
    day: { id: dId, status: 'open', scores: {} }, block: { scores: [], checks: [] },
    sets: [{ id: dId + ':x1:s1:none', slot: 1, status: 'done', exercise_id: 'leg_press' }],
    feedback: [{ id: dId + ':x9', day_id: dId, pending: true, checks: {} }], exercises: new Map()
  };
  const calls = [];
  const ctx = {
    store: { dayView: async () => { calls.push(['dayView']); return v; }, finishDay: async (id, scores) => { calls.push(['finishDay', id, scores]); return null; } },
    wake: { release: () => calls.push(['release']) }, backup: { rebuild: async () => calls.push(['rebuild']) },
    go: (h) => calls.push(['go', h]), render: () => calls.push(['render'])
  };
  await finishFlow(ctx, dId);
  assert.deepEqual(calls.map(c => c[0]), ['dayView', 'finishDay', 'release', 'rebuild', 'go'], 'the orphan row is passed over: no sheet, no second read');
  assert.equal(calls[4][1], '#/daydone/' + dId);
  // The sheet itself gives way at once when its slot has no set.
  assert.equal(await feedbackSheet(ctx, v, 9, true), undefined);
});
