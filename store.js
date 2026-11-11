// store.js - every training rule that touches saved rows (DESIGN 5.2, 5.3, 5.5).
// It talks to the database through the db object it is given, and reads time only
// from the clock it is given, so node tests run it on a fake db with a fake clock.
import { APP_VERSION } from './version.js';
import {
  STORE_NAMES, DEVICE_KEYS, LIMITS, SNAPSHOT_REASONS, validateBackup, validateSnapshotRow, validateBlock, migrate,
  buildBackup, repPairOk, markerOk, lineOk, textOk, minOf, maxOf, MUSCLES, EQUIPMENT
} from './backup.js';
import { SEED_EXERCISES, SEED_IDS } from './data/exercises.js';
import { t } from './ui/strings.js';

const ID_RE = /^[A-Za-z0-9:_-]{1,120}$/;
const STALE_MS = 12 * 3600 * 1000;      // design number: the "Finish it?" card
const SINCE_MAX_MS = 3 * 3600 * 1000;   // design number: "Since last set" hides after 3 hours
const KEEP_SNAPSHOTS = 3;
const NOTE_MS = 60 * 1000;              // a restore note older than this is dropped unseen (A3-R8)
const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

// The exercise as this block uses it (R4-04, R4-06, R4-15, r4.1 Q14, Q18). One function, read by
// every reader. A block entry screens the exercise (flags_set true) and its guard flags and
// machine flag win. Steps, in the read order: the block's list of loads (in weight_steps), then
// the block's step size (in step, with the row's list put aside), then the row's own list, then
// the row's step_default (lb blocks only, read by the stepper, r4.1 Q13). The row is never changed.
export function effectiveExercise(block, ex) {
  if (!ex) return ex;
  const flags = block && block.exercise_flags;
  const f = own(flags, ex.id) ? flags[ex.id] : null;
  if (!f) return ex;
  const out = { ...ex, flags_set: true };
  for (const k of ['no_added_sets', 'left_out_of_builder', 'machine']) if (typeof f[k] === 'boolean') out[k] = f[k];
  if (Array.isArray(f.weight_steps) && f.weight_steps.length) out.weight_steps = [...f.weight_steps];
  else if (typeof f.step === 'number' && f.step > 0) { out.weight_steps = null; out.step = f.step; }
  return out;
}

// The block checks asked on an exercise (15 Part 17, R4-03): a check with lifts null is asked on
// every exercise, else only on the ids its list holds.
export function checksFor(block, exerciseId) {
  return ((block && block.checks) || []).filter(c => c.lifts === null || c.lifts === undefined || (Array.isArray(c.lifts) && c.lifts.includes(exerciseId)));
}

// The cards of a day in their order (A1-5): the day's slot_order first, then any slot not in
// it by number; a number in it with no set on the day is left out.
export function slotsInOrder(day, sets) {
  const have = [...new Set(sets.map(s => s.slot))].sort((a, b) => a - b);
  const order = (day && Array.isArray(day.slot_order) ? day.slot_order : []).filter(sl => have.includes(sl));
  return [...order, ...have.filter(sl => !order.includes(sl))];
}

// A written slot_order never passes LIMITS.SLOT_ORDER (14.8 G15, review P12). Each swap adds a
// slot and the old one keeps its skipped sets, so a long day of swaps can pass the cap. First
// slots where every set is skipped go, from the end; then the list is cut to the cap as the last
// step. slotsInOrder puts any slot left out after the rest in number order.
export function capOrder(order, sets) {
  if (order.length <= LIMITS.SLOT_ORDER) return order;
  const out = order.slice();
  const allSkipped = (sl) => { const rows = sets.filter(x => x.slot === sl); return rows.length > 0 && rows.every(x => x.status === 'skipped'); };
  for (let i = out.length - 1; i >= 0 && out.length > LIMITS.SLOT_ORDER; i--) if (allSkipped(out[i])) out.splice(i, 1);
  return out.slice(0, LIMITS.SLOT_ORDER);
}

// A block row always holds every r4 lift and check field, so a backup and a restore give
// back the same rows (R4-04: missing means the Slice 1 behavior).
function fullTemplates(dts) {
  return dts.map(d => ({ ...d, lifts: d.lifts.map(l => ({ short_note: '', goal_line: '', ...l, warmups: l.warmups || [] })) }));
}
const fullChecks = (cks) => (cks || []).map(c => ({ ...c, lifts: c.lifts === undefined ? null : c.lifts }));

// The name a blank block name saves as (15 Part 2): the smallest whole number at or above
// (blocks on the phone + 1) that no block name already uses.
export function defaultBlockName(blocks) {
  const used = new Set(blocks.map(b => b.name));
  let n = blocks.length + 1;
  while (used.has(t('builder.defaultname', { n }))) n++;
  return t('builder.defaultname', { n });
}

// Set ids keep their numbers (r4 review R12): a new set takes 1 plus the highest number the
// slot's ids already use for its letter ('s' work, 'w' warm-up), never set_n, so an id is
// never put over a row that still exists. The order on screen comes from set_n.
const ID_N_RE = /:x\d+:([sw])(\d+):(L|R|none)$/;
const SET_DAY_RE = /^(.*):x\d+:[sw]\d+:(L|R|none)$/;
export function nextIdNum(sets, letter) {
  let m = 0;
  for (const x of sets) { const r = ID_N_RE.exec(x.id); if (r && r[1] === letter) m = Math.max(m, Number(r[2])); }
  return m + 1;
}

// Why a set may not be deleted, or null when it may (15 Part 10, R24): only a planned set
// whose draft is empty or a copy, never the last set row of its slot. On LR the pair goes
// together, and only if both rows pass.
export function deleteReason(slotRows, s) {
  const pair = slotRows.filter(x => x.id !== s.id && s.side !== 'none' && x.kind === s.kind && x.set_n === s.set_n && x.side !== 'none');
  pair.push(s);
  for (const x of pair) if (x.status !== 'planned') return 'done';
  for (const x of pair) if (x.draft !== null && x.draft.from_copy !== true) return 'draft';
  if (slotRows.filter(x => !pair.some(p => p.id === x.id)).length < 1) return 'last';
  return null;
}

// Breaks on a laps set (15 Part 16, R4-14): 0 to 3 (3 = three or more). Not answered stays
// null, never 0. Any other value is refused, so a bad tap can never store a made-up count.
export function breaksOf(v) {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || v < 0 || v > LIMITS.BREAKS_MAX) throw new Refused('bad breaks');
  return v;
}

// The Day done numbers of a day's sets (15 Part 14, LOOK 4.10): work sets done, exercises done (a
// slot with at least one done set), exercises skipped (a slot with no done set; a slot swapped out
// today is left out, its swap-in has its own card).
export function dayTotalsOf(sets) {
  const slots = [...new Set(sets.map(s => s.slot))];
  let exDone = 0, exSkipped = 0;
  for (const sl of slots) {
    const rows = sets.filter(s => s.slot === sl);
    if (rows.some(s => s.status === 'done')) exDone++;
    else if (!rows.some(s => s.status === 'skipped' && s.why === 'Swapped by you')) exSkipped++;
  }
  return { workDone: sets.filter(s => s.kind === 'work' && s.status === 'done').length, exDone, exSkipped };
}

export class NotSaved extends Error { constructor() { super('not saved'); this.name = 'NotSaved'; } }
export class Refused extends Error { constructor(code) { super(code); this.name = 'Refused'; this.code = code; } }

// His typed text, checked with the validator's own rule before any write is queued (SR3, SR11).
// Undefined reads as empty, the value the row would store.
function checkText(kind, v) {
  if (!textOk(kind, v === undefined || v === null ? '' : v)) throw new Refused('bad text');
}

// The local calendar date of a time, never cut from a UTC string.
export function localDate(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

const dayId = (blockId, pass, day) => blockId + ':p' + pass + ':d' + day;
const newDay = (id, blockId, pass, day, label) => ({
  id, block_id: blockId, pass, day, label, status: 'planned', started_at: null, done_at: null, done_date: null,
  scores: {}, notes: '', saved_at: null, slot_order: null
});
const sideOrder = { L: 0, R: 1, none: 2 };
export function setOrder(a, b) {
  return a.slot - b.slot || (a.kind === b.kind ? 0 : a.kind === 'warmup' ? -1 : 1) || a.set_n - b.set_n || sideOrder[a.side] - sideOrder[b.side];
}

// A name like __proto__ or constructor is never an id: it would read back an object, not a string.
export const reservedName = (id) => id === '__proto__' || id in Object.prototype;

function checkId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id) || reservedName(id)) throw new Refused('bad id');
  return id;
}

// Finish day shows on an open day, and on a planned day once every set on it was skipped by
// him (DESIGN 5.2, C34). finishDay itself also needs one done set (R4-02): a day with none
// is ended by Skip day, and the button then says so.
export function finishable(day, sets) {
  if (!day) return false;
  if (day.status === 'open') return true;
  return day.status === 'planned' && sets.length > 0 && sets.every(s => s.status !== 'planned');
}

export function createStore(opts) {
  const db = opts.db;
  const now = opts.now || (() => Date.now());
  const setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer || ((h) => clearTimeout(h));
  const uuid = opts.uuid || (() => globalThis.crypto.randomUUID());
  const LIMIT_MS = opts.writeLimitMs || 4000;
  // The read and plan part of a whole-database job ends within this, or the job ends as Not saved (SB4).
  const READ_LIMIT_MS = opts.readLimitMs || 2 * LIMIT_MS;
  const listeners = new Set();
  const queues = new Map();
  // Whole-database writes (restore, undo, erase, safety copy) hold this gate: every day
  // queue drains first, and a write tapped while one runs waits for it to finish (R3).
  let gate = Promise.resolve();
  let pending = 0;                 // writes started and not yet settled (store.busy)
  const idleWaiters = [];

  const changed = () => { for (const fn of listeners) { try { fn(); } catch (_) { /* a screen error never stops a save */ } } };

  // ---------------- guarded writes (5.3 Writes) ----------------

  function settle(promises, ms) {
    return new Promise((resolve) => {
      let left = promises.length, over = false;
      const h = setTimer(() => { over = true; resolve('timeout'); }, ms);
      for (const p of promises) {
        p.then(() => { if (!over) { over = true; clearTimer(h); resolve('ok'); } },
          () => { left--; if (!left && !over) { over = true; clearTimer(h); resolve('err'); } });
      }
    });
  }

  async function attempt(fn) {
    const p1 = Promise.resolve().then(fn);
    let firstErr = null;
    p1.catch((e) => { firstErr = e; });
    const r1 = await settle([p1], LIMIT_MS);
    if (r1 === 'ok') return true;
    // A refusal is an answer, not a lost link: it is never retried.
    if (r1 === 'err' && firstErr instanceof Refused) throw firstErr;
    db.resetLink();
    const p2 = Promise.resolve().then(fn);
    p2.catch(() => {});
    // A late first write still counts. Every write is safe to run twice (review P9): it puts the
    // same rows again, or it keeps what its first try planned and returns with no write when
    // those rows are already there (finishDay, tick, addSet, addSetBelow, moveSlot, swap, skips).
    if (await settle([p1, p2], LIMIT_MS) === 'ok') return true;
    throw new NotSaved();
  }

  // One queue per key, so writes run in tap order. Every set and day write of one day
  // shares the key 'day:<id>', and each one reads its rows INSIDE the queue, so a write
  // is never built from a row that an earlier queued write was about to change (C3).
  function queued(key, fn) {
    pending++;
    const prev = queues.get(key) || Promise.resolve();
    const held = gate;
    const next = Promise.all([prev.catch(() => {}), held.catch(() => {})]).then(() => attempt(fn));
    queues.set(key, next);
    next.finally(() => {
      if (queues.get(key) === next) queues.delete(key);
      pending--;
      if (!pending) for (const w of idleWaiters.splice(0)) w();
    }).catch(() => {});
    return next.then((r) => { changed(); return r; });
  }
  // One whole-database job: it starts when every queued write has settled and the gate
  // before it is open, and new queued writes wait behind it. Each write step inside it goes
  // through job.write(), which goes through attempt(), so it gets the 4 s limit, the link
  // reset and one retry. The reads and the plan between two writes are bounded too (SB4): a
  // read that never answers ends the job as Not saved within READ_LIMIT_MS, the link is reset
  // and the gate opens again, so a tick tapped after it still saves. The late body can never
  // write after that: job.write() refuses once the job was cut off, and a batch is one
  // transaction, so the check right before it is the fence. The body never runs twice, so
  // every uuid() and now() draw stays where it is.
  function exclusive(fn) {
    pending++;
    const drain = Promise.all([gate, ...queues.values()].map(p => p.catch(() => {})));
    const run = drain.then(() => new Promise((resolve, reject) => {
      let h = null, over = false;
      const disarm = () => { if (h !== null) { clearTimer(h); h = null; } };
      const arm = () => {
        disarm();
        if (over) return;
        h = setTimer(() => {
          h = null;
          if (over) return;
          over = true;
          job.aborted = true;
          db.resetLink();
          reject(new NotSaved());
        }, READ_LIMIT_MS);
      };
      const job = {
        aborted: false,
        async write(w) {
          if (job.aborted) throw new NotSaved();
          disarm();
          try { return await attempt(w); } finally { arm(); }
        }
      };
      arm();
      Promise.resolve().then(() => fn(job)).then(
        (r) => { if (!over) { over = true; disarm(); resolve(r); } },
        (e) => { if (!over) { over = true; disarm(); reject(e); } });
    }));
    gate = run;
    run.finally(() => {
      if (gate === run) gate = Promise.resolve();
      pending--;
      if (!pending) for (const w of idleWaiters.splice(0)) w();
    }).catch(() => {});
    return run.then((r) => { changed(); return r; });
  }
  const dayKey = (dId) => 'day:' + dId;
  // A set id starts with its day id (dayId + ':x' + slot ...), so the key is known with no
  // read first: a tap joins the queue at the moment of the tap, in tap order. The day id is read
  // with an anchored pattern, so a block id that itself holds ':x' still gives the right day (SR9).
  const setKey = (setId) => { const m = SET_DAY_RE.exec(String(setId)); return dayKey(m ? m[1] : String(setId).split(':x')[0]); };
  const busy = () => pending > 0;
  const idle = () => (pending ? new Promise((res) => idleWaiters.push(res)) : Promise.resolve());

  const batch = (ops) => {
    for (const o of ops) checkId(o.store === 'settings' ? 'k' : ('put' in o ? o.put.id : o.del));
    return db.batch(ops);
  };

  // ---------------- settings and seed ----------------

  const getSetting = (k, fb) => db.setting(k, fb);
  // Queued like every other write, so it gets the 4 s limit and one retry (R3).
  const setSetting = async (k, v) => { await queued('setting:' + k, () => db.setSetting(k, v)); };

  // One exclusive job (r4.3 H1): the read that keeps his note and link runs inside the same job
  // as the write, so a note saved while the seed runs waits behind it and is never put back.
  function seed() {
    return exclusive(async (job) => {
      const have = await db.all('exercises');
      const byId = new Map(have.map(r => [r.id, r]));
      const version = await db.setting('seeded_version', null);
      const missing = SEED_IDS.some(id => !byId.has(id));
      if (version === APP_VERSION && !missing) return false;
      const ops = [];
      for (const r of SEED_EXERCISES) {
        const old = byId.get(r.id);
        if (old && old.edited === true) continue;
        // His note and video link on a list row are his, so a list update keeps them (17 C.2.6).
        ops.push({ store: 'exercises', put: { ...r, notes: old ? old.notes : r.notes, link: old ? old.link : r.link } });
      }
      ops.push({ store: 'settings', put: { key: 'seeded_version', value: APP_VERSION } });
      // One write for the whole list, with the 4 s limit and one retry like every other write.
      await job.write(() => batch(ops));
      return true;
    });
  }

  // ---------------- reading ----------------

  async function exercisesMap() {
    return new Map((await db.all('exercises')).map(r => [r.id, r]));
  }

  async function activeBlock() {
    const id = await db.setting('active_block_id', null);
    return id ? (await db.get('blocks', id)) || null : null;
  }

  async function openDay() {
    const days = await db.all('days');
    return days.find(d => d.status === 'open') || null;
  }

  async function isDayOpen() { return !!(await openDay()); }

  // The day Today shows: the open day, else the first planned day of the active block.
  async function currentDay() {
    const open = await openDay();
    if (open) return open;
    const block = await activeBlock();
    if (!block) return null;
    const days = (await db.byIndex('days', 'block_id', block.id)).filter(d => d.status === 'planned');
    days.sort((a, b) => a.pass - b.pass || a.day - b.day);
    return days[0] || null;
  }

  async function dayView(id) {
    const day = await db.get('days', id);
    if (!day) return null;
    const block = await db.get('blocks', day.block_id);
    const sets = (await db.byIndex('sets', 'day_id', id)).sort(setOrder);
    const feedback = await db.byIndex('feedback', 'day_id', id);
    return { day, block, sets, feedback, exercises: await exercisesMap(), slots: slotsInOrder(day, sets) };
  }

  // ---------------- planning ----------------

  function planSets(dId, blockId, lift, origin, why) {
    const sides = lift.sides === 'LR' ? ['L', 'R'] : ['none'];
    const rows = [];
    const base = (id, kind, n, side, target) => ({
      id, day_id: dId, block_id: blockId, exercise_id: lift.exercise_id, slot: lift.slot, set_n: n, side, kind, target,
      draft: null, done: null, status: 'planned', origin, saved_at: null, first_done_at: null, why
    });
    lift.warmups.forEach((w, i) => {
      for (const s of sides) rows.push(base(dId + ':x' + lift.slot + ':w' + (i + 1) + ':' + s, 'warmup', i + 1, s,
        { load: w.load, rep_low: w.reps, rep_high: w.reps, load_basis: lift.load_basis, count_label: lift.count_label, reps_left_target: null }));
    });
    for (let n = 1; n <= lift.sets; n++) {
      for (const s of sides) rows.push(base(dId + ':x' + lift.slot + ':s' + n + ':' + s, 'work', n, s,
        { load: lift.start_load, rep_low: lift.rep_low, rep_high: lift.rep_high, load_basis: lift.load_basis, count_label: lift.count_label, reps_left_target: lift.reps_left_target }));
    }
    return rows;
  }

  // The weight a set shows: its draft load, else its target load.
  const shownLoad = (x) => (x.draft && x.draft.load !== null && x.draft.load !== undefined) ? x.draft.load : x.target.load;
  // A copied draft holds the load only; its other fields show the target (15 Part 6).
  const copiedDraft = (load) => ({ load, reps: null, reps_left: null, reps_left_plus: false, failure: false, from_copy: true, breaks: null });

  // The write guard (M16): only a planned set with no done and no draft may be written by planning.
  const writable = (s) => s.status === 'planned' && s.done === null && s.draft === null;

  // Ops that (re)plan one day of a block. A day that is not planned is never touched.
  async function planDayOps(block, pass, dayN, opts2) {
    const tpl = block.day_templates.find(d => d.day === dayN);
    if (!tpl) return [];
    const id = dayId(block.id, pass, dayN);
    const existing = await db.get('days', id);
    if (existing && existing.status !== 'planned') return [];
    const old = existing ? await db.byIndex('sets', 'day_id', id) : [];
    if (opts2 && opts2.wholeDayGuard && old.some(s => s.status === 'planned' && s.draft !== null)) return null;
    const ops = [];
    const oldById = new Map(old.map(s => [s.id, s]));
    // A slot that holds only his own rows (a swap) is his; a new plan lift never takes it (C4).
    const swapSlots = new Set(old.filter(s => s.origin === 'added').map(s => s.slot)
      .filter(sl => !old.some(s => s.slot === sl && s.origin === 'plan')));
    const want = new Set();
    for (const lift of tpl.lifts) {
      if (swapSlots.has(lift.slot)) continue;
      for (const row of planSets(id, block.id, lift, 'plan', 'As written on your block')) {
        want.add(row.id);
        const was = oldById.get(row.id);
        if (was && (!writable(was) || was.origin === 'added')) continue;
        ops.push({ store: 'sets', put: row });
      }
    }
    // A planned set from the old plan that the new plan no longer holds goes away.
    for (const s of old) if (!want.has(s.id) && s.origin === 'plan' && writable(s)) ops.push({ store: 'sets', del: s.id });
    if (!existing) {
      ops.unshift({ store: 'days', put: newDay(id, block.id, pass, dayN, tpl.label) });
      return ops;
    }
    // The card order keeps only the slots that still hold a set after these ops (review P8):
    // a Move up or down, then a block update that drops that lift, must never leave the day
    // naming a slot with no set, or every later backup and safety copy is refused.
    const gone = new Set(ops.filter(o => 'del' in o).map(o => o.del));
    const slots = new Set(old.filter(s => !gone.has(s.id)).map(s => s.slot));
    for (const o of ops) if ('put' in o) slots.add(o.put.slot);
    const kept = Array.isArray(existing.slot_order) ? existing.slot_order.filter(sl => slots.has(sl)) : null;
    const order = kept && kept.length ? kept : null;
    const sameOrder = JSON.stringify(order) === JSON.stringify(existing.slot_order === undefined ? null : existing.slot_order);
    if (existing.label !== tpl.label || !sameOrder) ops.unshift({ store: 'days', put: { ...existing, label: tpl.label, slot_order: order } });
    // A feedback row on a slot that no longer holds a set goes too, in the same ops (SB5): a
    // pending row with no set would hold Finish day on a sheet that has nothing to ask.
    for (const f of await db.byIndex('feedback', 'day_id', id)) {
      if (!slots.has(Number(String(f.id).split(':x').pop()))) ops.push({ store: 'feedback', del: f.id });
    }
    return ops;
  }

  function nextPosition(block, pass, dayN) {
    const days = block.day_templates.map(d => d.day).sort((a, b) => a - b);
    const i = days.indexOf(dayN);
    if (i >= 0 && i + 1 < days.length) return { pass, day: days[i + 1] };
    if (block.passes !== null && pass + 1 > block.passes) return null;
    return { pass: pass + 1, day: days[0] };
  }

  function blockRow(spec, t) {
    return {
      id: spec.id, source_id: spec.source_id || null, version: spec.version || null, id_map: spec.id_map || {},
      name: spec.name || '', created_at: t, unit: spec.unit || 'lb', profile: 'fixed',
      rules_frozen: { profile: 'fixed', rules_version: 'none' }, passes: spec.passes === undefined ? null : spec.passes,
      notes: spec.notes || '', checks: fullChecks(spec.checks), scores: spec.scores || [],
      rule_notes: spec.rule_notes || { one_failure_set: '', failure_on_machine: '' },
      exercise_flags: spec.exercise_flags || {}, day_templates: fullTemplates(spec.day_templates), status: 'active'
    };
  }

  // The rules a new block must pass before any op is built.
  function checkSpec(spec) {
    checkText('blockname', spec.name);
    checkText('note', spec.notes);
    // No repeated day number, and no repeated slot in one day: the validator refuses both (SR12).
    const dayNs = spec.day_templates.map(d => d.day);
    if (new Set(dayNs).size !== dayNs.length) throw new Refused('bad block');
    for (const d of spec.day_templates) { const sl = d.lifts.map(l => l.slot); if (new Set(sl).size !== sl.length) throw new Refused('bad block'); }
    // A rep range is both empty, or a low end with a high end at or above it, or a low end
    // with an open top (R4-05). The validator holds the same rule for files.
    for (const d of spec.day_templates) {
      // A day with no exercise is never saved (15 Part 3, the second guard behind Review).
      if (!d.lifts.length) throw new Refused('empty day');
      // A day label passes the same line rule as relabelDay and the validator (SR5), so a pasted
      // tab or other control character never reaches a block or a day row. newBlockOps runs this
      // inside the block write, so a block file is checked here too.
      if (!lineOk(d.label === undefined || d.label === null ? '' : d.label, LIMITS.LABEL)) throw new Refused('bad label');
      for (const l of d.lifts) {
        if (!repPairOk(l.rep_low === undefined ? null : l.rep_low, l.rep_high === undefined ? null : l.rep_high)) throw new Refused('bad rep range');
        checkText('note', l.note);
        checkText('words', l.short_note);
        checkText('words', l.goal_line);
      }
    }
  }

  // The ops of a new block (r4.3 H1): the block, the days and sets of round 1, and the active
  // block op when o.activate. Writes nothing. spec carries its id and unit already, so a retry
  // builds the same rows. A blank name takes the default name from the blocks rows the caller
  // read inside its own queue or exclusive job (15 Part 2).
  function newBlockOps(spec, extraOps, blocks, o) {
    checkSpec(spec);
    const block = blockRow(spec, o.t);
    if (!String(block.name).trim()) block.name = defaultBlockName(blocks.filter(b => b.id !== block.id));
    const ops = [...(extraOps || []), { store: 'blocks', put: block }];
    for (const d of block.day_templates) {
      const id = dayId(block.id, 1, d.day);
      ops.push({ store: 'days', put: newDay(id, block.id, 1, d.day, d.label) });
      for (const lift of d.lifts) for (const r of planSets(id, block.id, lift, 'plan', 'As written on your block')) ops.push({ store: 'sets', put: r });
    }
    if (o.activate) ops.push({ store: 'settings', put: { key: 'active_block_id', value: block.id } });
    return { block, ops };
  }

  // Save a new block: the block, the days and sets of round 1, and make it active.
  async function createBlock(spec, extraOps) {
    checkSpec(spec);
    const t = now();
    const unit = spec.unit || await db.setting('unit', 'lb');
    const full = { ...spec, id: spec.id || 'b' + uuid(), unit };
    let block = null;
    // The blocks read for a blank name runs inside the block write (15 Part 2).
    await queued('block', async () => {
      const r = newBlockOps(full, extraOps, await db.all('blocks'), { t, activate: true });
      block = r.block;
      return batch(r.ops);
    });
    return block;
  }

  // ---------------- logging (5.3 Today) ----------------

  async function getSet(id) {
    const s = await db.get('sets', id);
    if (!s) throw new Refused('no such set');
    return s;
  }

  // Tick a set done. The first saved tick of a day opens it and sets started_at.
  async function tick(setId, values) {
    let row = null;
    await queued(setKey(setId), async () => {
      const s = await getSet(setId);
      // A retry after a late first commit: the row it wrote is there, so nothing more (P9).
      if (row && s.status === 'done' && s.saved_at === row.saved_at) return undefined;
      const day = await db.get('days', s.day_id);
      const block = await db.get('blocks', s.block_id);
      if (day.status === 'done') throw new Refused('day is done');
      const t = now();
      const v = values || s.draft || {};
      row = {
        ...s,
        done: {
          load: v.load === undefined ? s.target.load : v.load, reps: v.reps === undefined ? s.target.rep_high : v.reps,
          reps_left: v.reps_left === undefined ? null : v.reps_left, reps_left_plus: !!v.reps_left_plus,
          failure: !!v.failure, unit: block.unit, breaks: breaksOf(v.breaks)
        },
        draft: null, status: 'done', saved_at: t, first_done_at: s.first_done_at === null ? t : s.first_done_at
      };
      const tickOps = [{ store: 'sets', put: row }];
      if (day.status === 'planned') tickOps.push({ store: 'days', put: { ...day, status: 'open', started_at: day.started_at === null ? t : day.started_at, saved_at: t } });
      return batch(tickOps);
    });
    return row;
  }

  // Undo a tick while the day is open.
  async function untick(setId) {
    let row = null;
    await queued(setKey(setId), async () => {
      const s = await getSet(setId);
      if (s.status !== 'done') { row = s; return undefined; }
      row = { ...s, done: null, status: 'planned', saved_at: now() };
      return batch([{ store: 'sets', put: row }]);
    });
    return row;
  }

  // An edited value on a set not yet ticked: kept as a draft so a relaunch shows it.
  // The status is read inside the queue, so a draft never lands on a set a queued tick made done.
  // A typed or stepped draft is never a copy, so from_copy is false here (15 Part 6).
  async function saveDraft(setId, draft) {
    const d = {
      load: draft.load === undefined ? null : draft.load, reps: draft.reps === undefined ? null : draft.reps,
      reps_left: draft.reps_left === undefined ? null : draft.reps_left, reps_left_plus: !!draft.reps_left_plus, failure: !!draft.failure,
      from_copy: false, breaks: breaksOf(draft.breaks)
    };
    let row = null;
    await queued(setKey(setId), async () => {
      const s = await getSet(setId);
      if (s.status !== 'planned') { row = s; return undefined; }
      const t = now();
      row = { ...s, draft: d, saved_at: t };
      const ops = [{ store: 'sets', put: row }];
      // Weight copies down (15 Part 6): a changed load on a planned work set goes to every LATER
      // planned work set of the same slot and side whose draft is empty or a copy. Never up,
      // never over a typed draft, never onto a done, skipped or warm-up set, never from a warm-up.
      const old = shownLoad(s);
      if (s.kind === 'work' && d.load !== null && d.load !== old) {
        // Carry-down (15 Part 7), read inside the same write: with the switch on, a later set that
        // shows the OLD weight changes too, a typed draft included. Done and skipped sets never do.
        const carry = (await db.setting('carry_down', false)) === true;
        const later = (await slotSets(s.day_id, s.slot)).filter(x => x.id !== s.id && x.kind === 'work' && x.side === s.side && x.set_n > s.set_n && x.status === 'planned');
        for (const x of later) {
          const copyOk = x.draft === null || x.draft.from_copy === true;
          if (copyOk) ops.push({ store: 'sets', put: { ...x, draft: copiedDraft(d.load), saved_at: t } });
          else if (carry && shownLoad(x) === old) ops.push({ store: 'sets', put: { ...x, draft: { ...x.draft, load: d.load }, saved_at: t } });
        }
      }
      return batch(ops);   // the edit and every copy in one write (15 Part 6)
    });
    return row;
  }

  async function slotSets(dId, slot) {
    return (await db.byIndex('sets', 'day_id', dId)).filter(s => s.slot === slot).sort(setOrder);
  }

  // The rows are picked inside the queue, from a fresh read.
  async function markSkipped(dId, slot, pick, why) {
    let ids = [];
    let tries = 0;
    await queued(dayKey(dId), async () => {
      const t = now();
      const all = await slotSets(dId, slot);
      // A retry after a late first commit: the rows the first try picked are skipped already (P9).
      if (tries++ && ids.length && ids.every(id => all.some(x => x.id === id && x.status === 'skipped'))) return undefined;
      const rows = pick(all);
      ids = rows.map(s => s.id);
      if (!rows.length) return undefined;
      return batch(rows.map(s => ({ store: 'sets', put: { ...s, status: 'skipped', why, draft: null, saved_at: t } })));
    });
    return ids;
  }

  // Skip set: the open row (the first set still planned) becomes skipped.
  async function skipSet(dId, slot) {
    const ids = await markSkipped(dId, slot, (sets) => { const o = sets.find(s => s.status === 'planned'); return o ? [o] : []; }, 'Skipped by you');
    return ids[0] || null;
  }

  async function unskip(setId) {
    let row = null;
    await queued(setKey(setId), async () => {
      const s = await getSet(setId);
      if (s.status !== 'skipped') { row = s; return undefined; }
      row = { ...s, status: 'planned', why: s.origin === 'added' ? 'Added by you' : 'As written on your block', saved_at: now() };
      return batch([{ store: 'sets', put: row }]);
    });
    return row;
  }

  async function skipExercise(dId, slot) {
    return (await markSkipped(dId, slot, (sets) => sets.filter(s => s.status !== 'done' && s.status !== 'skipped'), 'Skipped by you')).length;
  }

  async function stopExercise(dId, slot) {
    return (await markSkipped(dId, slot, (sets) => sets.filter(s => s.status === 'planned'), 'Stopped by a block check')).length;
  }

  // An exercise this block marks no_added_sets never gains a set (15 Part 9, same rule as Add set).
  async function refuseNoAdd(s) {
    const eff = effectiveExercise(await db.get('blocks', s.block_id), await db.get('exercises', s.exercise_id));
    if (eff && eff.no_added_sets === true) throw new Refused('no added sets');
  }

  // A new set row; its id must not exist yet (R12).
  function addedRow(sets, base, id, n, side, kind, target, t) {
    if (sets.some(x => x.id === id)) throw new Refused('id in use');
    return { store: 'sets', put: {
      id, day_id: base.day_id, block_id: base.block_id, exercise_id: base.exercise_id, slot: base.slot, set_n: n, side, kind,
      target: { ...target }, draft: null, done: null, status: 'planned', origin: 'added', saved_at: t, first_done_at: null, why: 'Added by you'
    } };
  }

  async function addSet(dId, slot) {
    let ids = [];
    await queued(dayKey(dId), async () => {
      const sets = await slotSets(dId, slot);
      // A retry after a late first commit: the rows the first try added are there (P9).
      if (ids.length && ids.every(id => sets.some(x => x.id === id))) return undefined;
      const work = sets.filter(s => s.kind === 'work');
      const last = work[work.length - 1] || sets[sets.length - 1];
      if (!last) throw new Refused('no slot');
      await refuseNoAdd(last);
      const top = maxOf(work.map(s => s.set_n));
      const n = (top !== null && top > 0 ? top : 0) + 1;
      // Never a set number the restore would refuse (SR8).
      if (n > LIMITS.SET_N_MAX) throw new Refused('no set');
      const k = nextIdNum(sets, 's');
      const sides = last.side === 'none' ? ['none'] : ['L', 'R'];
      const t = now();
      const ops = sides.map(side => addedRow(sets, last, dId + ':x' + slot + ':s' + k + ':' + side, n, side, 'work', last.target, t));
      ids = ops.map(o => o.put.id);
      return batch(ops);
    });
    return ids;
  }

  // Add set below (15 Part 9): a new planned row right under the tapped one, same kind and
  // target; every later row of that kind moves its set_n up by one in the same write. On LR
  // the pair is added. An open day only (review R15), so a re-plan never meets the renumbering.
  async function addSetBelow(setId) {
    let ids = [];
    await queued(setKey(setId), async () => {
      const s = await getSet(setId);
      const day = await db.get('days', s.day_id);
      if (!day || day.status !== 'open') throw new Refused('day is not open');
      await refuseNoAdd(s);
      const sets = await slotSets(s.day_id, s.slot);
      // A retry after a late first commit: the rows the first try added are there, and the later
      // numbers already moved, so a second run would add and move them again (P9).
      if (ids.length && ids.every(id => sets.some(x => x.id === id))) return undefined;
      ids = [];
      const same = sets.filter(x => x.kind === s.kind);
      // The new row and every row it moves down stay within SET_N_MAX (SR8).
      if (s.set_n + 1 > LIMITS.SET_N_MAX || same.some(x => x.set_n > s.set_n && x.set_n + 1 > LIMITS.SET_N_MAX)) throw new Refused('no set');
      const letter = s.kind === 'warmup' ? 'w' : 's';
      const k = nextIdNum(sets, letter);
      const t = now();
      const ops = [];
      for (const x of same) if (x.set_n > s.set_n) ops.push({ store: 'sets', put: { ...x, set_n: x.set_n + 1 } });
      for (const side of (s.side === 'none' ? ['none'] : ['L', 'R'])) {
        const twin = same.find(x => x.set_n === s.set_n && x.side === side) || s;
        const op = addedRow(sets, s, s.day_id + ':x' + s.slot + ':' + letter + k + ':' + side, s.set_n + 1, side, s.kind, twin.target, t);
        ids.push(op.put.id);
        ops.push(op);
      }
      return batch(ops);
    });
    return ids;
  }

  // Delete a set (15 Part 10): a planned set with no typed draft, never the last row of its
  // slot, on a planned or open day. On LR the pair goes. Later rows of that kind move down by
  // one in the same write. The checks run inside the queue.
  async function deleteSet(setId) {
    let gone = [];
    await queued(setKey(setId), async () => {
      const s = await getSet(setId);
      const day = await db.get('days', s.day_id);
      if (!day || (day.status !== 'planned' && day.status !== 'open')) throw new Refused('day is not open');
      const sets = await slotSets(s.day_id, s.slot);
      const why = deleteReason(sets, s);
      if (why) throw new Refused(why);
      const pair = sets.filter(x => x.kind === s.kind && x.set_n === s.set_n && (s.side === 'none' ? x.id === s.id : x.side !== 'none'));
      gone = pair.map(x => x.id);
      const ops = pair.map(x => ({ store: 'sets', del: checkId(x.id) }));
      for (const x of sets) if (x.kind === s.kind && x.set_n > s.set_n) ops.push({ store: 'sets', put: { ...x, set_n: x.set_n - 1 } });
      ops.push({ store: 'days', put: { ...day, saved_at: now() } });
      return batch(ops);
    });
    return gone;
  }

  // Move an exercise today (15 Part 11): writes days.slot_order from a fresh read (null =
  // slot number order). Never changes slots, set ids or the block. Planned or open day only.
  async function moveSlot(dId, slot, dir) {
    let order = null;
    await queued(dayKey(dId), async () => {
      const day = await db.get('days', dId);
      if (!day || (day.status !== 'planned' && day.status !== 'open')) throw new Refused('day is not open');
      // A retry after a late first commit: the order is already the one the first try wrote, and
      // a second run would swap it back (P9).
      if (order && JSON.stringify(day.slot_order) === JSON.stringify(order)) return undefined;
      const daySets = await db.byIndex('sets', 'day_id', dId);
      const cur = slotsInOrder(day, daySets);
      const i = cur.indexOf(slot);
      const j = i + (dir < 0 ? -1 : 1);
      if (i < 0 || j < 0 || j >= cur.length) throw new Refused('cannot move');
      [cur[i], cur[j]] = [cur[j], cur[i]];
      order = capOrder(cur, daySets);
      return batch([{ store: 'days', put: { ...day, slot_order: order, saved_at: now() } }]);
    });
    return order;
  }

  // Swap (today only): a NEW slot for the new exercise; the old slot keeps its done sets.
  async function swapExercise(dId, slot, newExerciseId) {
    let newSlot = null;
    await queued(dayKey(dId), async () => {
      const all = await db.byIndex('sets', 'day_id', dId);
      // A retry after a late first commit: the new card is there, so a second one is never made (P9).
      if (newSlot !== null && all.some(s => s.slot === newSlot && s.origin === 'added')) return undefined;
      const old = all.filter(s => s.slot === slot).sort(setOrder);
      const fbs = await db.byIndex('feedback', 'day_id', dId);
      // Only a whole slot number above 0 counts (SR9, belt and braces behind the validator).
      const used = new Set([...all.map(s => s.slot), ...fbs.map(f => Number(f.id.split(':x').pop())).filter(n => Number.isInteger(n) && n > 0)]);
      const topSlot = maxOf([...used]);
      newSlot = (topSlot !== null && topSlot > 0 ? topSlot : 0) + 1;
      while (used.has(newSlot)) newSlot++;
      // Never a slot the restore would refuse (SR8).
      if (newSlot > LIMITS.SLOT_MAX) throw new Refused('no slot');
      const left = old.filter(s => s.status === 'planned' && s.kind === 'work');
      const tmpl = left[0] || old.filter(s => s.kind === 'work').pop() || old[0];
      if (!tmpl) throw new Refused('no slot');
      const count = Math.max(1, new Set(left.map(s => s.set_n)).size);
      const sides = tmpl.side === 'none' ? ['none'] : ['L', 'R'];
      const t = now();
      const ops = [];
      for (let n = 1; n <= count; n++) for (const side of sides) ops.push({ store: 'sets', put: {
        id: dId + ':x' + newSlot + ':s' + n + ':' + side, day_id: dId, block_id: tmpl.block_id, exercise_id: newExerciseId,
        slot: newSlot, set_n: n, side, kind: 'work', target: { ...tmpl.target, load: null }, draft: null, done: null,
        status: 'planned', origin: 'added', saved_at: t, first_done_at: null, why: 'Swapped by you'
      } });
      for (const s of old.filter(x => x.status === 'planned')) ops.push({ store: 'sets', put: { ...s, status: 'skipped', why: 'Swapped by you', draft: null, saved_at: t } });
      // The new exercise takes the old one's place in the card order; the old card goes after
      // the listed ones (A1-5). Same write as the sets, so the order never lags the swap.
      const day = await db.get('days', dId);
      // The cap reads the sets as this write leaves them (the old slot's planned sets now skipped).
      const after = [...all.map(s => (s.slot === slot && s.status === 'planned' ? { ...s, status: 'skipped' } : s)), ...ops.filter(o => o.store === 'sets' && o.put.slot === newSlot).map(o => o.put)];
      if (day) ops.push({ store: 'days', put: { ...day, slot_order: capOrder(slotsInOrder(day, all).map(sl => (sl === slot ? newSlot : sl)), after), saved_at: t } });
      return batch(ops);
    });
    return newSlot;
  }

  // Relabel a day (15 Part 1): today only, on a planned or open day. The label is trimmed;
  // an empty label is a real choice and shows the numbered name.
  async function relabelDay(dId, label) {
    const v = String(label === null || label === undefined ? '' : label).trim();
    // The one line rule of backup.js (P.4 item 1, SR5, SR6).
    if (!lineOk(v, LIMITS.LABEL)) throw new Refused('bad label');
    let row = null;
    await queued(dayKey(dId), async () => {
      const day = await db.get('days', dId);
      if (!day) throw new Refused('no such day');
      if (day.status !== 'planned' && day.status !== 'open') throw new Refused('day is not open');
      row = { ...day, label: v, saved_at: now() };
      return batch([{ store: 'days', put: row }]);
    });
    return row;
  }

  // Feedback for one exercise slot. pending = "Ask me later".
  async function saveFeedback(dId, slot, answers, pending) {
    const a = answers || {};
    if (!pending) checkText('note', a.note);
    let row = null;
    await queued(dayKey(dId), async () => {
      const sets = await slotSets(dId, slot);
      // A slot with no set has nothing to answer on (r4.3 H1 item 7), like saveChecks.
      if (!sets.length) throw new Refused('no slot');
      const ex = (await exercisesMap()).get(sets[0].exercise_id);
      // A check answered true stays true that day (R4-03 sticky Yes, review R20): a later save
      // of the same row never turns it back, so a Reset day that kept it cannot lose it here.
      const was = await db.get('feedback', dId + ':x' + slot);
      const checks = { ...(pending ? {} : (a.checks || {})) };
      for (const [k, val] of Object.entries((was && was.checks) || {})) if (val === true) checks[k] = true;
      row = {
        id: dId + ':x' + slot, day_id: dId, exercise_id: sets[0].exercise_id, muscle: ex ? ex.muscle : 'core',
        pump: pending ? null : (a.pump ?? null), soreness: pending ? null : (a.soreness ?? null), workload: pending ? null : (a.workload ?? null),
        checks, note: pending ? '' : (a.note || ''), pending: !!pending, saved_at: now(), label_set: 'w1'
      };
      return batch([{ store: 'feedback', put: row }]);
    });
    return row;
  }

  // Block check answers from the card inset (15 Part 17, R4-03), in the day queue. Creates the
  // slot's feedback row as pending, or merges into it: never clears pump, soreness, workload or
  // note, and never turns a true back (a Yes is sticky for that exercise that day). answers is
  // {check key: true | false | null}; a key the block does not ask on this exercise is refused.
  async function saveChecks(dId, slot, answers) {
    let row = null;
    await queued(dayKey(dId), async () => {
      const day = await db.get('days', checkId(dId));
      if (!day || (day.status !== 'planned' && day.status !== 'open')) throw new Refused('day is not open');
      const sets = await slotSets(dId, slot);
      if (!sets.length) throw new Refused('no slot');
      const block = await db.get('blocks', day.block_id);
      const keys = new Set(checksFor(block, sets[0].exercise_id).map(c => c.key));
      const ex = (await exercisesMap()).get(sets[0].exercise_id);
      const id = dId + ':x' + slot;
      const was = await db.get('feedback', id);
      const checks = { ...((was && was.checks) || {}) };
      for (const [k, v] of Object.entries(answers || {})) {
        if (!keys.has(k) || reservedName(k) || !(v === true || v === false || v === null)) throw new Refused('bad check');
        if (checks[k] !== true) checks[k] = v;
      }
      row = was ? { ...was, checks, saved_at: now() } : {
        id, day_id: dId, exercise_id: sets[0].exercise_id, muscle: ex ? ex.muscle : 'core',
        pump: null, soreness: null, workload: null, checks, note: '', pending: true, saved_at: now(), label_set: 'w1'
      };
      return batch([{ store: 'feedback', put: row }]);
    });
    return row;
  }

  // Every other write also goes through the queue, so it gets the 4 s limit, the link
  // reset and one retry, and a hung write ends as NotSaved, never a silent wait (C35).
  async function saveExerciseText(exId, field, value) {
    if (field !== 'notes' && field !== 'link') throw new Refused('bad field');
    checkText(field === 'notes' ? 'note' : 'link', value);
    let row = null;
    // The row is read inside its own queue (r4.3 H1), so a note and a link saved in one tick
    // both land: the second write reads the row the first one put.
    await queued('ex:' + exId, async () => {
      const ex = await db.get('exercises', exId);
      if (!ex) throw new Refused('bad field');
      // A note or link never marks a list row edited, so it never freezes the row against a
      // later list fix; the seed upsert keeps the note and link instead (17 C.2.6).
      row = { ...ex, [field]: value };
      return batch([{ store: 'exercises', put: row }]);
    });
    return row;
  }

  async function addCustomExercise(spec) {
    checkText('name', spec.name);
    // Never a row the restore refuses (SB3): the muscle and the equipment come from the fixed lists.
    if (!MUSCLES.includes(spec.muscle) || !EQUIPMENT.includes(spec.equipment)) throw new Refused('bad text');
    const row = {
      id: 'c-' + uuid(), name: spec.name, muscle: spec.muscle, equipment: spec.equipment, count_label: 'reps',
      weight_steps: null, step_default: 5, unilateral: false, machine: spec.equipment === 'machine', no_added_sets: false,
      left_out_of_builder: false, flags_set: false, link: '', notes: '', custom: true, edited: false
    };
    await queued('ex:' + row.id, () => batch([{ store: 'exercises', put: row }]));
    return row;
  }

  // Finish day (5.3), the transaction part: leftover planned sets become skipped, the day
  // is done, the next day is planned under the write guard. One exclusive job (r4.3 H1): it
  // starts when every queued write has settled, so a waiting tick commits first and is never
  // undone, and a tick on the NEXT day tapped after it waits until the plan has landed.
  function finishDay(dId, scores) {
    return exclusive(async (job) => {
      const day = await db.get('days', dId);
      const sets = day ? await db.byIndex('sets', 'day_id', dId) : [];
      // The check runs inside the day queue, so a first tick still waiting has opened the day (R4).
      if (!finishable(day, sets)) throw new Refused('day is not open');
      // A day with no done set is never finished: Skip day ends it instead (R4-02, C34).
      if (!sets.some(s => s.status === 'done')) throw new Refused('no done set');
      const block = await db.get('blocks', day.block_id);
      const t = now();
      const ops = [];
      for (const s of sets) if (s.status === 'planned') ops.push({ store: 'sets', put: { ...s, status: 'skipped', why: 'Not done', draft: null, saved_at: t } });
      let from = day.started_at;
      if (from === null) {
        const done = sets.filter(s => s.status === 'done').map(s => s.saved_at).filter(x => x !== null);
        from = done.length ? minOf(done) : t;
      }
      ops.push({ store: 'days', put: { ...day, status: 'done', done_at: t, done_date: localDate(from), scores: scores || day.scores || {}, saved_at: t } });
      const next = nextPosition(block, day.pass, day.day);
      if (next) ops.push(...await planDayOps(block, next.pass, next.day));
      else ops.push({ store: 'blocks', put: { ...block, status: 'done' } });
      // The same ops put twice give the same rows, so a retry after a late commit is safe (P9).
      await job.write(() => batch(ops));
      return next;
    });
  }

  // Skip day (15 Part 15, R4-02): a planned or open day with no done set. One write in the day
  // queue: every planned set is skipped with why 'Day skipped' and its draft cleared, the day
  // is skipped with no done dates, and the next day is planned under the write guard. With no
  // next position the block is done, as Finish day does (review R21, R45). No undo.
  function skipDay(dId) {
    return exclusive(async (job) => {
      const day = await db.get('days', checkId(dId));
      if (!day || (day.status !== 'planned' && day.status !== 'open')) throw new Refused('day is not open');
      const sets = await db.byIndex('sets', 'day_id', dId);
      if (sets.some(s => s.status === 'done')) throw new Refused('a set is done');
      const block = await db.get('blocks', day.block_id);
      const t = now();
      const ops = [];
      for (const s of sets) if (s.status === 'planned') ops.push({ store: 'sets', put: { ...s, status: 'skipped', why: 'Day skipped', draft: null, saved_at: t } });
      ops.push({ store: 'days', put: { ...day, status: 'skipped', done_at: null, done_date: null, saved_at: t } });
      const next = nextPosition(block, day.pass, day.day);
      if (next) ops.push(...await planDayOps(block, next.pass, next.day));
      else ops.push({ store: 'blocks', put: { ...block, status: 'done' } });
      await job.write(() => batch(ops));
      return next;
    });
  }

  // The Day done numbers (15 Part 14), read only: the day must exist and be done.
  async function dayTotals(dId) {
    const day = await db.get('days', checkId(dId));
    if (!day || day.status !== 'done') return null;
    return { day, totals: dayTotalsOf(await db.byIndex('sets', 'day_id', dId)) };
  }

  // ---------------- last time and since last set ----------------

  async function position(d, blocks) {
    const b = blocks.get(d.block_id);
    return [b ? b.created_at : 0, d.block_id, d.pass, d.day];
  }
  const before = (a, b) => {
    for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return true; if (a[i] > b[i]) return false; }
    return false;
  };

  // The done sets from the latest earlier done day that holds this exercise (by position, never by time).
  // Work sets only: a warm-up next to work sets would read as the same kind of set (A2-8).
  async function lastTime(exerciseId, currentDayId) {
    const sets = (await db.byIndex('sets', 'exercise_id', exerciseId)).filter(s => s.done !== null && s.kind === 'work');
    if (!sets.length) return [];
    const blocks = new Map((await db.all('blocks')).map(b => [b.id, b]));
    const cur = await db.get('days', currentDayId);
    const curPos = cur ? await position(cur, blocks) : [Infinity];
    let best = null, bestPos = null;
    for (const did of new Set(sets.map(s => s.day_id))) {
      const d = await db.get('days', did);
      if (!d || d.status !== 'done' || did === currentDayId) continue;
      const p = await position(d, blocks);
      if (!before(p, curPos)) continue;
      if (!best || before(bestPos, p)) { best = d; bestPos = p; }
    }
    if (!best) return [];
    // Slot first, so an exercise done in two slots of one day never mixes its rows (C42).
    return sets.filter(s => s.day_id === best.id).sort(setOrder);
  }

  // Minutes since the newest done set of the day, or null when it must stay hidden.
  async function sinceLastSet(dId) {
    const done = (await db.byIndex('sets', 'day_id', dId)).filter(s => s.status === 'done' && s.saved_at !== null);
    if (!done.length) return null;
    const ms = now() - maxOf(done.map(s => s.saved_at));
    if (ms < 0 || ms > SINCE_MAX_MS) return null;
    return ms;
  }

  function isStale(day) {
    return !!day && day.status === 'open' && day.started_at !== null && now() - day.started_at > STALE_MS;
  }

  // ---------------- backup and its marker ----------------

  // All 7 stores in ONE read transaction, so a file never holds half of a write (C2).
  function readAll() {
    return db.allMany(STORE_NAMES);
  }

  // The time is read BEFORE the rows: a row saved during the read is newer than the file
  // says, so the badge stays on for it.
  async function backupObject() {
    const t = now();
    const data = await readAll();
    return buildBackup(data, { now: t, appVersion: APP_VERSION });
  }

  async function backupDue() {
    const last = await db.setting('last_backup_at', null);
    for (const s of ['sets', 'days', 'feedback']) {
      for (const r of await db.all(s)) {
        if (r.saved_at === null) continue;
        if (last === null || r.saved_at > last) return true;
      }
    }
    return false;
  }

  async function markBackedUp(exportedMs) {
    // A marker the restore would refuse is never stored (SR1, SR10).
    if (!markerOk(exportedMs, now())) throw new Refused('bad');
    await queued('marker', () => db.setSetting('last_backup_at', exportedMs));
  }

  // ---------------- safety copies, restore, undo, erase (5.5 Order) ----------------

  // Runs only inside exclusive(): the rows it copies can not change under it.
  async function snapshotNow(reason, job) {
    const t = now();
    const data = await backupObject();
    delete data.flat_log;
    const row = { id: 's' + t, made_at: t, reason, last_backup_at_then: await db.setting('last_backup_at', null), data };
    const ops = [{ store: 'snapshots', put: row }];
    const old = (await db.all('snapshots')).filter(s => s.id !== row.id).sort((a, b) => b.made_at - a.made_at);
    for (const s of old.slice(KEEP_SNAPSHOTS - 1)) ops.push({ store: 'snapshots', del: s.id });
    await job.write(() => db.batch(ops));
    return row;
  }

  function saveSnapshot(reason) {
    if (!SNAPSHOT_REASONS.includes(reason)) return Promise.reject(new Refused('bad reason'));
    return exclusive((job) => snapshotNow(reason, job));
  }

  async function listSnapshots() {
    return (await db.all('snapshots')).sort((a, b) => b.made_at - a.made_at)
      .map(s => ({ id: s.id, made_at: s.made_at, reason: s.reason }));
  }

  // Phone keeps its own device keys; the marker comes from the caller.
  async function replaceWith(stores, marker, job) {
    // The marker every later backup and safety copy carries: never one the validator refuses,
    // so an undo of an old copy can never store one either (SR1, SR10).
    if (!markerOk(marker, now())) throw new Refused('bad');
    const phone = await db.all('settings');
    const keep = phone.filter(r => DEVICE_KEYS.includes(r.key) && r.key !== 'last_backup_at' && r.key !== 'restore_note');
    const settings = stores.settings.filter(r => !DEVICE_KEYS.includes(r.key)).concat(keep);
    settings.push({ key: 'last_backup_at', value: marker });
    const rows = STORE_NAMES.reduce((n, s) => n + (s === 'settings' ? settings.length : stores[s].length), 0);
    // The "Restored" line rides across the reload in the same transaction as the data, so a
    // failed restore can never leave a note behind (A3-R8).
    settings.push({ key: 'restore_note', value: { rows, at: now() } });
    const data = { ...stores, settings };
    const counts = Object.fromEntries(STORE_NAMES.map(s => [s, data[s].length]));
    // The same rows written twice do no harm, so a retry after a late first write is safe.
    await job.write(() => db.replaceAll(data, counts));
    return rows;
  }

  // Read the restore note once: the row count when the note is under 60 s old, else null.
  // The note is deleted either way, so a second reload shows nothing (A3-R8).
  async function takeRestoreNote() {
    const note = await db.setting('restore_note', null);
    if (note === null) return null;
    await queued('setting:restore_note', () => batch([{ store: 'settings', del: 'restore_note' }]));
    const age = now() - (note && note.at);
    return note && Number.isInteger(note.rows) && age >= 0 && age <= NOTE_MS ? note.rows : null;
  }

  // Read a file for the preview. Writes nothing.
  async function readBackupFile(text) {
    const v = validateBackup(text, { now: now(), seedIds: SEED_IDS });
    if (!v.ok) return v;
    const data = migrate(v.stores, v.schema);
    return { ...v, stores: data, info: await compareInfo(data) };
  }

  async function compareInfo(data) {
    const fileDone = data.days.filter(d => d.status === 'done');
    const lastFile = fileDone.reduce((m, d) => (m === null || d.done_date > m ? d.done_date : m), null);
    const phoneDays = (await db.all('days')).filter(d => d.status === 'done');
    const fileIds = new Set(fileDone.map(d => d.id));
    const newer = phoneDays.filter(d => !fileIds.has(d.id) && (lastFile === null || d.done_date >= lastFile)).length;
    const phone = {
      blocks: (await db.all('blocks')).length, days: phoneDays.length,
      sets: (await db.all('sets')).filter(s => s.status === 'done').length
    };
    return {
      blocks: data.blocks.length, days: fileDone.length,
      sets: data.sets.filter(s => s.status === 'done').length, last: lastFile, newerOnPhone: newer, phone
    };
  }

  // Restore from a file. Nothing is written until parse, validate and migrate pass.
  async function restoreFile(text) {
    const v = validateBackup(text, { now: now(), seedIds: SEED_IDS });
    if (!v.ok) throw new Refused(v.code);
    const data = migrate(v.stores, v.schema);
    return exclusive(async (job) => {
      await snapshotNow('before-restore', job);
      return replaceWith(data, v.exported_ms, job);
    });
  }

  async function readSnapshot(id) {
    const snap = await db.get('snapshots', id);
    if (!snap) return { ok: false, code: 'bad' };
    try {
      // The copy's own fields and reason are checked too, never only its data (A2-10).
      const v = validateSnapshotRow(snap, { now: now(), seedIds: SEED_IDS });
      const data = migrate(v.stores, v.schema);
      return { ok: true, snap, stores: data, info: await compareInfo(data), exported_at: v.exported_at };
    } catch (e) {
      return { ok: false, code: e.code || 'bad' };
    }
  }

  // Undo: the marker goes back to what it was when the copy was made, so unsaved edits still show.
  // The 5.5 Order: a safety copy of what is on the phone now comes first, so an undo can be
  // undone. The picked copy is already in memory (r), so the newest-3 trim cannot lose it (C1).
  async function undoSnapshot(id) {
    return exclusive(async (job) => {
      const r = await readSnapshot(id);
      if (!r.ok) throw new Refused(r.code);
      await snapshotNow('before-undo', job);
      return replaceWith(r.stores, r.snap.last_backup_at_then, job);
    });
  }

  async function eraseAll() {
    return exclusive(async (job) => {
      await snapshotNow('before-erase', job);
      const phone = await db.all('settings');
      const settings = phone.filter(r => ['theme', 'persist_answer', 'seeded_version'].includes(r.key));
      const data = Object.fromEntries(STORE_NAMES.map(s => [s, []]));
      data.settings = settings;
      await job.write(() => db.replaceAll(data, Object.fromEntries(STORE_NAMES.map(s => [s, data[s].length]))));
    });
  }

  function clearSnapshots() { return exclusive((job) => job.write(() => db.clearSnapshots())); }

  // Phone check row 4 (SR15): put a probe row, drop the link on purpose, read it back, delete it.
  // One exclusive job, so every queued write has settled before the link drops and none starts
  // until the probe is gone; each step gets the 4 s limit and one retry. Returns the value read.
  function probe(stamp) {
    return exclusive(async (job) => {
      await job.write(() => db.put('settings', { key: 'phonecheck_probe', value: stamp }));
      if (typeof db.closeForTest === 'function') db.closeForTest();
      let row = null;
      await job.write(async () => { row = await db.get('settings', 'phonecheck_probe'); });
      await job.write(() => db.del('settings', 'phonecheck_probe'));
      return row ? row.value : null;
    });
  }

  // Reset an open day (15 Part 12), inside the exclusive section (A3-R3): first a safety copy
  // (before-reset), then one write. Every done set goes back to planned with its done and
  // draft cleared and first_done_at kept; planned sets lose their typed numbers too; skipped
  // sets stay skipped. Feedback rows lose every answer but a check answered true (review R20,
  // R4-03 sticky Yes); a row left holding nothing is deleted, a row that keeps a Yes waits as
  // pending so the questions are asked again. The day stays open with its started_at.
  async function resetDay(dId) {
    return exclusive(async (job) => {
      const day = await db.get('days', checkId(dId));
      if (!day || day.status !== 'open') throw new Refused('day is not open');
      await snapshotNow('before-reset', job);
      const t = now();
      const ops = [];
      for (const s of await db.byIndex('sets', 'day_id', dId)) {
        if (s.status === 'done') {
          ops.push({ store: 'sets', put: { ...s, status: 'planned', done: null, draft: null, why: s.origin === 'added' ? 'Added by you' : 'As written on your block', saved_at: t } });
        } else if (s.status === 'planned' && s.draft !== null) {
          ops.push({ store: 'sets', put: { ...s, draft: null, saved_at: t } });
        }
      }
      for (const f of await db.byIndex('feedback', 'day_id', dId)) {
        const kept = Object.fromEntries(Object.entries(f.checks || {}).filter(([, val]) => val === true));
        if (!Object.keys(kept).length) ops.push({ store: 'feedback', del: f.id });
        else ops.push({ store: 'feedback', put: { ...f, pump: null, soreness: null, workload: null, note: '', checks: kept, pending: true, saved_at: t } });
      }
      ops.push({ store: 'days', put: { ...day, saved_at: t } });
      await job.write(() => batch(ops));
      return ops.length;
    });
  }

  // ---------------- block files (5.3 Load a block file) ----------------

  async function readBlockFile(text) {
    const v = validateBlock(text, { now: now(), seedIds: SEED_IDS });
    if (!v.ok) return v;
    const blocks = await db.all('blocks');
    const same = blocks.find(b => b.source_id === v.source_id);
    const active = await activeBlock();
    if (!same) return { ...v, kind: 'new', otherActive: !!active };
    if (!(v.version > (same.version || 0))) return { ok: false, code: 'old' };
    const plan = await updatePlan(same, v);
    if (!plan) return { ok: false, code: 'badref' };
    return { ...v, kind: 'update', target: same, changes: plan.changes, keepDraft: plan.keepDraft, otherActive: !!active && active.id !== same.id };
  }

  function rewrite(block, map) {
    const out = JSON.parse(JSON.stringify(block));
    for (const dt of out.day_templates) for (const l of dt.lifts) l.exercise_id = map(l.exercise_id);
    const flags = {};
    for (const [k, v] of Object.entries(out.exercise_flags)) flags[map(k)] = v;
    out.exercise_flags = flags;
    // A check asked on some lifts only names them by id, so those ids go through the map too (R13).
    for (const ck of out.checks) if (Array.isArray(ck.lifts)) ck.lifts = ck.lifts.map(map);
    return out;
  }

  async function updatePlan(same, v) {
    const phoneEx = await exercisesMap();
    const idMap = Object.assign(Object.create(null), same.id_map);   // no inherited names (C9)
    const exOps = [];
    const changes = [];
    for (const e of v.exercises) {
      const phoneId = idMap[e.id];
      // A phone row is reused only when it is his own custom row, never a list row (SR2): a
      // crafted id_map that names a seed id gets a new c- row and the list row stays as it is.
      const mine = phoneId && phoneEx.has(phoneId) && phoneEx.get(phoneId).custom === true && !SEED_IDS.includes(phoneId);
      if (mine) {
        const was = phoneEx.get(phoneId);
        exOps.push({ store: 'exercises', put: { ...e, id: phoneId, link: was.link, notes: was.notes, edited: was.edited, custom: true } });
      } else {
        const nid = 'c-' + uuid();
        idMap[e.id] = nid;
        exOps.push({ store: 'exercises', put: { ...e, id: nid, custom: true, edited: false } });
        changes.push({ kind: 'newex', name: e.name });
      }
    }
    let unresolved = false;
    const map = (id) => {
      if (SEED_IDS.includes(id)) return id;
      if (idMap[id]) return idMap[id];
      unresolved = true;
      return id;
    };
    const nb = rewrite(v.block, map);
    if (unresolved) return null;
    // Load changes old to new, for the preview.
    const nameOf = (id) => (phoneEx.get(id) || (exOps.find(o => o.put.id === id) || {}).put || { name: id }).name;
    for (const dt of nb.day_templates) {
      const od = same.day_templates.find(x => x.day === dt.day);
      for (const l of dt.lifts) {
        const ol = od && od.lifts.find(x => x.slot === l.slot && x.exercise_id === l.exercise_id);
        if (ol && ol.start_load !== l.start_load) changes.push({ kind: 'load', name: nameOf(l.exercise_id), from: ol.start_load, to: l.start_load });
      }
    }
    const newBlock = { ...same, version: v.version, id_map: idMap, name: String(nb.name).trim() ? nb.name : same.name, notes: nb.notes, passes: nb.passes, day_templates: nb.day_templates, checks: nb.checks, scores: nb.scores, rule_notes: nb.rule_notes, exercise_flags: nb.exercise_flags };
    const dayOps = [];
    const keepDraft = [];
    const days = (await db.byIndex('days', 'block_id', same.id)).filter(d => d.status === 'planned');
    for (const d of days) {
      const ops = await planDayOps(newBlock, d.pass, d.day, { wholeDayGuard: true });
      if (ops === null) keepDraft.push(d.label);
      else dayOps.push(...ops);
    }
    return { exOps, newBlock, dayOps, changes, keepDraft };
  }

  // Load a block file (r4.3 H1): both paths are ONE exclusive job, set at the tap before any
  // await. The reads, the plan and one batch run inside it, so it starts when every queued
  // write has settled and a tick or a Move tapped after it waits until it has landed. Never
  // call queued() or exclusive() inside this body.
  function importBlock(text, activate) {
    return exclusive(async (job) => {
      const v = validateBlock(text, { now: now(), seedIds: SEED_IDS });
      if (!v.ok) throw new Refused(v.code);
      const blocks = await db.all('blocks');
      const same = blocks.find(b => b.source_id === v.source_id);
      let ops, out;
      if (!same) {
        const idMap = Object.create(null);
        const exOps = v.exercises.map(e => {
          const nid = 'c-' + uuid();
          idMap[e.id] = nid;
          return { store: 'exercises', put: { ...e, id: nid, custom: true, edited: false } };
        });
        const nb = rewrite(v.block, (id) => idMap[id] || id);
        const activeId = await db.setting('active_block_id', null);
        const otherActive = !!activeId && blocks.some(b => b.id === activeId);
        const unit = nb.unit || await db.setting('unit', 'lb');
        // Not made active while another block is: the active block op is left out, so this
        // is one write and the active block stays (never a second write that puts it back).
        const r = newBlockOps({ ...nb, id: 'b' + uuid(), unit, source_id: v.source_id, version: v.version, id_map: idMap }, exOps, blocks,
          { t: now(), activate: !otherActive || !!activate });
        ops = r.ops;
        out = r.block;
      } else {
        if (!(v.version > (same.version || 0))) throw new Refused('old');
        const plan = await updatePlan(same, v);
        if (!plan) throw new Refused('badref');
        ops = [...plan.exOps, { store: 'blocks', put: plan.newBlock }, ...plan.dayOps];
        if (activate) ops.push({ store: 'settings', put: { key: 'active_block_id', value: plan.newBlock.id } });
        out = plan.newBlock;
      }
      await job.write(() => batch(ops));
      return out;
    });
  }

  return {
    LIMITS, seed, getSetting, setSetting, activeBlock, openDay, isDayOpen, currentDay, dayView, createBlock,
    tick, untick, saveDraft, skipSet, unskip, skipExercise, stopExercise, addSet, swapExercise, saveFeedback,
    saveExerciseText, addCustomExercise, finishDay, lastTime, sinceLastSet, isStale, backupObject, backupDue,
    markBackedUp, saveSnapshot, listSnapshots, readBackupFile, restoreFile, readSnapshot, undoSnapshot, eraseAll,
    clearSnapshots, readBlockFile, importBlock, exercisesMap, busy, idle, takeRestoreNote, probe,
    defaultBlockName: async () => defaultBlockName(await db.all('blocks')), relabelDay, addSetBelow, deleteSet, moveSlot, resetDay, skipDay, saveChecks, dayTotals,
    effectiveExercise: async (block, exerciseId) => effectiveExercise(block, await db.get('exercises', exerciseId)),
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
}
