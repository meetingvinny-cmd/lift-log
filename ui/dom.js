// ui/dom.js - the only way screens build the page.
// Text goes in with textContent, attributes with setAttribute, listeners with
// addEventListener. No HTML strings anywhere, so nothing read from a file can
// ever run as code.
import { LIMITS } from '../backup.js';

const BANNED_ATTR = /^(style|on)/i;

function append(node, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    if (typeof kid === 'string' || typeof kid === 'number') node.appendChild(document.createTextNode(String(kid)));
    else node.appendChild(kid);
  }
  return node;
}

function setAttrs(node, attrs) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'on') {
      for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
      continue;
    }
    if (k === 'text') { node.textContent = String(v); continue; }
    if (BANNED_ATTR.test(k)) throw new Error('dom: attribute not allowed: ' + k);
    node.setAttribute(k, v === true ? '' : String(v));
  }
  return node;
}

// el('p', {class: 'small'}, 'Hello')
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  setAttrs(node, attrs);
  return append(node, children);
}

// The one address string allowed in app code: the SVG namespace name. It is a
// name, never fetched. The static test allows it here and nowhere else.
const SVG_NS = 'http://www.w3.org/2000/svg';

// svg('path', {d: 'M0 0h4'}) for drawn parts (tally lines, charts later).
export function svg(tag, attrs, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  setAttrs(node, attrs);
  return append(node, children);
}

// A copy of one glyph from the hidden set in index.html.
export function glyph(name) {
  const src = document.getElementById('g-' + name);
  if (!src) return null;
  const copy = src.cloneNode(true);
  copy.removeAttribute('id');
  return copy;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

let toastNode = null;
let toastTimer = null;
// The toast time comes from the --toast-ms token, so the two can never drift (C31). A toast
// that wraps reads --t-toast-action (6 s) instead, so it can be read between sets (LOOK 3.7).
function tokenMs(name, fallback) {
  try {
    const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch (_) { return fallback; }
}
// Pure helpers for the long toast (stage 4 B4, LOOK 3.7, DESIGN 4.2). It wraps when its text
// box is taller than one line, measured on the page, never by counting characters.
export function toastWraps(textHeight, lineHeight) {
  return Number.isFinite(textHeight) && Number.isFinite(lineHeight) && lineHeight > 0 && textHeight > lineHeight * 1.5;
}
export function toastTime(wraps, shortMs, longMs) {
  return wraps ? longMs : shortMs;
}
function measureWraps(node) {
  try {
    const cs = getComputedStyle(node);
    const textH = node.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    return toastWraps(textH, parseFloat(cs.lineHeight));
  } catch (_) { return false; }
}
// The backup marker after a share or a "yes, it saved" (SB1, SB6): a refused or failed marker
// (Refused since SR10, or NotSaved) still runs settled(), so the share flag goes off and a held
// update is let go; onFail shows the existing words. True when the marker was written.
export async function markSaved(store, ms, settled, onFail) {
  let ok = true;
  try { await store.markBackedUp(ms); } catch (e) { ok = false; if (onFail) onFail(e); } finally { settled(); }
  return ok;
}
export function toast(text) {
  if (!toastNode) {
    toastNode = el('div', { class: 'toast', role: 'status' });
    document.body.appendChild(toastNode);
  }
  toastNode.classList.remove('is-long');
  toastNode.textContent = String(text);
  // Measured in the one-line skin; the long skin only changes the corners and the alignment.
  const wraps = measureWraps(toastNode);
  toastNode.classList.toggle('is-long', wraps);
  toastNode.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastNode.classList.remove('is-on'), toastTime(wraps, tokenMs('--toast-ms', 3000), tokenMs('--t-toast-action', 6000)));
}

// A ghost tally group for empty states (LOOK 3.10).
export function ghostTally(n = 4) {
  const box = el('span', { class: 'tally', 'aria-hidden': 'true' });
  for (let i = 0; i < n; i++) box.appendChild(el('span', { class: 'tally-stroke' }));
  return box;
}

// A bottom sheet (LOOK 3.3). The scrim closes it only while canDismiss() says so.
// While a field inside has focus the panel carries data-typing, so the keyboard
// never covers the field.
let openSheets = 0;
const idleHooks = new Set();
// How many sheets are open now; an update never reloads while one is (C5, C6).
export function sheetsOpen() { return openSheets; }
// Called each time the last open sheet closes.
export function onSheetsIdle(fn) { idleHooks.add(fn); }
export function sheet(opts, ...children) {
  const o = opts || {};
  const panel = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', id: o.id || null },
    el('div', { class: 'sheet-handle', 'aria-hidden': 'true' }),
    o.title ? el('h2', { class: 'sheet-title' }, o.title) : null,
    o.sub ? el('p', { class: 'small' }, o.sub) : null,
    ...children);
  const scrim = el('div', { class: 'sheet-scrim' });
  const wrap = el('div', { class: 'sheet-wrap' }, scrim, panel);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    wrap.remove();
    openSheets = Math.max(0, openSheets - 1);
    if (!openSheets) document.body.classList.remove('has-sheet');
    if (o.onClose) o.onClose();
    if (!openSheets) for (const fn of idleHooks) { try { fn(); } catch (_) { /* never stops a close */ } }
  };
  scrim.addEventListener('click', () => { if (!o.canDismiss || o.canDismiss()) close(); });
  panel.addEventListener('focusin', (ev) => {
    const f = ev.target;
    if (!f || !/^(INPUT|TEXTAREA)$/.test(f.tagName)) return;
    panel.setAttribute('data-typing', '');
    setTimeout(() => { try { f.scrollIntoView({ block: 'center' }); } catch (_) { /* old engine */ } }, 0);
  });
  // The panel moves back down only after the tap that took the focus has landed,
  // so a tap on a button under a field never hits the scrim instead.
  panel.addEventListener('focusout', () => {
    setTimeout(() => {
      const a = document.activeElement;
      if (!(a && panel.contains(a) && /^(INPUT|TEXTAREA)$/.test(a.tagName))) panel.removeAttribute('data-typing');
    }, 400);
  });
  document.body.appendChild(wrap);
  openSheets++;
  document.body.classList.add('has-sheet');
  return { panel, close, get closed() { return closed; } };
}

// A typed confirm field (LOOK 3.3): the button stays disabled until the word is exact.
export function typedConfirm(labelText, word, button) {
  const input = el('input', { type: 'text', class: 'confirm-input', autocapitalize: 'characters', autocomplete: 'off',
    spellcheck: 'false', 'aria-label': labelText, maxlength: String(LIMITS.KEY) });
  button.disabled = true;
  button.setAttribute('aria-disabled', 'true');
  input.addEventListener('input', () => {
    const ok = input.value.trim() === word;
    button.disabled = !ok;
    button.setAttribute('aria-disabled', ok ? 'false' : 'true');
  });
  return el('label', { class: 'confirm' }, el('span', { class: 'small' }, labelText), input);
}

// True while a typed confirm field (from typedConfirm) holds nothing: a sheet's canDismiss.
export function untyped(confirmLabel) {
  const input = confirmLabel && confirmLabel.querySelector('input');
  return !input || input.value === '';
}
