// ui/history.js - the History tab (17 C.3.12, LOOK 4.8), the by-exercise page body it shares with
// Exercise detail and the Block summary, the Block summary pages (C.3.10, LOOK 4.12) and the Block
// finished screen (C.3.9, LOOK 4.12). Every word comes from strings.js; his own words (block names,
// day labels, exercise names) reach the page as text only.
import { el, clear, glyph, ghostTally } from './dom.js';
import { t, tn } from './strings.js';
import { fillTally, dayTitle, nudge } from './today.js';
import { muscleName } from './block.js';
import { trendSvg } from './trend.js';

const fmt = (n) => (n === null || n === undefined) ? '' : String(Math.round(n * 100) / 100);
const unitWord = (u) => t(u === 'kg' ? 'unit.kg' : 'unit.lb');

// ---------------- pure helpers (today.test.js) ----------------

// One done set in the by-round table: "load x reps", reps only on a body row, a count word for
// seconds and laps; an L and R pair reads its side letter after the set number (LOOK 4.8).
export function setText(s, loadKind) {
  const reps = s.count_label && s.count_label !== 'reps' ? fmt(s.reps) + ' ' + s.count_label : fmt(s.reps);
  const body = loadKind === 'body' || s.load === null || s.load === undefined;
  const main = body ? t('history.set.body', { reps }) : t('history.set', { load: fmt(s.load), reps });
  return s.side === 'L' || s.side === 'R' ? s.set_n + s.side + ' ' + main : main;
}

// The second line of a History day row: date and time from done_at in local time, the set
// count, and the body weight when given (LOOK 4.8 r4), as parts the row puts in their own spans.
export function whenLine(day, sets, unit) {
  const d = new Date(day.done_at);
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const when = sets === 1 ? t('history.when.one', { date, time }) : t('history.when', { date, time, n: sets });
  return typeof day.body_weight === 'number' ? [when, t('history.bw', { n: fmt(day.body_weight), unit: unitWord(unit) })] : [when];
}

// ---------------- the by-exercise page body (History, Exercise detail, Summary) ----------------

// blocks: exerciseHistory(...).blocks, newest block first. One group per block: its label, the
// trend line of that block only, then the by-round table.
export function exerciseBody(name, blocks) {
  const box = el('div', { class: 'ex-history' });
  for (const b of blocks) {
    const unit = b.load_kind === 'body' ? t('unit.reps') : unitWord(b.unit);
    const group = el('div', { class: 'ex-history-block', 'data-histblock': b.block_id },
      el('p', { class: 'label' }, t('history.block', { name: b.name })));
    const chart = trendSvg(b.points, name, unit);
    if (chart) group.appendChild(el('div', { class: 'trend-box' }, chart));
    group.appendChild(el('div', { class: 'card hist-table' }, b.rounds.map(r =>
      el('div', { class: 'hist-round', 'data-pass': String(r.pass) },
        el('span', { class: 'num hist-r' }, t('round.short', { r: r.pass })),
        el('span', { class: 'hist-sets' }, r.sets.map(s => el('span', { class: 'num hist-set' }, setText(s, b.load_kind))))))));
    box.appendChild(group);
  }
  return box;
}

// ---------------- the History tab ----------------

let view = 0;   // the switch pick, in memory only: a reload resets it to Days (C.3.12)

function seg(items, pick, onPick, id) {
  return el('div', { class: 'seg seg-switch', role: 'group', id }, items.map((w, i) =>
    el('button', { class: 'chip' + (i === pick ? ' is-on' : ''), type: 'button', 'data-seg': String(i), 'aria-pressed': String(i === pick), on: { click: () => onPick(i) } },
      i === pick ? glyph('check') : null, w)));
}

export function renderHistory(ctx) {
  const screen = el('section', { class: 'screen', id: 'history' });
  drawHistory(ctx, screen).catch((e) => { screen.appendChild(el('p', { class: 'raw' }, String(e && e.message))); });
  return screen;
}

async function drawHistory(ctx, screen) {
  const first = await ctx.store.historyDays({ limit: 30 });
  clear(screen);
  screen.appendChild(el('h1', {}, t('tab.history')));
  if (!first.rows.length) {
    screen.appendChild(el('div', { class: 'empty', id: 'history-none' }, ghostTally(4), el('h2', {}, t('empty.history.title')), el('p', { class: 'lead' }, t('empty.history.line'))));
    return;
  }
  const body = el('div', { id: 'history-body' });
  const pick = (i) => { view = i; screen.querySelector('#history-switch').replaceWith(seg(t('history.switch'), view, pick, 'history-switch')); paint(); };
  screen.append(seg(t('history.switch'), view, pick, 'history-switch'), body);
  const paint = () => { clear(body); screen.setAttribute('data-view', view === 0 ? 'days' : 'exercise'); (view === 0 ? daysView(ctx, body, first) : exerciseList(ctx, body)).catch(() => {}); };
  paint();
}

async function daysView(ctx, body, first) {
  let page = first, lastBlock = null, card = null;
  const list = el('div', { id: 'history-days' });
  body.appendChild(list);
  const add = (p) => {
    for (const r of p.rows) {
      if (r.block.id !== lastBlock) {
        lastBlock = r.block.id;
        list.appendChild(el('p', { class: 'label', 'data-histlabel': r.block.id }, t('history.block', { name: r.block.name })));
        card = el('div', { class: 'card' });
        list.appendChild(card);
      }
      // LOOK 4.8: the large tally on each History day row, done strokes in chalk.
      const tally = el('span', { class: 'tally tally-lg hist-tally', 'aria-hidden': 'true' });
      fillTally(tally, Array.from({ length: r.total }, (_, i) => i < r.done));
      card.appendChild(el('a', { class: 'row row-link menu-row hist-day', href: '#/day/' + r.day.id, 'data-histday': r.day.id },
        el('span', { class: 'grow' },
          el('span', { class: 'hist-pos' }, t('history.pos', { r: r.day.pass, d: r.day.day }) + ' ' + dayTitle(r.day)),
          el('span', { class: 'small hist-when' }, whenLine(r.day, r.sets, r.block.unit).map((x, i) => el('span', { class: i ? 'hist-bw' : null }, x)))),
        tally, glyph('chevron')));
    }
  };
  add(page);
  if (page.more) {
    const more = el('button', { class: 'btn btn-quiet', type: 'button', id: 'history-more' }, t('history.more'));
    more.addEventListener('click', async () => {
      more.disabled = true;
      page = await ctx.store.historyDays({ before: page.next, limit: 30 });
      add(page);
      if (page.more) more.disabled = false; else more.remove();
    });
    body.appendChild(more);
  }
}

async function exerciseList(ctx, body) {
  const rows = await ctx.store.historyExercises();
  const card = el('div', { class: 'card', id: 'history-exercises' }, rows.map(r =>
    el('button', { class: 'row row-link menu-row', type: 'button', 'data-histex': r.id, on: { click: () => exercisePage(ctx, body, r.id) } },
      el('span', { class: 'grow' }, r.name), glyph('chevron'))));
  body.appendChild(card);
}

async function exercisePage(ctx, body, id) {
  const h = await ctx.store.exerciseHistory(id);
  if (!h) return;
  clear(body);
  body.append(
    el('button', { class: 'btn btn-quiet', type: 'button', id: 'histex-back', on: { click: () => { clear(body); exerciseList(ctx, body).catch(() => {}); } } }, glyph('back'), t('history.switch')[1]),
    el('h2', { id: 'histex-name' }, h.exercise.name),
    exerciseBody(h.exercise.name, h.blocks));
}

// ---------------- the Block summary (#/summary/<blockId>[/<exerciseId>]) ----------------

let sumView = 0;

export function renderSummary(ctx, blockId, exerciseId) {
  const screen = el('section', { class: 'screen', id: 'summary' });
  drawSummary(ctx, screen, blockId, exerciseId).catch(() => ctx.go('#/blocks'));
  return screen;
}

async function drawSummary(ctx, screen, blockId, exerciseId) {
  const s = await ctx.store.blockSummary(blockId);
  if (!s) { ctx.go('#/blocks'); return; }
  clear(screen);
  screen.setAttribute('data-block', s.block.id);
  if (exerciseId) {
    const h = await ctx.store.exerciseHistory(exerciseId, s.block.id);
    if (!h) { ctx.go('#/summary/' + s.block.id); return; }
    screen.append(el('a', { class: 'btn btn-quiet', href: '#/summary/' + s.block.id, id: 'sum-back' }, glyph('back'), t('sum.title')),
      el('h1', { id: 'sumex-name' }, h.exercise.name), exerciseBody(h.exercise.name, h.blocks));
    return;
  }
  const body = el('div', { id: 'summary-body' });
  const pick = (i) => { sumView = i; screen.querySelector('#summary-switch').replaceWith(seg(t('sum.switch'), sumView, pick, 'summary-switch')); paint(); };
  screen.append(el('a', { class: 'btn btn-quiet', href: '#/blocks', id: 'sum-blocks' }, glyph('back'), t('blocks.title')),
    el('p', { class: 'label' }, s.block.name), el('h1', {}, t('sum.title')), seg(t('sum.switch'), sumView, pick, 'summary-switch'), body);
  const paint = () => {
    clear(body);
    screen.setAttribute('data-view', ['days', 'muscles', 'exercises'][sumView]);
    if (sumView === 0) {
      const tiles = t('sum.tiles');
      body.appendChild(el('div', { class: 'sum-tiles', id: 'sum-tiles' }, [s.counts.done, s.counts.skipped, s.counts.not_done].map((n, i) =>
        el('div', { class: 'card sum-tile', 'data-tile': ['done', 'skipped', 'notdone'][i] }, el('span', { class: 'num sum-n' }, String(n)), el('span', { class: 'label' }, tiles[i])))));
    } else if (sumView === 1) {
      const rows = [...s.muscles.rows].sort((a, b) => (sum(b.cells) - sum(a.cells)) || (a.muscle < b.muscle ? -1 : 1));
      const head = el('tr', {}, el('th', { class: 'label sum-head', scope: 'col' }, t('sum.muscle')), s.muscles.rounds.map(r => el('th', { class: 'label', scope: 'col' }, t('round.short', { r }))));
      body.appendChild(el('div', { class: 'sum-scroll' }, el('table', { class: 'sum-table', id: 'sum-muscles' },
        el('thead', {}, head),
        el('tbody', {}, rows.map(r => el('tr', { 'data-muscle': r.muscle }, el('th', { class: 'sum-head', scope: 'row' }, muscleName(r.muscle)),
          r.cells.map(c => el('td', { class: 'num' }, String(c)))))))));
    } else {
      body.appendChild(el('div', { class: 'card', id: 'sum-exercises' }, s.exercises.map(x =>
        el('a', { class: 'row row-link menu-row', href: '#/summary/' + s.block.id + '/' + x.id, 'data-sumex': x.id }, el('span', { class: 'grow' }, x.name), glyph('chevron')))));
    }
  };
  paint();
}
const sum = (a) => a.reduce((x, y) => x + y, 0);

// ---------------- Block finished (#/finished/<blockId>) ----------------

// The 4.10 Day done layout. ctx.finished = {id, nudge}: the backup nudge opens over it once,
// right after its first paint, only when the chain that ended the block had no Day done screen
// (End block, Skip day on the last day); after Finish day the Day done screen had the nudge.
export function renderFinished(ctx, blockId) {
  const screen = el('section', { class: 'screen', id: 'finished' });
  (async () => {
    const v = await ctx.store.blockFinishedView(blockId);
    if (!v) { ctx.go('#/today'); return; }
    const tally = el('span', { class: 'tally tally-lg', role: 'img', id: 'fin-tally', 'aria-label': v.tally === 1 ? t('done.tally.one') : t('done.tally', { n: v.tally }) });
    fillTally(tally, Array.from({ length: v.tally }, () => true));
    const rows = [[v.rounds, 'fin.rounds'], [v.days, 'fin.days'], [v.skipped, 'fin.skipped']].filter(([n]) => n > 0)
      .map(([n, key]) => el('div', { class: 'done-row', 'data-fin': key }, el('span', { class: 'num done-n' }, String(n)), el('span', { class: 'done-word' }, tn(key, n))));
    clear(screen);
    screen.setAttribute('data-block', v.block.id);
    screen.append(
      el('p', { class: 'label', id: 'fin-name' }, v.block.name),
      el('h1', {}, t('empty.done.title')),
      tally,
      rows.length ? el('div', { class: 'card done-card' }, rows) : null,
      el('button', { class: 'btn btn-primary', type: 'button', id: 'fin-new', on: { click: () => { ctx.finished = null; ctx.go('#/new'); } } }, t('fin.new')),
      el('button', { class: 'btn btn-secondary', type: 'button', id: 'fin-copy', on: { click: () => { ctx.finished = null; ctx.go('#/copy/' + v.block.id); } } }, t('fin.copy')));
    const want = ctx.finished;
    if (want && want.id === v.block.id && want.nudge) {
      want.nudge = false;
      requestAnimationFrame(() => setTimeout(() => nudge(ctx), 0));
    }
  })().catch(() => ctx.go('#/today'));
  return screen;
}
