// ui/block.js - the Block tab (16 B.5 row 14, LOOK 4.7): the round strip, the day rows of a round,
// the sets this round by muscle and Close block; the read-only day view at #/day/<id> (B.5 row 2,
// LOOK 4.11); and the Easy round stop sheet (B.5 row 4). Every word comes from strings.js; his own
// words (block name, day labels, exercise names) reach the page as text only.
import { el, clear, glyph, sheet, toast, ghostTally, typedConfirm, untyped } from './dom.js';
import { t } from './strings.js';
import { MUSCLE_NAMES, MUSCLE_DETAIL_NAMES, EQUIPMENT_NAMES } from '../data/exercises.js';
import { effectiveExercise } from '../store.js';
import { helperLine, dayTitle, ringGlyph, tildeGlyph } from './today.js';

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

// blockId (17 C.3.2, r4 review R27): the overview of that block from the block list, at
// #/block/<id>. None: the current block. A bad or unknown id goes to the block list.
export function renderBlock(ctx, blockId) {
  const screen = el('section', { class: 'screen', id: 'block' });
  draw(ctx, screen, null, blockId || null).catch((e) => { screen.appendChild(el('p', { class: 'raw' }, String(e && e.message))); });
  return screen;
}

// A tap on a round cell draws again with that round's day rows; only the newest draw is put in.
const drawSeq = new WeakMap();
async function draw(ctx, screen, shown, blockId) {
  const seq = (drawSeq.get(screen) || 0) + 1;
  drawSeq.set(screen, seq);
  const store = ctx.store;
  let block = null, current = true;
  if (blockId) {
    let info = null;
    try { info = await store.blockInfo(blockId); } catch (e) { info = null; }
    if (!info) { ctx.go('#/blocks'); return; }
    block = info.block;
    current = info.current;
  } else {
    block = await store.activeBlock();
  }
  const ov = block ? await store.blockOverview(block.id, shown) : null;
  const grid = block ? await store.roundGrid(block.id) : null;
  if (drawSeq.get(screen) !== seq) return;
  clear(screen);
  const allRow = el('div', { class: 'card', id: 'block-links' },
    el('a', { class: 'row row-link menu-row', href: '#/blocks', id: 'blocks-all' }, el('span', { class: 'grow' }, t('blocks.all')), glyph('chevron')),
    el('a', { class: 'row row-link menu-row', href: '#/exercises', id: 'lib-row' }, el('span', { class: 'grow' }, t('lib.row')), glyph('chevron')));
  if (!ov) {
    screen.appendChild(el('h1', {}, t('block.title')));
    screen.appendChild(el('div', { class: 'empty', id: 'block-none' }, ghostTally(4), el('h2', {}, t('empty.today.title')), el('p', { class: 'lead' }, t('empty.today.line'))));
    screen.appendChild(allRow);
    return;
  }
  // Muscle levels (17 C.3.7, LOOK 4.7 r4.1): the first row of the grouped card, on the current
  // block only while it is not done.
  if (current && ov.status !== 'done') {
    allRow.prepend(el('a', { class: 'row row-link menu-row', href: '#/levels/' + ov.id, id: 'levels-row' }, el('span', { class: 'grow' }, t('levels.row')), glyph('chevron')));
  }
  // A block that is not current (R27): no End block, every day opens read only; a done block is
  // read only; an active one offers Use this block.
  ov.current = current;
  screen.setAttribute('data-current', String(current));
  const profile = t(ov.profile === 'adaptive' ? 'profile.adjust' : 'profile.fixed');
  screen.setAttribute('data-block', ov.id);
  screen.append(
    el('h1', {}, t('block.title')),
    el('p', { class: 'lead', id: 'block-head' }, ov.passes === null ? t('block.head.open', { name: ov.name, profile }) : t('block.head', { name: ov.name, rounds: ov.passes, profile })));
  if (!current && ov.status === 'active') {
    screen.appendChild(el('button', { class: 'btn btn-secondary', type: 'button', id: 'block-use', on: { click: () => useFlow(ctx, ov) } }, t('blocks.use')));
  }
  screen.append(roundGrid(ctx, screen, ov, grid), gridStepper(ctx, screen, ov, grid));
  // Close block (B.5 row 7, LOOK 4.7): a secondary button, never the danger skin; current block only.
  screen.appendChild(allRow);
  if (ov.status !== 'done' && current) {
    screen.appendChild(el('button', { class: 'btn btn-secondary', type: 'button', id: 'block-end', on: { click: () => endFlow(ctx, ov) } }, t('daymenu.end')));
  }
}

// Use this block (C.3.2): a plain confirm only while a day of the current block is open.
async function useFlow(ctx, ov) {
  const go = async () => {
    try { await ctx.store.setCurrentBlock(ov.id); } catch (e) { toast(t('today.notsaved')); return; }
    ctx.go('#/today');
  };
  if (!(await ctx.store.isDayOpen().catch(() => false))) return go();
  const yes = el('button', { class: 'btn btn-secondary', type: 'button', id: 'use-yes' }, t('blocks.use'));
  const no = el('button', { class: 'btn btn-quiet', type: 'button', id: 'use-cancel' }, t('text.cancel'));
  const sh = sheet({ id: 'use-sheet', title: t('blocks.use.ask') }, yes, el('div', { class: 'quiet-row' }, no));
  yes.addEventListener('click', () => { sh.close(); go(); });
  no.addEventListener('click', () => sh.close());
  return undefined;
}

// The round grid (17 C.3.11, LOOK 4.12; replaces the 4.7 round strip): one column per round with
// its reps-left goal (none on an open-ended block or on Fixed), one row per day label, a 56 x 56
// cell per day with its state glyph and grid.cell aria. The current round header carries the
// accent border. Any cell opens through openDay (Today for the current day of the current block,
// the stop sheet on an easy day with hard days left, else the read-only day view).
const STATE_WORD = { done: 0, skipped: 1, now: 2, planned: 3, notplanned: 4 };
export function cellState(c) { return t('grid.states')[STATE_WORD[c.state]]; }

function roundGrid(ctx, screen, ov, g) {
  const box = el('div', { class: 'round-grid', id: 'round-grid', role: 'group', 'aria-label': t('grid.rounds') });
  const head = el('div', { class: 'grid-row grid-headrow' }, el('span', { class: 'grid-head' }));
  for (const r of ov.rounds) {
    const goal = (g.rounds.find(x => x.pass === r.pass) || {}).goal;
    head.appendChild(el('span', { class: 'grid-col is-' + r.state + (r.easy ? ' is-easy' : ''), 'data-round': String(r.pass), 'data-state': r.state, 'data-easy': String(!!r.easy) },
      el('span', { class: 'num grid-r' }, t('round.short', { r: r.pass })),
      goal === null || goal === undefined ? null : el('span', { class: 'small grid-goal' }, t('grid.goal', { n: goal }))));
  }
  box.appendChild(head);
  for (const row of g.rows) {
    const line = el('div', { class: 'grid-row', 'data-gridday': String(row.day) }, el('span', { class: 'grid-head' }, dayTitle({ label: row.label, day: row.day })));
    for (const c of row.cells) {
      const d = { ref: c.ref, pass: c.pass, day: c.day, now: c.now, status: c.state === 'now' ? (ov.days.find(x => x.ref === c.ref) || {}).status || 'planned' : c.state };
      // A button never acts as a table cell in the browser (it stacked every cell under R1), so each
      // button sits inside its own cell span.
      line.appendChild(el('span', { class: 'grid-td' }, el('button', {
        class: 'grid-cell is-' + c.state, type: 'button', 'data-blockday': c.ref, 'data-status': d.status, 'data-now': String(!!c.now), 'data-cell': c.state,
        'aria-label': t('grid.cell', { r: c.pass, label: row.label || String(row.day), state: cellState(c) }), on: { click: () => openDay(ctx, ov, d) }
      }, c.state === 'done' ? glyph('check') : c.state === 'skipped' ? glyph('skip') : c.state === 'now' ? ringGlyph() : null)));
    }
    box.appendChild(line);
  }
  return el('div', { class: 'grid-scroll' }, box);
}

// The round count under the grid (C.3.11, r4.6 Q2): minus and plus on a block with a length
// (Fixed too), each disabled with its reason line when the store refuses; an open-ended block
// shows grid.open; a done block shows nothing.
function gridStepper(ctx, screen, ov, g) {
  if (g.open) return el('p', { class: 'small', id: 'grid-open' }, t('grid.open'));
  if (!g.plus || !g.minus || !ov.current) return el('div', { id: 'grid-none', hidden: true });
  const less = el('button', { class: 'btn btn-icon stepper', type: 'button', id: 'grid-less', 'aria-label': t('grid.less') }, glyph('minus'));
  const more = el('button', { class: 'btn btn-icon stepper', type: 'button', id: 'grid-more', 'aria-label': t('grid.more') }, glyph('plus'));
  less.disabled = !g.minus.ok;
  more.disabled = !g.plus.ok;
  more.addEventListener('click', async () => {
    more.disabled = true;
    let r = null;
    try { r = await ctx.store.resizeBlock(ov.id, 1); } catch (e) { toast(t('today.notsaved')); draw(ctx, screen, null, screen.getAttribute('data-current') === 'false' ? ov.id : null).catch(() => {}); return; }
    toast(t('grid.added', { n: r.block.passes }));
    draw(ctx, screen, null, ov.current ? null : ov.id).catch(() => {});
  });
  less.addEventListener('click', () => removeSheet(ctx, screen, ov, g));
  const reasons = [];
  if (!g.minus.ok) reasons.push(el('p', { class: 'small grid-reason', id: 'grid-less-why' }, t(g.minus.reason.key, g.minus.reason.vals)));
  if (!g.plus.ok) reasons.push(el('p', { class: 'small grid-reason', id: 'grid-more-why' }, t(g.plus.reason.key, g.plus.reason.vals)));
  return el('div', { class: 'grid-count', id: 'grid-count' },
    el('div', { class: 'grid-stepper' }, el('span', { class: 'grow' }, t('grid.rounds')), less, el('span', { class: 'num', id: 'grid-n' }, String(ov.passes)), more),
    ...reasons);
}

// Minus (LOOK 4.12): the typed REMOVE sheet with the Danger button; end.line under the line when
// the minus finishes the block (r4.6 Q1), then the Block finished screen with the nudge once.
function removeSheet(ctx, screen, ov, g) {
  const go = el('button', { class: 'btn btn-danger', type: 'button', id: 'grid-remove-go' }, glyph('warn'), t('grid.remove.go'));
  const cancel = el('button', { class: 'btn btn-quiet', type: 'button', id: 'grid-remove-cancel' }, t('text.cancel'));
  const conf = typedConfirm(t('grid.remove.type'), 'REMOVE', go);
  const sh = sheet({ id: 'grid-remove', title: t('grid.remove.title', { r: ov.passes }), canDismiss: () => untyped(conf) },
    el('p', { class: 'small' }, t('grid.remove.line')), g.minus.finishes ? el('p', { class: 'small', id: 'grid-remove-end' }, t('end.line')) : null,
    conf, go, el('div', { class: 'quiet-row' }, cancel));
  cancel.addEventListener('click', () => sh.close());
  go.addEventListener('click', async () => {
    go.disabled = true;
    const typed = conf.querySelector('input') ? conf.querySelector('input').value.trim() : '';
    let r = null;
    try { r = await ctx.store.resizeBlock(ov.id, -1, typed); } catch (e) { go.disabled = false; toast(t('today.notsaved')); return; }
    sh.close();
    if (r.finished) { ctx.finished = { id: ov.id, nudge: true }; ctx.go('#/finished/' + ov.id); return; }
    draw(ctx, screen, null, ov.current ? null : ov.id).catch(() => {});
  });
}

// A day row tap: an easy-round day while hard days are left opens the stop sheet (B.5 row 4, M40);
// the current day goes to Today; any other day opens the read-only view.
function openDay(ctx, ov, d) {
  if (ov.current === false) { ctx.go('#/day/' + d.ref); return; }
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
  // The current day goes to Today only on the current block; on any other block every day opens
  // here read only (17 C.3.2, r4 review R27).
  if (p.state === 'open' || p.state === 'current') {
    const active = await ctx.store.activeBlock().catch(() => null);
    if (active && active.id === p.block.id) { ctx.go('#/today'); return; }
  }
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
