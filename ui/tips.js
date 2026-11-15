// ui/tips.js - tip lines, one-time intros and the what-changed note (17 C.3.16, LOOK 4.13, 3.6).
// TIP_IDS is also the allowed key list of the tips_seen device key (backup.js holds the same list;
// static.test.js holds the two equal). A closed tip or a seen intro never comes back.
import { el, glyph, sheet } from './dom.js';
import { S, t } from './strings.js';

export const TIP_IDS = Object.freeze(['tip_warmup', 'tip_rest', 'tip_start', 'intro_board', 'intro_picker', 'intro_builder']);

// The tip key of each tip id.
const TIP_KEY = { tip_warmup: 'tip.warmup', tip_rest: 'tip.rest', tip_start: 'tip.start' };

// Which tip Today shows (one at a time; the newest event wins: start, then rest, then warm-up).
// event: {kind: 'start' | 'rest', dayId, exercise_id} or null; seen: the tips_seen object.
export function pickTip(event, seen, day, hasOpen) {
  const s = seen || {};
  if (event && event.dayId === day.id && event.kind === 'start' && !s.tip_start) return { id: 'tip_start', exercise_id: event.exercise_id };
  if (event && event.dayId === day.id && event.kind === 'rest' && !s.tip_rest && hasOpen) return { id: 'tip_rest' };
  if (day.pass === 1 && day.status !== 'done' && !s.tip_warmup) return { id: 'tip_warmup' };
  return null;
}

// A tip line in the page flow: the "i" glyph, one line, and the 44 x 44 close glyph.
export function tipLine(ctx, id) {
  const box = el('div', { class: 'tip', id: 'tip', 'data-tip': id, role: 'note' }, glyph('info'), el('p', { class: 'grow' }, t(TIP_KEY[id])));
  box.appendChild(el('button', { class: 'btn btn-icon', type: 'button', id: 'tip-close', 'aria-label': t('tip.close'), on: { click: async () => {
    box.remove();
    try { await ctx.store.markTipSeen(id); } catch (e) { /* shown again next time, never lost silently */ }
  } } }, glyph('cross')));
  return box;
}

// A one-time intro sheet (picker, builder, guided board): up to 3 lines and Got it; Got it or the
// scrim writes tips_seen[id]. Shown only when the id is not seen yet.
export async function introOnce(ctx, id, titleKey, linesKey) {
  let seen = null;
  try { seen = await ctx.store.tipsSeen(); } catch (e) { return false; }
  if (seen[id]) return false;
  const ok = el('button', { class: 'btn btn-primary', type: 'button', id: 'intro-ok', 'data-intro-ok': id }, t('intro.ok'));
  const lines = t(linesKey);
  const sh = sheet({ id: 'intro-sheet', title: t(titleKey), onClose: () => { ctx.store.markTipSeen(id).catch(() => {}); } },
    el('div', { class: 'intro-lines' }, (Array.isArray(lines) ? lines : [lines]).map(l => el('p', { class: 'lead' }, l))), ok);
  sh.panel.setAttribute('data-intro', id);
  ok.addEventListener('click', () => sh.close());
  return true;
}

// The what-changed note (3.6 banner skin): changed.head with the version, then this version's
// line (changed.v<major>_<minor>_<patch>). Its close hides it for good.
export const changedKey = (v) => 'changed.v' + String(v).split('.').join('_');
export function changedBanner(ctx, version) {
  const box = el('div', { class: 'banner', role: 'status', id: 'changed-banner' },
    el('div', { class: 'grow' }, el('p', {}, t('changed.head', { v: version })),
      // A version with no line of its own (a test build) shows the head alone; static.test.js holds
      // that the shipped version always has its line.
      typeof S[changedKey(version)] === 'string' ? el('p', { class: 'second', id: 'changed-line' }, t(changedKey(version))) : null));
  box.appendChild(el('button', { class: 'btn btn-icon', type: 'button', id: 'changed-close', 'aria-label': t('changed.close'), on: { click: () => {
    box.remove();
    ctx.changedNote = null;
    ctx.store.markChangedSeen().catch(() => {});
  } } }, glyph('cross')));
  return box;
}
