// ui/blocks.js - Slice 3 block screens (17 C.3.2, C.3.3; LOOK 4.12): the block list with its row
// menu (Note, Rename, Copy, Summary, Save as template, Delete) and the New block chooser. Every word
// comes from strings.js; his own words (block names, notes) reach the page as text only.
import { el, clear, glyph, sheet, toast, ghostTally, typedConfirm, untyped } from './dom.js';
import { t, tn } from './strings.js';
import { LIMITS } from '../backup.js';
import { openBuilder, askSwitch } from './builder.js';
import { ringGlyph } from './today.js';
import { openGuided } from './guided.js';

// The row line of one block (LOOK 4.12): rounds (or open ended), profile word, days done or finished.
export function blockRowLine(b) {
  const profile = t(b.profile === 'adaptive' ? 'profile.adjust' : 'profile.fixed');
  const base = b.passes === null ? 'blocks.row.open' : b.passes === 1 ? 'blocks.row.r1' : 'blocks.row';
  if (b.status === 'done') return t(base + '.done', { rounds: b.passes, profile });
  return tn(base, b.days_done, { rounds: b.passes, profile });
}

// The six row menu items, in order (C.3.2): [key into rowmenu, data-item].
export const ROW_MENU = [[0, 'note'], [1, 'rename'], [2, 'copy'], [3, 'summary'], [4, 'template'], [5, 'delete']];

export function renderBlocks(ctx) {
  const screen = el('section', { class: 'screen', id: 'blocks' });
  draw(ctx, screen).catch((e) => { screen.appendChild(el('p', { class: 'raw' }, String(e && e.message))); });
  return screen;
}

async function draw(ctx, screen) {
  const list = await ctx.store.listBlocks();
  clear(screen);
  const newBtn = el('button', { class: 'btn btn-primary', type: 'button', id: 'blocks-new', on: { click: () => ctx.go('#/new') } }, t('blocks.new'));
  screen.appendChild(el('h1', {}, t('blocks.title')));
  if (!list.length) {
    screen.append(el('div', { class: 'empty', id: 'blocks-empty' }, ghostTally(4), el('h2', {}, t('blocks.empty.title'))), newBtn);
    return;
  }
  screen.append(el('div', { class: 'card', id: 'blocks-list' }, list.map(b => blockRow(ctx, screen, b))), newBtn);
}

function blockRow(ctx, screen, b) {
  const more = el('button', { class: 'btn btn-icon', type: 'button', 'data-blockmore': b.id, 'aria-label': t('blocks.more', { name: b.name }),
    on: { click: (ev) => { ev.stopPropagation(); rowMenu(ctx, screen, b); } } }, glyph('more'));
  const open = el('button', { class: 'row row-link menu-row block-list-row grow', type: 'button', 'data-blockrow': b.id, 'data-current': String(b.current),
    on: { click: () => ctx.go('#/block/' + b.id) } },
  el('span', { class: 'grow' },
    el('span', { class: 'block-row-name' }, b.name, b.current ? el('span', { class: 'pill pill-target', 'data-pill': 'current' }, ringGlyph(), t('pill.current')) : null),
    el('span', { class: 'small block-row-line' }, blockRowLine(b))));
  return el('div', { class: 'block-list-item', 'data-block-item': b.id }, open, more);
}

function rowMenu(ctx, screen, b) {
  const words = t('rowmenu');
  const items = ROW_MENU.map(([i, key]) => el('button', { class: 'row row-link menu-row' + (key === 'delete' ? ' menu-row-danger' : ''), type: 'button', 'data-rowitem': key,
    on: { click: () => { sh.close(); act(ctx, screen, b, key); } } }, el('span', { class: 'grow' }, words[i])));
  // The delete item sits after a hairline (LOOK 4.12).
  const sh = sheet({ id: 'row-menu', title: b.name }, el('div', { class: 'card' }, ...items.slice(0, 5)), el('div', { class: 'card hairline-top' }, items[5]));
}

function act(ctx, screen, b, key) {
  const again = () => draw(ctx, screen).catch(() => {});
  if (key === 'note') return noteSheet(ctx, b, again);
  if (key === 'rename') return renameSheet(ctx, b, again);
  if (key === 'delete') return deleteSheet(ctx, b, again);
  if (key === 'copy') return ctx.go('#/copy/' + b.id);
  if (key === 'summary') return ctx.go('#/summary/' + b.id);
  if (key === 'template') return saveTemplateSheet(ctx, b.id, b.name);
  return undefined;
}

// The block note sheet (C.3.2 Note, the Slice 1 Notes skin): writes blocks.notes.
export function noteSheet(ctx, b, done) {
  const area = el('textarea', { rows: '5', id: 'blocknote-in', maxlength: String(LIMITS.NOTE), 'aria-label': t('blocknote.title') });
  area.value = b.notes || '';
  const was = area.value;
  const save = el('button', { class: 'btn btn-primary', type: 'button', id: 'blocknote-save' }, t('text.save'));
  const cancel = el('button', { class: 'btn btn-quiet', type: 'button', id: 'blocknote-cancel' }, t('text.cancel'));
  const sh = sheet({ id: 'blocknote-sheet', title: t('blocknote.title'), canDismiss: () => area.value === was }, area, save, el('div', { class: 'quiet-row' }, cancel));
  save.addEventListener('click', async () => {
    try { await ctx.store.setBlockNote(b.id, area.value); } catch (e) { toast(t('today.notsaved')); return; }
    sh.close();
    if (done) done();
  });
  cancel.addEventListener('click', () => sh.close());
}

// Rename (C.3.2, LOOK 4.3 relabel skin): one normal text field, a blank name is refused.
function renameSheet(ctx, b, done) {
  const input = el('input', { type: 'text', class: 'field', id: 'rename-in', maxlength: String(LIMITS.NAME), autocomplete: 'off', 'aria-label': t('rename.title') });
  input.value = b.name;
  const save = el('button', { class: 'btn btn-primary', type: 'button', id: 'rename-save' }, t('text.save'));
  const cancel = el('button', { class: 'btn btn-quiet', type: 'button', id: 'rename-cancel' }, t('text.cancel'));
  const sh = sheet({ id: 'rename-sheet', title: t('rename.title'), canDismiss: () => input.value === b.name }, input, save, el('div', { class: 'quiet-row' }, cancel));
  save.addEventListener('click', async () => {
    if (!input.value.trim()) { input.focus(); return; }
    try { await ctx.store.renameBlock(b.id, input.value.trim()); } catch (e) { toast(t('today.notsaved')); return; }
    sh.close();
    if (done) done();
  });
  cancel.addEventListener('click', () => sh.close());
}

// Delete (C.3.2, LOOK 4.12): the Danger button stays off until the field says DELETE (M54).
function deleteSheet(ctx, b, done) {
  const go = el('button', { class: 'btn btn-danger', type: 'button', id: 'del-go' }, t('del.go'));
  const field = typedConfirm(t('del.type'), 'DELETE', go);
  const cancel = el('button', { class: 'btn btn-quiet', type: 'button', id: 'del-cancel' }, t('text.cancel'));
  const sh = sheet({ id: 'del-sheet', title: t('del.title', { name: b.name }), canDismiss: () => untyped(field) },
    el('p', { class: 'small' }, t('del.line')), field, go, el('div', { class: 'quiet-row' }, cancel));
  go.addEventListener('click', async () => {
    const typed = field.querySelector('input').value.trim();
    go.disabled = true;
    try { await ctx.store.deleteBlock(b.id, typed); } catch (e) { go.disabled = false; toast(t('today.notsaved')); return; }
    sh.close();
    // A day of that block may have been open: the screen stays awake only while a day is open.
    if (ctx.wake && !(await ctx.store.isDayOpen().catch(() => false))) ctx.wake.release();
    if (done) done();
  });
  cancel.addEventListener('click', () => sh.close());
}

// Save as template (C.3.4, LOOK 4.12): the relabel skin with one name field preset to the block name.
// Built by the templates step; until then the store call is absent and the sheet says not saved.
export function saveTemplateSheet(ctx, blockId, name) {
  const input = el('input', { type: 'text', class: 'field', id: 'tplsave-in', maxlength: String(LIMITS.NAME), autocomplete: 'off', 'aria-label': t('tplsave.name') });
  input.value = name || '';
  const save = el('button', { class: 'btn btn-primary', type: 'button', id: 'tplsave-save' }, t('text.save'));
  const cancel = el('button', { class: 'btn btn-quiet', type: 'button', id: 'tplsave-cancel' }, t('text.cancel'));
  const sh = sheet({ id: 'tplsave-sheet', title: t('tplsave.title'), canDismiss: () => input.value === (name || '') },
    el('label', { class: 'label', for: 'tplsave-in' }, t('tplsave.name')), input, save, el('div', { class: 'quiet-row' }, cancel));
  save.addEventListener('click', async () => {
    if (!input.value.trim()) { input.focus(); return; }
    try {
      if (typeof ctx.store.saveBlockAsTemplate !== 'function') throw new Error('not built');
      await ctx.store.saveBlockAsTemplate(blockId, input.value.trim());
    } catch (e) { toast(t('today.notsaved')); return; }
    sh.close();
    toast(t('tpl.saved'));
  });
  cancel.addEventListener('click', () => sh.close());
}

// ---------------- the New block chooser (C.3.3, LOOK 4.12) ----------------

export function renderChooser(ctx) {
  // The 3.4 Choice skin (the scope sheet's stacked chips): a title over one 15px line.
  const choice = (id, titleKey, lineKey, go) => el('button', { class: 'chip choice', type: 'button', id, on: { click: go } },
    el('span', { class: 'grow' }, el('span', { class: 'choice-title' }, t(titleKey)), el('span', { class: 'choice-line small' }, t(lineKey))));
  return el('section', { class: 'screen no-bar', id: 'new' },
    el('div', { class: 'topbar' }, el('button', { class: 'btn btn-quiet', type: 'button', id: 'new-back', on: { click: () => history.length > 1 ? history.back() : ctx.go('#/today') } }, glyph('back'), t('builder.back'))),
    el('h1', {}, t('new.title')),
    el('div', { class: 'q-chips stack choices' },
      choice('new-scratch', 'new.scratch', 'new.scratch.line', () => openBuilder(ctx)),
      choice('new-template', 'new.template', 'new.template.line', () => ctx.go('#/templates')),
      choice('new-guided', 'new.guided', 'new.guided.line', () => openGuided(ctx))),
    el('div', { class: 'quiet-row' }, el('button', { class: 'btn btn-quiet', type: 'button', id: 'new-load', on: { click: () => ctx.loadBlockFile() } }, t('setup.load'))));
}

// ---------------- Copy a block (C.3.8, LOOK 4.12) ----------------

// Three steps in the 4.6 progress skin: pick a round, review the start values, Copy block. The
// copy keeps the source unit (B09), so Review says so. The pick lives in ctx.copy (counted busy).
export function renderCopy(ctx, blockId) {
  if (!ctx.copy || ctx.copy.blockId !== blockId) ctx.copy = { blockId, step: 1, pass: null };
  const c = ctx.copy;
  const steps = t('copy.steps');
  const screen = el('section', { class: 'screen no-bar', id: 'copy', 'data-step': String(c.step) });
  const rerender = () => { const n = renderCopy(ctx, blockId); screen.replaceWith(n); };
  const progress = el('progress', { id: 'copy-progress', 'aria-label': t('builder.progress', { n: c.step, step: steps[c.step - 1] }) });
  progress.setAttribute('max', '3');
  progress.setAttribute('value', String(c.step));
  const leave = () => { ctx.copy = null; ctx.go('#/blocks'); };
  screen.append(el('div', { class: 'topbar' },
    el('button', { class: 'btn btn-quiet', type: 'button', id: 'copy-cancel', on: { click: leave } }, glyph('back'), t('block.cancel')),
    el('h2', { class: 'grow' }, steps[c.step - 1])), progress);
  const body = el('div', { id: 'copy-body' });
  screen.appendChild(body);
  (async () => {
    const rounds = await ctx.store.copyRounds(blockId).catch(() => null);
    if (!rounds) { leave(); return; }
    screen.setAttribute('data-block', rounds.block_id);
    if (c.step === 1) {
      body.appendChild(el('div', { class: 'q-chips stack choices', id: 'copy-rounds' }, rounds.rounds.map(r => el('button', {
        class: 'chip choice' + (c.pass === r.pass ? ' is-on' : ''), type: 'button', 'data-copyround': String(r.pass),
        on: { click: () => { c.pass = r.pass; c.step = 2; rerender(); } } },
      el('span', { class: 'grow' }, el('span', { class: 'choice-title' }, t('today.round', { r: r.pass })),
        el('span', { class: 'choice-line small' }, tn('copy.round.line', r.days_done)))))));
      return;
    }
    const pv = await ctx.store.copyPreview(blockId, c.pass).catch(() => null);
    if (!pv) { c.step = 1; rerender(); return; }
    const unitWord = t(pv.unit === 'kg' ? 'unit.kg' : 'unit.lb');
    if (c.step === 2) {
      body.append(el('p', { class: 'small', id: 'copy-unit' }, t('copy.unit', { unit: unitWord })),
        ...pv.days.map(d => el('div', { class: 'card day-card', 'data-copyday': String(d.day) }, el('h2', {}, d.label || t('day.n', { n: d.day })),
          ...d.lifts.map(l => el('div', { class: 'row', 'data-copylift': d.day + ':' + l.slot },
            el('span', { class: 'grow' }, tn('builder.liftsets', l.sets, { name: l.name })),
            l.start_load === null ? null : el('span', { class: 'num', 'data-copyload': d.day + ':' + l.slot }, String(l.start_load)))))),
        el('button', { class: 'btn btn-primary', type: 'button', id: 'copy-next', on: { click: () => { c.step = 3; rerender(); } } }, t('builder.next')),
        el('button', { class: 'btn btn-quiet', type: 'button', id: 'copy-back', on: { click: () => { c.step = 1; rerender(); } } }, t('builder.back')));
      return;
    }
    const go = el('button', { class: 'btn btn-primary', type: 'button', id: 'copy-go' }, t('copy.go'));
    go.addEventListener('click', async () => {
      go.disabled = true;
      const finish = async (activate) => {
        try { await ctx.store.copyBlock(blockId, c.pass, { activate }); } catch (e) { go.disabled = false; toast(t('today.notsaved')); return; }
        ctx.copy = null;
        ctx.go(activate ? '#/today' : '#/blocks');
      };
      const current = await ctx.store.activeBlock().catch(() => null);
      if (!current) { finish(true); return; }
      askSwitch((yes) => finish(yes), () => { go.disabled = false; });
    });
    body.append(el('p', { class: 'small', id: 'copy-unit' }, t('copy.unit', { unit: unitWord })), go,
      el('button', { class: 'btn btn-quiet', type: 'button', id: 'copy-back', on: { click: () => { c.step = 2; rerender(); } } }, t('builder.back')));
  })();
  return screen;
}
