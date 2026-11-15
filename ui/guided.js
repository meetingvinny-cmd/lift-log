// ui/guided.js - the guided builder (DESIGN 17 C.3.5, C.3.6; LOOK 4.12) and the muscle levels
// board of a block (C.3.7). The draft lives in memory (ctx.guided) until Save; nothing is stored
// before Review. Every word comes from strings.js; muscle and equipment words are data.
import { el, clear, glyph, sheet, toast } from './dom.js';
import { t, tn } from './strings.js';
import { LIMITS, MUSCLE_DETAILS, EQUIPMENT_DETAILS } from '../backup.js';
import { MUSCLE_DETAIL_NAMES, EQUIPMENT_DETAIL_NAMES } from '../data/exercises.js';
import { readNumber } from './today.js';
import { askSwitch } from './builder.js';
import { levelWord } from './templates.js';

export const LEVELS = ['top', 'middle', 'bottom'];
const LETTERS = 'ABCDEFGHIJKLMN';
const COUNT_MAX = 4;

function freshGuided() {
  return { step: 1, days: null, levels: { top: [], middle: [], bottom: [] }, board: null, layout: null, dropped: [],
    name: '', notes: '', passes: '', unit: null, rec: {}, introShown: false };
}

// A guided draft is kept (and holds an update) once a day count or a muscle is picked.
export function hasGuidedDraft(g) {
  return !!g && (g.days !== null || LEVELS.some(lv => g.levels[lv].length > 0));
}

const levelOf = (levels, m) => LEVELS.find(lv => levels[lv].includes(m)) || null;
const copyLevels = (lv) => ({ top: lv.top.slice(), middle: lv.middle.slice(), bottom: lv.bottom.slice() });
const copyBoard = (b) => (b || []).map(d => ({ ...d, lifts: d.lifts.map(l => ({ ...l })) }));

// ---------------- the level board (step 2, and Muscle levels mid block) ----------------

// Moves of one muscle (C.3.5 step 2): up and down inside its level; past the top or bottom of a
// level it moves into the next level up or down. One level per muscle, always (BW3, M50).
export function moveMuscle(levels, m, dir) {
  const lv = levelOf(levels, m);
  if (!lv) return false;
  const list = levels[lv], i = list.indexOf(m), li = LEVELS.indexOf(lv);
  if (dir < 0) {
    if (i > 0) { [list[i - 1], list[i]] = [list[i], list[i - 1]]; return true; }
    if (li === 0) return false;
    list.splice(i, 1); levels[LEVELS[li - 1]].push(m); return true;
  }
  if (i < list.length - 1) { [list[i + 1], list[i]] = [list[i], list[i + 1]]; return true; }
  if (li === LEVELS.length - 1) return false;
  list.splice(i, 1); levels[LEVELS[li + 1]].unshift(m); return true;
}

// Put a muscle on a level (at index, or the end). A muscle already on ANOTHER level is refused:
// he takes it off there first (BW3, M50).
export function placeMuscle(levels, m, lv, index) {
  const at = levelOf(levels, m);
  if (at && at !== lv) return false;
  if (at === lv) levels[lv].splice(levels[lv].indexOf(m), 1);
  const list = levels[lv];
  list.splice(index === undefined || index > list.length ? list.length : index, 0, m);
  return true;
}

// The three level cards (LOOK 4.12). onChange redraws; the levels object is changed in place.
export function levelCards(levels, onChange) {
  const box = el('div', { id: 'level-cards' });
  const names = t('level.names');
  LEVELS.forEach((lv, li) => {
    const head = el('div', { class: 'pos-row' }, el('p', { class: 'label grow' }, names[li]),
      li === 0 ? el('button', { class: 'btn btn-icon', type: 'button', id: 'level-info', 'aria-label': t('level.info'), on: { click: levelsSheet } }, glyph('info')) : null);
    const list = levels[lv];
    const card = el('div', { class: 'card level-card' + (list.length ? '' : ' level-empty'), 'data-level': lv });
    if (!list.length) card.appendChild(el('p', { class: 'small', 'data-levelempty': lv }, t('level.empty')));
    list.forEach((m, i) => {
      const firstTop = li === 0 && i === 0, lastBottom = li === LEVELS.length - 1 && i === list.length - 1;
      const mv = (dir, off) => el('button', { class: 'btn btn-icon', type: 'button', 'data-lvmove': m + (dir < 0 ? ':up' : ':down'),
        'aria-label': t(dir < 0 ? 'guided.up' : 'guided.down', { muscle: MUSCLE_DETAIL_NAMES[m] }),
        'aria-disabled': off ? 'true' : null, disabled: off ? true : null,
        on: { click: () => { if (moveMuscle(levels, m, dir)) onChange(); } } }, glyph(dir < 0 ? 'up' : 'down'));
      const handle = el('span', { class: 'drag-handle', 'aria-hidden': 'true', 'data-drag': m }, '≡');
      handle.addEventListener('pointerdown', (ev) => startDrag(ev, levels, m, onChange));
      card.appendChild(el('div', { class: 'row level-row', 'data-lvrow': m, 'data-lvindex': String(i) },
        handle, el('span', { class: 'grow' }, MUSCLE_DETAIL_NAMES[m]), mv(-1, firstTop), mv(1, lastBottom),
        el('button', { class: 'btn btn-icon btn-remove', type: 'button', 'data-lvremove': m, 'aria-label': t('guided.remove', { muscle: MUSCLE_DETAIL_NAMES[m] }),
          on: { click: () => { list.splice(list.indexOf(m), 1); onChange(); } } }, glyph('cross'))));
    });
    box.append(head, card,
      el('div', { class: 'quiet-row' },
        el('button', { class: 'btn btn-quiet', type: 'button', 'data-lvclear': lv, on: { click: () => { list.splice(0); onChange(); } } }, t('guided.clearall')),
        el('button', { class: 'btn btn-quiet', type: 'button', 'data-lvadd': lv, on: { click: () => addMuscleSheet(levels, lv, onChange) } }, t('guided.addmuscle'))));
  });
  return box;
}

// Drag is the extra; the up and down buttons are the control (LOOK 4.12). A drop on a row puts
// the muscle before that row; a drop on a level card puts it at the end of that level.
function startDrag(ev, levels, m, onChange) {
  ev.preventDefault();
  const row = ev.target.closest('[data-lvrow]');
  if (row) row.classList.add('is-dragging');
  const up = (e) => {
    document.removeEventListener('pointerup', up, true);
    if (row) row.classList.remove('is-dragging');
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const over = hit && hit.closest('[data-lvrow]');
    const card = hit && hit.closest('[data-level]');
    if (!card) return;
    const lv = card.getAttribute('data-level');
    const from = levelOf(levels, m);
    levels[from].splice(levels[from].indexOf(m), 1);
    let index = levels[lv].length;
    if (over && over.getAttribute('data-lvrow') !== m) index = levels[lv].indexOf(over.getAttribute('data-lvrow'));
    levels[lv].splice(index < 0 ? levels[lv].length : index, 0, m);
    onChange();
  };
  document.addEventListener('pointerup', up, true);
}

// Add muscle on a level card: the 12 muscles as check rows; one on another level is shown
// disabled with that level's name (guided.taken).
function addMuscleSheet(levels, lv, onChange) {
  const rows = MUSCLE_DETAILS.map(m => {
    const at = levelOf(levels, m);
    const taken = at && at !== lv;
    const on = at === lv;
    const b = el('button', { class: 'row opt-row' + (on ? ' is-on' : ''), type: 'button', 'data-addmuscle': m, 'aria-pressed': String(on),
      'aria-disabled': taken ? 'true' : null, disabled: taken ? true : null,
      on: { click: () => {
        if (levelOf(levels, m) === lv) levels[lv].splice(levels[lv].indexOf(m), 1);
        else placeMuscle(levels, m, lv);
        const yes = levelOf(levels, m) === lv;
        b.classList.toggle('is-on', yes); b.setAttribute('aria-pressed', String(yes));
      } } }, glyph('check'), el('span', { class: 'grow' }, el('span', {}, MUSCLE_DETAIL_NAMES[m]),
      taken ? el('span', { class: 'small second' }, ' ' + t('guided.taken', { level: levelWord(at) })) : null));
    return b;
  });
  const done = el('button', { class: 'btn btn-primary', type: 'button', id: 'addmuscle-done' }, t('text.close'));
  const sh = sheet({ id: 'addmuscle-sheet', title: t('guided.addmuscle'), onClose: onChange }, el('div', { class: 'card' }, rows), done);
  done.addEventListener('click', () => sh.close());
}

function levelsSheet() {
  const close = el('button', { class: 'btn btn-quiet', type: 'button', id: 'levels-close' }, t('text.close'));
  const sh = sheet({ id: 'levels-sheet', title: t('level.info') }, ...t('level.explain').map(line => el('p', { class: 'lead level-line' }, line)), el('div', { class: 'quiet-row' }, close));
  close.addEventListener('click', () => sh.close());
}

// ---------------- the guided builder ----------------

export function renderGuided(ctx) {
  if (!ctx.guided) ctx.guided = freshGuided();
  const g = ctx.guided;
  if (g.unit === null) ctx.store.getSetting('unit', 'lb').then((u) => { if (g.unit === null) g.unit = u; }).catch(() => {});
  const info = ctx.store.builderInfo();
  const steps = t('guided.steps');
  const screen = el('section', { class: 'screen no-bar', id: 'guided', 'data-step': String(g.step) });
  const rerender = () => { const n = renderGuided(ctx); screen.replaceWith(n); };
  const go = (step) => { g.step = step; rerender(); };
  const progress = el('progress', { id: 'guided-progress', 'aria-label': t('builder.progress', { n: g.step, step: steps[g.step - 1] }) });
  progress.setAttribute('max', '4');
  progress.setAttribute('value', String(g.step));
  // The way out keeps a draft (the 6.6 rule); an empty one is dropped.
  const cancel = () => { if (!hasGuidedDraft(g)) ctx.guided = null; ctx.go('#/new'); };
  screen.append(el('div', { class: 'topbar' },
    el('button', { class: 'btn btn-quiet', type: 'button', id: 'guided-cancel', on: { click: cancel } }, glyph('back'), t('block.cancel')),
    el('h2', { class: 'grow' }, steps[g.step - 1])), progress);
  const next = (onNext, off) => {
    const b = el('button', { class: 'btn btn-primary', type: 'button', id: 'guided-next', on: { click: onNext } }, t('builder.next'));
    if (off) { b.disabled = true; b.setAttribute('aria-disabled', 'true'); }
    return b;
  };
  const back = (n) => el('button', { class: 'btn btn-quiet', type: 'button', id: 'guided-back', on: { click: () => go(n) } }, t('builder.back'));

  if (g.step === 1) {
    const chips = [];
    for (let n = info.days_min; n <= info.days_max; n++) {
      chips.push(el('button', { class: 'chip chip-days' + (g.days === n ? ' is-on' : ''), type: 'button', 'data-gdays': String(n), 'aria-pressed': String(g.days === n),
        on: { click: () => { g.days = n; rerender(); } } }, glyph('check'), String(n)));
    }
    screen.append(el('h2', {}, t('guided.days')), el('div', { class: 'chips-row', id: 'guided-days' }, chips), next(() => go(2), g.days === null));
  } else if (g.step === 2) {
    const any = LEVELS.some(lv => g.levels[lv].length);
    screen.append(levelCards(g.levels, rerender), next(async () => {
      try { await layoutBoard(ctx, g); } catch (e) { toast(t('today.notsaved')); return; }
      go(3);
    }, !any), back(1));
  } else if (g.step === 3) {
    boardStep(ctx, g, screen, rerender, info);
    screen.append(next(() => go(4)), back(2));
    if (!g.introShown) { g.introShown = true; boardIntro(ctx); }
  } else {
    reviewStep(ctx, g, screen, rerender);
    screen.appendChild(back(3));
  }
  return screen;
}

// Next on step 2 (C.3.5): autoBuildDays lays the board out. Coming back with a board, the picks
// he made by hand on days and muscles still placed are kept.
async function layoutBoard(ctx, g) {
  const r = await ctx.store.guidedLayout(g.days, g.levels);
  const old = g.board;
  const board = r.board;
  if (old) {
    for (const d of board) {
      const od = old.find(x => x.day === d.day);
      if (!od) continue;
      const seen = {};
      for (const l of d.lifts) {
        const k = seen[l.muscle_detail] = (seen[l.muscle_detail] || 0) + 1;
        const prev = od.lifts.filter(x => x.muscle_detail === l.muscle_detail)[k - 1];
        if (prev && prev.hand && prev.exercise_id && !d.lifts.some(x => x !== l && x.exercise_id === prev.exercise_id)) { l.exercise_id = prev.exercise_id; l.hand = true; }
      }
    }
  }
  g.board = board;
  g.layout = copyBoard(board);
  g.dropped = r.dropped;
  g.rec = {};
}

// The board intro (C.3.16, BW7): the first visit only; Got it or the scrim marks it seen.
async function boardIntro(ctx) {
  const seen = await ctx.store.tipsSeen().catch(() => ({ intro_board: true }));
  if (seen.intro_board) return;
  const ok = el('button', { class: 'btn btn-primary', type: 'button', id: 'intro-ok' }, t('intro.ok'));
  const sh = sheet({ id: 'intro-board', title: t('intro.board.title'), onClose: () => { ctx.store.markTipSeen('intro_board').catch(() => {}); } },
    ...t('intro.board.lines').map(line => el('p', { class: 'lead' }, line)), ok);
  ok.addEventListener('click', () => sh.close());
}

function relabel(board) {
  board.forEach((d, i) => { d.day = i + 1; d.label = LETTERS[i]; });
}

function boardStep(ctx, g, screen, rerender, info) {
  const exMap = ctx.exerciseCache || new Map();
  if (!ctx.exerciseCache) ctx.store.exercisesMap().then((m) => { ctx.exerciseCache = m; rerender(); }).catch(() => {});
  const lvOf = (m) => levelOf(g.levels, m);
  for (const d of g.board || []) {
    const card = el('div', { class: 'card day-card', 'data-gday': String(d.day) }, el('h2', {}, t('day.n', { n: d.label })));
    for (const l of d.lifts) {
      const name = l.exercise_id ? (exMap.get(l.exercise_id) || { name: l.exercise_id }).name : null;
      const muscle = MUSCLE_DETAIL_NAMES[l.muscle_detail];
      const pickBtn = name
        ? el('button', { class: 'btn btn-quiet slot-pick grow', type: 'button', 'data-slotpick': d.day + ':' + l.slot, on: { click: () => openSlotPicker(ctx, d, l) } }, name)
        : el('button', { class: 'btn btn-quiet slot-rec', type: 'button', 'data-slotrec': d.day + ':' + l.slot, 'aria-label': t('recommend.aria', { muscle }),
          on: { click: () => suggest(ctx, g, d, l, rerender) } }, t('recommend'));
      const row = el('div', { class: 'row slot-row', 'data-gslot': d.day + ':' + l.slot, 'data-muscle': l.muscle_detail, 'data-filled': String(!!l.exercise_id),
        'aria-label': name ? null : t('slot.empty', { muscle }) },
      el('span', { class: 'grow' }, el('span', { class: 'small slot-line' }, t('today.sub', { muscle, equipment: levelWord(lvOf(l.muscle_detail) || l.level) })), el('span', { class: 'slot-ex' }, pickBtn)),
      // r4.6 Q7: Suggest one stays on a slot Suggest one or Fill for me filled (a second tap moves on),
      // never on his own hand pick.
      name && !l.hand ? el('button', { class: 'btn btn-quiet slot-rec', type: 'button', 'data-slotrec': d.day + ':' + l.slot, 'aria-label': t('recommend.aria', { muscle }),
        on: { click: () => suggest(ctx, g, d, l, rerender) } }, t('recommend')) : null,
      el('button', { class: 'btn btn-icon btn-remove', type: 'button', 'data-slotdel': d.day + ':' + l.slot, 'aria-label': t('builder.remove', { exercise: name || muscle }),
        on: { click: () => { d.lifts.splice(d.lifts.indexOf(l), 1); d.lifts.forEach((x, i) => { x.slot = i + 1; }); rerender(); } } }, glyph('cross')));
      card.appendChild(row);
    }
    // The soft size warning, per day (R4-16): never disables Next.
    const sized = { ...d, lifts: d.lifts.map(l => ({ ...l, level: lvOf(l.muscle_detail) || l.level })) };
    if (ctx.store.dayWarning(sized)) card.appendChild(el('div', { class: 'inset size-warn', 'data-gwarn': String(d.day) }, glyph('info'), el('span', { class: 'grow' }, t('guided.warn'))));
    const full = d.lifts.length >= info.max_lifts;
    const add = el('button', { class: 'btn btn-quiet', type: 'button', 'data-gaddmuscle': String(d.day), 'aria-disabled': full ? 'true' : null, disabled: full ? true : null,
      on: { click: () => dayMuscleSheet(ctx, g, d, info, rerender) } }, t('guided.addmuscle'));
    const filled = d.lifts.some(l => l.exercise_id);
    const remove = el('button', { class: 'btn btn-quiet', type: 'button', 'data-gremoveday': String(d.day), on: { click: () => {
      const drop = () => { g.board.splice(g.board.indexOf(d), 1); relabel(g.board); rerender(); };
      if (!filled) { drop(); return; }
      plainConfirm('removeday-sheet', t('board.removeday.ask', { label: d.label }), t('board.removeday'), drop);
    } } }, t('board.removeday'));
    card.appendChild(el('div', { class: 'quiet-row' }, add, remove));
    if (full) card.appendChild(el('p', { class: 'small', 'data-gfull': String(d.day) }, t('guided.full')));
    screen.appendChild(card);
  }
  const canAddDay = (g.board || []).length < info.days_max;
  screen.append(el('div', { class: 'quiet-row' },
    el('button', { class: 'btn btn-quiet', type: 'button', id: 'guided-addday', disabled: canAddDay ? null : true, on: { click: () => {
      g.board.push({ day: g.board.length + 1, label: LETTERS[g.board.length], lifts: [] }); rerender();
    } } }, glyph('plus'), t('builder.addday')),
    el('button', { class: 'btn btn-quiet', type: 'button', id: 'guided-autofill', on: { click: () => fillSheet(ctx, g, rerender) } }, t('autofill')),
    el('button', { class: 'btn btn-icon', type: 'button', id: 'guided-tools', 'aria-label': t('guided.tools'), on: { click: () => toolsSheet(ctx, g, rerender) } }, glyph('more'))));
}

// Suggest one (C.3.6): a second tap on the same slot moves to the next exercise in order.
async function suggest(ctx, g, d, l, rerender) {
  const key = d.day + ':' + l.slot;
  const index = g.rec[key] === undefined ? 0 : g.rec[key] + 1;
  let r;
  try { r = await ctx.store.recommend(g, d.day, l.slot, index); } catch (e) { toast(t('today.notsaved')); return; }
  if (!r.filled) { toast(t('autofill.none')); return; }
  g.rec[key] = index;
  g.board = r.board;
  ctx.exerciseCache = await ctx.store.exercisesMap().catch(() => ctx.exerciseCache);
  rerender();
}

// A slot tap opens the picker filtered to that slot's muscle (S12); the pick is a hand pick.
function openSlotPicker(ctx, d, l) {
  ctx.picker = { mode: 'slot', day: d.day, slot: l.slot, muscle_detail: l.muscle_detail, back: '#/guided' };
  ctx.go('#/picker');
}

// Add muscle on a day (BW9): the 12 muscles each with a 0 to 4 count. A muscle on no level yet
// takes the default level (Steady, health-coach C4). The 8 cap refuses a ninth (guided.full).
function dayMuscleSheet(ctx, g, d, info, rerender) {
  const rows = MUSCLE_DETAILS.map(m => {
    const count = el('span', { class: 'num', 'data-gcount': m }, String(d.lifts.filter(l => l.muscle_detail === m).length));
    const paint = () => { count.textContent = String(d.lifts.filter(l => l.muscle_detail === m).length); };
    const step = (dir) => el('button', { class: 'btn btn-icon', type: 'button', 'data-gstep': m + (dir > 0 ? '+' : '-'),
      // r4.6 Q5 (ai-ops-architect 2026-11-14): the two count buttons have their own words.
      'aria-label': t(dir > 0 ? 'guided.count.more' : 'guided.count.less', { muscle: MUSCLE_DETAIL_NAMES[m] }),
      on: { click: () => {
        const have = d.lifts.filter(l => l.muscle_detail === m);
        if (dir > 0) {
          if (have.length >= COUNT_MAX) return;
          if (d.lifts.length >= info.max_lifts) { toast(t('guided.full')); return; }
          if (!levelOf(g.levels, m)) g.levels[info.default_level].push(m);
          d.lifts.push({ slot: d.lifts.length + 1, muscle_detail: m, level: levelOf(g.levels, m), exercise_id: null });
        } else {
          if (!have.length) return;
          d.lifts.splice(d.lifts.lastIndexOf(have[have.length - 1]), 1);
        }
        d.lifts.forEach((x, i) => { x.slot = i + 1; });
        paint();
      } } }, glyph(dir > 0 ? 'plus' : 'minus'));
    return el('div', { class: 'row', 'data-gmuscle': m }, el('span', { class: 'grow' }, MUSCLE_DETAIL_NAMES[m]),
      el('div', { class: 'stepper', role: 'group', 'aria-label': t('board.count', { n: d.lifts.filter(l => l.muscle_detail === m).length, muscle: MUSCLE_DETAIL_NAMES[m] }) }, step(-1), count, step(1)));
  });
  const done = el('button', { class: 'btn btn-primary', type: 'button', id: 'gmuscle-done' }, t('text.close'));
  const sh = sheet({ id: 'gmuscle-sheet', title: t('guided.addmuscle'), onClose: rerender }, el('div', { class: 'card' }, rows), done);
  done.addEventListener('click', () => sh.close());
}

// Fill for me (C.3.6, LOOK 4.12): the empty-only switch (on), the 10 kinds preset from saved
// equipment (this run only; at least one stays picked), Fill for me, Cancel.
async function fillSheet(ctx, g, rerender) {
  let emptyOnly = true;
  let kinds = await ctx.store.getSavedEquipment().catch(() => EQUIPMENT_DETAILS.slice());
  const word = el('span', { class: 'small switch-word' }, t('switch.on'));
  const sw = el('button', { class: 'row switch-row', type: 'button', role: 'switch', id: 'fill-empty', 'aria-checked': 'true',
    on: { click: () => { emptyOnly = !emptyOnly; sw.setAttribute('aria-checked', String(emptyOnly)); word.textContent = t(emptyOnly ? 'switch.on' : 'switch.off'); } } },
  el('span', { class: 'grow' }, t('autofill.empty')), el('span', { class: 'switch', 'aria-hidden': 'true' }, el('span', { class: 'switch-knob' })), word);
  const chips = el('div', { class: 'chips-row chips-wrap', id: 'fill-chips' });
  const paint = () => { for (const c of chips.children) { const on = kinds.includes(c.getAttribute('data-fillk')); c.classList.toggle('is-on', on); c.setAttribute('aria-pressed', String(on)); } };
  for (const k of EQUIPMENT_DETAILS) {
    chips.appendChild(el('button', { class: 'chip', type: 'button', 'data-fillk': k, on: { click: () => {
      if (kinds.includes(k) && kinds.length === 1) { toast(t('equip.min')); return; }
      kinds = kinds.includes(k) ? kinds.filter(x => x !== k) : EQUIPMENT_DETAILS.filter(x => x === k || kinds.includes(x));
      paint();
    } } }, glyph('check'), EQUIPMENT_DETAIL_NAMES[k]));
  }
  paint();
  const go = el('button', { class: 'btn btn-primary', type: 'button', id: 'fill-go' }, t('autofill'));
  const cancel = el('button', { class: 'btn btn-quiet', type: 'button', id: 'fill-cancel' }, t('text.cancel'));
  const sh = sheet({ id: 'fill-sheet', title: t('autofill') }, sw, el('p', { class: 'label' }, t('autofill.equipment')), chips, go, el('div', { class: 'quiet-row' }, cancel));
  go.addEventListener('click', async () => {
    let r;
    try { r = await ctx.store.autofill(g, { emptyOnly, equipment: kinds }); } catch (e) { toast(t('today.notsaved')); return; }
    sh.close();
    if (!r.filled) { toast(t('autofill.none')); return; }
    // A refill by the sheet is not a hand pick.
    for (const d of r.board) for (const l of d.lifts) if (l.hand === undefined) l.hand = false;
    g.board = r.board;
    ctx.exerciseCache = await ctx.store.exercisesMap().catch(() => ctx.exerciseCache);
    rerender();
  });
  cancel.addEventListener('click', () => sh.close());
}

// A plain confirm (LOOK 4.11): the confirm button in the secondary skin, quiet Cancel.
function plainConfirm(id, title, goWords, onGo, line) {
  const go = el('button', { class: 'btn btn-secondary', type: 'button', id: id + '-go' }, goWords);
  const cancel = el('button', { class: 'btn btn-quiet', type: 'button', id: id + '-cancel' }, t('text.cancel'));
  const sh = sheet({ id, title }, line ? el('p', { class: 'small' }, line) : null, go, el('div', { class: 'quiet-row' }, cancel));
  go.addEventListener('click', () => { sh.close(); onGo(); });
  cancel.addEventListener('click', () => sh.close());
}

// The board tools (r4 review R25): Clear (every pick off, slots kept), Reset (back to the step 3
// layout), Save as template. Clear and Reset each ask, since they drop unsaved work (BW6).
function toolsSheet(ctx, g, rerender) {
  const words = t('guided.toolmenu');
  const item = (i, key, fn) => el('button', { class: 'row row-link menu-row', type: 'button', 'data-gtool': key, on: { click: () => { sh.close(); fn(); } } }, el('span', { class: 'grow' }, words[i]));
  const sh = sheet({ id: 'gtools-sheet', title: t('guided.tools') }, el('div', { class: 'card' },
    item(0, 'clear', () => plainConfirm('clear-sheet', t('clear.title'), t('text.clear'), () => {
      for (const d of g.board) for (const l of d.lifts) { l.exercise_id = null; l.hand = false; }
      g.rec = {}; rerender();
    }, t('clear.line'))),
    item(1, 'reset', () => plainConfirm('reset-sheet', t('boardreset.title'), t('boardreset.go'), () => {
      g.board = copyBoard(g.layout); g.rec = {}; rerender();
    }, t('boardreset.line'))),
    item(2, 'template', () => boardTemplateSheet(ctx, g))));
}

function boardTemplateSheet(ctx, g) {
  const input = el('input', { type: 'text', class: 'field', id: 'tplsave-in', maxlength: String(LIMITS.NAME), autocomplete: 'off', 'aria-label': t('tplsave.name') });
  input.value = g.name || '';
  const save = el('button', { class: 'btn btn-primary', type: 'button', id: 'tplsave-save' }, t('text.save'));
  const cancel = el('button', { class: 'btn btn-quiet', type: 'button', id: 'tplsave-cancel' }, t('text.cancel'));
  const sh = sheet({ id: 'tplsave-sheet', title: t('tplsave.title'), canDismiss: () => input.value === (g.name || '') },
    el('label', { class: 'label', for: 'tplsave-in' }, t('tplsave.name')), input, save, el('div', { class: 'quiet-row' }, cancel));
  save.addEventListener('click', async () => {
    if (!input.value.trim()) { input.focus(); return; }
    try { await ctx.store.saveBoardAsTemplate(g, input.value.trim()); } catch (e) { toast(t('today.notsaved')); return; }
    sh.close();
    toast(t('tpl.saved'));
  });
  cancel.addEventListener('click', () => sh.close());
}

// Review (step 4): the Slice 1 builder Review with the guided lines. Empty slots are left out and
// counted; a day with no filled slot keeps Save off (guided.emptyday).
function reviewStep(ctx, g, screen, rerender) {
  const exMap = ctx.exerciseCache || new Map();
  const lvOf = (m) => levelOf(g.levels, m);
  const name = el('input', { type: 'text', class: 'field', id: 'guided-name', maxlength: String(LIMITS.NAME), autocomplete: 'off', 'aria-label': t('builder.name') });
  name.value = g.name;
  ctx.store.defaultBlockName().then((n) => name.setAttribute('placeholder', n)).catch(() => {});
  name.addEventListener('input', () => { g.name = name.value; });
  const notes = el('textarea', { rows: '3', id: 'guided-notes', maxlength: String(LIMITS.NOTE), 'aria-label': t('builder.notes') });
  notes.value = g.notes;
  notes.addEventListener('input', () => { g.notes = notes.value; });
  const rounds = el('input', { type: 'text', class: 'field num', id: 'guided-rounds', inputmode: 'numeric', autocomplete: 'off', maxlength: String(LIMITS.PASSES_CHARS), 'aria-label': t('builder.rounds') });
  rounds.value = g.passes === '' ? '' : String(g.passes);
  rounds.addEventListener('change', () => {
    const n = readNumber(rounds.value, LIMITS.PASSES_MAX, true);
    if (Number.isNaN(n) || n === 0) { rounds.value = g.passes === '' ? '' : String(g.passes); return; }
    g.passes = n === null ? '' : n;
  });
  const empty = g.board.filter(d => !d.lifts.some(l => l.exercise_id));
  const dropped = g.dropped.length + g.board.reduce((n, d) => n + d.lifts.filter(l => !l.exercise_id).length, 0);
  const card = el('div', { class: 'card', id: 'guided-review' },
    ...g.board.filter(d => d.lifts.some(l => l.exercise_id)).map(d => el('div', { class: 'row', 'data-greview': String(d.day) },
      el('span', { class: 'grow' }, t('builder.dayline', { label: d.label, lifts: d.lifts.filter(l => l.exercise_id).map(l => tn('builder.liftsets', ctx.store.startSetsFor(lvOf(l.muscle_detail) || l.level), { name: (exMap.get(l.exercise_id) || { name: l.exercise_id }).name })).join(', ') })))),
    dropped ? el('div', { class: 'row row-note', id: 'guided-dropped' }, glyph('info'), el('span', { class: 'grow' }, tn('guided.dropped', dropped))) : null,
    ...empty.map(d => el('div', { class: 'row row-note', 'data-gemptyday': String(d.day) }, glyph('info'), el('span', { class: 'grow' }, t('guided.emptyday', { label: d.label })))));
  const ok = g.board.length > 0 && !empty.length;
  const save = el('button', { class: 'btn btn-primary', type: 'button', id: 'guided-save', 'aria-disabled': String(!ok) }, t('block.save'));
  save.disabled = !ok;
  save.addEventListener('click', async () => {
    save.disabled = true;
    const finish = async (activate) => {
      try { await ctx.store.guidedSave(g, { activate }); } catch (e) { save.disabled = false; toast(t('today.notsaved')); return; }
      ctx.guided = null;
      ctx.go(activate ? '#/today' : '#/blocks');
    };
    const current = await ctx.store.activeBlock().catch(() => null);
    if (!current) { finish(true); return; }
    askSwitch((yes) => finish(yes), () => { save.disabled = false; });
  });
  screen.append(el('label', { class: 'label', for: 'guided-name' }, t('builder.name')), name,
    el('label', { class: 'label', for: 'guided-notes' }, t('builder.notes')), notes,
    el('label', { class: 'label', for: 'guided-rounds' }, t('builder.rounds')), rounds, el('p', { class: 'small' }, t('builder.rounds.help')),
    card, save);
  void rerender;
}

// ---------------- Muscle levels mid block (C.3.7, LOOK 4.12) ----------------

export function renderLevels(ctx, blockId) {
  const screen = el('section', { class: 'screen no-bar', id: 'levels' });
  (async () => {
    let info = null;
    try { info = await ctx.store.blockLevels(blockId); } catch (e) { info = null; }
    if (!info) { ctx.go('#/blocks'); return; }
    const levels = info.levels;
    const draw = () => {
      clear(screen);
      screen.setAttribute('data-block', info.block_id);
      screen.append(
        el('div', { class: 'topbar' }, el('button', { class: 'btn btn-quiet', type: 'button', id: 'levels-back', on: { click: () => ctx.go('#/block/' + info.block_id) } }, glyph('back'), t('builder.back'))),
        el('h1', {}, t('levels.row')),
        info.saved ? null : el('p', { class: 'lead', id: 'levels-unsaved' }, t('levels.unsaved', { level: t('level.names')[1] })),
        levelCards(levels, draw),
        el('button', { class: 'btn btn-primary', type: 'button', id: 'levels-save', on: { click: async () => {
          try { await ctx.store.setPriorities(info.block_id, levels); } catch (e) { toast(t('today.notsaved')); return; }
          info.saved = true;
          ctx.go('#/block/' + info.block_id);
        } } }, t('levels.save')));
    };
    draw();
  })();
  return screen;
}

// Every Guided builder start comes here (C.3.5 Draft): with a guided draft in memory the 6.6 ask
// comes first. Keep my draft opens it at its step; Start over drops it.
export function openGuided(ctx) {
  if (!hasGuidedDraft(ctx.guided)) { ctx.guided = null; ctx.go('#/guided'); return; }
  let over = false;
  const keep = el('button', { class: 'btn btn-secondary', type: 'button', id: 'draft-keep' }, t('draft.keep'));
  const fresh = el('button', { class: 'btn btn-quiet', type: 'button', id: 'draft-over' }, t('draft.over'));
  const sh = sheet({ id: 'draft-sheet', title: t('draft.title'), onClose: () => { if (over) ctx.guided = null; ctx.go('#/guided'); } },
    el('p', { class: 'small' }, t('draft.line')), keep, el('div', { class: 'quiet-row' }, fresh));
  keep.addEventListener('click', () => sh.close());
  fresh.addEventListener('click', () => { over = true; sh.close(); });
}
