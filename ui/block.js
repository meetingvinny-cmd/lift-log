// ui/block.js - the Block tab (16 B.5 row 14, LOOK 4.7): the round strip, the day rows of a round,
// the sets this round by muscle and Close block; the read-only day view at #/day/<id> (B.5 row 2,
// LOOK 4.11); and the Easy round stop sheet (B.5 row 4). Every word comes from strings.js; his own
// words (block name, day labels, exercise names) reach the page as text only.
import { el, clear, glyph, sheet, toast, ghostTally } from './dom.js';
import { t } from './strings.js';
import { MUSCLE_NAMES, MUSCLE_DETAIL_NAMES, EQUIPMENT_NAMES } from '../data/exercises.js';
import { effectiveExercise } from '../store.js';
import { tallyGroups, helperLine, dayTitle, tildeGlyph } from './today.js';

const DAY_OPEN = 'day open';    // the store's refusal code for Close block with a day open (B.5 row 7)
const fmtNum = (n) => (n === null || n === undefined) ? '' : String(Math.round(n * 100) / 100);

// ---------------- pure helpers (today.test.js) ----------------

// The word at the right of a day row (LOOK 4.7): Done, Now, the Not planned yet pill, the Skipped
// pill, or none for a planned day that is not the current one. Returns [key, kind] or null.
export function dayWord(d) {
  if (d.now) return ['blockday.now', 'now'];
  if (d.status === 'done') return ['blockday.done', 'done'];
  if (d.status === 'notplanned') return ['day.notplanned', 'notplanned'];
  if (d.status === 'skipped') return ['pill.skipped', 'skipped'];
  return null;
}

// The state word of a round cell (LOOK 4.7): done, now, easy, or none.
export function roundWord(r) {
  if (r.state === 'done') return 'round.done';
  if (r.state === 'now') return 'round.now';
  if (r.easy) return 'round.easy';
  return null;
}

// The change from last round as a signed number ({diff} in block.musclediff), or null when there
// is no last round or no change (the line is left out; LOOK 4.7: a fact, never good or bad).
export function diffText(change) {
  if (typeof change !== 'number' || change === 0) return null;
  return change > 0 ? '+' + change : String(change);
}

// The stop sheet count (B.5 row 4): a tap on a day of the easy round while hard days are left
// gives how many; any other day gives 0 and opens.
export function easyStop(ov, d) {
  const r = ov.rounds.find(x => x.pass === d.pass);
  return r && r.easy && ov.hard_left > 0 ? ov.hard_left : 0;
}

// The muscle key's name: the finer name, else the group name, else the key.
export function muscleName(key) {
  return MUSCLE_DETAIL_NAMES[key] || MUSCLE_NAMES[key] || key;
}

// ---------------- the Block tab ----------------

export function renderBlock(ctx) {
  const screen = el('section', { class: 'screen', id: 'block' });
  draw(ctx, screen, null).catch((e) => { screen.appendChild(el('p', { class: 'raw' }, String(e && e.message))); });
  return screen;
}

// A tap on a round cell draws again with that round's day rows; only the newest draw is put in.
const drawSeq = new WeakMap();
async function draw(ctx, screen, shown) {
  const seq = (drawSeq.get(screen) || 0) + 1;
  drawSeq.set(screen, seq);
  const store = ctx.store;
  const block = await store.activeBlock();
  const ov = block ? await store.blockOverview(block.id, shown) : null;
  if (drawSeq.get(screen) !== seq) return;
  clear(screen);
  if (!ov) {
    screen.appendChild(el('h1', {}, t('block.title')));
    screen.appendChild(el('div', { class: 'empty', id: 'block-none' }, ghostTally(4), el('h2', {}, t('empty.today.title')), el('p', { class: 'lead' }, t('empty.today.line'))));
    return;
  }
  const profile = t(ov.profile === 'adaptive' ? 'profile.adjust' : 'profile.fixed');
  screen.setAttribute('data-block', ov.id);
  screen.append(
    el('h1', {}, t('block.title')),
    el('p', { class: 'lead', id: 'block-head' }, ov.passes === null ? t('block.head.open', { name: ov.name, profile }) : t('block.head', { name: ov.name, rounds: ov.passes, profile })),
    el('div', { class: 'round-strip', id: 'round-strip' }, ov.rounds.map(r => roundCell(ctx, screen, ov, r))),
    el('p', { class: 'label', id: 'round-label' }, t('round.label', { r: ov.shown })),
    el('div', { class: 'card', id: 'block-days' }, ov.days.map(d => dayRow(ctx, ov, d))));
  if (ov.muscles.length) {
    screen.append(el('p', { class: 'label' }, t('block.musclesets')),
      el('div', { class: 'muscle-table', id: 'muscle-table' }, ov.muscles.map(m => {
        const diff = diffText(m.change);
        return el('div', { class: 'muscle-row', 'data-muscle': m.muscle },
          el('span', { class: 'muscle-name' }, muscleName(m.muscle)),
          el('span', { class: 'num muscle-sets' }, String(m.sets)),
          el('span', { class: 'small muscle-diff' }, diff === null ? '' : t('block.musclediff', { diff })));
      })));
  }
  // Close block (B.5 row 7, LOOK 4.7): a secondary button, never the danger skin; current block only.
  if (ov.status !== 'done') {
    screen.appendChild(el('button', { class: 'btn btn-secondary', type: 'button', id: 'block-end', on: { click: () => endFlow(ctx, ov) } }, t('daymenu.end')));
  }
}

// One round cell (LOOK 4.7): the round over its state word; the current round has the accent
// border; a done round shows the check, the easy round the drawn "~". A tap shows its day rows.
function roundCell(ctx, screen, ov, r) {
  const word = roundWord(r);
  return el('button', {
    class: 'round-cell is-' + r.state + (r.easy ? ' is-easy' : ''), type: 'button', 'data-round': String(r.pass), 'data-state': r.state,
    'data-easy': String(!!r.easy), 'aria-pressed': String(r.pass === ov.shown), on: { click: () => { draw(ctx, screen, r.pass).catch(() => {}); } }
  }, el('span', { class: 'num round-num' }, t('round.short', { r: r.pass })),
  el('span', { class: 'round-word' }, r.state === 'done' ? glyph('check') : r.easy ? tildeGlyph() : null, word ? t(word) : ''));
}

// One day row (LOOK 4.7): the day's name, its tally, its word at the right, and the chevron.
function dayRow(ctx, ov, d) {
  const w = dayWord(d);
  let right = null;
  if (w && (w[1] === 'notplanned')) right = el('span', { class: 'pill pill-info' }, t(w[0]));
  else if (w && w[1] === 'skipped') right = el('span', { class: 'pill pill-skip' }, t(w[0]));
  else if (w) right = el('span', { class: 'block-day-word is-' + w[1] }, t(w[0]));
  let tally = null;
  if (d.total > 0) {
    tally = el('span', { class: 'tally tally-grouped block-day-tally', role: 'img', 'aria-label': d.total === 1 ? t('tally.aria.one', { done: d.done }) : t('tally.aria', { done: d.done, total: d.total }) });
    for (const g of tallyGroups(Array.from({ length: d.total }, (_, i) => i < d.done))) {
      tally.appendChild(el('span', { class: 'tally-group', 'aria-hidden': 'true' }, g.map(m => el('span', { class: (m.slash ? 'tally-slash' : 'tally-stroke') + (m.done ? ' is-done' : ''), 'aria-hidden': 'true' }))));
    }
  }
  return el('button', { class: 'row row-link menu-row block-day', type: 'button', 'data-blockday': d.ref, 'data-status': d.status, 'data-now': String(!!d.now), on: { click: () => openDay(ctx, ov, d) } },
    el('span', { class: 'grow block-day-name' }, dayTitle(d)), tally, right, glyph('chevron'));
}

// A day row tap: an easy-round day while hard days are left opens the stop sheet (B.5 row 4, M40);
// the current day goes to Today; any other day opens the read-only view.
function openDay(ctx, ov, d) {
  const n = easyStop(ov, d);
  if (n > 0) { easySheet(ctx, n); return; }
  if (d.now) { ctx.go('#/today'); return; }
  ctx.go('#/day/' + d.ref);
}

// The Easy round stop sheet (LOOK 4.11): a title, one line with the count, the primary that goes
// to the open day, and a quiet Cancel. No amber, no red: it is a route, not a warning.
function easySheet(ctx, n) {
  const go = el('button', { class: 'btn btn-primary', type: 'button', id: 'easy-go' }, t('easy.go'));
  const cancel = el('button', { class: 'btn btn-quiet', type: 'button', id: 'easy-cancel' }, t('text.cancel'));
  const sh = sheet({ id: 'easy-sheet', title: t('easy.title') },
    el('p', { class: 'small', id: 'easy-line' }, n === 1 ? t('easy.line.one') : t('easy.line', { n })), go, el('div', { class: 'quiet-row' }, cancel));
  cancel.addEventListener('click', () => sh.close());
  go.addEventListener('click', () => { sh.close(); ctx.go('#/today'); });
}

// Close block from the Block tab (LOOK 4.7 r4): with a day open, the end.open toast and nothing
// else; else the 4.11 confirm, then Today shows the Block finished state.
async function endFlow(ctx, ov) {
  if (await ctx.store.isDayOpen()) { toast(t('end.open')); return; }
  const go = el('button', { class: 'btn btn-secondary', type: 'button', id: 'end-go' }, t('daymenu.end'));
  const cancel = el('button', { class: 'btn btn-quiet', type: 'button', id: 'end-cancel' }, t('text.cancel'));
  const sh = sheet({ id: 'end-sheet', title: t('end.title') },
    el('p', { class: 'small' }, t('end.line')), go, el('div', { class: 'quiet-row' }, cancel));
  cancel.addEventListener('click', () => sh.close());
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      await ctx.store.endBlock(ov.id);
    } catch (e) {
      go.disabled = false;
      toast(t(e && e.code === DAY_OPEN ? 'end.open' : 'today.notsaved'));
      return;
    }
    sh.close();
    ctx.go('#/today');
  });
}

// ---------------- the read-only day view (#/day/<id>) ----------------

// One view, its states told apart by the pill and the line (LOOK 4.11). No tick button, stepper,
// set menu, card menu, Finish day or sleep card. A bad id, or one that names no day of a block on
// the phone, goes to the Block tab (B.10 item 9); the open or current day goes to Today.
export function renderDayView(ctx, dayId) {
  const screen = el('section', { class: 'screen', id: 'dayview' });
  drawDay(ctx, screen, dayId).catch(() => ctx.go('#/block'));
  return screen;
}

async function drawDay(ctx, screen, dayId) {
  let p = null;
  try { p = await ctx.store.dayPreview(dayId); } catch (e) { p = null; }
  if (!p) { ctx.go('#/block'); return; }
  if (p.state === 'open' || p.state === 'current') { ctx.go('#/today'); return; }
  const day = p.day, b = p.block;
  const roundPill = el('span', { class: 'pill pill-info', id: 'round-pill' }, b.passes === null ? t('today.round', { r: day.pass }) : t('today.round.of', { r: day.pass, n: b.passes }));
  let second = null;
  if (p.state === 'notplanned') second = el('span', { class: 'pill pill-info', id: 'state-pill' }, t('day.notplanned'));
  else if (p.state === 'done') second = el('span', { class: 'pill pill-yes', id: 'state-pill' }, t('blockday.done'));
  else if (p.state === 'skipped') second = el('span', { class: 'pill pill-skip', id: 'state-pill' }, t('pill.skipped'));
  else if (p.easy) second = el('span', { class: 'pill pill-easy', id: 'easy-pill' }, tildeGlyph(), t('pill.easy'));
  let line = null;
  if (p.state === 'notplanned') line = t('day.notplanned.line');
  else if (p.state === 'later' && p.after) line = t('day.later.line', { label: p.after });
  else if (p.state === 'done' && day.done_at) line = new Date(day.done_at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  clear(screen);
  screen.setAttribute('data-day', day.id);
  screen.setAttribute('data-state', p.state);
  screen.append(
    el('a', { class: 'btn btn-quiet', href: '#/block', id: 'day-back' }, glyph('back'), t('check.backtab')),
    el('div', { class: 'day-head' },
      el('p', { class: 'label', id: 'day-position' }, t('today.position', { r: day.pass, label: day.label || String(day.day) })),
      el('h1', { id: 'day-label' }, dayTitle(day)),
      second ? el('div', { class: 'pill-row' }, roundPill, second) : roundPill,
      line ? el('p', { class: 'small', id: 'day-line' }, line) : null));
  if (p.state === 'notplanned') {
    for (const l of [...p.lifts].sort((x, y) => x.slot - y.slot)) {
      const ex = effectiveExercise(b, p.exercises.get(l.exercise_id));
      const rows = Array.from({ length: Math.max(1, l.sets) }, (_, i) => emptyRow(i + 1));
      screen.appendChild(roCard(ex, l.exercise_id, l.slot, rows, false));
    }
    return;
  }
  for (const slot of p.slots) {
    const sets = p.sets.filter(s => s.slot === slot);
    const ex = effectiveExercise(b, p.exercises.get(sets[0].exercise_id));
    const tpl = b.day_templates.find(d => d.day === day.day);
    const lift = tpl ? tpl.lifts.find(x => x.slot === slot && x.exercise_id === sets[0].exercise_id) || null : null;
    screen.appendChild(roCard(ex, sets[0].exercise_id, slot, sets.map(s => roRow(b, s, ex, lift)), sets.every(s => s.status !== 'planned')));
  }
}

function roCard(ex, exerciseId, slot, rows, allOver) {
  const name = ex ? ex.name : exerciseId;
  return el('div', { class: 'ex-card is-readonly' + (allOver ? ' is-done' : ''), 'data-slot': String(slot), 'data-exercise': exerciseId },
    el('div', { class: 'ex-head' },
      el('div', { class: 'grow' },
        el('p', { class: 'ex-name' }, name),
        ex ? el('p', { class: 'ex-sub' }, t('today.sub', { muscle: MUSCLE_NAMES[ex.muscle] || '', equipment: EQUIPMENT_NAMES[ex.equipment] || '' })) : null)),
    ...rows);
}

const setNo = (s) => (s.kind === 'warmup' ? t('today.warmup') : String(s.set_n)) + (s.side === 'none' ? '' : s.side);
function unitOf(block, target) {
  const u = t(block.unit === 'kg' ? 'unit.kg' : 'unit.lb');
  if (target.load_basis === 'per_side') return t('today.side', { unit: u });
  if (target.load_basis === 'per_hand') return t('today.hand', { unit: u });
  return u;
}

// A set row of a later, done or skipped day: the numbers as text, the done or skip mark as a
// picture (never a button), the goal helper in --ink-2 on a day not done.
function roRow(block, s, ex, lift) {
  const state = s.status === 'done' ? 'done' : s.status === 'skipped' ? 'skipped' : 'todo';
  const cur = s.done || { load: s.target.load, reps: s.target.rep_low };
  const countWord = s.target.count_label || (ex ? ex.count_label : null) || t('unit.reps');
  const mark = state === 'done' ? el('span', { class: 'tick', 'aria-hidden': 'true' }, el('span', { class: 'ring' }, glyph('check')))
    : state === 'skipped' ? el('span', { class: 'tick', 'aria-hidden': 'true' }, el('span', { class: 'ring' }, glyph('skip')))
      : el('span', { class: 'tick', 'aria-hidden': 'true' });
  return el('div', { class: 'set is-readonly is-' + state, 'data-set': s.id, 'data-state': state },
    el('span', { class: 'num set-no' }, setNo(s)),
    el('div', { class: 'cell' }, el('span', { class: 'val-ro num' }, fmtNum(cur.load)), el('span', { class: 'unit' }, unitOf(block, s.target))),
    el('div', { class: 'cell' }, el('span', { class: 'val-ro num' }, fmtNum(cur.reps)), el('span', { class: 'unit' }, countWord)),
    mark,
    el('p', { class: 'helper' }, state === 'todo' ? helperLine(s, lift) : ''));
}

// A set row of a day not planned yet: the set number, empty weight and reps cells in --ink-2.
function emptyRow(n) {
  return el('div', { class: 'set is-readonly is-notplanned', 'data-state': 'notplanned' },
    el('span', { class: 'num set-no' }, String(n)),
    el('div', { class: 'cell' }, el('span', { class: 'val-ro num' }, '')),
    el('div', { class: 'cell' }, el('span', { class: 'val-ro num' }, '')),
    el('span', { class: 'tick', 'aria-hidden': 'true' }));
}
