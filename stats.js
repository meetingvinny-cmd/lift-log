// stats.js - the counts behind the Block summary, History and the trend line (17 C.3.10, C.3.12).
// Pure functions: zero imports, never reads the clock, never draws a random number, never
// touches a global. A done work set counts once per set number: an L and R pair is one set,
// and a warm-up never counts.

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
// The smallest and the largest number of a list by a plain loop, null for an empty list (14.10 J9).
function maxOf(list) {
  let m = null;
  for (let i = 0; i < list.length; i++) if (m === null || list[i] > m) m = list[i];
  return m;
}
const isDoneWork = (s) => !!s && s.kind === 'work' && s.status === 'done';
// A set's round, read from its day id (<block>:p<pass>:d<day>, the shared id form).
const PASS_RE = /:p(\d+):d\d+(?::|$)/;
function passOf(s, dayPass) {
  if (dayPass && own(dayPass, s.day_id)) return dayPass[s.day_id];
  const m = PASS_RE.exec(String(s.day_id || ''));
  return m ? Number(m[1]) : null;
}

// Days page: done, skipped and not done. Total = rounds x days in the rotation for a block with
// a length (the easy round counted), else the day rows that exist; the rest is total less done and skipped.
export function dayCounts(block, days) {
  const ds = (days || []).filter(d => d && block && d.block_id === block.id);
  const done = ds.filter(d => d.status === 'done').length;
  const skipped = ds.filter(d => d.status === 'skipped').length;
  const perRound = block && Array.isArray(block.day_templates) ? block.day_templates.length : 0;
  const total = block && num(block.passes) ? block.passes * perRound : ds.length;
  return { total, done, skipped, not_done: Math.max(0, total - done - skipped) };
}

// Muscles page: one row per muscle (the exercise's muscle_detail, else its chip), one column per
// round (every round of a block with a length, the easy round too; else up to the newest round
// with a day row). A cell = the done work sets of that muscle in that round, once per set number.
// Out { rounds: [1..n], rows: [{ muscle, cells: [n numbers] }] }, rows by muscle key.
export function setsByMuscle(block, days, sets, exercises) {
  const ds = (days || []).filter(d => d && block && d.block_id === block.id);
  const dayPass = {};
  for (const d of ds) dayPass[d.id] = d.pass;
  const n = block && num(block.passes) ? block.passes : (maxOf(ds.map(d => d.pass)) || 0);
  const rounds = Array.from({ length: n }, (_, i) => i + 1);
  const exs = new Map((exercises || []).map(e => [e.id, e]));
  const seen = new Set();
  const byMuscle = new Map();
  for (const s of sets || []) {
    if (!isDoneWork(s) || !block || s.block_id !== block.id) continue;
    const pass = passOf(s, dayPass);
    if (!Number.isInteger(pass) || pass < 1 || pass > n) continue;
    const key = s.day_id + '|' + s.slot + '|' + s.set_n;
    if (seen.has(key)) continue;
    seen.add(key);
    const ex = exs.get(s.exercise_id);
    const muscle = ex ? (ex.muscle_detail || ex.muscle || null) : null;
    if (!muscle) continue;
    if (!byMuscle.has(muscle)) byMuscle.set(muscle, rounds.map(() => 0));
    byMuscle.get(muscle)[pass - 1]++;
  }
  const rows = [...byMuscle.keys()].sort().map(m => ({ muscle: m, cells: byMuscle.get(m) }));
  return { rounds, rows };
}

// One exercise's done work sets, per block, per round. Out [{ block_id, rounds: [{ pass, sets:
// [{ set_n, side, load, reps, count_label }] }] }]: blocks in the order they first appear in
// `sets`, rounds oldest first, sets by set number then L before R. One block never mixes into
// another's rounds.
export function exerciseRounds(sets, exerciseId) {
  const blocks = new Map();
  for (const s of sets || []) {
    if (!isDoneWork(s) || s.exercise_id !== exerciseId || !s.done) continue;
    const pass = passOf(s, null);
    if (!Number.isInteger(pass)) continue;
    if (!blocks.has(s.block_id)) blocks.set(s.block_id, new Map());
    const rounds = blocks.get(s.block_id);
    if (!rounds.has(pass)) rounds.set(pass, []);
    rounds.get(pass).push({ set_n: s.set_n, side: s.side, load: num(s.done.load) ? s.done.load : null,
      reps: num(s.done.reps) ? s.done.reps : null, count_label: s.target ? s.target.count_label || null : null });
  }
  const sideRank = (x) => (x === 'L' ? 0 : x === 'R' ? 1 : 2);
  return [...blocks.entries()].map(([block_id, rounds]) => ({
    block_id,
    rounds: [...rounds.keys()].sort((a, b) => a - b).map(pass => ({
      pass, sets: rounds.get(pass).slice().sort((a, b) => a.set_n - b.set_n || sideRank(a.side) - sideRank(b.side))
    }))
  }));
}

// The trend line of one block: per round, the top done work set. External and body_plus loads:
// the heaviest load, ties by most reps. Body rows: the most reps. Assist rows: the least help,
// ties by most reps (more assist is easier). rows = the `rounds` of one exerciseRounds block.
// Out [{ pass, value, load, reps }] in round order, oldest first.
export function trendPoints(rows, loadKind) {
  const out = [];
  for (const r of rows || []) {
    const sets = (r && r.sets) || [];
    let best = null;
    for (const s of sets) {
      if (loadKind === 'body') {
        if (!num(s.reps)) continue;
        if (!best || s.reps > best.reps) best = s;
        continue;
      }
      if (!num(s.load)) continue;
      const better = !best ||
        (loadKind === 'assist' ? s.load < best.load : s.load > best.load) ||
        (s.load === best.load && num(s.reps) && (!num(best.reps) || s.reps > best.reps));
      if (better) best = s;
    }
    if (!best) continue;
    out.push({ pass: r.pass, value: loadKind === 'body' ? best.reps : best.load, load: best.load, reps: best.reps });
  }
  return out.sort((a, b) => a.pass - b.pass);
}
