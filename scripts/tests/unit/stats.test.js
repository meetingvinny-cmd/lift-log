// stats.test.js - the pure counts of 17 C.3.10 and C.3.12 (stats.js). Made-up data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dayCounts, setsByMuscle, exerciseRounds, trendPoints } from '../../../stats.js';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const tpl = (n) => Array.from({ length: n }, (_, i) => ({ day: i + 1, label: String.fromCharCode(65 + i), lifts: [] }));
const day = (b, pass, d, status) => ({ id: b + ':p' + pass + ':d' + d, block_id: b, pass, day: d, status });
const set = (b, pass, d, o) => ({ id: b + ':p' + pass + ':d' + d + ':x' + (o.slot || 1) + ':s' + (o.set_n || 1) + ':' + (o.side || 'none'),
  day_id: b + ':p' + pass + ':d' + d, block_id: b, exercise_id: o.ex || 'ex_q', slot: o.slot || 1, set_n: o.set_n || 1, side: o.side || 'none',
  kind: o.kind || 'work', status: o.status || 'done', origin: 'plan', target: { count_label: null },
  done: (o.status || 'done') === 'done' ? { load: o.load ?? 100, reps: o.reps ?? 8 } : null });
const EX = [
  { id: 'ex_q', muscle: 'legs', muscle_detail: 'quads' },
  { id: 'ex_c', muscle: 'chest', muscle_detail: 'chest' },
  { id: 'ex_n', muscle: 'core', muscle_detail: null }
];

test('stats.js has zero imports and never reads the clock or a random number', () => {
  const src = readFileSync(join(APP, 'stats.js'), 'utf8');
  assert.equal(/^\s*import\b/m.test(src), false);
  assert.equal(/\bDate\b|performance\.now|Math\.random|crypto/.test(src), false);
  assert.equal(/Math\.(min|max)\(\s*\.\.\./.test(src), false, 'no spread into Math.min or Math.max (14.10 J9)');
});

test('ZW2: a 4-round, 3-day block after day 1: done 1, skipped 0, not done 11 (M57: the easy round is counted)', () => {
  const b = { id: 'b1', passes: 4, day_templates: tpl(3) };
  assert.deepEqual(dayCounts(b, [day('b1', 1, 1, 'done'), day('b1', 1, 2, 'planned')]), { total: 12, done: 1, skipped: 0, not_done: 11 });
  assert.deepEqual(dayCounts(b, [day('b1', 1, 1, 'done'), day('b1', 1, 2, 'skipped'), day('zz', 1, 1, 'done')]), { total: 12, done: 1, skipped: 1, not_done: 10 }, 'another block never counts');
  assert.deepEqual(dayCounts({ id: 'b2', passes: null, day_templates: tpl(2) }, [day('b2', 1, 1, 'done'), day('b2', 1, 2, 'open'), day('b2', 2, 1, 'planned')]),
    { total: 3, done: 1, skipped: 0, not_done: 2 }, 'open ended: the day rows that exist');
});

test('M58: sets per muscle counts an L and R pair once and never a warm-up', () => {
  const b = { id: 'b1', passes: 2, day_templates: tpl(1) };
  const days = [day('b1', 1, 1, 'done'), day('b1', 2, 1, 'done')];
  const sets = [
    set('b1', 1, 1, { set_n: 1, side: 'L' }), set('b1', 1, 1, { set_n: 1, side: 'R' }),
    set('b1', 1, 1, { set_n: 2, side: 'L' }), set('b1', 1, 1, { set_n: 2, side: 'R' }),
    set('b1', 1, 1, { set_n: 1, kind: 'warmup' }),
    set('b1', 1, 1, { set_n: 3, status: 'skipped' }),
    set('b1', 2, 1, { set_n: 1, slot: 2, ex: 'ex_c' }),
    set('b1', 2, 1, { set_n: 1, slot: 3, ex: 'ex_n' })
  ];
  const r = setsByMuscle(b, days, sets, EX);
  assert.deepEqual(r.rounds, [1, 2]);
  assert.deepEqual(r.rows, [{ muscle: 'chest', cells: [0, 1] }, { muscle: 'core', cells: [0, 1] }, { muscle: 'quads', cells: [2, 0] }]);
});

test('GW5: the easy round has its column, and future rounds show empty cells mid block', () => {
  const b = { id: 'b1', passes: 4, day_templates: tpl(1) };
  const r = setsByMuscle(b, [day('b1', 1, 1, 'done')], [set('b1', 1, 1, {})], EX);
  assert.deepEqual(r.rounds, [1, 2, 3, 4]);
  assert.deepEqual(r.rows, [{ muscle: 'quads', cells: [1, 0, 0, 0] }]);
});

test('exerciseRounds: per block, rounds oldest first, sets by number then L before R; one block never mixes into another', () => {
  const sets = [
    set('b1', 2, 1, { set_n: 2, load: 110 }), set('b1', 1, 1, { set_n: 1, side: 'R', load: 50 }), set('b1', 1, 1, { set_n: 1, side: 'L', load: 50 }),
    set('b2', 1, 1, { set_n: 1, load: 40 }), set('b1', 2, 1, { set_n: 1, load: 105 }),
    set('b1', 3, 1, { set_n: 1, status: 'planned' }), set('b1', 3, 1, { set_n: 1, ex: 'ex_c' })
  ];
  const r = exerciseRounds(sets, 'ex_q');
  assert.deepEqual(r.map(x => x.block_id), ['b1', 'b2']);
  assert.deepEqual(r[0].rounds.map(x => x.pass), [1, 2]);
  assert.deepEqual(r[0].rounds[0].sets.map(s => s.side), ['L', 'R']);
  assert.deepEqual(r[0].rounds[1].sets.map(s => s.load), [105, 110]);
  assert.deepEqual(r[1].rounds.map(x => x.sets.map(s => s.load)), [[40]]);
  assert.deepEqual(trendPoints(r[1].rounds, 'external').map(p => p.value), [40], 'block b2 has its own series');
});

test('M60: trendPoints gives rounds in order, oldest first; the heaviest set, ties by reps', () => {
  const rounds = [
    { pass: 3, sets: [{ set_n: 1, load: 120, reps: 5 }, { set_n: 2, load: 120, reps: 7 }] },
    { pass: 1, sets: [{ set_n: 1, load: 100, reps: 8 }, { set_n: 2, load: 105, reps: 6 }] },
    { pass: 2, sets: [{ set_n: 1, load: 110, reps: 8 }] }
  ];
  const p = trendPoints(rounds, 'external');
  assert.deepEqual(p.map(x => x.pass), [1, 2, 3]);
  assert.deepEqual(p.map(x => [x.value, x.reps]), [[105, 6], [110, 8], [120, 7]]);
});

test('trendPoints: a body row uses the most reps; body plus the heaviest added load; assist the least help', () => {
  const rounds = [{ pass: 1, sets: [{ load: 0, reps: 12 }, { load: 0, reps: 15 }] }, { pass: 2, sets: [{ load: 0, reps: 14 }] }];
  assert.deepEqual(trendPoints(rounds, 'body').map(x => x.value), [15, 14]);
  const plus = [{ pass: 1, sets: [{ load: 10, reps: 8 }, { load: 25, reps: 5 }] }];
  assert.deepEqual(trendPoints(plus, 'body_plus').map(x => x.value), [25]);
  const assist = [{ pass: 1, sets: [{ load: 60, reps: 8 }, { load: 50, reps: 6 }] }];
  assert.deepEqual(trendPoints(assist, 'assist').map(x => x.value), [50]);
  assert.deepEqual(trendPoints([{ pass: 1, sets: [] }], 'external'), [], 'a round with no done set gives no dot');
});
