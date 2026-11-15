// ui/templates.js - the template browser and preview (DESIGN 17 C.3.4, LOOK 4.12).
// Our starter programs come from data/templates.js through the store; his own are store rows.
// Names and why lines are data words (ours or his), put on the page as text only.
import { el, clear, glyph, sheet, toast, ghostTally } from './dom.js';
import { t, tn } from './strings.js';
import { LIMITS } from '../backup.js';
import { EQUIPMENT_DETAIL_NAMES, MUSCLE_DETAIL_NAMES, MUSCLE_NAMES } from '../data/exercises.js';
import { FOCUS_NAMES } from '../data/templates.js';
import { hasDraft } from './builder.js';

const LEVEL_I = { top: 0, middle: 1, bottom: 2 };
const DAY_CHOICES = [2, 3, 4, 5, 6];
const KINDS = ['days', 'focus', 'equipment', 'author'];

// The filters stay while he moves between the list and a preview in this session (in memory only).
function filters(ctx) {
  if (!ctx.tplFilters) ctx.tplFilters = { q: '', days: [], focus: [], equipment: [], author: [] };
  return ctx.tplFilters;
}
const activeCount = (f, k) => (k === 'equipment' ? f.equipment.length : f[k].length);
const anyOn = (f) => KINDS.some(k => activeCount(f, k) > 0);

// The level word of a level key (level.names: top, middle, bottom).
export function levelWord(level) {
  return level && level in LEVEL_I ? t('level.names')[LEVEL_I[level]] : '';
}
export function muscleWord(m) {
  return MUSCLE_DETAIL_NAMES[m] || MUSCLE_NAMES[m] || '';
}

export function renderTemplates(ctx) {
  const f = filters(ctx);
  const screen = el('section', { class: 'screen', id: 'templates' });
  const list = el('div', { id: 'tpl-list' });
  const search = el('input', { type: 'search', class: 'field', id: 'tpl-search', enterkeyhint: 'search', autocomplete: 'off',
    maxlength: String(LIMITS.NAME), placeholder: t('tpl.search'), 'aria-label': t('tpl.search') });
  search.value = f.q;
  const chipRow = el('div', { class: 'chips-row', id: 'tpl-filters' });
  const clearBtn = el('button', { class: 'btn btn-quiet', type: 'button', id: 'tpl-clear', on: { click: () => {
    f.days = []; f.focus = []; f.equipment = []; f.author = []; paintChips(); paint();
  } } }, t('tpl.clear'));
  const words = t('tpl.filters');
  function paintChips() {
    clear(chipRow);
    KINDS.forEach((k, i) => {
      const n = activeCount(f, k);
      chipRow.appendChild(el('button', { class: 'chip' + (n ? ' is-on' : ''), type: 'button', 'data-tplf': k, 'aria-pressed': String(n > 0),
        on: { click: () => filterSheet(ctx, k, () => { paintChips(); paint(); }) } },
      n ? glyph('check') : null, n ? t('tpl.filter.on', { kind: words[i], n }) : words[i]));
    });
    clearBtn.hidden = !anyOn(f);
  }
  async function paint() {
    f.q = search.value;
    const q = { q: f.q, days: f.days, focus: f.focus, author: f.author,
      equipment: f.equipment.includes('fits') ? 'fits' : f.equipment };
    let rows = [];
    try { rows = await ctx.store.listTemplates(q); } catch (e) { rows = []; }
    clear(list);
    if (!rows.length) {
      list.appendChild(el('div', { class: 'empty', id: 'tpl-none' }, ghostTally(4), el('h2', {}, t(anyOn(f) || f.q.trim() ? 'tpl.none' : 'tpl.empty'))));
      return;
    }
    list.appendChild(el('div', { class: 'card' }, rows.map(tp => el('button', { class: 'row row-link menu-row tpl-row', type: 'button', 'data-tpl': tp.id,
      on: { click: () => ctx.go('#/template/' + tp.id) } },
    el('span', { class: 'grow' },
      el('span', { class: 'tpl-name' }, tp.name, tp.author === 'mine' ? el('span', { class: 'pill', 'data-pill': 'mine' }, t('pill.mine')) : null),
      el('span', { class: 'small tpl-line' }, tn('tpl.row', tp.days_per_rotation, { days: tp.days_per_rotation, equipment: tp.equipment.map(k => EQUIPMENT_DETAIL_NAMES[k]).join(', ') }))),
    glyph('chevron')))));
  }
  search.addEventListener('input', paint);
  screen.append(
    el('div', { class: 'topbar' }, el('button', { class: 'btn btn-quiet', type: 'button', id: 'tpl-back', on: { click: () => ctx.go('#/new') } }, glyph('back'), t('builder.back'))),
    el('h1', {}, t('tpl.title')), search, chipRow, el('div', { class: 'quiet-row' }, clearBtn), list);
  paintChips();
  paint();
  return screen;
}

// One filter kind as a sheet of check rows (LOOK 4.12). Equipment leads with Fits my equipment.
function filterSheet(ctx, kind, done) {
  const f = filters(ctx);
  let opts;
  if (kind === 'days') opts = DAY_CHOICES.map(n => [n, String(n)]);
  else if (kind === 'focus') opts = Object.keys(FOCUS_NAMES).map(k => [k, FOCUS_NAMES[k]]);
  else if (kind === 'equipment') opts = [['fits', t('tpl.fits')], ...Object.keys(EQUIPMENT_DETAIL_NAMES).map(k => [k, EQUIPMENT_DETAIL_NAMES[k]])];
  else opts = [['ours', t('tpl.madeby')[0]], ['mine', t('tpl.madeby')[1]]];
  const rows = opts.map(([v, word]) => {
    const on = () => f[kind].includes(v);
    const b = el('button', { class: 'row opt-row' + (on() ? ' is-on' : ''), type: 'button', 'data-tplopt': String(v), 'aria-pressed': String(on()),
      on: { click: () => {
        if (on()) f[kind] = f[kind].filter(x => x !== v);
        else f[kind] = kind === 'equipment' && v === 'fits' ? ['fits'] : [...f[kind].filter(x => x !== 'fits'), v];
        for (const r of rows) { const x = r.getAttribute('data-tplopt'); const val = kind === 'days' ? Number(x) : x; const yes = f[kind].includes(val); r.classList.toggle('is-on', yes); r.setAttribute('aria-pressed', String(yes)); }
      } } }, glyph('check'), el('span', { class: 'grow' }, word));
    return b;
  });
  const close = el('button', { class: 'btn btn-primary', type: 'button', id: 'tplf-done' }, t('text.close'));
  const sh = sheet({ id: 'tplf-sheet', title: t('tpl.filters')[KINDS.indexOf(kind)], onClose: done }, el('div', { class: 'card' }, rows), close);
  close.addEventListener('click', () => sh.close());
}

// The slot line under a preview row (LOOK 4.12): muscle, level and rep range joined by the middle
// dot of the today.sub words (no 5.11 key holds three parts; BUILD_LOG S2 provisional 2).
function slotLine(s) {
  const two = t('today.sub', { muscle: muscleWord(s.muscle), equipment: levelWord(s.level) });
  return s.rep_low === null ? two : t('today.sub', { muscle: two, equipment: s.rep_low + '-' + s.rep_high });
}

// The preview (C.3.4, LOOK 4.12): one card per day, each slot with its set count, muscle, level
// and rep range; Start at the end; Delete template on his own only.
export function renderTemplate(ctx, id) {
  const screen = el('section', { class: 'screen no-bar', id: 'template' });
  draw(ctx, screen, id).catch(() => ctx.go('#/templates'));
  return screen;
}

async function draw(ctx, screen, id) {
  let tp = null;
  try { tp = await ctx.store.templatePreview(id); } catch (e) { tp = null; }
  if (!tp) { ctx.go('#/templates'); return; }
  clear(screen);
  screen.setAttribute('data-tpl', tp.id);
  screen.append(
    el('div', { class: 'topbar' }, el('button', { class: 'btn btn-quiet', type: 'button', id: 'template-back', on: { click: () => ctx.go('#/templates') } }, glyph('back'), t('builder.back'))),
    el('h1', {}, tp.name));
  if (tp.why) screen.appendChild(el('p', { class: 'lead', id: 'tpl-why' }, tp.why));
  for (const d of tp.days) {
    screen.appendChild(el('div', { class: 'card day-card', 'data-tplday': d.label },
      el('h2', {}, d.label),
      ...d.slots.map(s => el('div', { class: 'row tpl-slot', 'data-tplslot': s.exercise_id },
        el('span', { class: 'grow' },
          el('span', {}, tn('tpl.slot', s.start_sets, { name: s.name })),
          el('span', { class: 'small tpl-slot-line' }, slotLine(s)))))));
  }
  const start = el('button', { class: 'btn btn-primary', type: 'button', id: 'tpl-start', on: { click: () => startFlow(ctx, tp.id) } }, t('tpl.start'));
  screen.appendChild(start);
  if (tp.author === 'mine') {
    screen.appendChild(el('div', { class: 'quiet-row tpl-delete-row' },
      el('button', { class: 'btn btn-quiet', type: 'button', id: 'tpl-delete', on: { click: () => deleteFlow(ctx, tp) } }, t('tpl.delete'))));
  }
}

// Start (C.3.4): with a draft build in memory the 15 Part 4 ask comes first, so a template never
// drops a typed draft without his tap. Then the builder opens at Rounds with the template filled in.
function startFlow(ctx, id) {
  const fill = async () => {
    try { ctx.build = await ctx.store.templateToDraft(id); } catch (e) { toast(t('today.notsaved')); return; }
    ctx.exerciseCache = await ctx.store.exercisesMap().catch(() => ctx.exerciseCache);
    ctx.go('#/builder');
  };
  if (!hasDraft(ctx.build)) { fill(); return; }
  let over = false;
  const keep = el('button', { class: 'btn btn-secondary', type: 'button', id: 'draft-keep' }, t('draft.keep'));
  const fresh = el('button', { class: 'btn btn-quiet', type: 'button', id: 'draft-over' }, t('draft.over'));
  const sh = sheet({ id: 'draft-sheet', title: t('draft.title'), onClose: () => { if (over) fill(); else ctx.go('#/builder'); } },
    el('p', { class: 'small' }, t('draft.line')), keep, el('div', { class: 'quiet-row' }, fresh));
  keep.addEventListener('click', () => sh.close());
  fresh.addEventListener('click', () => { over = true; sh.close(); });
}

// Delete template (C.3.4): a plain confirm; the store keeps a before-delete safety copy first.
function deleteFlow(ctx, tp) {
  const go = el('button', { class: 'btn btn-secondary', type: 'button', id: 'tpl-delete-go' }, t('tpl.delete'));
  const cancel = el('button', { class: 'btn btn-quiet', type: 'button', id: 'tpl-delete-cancel' }, t('text.cancel'));
  const sh = sheet({ id: 'tpl-delete-sheet', title: t('tpl.delete.ask', { name: tp.name }) }, go, el('div', { class: 'quiet-row' }, cancel));
  go.addEventListener('click', async () => {
    go.disabled = true;
    try { await ctx.store.deleteTemplate(tp.id); } catch (e) { go.disabled = false; toast(t('today.notsaved')); return; }
    sh.close();
    ctx.go('#/templates');
  });
  cancel.addEventListener('click', () => sh.close());
}
