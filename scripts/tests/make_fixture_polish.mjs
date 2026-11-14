// make_fixture_polish.mjs - builds fixtures/backup_v1_polish.json through the store on the fake db
// (DESIGN 15 P.1 step 5): every polish field filled, made-up words only. backup_v1.json is never
// touched. Run from app/: TZ=America/New_York node scripts/tests/make_fixture_polish.mjs
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../../store.js';
import { createFakeDb, fakeClock } from './unit/fake_db.js';
import { SCHEMA } from '../../version.js';

// The polish fixture is a frozen schema 1 file (16 B.1 step 3 e, B.6.3): from schema 2 on the store
// writes schema 2 rows, so this script would make a different file. It stops before it writes.
if (SCHEMA !== 1) {
  console.log('make_fixture_polish.mjs makes the frozen schema 1 fixture only; SCHEMA is ' + SCHEMA + ', nothing written');
  process.exit(1);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const MIN = 60000;
const db = createFakeDb();
const clock = fakeClock('2026-11-02T18:00:00-05:00');
let n = 0;
const store = createStore({ db, now: clock.now, uuid: () => '00000000-0000-4000-8000-' + String(++n).padStart(12, '0') });
await store.seed();
await store.setSetting('unit', 'lb');

const lift = (slot, ex, sets, load, more) => ({ slot, exercise_id: ex, sets, rep_low: 8, rep_high: 12, start_load: load, failure_set: false,
  reps_left_target: 2, warmups: [], sides: 'none', load_basis: 'total', count_label: null, note: '', short_note: '', goal_line: '', ...(more || {}) });
const file = {
  format: 'liftlog-block', schema: 1, source_id: 'polish-fixture', version: 1,
  block: {
    name: 'Made-up polish block', unit: 'lb', profile: 'fixed', rules_frozen: { profile: 'fixed', rules_version: 'none' }, passes: 2,
    notes: 'Made-up notes.',
    checks: [{ key: 'check_all', ask: 'Made-up question for every lift?', stop_note: 'Made-up stop words.', lifts: null },
      { key: 'check_one', ask: 'Made-up question for one lift?', stop_note: 'Made-up stop words two.', lifts: ['leg_press'] }],
    scores: [{ key: 'score_a', label: 'Made-up score', min: 0, max: 10 }],
    rule_notes: { one_failure_set: 'Made-up one failure words.', failure_on_machine: 'Made-up machine words.' },
    exercise_flags: {
      leg_press: { no_added_sets: false, left_out_of_builder: false, machine: false, weight_steps: [100, 115, 130] },
      lat_pulldown: { no_added_sets: false, left_out_of_builder: false, step: 7.5 },
      leg_extension: { no_added_sets: true, left_out_of_builder: false, machine: true }
    },
    day_templates: [
      { day: 1, label: 'A', lifts: [
        lift(1, 'leg_press', 3, 100, { rep_high: null, short_note: 'Made-up lift note.' }),
        lift(2, 'lat_pulldown', 2, 80),
        lift(3, 'leg_extension', 2, 50, { rep_low: null, rep_high: null, count_label: 'laps', goal_line: 'Made-up goal words' })] },
      { day: 2, label: '', lifts: [lift(1, 'lat_pulldown', 2, 80)] },
      { day: 3, label: 'C', lifts: [lift(1, 'leg_press', 3, 100), lift(2, 'leg_extension', 2, 50, { rep_low: null, rep_high: null, count_label: 'laps' })] }
    ]
  },
  exercises: []
};
await store.importBlock(JSON.stringify(file), true);

// Day 1: a moved card (slot_order), breaks on the laps lift, a check Yes, a set added below, finished.
let day = await store.currentDay();
await store.moveSlot(day.id, 3, -1);
let v = await store.dayView(day.id);
for (const s of v.sets.filter(x => x.slot === 1)) { clock.add(MIN); await store.tick(s.id, { load: 100, reps: 10, reps_left: 2, reps_left_plus: false, failure: false }); }
await store.saveChecks(day.id, 1, { check_all: true, check_one: false });
clock.add(MIN);
v = await store.dayView(day.id);
await store.addSetBelow(v.sets.find(x => x.slot === 2 && x.set_n === 1).id);
v = await store.dayView(day.id);
for (const s of v.sets.filter(x => x.slot === 2)) { clock.add(MIN); await store.tick(s.id, { load: 80, reps: 9, reps_left: 1, reps_left_plus: false, failure: false }); }
const laps = v.sets.filter(x => x.slot === 3);
clock.add(MIN); await store.tick(laps[0].id, { load: 50, reps: 3, breaks: 2 });
clock.add(MIN); await store.tick(laps[1].id, { load: 50, reps: 3, breaks: 3 });
for (const slot of [1, 2, 3]) { clock.add(30000); await store.saveFeedback(day.id, slot, { pump: 2, soreness: 1, workload: 3, checks: {}, note: 'made-up note' }, false); }
clock.add(MIN);
await store.finishDay(day.id, { score_a: 6 });

// Day 2 (no label): skipped with Skip day.
clock.add(24 * 60 * MIN);
day = await store.currentDay();
await store.skipDay(day.id);

// Day 3: open, a copied draft and a draft with breaks.
clock.add(24 * 60 * MIN);
day = await store.currentDay();
v = await store.dayView(day.id);
const lp = v.sets.filter(x => x.slot === 1);
clock.add(MIN); await store.tick(lp[0].id, { load: 100, reps: 10, reps_left: 2, reps_left_plus: false, failure: false });
await store.saveDraft(lp[1].id, { load: 115, reps: 9, reps_left: null, reps_left_plus: false, failure: false });
await store.saveDraft(v.sets.find(x => x.slot === 2).id, { load: 50, reps: 3, breaks: 1 });

await store.setSetting('carry_down', true);
await store.setSetting('rep_ask', false);
await store.setSetting('theme', 'phone');
await store.setSetting('last_backup_at', clock.now() - 1000);
clock.add(MIN);
const b = await store.backupObject();
for (const s of Object.keys(b.stores)) console.log(s, b.stores[s].length);
console.log('flat_log', b.flat_log.length, 'app_version', b.app_version);
writeFileSync(join(HERE, 'fixtures', 'backup_v1_polish.json'), JSON.stringify(b, null, 1) + '\n');
