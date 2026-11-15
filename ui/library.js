// ui/library.js - the exercise library at #/exercises and Exercise detail at #/exercise/<id>
// (17 C.3.13, C.3.14, LOOK 4.13). The library reads every exercise once per visit and filters in
// memory (filterExercises in store.js). The video link is a plain link to the uploader, set only
// after isLink passes, with rel noopener noreferrer: no player, no embed (section 7 row 5).
import { el, clear, glyph, sheet, toast } from './dom.js';
import { t } from './strings.js';
import { LIMITS, isLink } from '../backup.js';
import { MUSCLE_DETAIL_NAMES, MUSCLE_NAMES, EQUIPMENT_DETAIL_NAMES, MUSCLE_DETAILS, EQUIPMENT_DETAILS } from '../data/exercises.js';
import { filterExercises } from '../store.js';
import { makeSheet } from './builder.js';
import { exerciseBody } from './history.js';

const LINK_REL = 'noopener noreferrer';
const KINDS = ['muscle', 'equipment', 'mine', 'logged'];

// The filter state of one visit (never stored). Equipment starts at saved equipment (C.3.13).
export function libraryStart(saved) {
  return { q: '', muscle: [], equipment: Array.isArray(saved) && saved.length < EQUIPMENT_DETAILS.length ? [...saved] : [], mine: false, logged: false };
}
export const filtersOn = (f) => !!(f.muscle.length || f.equipment.length || f.mine || f.logged);

export function renderLibrary(ctx) {
  const screen = el('section', { class: 'screen', id: 'library' });
  drawLibrary(ctx, screen).catch((e) => { screen.appendChild(el('p', { class: 'raw' }, String(e && e.message))); });
  return screen;
}

async function drawLibrary(ctx, screen) {
  const saved = await ctx.store.getSavedEquipment().catch(() => null);
  const f = libraryStart(saved);
  let rows = [...(await ctx.store.exercisesMap()).values()];
  const logged = new Set(await ctx.store.loggedExerciseIds());
  const list = el('div', { id: 'lib-list' });
  const chipRow = el('div', { class: 'chips-row', id: 'lib-filters' });
  const clearBtn = el('button', { class: 'btn btn-quiet', type: 'button', id: 'lib-clear', on: { click: () => { f.muscle = []; f.equipment = []; f.mine = false; f.logged = false; paint(); } } }, t('tpl.clear'));
  const search = el('input', { type: 'search', class: 'field', id: 'lib-search', enterkeyhint: 'search', autocomplete: 'off',
    maxlength: String(LIMITS.NAME), placeholder: t('picker.search'), 'aria-label': t('picker.search') });
  search.addEventListener('input', () => { f.q = search.value; paint(); });
  const words = t('lib.filters');
  const chip = (i) => {
    const k = KINDS[i];
    const n = k === 'muscle' ? f.muscle.length : k === 'equipment' ? f.equipment.length : 0;
    const on = n > 0 || (k === 'mine' && f.mine) || (k === 'logged' && f.logged);
    return el('button', { class: 'chip' + (on ? ' is-on' : ''), type: 'button', 'data-libf': k, 'aria-pressed': String(on),
      on: { click: () => {
        if (k === 'mine') { f.mine = !f.mine; paint(); return; }
        if (k === 'logged') { f.logged = !f.logged; paint(); return; }
        pickSheet(k, k === 'muscle' ? MUSCLE_DETAILS : EQUIPMENT_DETAILS, k === 'muscle' ? MUSCLE_DETAIL_NAMES : EQUIPMENT_DETAIL_NAMES, f[k], (v) => { f[k] = v; paint(); }, words[i]);
      } } }, on ? glyph('check') : null, n > 0 ? t('tpl.filter.on', { kind: words[i], n }) : words[i]);
  };
  function paint() {
    clear(chipRow);
    chipRow.append(...KINDS.map((_, i) => chip(i)));
    clearBtn.hidden = !filtersOn(f);
    const shown = filterExercises(rows, f, logged);
    clear(list);
    screen.setAttribute('data-count', String(shown.length));
    if (!shown.length) { list.appendChild(el('p', { class: 'lead', id: 'lib-none' }, t('lib.none'))); return; }
    // One list by name; built off the page, then put in once.
    const card = el('div', { class: 'card' });
    for (const e of shown) {
      card.appendChild(el('a', { class: 'row row-link pick-row', href: '#/exercise/' + e.id, 'data-libex': e.id },
        el('span', { class: 'grow' }, el('span', {}, e.name), el('span', { class: 'small' }, ' ' + (EQUIPMENT_DETAIL_NAMES[e.equipment_detail] || ''))), glyph('chevron')));
    }
    list.appendChild(card);
  }
  const make = el('button', { class: 'btn btn-secondary', type: 'button', id: 'lib-make', on: { click: () => makeSheet(ctx, search.value.trim(), async () => {
    rows = [...(await ctx.store.exercisesMap()).values()];
    paint();
  }) } }, glyph('plus'), t('picker.make'));
  clear(screen);
  screen.append(el('h1', {}, t('lib.row')), search, chipRow, el('div', { class: 'quiet-row' }, clearBtn), list, make);
  paint();
}

// The check-row sheet of a Muscle or Equipment filter: tap rows on or off; Close keeps the pick.
function pickSheet(kind, keys, names, current, done, title) {
  const pick = new Set(current);
  const rows = keys.map(k => el('button', { class: 'menu-row check-row' + (pick.has(k) ? ' is-on' : ''), type: 'button', 'data-libpick': k, 'aria-pressed': String(pick.has(k)),
    on: { click: (e) => { const b = e.currentTarget; if (pick.has(k)) pick.delete(k); else pick.add(k); b.classList.toggle('is-on', pick.has(k)); b.setAttribute('aria-pressed', String(pick.has(k))); } } },
  el('span', { class: 'grow' }, names[k]), glyph('check')));
  const close = el('button', { class: 'btn btn-primary', type: 'button', id: 'libpick-close' }, t('text.close'));
  const sh = sheet({ id: 'libpick-' + kind, title, onClose: () => done(keys.filter(k => pick.has(k))) }, el('div', { class: 'card' }, rows), close);
  close.addEventListener('click', () => sh.close());
}

// ---------------- Exercise detail ----------------

let tab = 0;   // About or History, this visit only

export function renderExerciseDetail(ctx, id) {
  const screen = el('section', { class: 'screen', id: 'exdetail' });
  tab = 0;
  drawDetail(ctx, screen, id).catch(() => ctx.go('#/exercises'));
  return screen;
}

async function drawDetail(ctx, screen, id) {
  const d = await ctx.store.exerciseDetail(id);
  if (!d) { ctx.go('#/exercises'); return; }
  const ex = d.exercise;
  clear(screen);
  screen.setAttribute('data-exercise', ex.id);
  const body = el('div', { id: 'exd-body' });
  const words = t('detail.switch');
  const sw = el('div', { class: 'seg seg-switch', id: 'exd-switch' });
  const paintSwitch = () => {
    clear(sw);
    sw.append(...words.map((w, i) => el('button', { class: 'chip' + (i === tab ? ' is-on' : ''), type: 'button', 'data-seg': String(i), 'aria-pressed': String(i === tab),
      on: { click: () => { tab = i; paintSwitch(); paint(); } } }, i === tab ? glyph('check') : null, w)));
  };
  const paint = () => {
    clear(body);
    screen.setAttribute('data-tab', tab === 0 ? 'about' : 'history');
    if (tab === 1) { body.appendChild(exerciseBody(ex.name, d.history.blocks)); return; }
    body.appendChild(ex.notes ? el('div', { class: 'inset', id: 'exd-note', 'aria-label': t('detail.note') }, el('p', {}, ex.notes))
      : el('p', { class: 'small', id: 'exd-nonote' }, t('detail.nonote')));
    if (ex.link && isLink(ex.link)) {
      const a = el('a', { class: 'btn btn-quiet', id: 'exd-link', rel: LINK_REL, target: '_blank' }, t('video.watch'));
      a.setAttribute('href', ex.link);
      body.appendChild(a);
    } else {
      body.appendChild(el('p', { class: 'small', id: 'exd-nolink' }, t('detail.nolink')));
    }
    body.appendChild(el('button', { class: 'btn btn-secondary', type: 'button', id: 'exd-editnote', on: { click: () => noteSheet(ctx, ex, (v) => { ex.notes = v; paint(); }) } }, t('detail.editnote')));
  };
  const muscle = MUSCLE_DETAIL_NAMES[ex.muscle_detail] || MUSCLE_NAMES[ex.muscle] || '';
  const spotter = Array.isArray(ex.tags) && ex.tags.includes('spotter');
  screen.append(
    el('a', { class: 'btn btn-quiet', href: '#/exercises', id: 'exd-back' }, glyph('back'), t('lib.row')),
    el('h1', { id: 'exd-name' }, ex.name),
    el('p', { class: 'lead', id: 'exd-sub' }, t('today.sub', { muscle, equipment: EQUIPMENT_DETAIL_NAMES[ex.equipment_detail] || '' })),
    spotter ? el('div', { class: 'inset', id: 'exd-spotter' }, glyph('info'), el('span', {}, t('detail.spotter'))) : null,
    sw, body);
  paintSwitch();
  paint();
}

// Edit note (C.3.14): the Slice 1 note textarea in a sheet; a note never marks the row edited.
function noteSheet(ctx, ex, done) {
  const area = el('textarea', { rows: '5', id: 'exnote-in', maxlength: String(LIMITS.NOTE), 'aria-label': t('detail.editnote') });
  area.value = ex.notes || '';
  const was = area.value;
  const save = el('button', { class: 'btn btn-primary', type: 'button', id: 'exnote-save' }, t('text.save'));
  const cancel = el('button', { class: 'btn btn-quiet', type: 'button', id: 'exnote-cancel' }, t('text.cancel'));
  const sh = sheet({ id: 'exnote-sheet', title: t('detail.editnote'), canDismiss: () => area.value === was }, area, save, el('div', { class: 'quiet-row' }, cancel));
  save.addEventListener('click', async () => {
    try { await ctx.store.saveExerciseText(ex.id, 'notes', area.value); } catch (e) { toast(t('today.notsaved')); return; }
    sh.close();
    done(area.value);
  });
  cancel.addEventListener('click', () => sh.close());
}
