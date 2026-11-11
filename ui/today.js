// ui/today.js - the training day (DESIGN 5.3 Today, LOOK 4.3, 4.4, 4.4b).
// Every tap writes at once through the store. A row shows Done only after its
// write has committed; until then it shows Saving, and a write that fails twice
// turns the row red with a retry.
import { el, clear, glyph, sheet, ghostTally, toast, typedConfirm, untyped } from './dom.js';
import { t, tn, numSplit } from './strings.js';
import { LIMITS, isLink } from '../backup.js';
import { MUSCLE_NAMES, EQUIPMENT_NAMES } from '../data/exercises.js';
import { finishable, effectiveExercise, deleteReason, checksFor } from '../store.js';
import { openBuilder } from './builder.js';

const LINK_REL = 'noopener noreferrer';   // plain link to the uploader, never embedded
const NO_DONE_SET = 'no done set';       // the store's refusal code for a day with no done set (R4-02)
const rowState = new Map();     // set id -> 'saving' | 'failed'
let openId = null;              // the row he tapped open, if any
let inset = null;               // the block check inset (15 Part 17): {day, slot, after: set id or null}
let sinceTimer = null;

const fmtNum = (n) => (n === null || n === undefined) ? '' : String(Math.round(n * 100) / 100);

// A dot or a comma is the decimal mark. Returns a number, or null for blank, or NaN.
export function readNumber(text, max, whole) {
  const s = String(text).trim().replace(',', '.');
  if (s === '') return null;
  if (!/^\d+(\.\d+)?$/.test(s) && !/^\.\d+$/.test(s)) return NaN;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > max || (whole && !Number.isInteger(n))) return NaN;
  return n;
}

function unitWord(block, target) {
  const u = t(block.unit === 'kg' ? 'unit.kg' : 'unit.lb');
  if (target.load_basis === 'per_side') return t('today.side', { unit: u });
  if (target.load_basis === 'per_hand') return t('today.hand', { unit: u });
  return u;
}

function setLabel(s) {
  const side = s.side === 'none' ? '' : s.side;
  return (s.kind === 'warmup' ? t('today.warmup') : String(s.set_n)) + side;
}

// The helper line of a set (15 Part 5, R4-05). It always reads the target, never a draft.
// No load: the no-weight line (with the range, the open top, or neither). A load: the goal.
// Then the effort part, on a work set only. With no rep range, his block's goal_line for the
// lift is the goal part (15 Part 18); with a rep range the built line stands.
export function helperLine(s, lift) {
  const tg = s.target;
  let effort = '';
  if (s.kind === 'work') {
    if (tg.reps_left_target === 0) effort = t('today.fail');
    else if (tg.reps_left_target !== null && tg.reps_left_target !== undefined) effort = t('today.stop', { n: tg.reps_left_target });
  }
  let goal;
  const own = lift && typeof lift.goal_line === 'string' ? lift.goal_line : '';
  if (tg.rep_low === null && own) {
    goal = own;
  } else if (tg.load === null || tg.load === undefined) {
    if (tg.rep_low === null) goal = t('today.noload');
    else if (tg.rep_high === null) goal = t('today.noload.open', { low: tg.rep_low });
    else goal = t('today.noload.range', { low: tg.rep_low, high: tg.rep_high });
  } else {
    if (tg.rep_low === null) return '';
    goal = tg.rep_high === null ? t('today.goal.open', { load: fmtNum(tg.load), low: tg.rep_low })
      : t('today.goal', { load: fmtNum(tg.load), low: tg.rep_low, high: tg.rep_high });
  }
  return goal + effort;
}

// The rep range ask (15 Part 8, R4-05, R38): on a work set with a rep_low, reps below the
// range, or above a set top, ask once. An open top asks only below. Never on a warm-up, and
// never when the reps to be saved are null. Returns the line's key and values, or null.
export function rangeAsk(s, reps) {
  const tg = s.target;
  if (s.kind !== 'work' || reps === null || reps === undefined || tg.rep_low === null || tg.rep_low === undefined) return null;
  if (tg.rep_high === null || tg.rep_high === undefined) return reps < tg.rep_low ? { key: 'range.line.open', vals: { reps, low: tg.rep_low } } : null;
  if (reps < tg.rep_low || reps > tg.rep_high) return { key: 'range.line', vals: { reps, low: tg.rep_low, high: tg.rep_high } };
  return null;
}

// The ask sheet (LOOK 4.10). Resolves {save, noask}. A scrim tap is Cancel. A question, not
// a warning: no amber, no red.
function rangeSheet(ask) {
  return new Promise((resolve) => {
    let save = false, noask = false;
    const box = el('button', { class: 'row check-box-row', type: 'button', role: 'checkbox', id: 'range-noask', 'aria-checked': 'false' },
      el('span', { class: 'box', 'aria-hidden': 'true' }), el('span', { class: 'grow' }, t('range.noask')));
    box.addEventListener('click', () => {
      noask = !noask;
      box.setAttribute('aria-checked', String(noask));
      const mark = box.querySelector('.box');
      clear(mark);
      if (noask) mark.appendChild(glyph('check'));
    });
    const go = el('button', { class: 'btn btn-primary', type: 'button', id: 'range-log' }, t('range.log'));
    const cancel = el('button', { class: 'btn btn-quiet', type: 'button', id: 'range-cancel' }, t('text.cancel'));
    const sh = sheet({ id: 'range-sheet', title: t('range.title'), onClose: () => resolve({ save, noask: save && noask }) },
      // The numbers sit in .num (LOOK 4.10, the 5.11 range.line note; review P21 a), text only.
      el('p', { id: 'range-line' }, numSplit(ask.key, ask.vals).map(p => (p.num !== undefined ? el('span', { class: 'num' }, p.num) : p.text))),
      box, go, el('div', { class: 'quiet-row' }, cancel));
    go.addEventListener('click', () => { save = true; sh.close(); });
    cancel.addEventListener('click', () => sh.close());
  });
}

function startValues(s) {
  const d = s.draft || {};
  return {
    load: d.load !== undefined && d.load !== null ? d.load : s.target.load,
    reps: d.reps !== undefined && d.reps !== null ? d.reps : s.target.rep_low,
    reps_left: d.reps_left === undefined ? null : d.reps_left,
    reps_left_plus: !!d.reps_left_plus,
    failure: !!d.failure,
    breaks: d.breaks === undefined ? null : d.breaks
  };
}

// The count word of a set: its own, else the exercise's (DESIGN 5.2).
const countOf = (s, ex) => s.target.count_label || (ex ? ex.count_label : null);

// Break chips (15 Part 16, R4-14, review R42): on a work set of a lift whose count word is
// laps. Never on a warm-up, never on a reps or seconds lift.
export function breaksShown(s, ex) {
  return s.kind === 'work' && countOf(s, ex) === 'laps';
}

// The break chip row (LOOK 3.1 strip 2b): 0, 1, 2 and "3 or more", stored 0 to 3. Tapping the
// picked chip clears it back to not answered (null), never 0.
export function breakChips(cur, label, onPick) {
  const box = el('div', { class: 'rl-chips br-chips', role: 'group', 'aria-label': t('breaks.aria', { set: label }) });
  for (let i = 0; i <= 3; i++) {
    const on = cur.breaks === i;
    box.appendChild(el('button', { class: 'rl num' + (on ? ' is-on' : ''), type: 'button', 'data-br': String(i), 'aria-pressed': String(on),
      on: { click: () => onPick(on ? null : i) } }, on ? glyph('check') : null, i === 3 ? t('breaks.more') : String(i)));
  }
  return box;
}

// The step of the weight steppers (15 Part 18, r4.1 Q13, Q14, Q18, Q27), one read order for an
// exercise as effectiveExercise gives it: a list of loads (the block's, else the row's), the
// block's step size, the row's step_default (lb blocks only: it is a pound step), else 5 lb or
// 1 kg. The signed table (load.default_steps) is read here once Slice 2 wires rules.js in; its
// signed values today are 5 lb for barbell, machine, cable and dumbbell and none in kg, which is
// the same step this fallback gives. Returns {list} or {size}.
export function loadStep(ex, unit) {
  if (ex && Array.isArray(ex.weight_steps) && ex.weight_steps.length) return { list: [...ex.weight_steps].sort((a, b) => a - b) };
  if (ex && typeof ex.step === 'number' && ex.step > 0) return { size: ex.step };
  if (unit !== 'kg' && ex && typeof ex.step_default === 'number' && ex.step_default > 0) return { size: ex.step_default };
  return { size: unit === 'kg' ? 1 : 5 };
}

export function stepLoad(ex, load, dir, unit) {
  const v = load === null ? 0 : load;
  const st = loadStep(ex, unit);
  if (st.list) {
    if (dir > 0) { const n = st.list.find(x => x > v); return n === undefined ? v : n; }
    const p = st.list.filter(x => x < v).pop();
    return p === undefined ? v : p;
  }
  return Math.max(0, Math.min(LIMITS.LOAD_MAX, Math.round((v + dir * st.size) * 100) / 100));
}

// ---------------- the screen ----------------

export function renderToday(ctx) {
  const screen = el('section', { class: 'screen', id: 'today' });
  clearInterval(sinceTimer);
  draw(ctx, screen).catch((e) => { screen.appendChild(el('p', { class: 'raw' }, String(e && e.message))); });
  return screen;
}

// Taps can start a new draw while one is still reading the store, so each draw
// builds off the page and only the newest one is put in.
const drawSeq = new WeakMap();
async function draw(ctx, screen) {
  const seq = (drawSeq.get(screen) || 0) + 1;
  drawSeq.set(screen, seq);
  const box = document.createDocumentFragment();
  const commit = (attrs) => {
    if (drawSeq.get(screen) !== seq) return false;
    clearInterval(sinceTimer);
    clear(screen);
    for (const [k, val] of Object.entries(attrs || {})) screen.setAttribute(k, val);
    screen.appendChild(box);
    return true;
  };
  const store = ctx.store;
  const unit = await store.getSetting('unit', null);
  const block = await store.activeBlock();
  const day = await store.currentDay();
  if (!day) {
    // A block whose last day is done is finished, not missing (C27).
    box.appendChild(unit === null && !block ? setupScreen(ctx) : block && block.status === 'done' ? blockDone(ctx) : noBlock(ctx));
    commit();
    return;
  }
  const v = await store.dayView(day.id);

  if (store.isStale(day)) {
    box.appendChild(el('div', { class: 'banner', id: 'stale-card', role: 'status' },
      el('p', { class: 'grow' }, t('today.stale', { date: new Date(day.started_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) })),
      el('button', { class: 'btn btn-secondary', type: 'button', id: 'stale-finish', on: { click: () => finishFlow(ctx, day.id) } }, t('today.finish'))));
  }
  const b = v.block;
  // The day menu sits at the right of the position line (LOOK 4.3, 15 Parts 1 and 12).
  const menuBtn = el('button', { class: 'btn btn-icon', type: 'button', id: 'day-menu', 'aria-label': t('day.menu'), on: { click: () => dayMenu(ctx, screen, v) } }, glyph('more'));
  box.appendChild(el('div', { class: 'day-head' },
    el('div', { class: 'pos-row' },
      el('p', { class: 'label grow', id: 'day-position' }, t('today.position', { r: day.pass, label: day.label || String(day.day) })),
      dayMenuRows(day, v.sets).length ? menuBtn : null),
    el('h1', { id: 'day-label' }, dayTitle(day)),
    el('span', { class: 'pill pill-info', id: 'round-pill' }, b.passes === null ? t('today.round', { r: day.pass }) : t('today.round.of', { r: day.pass, n: b.passes })),
    progressLine(v.sets)));
  if (b.notes) box.appendChild(el('p', { class: 'lead', id: 'block-notes' }, b.notes));

  // The open row: the one he tapped, else the first set still planned.
  // Cards follow the day's own order (a swap keeps its place, A1-5).
  const order = v.slots;
  const planned = order.flatMap(sl => v.sets.filter(s => s.slot === sl && s.status === 'planned'));
  let open = planned.find(s => s.id === openId) || planned[0] || null;
  if (day.status === 'done') open = null;
  const since = await store.sinceLastSet(day.id);

  if (inset && inset.day !== day.id) inset = null;
  for (const slot of order) {
    const sets = v.sets.filter(s => s.slot === slot);
    // The exercise as this block uses it, in every reader on the card (15 Part 18, R4-04).
    const ex = effectiveExercise(b, v.exercises.get(sets[0].exercise_id));
    const last = (await store.lastTime(sets[0].exercise_id, day.id)).filter(s => s.kind === 'work');
    box.appendChild(card(ctx, screen, v, slot, sets, ex, last, open, since));
  }
  // Finish day only on a day he started (or skipped through): one tap on an untouched day
  // must never close it and move him on (C34).
  if (finishable(day, v.sets)) {
    box.appendChild(el('button', { class: 'btn btn-primary', type: 'button', id: 'finish-day', on: { click: () => finishFlow(ctx, day.id) } }, t('today.finish')));
  }
  commit({ 'data-day': day.id, 'data-status': day.status });
}

// The day progress numbers (15 Part 13): every set row of the day counts (warm-ups, L and R
// rows included); a row counts as through once it is done or skipped AND its write has
// committed, so a row still Saving or Not saved never moves the line.
export function dayProgress(sets, states) {
  const total = sets.length;
  const through = sets.filter(s => (s.status === 'done' || s.status === 'skipped') && !(states && states.has(s.id))).length;
  return { done: through, total };
}

// The progress line (LOOK 4.3): a native <progress>, max and value set with setAttribute, no
// animation, no number beside it; its name says the count. Hidden on a day with no sets.
function progressLine(sets) {
  const p = dayProgress(sets, rowState);
  if (!p.total) return null;
  const bar = el('progress', { id: 'day-progress', 'aria-label': p.total === 1 ? t('today.progress.one', { done: p.done }) : t('today.progress', { done: p.done, total: p.total }) });
  bar.setAttribute('max', String(p.total));
  bar.setAttribute('value', String(p.done));
  return bar;
}

// The day's own name: its label, or the numbered name when it has none (15 Part 1).
export function dayTitle(day) {
  return day.label || t('day.n', { n: day.day });
}

// The day menu rows that apply to this day, in the LOOK 4.3 order; rows that do not apply
// are left out, never shown disabled. Skip day sits after the hairline, on a planned or open
// day with no done set (15 Part 15, R4-02).
export function dayMenuRows(day, sets) {
  const rows = [];
  const live = day.status === 'planned' || day.status === 'open';
  if (live) rows.push('relabel');
  if (day.status === 'open') rows.push('reset');
  if (live && !(sets || []).some(s => s.status === 'done')) rows.push('skip');
  return rows;
}

function dayMenu(ctx, screen, v) {
  const day = v.day;
  let sh = null;
  const act = {
    relabel: () => { sh.close(); relabelSheet(day.label, async (val) => { await ctx.store.relabelDay(day.id, val); redraw(ctx, screen); }); },
    reset: () => { sh.close(); resetSheet(ctx, screen, v); },
    skip: () => { sh.close(); skipDaySheet(ctx, screen, v); }
  };
  const words = { relabel: 'day.relabel', reset: 'day.reset', skip: 'daymenu.skip' };
  // The hairline sets off the row that moves the block forward (LOOK 4.3).
  sh = sheet({ id: 'day-menu-sheet' }, el('div', { class: 'card' }, dayMenuRows(day, v.sets).map(k =>
    el('button', { class: 'menu-row' + (k === 'skip' ? ' menu-row-sep' : ''), type: 'button', 'data-dayitem': k, on: { click: act[k] } }, t(words[k])))));
}

// Skip day (LOOK 4.11 confirm, 15 Part 15): a title, one line, a secondary confirm and a quiet
// Cancel. No typed word, no undo. The store skips every planned set, ends the day and plans the
// next (or ends the block); keep-awake is released; no feedback, no overall sheet, no Day done.
function skipDaySheet(ctx, screen, v) {
  const go = el('button', { class: 'btn btn-secondary', type: 'button', id: 'skipday-go' }, t('daymenu.skip'));
  const cancel = el('button', { class: 'btn btn-quiet', type: 'button', id: 'skipday-cancel' }, t('text.cancel'));
  const sh = sheet({ id: 'skipday-sheet', title: t('skipday.title') },
    el('p', { class: 'small' }, t('skipday.line')), go, el('div', { class: 'quiet-row' }, cancel));
  cancel.addEventListener('click', () => sh.close());
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      await ctx.store.skipDay(v.day.id);
    } catch (e) {
      go.disabled = false;
      toast(t('today.notsaved'));
      return;
    }
    sh.close();
    ctx.wake.release();
    openId = null;
    ctx.render();
  });
}

// Reset day (LOOK 4.3, 15 Part 12): a typed RESET, then the store makes the safety copy and
// the one write. Keep-awake stays on. A write that fails says so and the button stays live.
function resetSheet(ctx, screen, v) {
  const n = v.sets.filter(s => s.status === 'done').length;
  const go = el('button', { class: 'btn btn-danger', type: 'button', id: 'reset-go' }, glyph('warn'), t('day.reset'));
  const cancel = el('button', { class: 'btn btn-quiet', type: 'button', id: 'reset-cancel' }, t('text.cancel'));
  // A scrim tap closes it only while nothing is typed (LOOK 3.3, review P19).
  const conf = typedConfirm(t('reset.type'), 'RESET', go);
  const sh = sheet({ id: 'reset-sheet', title: t('reset.title'), canDismiss: () => untyped(conf) },
    el('p', { class: 'small' }, tn('reset.line', n)), conf, go, el('div', { class: 'quiet-row' }, cancel));
  cancel.addEventListener('click', () => sh.close());
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      await ctx.store.resetDay(v.day.id);
    } catch (e) {
      go.disabled = false;
      toast(t('today.notsaved'));
      return;
    }
    sh.close();
    openId = null;
    redraw(ctx, screen);
  });
}

// The relabel sheet (LOOK 4.3), shared by Today and the builder. Save trims spaces; an empty
// field and Clear label both save no label. A write that fails keeps the sheet open.
export function relabelSheet(current, onSave) {
  const was = current || '';
  const input = el('input', { type: 'text', class: 'field', id: 'relabel-in', maxlength: String(LIMITS.LABEL), autocapitalize: 'characters',
    autocomplete: 'off', 'aria-label': t('relabel.title'), 'aria-describedby': 'relabel-help' });
  input.value = was;
  input.addEventListener('focus', () => { try { input.setSelectionRange(0, input.value.length); } catch (_) { /* not a text box */ } });
  const save = el('button', { class: 'btn btn-primary', type: 'button', id: 'relabel-save' }, t('text.save'));
  const clearBtn = el('button', { class: 'btn btn-quiet', type: 'button', id: 'relabel-clear' }, t('relabel.clear'));
  const cancel = el('button', { class: 'btn btn-quiet', type: 'button', id: 'relabel-cancel' }, t('text.cancel'));
  const sh = sheet({ id: 'relabel-sheet', title: t('relabel.title'), canDismiss: () => input.value === was },
    input, el('p', { class: 'small', id: 'relabel-help' }, t('relabel.help')), save, el('div', { class: 'quiet-row' }, clearBtn, cancel));
  const done = async (val) => {
    try { await onSave(val); } catch (e) { toast(t('today.notsaved')); return; }
    sh.close();
  };
  save.addEventListener('click', () => done(input.value.trim()));
  clearBtn.addEventListener('click', () => done(''));
  cancel.addEventListener('click', () => sh.close());
  return sh;
}

function setupScreen(ctx) {
  let unit = 'lb';
  const lb = el('button', { class: 'chip is-on', type: 'button', id: 'unit-lb', 'aria-pressed': 'true' }, glyph('check'), t('unit.lb'));
  const kg = el('button', { class: 'chip', type: 'button', id: 'unit-kg', 'aria-pressed': 'false' }, glyph('check'), t('unit.kg'));
  const pick = (u) => {
    unit = u;
    lb.classList.toggle('is-on', u === 'lb'); lb.setAttribute('aria-pressed', String(u === 'lb'));
    kg.classList.toggle('is-on', u === 'kg'); kg.setAttribute('aria-pressed', String(u === 'kg'));
  };
  lb.addEventListener('click', () => pick('lb'));
  kg.addEventListener('click', () => pick('kg'));
  return el('div', { class: 'empty', id: 'setup' }, ghostTally(4),
    el('h2', {}, t('setup.title')), el('p', { class: 'lead' }, t('setup.line')),
    el('div', { class: 'seg' }, lb, kg),
    el('button', { class: 'btn btn-primary', type: 'button', id: 'setup-build', on: { click: async () => { await ctx.store.setSetting('unit', unit); openBuilder(ctx); } } }, t('setup.build')),
    el('button', { class: 'btn btn-quiet', type: 'button', id: 'setup-load', on: { click: () => { ctx.store.setSetting('unit', unit); ctx.loadBlockFile(); } } }, t('setup.load')));
}

function blockDone(ctx) {
  return el('div', { class: 'empty', id: 'block-done' }, ghostTally(4),
    el('h2', {}, t('empty.done.title')), el('p', { class: 'lead' }, t('empty.done.line')),
    el('button', { class: 'btn btn-primary', type: 'button', id: 'build-block', on: { click: () => openBuilder(ctx) } }, t('setup.build')),
    el('button', { class: 'btn btn-quiet', type: 'button', id: 'load-block', on: { click: () => ctx.loadBlockFile() } }, t('setup.load')));
}

function noBlock(ctx) {
  return el('div', { class: 'empty', id: 'no-block' }, ghostTally(4),
    el('h2', {}, t('empty.today.title')), el('p', { class: 'lead' }, t('empty.today.line')),
    el('button', { class: 'btn btn-primary', type: 'button', id: 'build-block', on: { click: () => openBuilder(ctx) } }, t('setup.build')),
    el('button', { class: 'btn btn-quiet', type: 'button', id: 'load-block', on: { click: () => ctx.loadBlockFile() } }, t('setup.load')));
}

// The chalk tally in groups of five (LOOK 3.9, stage 4 B3): marks 1 to 4 of a group are upright
// strokes and the fifth is the slash across them; a new group starts after five. Each mark is
// its own element, so the count is the number of elements (done or ghost), never a width.
export function tallyGroups(doneFlags) {
  const groups = [];
  doneFlags.forEach((done, i) => {
    if (i % 5 === 0) groups.push([]);
    groups[groups.length - 1].push({ slash: i % 5 === 4, done: !!done });
  });
  return groups;
}
function fillTally(tally, doneFlags) {
  tally.classList.add('tally-grouped');
  for (const g of tallyGroups(doneFlags)) {
    const box = el('span', { class: 'tally-group', 'aria-hidden': 'true' });
    for (const m of g) {
      if (m.slash) box.appendChild(el('span', { class: 'tally-slash' + (m.done ? ' is-done' : ''), 'aria-hidden': 'true' }));
      else box.appendChild(el('span', { class: 'tally-stroke' + (m.done ? ' is-done' : ''), 'aria-hidden': 'true' }));
    }
    tally.appendChild(box);
  }
}

function card(ctx, screen, v, slot, sets, ex, last, open, since) {
  const day = v.day;
  const done = sets.filter(s => s.status === 'done').length;
  const allOver = sets.every(s => s.status !== 'planned');
  // The tally is named for a screen reader; only its strokes are hidden (A1-3).
  const counted = sets.filter(s => s.status !== 'skipped');
  const tally = el('span', { class: 'tally', role: 'img', 'aria-label': counted.length === 1 ? t('tally.aria.one', { done }) : t('tally.aria', { done, total: counted.length }) });
  fillTally(tally, counted.map(s => s.status === 'done'));
  const name = ex ? ex.name : sets[0].exercise_id;
  const holdsOpen = open && open.slot === slot;
  const sinceLine = holdsOpen && since !== null ? el('p', { class: 'ex-since', id: 'since-last' }) : null;
  if (sinceLine) {
    const base = Date.now() - since;
    const paint = () => {
      const ms = Date.now() - base;
      if (ms < 0 || ms > 3 * 3600 * 1000) { sinceLine.hidden = true; return; }
      const m = Math.floor(ms / 60000), ss = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
      sinceLine.textContent = t('today.since', { m, ss });
    };
    paint();
    setTimeout(() => { if (sinceLine.isConnected) { clearInterval(sinceTimer); sinceTimer = setInterval(paint, 1000); } }, 0);
  }
  const lastLine = last.length ? el('p', { class: 'ex-last' }, last.map(s => t('today.last', { load: fmtNum(s.done.load), reps: s.done.reps })).join(', ')) : null;
  const lift = liftOf(v, slot, sets[0].exercise_id);
  // His lift note (15 Part 18, LOOK 3.2): its own quiet line under the header, his words, text only.
  const noteLine = lift && lift.short_note ? el('p', { class: 'ex-note' }, lift.short_note) : null;
  const menuBtn = el('button', { class: 'btn btn-icon', type: 'button', 'data-menu': String(slot), 'aria-label': t('menu.more', { exercise: name }), on: { click: () => cardMenu(ctx, v, slot, ex) } }, glyph('more'));
  const box = el('div', { class: 'ex-card' + (allOver ? ' is-done' : ''), 'data-slot': String(slot), 'data-exercise': sets[0].exercise_id },
    el('div', { class: 'ex-head' },
      el('div', { class: 'grow' },
        el('p', { class: 'ex-name' }, allOver ? glyph('check') : null, name),
        ex ? el('p', { class: 'ex-sub' }, t('today.sub', { muscle: MUSCLE_NAMES[ex.muscle] || '', equipment: EQUIPMENT_NAMES[ex.equipment] || '' })) : null,
        lastLine, sinceLine),
      tally, menuBtn), noteLine);
  // The block check inset (15 Part 17): under the row just ticked, or above the open row when
  // opened from the card menu, while the exercise still has a planned set.
  const cks = checksFor(v.block, sets[0].exercise_id);
  const showInset = inset && inset.slot === slot && cks.length && day.status !== 'done' && sets.some(s => s.status === 'planned');
  const insetAt = !showInset ? null : inset.after && sets.some(s => s.id === inset.after) ? inset.after : null;
  const firstPlanned = sets.find(s => s.status === 'planned');
  for (const s of sets) {
    if (showInset && !insetAt && s === firstPlanned) box.appendChild(checkInset(ctx, screen, v, slot, cks));
    box.appendChild(setRow(ctx, screen, v, s, ex, open && open.id === s.id, lift));
    if (showInset && insetAt === s.id) box.appendChild(checkInset(ctx, screen, v, slot, cks));
  }
  const foot = el('div', { class: 'ex-foot' },
    day.status !== 'done' && canAdd(v.block, ex) ? el('button', { class: 'btn btn-quiet', type: 'button', 'data-addset': String(slot), on: { click: async () => { await ctx.store.addSet(day.id, slot); redraw(ctx, screen); } } }, glyph('plus'), t('menu')[0]) : el('span', {}),
    ex && ex.link && isLink(ex.link) ? linkTo(ex.link) : null);
  box.appendChild(foot);
  return box;
}

// The block's lift for this card (his note and goal line), or null for a swapped-in slot.
function liftOf(v, slot, exerciseId) {
  const tpl = (v.block.day_templates || []).find(d => d.day === v.day.day);
  return (tpl && tpl.lifts.find(l => l.slot === slot && l.exercise_id === exerciseId)) || null;
}

// The check inset (LOOK 3.2, 15 Part 17, R4-03): one row per check with No and Yes side by side.
// A Yes is sticky: its No chip is disabled with the sticky line, and it offers Stop and Keep going.
function checkInset(ctx, screen, v, slot, cks) {
  const fb = v.feedback.find(f => f.id === v.day.id + ':x' + slot);
  const ans = (fb && fb.checks) || {};
  const pick = async (key, val) => {
    try { await ctx.store.saveChecks(v.day.id, slot, { [key]: val }); } catch (e) { toast(t('today.notsaved')); }
    await redraw(ctx, screen);
  };
  const rows = cks.map((c) => {
    const yes = ans[c.key] === true, no = ans[c.key] === false;
    const chip = (isYes, on) => el('button', { class: 'chip' + (on ? ' is-on' : ''), type: 'button', 'data-checkans': c.key + (isYes ? '-yes' : '-no'),
      'aria-pressed': String(on), disabled: !isYes && yes ? true : null, 'aria-describedby': !isYes && yes ? 'sticky-' + slot + '-' + c.key : null,
      on: { click: () => { if (isYes) { if (!yes) pick(c.key, true); } else pick(c.key, no ? null : false); } } },
      on ? glyph('check') : null, el('span', { class: 'grow' }, t(isYes ? 'fb.yes' : 'fb.no')));
    const parts = [el('p', { class: 'q-text' }, c.ask), el('div', { class: 'check-chips' }, chip(false, no), chip(true, yes))];
    if (yes) {
      parts.push(el('p', { class: 'small', id: 'sticky-' + slot + '-' + c.key }, t('check.sticky')));
      parts.push(el('p', {}, t('check.says', { stop_note: c.stop_note })));
      parts.push(el('div', { class: 'btn-row' },
        el('button', { class: 'btn btn-secondary', type: 'button', 'data-stopnow': c.key, on: { click: async () => {
          inset = null;
          try { await ctx.store.stopExercise(v.day.id, slot); } catch (e) { toast(t('today.notsaved')); }
          await redraw(ctx, screen);
          await afterSlotChange(ctx, screen, v.day.id, slot);
        } } }, t('check.stop')),
        el('button', { class: 'btn btn-secondary', type: 'button', 'data-keep': c.key, on: { click: () => { inset = null; redraw(ctx, screen); } } }, t('check.keep'))));
    }
    return el('div', { class: 'check-q', 'data-check': c.key }, ...parts);
  });
  return el('div', { class: 'inset check-inset', 'data-inset': String(slot) }, el('p', { class: 'label' }, t('check.inset.title')), ...rows);
}

function linkTo(href) {
  const a = el('a', { target: '_blank', class: 'video-link' }, t('video.watch'));
  a.setAttribute('rel', LINK_REL);
  a.setAttribute('href', href);
  return a;
}

function redraw(ctx, screen) {
  return draw(ctx, screen).catch(() => {});
}

function setRow(ctx, screen, v, s, ex, isOpen, lift) {
  const block = v.block, day = v.day;
  const st = rowState.get(s.id);
  const state = st || (s.status === 'done' ? 'done' : s.status === 'skipped' ? 'skipped' : isOpen ? 'open' : 'todo');
  const cur = s.done ? { ...s.done } : startValues(s);
  const countWord = s.target.count_label || (ex ? ex.count_label : t('unit.reps'));
  const row = el('div', { class: 'set is-' + state + (isOpen ? ' is-open' : ''), 'data-set': s.id, 'data-state': state });

  let loadIn = null, repsIn = null;
  const helper = el('p', { class: 'helper' });
  const valueCell = (kind) => {
    const val = kind === 'load' ? cur.load : cur.reps;
    const btn = el('button', { class: 'val-btn', type: 'button', 'data-val': kind }, fmtNum(val));
    const cell = el('div', { class: 'cell' }, btn, el('span', { class: 'unit' }, kind === 'load' ? unitWord(block, s.target) : countWord));
    if (isOpen && !st) {
      btn.addEventListener('click', () => {
        const limitKey = kind === 'load' ? 'LOAD_CHARS' : 'REPS_CHARS';
        const input = el('input', {
          type: 'text', class: 'val-in', 'data-input': kind, inputmode: kind === 'load' ? 'decimal' : 'numeric', autocomplete: 'off',
          enterkeyhint: 'done', maxlength: String(LIMITS[limitKey]), 'aria-label': t(kind === 'load' ? 'field.load' : 'field.reps', { set: setLabel(s) })
        });
        input.value = fmtNum(val);
        const shown = input.value;
        btn.replaceWith(input);
        if (kind === 'load') loadIn = input; else repsIn = input;
        document.body.classList.add('is-typing');
        input.focus();
        // Select the old value only if he has not started typing yet, so a late select
        // never swallows the first digits he typed.
        setTimeout(() => { if (input.value !== shown) return; try { input.setSelectionRange(0, input.value.length); } catch (_) { /* not a text box */ } }, 0);
        const commit = () => readTyped(kind, input);
        input.addEventListener('change', commit);
        input.addEventListener('blur', () => { document.body.classList.remove('is-typing'); commit(); });
      });
    } else {
      btn.addEventListener('click', () => { if (s.status === 'planned') { openId = s.id; redraw(ctx, screen); } });
    }
    return cell;
  };

  // A typed value: refused with the number line and the old value kept, else saved as a draft.
  const readTyped = (kind, input) => {
    const n = readNumber(input.value, kind === 'load' ? LIMITS.LOAD_MAX : LIMITS.REPS_MAX, kind === 'reps');
    if (Number.isNaN(n)) {
      helper.textContent = t(kind === 'load' ? 'num.load' : 'num.reps');
      input.value = fmtNum(kind === 'load' ? cur.load : cur.reps);
      return false;
    }
    if (kind === 'load') cur.load = n; else cur.reps = n;
    input.value = fmtNum(n);
    ctx.store.saveDraft(s.id, cur).catch(() => {});
    return true;
  };

  // Every tick has a name, in each state (A1-3). A skipped set shows its pill in the helper slot (LOOK 3.1 r4.4).
  const set = setLabel(s);
  const tickName = state === 'done' ? t('today.tick.done', { set }) : state === 'saving' ? t('today.tick.saving', { set })
    : state === 'skipped' ? t('pill.skipped.aria', { set }) : t('today.tick', { set });
  const tick = el('button', { class: 'tick', type: 'button', 'data-tick': s.id, 'aria-pressed': String(s.status === 'done'), 'aria-label': tickName },
    el('span', { class: 'ring' }, state === 'done' ? glyph('check') : state === 'saving' ? glyph('dots') : state === 'failed' ? glyph('bang') : state === 'skipped' ? glyph('skip') : null));
  row.append(el('span', { class: 'num set-no' }, setLabel(s)), valueCell('load'), valueCell('reps'), tick);

  if (state === 'saving') helper.textContent = t('today.saving');
  else if (state === 'failed') helper.textContent = t('today.notsaved');
  else if (isOpen || state === 'todo') helper.textContent = helperLine(s, lift);
  else if (state === 'skipped') helper.appendChild(el('span', { class: 'pill pill-skip', 'aria-hidden': 'true' }, glyph('skip'), t('pill.skipped')));
  // Always on the row (empty hides by CSS), so a refused number can always say why (C23).
  row.appendChild(helper);

  const doTick = async (retry) => {
    // A field still focused is read first, so the typed value is the one saved.
    for (const [kind, input] of [['load', loadIn], ['reps', repsIn]]) if (input && document.activeElement === input && !readTyped(kind, input)) return;
    // Outside the rep range: ask once for this tick (15 Part 8). A retry of a failed save
    // was already answered. Cancel keeps the row open with the value as its draft.
    const ask = retry ? null : rangeAsk(s, cur.reps);
    if (ask) ctx.wake.ensure();   // asked inside the tap, before any wait (F28)
    if (ask && (await ctx.store.getSetting('rep_ask', true)) !== false) {
      const r = await rangeSheet(ask);
      if (!r.save) {
        openId = s.id;
        await ctx.store.saveDraft(s.id, cur).catch(() => {});
        return redraw(ctx, screen);
      }
      if (r.noask) await ctx.store.setSetting('rep_ask', false).catch(() => {});
    }
    ctx.wake.ensure();
    rowState.set(s.id, 'saving');
    redraw(ctx, screen);
    try {
      await ctx.store.tick(s.id, { ...cur });
      rowState.delete(s.id);
      ctx.wake.ensure();
      // Every saved tick on a card with block checks shows the inset under that row, warm-ups
      // included; the next tick replaces it (15 Part 17, R4-03, review R37).
      inset = checksFor(v.block, s.exercise_id).length ? { day: day.id, slot: s.slot, after: s.id } : null;
    } catch (e) {
      rowState.set(s.id, 'failed');
    }
    openId = null;
    await redraw(ctx, screen);
    if (!rowState.has(s.id)) await afterSlotChange(ctx, screen, day.id, s.slot);
  };

  if (day.status !== 'done') {
    tick.addEventListener('click', async () => {
      if (state === 'failed' || state === 'open' || state === 'todo') {
        if (state === 'todo') { openId = s.id; }
        return doTick(state === 'failed');
      }
      if (state === 'done') { await ctx.store.untick(s.id); openId = s.id; return redraw(ctx, screen); }
      if (state === 'skipped') { await ctx.store.unskip(s.id); return redraw(ctx, screen); }
      return undefined;
    });
    if (state === 'failed') row.addEventListener('click', (ev) => { if (ev.target === row || ev.target === helper) doTick(true); });
  }

  if (isOpen && !st && day.status !== 'done') row.appendChild(strips(ctx, screen, v, s, ex, cur, helper));
  return row;
}

function strips(ctx, screen, v, s, ex, cur, helper) {
  const save = () => ctx.store.saveDraft(s.id, cur).then(() => redraw(ctx, screen)).catch(() => {});
  const stepName = { 'load+': 'step.load.more', 'load-': 'step.load.less', 'reps+': 'step.reps.more', 'reps-': 'step.reps.less' };
  const stepper = (kind, dir) => el('button', { class: 'step', type: 'button', 'data-step': kind + (dir > 0 ? '+' : '-'), 'aria-label': t(stepName[kind + (dir > 0 ? '+' : '-')]),
    on: { click: () => {
      if (kind === 'load') cur.load = stepLoad(ex, cur.load, dir, v.block.unit);
      else cur.reps = Math.max(0, Math.min(LIMITS.REPS_MAX, (cur.reps || 0) + dir));
      save();
    } } }, glyph(dir > 0 ? 'plus' : 'minus'));
  const chips = el('div', { class: 'rl-chips' });
  for (let i = 0; i <= 4; i++) {
    const on = cur.reps_left === i && (i < 4 || cur.reps_left_plus);
    chips.appendChild(el('button', { class: 'rl num' + (on ? ' is-on' : ''), type: 'button', 'data-rl': String(i), 'aria-pressed': String(on),
      'aria-label': i === 4 ? t('today.chip4.aria') : null,
      on: { click: () => {
        if (on) { cur.reps_left = null; cur.reps_left_plus = false; } else { cur.reps_left = i; cur.reps_left_plus = i === 4; }
        if (cur.reps_left !== 0) cur.failure = false;
        save();
      } } }, on ? glyph('check') : null, i === 4 ? t('today.chip4') : String(i)));
  }
  const fail = el('button', { class: 'toggle', type: 'button', id: 'fail-toggle', 'aria-pressed': String(!!cur.failure),
    on: { click: () => {
      cur.failure = !cur.failure;
      if (cur.failure) { cur.reps_left = 0; cur.reps_left_plus = false; }
      save();
    } } }, el('span', { class: 'box', 'aria-hidden': 'true' }, glyph('check')), t('today.failure'));
  // Strip 3: the failure toggle, then the set menu button at the right (LOOK 3.1, 15 Parts 9, 10).
  const menu = el('button', { class: 'btn btn-icon', type: 'button', 'data-setmenu': s.id, 'aria-label': t('set.menu', { set: setLabel(s) }),
    on: { click: () => setMenu(ctx, screen, v, s, ex) } }, glyph('more'));
  // Strip 2b, breaks, under the reps-left chips on a laps work set (LOOK 3.1, 15 Part 16).
  const br = breaksShown(s, ex) ? [el('p', { class: 'label' }, t('breaks.title')),
    breakChips(cur, setLabel(s), (n) => { cur.breaks = n; save(); })] : [];
  const out = el('div', { class: 'strips' },
    el('div', { class: 'steppers' }, el('div', {}, stepper('load', -1), stepper('load', 1)), el('div', {}, stepper('reps', -1), stepper('reps', 1))),
    el('p', { class: 'label' }, t('today.repsleft')), chips, ...br, el('div', { class: 'strip3' }, fail, menu));
  // Failure notes inform; they never block the save (DESIGN 5.3).
  if (cur.failure) {
    const b = v.block;
    const failsToday = v.sets.filter(x => x.id !== s.id && x.status === 'done' && x.done && x.done.failure).length;
    if (failsToday >= 1) out.appendChild(el('p', { class: 'fail-note', 'data-note': 'onefail' }, b.rule_notes.one_failure_set || t('note.onefail')));
    if (ex && ex.machine === false) out.appendChild(el('p', { class: 'fail-note', 'data-note': 'machine' }, b.rule_notes.failure_on_machine || t('note.machine')));
  }
  return out;
}

// Can this exercise gain a set in this block? (15 Part 9: the same rule as Add set.)
const canAdd = (block, ex) => !(ex && effectiveExercise(block, ex).no_added_sets === true);

// The set menu (LOOK 3.1): New set under this one on an open day, and Delete this set,
// shown disabled with its one reason line when it may not run.
function setMenu(ctx, screen, v, s, ex) {
  const rows = [];
  let sh = null;
  const act = (fn) => async () => {
    sh.close();
    try { await fn(); } catch (e) { toast(t('today.notsaved')); }
    await redraw(ctx, screen);
  };
  if (v.day.status === 'open' && canAdd(v.block, ex)) {
    rows.push(el('button', { class: 'menu-row', type: 'button', 'data-setitem': 'addbelow', on: { click: act(() => ctx.store.addSetBelow(s.id)) } }, t('set.addbelow')));
  }
  const why = deleteReason(v.sets.filter(x => x.slot === s.slot), s);
  const del = el('button', { class: 'menu-row', type: 'button', 'data-setitem': 'delete', 'aria-disabled': String(!!why),
    'aria-describedby': why ? 'set-delete-why' : null, disabled: why ? true : null,
    on: { click: act(async () => { await ctx.store.deleteSet(s.id); openId = null; await afterSlotChange(ctx, screen, v.day.id, s.slot); }) } }, t('set.delete'));
  rows.push(del);
  if (why) rows.push(el('p', { class: 'small menu-why', id: 'set-delete-why' }, t('set.delete.' + why)));
  sh = sheet({ id: 'set-menu', title: t('set.menu.title', { set: setLabel(s) }) }, el('div', { class: 'card' }, rows));
}

// Feedback rows he put off with Ask me later in this app session: they wait for Finish day.
const askedLater = new Set();

// A row the card inset made (15 Part 17): pending, holding check answers and nothing else, and
// not one he put off. Its questions are still owed after the last set.
export function checksOnlyRow(f, later) {
  return !!f && f.pending === true && f.pump === null && f.soreness === null && f.workload === null && !f.note &&
    !(later && later.has(f.id)) && Object.values(f.checks || {}).some(x => x !== null);
}

// After a slot runs out of planned sets, ask the feedback questions once.
async function afterSlotChange(ctx, screen, dayId, slot) {
  const v = await ctx.store.dayView(dayId);
  const sets = v.sets.filter(s => s.slot === slot);
  if (sets.some(s => s.status === 'planned')) return;
  const f = v.feedback.find(x => x.id === dayId + ':x' + slot);
  if (f && !checksOnlyRow(f, askedLater)) return;
  await feedbackSheet(ctx, v, slot, false);
  await redraw(ctx, screen);
}

// ---------------- the card menu ----------------

// The card menu order of record (LOOK 3.2, the 5.11 menu row, 14.7 F9; review P18): menu[1] to
// menu[4], Move up, Move down, menu[5] Notes, Checks, menu[6] Video link. menu.remove and
// menu.answers join this list in their own slices. Code index 0 to 5 is menu[1] to menu[6].
export const CARD_MENU_ORDER = [0, 1, 2, 3, 'up', 'down', 4, 'checks', 5];

// Rows that do not apply are left out (LOOK 3.2): a done day keeps only notes and link, a
// no-add exercise has no Add set, the first card has no Move up and the last no Move down.
// Checks shows only while the exercise still has a planned set, the same window as the inset
// (14.8 G10, review P5, P17); after the last set he answers the checks on the feedback sheet.
export function cardMenuKeep(v, slot, ex, i) {
  const at = v.slots.indexOf(slot);
  if (v.day.status === 'done') return i === 4 || i === 5;
  if (i === 0) return canAdd(v.block, ex);
  if (i === 'up') return at > 0;
  if (i === 'down') return at >= 0 && at < v.slots.length - 1;
  if (i === 'checks') return checksFor(v.block, ex ? ex.id : null).length > 0 && v.sets.some(s => s.slot === slot && s.status === 'planned');
  return true;
}

function cardMenu(ctx, v, slot, ex) {
  const words = t('menu');
  const dayId = v.day.id;
  const screen = document.getElementById('today');
  let sh = null;
  const act = (fn) => async () => {
    sh.close();
    try { await fn(); } catch (e) { toast(t('today.notsaved')); }
    if (screen) redraw(ctx, screen);
  };
  const rows = [
    [0, act(() => ctx.store.addSet(dayId, slot))],
    [1, act(async () => { await ctx.store.skipSet(dayId, slot); await afterSlotChange(ctx, screen, dayId, slot); })],
    [2, act(async () => { await ctx.store.skipExercise(dayId, slot); await afterSlotChange(ctx, screen, dayId, slot); })],
    [3, async () => { sh.close(); ctx.picker = { mode: 'swap', dayId, slot, back: '#/today' }; ctx.go('#/picker'); }],
    ['up', act(() => ctx.store.moveSlot(dayId, slot, -1))],
    ['down', act(() => ctx.store.moveSlot(dayId, slot, 1))],
    [4, () => { sh.close(); textSheet(ctx, ex, 'notes'); }],
    // Checks opens the block check inset while the exercise still has a planned set (15 Part 17,
    // 14.8 G10). It sits between Notes and Video link, the order of record (LOOK 3.2, the 5.11 menu row; P18).
    ['checks', () => { sh.close(); inset = { day: dayId, slot, after: null }; if (screen) redraw(ctx, screen); }],
    [5, () => { sh.close(); textSheet(ctx, ex, 'link'); }]
  ].sort((a, b) => CARD_MENU_ORDER.indexOf(a[0]) - CARD_MENU_ORDER.indexOf(b[0]));
  const keep = ([i]) => cardMenuKeep(v, slot, ex, i);
  const word = (i) => (i === 'up' ? t('menu.up') : i === 'down' ? t('menu.down') : i === 'checks' ? t('menu.checks') : words[i]);
  sh = sheet({ id: 'card-menu' }, el('div', { class: 'card' }, rows.filter(keep).map(([i, fn]) =>
    el('button', { class: 'menu-row', type: 'button', 'data-item': String(i), on: { click: fn } }, word(i)))));
}

function textSheet(ctx, ex, field) {
  if (!ex) return;
  const isNote = field === 'notes';
  const title = t(isNote ? 'note.title' : 'link.label');
  const input = isNote
    ? el('textarea', { rows: '3', maxlength: String(LIMITS.NOTE), id: 'ex-text', 'aria-label': t('note.title') })
    : el('input', { type: 'url', class: 'field', maxlength: String(LIMITS.STR), id: 'ex-text', autocomplete: 'off', 'aria-label': t('link.label'), 'aria-describedby': 'ex-text-bad' });
  input.value = ex[field] || '';
  // A refused link says why in the field's helper slot (A1-3).
  const badLine = isNote ? null : el('p', { class: 'helper', id: 'ex-text-bad', role: 'status', hidden: true }, t('link.bad'));
  const save = el('button', { class: 'btn btn-primary', type: 'button', id: 'ex-text-save' }, t('text.save'));
  const clearBtn = isNote ? null : el('button', { class: 'btn btn-quiet', type: 'button', id: 'ex-text-clear' }, t('link.clear'));
  const sh = sheet({ id: 'text-sheet', title, canDismiss: () => input.value === (ex[field] || '') },
    input, badLine, save, clearBtn ? el('div', { class: 'quiet-row' }, clearBtn) : null);
  // A refused or failed save keeps the sheet and the typed text (SR3, SR11): a link says link.bad
  // in its helper slot, a note shows today.notsaved.
  const done = async (val) => {
    try {
      await ctx.store.saveExerciseText(ex.id, field, val);
    } catch (e) {
      if (!isNote && e && e.code === 'bad text') { input.setAttribute('aria-invalid', 'true'); badLine.hidden = false; }
      else toast(t('today.notsaved'));
      return;
    }
    sh.close();
    const screen = document.getElementById('today');
    if (screen) redraw(ctx, screen);
  };
  save.addEventListener('click', async () => {
    const val = input.value.trim();
    if (!isNote && val !== '' && !isLink(val)) { input.setAttribute('aria-invalid', 'true'); badLine.hidden = false; return; }
    await done(val);
  });
  // Clear link saves no link at once, like Clear label on a day.
  if (clearBtn) clearBtn.addEventListener('click', () => done(''));
}

// ---------------- feedback (LOOK 4.4) ----------------

function chipStack(words, prefix, onPick, start) {
  let picked = start === undefined ? null : start;
  const box = el('div', { class: 'q-chips' });
  const chips = words.map((w, i) => el('button', { class: 'chip', type: 'button', 'data-answer': prefix + (i + 1), 'aria-pressed': 'false',
    on: { click: () => {
      picked = picked === i + 1 ? null : i + 1;
      chips.forEach((c, j) => { c.classList.toggle('is-on', picked === j + 1); c.setAttribute('aria-pressed', String(picked === j + 1)); });
      onPick(picked);
    } } }, el('span', { class: 'badge num' }, String(i + 1)), el('span', { class: 'grow' }, w), glyph('check')));
  chips.forEach((c, j) => { c.classList.toggle('is-on', picked === j + 1); c.setAttribute('aria-pressed', String(picked === j + 1)); });
  box.append(...chips);
  return box;
}

// Resolves when the sheet closes. skip=true shows Skip in place of Ask me later (Finish day).
export function feedbackSheet(ctx, v, slot, skip) {
  return new Promise((resolve) => {
    const sets = v.sets.filter(s => s.slot === slot);
    // A row on a slot with no set has nothing to ask, so it never holds Finish day (SB5).
    if (!sets.length) { resolve(); return; }
    const ex = v.exercises.get(sets[0].exercise_id);
    // Only the checks this block asks on this exercise, each pre-filled with any answer the card
    // inset already gave (15 Part 17, R4-03).
    const checks = checksFor(v.block, sets[0].exercise_id);
    const was = v.feedback.find(f => f.id === v.day.id + ':x' + slot);
    const given = (was && was.checks) || {};
    const a = { pump: null, soreness: null, workload: null, checks: {}, note: '' };
    for (const c of checks) if (given[c.key] === true || given[c.key] === false) a.checks[c.key] = given[c.key];
    let touched = false;
    const q = (key) => el('div', { class: 'q', 'data-q': key },
      el('p', { class: 'q-text' }, t('fb.q.' + key)),
      chipStack(t('fb.a.' + key), key + '-', (n) => { a[key] = n; touched = true; }));
    const parts = [q('pump'), q('soreness'), q('workload')];
    for (const c of checks) {
      // After the last set nothing is left to stop: a Yes shows the line only (r4, LOOK 4.4).
      const start = a.checks[c.key] === true ? 2 : a.checks[c.key] === false ? 1 : null;
      const inset = el('div', { class: 'inset', hidden: start !== 2, 'data-stop': c.key },
        el('p', {}, t('check.says', { stop_note: c.stop_note })));
      parts.push(el('div', { class: 'q', 'data-q': 'check_' + c.key },
        el('p', { class: 'q-text' }, c.ask),
        chipStack([t('fb.no'), t('fb.yes')], 'check-' + c.key + '-', (n) => {
          touched = true;
          a.checks[c.key] = n === null ? null : n === 2;
          inset.hidden = n !== 2;
        }, start), inset));
    }
    const note = el('textarea', { rows: '3', maxlength: String(LIMITS.NOTE), id: 'fb-note', 'aria-label': t('fb.note') });
    note.addEventListener('input', () => { touched = true; });
    parts.push(el('label', { class: 'q' }, el('span', { class: 'q-text' }, t('fb.note')), note));
    const saveBtn = el('button', { class: 'btn btn-primary', type: 'button', id: 'fb-save' }, t('fb.save'));
    const laterBtn = el('button', { class: 'btn btn-quiet', type: 'button', id: skip ? 'fb-skip' : 'fb-later' }, t(skip ? 'fb.skip' : 'fb.later'));
    const n = 3 + checks.length;
    // No scrim close: an answer is given only by Save, Ask me later or Skip, so a stray tap
    // never loses the questions or leaves a pending row on a done day (C39).
    const sh = sheet({ id: 'feedback', title: t('fb.title', { exercise: ex ? ex.name : '' }), sub: t('fb.sub', { n }),
      canDismiss: () => false, onClose: () => resolve() },
      ...parts, saveBtn, el('div', { class: 'quiet-row' }, laterBtn));
    // A refused or failed save keeps the sheet and his answers open, with today.notsaved (SR3, SR11).
    saveBtn.addEventListener('click', async () => {
      a.note = note.value;
      try { await ctx.store.saveFeedback(v.day.id, slot, a, false); } catch (e) { toast(t('today.notsaved')); return; }
      sh.close();
    });
    laterBtn.addEventListener('click', async () => {
      try {
        if (skip) await ctx.store.saveFeedback(v.day.id, slot, {}, false);
        else { await ctx.store.saveFeedback(v.day.id, slot, {}, true); askedLater.add(v.day.id + ':x' + slot); }
      } catch (e) { toast(t('today.notsaved')); return; }
      sh.close();
    });
  });
}

// ---------------- Finish day (DESIGN 5.3) ----------------

function overallSheet(ctx, v) {
  return new Promise((resolve) => {
    const scores = {};
    const parts = v.block.scores.map((sc) => {
      const grid = el('div', { class: 'score-grid' });
      const chips = [];
      for (let i = 0; i <= 10; i++) {
        const c = el('button', { class: 'score num', type: 'button', 'data-score': sc.key + '-' + i, 'aria-pressed': 'false',
          on: { click: () => {
            scores[sc.key] = scores[sc.key] === i ? null : i;
            chips.forEach((x, j) => { x.classList.toggle('is-on', scores[sc.key] === j); x.setAttribute('aria-pressed', String(scores[sc.key] === j)); });
          } } }, String(i));
        chips.push(c);
        grid.appendChild(c);
      }
      scores[sc.key] = null;
      return el('div', { class: 'q' }, el('p', { class: 'q-text' }, t('day.scale', { label: sc.label })), grid);
    });
    let result = null;
    const save = el('button', { class: 'btn btn-primary', type: 'button', id: 'day-save' }, t('day.save'));
    const skipBtn = el('button', { class: 'btn btn-quiet', type: 'button', id: 'day-skip' }, t('day.skip'));
    const sh = sheet({ id: 'overall', title: t('day.title'), sub: t('day.sub', { n: v.block.scores.length }), canDismiss: () => false, onClose: () => resolve(result) },
      ...parts, save, el('div', { class: 'quiet-row' }, skipBtn));
    save.addEventListener('click', () => { result = { ...scores }; sh.close(); });
    skipBtn.addEventListener('click', () => {
      result = Object.fromEntries(v.block.scores.map(s => [s.key, null]));
      sh.close();
    });
  });
}

export async function finishFlow(ctx, dayId) {
  const store = ctx.store;
  let v = await store.dayView(dayId);
  if (!v || v.day.status === 'done') return;
  // A day with no done set is never finished (R4-02): nothing is written, and the toast names
  // the Skip day route. The store refuses it too, inside the day queue (A3-R4).
  if (!v.sets.some(s => s.status === 'done')) { toast(t('today.finish.none')); return; }
  let scores;
  try {
    // (1) Each pending feedback sheet in turn, each with Skip. A row whose slot holds no set
    // (an old file or an old safety copy) is passed over, never asked (SB5).
    for (const f of v.feedback.filter(x => x.pending)) {
      const slot = Number(f.id.split(':x').pop());
      if (!v.sets.some(s => s.slot === slot)) continue;
      await feedbackSheet(ctx, v, slot, true);
      v = await store.dayView(dayId);
    }
    // (2) The overall sheet if the block has scores and the day has none yet.
    scores = v.day.scores;
    const hasScores = Object.values(v.day.scores || {}).some(x => x !== null);
    if (v.block.scores.length && !hasScores) scores = await overallSheet(ctx, v);
  } catch (e) {
    toast(t('today.notsaved'));
    ctx.render();
    return;
  }
  // (3) One transaction. (4) Keep-awake off. (5) The backup file rebuilt. (6) The nudge.
  // A write that does not save says so; the day stays open and keep-awake stays on (C35).
  try {
    await store.finishDay(dayId, scores || {});
  } catch (e) {
    const none = !!e && e.code === NO_DONE_SET;
    toast(t(none ? 'today.finish.none' : 'today.finish.notsaved'));
    ctx.render();
    return;
  }
  ctx.wake.release();
  await ctx.backup.rebuild();
  openId = null;
  inset = null;
  // (6) The Day done screen, then the nudge over it right after its first paint (15 Part 14).
  ctx.dayDone = { id: dayId, nudge: true };
  ctx.go('#/daydone/' + dayId);
}

// ---------------- Day done (15 Part 14, LOOK 4.10) ----------------

// The screen at #/daydone/<dayId>. The id must pass the store's id check and name a done day
// that this app session just finished, else Today (a boot on this address goes to Today).
export function renderDayDone(ctx, dayId) {
  const screen = el('section', { class: 'screen', id: 'daydone' });
  const want = ctx.dayDone;
  (async () => {
    const r = want && want.id === dayId ? await ctx.store.dayTotals(dayId).catch(() => null) : null;
    if (!r) { ctx.dayDone = null; ctx.go('#/today'); return; }
    const { day, totals } = r;
    const rows = [
      [totals.workDone, 'done.sets'], [totals.exDone, 'done.ex'], [totals.exSkipped, 'done.skipped']
    ].filter(([n]) => n > 0).map(([n, key]) => el('div', { class: 'done-row', 'data-done': key },
      el('span', { class: 'num done-n' }, String(n)), el('span', { class: 'done-word' }, t(n === 1 ? key + '.one' : key))));
    const tally = el('span', { class: 'tally tally-lg', role: 'img', id: 'done-tally',
      'aria-label': totals.workDone === 1 ? t('done.tally.one') : t('done.tally', { n: totals.workDone }) });
    fillTally(tally, Array.from({ length: totals.workDone }, () => true));
    const go = el('button', { class: 'btn btn-primary', type: 'button', id: 'done-go', on: { click: () => { ctx.dayDone = null; ctx.go('#/today'); } } }, t('done.go'));
    clear(screen);
    screen.append(
      el('p', { class: 'label', id: 'done-position' }, t('today.position', { r: day.pass, label: day.label || String(day.day) })),
      el('h1', {}, t('done.title')),
      tally,
      rows.length ? el('div', { class: 'card done-card' }, rows) : null,
      go);
    screen.setAttribute('data-day', day.id);
    if (want.nudge) {
      want.nudge = false;
      // Right after the first paint, never before it.
      requestAnimationFrame(() => setTimeout(() => nudge(ctx), 0));
    }
  })().catch(() => { ctx.go('#/today'); });
  return screen;
}

function nudge(ctx) {
  const now = el('button', { class: 'btn btn-primary', type: 'button', id: 'nudge-now' }, t('nudge.now'));
  const later = el('button', { class: 'btn btn-quiet', type: 'button', id: 'nudge-later' }, t('nudge.later'));
  const sh = sheet({ id: 'nudge', onClose: () => ctx.offerPendingUpdate() }, now, el('div', { class: 'quiet-row' }, later));
  now.addEventListener('click', () => { ctx.backup.share(now, () => sh.close()); });
  later.addEventListener('click', () => sh.close());
}

// The swap target from the picker.
export async function swapTo(ctx, exerciseId) {
  const p = ctx.picker;
  ctx.picker = null;
  if (!p || p.mode !== 'swap') return;
  await ctx.store.swapExercise(p.dayId, p.slot, exerciseId);
}
