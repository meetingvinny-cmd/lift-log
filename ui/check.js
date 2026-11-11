// ui/check.js - Phone check. Seven rows plus a few facts, for one screenshot (DESIGN 4.5).
// Row states: Yes (ok), Unsure (amber), No (red). An Unsure or No shows one line on what to do.
import { el, clear, glyph } from './dom.js';
import { t } from './strings.js';

// Must equal the Content-Security-Policy meta tag in index.html (static test).
export const EXPECTED_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

const YES = 'yes', UNSURE = 'unsure', NO = 'no';
const WORD = { yes: 'check.yes', unsure: 'check.unsure', no: 'check.no' };
const GLYPH = { yes: 'check', unsure: 'ask', no: 'cross' };
const CONTROLLER_WAIT_MS = 10000;

function result(state, value, todo) { return { state, value: value || '', todo: todo || '' }; }

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), ms); })
  ]).finally(() => clearTimeout(timer));
}

// ---- row 1 ----
function checkIcon(ctx) {
  return ctx.isStandalone() ? result(YES) : result(NO, '', t('check.row1.no'));
}

// ---- row 2 ----
function waitForController(ms) {
  return new Promise((resolve, reject) => {
    if (navigator.serviceWorker.controller) return resolve(navigator.serviceWorker.controller);
    const end = Date.now() + ms;
    const tick = () => {
      if (navigator.serviceWorker.controller) return resolve(navigator.serviceWorker.controller);
      if (Date.now() >= end) return reject(new Error('no controller'));
      setTimeout(tick, 200);
    };
    tick();
  });
}

function askWorker(ctl) {
  return withTimeout(new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = (ev) => resolve(ev.data);
    ctl.postMessage({ type: 'SHELL' }, [ch.port2]);
  }), 3000);
}

// The worker's own answer from the last row 2 check: the facts box prints ITS cache name,
// never a name the page works out for itself, so a mixed old page and new worker shows (C8).
let workerInfo = null;

async function checkOffline(ctx) {
  workerInfo = null;
  if (!('serviceWorker' in navigator) || !window.caches) return result(NO, '', t('check.row2.no'));
  const start = Date.now();
  let reg, ctl;
  try {
    reg = await withTimeout(navigator.serviceWorker.ready, CONTROLLER_WAIT_MS);
    ctl = await waitForController(Math.max(0, CONTROLLER_WAIT_MS - (Date.now() - start)));
  } catch (e) {
    return result(UNSURE, t('check.noanswer'), t('check.row2.unsure'));
  }
  let info;
  try { info = await askWorker(ctl); } catch (e) { return result(UNSURE, t('check.noanswer'), t('check.row2.unsure')); }
  if (!info || !Array.isArray(info.shell)) return result(UNSURE, t('check.noanswer'), t('check.row2.unsure'));
  workerInfo = info;
  const total = info.shell.length;
  if (info.version !== ctx.version) return result(NO, '', t('check.row2.mixed'));
  // caches.has first: caches.open would make an empty cache that was not there.
  if (!(await caches.has(info.cache))) return result(NO, t('check.count', { n: 0, total }), t('check.row2.no'));
  const cache = await caches.open(info.cache);
  let have = 0;
  for (const u of info.shell) {
    if (await cache.match(new URL(u, reg.scope).href)) have++;
  }
  const value = t('check.count', { n: have, total });
  return have === total ? result(YES, value) : result(NO, value, t('check.row2.no'));
}

// ---- row 3 ----
function mb(n) {
  return (typeof n === 'number' && isFinite(n)) ? (n / 1048576).toFixed(1) : '?';
}

async function usageLine(ctx) {
  const s = navigator.storage;
  let x = '?', y = '?';
  if (s && s.estimate) {
    try { const est = await s.estimate(); x = mb(est.usage); y = mb(est.quota); } catch (e) { /* stays ? */ }
  }
  const words = t('check.row3.usage.asked');
  const asked = ctx.persistAnswer === null ? words[2] : (ctx.persistAnswer ? words[0] : words[1]);
  return t('check.row3.usage', { x, y, asked });
}

async function checkStorage(ctx) {
  const s = navigator.storage;
  if (!s || !s.persisted) return result(UNSURE, t('check.unknown'), t('check.row3.nosay'));
  let persisted = false;
  try { persisted = await s.persisted(); } catch (e) { persisted = false; }
  if (persisted) return result(YES);
  return result(UNSURE, '', ctx.isStandalone() ? t('check.row3.icon') : t('check.row3.tab'));
}

// ---- row 4 ----
async function checkSaves(ctx) {
  const todo = t('check.row4.no');
  // A write still in flight (the boot seed, a save): wait up to 4 s for it, and never drop the
  // link under it (SR15). Still busy: Unsure, run the check again.
  if (ctx.store.busy()) await withTimeout(ctx.store.idle(), 4000).catch(() => {});
  if (ctx.store.busy()) return result(UNSURE, '', t('check.row5.first'));
  const stamp = Date.now();
  try {
    // The store puts, drops the link on purpose (the read must reconnect), reads back and
    // deletes, inside one exclusive job.
    const value = await ctx.store.probe(stamp);
    if (value !== stamp) return result(NO, '', todo);
    return result(YES);
  } catch (e) {
    return result(NO, (e && e.name) || t('check.error'), todo);
  }
}

// ---- row 5 ----
// Called inside the "Run check again" tap, before anything is awaited, so the
// phone sees a user action. Never called on open.
function requestWake() {
  if (!('wakeLock' in navigator) || !navigator.wakeLock || !navigator.wakeLock.request) return { missing: true };
  try { return { promise: navigator.wakeLock.request('screen') }; } catch (e) { return { error: e }; }
}

async function checkAwake(ctx, opts) {
  if (!('wakeLock' in navigator) || !navigator.wakeLock || !navigator.wakeLock.request) return result(NO, '', t('check.row5.unsure'));
  const w = opts && opts.wake;
  if (!w) return result(UNSURE, '', t('check.row5.first'));
  if (w.missing) return result(NO, '', t('check.row5.unsure'));
  if (w.error) return result(UNSURE, w.error.name || t('check.error'), t('check.row5.unsure'));
  try {
    const lock = await withTimeout(w.promise, 3000);
    try { await lock.release(); } catch (e) { /* released already */ }
    return result(YES);
  } catch (e) {
    return result(UNSURE, (e && e.name) || t('check.error'), t('check.row5.unsure'));
  }
}

// ---- row 6 ----
function checkShare() {
  try {
    if (!navigator.canShare) return result(UNSURE, '', t('check.row6.unsure'));
    const f = new File(['{}'], 't.json', { type: 'application/json' });
    return navigator.canShare({ files: [f] }) ? result(YES) : result(UNSURE, '', t('check.row6.unsure'));
  } catch (e) {
    return result(UNSURE, '', t('check.row6.unsure'));
  }
}

// ---- row 7 ----
function checkLocked() {
  const m = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  const first = document.head && document.head.firstElementChild;
  const ok = !!m && m.getAttribute('content') === EXPECTED_CSP &&
    !!first && first.hasAttribute('charset') && first.nextElementSibling === m;
  return ok ? result(YES) : result(NO, '', t('check.row7.no'));
}

// ---- facts ----

// Safari on newer iOS reports a frozen 18.x number, so an 18.6 or higher
// reading is shown as "or newer" and the real number is read in Settings.
export function iosVersion(ua) {
  const m = /OS (\d+)_(\d+)(?:_(\d+))? like Mac OS X/.exec(ua || '');
  if (!m) return t('check.ios.none');
  const v = m[1] + '.' + m[2] + (m[3] ? '.' + m[3] : '');
  return (Number(m[1]) === 18 && Number(m[2]) >= 6) ? v + ' ' + t('check.ios.newer') : v;
}

function screenFacts() {
  const probe = el('div', { class: 'safe-probe' });
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const top = Math.round(parseFloat(cs.paddingTop) || 0);
  const bottom = Math.round(parseFloat(cs.paddingBottom) || 0);
  probe.remove();
  return {
    size: window.innerWidth + 'x' + window.innerHeight + ', ' + (window.devicePixelRatio || 1) + 'x',
    safe: top + '/' + bottom
  };
}

function checkedAt(d) {
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

// ---- screen ----

const ROWS = [
  ['1', 'check.row1', checkIcon],
  ['2', 'check.row2', checkOffline],
  ['3', 'check.row3', checkStorage],
  ['4', 'check.row4', checkSaves],
  ['5', 'check.row5', checkAwake],
  ['6', 'check.row6', checkShare],
  ['7', 'check.row7', checkLocked]
];

function resultRow(n, label, r) {
  return el('div', { class: 'row check-row is-' + r.state, 'data-row': n, 'data-result': r.state },
    el('span', { class: 'pill pill-' + r.state }, glyph(GLYPH[r.state]), t(WORD[r.state])),
    el('span', { class: 'grow' }, label),
    r.value ? el('span', { class: 'val' }, r.value) : null,
    r.state !== YES && r.todo ? el('span', { class: 'what-to-do' }, r.todo) : null);
}

function factRow(label, value, id) {
  return el('div', { class: 'row', 'data-fact': id },
    el('span', { class: 'grow' }, label),
    el('span', { class: 'val' }, value));
}

export async function runChecks(ctx, opts) {
  const out = [];
  for (const [n, key, fn] of ROWS) {
    let r;
    try { r = await fn(ctx, opts); } catch (e) { r = result(UNSURE, t('check.error'), ''); }
    out.push([n, t(key), r]);
  }
  return out;
}

export function renderCheck(ctx) {
  const standalone = ctx.isStandalone();
  const rowsBox = el('div', { class: 'card', id: 'check-rows', 'aria-busy': 'true' },
    el('div', { class: 'row' }, el('span', { class: 'grow small' }, t('check.busy'))));
  const factsBox = el('div', { class: 'card', id: 'check-facts' });
  const storageBox = el('div', { class: 'banner banner-storage', id: 'storage-banner', role: 'status', hidden: true },
    el('p', { class: 'grow' }, t('storage.unprotected')));
  const summary = el('p', { class: 'summary', id: 'check-summary' });
  const again = el('button', { class: 'btn btn-primary', type: 'button', id: 'check-again' }, t('check.again'));
  const info = t('check.info');
  const mode = t('check.summary.mode');

  async function run(opts) {
    again.disabled = true;
    rowsBox.setAttribute('aria-busy', 'true');
    const rows = await runChecks(ctx, opts);
    clear(rowsBox);
    for (const [n, label, r] of rows) rowsBox.appendChild(resultRow(n, label, r));
    const yes = rows.filter(([, , r]) => r.state === YES).length;
    // Amber storage banner (LOOK 3.6): from the icon only, while row 3 is not Yes.
    const r3 = rows.find(([n]) => n === '3');
    storageBox.hidden = !(standalone && r3 && r3[2].state !== YES);
    const ios = iosVersion(navigator.userAgent);
    const sf = screenFacts();
    clear(factsBox);
    factsBox.appendChild(factRow(t('check.ios'), ios, 'ios'));
    if (ios.endsWith(t('check.ios.newer'))) factsBox.appendChild(el('div', { class: 'row' }, el('span', { class: 'small' }, t('check.ios.hint'))));
    factsBox.appendChild(factRow(info[0], ctx.version, 'version'));
    factsBox.appendChild(factRow(info[1], String(ctx.schema), 'schema'));
    factsBox.appendChild(factRow(info[2], workerInfo && typeof workerInfo.cache === 'string' ? workerInfo.cache : t('check.noanswer'), 'cache'));
    factsBox.appendChild(factRow(info[3], sf.size, 'screen'));
    factsBox.appendChild(factRow(info[4], sf.safe, 'safe'));
    factsBox.appendChild(factRow(info[5], checkedAt(new Date()), 'checked'));
    factsBox.appendChild(el('div', { class: 'row' }, el('span', { class: 'raw', id: 'check-ua' }, navigator.userAgent)));
    factsBox.appendChild(el('div', { class: 'row' }, el('span', { class: 'raw', id: 'check-usage' }, await usageLine(ctx))));
    summary.textContent = [ctx.version, standalone ? mode[0] : mode[1], t('check.count', { n: yes, total: rows.length })].join(' | ');
    rowsBox.setAttribute('aria-busy', 'false');
    again.disabled = false;
  }
  // The keep-awake request must sit inside the tap, before anything is awaited.
  again.addEventListener('click', () => { const wake = requestWake(); run({ wake }); });

  const back = standalone
    ? el('a', { class: 'btn btn-quiet', href: '#/settings', id: 'check-back' }, glyph('back'), t('check.back'))
    : el('a', { class: 'btn btn-quiet', href: '#/install', id: 'check-back' }, glyph('back'), t('check.backtab'));

  const screen = el('section', { class: 'screen' + (standalone ? '' : ' no-bar'), id: 'check' },
    el('div', { class: 'topbar' }, back),
    el('h1', {}, t('check.title')),
    el('p', { class: 'lead' }, t('check.sub')),
    storageBox,
    rowsBox, factsBox, again, summary,
    el('p', { class: 'small' }, t('check.footer')));
  setTimeout(() => run({ wake: null }), 0);
  return screen;
}
