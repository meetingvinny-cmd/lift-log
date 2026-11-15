// templates.test.js - static checks on our starter programs (DESIGN 17 C.3.4), run on the real
// data/templates.js and on the made-up fixtures/templates_sample.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as REAL from '../../../data/templates.js';
import * as SAMPLE from '../fixtures/templates_sample.js';
import { SEED_EXERCISES, MUSCLE_DETAILS, EQUIPMENT_DETAILS, MUSCLE_DETAIL_CHIP } from '../../../data/exercises.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..', '..');
const FROZEN = JSON.parse(readFileSync(join(HERE, '..', 'fixtures', 'template_ids.json'), 'utf8'));
const ROWS = new Map(SEED_EXERCISES.map(r => [r.id, r]));
const LEVELS = ['top', 'middle', 'bottom'];
const CEILING = { reps: 30, seconds: 600, laps: 20 };
const SLOT_KEYS = ['exercise_id', 'priority', 'rep_high', 'rep_low'];
const TEMPLATE_KEYS = ['days', 'days_per_rotation', 'equipment', 'focus_key', 'id', 'levels', 'name', 'why'];

// The muscle a slot counts under: the row's finer value, else (a row with a null detail) any level
// key that sits on the row's chip.
function slotMuscles(row) {
  return row.muscle_detail ? [row.muscle_detail] : MUSCLE_DETAILS.filter(m => MUSCLE_DETAIL_CHIP[m] === row.muscle);
}

function checkFile(name, mod) {
  const { TEMPLATES, TEMPLATE_IDS, FOCUS_NAMES } = mod;
  test(name + ': at least one template, frozen list, ids unique and in the id pattern', () => {
    assert.ok(Array.isArray(TEMPLATES) && TEMPLATES.length >= 1);
    assert.ok(Object.isFrozen(TEMPLATES) && Object.isFrozen(TEMPLATE_IDS) && Object.isFrozen(FOCUS_NAMES));
    assert.deepEqual([...TEMPLATE_IDS], TEMPLATES.map(t => t.id));
    assert.equal(new Set(TEMPLATE_IDS).size, TEMPLATE_IDS.length);
    for (const t of TEMPLATES) assert.match(t.id, /^t_[a-z0-9_]{1,60}$/);
  });
  test(name + ': each template holds exactly the template fields, no sets key and no load anywhere', () => {
    for (const t of TEMPLATES) {
      assert.deepEqual(Object.keys(t).sort(), TEMPLATE_KEYS, t.id);
      const text = JSON.stringify(t);
      assert.ok(!/"sets"\s*:/.test(text), t.id + ' holds a sets key');
      assert.ok(!/load/.test(text), t.id + ' names a load');
      for (const d of t.days) for (const s of d.slots) assert.deepEqual(Object.keys(s).sort(), SLOT_KEYS, t.id);
    }
  });
  test(name + ': 2 to 6 days equal to days_per_rotation, labels 1 to 4 letters or digits and unique', () => {
    for (const t of TEMPLATES) {
      assert.ok(Number.isInteger(t.days_per_rotation) && t.days_per_rotation >= 2 && t.days_per_rotation <= 6, t.id);
      assert.equal(t.days.length, t.days_per_rotation, t.id);
      const labels = t.days.map(d => d.label);
      for (const l of labels) assert.match(l, /^[A-Za-z0-9]{1,4}$/, t.id);
      assert.equal(new Set(labels).size, labels.length, t.id + ' has two days with one label');
      for (const d of t.days) assert.ok(d.slots.length >= 1 && d.slots.length <= 30, t.id + ' day ' + d.label);
    }
  });
  test(name + ': every slot names an id in data/exercises.js (M65)', () => {
    for (const t of TEMPLATES) for (const d of t.days) for (const s of d.slots) {
      assert.ok(ROWS.has(s.exercise_id), t.id + ' day ' + d.label + ' names ' + s.exercise_id + ', not in data/exercises.js');
    }
  });
  test(name + ': levels keys are muscle_detail values, one level each, and every slot muscle has a level', () => {
    for (const t of TEMPLATES) {
      for (const [k, v] of Object.entries(t.levels)) {
        assert.ok(MUSCLE_DETAILS.includes(k), t.id + ' level key ' + k);
        assert.ok(LEVELS.includes(v), t.id + ' level ' + v);
      }
      for (const d of t.days) for (const s of d.slots) {
        const row = ROWS.get(s.exercise_id);
        assert.ok(slotMuscles(row).some(m => m in t.levels), t.id + ': ' + s.exercise_id + ' trains a muscle with no level');
        assert.ok(LEVELS.includes(s.priority), t.id + ' slot priority');
      }
    }
  });
  test(name + ': a muscle level is the highest priority any of its slots holds', () => {
    for (const t of TEMPLATES) {
      const best = {};
      for (const d of t.days) for (const s of d.slots) {
        const row = ROWS.get(s.exercise_id);
        if (!row.muscle_detail) continue;
        const m = row.muscle_detail;
        best[m] = Math.min(best[m] === undefined ? 9 : best[m], LEVELS.indexOf(s.priority));
      }
      for (const [m, i] of Object.entries(best)) assert.equal(t.levels[m], LEVELS[i], t.id + ' ' + m);
    }
  });
  test(name + ': rep ranges are whole numbers, low at most high, under the ceiling for the count word', () => {
    for (const t of TEMPLATES) for (const d of t.days) for (const s of d.slots) {
      const c = CEILING[ROWS.get(s.exercise_id).count_label];
      assert.ok(Number.isInteger(s.rep_low) && Number.isInteger(s.rep_high), t.id);
      assert.ok(s.rep_low >= 1 && s.rep_low <= s.rep_high && s.rep_high <= c, t.id + ' ' + s.exercise_id);
    }
  });
  test(name + ': equipment is a list of finer kinds and every slot exercise uses one of them', () => {
    for (const t of TEMPLATES) {
      assert.ok(t.equipment.length >= 1 && new Set(t.equipment).size === t.equipment.length, t.id);
      for (const e of t.equipment) assert.ok(EQUIPMENT_DETAILS.includes(e), t.id + ' ' + e);
      for (const d of t.days) for (const s of d.slots) {
        assert.ok(t.equipment.includes(ROWS.get(s.exercise_id).equipment_detail), t.id + ' ' + s.exercise_id);
      }
    }
  });
  test(name + ': focus keys have their words, names and why lines are set', () => {
    for (const t of TEMPLATES) {
      assert.ok(typeof FOCUS_NAMES[t.focus_key] === 'string' && FOCUS_NAMES[t.focus_key].length > 0, t.id);
      assert.ok(t.name.length >= 1 && t.name.length <= 60, t.id);
      assert.ok(t.why.length >= 1 && t.why.length <= 200, t.id);
    }
    for (const k of Object.keys(FOCUS_NAMES)) assert.ok(TEMPLATES.some(t => t.focus_key === k), 'focus key ' + k + ' is used');
    assert.equal(new Set(TEMPLATES.map(t => t.name.toLowerCase())).size, TEMPLATES.length, 'names unique');
  });
}

checkFile('data/templates.js', REAL);
checkFile('fixtures/templates_sample.js', SAMPLE);

test('data/templates.js: every template id is frozen in fixtures/template_ids.json, in order, never dropped', () => {
  for (const id of FROZEN) assert.ok(REAL.TEMPLATE_IDS.includes(id), 'frozen template id ' + id + ' is gone');
  for (const id of REAL.TEMPLATE_IDS) assert.ok(FROZEN.includes(id), 'template id ' + id + ' is not frozen in template_ids.json');
  assert.equal(new Set(FROZEN).size, FROZEN.length);
});

test('data/templates.js: ours first by days in the rotation, then name', () => {
  const key = (t) => [t.days_per_rotation, t.name.toLowerCase()];
  const sorted = [...REAL.TEMPLATES].sort((a, b) => key(a)[0] - key(b)[0] || (key(a)[1] < key(b)[1] ? -1 : key(a)[1] > key(b)[1] ? 1 : 0));
  assert.deepEqual(REAL.TEMPLATE_IDS, sorted.map(t => t.id));
});

test('data/templates.js and the sample are data only: no import, no clock, no random', () => {
  for (const f of ['data/templates.js', 'scripts/tests/fixtures/templates_sample.js']) {
    const src = readFileSync(join(APP, f), 'utf8');
    assert.ok(!/^\s*import\s/m.test(src), f + ' imports');
    assert.ok(!/Date|Math\.random|fetch\(/.test(src), f + ' reads a clock, a random number or the network');
  }
});

test('the sample ids are never in the real list or the frozen id list', () => {
  for (const id of SAMPLE.TEMPLATE_IDS) {
    assert.ok(!REAL.TEMPLATE_IDS.includes(id));
    assert.ok(!FROZEN.includes(id));
  }
});
