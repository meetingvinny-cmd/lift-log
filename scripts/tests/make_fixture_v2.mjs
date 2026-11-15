// make_fixture_v2.mjs - builds fixtures/backup_v2.json through the real store on the fake db with a
// fake clock after 2026-12-01 (DESIGN 16 B.6.3, r4.4 R12): it holds only rows the store really
// writes, made-up words only. Run from app/: TZ=America/New_York node scripts/tests/make_fixture_v2.mjs
// Made at the schema commit (B.1 steps 3 to 5) with the calls built then: a block file with the
// schema 2 words, a sleep answer, a set kind he picked, a hand Add set, a custom exercise. Made
// again at B.1 step 5 rest with the switch through switchProfile (three ticks and ADJUST), a Rest
// of block Add set through liveEdit and a Change answers save (B.6.3). Made again at B.1 step 11,
// once the Slice 2 screens call these, with the soreness-alone sheet's saveSoreness on day B. Made
// again at Slice 3 C.0.1 step 1 with the Slice 3 store calls (C.0.2: every Slice 3 field filled).
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../../store.js';
import { createFakeDb, fakeClock } from './unit/fake_db.js';
import { SCHEMA } from '../../version.js';
import { TEMPLATES } from '../../data/templates.js';

if (SCHEMA !== 2) {
  console.log('make_fixture_v2.mjs makes the schema 2 fixture only; SCHEMA is ' + SCHEMA + ', nothing written');
  process.exit(1);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const MIN = 60000;
const db = createFakeDb();
const clock = fakeClock('2026-12-02T18:00:00-05:00');
let n = 0;
const store = createStore({ db, now: clock.now, uuid: () => '00000000-0000-4000-8000-' + String(++n).padStart(12, '0') });
await store.seed();
await store.setSetting('unit', 'lb');

const lift = (slot, ex, sets, load, more) => ({ slot, exercise_id: ex, sets, rep_low: 8, rep_high: 12, start_load: load, failure_set: false,
  reps_left_target: 2, warmups: [], sides: 'none', load_basis: 'total', count_label: null, note: '', short_note: '', goal_line: '',
  set_type: 'normal', ...(more || {}) });
const file = {
  format: 'liftlog-block', schema: 2, source_id: 'v2-fixture', version: 1,
  block: {
    name: 'Made-up schema two block', unit: 'lb', profile: 'fixed', rules_frozen: { profile: 'fixed', rules_version: 'signed-1' }, passes: 4,
    notes: 'Made-up notes.',
    checks: [{ key: 'check_a', ask: 'Made-up check question?', stop_note: 'Made-up stop words.', lifts: null }],
    scores: [{ key: 'score_a', label: 'Made-up score', min: 0, max: 10 }],
    rule_notes: { one_failure_set: 'Made-up one failure words.', failure_on_machine: 'Made-up machine words.' },
    exercise_flags: { leg_press: { no_added_sets: false, left_out_of_builder: false } },
    levels: { quads: 'top', hamstrings: 'middle', abs_core: 'bottom' },
    switch_conditions: ['Made-up condition line one.', 'Made-up condition line two.', 'Made-up condition line three.'],
    sleep_hint: 'Made-up sleep hint.',
    flag_questions: { machine: 'Made-up machine question?', no_added_sets: 'Made-up no added sets question?', left_out_of_builder: 'Made-up left out question?' },
    day_templates: [
      { day: 1, label: 'A', lifts: [
        lift(1, 'leg_press', 2, 100, { warmups: [{ reps: 10, load: 50 }] }),
        lift(2, 'seated_leg_curl', 2, 60, { failure_set: true, reps_left_target: 0, set_type: 'failure' }),
        lift(3, 'ex_core', 2, null, { rep_low: null, rep_high: null, reps_left_target: null, goal_line: 'Made-up goal words' })] },
      { day: 2, label: 'B', lifts: [lift(1, 'leg_extension', 2, 50), lift(2, 'seated_leg_curl', 2, 60)] }
    ]
  },
  exercises: [{ id: 'ex_core', name: 'Made-up core lift', muscle: 'core', equipment: 'bodyweight', count_label: 'reps', weight_steps: null,
    step_default: 5, unilateral: false, machine: false, no_added_sets: false, left_out_of_builder: false, flags_set: true, link: '', notes: '',
    custom: true, edited: false, muscle_detail: 'abs_core', equipment_detail: 'body', load_kind: 'body', tags: [] }]
};
const block = await store.importBlock(JSON.stringify(file), true);
await store.addCustomExercise({ name: 'Made-up own lift', muscle: 'arms', equipment: 'cable' });
// The switch to Adjust each round, his three ticks and the typed word (16 B.9).
clock.add(MIN);
await store.switchProfile(block.id, [true, true, true], 'ADJUST');

// Round 1 day A: a sleep Yes on the card, a set kind he picked, a hand Add set Today only and one
// with Rest of block, a check, finished.
let day = await store.currentDay();
await store.answerSleep(day.id, true);
await store.setSetType(day.id + ':x1:s2:none', 'failure');
await store.addSet(day.id, 1);
await store.liveEdit({ type: 'add_set', dayId: day.id, slot: 1 }, 'rest');
let v = await store.dayView(day.id);
for (const s of v.sets) { clock.add(MIN); await store.tick(s.id, { load: s.target.load === null ? 0 : s.target.load, reps: 10, reps_left: 2, reps_left_plus: false, failure: false }); }
await store.saveChecks(day.id, 1, { check_a: false });
for (const slot of v.slots) { clock.add(30000); await store.saveFeedback(day.id, slot, { pump: 2, soreness: 2, workload: 2, checks: { check_a: false }, note: 'made-up note' }, false); }
clock.add(MIN);
await store.finishDay(day.id, { score_a: 3 });
// Change answers on day A's first lift: a new saved_at, and day B planned again from it.
clock.add(10 * MIN);
await store.changeAnswers(day.id + ':x1', { pump: 3, checks: { check_a: true } });

// Round 1 day B: a sleep No, then finished.
clock.add(24 * 60 * MIN);
day = await store.currentDay();
await store.answerSleep(day.id, false);
v = await store.dayView(day.id);
// The soreness-alone sheet's write (16 B.5 row 9): after the first tick of slot 1 (quads, trained on
// day A) the sheet saves soreness into the slot's row, still pending; the end sheet then sends no
// soreness key, so the store keeps it (B.4.4).
let first = true;
for (const s of v.sets) {
  clock.add(MIN);
  await store.tick(s.id, { load: s.target.load, reps: 9, reps_left: 1, reps_left_plus: false, failure: false });
  if (first && s.slot === v.slots[0]) { first = false; clock.add(20000); await store.saveSoreness(day.id, s.slot, 1); }
}
for (const slot of v.slots) {
  clock.add(30000);
  const a = slot === v.slots[0] ? { pump: 3, workload: 2, checks: {}, note: '' } : { pump: 3, soreness: 1, workload: 2, checks: {}, note: '' };
  await store.saveFeedback(day.id, slot, a, false);
}
clock.add(MIN);
await store.finishDay(day.id, { score_a: 2 });

// Round 2 day A: planned, a sleep Yes then cleared.
clock.add(24 * 60 * MIN);
day = await store.currentDay();
await store.answerSleep(day.id, true);
await store.answerSleep(day.id, null);

// Slice 3 (17 C.0.1 step 1, C.0.2, r4 review R33): every Slice 3 field filled by the store's own
// calls. Saved equipment, two tips seen, the what-changed version written on a first boot, a body
// weight on the planned round 2 day A, muscle levels changed mid block, a block started from one of
// our templates (template_id), his own template saved from the block, a copy of round 1
// (copied_from) ended with End block (finished_at), and a block made and deleted (before-delete).
await store.setSavedEquipment(['machine', 'smith', 'cable', 'barbell', 'landmine', 'dumbbell', 'kettlebell', 'body', 'other']);
await store.markTipSeen('tip_warmup');
await store.markTipSeen('intro_picker');
await store.changedDue();
clock.add(MIN);
await store.setBodyWeight(day.id, 181.5);
await store.setPriorities(block.id, { quads: 'top', hamstrings: 'middle', abs_core: 'bottom' });
clock.add(MIN);
const tpl = TEMPLATES[0];
const draft = await store.templateToDraft(tpl.id);
await store.createBlock({ name: draft.name, passes: 2, levels: draft.levels, template_id: draft.template_id,
  day_templates: draft.days.map((d, i) => ({ day: i + 1, label: d.label, lifts: d.lifts.map((l, j) => lift(j + 1, l.exercise_id, l.sets, null,
    { rep_low: l.rep_low, rep_high: l.rep_high, reps_left_target: l.reps_left_target, sides: l.sides })) })) }, null, { activate: false });
clock.add(MIN);
await store.saveBlockAsTemplate(block.id, 'Made-up own template');
clock.add(MIN);
const copy = await store.copyBlock(block.id, 1, { activate: false });
clock.add(MIN);
await store.endBlock(copy.id);
clock.add(MIN);
const gone = await store.createBlock({ name: 'Made-up block to delete', passes: 1, day_templates: [{ day: 1, label: 'A', lifts: [lift(1, 'leg_press', 1, 100)] }] }, null, { activate: false });
await store.deleteBlock(gone.id, 'DELETE');

await store.setSetting('last_backup_at', clock.now() - 1000);
clock.add(MIN);
const b = await store.backupObject();
for (const s of Object.keys(b.stores)) console.log(s, b.stores[s].length);
console.log('flat_log', b.flat_log.length, 'app_version', b.app_version, 'schema', b.schema, 'block', block.id);
writeFileSync(join(HERE, 'fixtures', 'backup_v2.json'), JSON.stringify(b, null, 1) + '\n');
