// engine.js - the round adjust engine (TD-2 to TD-7). Pure functions: zero imports,
// never reads the clock, never draws a random number, never touches a global.
// Every function takes a profile table (RULES.profiles.<name>) as `rules`, except
// validateRules and buildBlock, which take the whole RULES object.
// Bad input gives { ok: false, error } where a call can be refused; nothing throws on data.
// Comments name a source only as "health-coach verdict item N" or "TD-n".

const ANSWER_KEYS = ['pump', 'soreness', 'workload'];
const WHEN_KEYS = {
  pump: [1, 2, 3, 4], soreness: [1, 2, 3, 4], workload: [1, 2, 3, 4],
  score_max: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], check_yes: [true, false], missed: [true, false],
  level: ['top', 'middle', 'bottom']
};
const LEVELS = ['top', 'middle', 'bottom'];
const WHY_RE = /^why\.[A-Za-z0-9_]{1,30}$/;
const KIND_RE = /^[a-z0-9_]{1,30}$/;

const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const before = (a, b) => a.pass < b.pass || (a.pass === b.pass && a.day < b.day);
const dayIdOf = (blockId, pass, day) => blockId + ':p' + pass + ':d' + day;
const isFixed = (rules) => !rules || !rules.load || rules.load.add_when === 'never';
// The smallest and the largest number of a list by a plain loop, null for an empty list
// (14.10 J9, SR13: no spread into Math.min or Math.max; the engine keeps zero imports).
function minOf(list) {
  let m = null;
  for (let i = 0; i < list.length; i++) if (m === null || list[i] < m) m = list[i];
  return m;
}
function maxOf(list) {
  let m = null;
  for (let i = 0; i < list.length; i++) if (m === null || list[i] > m) m = list[i];
  return m;
}

// ---------------- validateRules ----------------

function validateProfile(name, p, setKinds, errors) {
  const e = (s) => errors.push(name + ': ' + s);
  if (!isObj(p)) { e('profile is not an object'); return; }
  for (const part of ['signals', 'set_rules', 'caps', 'start_sets', 'effort', 'load', 'easy_week', 'carry_forward', 'live_edits']) {
    if (!own(p, part) || !isObj(p[part])) e('part missing: ' + part);
  }
  if (errors.length) return;
  const caps = p.caps;
  for (const k of ['start_max', 'add_per_pass_max', 'cut_per_pass_max', 'top_sets', 'min_sets', 'short_sleep_hours']) {
    if (!own(caps, k) || !num(caps[k])) e('caps.' + k + ' is not a number');
  }
  for (const k of ['no_add_after_short_sleep', 'no_add_if_check_yes', 'no_add_if_missed']) {
    if (!own(caps, k) || typeof caps[k] !== 'boolean') e('caps.' + k + ' is not true or false');
  }
  if (!(caps.min_sets >= 1 && caps.min_sets <= caps.start_max && caps.start_max <= caps.top_sets)) e('caps out of order: 1 <= min_sets <= start_max <= top_sets');
  if (!(caps.add_per_pass_max >= 0) || !(caps.cut_per_pass_max >= 0)) e('caps: add and cut limits must be 0 or more');

  const sr = p.set_rules;
  if (!['newest_for_muscle', 'same_day_last_round'].includes(sr.source)) e('set_rules.source unknown');
  const rows = Array.isArray(sr.rows) ? sr.rows : null;
  if (!rows || !rows.length) { e('set_rules.rows is empty'); return; }
  const ids = new Set();
  rows.forEach((r, i) => {
    const at = 'row ' + (own(r, 'id') ? r.id : '#' + (i + 1));
    if (!isObj(r) || !own(r, 'id') || !own(r, 'when') || !own(r, 'delta') || !own(r, 'why')) { e(at + ' lacks id, when, delta or why'); return; }
    if (ids.has(r.id)) e(at + ' id used twice');
    ids.add(r.id);
    if (!isObj(r.when)) { e(at + ' when is not an object'); return; }
    for (const k of Object.keys(r.when)) {
      if (!own(WHEN_KEYS, k)) { e(at + ' names an unknown key ' + k); continue; }
      const list = r.when[k];
      if (!Array.isArray(list) || !list.length) { e(at + ' ' + k + ' list is empty'); continue; }
      for (const v of list) if (!WHEN_KEYS[k].includes(v)) e(at + ' ' + k + ' value out of range');
    }
    if (!Number.isInteger(r.delta) || r.delta > caps.add_per_pass_max || r.delta < -caps.cut_per_pass_max) e(at + ' delta ' + r.delta + ' is past the per round cap');
    if (typeof r.why !== 'string' || !WHY_RE.test(r.why)) e(at + ' why is not a why key');
    const catchAll = Object.keys(r.when).length === 0;
    if (i < rows.length - 1 && catchAll) e(at + ' catches all but is not the last row');
    if (i === rows.length - 1 && !catchAll) e('last row ' + r.id + ' does not catch all: there are holes');
  });
  // No holes: every answer, score and level mix reaches a row.
  const scores = [null, ...WHEN_KEYS.score_max];
  const levels = [null, ...LEVELS];
  let holes = 0;
  for (const pump of [1, 2, 3, 4]) for (const soreness of [1, 2, 3, 4]) for (const workload of [1, 2, 3, 4]) {
    for (const score_max of scores) for (const level of levels) {
      const sig = { pump, soreness, workload, score_max, level, check_yes: null, missed: false };
      if (!rows.some(r => isObj(r) && isObj(r.when) && matches(r.when, sig))) holes++;
    }
  }
  if (holes) e(holes + ' answer mixes reach no row (holes)');

  const ef = p.effort;
  if (!num(ef.length_min) || !num(ef.length_max) || ef.length_min > ef.length_max) e('effort length_min and length_max out of order');
  if (!num(ef.failure_reps_left) || !num(ef.short_sleep_failure_reps_left)) e('effort failure goals are not numbers');   // health-coach verdict item R4-13
  if (ef.reps_left_by_pass !== null) {
    if (!isObj(ef.reps_left_by_pass)) e('effort.reps_left_by_pass is not a table');
    else {
      for (const k of Object.keys(ef.reps_left_by_pass)) {
        const n = Number(k), list = ef.reps_left_by_pass[k];
        if (!Number.isInteger(n) || !Array.isArray(list) || list.length !== n) { e('effort length ' + k + ' does not hold ' + k + ' values'); continue; }
        const hard = list.slice(0, -1);
        if (hard.some(v => !Number.isInteger(v) || v < 1 || v > 4)) e('effort length ' + k + ' hard value outside 1 to 4');
        for (let i = 1; i < hard.length; i++) if (hard[i] > hard[i - 1]) e('effort length ' + k + ' rises');
        if (list[list.length - 1] !== p.easy_week.reps_left) e('effort length ' + k + ' last value is not the easy round goal');
      }
    }
  }
  const ld = p.load;
  if (!['goal_met', 'top_of_range', 'never'].includes(ld.add_when)) e('load.add_when unknown');
  if (!['step_down', 'done_plus_one', 'as_written'].includes(ld.on_two_misses)) e('load.on_two_misses unknown');
  if (!['done_plus_one', 'as_written'].includes(ld.on_miss)) e('load.on_miss unknown');
  if (!(num(ld.rep_floor) && num(ld.rep_ceiling) && ld.rep_floor <= ld.rep_ceiling)) e('load rep_floor and rep_ceiling out of order');
  const ew = p.easy_week;
  if (!(num(ew.load_factor) && ew.load_factor > 0 && ew.load_factor <= 1)) e('easy_week.load_factor outside 0 to 1');
  if (!(num(ew.reps_factor) && ew.reps_factor > 0 && ew.reps_factor <= 1)) e('easy_week.reps_factor outside 0 to 1');
  if (!(num(ew.set_factor) && ew.set_factor >= 1)) e('easy_week.set_factor below 1');
  if (!Array.isArray(ew.drop)) e('easy_week.drop is not a list');
  validateBuilder(p.builder, e);
  validateCopy(p.copy, e);
  void setKinds;
}

// The builder part (TD-8): its numbers in range, and for the same days top gets strictly more
// slots than middle and middle at least as many as bottom (contract BW4).
function validateBuilder(b, e) {
  if (!isObj(b)) { e('part missing: builder'); return; }
  const lo = b.days_per_rotation_min, hi = b.days_per_rotation_max;
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 2 || hi > 6 || lo > hi) { e('builder days per rotation out of range 2 to 6'); return; }
  const spr = b.slots_per_rotation;
  if (!isObj(spr)) { e('builder.slots_per_rotation missing'); return; }
  for (let d = lo; d <= hi; d++) {
    const v = {};
    for (const lv of LEVELS) {
      v[lv] = isObj(spr[lv]) ? spr[lv][d] : undefined;
      if (!Number.isInteger(v[lv]) || v[lv] < 1) e('builder slots for ' + lv + ' at ' + d + ' days is not a whole number of 1 or more');
    }
    if (Number.isInteger(v.top) && Number.isInteger(v.middle) && !(v.top > v.middle)) e('builder: top must get more slots than middle at ' + d + ' days');
    if (Number.isInteger(v.middle) && Number.isInteger(v.bottom) && !(v.middle >= v.bottom)) e('builder: middle must get at least as many slots as bottom at ' + d + ' days');
  }
  for (const k of ['max_lifts_per_day', 'warn_lifts_per_day', 'warn_work_sets_per_day']) {
    if (!Number.isInteger(b[k]) || b[k] < 1) e('builder.' + k + ' is not a whole number of 1 or more');
  }
  if (Number.isInteger(b.warn_lifts_per_day) && Number.isInteger(b.max_lifts_per_day) && b.warn_lifts_per_day > b.max_lifts_per_day) e('builder: the warning is past the hard cap');
  if (!LEVELS.includes(b.default_level_on_board)) e('builder.default_level_on_board unknown');
  if (b.default_rep_range !== null && !(isObj(b.default_rep_range) && num(b.default_rep_range.low) && num(b.default_rep_range.high) && b.default_rep_range.low <= b.default_rep_range.high)) e('builder.default_rep_range bad');
  if (!Number.isInteger(b.default_reps_left_target) || b.default_reps_left_target < 0 || b.default_reps_left_target > 4) e('builder.default_reps_left_target outside 0 to 4');
}

function validateCopy(c, e) {
  if (!isObj(c)) { e('part missing: copy'); return; }
  if (c.sets_from !== 'planned') e('copy.sets_from unknown');
  if (c.load_from !== 'last_done') e('copy.load_from unknown');
  if (c.fallback !== 'round_goal') e('copy.fallback unknown');
}

export function validateRules(rules) {
  const errors = [];
  if (!isObj(rules)) return { ok: false, errors: ['rules is not an object'] };
  if (!own(rules, 'rules_version') || typeof rules.rules_version !== 'string') errors.push('rules_version missing');
  const kinds = own(rules, 'set_kinds') ? rules.set_kinds : null;
  if (!Array.isArray(kinds) || !kinds.length) errors.push('set_kinds missing');
  else {
    for (const k of kinds) {
      if (!isObj(k) || typeof k.key !== 'string' || !KIND_RE.test(k.key)) errors.push('set kind key bad');
      else if (!(k.counts === 0 || k.counts === 1) || typeof k.miss_check !== 'boolean') errors.push('set kind ' + k.key + ' counts or miss_check bad');
    }
    if (!kinds.some(k => isObj(k) && k.key === 'normal')) errors.push('set kind normal missing');
  }
  if (!own(rules, 'profiles') || !isObj(rules.profiles)) errors.push('profiles missing');
  else {
    const names = Object.keys(rules.profiles);
    for (const n of ['fixed', 'adaptive']) if (!names.includes(n)) errors.push('profile ' + n + ' missing');
    for (const n of names) validateProfile(n, rules.profiles[n], kinds, errors);
  }
  return { ok: errors.length === 0, errors };
}

// ---------------- setDelta ----------------

// A key not named in a row matches anything, null included. A key named matches only
// a value inside its list; null never matches (TD-3).
function matches(when, sig) {
  for (const k of Object.keys(when)) {
    const v = own(sig, k) ? sig[k] : null;
    if (v === null || v === undefined) return false;
    if (!when[k].includes(v)) return false;
  }
  return true;
}

export function setDelta(rules, signals) {
  const sig = signals || {};
  const rows = rules.set_rules.rows;
  for (const r of rows) if (matches(r.when, sig)) return { delta: r.delta, why: r.why, row: r.id };
  // validateRules makes this unreachable; hold if a crafted table has a hole.
  return { delta: 0, why: 'why.R11', row: null };
}

// ---------------- nextWeekSets ----------------

export function nextWeekSets(rules, current, delta, context) {
  const caps = rules.caps;
  const ctx = context || {};
  const rowDelta = num(delta) ? delta : 0;
  let request = rowDelta;
  let byHand = false;
  // A rest-of-block hand add: the larger of the two, never the sum, and only when the row
  // holds or adds. When the row cuts, the cut stands and the hand add does not carry (TD-3, TD-7).
  if (ctx.hand_add === 'rest' && rowDelta >= 0 && request < 1) { request = 1; byHand = true; }
  let gate = null;
  if (request > 0) {
    const sleep = Array.isArray(ctx.sleep) && ctx.sleep.length ? ctx.sleep : [null];   // no answer is never good news
    if (ctx.no_added_sets === true || ctx.flags_set !== true) gate = 'flag';
    else if (caps.no_add_after_short_sleep && sleep.some(v => v !== false)) gate = 'sleep';
    else if (caps.no_add_if_check_yes && ctx.check_yes === true) gate = 'check';
    else if (scoreBlocks(rules, ctx.score_max)) gate = 'score';
    else if (caps.no_add_if_missed && ctx.missed === true) gate = 'missed';
    if (gate) request = 0;
  }
  request = clamp(request, -caps.cut_per_pass_max, caps.add_per_pass_max);
  const base = num(current) ? current : caps.min_sets;
  let sets = clamp(base + request, caps.min_sets, caps.top_sets);
  // A count above the top steps down one set a round, never straight to the top (TD-3).
  if (base > caps.top_sets) sets = Math.max(sets, base - caps.cut_per_pass_max);
  let why;
  if (gate) why = 'why.' + gate;
  else if ((request > 0 && base + request > caps.top_sets) || (base > caps.top_sets && request >= 0)) why = 'why.top';
  else if (request < 0 && base + request < caps.min_sets) why = 'why.floor';
  else if (byHand) why = 'why.hand_add';
  else why = ctx.row_why || null;
  return { sets, why, gate, hand_add_carried: ctx.hand_add === 'rest' && rowDelta >= 0 && !gate };
}

// The score gate reads the score band of the first row that names score_max; it is never typed
// again as a number here. A table with no such row (Fixed) never shuts it (TD-3).
function scoreBlocks(rules, score) {
  if (!num(score)) return false;
  const row = rules.set_rules.rows.find(r => isObj(r.when) && own(r.when, 'score_max'));
  return !!row && Array.isArray(row.when.score_max) && row.when.score_max.includes(score);
}

// ---------------- startingSets ----------------

export function startingSets(rules, lift, priority) {
  const ss = rules.start_sets;
  const byLevel = priority && own(ss.by_priority, priority) ? ss.by_priority[priority] : ss.default;
  const own_sets = lift && num(lift.sets) ? lift.sets : Infinity;
  return Math.max(rules.caps.min_sets, Math.min(byLevel, rules.caps.start_max, own_sets));
}

// ---------------- effortTarget ----------------

export function effortTarget(rules, pass, passes, lift) {
  const fallback = lift && own(lift, 'reps_left_target') ? lift.reps_left_target : null;
  const table = rules.effort.reps_left_by_pass;
  if (passes === null || passes === undefined || table === null) return fallback;
  if (!Number.isInteger(passes) || passes < rules.effort.length_min || passes > rules.effort.length_max || !own(table, passes)) return fallback;
  if (!Number.isInteger(pass) || pass < 1 || pass > passes) return null;
  return table[passes][pass - 1];
}

// ---------------- steps ----------------

// The step of an exercise in a block, in the TD-6 read order: the block's own list, the
// block's own step size, the exercise row's list (lists are lists of loads, as the steppers
// read them), the row's own step size (lb blocks only: the shipped rows carry a pound step),
// then the table default. An assist row never has a step (TD-6).
export function stepFor(rules, exercise, unit, blockFlags) {
  if (exercise && exercise.load_kind === 'assist') return null;
  const listOf = (l) => Array.isArray(l) && l.length ? [...l].filter(num).sort((a, b) => a - b) : null;
  const bl = blockFlags ? listOf(blockFlags.weight_steps) : null;
  if (bl) return { list: bl };
  if (blockFlags && num(blockFlags.step) && blockFlags.step > 0) return { size: blockFlags.step };
  const el = exercise ? listOf(exercise.weight_steps) : null;
  if (el) return { list: el };
  if (unit === 'lb' && exercise && num(exercise.step_default) && exercise.step_default > 0) return { size: exercise.step_default };
  const byUnit = rules.load.default_steps[unit] || {};
  const d = exercise && own(byUnit, exercise.equipment) ? listOf(byUnit[exercise.equipment]) : null;
  if (d) return { size: d[0] };
  return null;
}

const round2 = (v) => Math.round(v * 100) / 100;
function stepUp(step, load) {
  if (!step || !num(load)) return null;
  if (step.list) { const n = step.list.find(x => x > load); return n === undefined ? null : n; }
  return round2(load + step.size);
}
function stepDown(step, load) {
  if (!step || !num(load)) return null;
  if (step.list) { const p = step.list.filter(x => x < load).pop(); return p === undefined ? null : p; }
  return Math.max(0, round2(load - step.size));
}
function nearestStep(step, value) {
  if (step && step.list) return step.list.reduce((b, x) => (Math.abs(x - value) < Math.abs(b - value) ? x : b), step.list[0]);
  const size = step && step.size ? step.size : 1;
  return round2(Math.round(value / size) * size);
}

// ---------------- nextLoadTarget ----------------

// Work sets that count for the miss check: done, with a rep goal, and not the marked set.
const goalSets = (sets) => sets.filter(s => s.status === 'done' && s.done && !s.failure && s.target && num(s.target.rep_low));
const missedIn = (sets) => goalSets(sets).some(s => num(s.done.reps) && s.done.reps < s.target.rep_low);

export function nextLoadTarget(rules, lift, lastDone) {
  const L = rules.load;
  const tpl = (lift && lift.template) || {};
  const last = (lastDone && Array.isArray(lastDone.sets) ? lastDone.sets : []).slice().sort((a, b) => a.set_n - b.set_n);
  const asWritten = () => {
    const t = {};
    for (const s of last) t[s.set_n] = { load: tpl.start_load ?? null, rep_low: tpl.rep_low ?? null, rep_high: tpl.rep_high ?? null };
    return t;
  };
  if (L.add_when === 'never') return { targets: asWritten(), why: 'why.plan', missed: false };
  const keep = (s) => ({ load: s.target ? s.target.load : null, rep_low: s.target ? s.target.rep_low : null, rep_high: s.target ? s.target.rep_high : null });
  const missed = missedIn(last);
  const anyDone = last.some(s => s.status === 'done' && s.done);
  const targets = {};
  if (!anyDone) {
    for (const s of last) targets[s.set_n] = keep(s);
    return { targets, why: 'why.hold', missed: false };
  }
  const step = stepFor(rules, lift && lift.exercise, lift && lift.unit, lift && lift.flags);
  const effortOnly = () => ({ load: null, rep_low: null, rep_high: null });
  const doneAsGoal = (s) => ({ load: s.done.load ?? null, rep_low: s.done.reps ?? null, rep_high: s.done.reps ?? null });
  const failureKeep = (load) => ({ load, rep_low: tpl.rep_low ?? null, rep_high: tpl.rep_high ?? null });
  let why;
  const twoMisses = missed && lastDone && lastDone.prev_missed === true;
  if (twoMisses && L.on_two_misses === 'step_down') {
    why = 'why.step_down';
    for (const s of last) {
      if (s.status === 'skipped') { targets[s.set_n] = effortOnly(); continue; }
      const t = keep(s);
      const down = stepDown(step, t.load);
      const load = down === null ? t.load : down;
      if (s.failure) { targets[s.set_n] = failureKeep(load); continue; }
      const back = lastDone.goal_before_miss && num(lastDone.goal_before_miss[s.set_n]) ? lastDone.goal_before_miss[s.set_n] : t.rep_low;
      const rep_low = num(back) ? Math.max(L.rep_floor, back) : back;
      targets[s.set_n] = { load, rep_low, rep_high: num(t.rep_high) && num(rep_low) ? Math.max(t.rep_high, rep_low) : t.rep_high };
    }
    return { targets, why, missed };
  }
  if (missed && (L.on_miss === 'done_plus_one' || (twoMisses && L.on_two_misses === 'done_plus_one'))) {
    why = 'why.on_miss';
    for (const s of last) {
      if (s.status === 'skipped') { targets[s.set_n] = effortOnly(); continue; }
      const t = keep(s);
      if (s.failure) { targets[s.set_n] = failureKeep(t.load); continue; }
      if (s.status === 'done' && s.done && num(t.rep_low) && num(s.done.reps) && s.done.reps < t.rep_low) {
        const rep_low = Math.min(L.rep_ceiling, s.done.reps + 1);
        targets[s.set_n] = { load: t.load ?? s.done.load ?? null, rep_low, rep_high: num(t.rep_high) ? Math.max(t.rep_high, rep_low) : t.rep_high };
      } else if (s.status === 'done' && s.done && !num(t.rep_low)) targets[s.set_n] = doneAsGoal(s);
      else targets[s.set_n] = t;
    }
    return { targets, why, missed };
  }
  if (missed) {   // as written on a miss
    for (const s of last) targets[s.set_n] = s.status === 'skipped' ? effortOnly() : keep(s);
    return { targets, why: 'why.hold', missed };
  }
  const goals = goalSets(last);
  const met = goals.length > 0 && goals.every(s => num(s.done.reps) && (L.add_when === 'top_of_range' && num(s.target.rep_high) ? s.done.reps >= s.target.rep_high : s.done.reps >= s.target.rep_low));
  why = met ? null : 'why.hold';
  // One load for the whole slot: the heaviest done load among the goal sets.
  const doneLoad = goals.reduce((m, s) => (num(s.done.load) && (m === null || s.done.load > m) ? s.done.load : m), null);
  const up = met ? stepUp(step, doneLoad) : null;
  for (const s of last) {
    if (s.status === 'skipped') { targets[s.set_n] = effortOnly(); continue; }
    const t = keep(s);
    if (s.failure) { targets[s.set_n] = failureKeep(met && up !== null ? up : t.load); continue; }
    if (s.status === 'done' && s.done && !num(t.rep_low)) { targets[s.set_n] = doneAsGoal(s); continue; }
    if (!met) { targets[s.set_n] = t; continue; }
    if (up !== null) {
      why = 'why.load_up';
      targets[s.set_n] = { load: up, rep_low: t.rep_low, rep_high: t.rep_high };
    } else if (num(t.rep_low) && t.rep_low >= L.rep_ceiling) {
      why = why || 'why.rep_up';
      targets[s.set_n] = { load: t.load, rep_low: L.rep_ceiling, rep_high: t.rep_high, effort_only: true };
    } else {
      why = why === 'why.load_up' ? why : 'why.rep_up';
      const rep_low = Math.min(L.rep_ceiling, t.rep_low + 1);
      targets[s.set_n] = { load: t.load, rep_low, rep_high: num(t.rep_high) ? Math.max(t.rep_high, rep_low) : t.rep_high };
    }
  }
  return { targets, why: why || 'why.hold', missed };
}

// ---------------- retargetOnLoad ----------------

// target = { load, rep_low, rep_high, step, unit, load_kind } (step from stepFor). Shown, never saved.
export function retargetOnLoad(rules, target, typedLoad) {
  const t = target || {};
  // Fixed shows the goal as written; an assist row shows its planned goal (more assist is easier).
  if (isFixed(rules) || t.load_kind === 'assist') return { rep_low: t.rep_low ?? null };
  const L = rules.load;
  const band = L.retarget_band[t.unit];
  const step = t.step && (t.step.size || (t.step.list && t.step.list.length > 1)) ? t.step : null;
  if (!num(t.load) || !num(typedLoad) || !num(t.rep_low) || !step || !num(band)) return { effort_only: true };
  const diff = typedLoad - t.load;
  if (Math.abs(diff) > band) return { effort_only: true };
  let size = step.size;
  if (!size) {   // a list of loads: the gap between the two nearest listed loads
    const gaps = step.list.slice(1).map((x, i) => x - step.list[i]).filter(g => g > 0);
    size = gaps.length ? minOf(gaps) : null;
  }
  if (!size) return { effort_only: true };
  const q = Math.abs(diff) / size;
  const steps = Math.sign(diff) * Math.ceil(q - 0.5);   // a half rounds toward 0
  return { rep_low: clamp(t.rep_low - steps * L.retarget_band.reps_per_step, L.rep_floor, L.rep_ceiling) };
}

// ---------------- easyWeekPlan ----------------

// pass = { slots: [{ slot, muscle, step, assist, sets, targets: { <set_n>: {load, rep_low, rep_high} }, reps_left, failure_set_n }] }
// An assist slot keeps its assist number; only its rep goal is made lighter (TD-6).
export function easyWeekPlan(rules, pass) {
  const ew = rules.easy_week;
  const plan = pass || { slots: [] };
  if (!ew.auto) return plan;
  const slots = [];
  for (const s of plan.slots || []) {
    if (ew.drop.includes(s.muscle)) continue;
    const sets = Math.min(ew.set_factor, s.sets);
    const targets = {};
    for (let n = 1; n <= sets; n++) {
      const t = (s.targets && s.targets[n]) || { load: null, rep_low: null, rep_high: null };
      targets[n] = {
        load: num(t.load) ? (s.assist === true ? t.load : nearestStep(s.step, t.load * ew.load_factor)) : null,
        rep_low: num(t.rep_low) ? Math.max(1, Math.round(t.rep_low * ew.reps_factor)) : null,
        rep_high: num(t.rep_high) ? Math.max(1, Math.round(t.rep_high * ew.reps_factor)) : null
      };
    }
    slots.push({ ...s, sets, targets, reps_left: ew.reps_left, failure_set_n: null, why: 'why.easy' });
  }
  return { ...plan, slots };
}

// ---------------- planDay ----------------

function exMap(exercises) {
  if (exercises instanceof Map) return exercises;
  return new Map((exercises || []).map(e => [e.id, e]));
}
const muscleKey = (ex) => (ex ? (ex.muscle_detail || ex.muscle || null) : null);

function effectiveFlags(block, ex, exerciseId) {
  const bf = block.exercise_flags && own(block.exercise_flags, exerciseId) ? block.exercise_flags[exerciseId] : null;
  return {
    entry: bf,
    no_added_sets: !!((bf && bf.no_added_sets) || (ex && ex.no_added_sets)),
    flags_set: !!((ex && ex.flags_set === true) || bf),
    machine: bf && typeof bf.machine === 'boolean' ? bf.machine : !!(ex && ex.machine)
  };
}

// The one marked set of the day: the first lift by slot order whose template marks it,
// whose exercise is a machine for this block and is screened (health-coach verdict item 3).
function failureSlot(block, tpl, exs) {
  for (const lift of [...tpl.lifts].sort((a, b) => a.slot - b.slot)) {
    if (!lift.failure_set) continue;
    const f = effectiveFlags(block, exs.get(lift.exercise_id), lift.exercise_id);
    if (f.machine && f.flags_set) return lift.slot;
  }
  return null;
}

function rowsFor(dId, block, lift, setCount, targets, repsLeftFor, why) {
  const sides = lift.sides === 'LR' ? ['L', 'R'] : ['none'];
  const rows = [];
  const base = (id, kind, n, side, target) => ({
    id, day_id: dId, block_id: block.id, exercise_id: lift.exercise_id, slot: lift.slot, set_n: n, side, kind, target,
    draft: null, done: null, status: 'planned', origin: 'plan', saved_at: null, first_done_at: null, why
  });
  (lift.warmups || []).forEach((w, i) => {
    for (const s of sides) rows.push(base(dId + ':x' + lift.slot + ':w' + (i + 1) + ':' + s, 'warmup', i + 1, s,
      { load: w.load, rep_low: w.reps, rep_high: w.reps, load_basis: lift.load_basis, count_label: lift.count_label, reps_left_target: null }));
  });
  for (let n = 1; n <= setCount; n++) {
    const t = targets(n);
    for (const s of sides) rows.push(base(dId + ':x' + lift.slot + ':s' + n + ':' + s, 'work', n, s,
      { load: t.load, rep_low: t.rep_low, rep_high: t.rep_high, load_basis: lift.load_basis, count_label: lift.count_label, reps_left_target: repsLeftFor(n) }));
  }
  return rows;
}

const freshDay = (block, pass, day, label) => ({
  id: dayIdOf(block.id, pass, day), block_id: block.id, pass, day, label, status: 'planned',
  started_at: null, done_at: null, done_date: null, scores: {}, notes: '', saved_at: null
});

// One entry per set_n for a slot on a day (L and R count as one set; a miss on either side is a miss).
function setsBySetN(rows) {
  const by = new Map();
  for (const s of rows) {
    const cur = by.get(s.set_n);
    if (!cur) { by.set(s.set_n, { ...s }); continue; }
    if (s.status === 'done' && s.done && (!cur.done || (num(s.done.reps) && num(cur.done.reps) && s.done.reps < cur.done.reps))) by.set(s.set_n, { ...cur, done: s.done, status: 'done' });
  }
  return [...by.values()].sort((a, b) => a.set_n - b.set_n);
}

export function planDay(rules, block, history, dayRef) {
  const out = { day: null, sets: [], notes: [] };
  if (!block || !dayRef) return out;
  const h = history || {};
  const days = (h.days || []).filter(d => d.block_id === block.id);
  const allSets = (h.sets || []).filter(s => s.block_id === block.id);
  const feedback = (h.feedback || []).filter(f => days.some(d => d.id === f.day_id));
  const exs = exMap(h.exercises);
  const { pass, day } = dayRef;
  if (block.passes !== null && block.passes !== undefined && pass > block.passes) return out;
  const tpl = (block.day_templates || []).find(d => d.day === day);
  if (!tpl) return out;
  const dId = dayIdOf(block.id, pass, day);
  const existing = days.find(d => d.id === dId);
  if (existing && existing.status !== 'planned') return out;
  out.day = freshDay(block, pass, day, tpl.label);
  // The day's own sleep answer (health-coach verdict item R4-13): a Yes stops the marked set 2 short.
  const shortSleep = !!(existing && existing.short_sleep_since_last === true);
  const failSlot = failureSlot(block, tpl, exs);
  const markGoal = shortSleep ? rules.effort.short_sleep_failure_reps_left : rules.effort.failure_reps_left;

  // Fixed, and round 1 on any profile: rows exactly as written on the block (health-coach verdict item 2).
  if (isFixed(rules) || pass === 1) {
    for (const lift of tpl.lifts) {
      const t = () => ({ load: lift.start_load, rep_low: lift.rep_low, rep_high: lift.rep_high });
      const goal = (n) => (shortSleep && lift.slot === failSlot && n === lift.sets ? markGoal : lift.reps_left_target);
      out.sets.push(...rowsFor(dId, block, lift, lift.sets, t, goal, 'why.plan'));
      out.notes.push({ slot: lift.slot, delta: 0, why: 'why.plan', row: null, gate: null, sets: lift.sets,
        failure_set_n: lift.slot === failSlot ? lift.sets : null, effort_only_set_n: [], load_why: null });
    }
    return out;
  }

  const ref = { pass, day };
  const ordered = days.slice().sort((a, b) => a.pass - b.pass || a.day - b.day);
  const lastId = dayIdOf(block.id, pass - 1, day);
  const lastDay = days.find(d => d.id === lastId) || null;
  const prevId = dayIdOf(block.id, pass - 2, day);
  const prevDay = days.find(d => d.id === prevId) || null;
  // One round back by position: the N days before this one, N = the number of day templates (TD-3).
  const dayNums = block.day_templates.map(d => d.day).sort((a, b) => a - b);
  const nDays = dayNums.length;
  const posOf = (d) => (d.pass - 1) * nDays + dayNums.indexOf(d.day);
  const refPos = posOf(ref);
  const windowDays = ordered.filter(d => dayNums.includes(d.day) && posOf(d) < refPos && posOf(d) >= refPos - nDays && d.status === 'done');
  // Sleep: every done day in that window, plus this day's own Yes (a blank on the day is not counted yet).
  const sleep = windowDays.map(d => (d.short_sleep_since_last === true || d.short_sleep_since_last === false ? d.short_sleep_since_last : null));
  if (shortSleep) sleep.push(true);
  const easy = !!(rules.easy_week.auto && num(block.passes) && pass === block.passes);
  const failSlots = new Map();
  const failSlotOfDay = (dayNum) => {
    if (!failSlots.has(dayNum)) {
      const t = block.day_templates.find(d => d.day === dayNum);
      failSlots.set(dayNum, t ? failureSlot(block, t, exs) : null);
    }
    return failSlots.get(dayNum);
  };
  // Only the planned failure set is left out of the miss check. A row that says so on its target
  // is read as it says; a row with no such field takes the position rule: the last planned work
  // set of that day's marked slot (health-coach verdict item 3). A set picked to failure by hand counts.
  const markFailure = (rows, slot, dayNum) => {
    const planned = rows.filter(r => r.origin === 'plan');
    const n = planned.length ? maxOf(planned.map(r => r.set_n)) : null;
    const fs = failSlotOfDay(dayNum);
    return rows.map(r => ({ ...r, failure: r.target && own(r.target, 'failure_set') ? r.target.failure_set === true : (slot === fs && r.set_n === n) }));
  };
  const plans = [];

  for (const lift of tpl.lifts) {
    const ex = exs.get(lift.exercise_id);
    const key = muscleKey(ex);
    const flags = effectiveFlags(block, ex, lift.exercise_id);
    const level = key && block.levels && own(block.levels, key) ? block.levels[key] : null;
    const lastRows = allSets.filter(s => s.day_id === lastId && s.slot === lift.slot && s.kind === 'work');
    const lastPlan = lastRows.filter(s => s.origin === 'plan');
    const sameEx = lastPlan.filter(s => s.exercise_id === lift.exercise_id);
    const swapped = lastPlan.length > 0 && sameEx.length === 0;
    const current = lastPlan.length ? new Set(lastPlan.map(s => s.set_n)).size : startingSets(rules, lift, level);

    // Answers: the newest done or skipped day before this one that trained this muscle (TD-3).
    let sig = { pump: null, soreness: null, workload: null, score_max: null };
    const src = ordered.filter(d => before(d, ref) && (d.status === 'done' || d.status === 'skipped'))
      .filter(d => allSets.some(s => s.day_id === d.id && muscleKey(exs.get(s.exercise_id)) === key)).pop();
    if (src && src.status === 'done' && key) {
      const rows = feedback.filter(f => f.day_id === src.id && muscleKey(exs.get(f.exercise_id)) === key);
      for (const k of ANSWER_KEYS) {
        const vals = rows.map(f => f[k]).filter(v => Number.isInteger(v));
        sig[k] = vals.length ? maxOf(vals) : null;   // two exercises of one muscle: bad news counts
      }
      const sc = Object.values(src.scores || {}).filter(num);
      sig.score_max = sc.length ? maxOf(sc) : null;
    }
    // The yes check and the missed goal read the whole window, so a lift on two days of the round is covered (TD-3).
    const winIds = new Set(windowDays.map(d => d.id));
    const fbWin = feedback.filter(f => winIds.has(f.day_id) && f.exercise_id === lift.exercise_id);
    const checkVals = fbWin.flatMap(f => Object.values(f.checks || {})).filter(v => v === true || v === false);
    const check_yes = checkVals.length ? checkVals.includes(true) : null;
    let windowMissed = false;
    for (const d of windowDays) {
      const rows = allSets.filter(s => s.day_id === d.id && s.kind === 'work' && s.exercise_id === lift.exercise_id);
      for (const slot of new Set(rows.map(r => r.slot))) {
        if (missedIn(markFailure(setsBySetN(rows.filter(r => r.slot === slot)), slot, d.day))) windowMissed = true;
      }
    }

    // The load step stays on the same day and slot, one and two rounds back (TD-6).
    const lastSetsN = markFailure(setsBySetN(sameEx), lift.slot, day);
    const prevRows = allSets.filter(s => s.day_id === prevId && s.slot === lift.slot && s.kind === 'work' && s.origin === 'plan' && s.exercise_id === lift.exercise_id);
    const prevSetsN = markFailure(setsBySetN(prevRows), lift.slot, day);
    const lastMissed = lastDay && lastDay.status === 'done' ? missedIn(lastSetsN) : false;
    const prevMissed = prevDay && prevDay.status === 'done' ? missedIn(prevSetsN) : false;
    const goal_before_miss = {};
    for (const s of prevSetsN) if (s.target && num(s.target.rep_low)) goal_before_miss[s.set_n] = s.target.rep_low;

    const added = lastRows.filter(s => s.origin === 'added');
    const hand_add = added.some(s => s.add_scope === 'rest') ? 'rest' : added.length ? 'today' : 'none';

    let sets, why, gate = null, row = null, delta = 0;
    if (easy) { sets = current; why = 'why.easy'; }
    else if (swapped) { sets = current; why = 'why.swap_hold'; }
    else {
      const sd = setDelta(rules, { ...sig, level, check_yes, missed: windowMissed });
      delta = sd.delta; row = sd.row;
      const nw = nextWeekSets(rules, current, sd.delta, { sleep, check_yes, score_max: sig.score_max, missed: windowMissed,
        no_added_sets: flags.no_added_sets, flags_set: flags.flags_set, hand_add, row_why: sd.why });
      sets = nw.sets; why = nw.why; gate = nw.gate;
    }

    // Targets per set_n.
    let targets = {};
    let loadWhy = null;
    if (swapped) {
      for (let n = 1; n <= sets; n++) targets[n] = { load: lift.start_load ?? null, rep_low: lift.rep_low ?? null, rep_high: lift.rep_high ?? null };
    } else if (lastSetsN.length) {
      const nl = nextLoadTarget(rules, { exercise: ex, unit: block.unit, template: lift, flags: flags.entry },
        { sets: lastSetsN, prev_missed: lastMissed && prevMissed, goal_before_miss });
      targets = nl.targets;
      loadWhy = nl.why;
    } else {
      for (let n = 1; n <= sets; n++) targets[n] = { load: lift.start_load ?? null, rep_low: lift.rep_low ?? null, rep_high: lift.rep_high ?? null };
    }
    // A set_n last round had keeps its new target; a set the engine adds starts with an effort goal only (TD-6).
    const tFor = (n) => targets[n] || { load: null, rep_low: null, rep_high: null };
    // The sets at the rep ceiling with no step: the goal stays and shows as an effort goal (TD-6).
    const effortOnly = Object.keys(targets).map(Number).filter(n => n <= sets && targets[n] && targets[n].effort_only === true).sort((a, b) => a - b);
    plans.push({ lift, muscle: key, step: stepFor(rules, ex, block.unit, flags.entry), assist: !!(ex && ex.load_kind === 'assist'),
      sets, tFor, why, gate, row, delta, loadWhy, effortOnly });
  }

  if (easy) {
    const lighter = easyWeekPlan(rules, { slots: plans.map(p => {
      const t = {};
      for (let n = 1; n <= p.sets; n++) t[n] = p.tFor(n);
      return { slot: p.lift.slot, muscle: p.muscle, step: p.step, assist: p.assist, sets: p.sets, targets: t, reps_left: null, failure_set_n: null };
    }) });
    for (const s of lighter.slots) {
      const p = plans.find(x => x.lift.slot === s.slot);
      out.sets.push(...rowsFor(dId, block, p.lift, s.sets, (n) => s.targets[n], () => s.reps_left, 'why.easy'));
      out.notes.push({ slot: s.slot, delta: 0, why: 'why.easy', row: null, gate: null, sets: s.sets, failure_set_n: null, effort_only_set_n: [], load_why: p.loadWhy });
    }
    return out;
  }

  for (const p of plans) {
    const goal = effortTarget(rules, pass, block.passes, p.lift);
    const fsn = p.lift.slot === failSlot ? p.sets : null;
    const repsLeft = (n) => (n === fsn ? markGoal : goal);
    out.sets.push(...rowsFor(dId, block, p.lift, p.sets, p.tFor, repsLeft, p.why));
    out.notes.push({ slot: p.lift.slot, delta: p.delta, why: p.why, row: p.row, gate: p.gate, sets: p.sets, failure_set_n: fsn, effort_only_set_n: p.effortOnly, load_why: p.loadWhy });
  }
  return out;
}

// ---------------- resizeBlock ----------------

export function resizeBlock(rules, block, delta, days) {
  if (!block || (delta !== 1 && delta !== -1)) return { ok: false, error: 'bad request' };
  if (!num(block.passes)) return { ok: false, error: 'open ended block' };
  const ds = (days || []).filter(d => d.block_id === block.id);
  const touched = (d) => d.status !== 'planned';
  const next = block.passes + delta;
  const adaptive = rules.effort.reps_left_by_pass !== null;
  if (adaptive) {
    if (next > rules.effort.length_max) return { ok: false, error: 'longer than the most rounds' };
    if (next < rules.effort.length_min) return { ok: false, error: 'shorter than the fewest rounds' };
    if (ds.some(d => d.pass === block.passes && touched(d))) return { ok: false, error: 'easy round started' };
    if (delta === -1 && ds.some(d => d.pass === block.passes - 1 && touched(d))) return { ok: false, error: 'that round has started' };
  } else {
    const reached = ds.filter(touched).reduce((m, d) => Math.max(m, d.pass), 1);
    if (next < reached) return { ok: false, error: 'below the current round' };
    if (next > rules.effort.length_max) return { ok: false, error: 'longer than the most rounds' };
  }
  const nb = { ...block, passes: next };
  const replan = ds.filter(d => d.status === 'planned' && d.pass <= next).map(d => ({ pass: d.pass, day: d.day }));
  const remove = ds.filter(d => d.status === 'planned' && d.pass > next).map(d => ({ pass: d.pass, day: d.day }));
  return { ok: true, block: nb, replan, remove };
}

// ---------------- buildBlock ----------------

// rules = the whole RULES object. Every block is built Fixed; a profile in the spec is ignored.
export function buildBlock(rules, spec) {
  const s = spec || {};
  return {
    id: s.id, source_id: s.source_id || null, version: s.version || null, id_map: s.id_map || {},
    name: s.name || '', created_at: s.created_at, unit: s.unit || 'lb', profile: 'fixed',
    rules_frozen: { profile: 'fixed', rules_version: rules.rules_version }, profile_switch: null,
    passes: s.passes === undefined ? null : s.passes, notes: s.notes || '', checks: s.checks || [], scores: s.scores || [],
    rule_notes: s.rule_notes || { one_failure_set: '', failure_on_machine: '' },
    exercise_flags: s.exercise_flags || {}, levels: s.levels || {}, switch_conditions: s.switch_conditions || [],
    day_templates: s.day_templates || [], status: 'active'
  };
}

// ---------------- the guided builder: autoBuildDays, fillSlots, sizeWarning (C.3.5, C.3.6) ----------------

// Is a pool row one the builder may place in this slot? Screened for the block (its own flags_set,
// or the block's flag entry merged by the caller as `screened`), not left out of the builder,
// of a picked kind, and of the slot's muscle (a slot with no muscle_detail takes any row of its
// chip). The one gate every builder pick goes through (C.2.5, C.3.6).
function builderEligible(row, slot, kinds) {
  if (!row || !slot) return false;
  const screened = own(row, 'screened') ? row.screened === true : row.flags_set === true;
  if (!screened) return false;
  if (row.left_out_of_builder === true) return false;
  if (kinds && !kinds.includes(row.equipment_detail)) return false;
  if (slot.muscle_detail) return row.muscle_detail === slot.muscle_detail;
  return !!slot.muscle && row.muscle === slot.muscle;
}

// Most done work sets first, then name, then id (health-coach verdict item R4-18).
function builderOrder(a, b) {
  const da = num(a.done_count) ? a.done_count : 0, db = num(b.done_count) ? b.done_count : 0;
  if (da !== db) return db - da;
  const na = String(a.name || ''), nb = String(b.name || '');
  if (na !== nb) return na < nb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const copyDays = (days) => (days || []).map(d => ({ ...d, lifts: (d.lifts || []).map(l => ({ ...l })) }));

// days: the board [{day, label, lifts: [{slot, muscle_detail, muscle?, level, exercise_id, hand?}]}].
// pool: exercise rows, each with screened (or flags_set), left_out_of_builder, equipment_detail,
// muscle_detail, muscle, name, id and done_count. opts: {emptyOnly, equipment: [kinds] (null: any
// kind), only: {day, slot} or null, index: the n-th eligible row for `only` (Suggest one again)}.
// Out { ok, days, filled }. The input is never changed. Never the same exercise twice in a day.
export function fillSlots(rules, days, pool, opts) {
  void rules;
  const o = opts || {};
  const emptyOnly = o.emptyOnly !== false;
  const kinds = Array.isArray(o.equipment) ? o.equipment : null;
  const rows = (pool || []).slice().sort(builderOrder);
  const out = copyDays(days);
  let filled = 0;
  for (const d of out) {
    for (const l of d.lifts) {
      if (o.only) {
        if (!(o.only.day === d.day && o.only.slot === l.slot)) continue;
      } else if (emptyOnly ? l.exercise_id !== null && l.exercise_id !== undefined : l.hand === true) continue;
      const taken = new Set(d.lifts.filter(x => x !== l && x.exercise_id).map(x => x.exercise_id));
      const fits = rows.filter(r => !taken.has(r.id) && builderEligible(r, l, kinds));
      if (!o.only) l.exercise_id = null;
      if (!fits.length) continue;
      const n = o.only && Number.isInteger(o.index) && o.index > 0 ? o.index % fits.length : 0;
      l.exercise_id = fits[n].id;
      if (o.only) l.hand = false;
      filled++;
    }
  }
  return { ok: true, days: out, filled };
}

// levels: {top: [muscle_detail...], middle: [...], bottom: [...]} in his rank order. Out
// { ok, days: [{day, label, lifts: [{slot, muscle_detail, level, exercise_id}]}], dropped:
// [{muscle_detail, level}] }. Same input, same output.
export function autoBuildDays(rules, levels, daysPerRotation, pool) {
  const b = rules && rules.builder;
  if (!isObj(b) || !isObj(b.slots_per_rotation)) return { ok: false, error: 'no builder rules' };
  const n = daysPerRotation;
  if (!Number.isInteger(n) || n < b.days_per_rotation_min || n > b.days_per_rotation_max) return { ok: false, error: 'days per rotation out of range' };
  const lv = isObj(levels) ? levels : {};
  const seen = new Set();
  const order = [];
  for (const level of LEVELS) {
    const list = own(lv, level) ? lv[level] : [];
    if (!Array.isArray(list)) return { ok: false, error: 'level ' + level + ' is not a list' };
    for (const m of list) {
      if (typeof m !== 'string' || !m) return { ok: false, error: 'bad muscle' };
      if (seen.has(m)) return { ok: false, error: 'a muscle on two levels' };
      seen.add(m);
      order.push({ muscle_detail: m, level });
    }
  }
  const days = Array.from({ length: n }, (_, i) => ({ day: i + 1, label: String.fromCharCode(65 + i), lifts: [] }));
  const dropped = [];
  const cap = b.max_lifts_per_day;
  order.forEach((m, rank) => {
    const count = b.slots_per_rotation[m.level][n];
    const perDay = Math.ceil(count / n);
    for (let k = 0; k < count; k++) {
      const start = Math.floor(k * n / count);
      let put = null;
      for (let j = 0; j < n && !put; j++) {
        const d = days[(start + j) % n];
        if (d.lifts.length >= cap) continue;
        if (d.lifts.filter(x => x.muscle_detail === m.muscle_detail).length >= perDay) continue;
        put = d;
      }
      if (!put) { dropped.push({ muscle_detail: m.muscle_detail, level: m.level }); continue; }
      put.lifts.push({ slot: 0, muscle_detail: m.muscle_detail, level: m.level, exercise_id: null, rank });
    }
  });
  for (const d of days) {
    d.lifts.sort((x, y) => x.rank - y.rank);
    d.lifts = d.lifts.map((x, i) => ({ slot: i + 1, muscle_detail: x.muscle_detail, level: x.level, exercise_id: null }));
  }
  const filled = fillSlots(rules, days, pool || [], { emptyOnly: true, equipment: null });
  return { ok: true, days: filled.days, dropped };
}

// The soft per-day warning (TD-8): more than warn_lifts_per_day exercises, or more than
// warn_work_sets_per_day planned work sets (a lift with no set count counts its starting sets).
// Never blocks anything.
export function sizeWarning(rules, day) {
  const b = rules && rules.builder;
  if (!isObj(b) || !day) return false;
  const lifts = day.lifts || [];
  let work = 0;
  for (const l of lifts) work += num(l.sets) ? l.sets : startingSets(rules, l, l.level || null);
  return lifts.length > b.warn_lifts_per_day || work > b.warn_work_sets_per_day;
}

// ---------------- copyStartValues (C.3.8) ----------------

// lift: the source day template lift. roundDoneSets: that slot's set rows of the picked round
// (every status). Out { sets, start_load, rep_low, rep_high }: the planned count of the round
// (origin 'plan' only, a hand-added set never counts), the load of the last done planned work set
// by set_n, else the round's target load, else the lift's own start load (TD-8,
// health-coach verdict item R4-17). Nothing goes up on its own.
export function copyStartValues(rules, lift, roundDoneSets) {
  const c = rules && rules.copy;
  const l = lift || {};
  const rows = (roundDoneSets || []).filter(s => s && s.kind === 'work' && s.origin === 'plan' && (!l.exercise_id || s.exercise_id === l.exercise_id));
  const nums = [...new Set(rows.map(s => s.set_n))];
  const sets = c && c.sets_from === 'planned' && nums.length ? nums.length : (num(l.sets) ? l.sets : null);
  let load = null;
  if (c && c.load_from === 'last_done') {
    const done = rows.filter(s => s.status === 'done' && s.done && num(s.done.load));
    const top = maxOf(done.map(s => s.set_n));
    if (top !== null) load = maxOf(done.filter(s => s.set_n === top).map(s => s.done.load));
  }
  if (load === null && c && c.fallback === 'round_goal') {
    const goal = rows.filter(s => s.target && num(s.target.load));
    const top = maxOf(goal.map(s => s.set_n));
    if (top !== null) load = maxOf(goal.filter(s => s.set_n === top).map(s => s.target.load));
  }
  if (load === null) load = num(l.start_load) ? l.start_load : null;
  return { sets, start_load: load, rep_low: own(l, 'rep_low') ? l.rep_low : null, rep_high: own(l, 'rep_high') ? l.rep_high : null };
}

// ---------------- applyLiveEdit ----------------

// plan = { rules, block, today: { day, sets }, later: [{ pass, day, status }], exercises }
// edit = { type, slot, ... }; scope 'today' or 'rest' (omitted: the table default).
export function applyLiveEdit(plan, edit, scope) {
  const p = plan || {};
  const rules = p.rules;
  const e = edit || {};
  const block = p.block;
  if (!rules || !block || !p.today || !p.today.day) return { ok: false, error: 'bad request' };
  const sc = scope || rules.live_edits[e.type];
  if (sc !== 'today' && sc !== 'rest') return { ok: false, error: 'bad scope' };
  const day = p.today.day;
  if (day.status === 'done' || day.status === 'skipped') return { ok: false, error: 'day is finished' };
  const fixed = isFixed(rules);
  const sets = p.today.sets || [];
  const exs = exMap(p.exercises);
  const slotSets = (slot) => sets.filter(s => s.slot === slot);
  const tplDay = (block.day_templates || []).find(d => d.day === day.day);
  const replan = (p.later || []).filter(d => d.status === 'planned' && !(d.pass === day.pass && d.day === day.day)).map(d => ({ pass: d.pass, day: d.day }));
  const copyBlock = () => JSON.parse(JSON.stringify(block));
  const res = (ops, nb, carry) => ({ ok: true, today_ops: ops, block: nb || block, replan: nb ? replan : [], carry: carry || null });
  const activeSlots = () => [...new Set(sets.filter(s => s.status !== 'skipped').map(s => s.slot))];
  const nextSlot = () => {
    const used = new Set([...sets.map(s => s.slot), ...(tplDay ? tplDay.lifts.map(l => l.slot) : [])]);
    const top = maxOf([...used]);
    let n = (top !== null && top > 0 ? top : 0) + 1;
    while (used.has(n)) n++;
    return n;
  };
  const setId = (slot, kind, n, side) => day.id + ':x' + slot + ':' + (kind === 'warmup' ? 'w' : 's') + n + ':' + side;
  const skipOp = (s, why) => ({ store: 'sets', put: { ...s, status: 'skipped', draft: null, why } });

  switch (e.type) {
    case 'add_set': {
      const exId = (slotSets(e.slot)[0] || {}).exercise_id;
      const f = effectiveFlags(block, exs.get(exId), exId);
      if (f.no_added_sets || !f.flags_set) return { ok: false, error: 'flag' };
      if (sc === 'rest' && fixed) return { ok: false, error: 'rest scope needs Adjust each round' };
      const work = slotSets(e.slot).filter(s => s.kind === 'work');
      if (!work.length) return { ok: false, error: 'no such slot' };
      const top = maxOf(work.map(s => s.set_n));
      const above = work.filter(s => s.set_n === top);
      // The new id takes 1 plus the highest number used in this slot's set ids, every status,
      // so a deleted set's id is never reused; set_n stays top + 1 (TD-7).
      const used = slotSets(e.slot).map(s => /:s(\d+):/.exec(String(s.id))).filter(Boolean).map(m => Number(m[1]));
      const mu = maxOf(used);
      const idN = (mu !== null && mu > top ? mu : top) + 1;
      const taken = new Set(sets.map(s => s.id));
      const ops = above.map(s => ({ store: 'sets', put: {
        ...s, id: setId(e.slot, 'work', idN, s.side), set_n: top + 1, draft: null, done: null, status: 'planned',
        origin: 'added', add_scope: sc, saved_at: null, first_done_at: null, why: 'why.added', target: { ...s.target } } }));
      if (ops.some(o => taken.has(o.put.id))) return { ok: false, error: 'id taken' };
      return res(ops, null, sc === 'rest' ? { slot: e.slot, hand_add: 'rest' } : null);
    }
    case 'skip_set': {
      if (sc !== 'today') return { ok: false, error: 'skip set is today only' };
      const open = slotSets(e.slot).filter(s => s.kind === 'work' && s.status === 'planned');
      if (!open.length) return { ok: false, error: 'nothing to skip' };
      const nextN = minOf(open.map(s => s.set_n));
      if (e.set_n !== nextN) return { ok: false, error: 'not the next set in line' };
      return res(open.filter(s => s.set_n === nextN).map(s => skipOp(s, 'why.skipped')));
    }
    case 'swap': {
      if (!e.exercise_id) return { ok: false, error: 'no exercise' };
      const old = slotSets(e.slot);
      if (!old.length) return { ok: false, error: 'no such slot' };
      const left = old.filter(s => s.kind === 'work' && s.status === 'planned');
      const ns = nextSlot();
      const ops = left.map(s => skipOp(s, 'why.swapped'));
      for (const s of left) ops.push({ store: 'sets', put: {
        ...s, id: setId(ns, 'work', s.set_n, s.side), slot: ns, exercise_id: e.exercise_id, draft: null, done: null, status: 'planned',
        origin: 'added', saved_at: null, first_done_at: null, why: 'why.swapped',
        target: { ...s.target, load: null, rep_low: null, rep_high: null } } });
      if (sc === 'today') return res(ops);
      const nb = copyBlock();
      const td = nb.day_templates.find(d => d.day === day.day);
      const l = td && td.lifts.find(x => x.slot === e.slot);
      const oldId = l ? l.exercise_id : old[0].exercise_id;
      if (l) { l.exercise_id = e.exercise_id; l.start_load = null; l.rep_low = null; l.rep_high = null; }
      // A check asked on the old exercise follows it to the new one (TD-7); a check is never set to null.
      for (const ck of nb.checks || []) if (ck && Array.isArray(ck.lifts)) ck.lifts = ck.lifts.map(x => (x === oldId ? e.exercise_id : x));
      return res(ops, nb);
    }
    case 'move': {
      const order = (day.slot_order && day.slot_order.length ? day.slot_order : [...new Set(sets.map(s => s.slot))].sort((a, b) => a - b)).slice();
      const i = order.indexOf(e.slot), j = i + (e.dir > 0 ? 1 : -1);
      if (i < 0 || j < 0 || j >= order.length) return { ok: false, error: 'cannot move past the end' };
      [order[i], order[j]] = [order[j], order[i]];
      const ops = [{ store: 'days', put: { ...day, slot_order: order } }];
      if (sc === 'today') return res(ops);
      const nb = copyBlock();
      const td = nb.day_templates.find(d => d.day === day.day);
      if (td) {
        const a = td.lifts.findIndex(x => x.slot === e.slot), b = a + (e.dir > 0 ? 1 : -1);
        if (a >= 0 && b >= 0 && b < td.lifts.length) [td.lifts[a], td.lifts[b]] = [td.lifts[b], td.lifts[a]];
      }
      return res(ops, nb);
    }
    case 'remove': {
      if (activeSlots().length <= 1 || (sc === 'rest' && tplDay && tplDay.lifts.length <= 1)) return { ok: false, error: 'last' };
      const ops = slotSets(e.slot).filter(s => s.status === 'planned').map(s => skipOp(s, 'why.skipped'));
      if (sc === 'today') return res(ops);
      const nb = copyBlock();
      const td = nb.day_templates.find(d => d.day === day.day);
      if (td) td.lifts = td.lifts.filter(x => x.slot !== e.slot);
      return res(ops, nb);
    }
    case 'add_exercise': {
      if (!e.exercise_id) return { ok: false, error: 'no exercise' };
      const ns = nextSlot();
      const level = (() => { const k = muscleKey(exs.get(e.exercise_id)); return k && block.levels && own(block.levels, k) ? block.levels[k] : null; })();
      const n = fixed ? (Number.isInteger(e.sets) && e.sets > 0 ? e.sets : 1) : startingSets(rules, { sets: e.sets }, level);
      const lift = { slot: ns, exercise_id: e.exercise_id, sets: n, rep_low: null, rep_high: null, start_load: null, failure_set: false,
        reps_left_target: e.reps_left_target ?? null, warmups: [], sides: e.sides === 'LR' ? 'LR' : 'none', load_basis: e.load_basis || 'total', count_label: null, note: '' };
      const ops = rowsFor(day.id, block, lift, n, () => ({ load: null, rep_low: null, rep_high: null }), () => lift.reps_left_target, 'why.added')
        .map(r => ({ store: 'sets', put: { ...r, origin: 'added', add_scope: 'today' } }));
      if (sc === 'today') return res(ops);
      const nb = copyBlock();
      const td = nb.day_templates.find(d => d.day === day.day);
      if (td) td.lifts.push(lift);
      return res(ops, nb);
    }
    case 'relabel': {
      const label = typeof e.label === 'string' ? e.label : '';
      const ops = [{ store: 'days', put: { ...day, label } }];
      if (sc === 'today') return res(ops);
      const nb = copyBlock();
      const td = nb.day_templates.find(d => d.day === day.day);
      if (td) td.label = label;
      return res(ops, nb);
    }
    default:
      return { ok: false, error: 'unknown edit' };
  }
}

// ---------------- feedbackDue ----------------

// ctx = { trained_before, one_set, soreness_asked_today, soreness_put_off, has_planned_set, moment }
// moment: 'first_tick' (the soreness-alone sheet), 'tick' (the block checks), 'end' (the end sheet).
export function feedbackDue(rules, day, muscle, ctx) {
  void day; void muscle;
  const c = ctx || {};
  const atFirstTick = rules.signals.soreness.asked === 'first_tick';
  if (c.moment === 'tick') return { ask: c.has_planned_set === false ? [] : ['checks'] };
  if (c.moment === 'first_tick') {
    if (atFirstTick && c.trained_before === true && c.one_set !== true && c.soreness_asked_today !== true) return { ask: ['soreness'] };
    return { ask: [] };
  }
  if (c.moment === 'end') {
    const sorenessNow = !atFirstTick || c.one_set === true || c.trained_before !== true || c.soreness_asked_today !== true || c.soreness_put_off === true;
    return { ask: sorenessNow ? ['pump', 'soreness', 'workload', 'checks'] : ['pump', 'workload', 'checks'] };
  }
  return { ask: [] };
}

// ---------------- currentPosition ----------------

export function currentPosition(block, days) {
  if (!block) return null;
  const mine = (days || []).filter(d => d.block_id === block.id);
  const open = mine.find(d => d.status === 'open');
  if (open) return open.id;
  const planned = mine.filter(d => d.status === 'planned').sort((a, b) => a.pass - b.pass || a.day - b.day);
  return planned.length ? planned[0].id : null;
}
