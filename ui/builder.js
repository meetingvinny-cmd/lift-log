// ui/builder.js - the block builder (LOOK 4.6) and the exercise picker (LOOK 4.5).
// Every new block is Fixed: there is no choice of how sets change on any step.
import { el, clear, glyph, sheet, toast } from './dom.js';
import { t, tn } from './strings.js';
import { LIMITS, MUSCLES, EQUIPMENT } from '../backup.js';
import { MUSCLE_NAMES, EQUIPMENT_NAMES, CHIP_EQUIPMENT } from '../data/exercises.js';
import { readNumber, swapTo, stepLoad, relabelSheet } from './today.js';

const LABELS = 'ABCDEFGHIJKLMN';

function freshBuild() {
  return { step: 1, name: '', notes: '', passes: '', unit: null, days: [{ label: 'A', lifts: [] }] };
}

// What Save hands createBlock. The unit is the one the start weights were stepped and typed in
// (b.unit), so a kept lb draft saved after Settings moved to kg is still an lb block (stage 4 N3).
// Not read yet: createBlock falls back to the setting, as before.
export function blockSpec(b) {
  return { name: b.name.trim(), notes: b.notes, passes: b.passes === '' ? null : b.passes, day_templates: buildDays(b), unit: b.unit || undefined };
}

// Start weight plus or minus in the unit the new block will take (Part 18, r4.1 Q13, Q27): the
// unit is read once when the builder opens and kept on the build, so a kg build steps in kg.
export function stepStart(b, ex, load, dir) {
  return stepLoad(ex, load, dir, b && b.unit === 'kg' ? 'kg' : 'lb');
}

// An unsaved build counts as a draft once any field is typed or any exercise is picked (15 Part 4).
export function hasDraft(b) {
  return !!b && (String(b.name).trim() !== '' || String(b.notes).trim() !== '' || b.passes !== '' || b.days.some(d => d.lifts.length > 0));
}

// Cancel on the builder (14.8 G4, review P13): a draft that hasDraft accepts is kept, so the
// Part 4 ask shows on the next Build a block; Start over in that ask is the only way to drop it.
// An empty draft is dropped. The builder has no tab bar (LOOK), so this is its one way out.
export function cancelBuild(ctx) {
  if (!hasDraft(ctx.build)) ctx.build = null;
  ctx.go('#/today');
}

// Every Build a block button comes here. With a draft in memory he is asked first: Keep my
// draft opens it at its step, Start over drops it. A scrim tap keeps it (15 Part 4).
export function openBuilder(ctx) {
  if (!hasDraft(ctx.build)) { ctx.build = null; ctx.go('#/builder'); return; }
  let over = false;
  const keep = el('button', { class: 'btn btn-secondary', type: 'button', id: 'draft-keep' }, t('draft.keep'));
  const fresh = el('button', { class: 'btn btn-quiet', type: 'button', id: 'draft-over' }, t('draft.over'));
  const sh = sheet({ id: 'draft-sheet', title: t('draft.title'), onClose: () => {
    if (over) ctx.build = null;
    ctx.go('#/builder');
  } }, el('p', { class: 'small' }, t('draft.line')), keep, el('div', { class: 'quiet-row' }, fresh));
  keep.addEventListener('click', () => sh.close());
  fresh.addEventListener('click', () => { over = true; sh.close(); });
}

// The days a Save writes, in order; slots follow the order on screen (C32).
export function buildDays(b) {
  return b.days.map((d, i) => ({
    day: i + 1, label: d.label,
    lifts: d.lifts.map((l, j) => ({ slot: j + 1, exercise_id: l.exercise_id, sets: l.sets, rep_low: l.rep_low, rep_high: Math.max(l.rep_low, l.rep_high),
      start_load: l.start_load, failure_set: l.failure_set, reps_left_target: l.failure_set ? 0 : null, warmups: [], sides: 'none',
      load_basis: 'total', count_label: null, note: l.note }))
  }));
}

// One tap takes an exercise out of the unsaved build, no confirm (15 Part 3).
export function removeLift(d, li) {
  if (li >= 0 && li < d.lifts.length) d.lifts.splice(li, 1);
}

function numField(value, limitKey, aria, onSet, mode) {
  const f = el('input', { type: 'text', class: 'field num', inputmode: mode || 'numeric', autocomplete: 'off', enterkeyhint: 'done', maxlength: String(LIMITS[limitKey]), 'aria-label': aria });
  f.value = value === null || value === undefined ? '' : String(value);
  f.addEventListener('change', () => { if (!onSet(f.value)) f.value = value === null || value === undefined ? '' : String(value); });
  return f;
}

export function renderBuilder(ctx) {
  if (!ctx.build) ctx.build = freshBuild();
  const b = ctx.build;
  // The unit setting createBlock will read, read once when the builder opens (review P3, P16).
  if (b.unit === undefined || b.unit === null) ctx.store.getSetting('unit', 'lb').then((u) => { if (b.unit === undefined || b.unit === null) b.unit = u; }).catch(() => {});
  const steps = t('builder.steps');
  const screen = el('section', { class: 'screen no-bar', id: 'builder', 'data-step': String(b.step) });
  const progress = el('progress', { id: 'builder-progress', 'aria-label': t('builder.progress', { n: b.step, step: steps[b.step - 1] }) });
  progress.setAttribute('max', '4');
  progress.setAttribute('value', String(b.step));
  const rerender = () => { const n = renderBuilder(ctx); screen.replaceWith(n); };
  const go = (step) => { b.step = step; rerender(); };
  screen.appendChild(el('div', { class: 'topbar' },
    el('button', { class: 'btn btn-quiet', type: 'button', id: 'builder-cancel', on: { click: () => cancelBuild(ctx) } }, glyph('back'), t('block.cancel')),
    el('h2', { class: 'grow' }, steps[b.step - 1])));
  screen.appendChild(progress);
  const next = (n) => el('button', { class: 'btn btn-primary', type: 'button', id: 'builder-next', on: { click: () => go(n) } }, t('builder.next'));
  const back = (n) => el('button', { class: 'btn btn-quiet', type: 'button', id: 'builder-back', on: { click: () => go(n) } }, t('builder.back'));

  if (b.step === 1) {
    const name = el('input', { type: 'text', class: 'field', id: 'block-name', maxlength: String(LIMITS.NAME), autocomplete: 'off', 'aria-label': t('builder.name') });
    name.value = b.name;
    // The placeholder shows what a blank name saves as, worked out when the step opens (15 Part 2).
    ctx.store.defaultBlockName().then((n) => name.setAttribute('placeholder', n)).catch(() => {});
    name.addEventListener('input', () => { b.name = name.value; });
    const notes = el('textarea', { rows: '3', id: 'block-notes-in', maxlength: String(LIMITS.NOTE), 'aria-label': t('builder.notes') });
    notes.value = b.notes;
    notes.addEventListener('input', () => { b.notes = notes.value; });
    screen.append(el('label', { class: 'label', for: 'block-name' }, t('builder.name')), name,
      el('label', { class: 'label', for: 'block-notes-in' }, t('builder.notes')), notes, next(2),
      el('div', { class: 'quiet-row' }, el('button', { class: 'btn btn-quiet', type: 'button', id: 'builder-load', on: { click: () => ctx.loadBlockFile() } }, t('builder.loadinstead'))));
  } else if (b.step === 2) {
    const rounds = numField(b.passes, 'PASSES_CHARS', t('builder.rounds'), (v) => {
      const n = readNumber(v, LIMITS.PASSES_MAX, true);
      if (Number.isNaN(n) || n === 0) return false;
      b.passes = n === null ? '' : n;
      return true;
    });
    rounds.id = 'block-rounds';
    screen.append(el('h2', {}, t('builder.rounds')), rounds, el('p', { class: 'small' }, t('builder.rounds.help')),
      el('p', { class: 'q-text' }, t('builder.how')), el('p', { class: 'lead' }, t('builder.how.line')), next(3), back(1));
  } else if (b.step === 3) {
    b.days.forEach((d, di) => screen.appendChild(dayCard(ctx, b, d, di, rerender)));
    screen.append(
      el('button', { class: 'btn btn-quiet', type: 'button', id: 'add-day', on: { click: () => { if (b.days.length < LIMITS.DAYS_PER_BLOCK) { b.days.push({ label: LABELS[b.days.length], lifts: [] }); rerender(); } } } }, glyph('plus'), t('builder.addday')),
      next(4), back(2));
  } else {
    screen.appendChild(review(ctx, b));
    // A day left with no exercise blocks Save until he adds one (15 Part 3).
    const ok = b.days.length > 0 && b.days.every(d => d.lifts.length > 0);
    const save = el('button', { class: 'btn btn-primary', type: 'button', id: 'block-save', 'aria-disabled': String(!ok) }, t('block.save'));
    save.disabled = !ok;
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await ctx.store.createBlock(blockSpec(b));
      } catch (e) {
        save.disabled = false;
        toast(t('today.notsaved'));
        return;
      }
      ctx.build = null;
      ctx.go('#/today');
    });
    screen.append(save, back(3));
  }
  return screen;
}

// Swap two lifts of a day; slots come from the order at Save (LOOK 4.6 reorder, C32).
export function moveLift(d, li, dir, rerender) {
  const j = li + dir;
  if (j < 0 || j >= d.lifts.length) return;
  [d.lifts[li], d.lifts[j]] = [d.lifts[j], d.lifts[li]];
  rerender();
}

function dayCard(ctx, b, d, di, rerender) {
  // A day may carry a label or none; Relabel here sets it or clears it (15 Part 1).
  const box = el('div', { class: 'day-card', 'data-day-card': String(di) },
    el('div', { class: 'pos-row' }, el('h2', { class: 'grow' }, dayName(b, d)),
      el('button', { class: 'btn btn-quiet', type: 'button', 'data-relabel': String(di),
        on: { click: () => relabelSheet(d.label, async (val) => { d.label = val; rerender(); }) } }, t('day.relabel'))));
  const exMap = ctx.exerciseCache || new Map();
  const heads = [t('builder.sets'), t('builder.replow'), t('builder.rephigh'), t('builder.load')];
  d.lifts.forEach((l, li) => {
    const ex = exMap.get(l.exercise_id);
    const fail = el('button', { class: 'toggle', type: 'button', 'aria-pressed': String(l.failure_set), 'data-fail': li + '',
      on: { click: () => { l.failure_set = !l.failure_set; rerender(); } } }, el('span', { class: 'box', 'aria-hidden': 'true' }, glyph('check')), t('builder.fail'));
    const name = ex ? ex.name : l.exercise_id;
    const note = el('textarea', { rows: '2', maxlength: String(LIMITS.NOTE), 'aria-label': t('builder.liftnote', { exercise: name }) });
    note.value = l.note;
    note.addEventListener('input', () => { l.note = note.value; });
    const aria = { sets: heads[0], rep_low: heads[1], rep_high: heads[2], start_load: heads[3] };
    const n = (key, limitKey, max, whole, mode) => numField(l[key], limitKey, aria[key], (v) => {
      const x = readNumber(v, max, whole);
      if (Number.isNaN(x) || (x === null && key !== 'start_load') || (key === 'sets' && x < 1)) return false;
      l[key] = x;
      return true;
    }, mode);
    // Start weight moves along the exercise's own steps (DESIGN 5.3 Builder, C41).
    const loadStep = (dir) => el('button', { class: 'btn btn-icon', type: 'button', 'data-loadstep': di + ':' + li + (dir > 0 ? '+' : '-'),
      'aria-label': t(dir > 0 ? 'builder.loadmore' : 'builder.loadless'),
      on: { click: async () => {
        if (b.unit === undefined || b.unit === null) b.unit = await ctx.store.getSetting('unit', 'lb').catch(() => 'lb');
        l.start_load = stepStart(b, ex, l.start_load, dir);
        rerender();
      } } }, glyph(dir > 0 ? 'plus' : 'minus'));
    const move = (dir) => el('button', { class: 'btn btn-icon', type: 'button', 'data-move': di + ':' + li + (dir > 0 ? 'down' : 'up'),
      'aria-label': t(dir > 0 ? 'builder.down' : 'builder.up', { exercise: name }), disabled: (dir < 0 ? li === 0 : li === d.lifts.length - 1) ? true : null,
      on: { click: () => moveLift(d, li, dir, rerender) } }, glyph(dir > 0 ? 'down' : 'up'));
    const remove = el('button', { class: 'btn btn-icon btn-remove', type: 'button', 'data-remove': di + ':' + li, 'aria-label': t('builder.remove', { exercise: name }),
      on: { click: () => { removeLift(d, li); rerender(); } } }, glyph('cross'));
    box.appendChild(el('div', { class: 'lift-row', 'data-lift': di + ':' + li },
      el('div', { class: 'lift-top' }, el('p', { class: 'q-text grow' }, name), move(-1), move(1), remove),
      el('div', { class: 'lift-heads', 'aria-hidden': 'true' }, heads.map(h => el('span', { class: 'label' }, h))),
      el('div', { class: 'lift-nums' },
        n('sets', 'SETS_CHARS', LIMITS.SETS_MAX, true), n('rep_low', 'REPS_CHARS', LIMITS.REPS_MAX, true),
        n('rep_high', 'REPS_CHARS', LIMITS.REPS_MAX, true), n('start_load', 'LOAD_CHARS', LIMITS.LOAD_MAX, false, 'decimal')),
      el('div', { class: 'lift-steps' }, loadStep(-1), loadStep(1)),
      fail, note));
  });
  box.appendChild(el('button', { class: 'btn btn-secondary', type: 'button', 'data-addex': String(di),
    on: { click: () => { ctx.picker = { mode: 'add', day: di, back: '#/builder' }; ctx.go('#/picker'); } } }, t('builder.addex')));
  return box;
}

// A day's name in the builder: its label, or the numbered name when it has none (15 Part 1).
function dayName(b, d) {
  return d.label || t('day.n', { n: b.days.indexOf(d) + 1 });
}

function review(ctx, b) {
  const exMap = ctx.exerciseCache || new Map();
  return el('div', { class: 'card', id: 'builder-review' },
    el('div', { class: 'row' }, el('span', { class: 'grow' }, b.name)),
    el('div', { class: 'row' }, el('span', { class: 'grow' }, b.passes === '' ? t('builder.rounds.help') : t('today.round.of', { r: 1, n: b.passes }))),
    ...b.days.filter(d => d.lifts.length).map(d => el('div', { class: 'row' },
      el('span', { class: 'grow' }, t('builder.dayline', { label: dayName(b, d), lifts: d.lifts.map(l => tn('builder.liftsets', l.sets, { name: (exMap.get(l.exercise_id) || { name: l.exercise_id }).name })).join(', ') })))),
    // One line per day with no exercise; Save stays off until each has one (15 Part 3).
    // The info glyph tells the line apart without color (14.8 G18c, LOOK grayscale rule).
    ...b.days.filter(d => !d.lifts.length).map(d => el('div', { class: 'row', 'data-dayempty': String(b.days.indexOf(d)) },
      glyph('info'), el('span', { class: 'grow' }, t('builder.dayempty', { label: d.label || String(b.days.indexOf(d) + 1) })))),
    el('div', { class: 'row' }, el('span', { class: 'grow small' }, t('builder.how.line'))));
}

// ---------------- picker (LOOK 4.5) ----------------

// The picker list (r4.3 H8; X01, Q06, R4-18): groups in MUSCLES order, each row only in its own
// muscle's group, rows sorted by name inside a group (never by answers), rows the block left out
// of the builder never shown. q is the search box text; kinds is the chip's equipment list, or
// null for every kind. A muscle with no row is left out. Pure: no page, no store.
export function pickerGroups(rows, q, kinds) {
  const needle = String(q || '').trim().toLowerCase();
  const shown = rows.filter(e => (!needle || e.name.toLowerCase().includes(needle)) && (!kinds || kinds.includes(e.equipment)) && !e.left_out_of_builder);
  const out = [];
  for (const m of MUSCLES) {
    const list = shown.filter(e => e.muscle === m).sort((a, b) => a.name.localeCompare(b.name));
    if (list.length) out.push({ muscle: m, rows: list });
  }
  return out;
}

export function renderPicker(ctx) {
  const p = ctx.picker || { mode: 'add', day: 0, back: '#/builder' };
  const screen = el('section', { class: 'screen no-bar', id: 'picker' });
  const list = el('div', { id: 'picker-list' });
  const search = el('input', { type: 'search', class: 'field', id: 'picker-search', enterkeyhint: 'search', autocomplete: 'off',
    maxlength: String(LIMITS.NAME), placeholder: t('picker.search'), 'aria-label': t('picker.search') });
  let chip = 0;
  const chipWords = t('picker.chips');
  const chips = chipWords.map((w, i) => el('button', { class: 'chip' + (i === 0 ? ' is-on' : ''), type: 'button', 'data-chip': String(i), 'aria-pressed': String(i === 0),
    on: { click: () => { chip = i; chips.forEach((c, j) => { c.classList.toggle('is-on', j === i); c.setAttribute('aria-pressed', String(j === i)); }); paint(); } } }, glyph('check'), w));

  const pick = async (exerciseId) => {
    if (p.mode === 'swap') {
      await swapTo(ctx, exerciseId);
      ctx.go('#/today');
      return;
    }
    const b = ctx.build || (ctx.build = { step: 3, name: '', notes: '', passes: '', days: [{ label: 'A', lifts: [] }] });
    const d = b.days[p.day] || b.days[0];
    if (d.lifts.length < LIMITS.LIFTS_PER_DAY) d.lifts.push({ exercise_id: exerciseId, sets: 3, rep_low: 8, rep_high: 12, start_load: null, failure_set: false, note: '' });
    ctx.picker = null;
    ctx.go('#/builder');
  };

  const make = (name) => makeSheet(ctx, name, async (row) => { ctx.exerciseCache = await ctx.store.exercisesMap(); pick(row.id); });

  async function paint() {
    const all = [...(await ctx.store.exercisesMap()).values()];
    ctx.exerciseCache = new Map(all.map(e => [e.id, e]));
    const groups = pickerGroups(all, search.value, CHIP_EQUIPMENT[chip]);
    clear(list);
    if (!groups.length) {
      list.append(el('p', { class: 'lead', id: 'picker-nomatch' }, t('picker.nomatch')),
        el('button', { class: 'btn btn-secondary', type: 'button', id: 'picker-addq', on: { click: () => make(search.value.trim()) } }, t('picker.addq', { q: search.value.trim() })));
      return;
    }
    for (const { muscle: m, rows } of groups) {
      list.append(el('p', { class: 'label group-label' }, MUSCLE_NAMES[m]),
        el('div', { class: 'card' }, rows.map(e => el('button', { class: 'pick-row', type: 'button', 'data-pick': e.id, on: { click: () => pick(e.id) } },
          el('span', { class: 'grow' }, el('span', {}, e.name), el('span', { class: 'small' }, ' ' + EQUIPMENT_NAMES[e.equipment])), glyph('plus')))));
    }
  }
  search.addEventListener('input', paint);
  screen.append(
    el('div', { class: 'topbar' }, el('button', { class: 'btn btn-quiet', type: 'button', id: 'picker-back', on: { click: () => { ctx.picker = null; ctx.go(p.back); } } }, glyph('back'), t('builder.back')),
      el('h2', { class: 'grow' }, p.mode === 'swap' ? t('menu')[3] : t('builder.addex'))),
    search, el('div', { class: 'chips-row' }, chips), list,
    el('button', { class: 'btn btn-secondary', type: 'button', id: 'picker-make', on: { click: () => make(search.value.trim()) } }, glyph('plus'), t('picker.make')));
  paint();
  return screen;
}

function makeSheet(ctx, startName, done) {
  let muscle = MUSCLES[0], equipment = EQUIPMENT[0];
  const name = el('input', { type: 'text', class: 'field', id: 'make-name', maxlength: String(LIMITS.NAME), autocomplete: 'off', 'aria-label': t('picker.make') });
  name.value = startName || '';
  const seg = (list, words, get, set, id) => {
    const box = el('div', { class: 'seg', id });
    const btns = list.map(k => el('button', { class: 'chip' + (get() === k ? ' is-on' : ''), type: 'button', 'data-k': k,
      on: { click: () => { set(k); btns.forEach(b => b.classList.toggle('is-on', b.getAttribute('data-k') === k)); } } }, glyph('check'), words[k]));
    box.append(...btns);
    return box;
  };
  const go = el('button', { class: 'btn btn-primary', type: 'button', id: 'make-save' }, t('picker.addq', { q: name.value }));
  name.addEventListener('input', () => { go.textContent = t('picker.addq', { q: name.value.trim() }); });
  const sh = sheet({ id: 'make-sheet', title: t('picker.make'), canDismiss: () => !name.value },
    name, seg(MUSCLES, MUSCLE_NAMES, () => muscle, (k) => { muscle = k; }, 'make-muscle'),
    seg(EQUIPMENT, EQUIPMENT_NAMES, () => equipment, (k) => { equipment = k; }, 'make-equipment'), go);
  go.addEventListener('click', async () => {
    const n = name.value.trim();
    if (!n) { name.focus(); return; }
    // A refused or failed save keeps the sheet and the typed name, with today.notsaved (SR3, SR11).
    let row = null;
    try { row = await ctx.store.addCustomExercise({ name: n, muscle, equipment }); } catch (e) { toast(t('today.notsaved')); return; }
    sh.close();
    done(row);
  });
}
