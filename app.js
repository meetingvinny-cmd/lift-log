// app.js - boot, updates, the install gate and the routes.
import { APP_VERSION, SCHEMA, RULES_VERSION } from './version.js';
import { db } from './db.js';
import { createStore } from './store.js';
import { backupFileName, LIMITS } from './backup.js';
import { el, clear, glyph, ghostTally, sheet, toast, sheetsOpen, onSheetsIdle, markSaved } from './ui/dom.js';
import { t } from './ui/strings.js';
import { renderInstall } from './ui/install.js';
import { renderCheck } from './ui/check.js';
import { renderSettings, applyTheme, loadBlockFlow } from './ui/settings.js';
import { renderToday, renderDayDone } from './ui/today.js';
import { renderBuilder, renderPicker, hasDraft } from './ui/builder.js';
import { renderBlock, renderDayView } from './ui/block.js';

const root = document.getElementById('app');
const store = createStore({ db });

const ctx = {
  version: APP_VERSION,
  schema: SCHEMA,
  rulesVersion: RULES_VERSION,
  persistAnswer: null,     // what the boot persist() call said
  registration: null,
  db,
  store,
  isStandalone,
  go,
  render: () => render(),
  dayOpen: false,
  build: null,
  picker: null,
  exerciseCache: null,
  dayDone: null,           // {id, nudge}: the day this session just finished, for #/daydone (15 Part 14)
  offerPendingUpdate: () => offerIfWaiting(ctx.registration),
  loadBlockFile: () => loadBlockFlow(ctx),
  pickFile: (maxBytes) => pickFile(maxBytes),
  releaseHeld: () => releaseHeld()
};

export function isStandalone() {
  return navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
}

// "A day is open" = a days row with status open (DESIGN 5.2). Known only after the
// database is read, so an update offer waits for that answer.
let knowDay;
const dayKnown = new Promise((res) => { knowDay = res; });
async function refreshDayOpen() {
  try { ctx.dayOpen = await store.isDayOpen(); } catch (e) { ctx.dayOpen = false; }
  return ctx.dayOpen;
}

// ---------------- keep-awake (DESIGN 5.3) ----------------

const wake = {
  lock: null,
  asking: false,
  request() {
    if (this.lock || this.asking || !navigator.wakeLock || !navigator.wakeLock.request) return;
    this.asking = true;
    navigator.wakeLock.request('screen').then((l) => {
      this.lock = l;
      l.addEventListener('release', () => { if (this.lock === l) this.lock = null; });
    }).catch(() => { /* refused: the screen may dim, Phone check says so */ }).finally(() => { this.asking = false; });
  },
  // From a tick tap: the day is open, or opens with this tick.
  ensure() { this.request(); },
  release() {
    const l = this.lock;
    this.lock = null;
    if (l) l.release().catch(() => {});
  }
};
ctx.wake = wake;
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && ctx.dayOpen) wake.request(); });
document.addEventListener('pointerdown', () => { if (ctx.dayOpen && !wake.lock) wake.request(); }, true);

// ---------------- the backup file, built ahead of the tap (DESIGN 5.4) ----------------

const backup = {
  file: null,
  exportedMs: null,
  bytes: null,          // the size of the file built ahead, for the backup.big line (A4-1)
  timer: null,
  buttons: new Set(),
  running: null,
  sharing: false,       // a share sheet or the "did it save?" ask is up (C6)
  paint() {
    for (const b of [...this.buttons]) {
      if (!b.isConnected) { this.buttons.delete(b); continue; }
      const busy = !this.file;
      b.disabled = busy;
      b.setAttribute('aria-disabled', String(busy));
      if (busy) b.textContent = t('backup.ready');
      else if (b.getAttribute('data-again') !== 'true') b.textContent = b.getAttribute('data-label');
    }
  },
  bind(btn) {
    if (!btn) return;
    btn.setAttribute('data-label', btn.textContent);
    this.buttons.add(btn);
    this.paint();
  },
  // A change came in: the file being built now may miss it, so it is thrown away (C2).
  stale() {
    this.file = null;
    this.running = null;
    this.paint();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.rebuild(), 1000);
  },
  rebuild() {
    clearTimeout(this.timer);
    const job = (async () => {
      const obj = await store.backupObject();
      const ms = Date.parse(obj.exported_at);
      const text = JSON.stringify(obj);
      if (this.running === job) { this.file = new File([text], backupFileName(ms), { type: 'application/json' }); this.exportedMs = ms; this.bytes = this.file.size; }
    })().catch(() => {}).finally(() => this.paint());
    this.running = job;
    return job;
  },
  // Nothing is awaited before share() in the tap, so the tap still counts.
  share(btn, onDone) {
    const f = this.file, ms = this.exportedMs;
    if (!f) return;
    const data = { files: [f] };
    const settled = () => { this.sharing = false; releaseHeld(); };
    this.sharing = true;
    if (navigator.share && navigator.canShare && navigator.canShare(data)) {
      navigator.share(data).then(async () => {
        const ok = await markSaved(store, ms, settled, () => toast(t('backup.not')));
        if (ok && btn) { btn.setAttribute('data-again', 'false'); }
        if (ok && onDone) onDone();
      }, (e) => {
        settled();
        const refused = !!e && e.name === 'NotAllowedError';
        if (refused && btn) {
          btn.setAttribute('data-again', 'true');
          btn.textContent = t('backup.again');
          return;
        }
        toast(t('backup.not'));
      });
      return;
    }
    const url = URL.createObjectURL(f);
    const a = el('a', { href: url, download: f.name, hidden: true, id: 'download-link' });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
    const yes = el('button', { class: 'btn btn-primary', type: 'button', id: 'saved-yes' }, t('backup.yes'));
    const no = el('button', { class: 'btn btn-quiet', type: 'button', id: 'saved-no' }, t('backup.no'));
    const sh = sheet({ id: 'saved-ask', title: t('backup.ask'), canDismiss: () => false }, yes, el('div', { class: 'quiet-row' }, no));
    yes.addEventListener('click', async () => { await markSaved(store, ms, settled, () => toast(t('backup.not'))); sh.close(); if (onDone) onDone(); });
    no.addEventListener('click', () => { settled(); sh.close(); toast(t('backup.not')); if (onDone) onDone(); });
  }
};
ctx.backup = backup;

// ---------------- the one file input (DESIGN 5.3 Load a block file) ----------------

let fileInput = null;
let fileResolve = null;
let fileMax = LIMITS.MAX_PICK_BYTES;
// Resolves the text, null, or { tooBig: true } when the file is over maxBytes. The size
// is checked before the file is read, so a wrong pick (a video) is never loaded (C11).
function pickFile(maxBytes) {
  if (!fileInput) {
    fileInput = el('input', { type: 'file', accept: '.json,application/json,text/plain', class: 'file-input', id: 'file-input', tabindex: '-1', 'aria-hidden': 'true' });
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files && fileInput.files[0];
      const done = fileResolve;
      fileResolve = null;
      if (!done) return;
      if (f && f.size > fileMax) { done({ tooBig: true }); return; }
      try { done(f ? await f.text() : null); } catch (e) { done(null); }
    });
    document.body.appendChild(fileInput);
  }
  fileMax = maxBytes || LIMITS.MAX_PICK_BYTES;
  return new Promise((resolve) => {
    fileResolve = resolve;
    fileInput.value = '';
    fileInput.click();
  });
}

store.onChange(() => {
  backup.stale();
  refreshDayOpen();
  paintDot();
  releaseHeld();
});

// ---------------- updates (DESIGN 4.4 App side) ----------------

let reloading = false;
// The one reload after a restore, undo or erase. Once it is asked for, nothing else
// reloads the page again (an update swap waits on the same flag) (R1).
ctx.reload = () => {
  if (reloading) return;
  reloading = true;
  location.reload();
};
let askedToSwap = false;      // true only after this page told a waiting version to take over
let updateBanner = null;
let bannerClosed = false;     // the close glyph hides the banner until the next launch
let held = false;             // an update found while he was busy, waiting for him to finish

// Busy = something in memory only would be lost by a reload: a half-built block (a draft by
// the Part 4 rule, review P6: an empty build left after Load a block file instead holds nothing),
// the picker, any open sheet, a share in progress, or a write not yet committed (C5, C6, C7).
// The builder route term still holds an update while he is on the builder.
function isBusy() {
  const r = currentRoute();
  return hasDraft(ctx.build) || !!ctx.picker || r === '#/builder' || r === '#/picker' ||
    sheetsOpen() > 0 || backup.sharing || store.busy();
}

function releaseHeld() {
  if (!held || isBusy()) return;
  held = false;
  offerIfWaiting(ctx.registration);
}
onSheetsIdle(() => releaseHeld());

function applyUpdate(worker) {
  if (!worker) return;
  askedToSwap = true;
  worker.postMessage({ type: 'SKIP_WAITING' });
}

async function offerUpdate(worker) {
  if (!worker) return;
  await dayKnown;
  if (!(await refreshDayOpen())) {
    if (isBusy()) { held = true; return; }
    applyUpdate(worker);
    return;
  }
  if (updateBanner || bannerClosed) return;
  updateBanner = el('div', { class: 'banner', role: 'status', id: 'update-banner' },
    el('div', { class: 'grow' },
      el('p', {}, t('update.title')),
      el('p', { class: 'second' }, t('update.later'))),
    el('button', { class: 'btn btn-quiet', type: 'button', on: { click: () => applyUpdate(worker) } }, t('update.now')),
    el('button', { class: 'btn btn-icon', type: 'button', id: 'update-close', 'aria-label': t('update.close'), on: { click: closeBanner } }, glyph('cross')));
  root.prepend(updateBanner);
}

function closeBanner() {
  bannerClosed = true;
  if (updateBanner) updateBanner.remove();
  updateBanner = null;
}

function offerIfWaiting(reg) {
  if (reg && reg.waiting && reg.active) offerUpdate(reg.waiting);
}

function updateNow() {
  const reg = ctx.registration;
  if (!reg) return;
  reg.update().then(() => offerIfWaiting(reg)).catch(() => { /* no signal is fine */ });
}

function watchForUpdates(reg) {
  reg.addEventListener('updatefound', () => {
    const w = reg.installing;
    if (!w) return;
    w.addEventListener('statechange', () => { if (w.state === 'installed') offerIfWaiting(reg); });
  });
  offerIfWaiting(reg);
}

function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Reload once when a version we asked for takes over. The first install also
  // fires controllerchange (clients.claim), and that one must not reload.
  navigator.serviceWorker.addEventListener('controllerchange', async () => {
    if (!askedToSwap || reloading) return;
    reloading = true;
    // A write still in flight (a first tick tapped in the gap) commits before the reload (C7).
    await Promise.race([store.idle(), new Promise((res) => setTimeout(res, 10000))]);
    location.reload();
  });
  navigator.serviceWorker.register('sw.js', { scope: './' })
    .then(reg => { ctx.registration = reg; watchForUpdates(reg); })
    .catch(() => { /* offline is checked on Phone check, never a blocker here */ });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') updateNow();
  });
}

// ---------------- routes ----------------

const TABS = [
  { route: '#/today', key: 'tab.today', icon: 'today' },
  { route: '#/block', key: 'tab.block', icon: 'block' },
  { route: '#/history', key: 'tab.history', icon: 'history' },
  { route: '#/settings', key: 'tab.settings', icon: 'settings' }
];

function tabbar(active) {
  const bar = el('nav', { class: 'tabbar' },
    TABS.map(x => el('a', {
      class: 'tab' + (x.route === active ? ' is-active' : ''),
      href: x.route,
      'data-tab': x.route,
      'aria-current': x.route === active ? 'page' : null
    }, glyph(x.icon), el('span', {}, t(x.key)))));
  setTimeout(paintDot, 0);
  return bar;
}

// The Settings tab dot: some set, day or feedback change is not in a backup yet.
function paintDot() {
  const tab = document.querySelector("a.tab[data-tab='#/settings']");
  if (!tab) return;
  store.backupDue().then((due) => {
    const dot = tab.querySelector('.tab-dot');
    if (due && !dot) tab.appendChild(el('span', { class: 'tab-dot', id: 'backup-dot', 'aria-hidden': 'true' }));
    if (!due && dot) dot.remove();
    // The dot is a picture; the tab itself says it in words while the dot shows (A1-3).
    if (due) tab.setAttribute('aria-label', t('tab.settings.due')); else tab.removeAttribute('aria-label');
  }).catch(() => {});
}

function emptyState(titleKey, lineKey) {
  return el('section', { class: 'screen' },
    el('div', { class: 'empty' }, ghostTally(4), el('h2', {}, t(titleKey)), el('p', { class: 'lead' }, t(lineKey))));
}

const STANDALONE_ROUTES = {
  '#/today': () => renderToday(ctx),
  '#/block': () => renderBlock(ctx),
  '#/history': () => emptyState('empty.next.title', 'empty.next.line'),
  '#/settings': () => renderSettings(ctx),
  '#/check': () => renderCheck(ctx),
  '#/builder': () => renderBuilder(ctx),
  '#/picker': () => renderPicker(ctx)
};
const NO_BAR = new Set(['#/builder', '#/picker']);
const DAYDONE = '#/daydone/';
// The read-only day view (16 B.5 row 2): the store checks the id; a bad one goes to the Block tab.
const DAYVIEW = '#/day/';

function currentRoute() {
  const h = location.hash || '';
  return h.split('?')[0];
}

function render() {
  clear(root);
  if (updateBanner) root.appendChild(updateBanner);
  const route = currentRoute();
  document.body.dataset.route = route || 'none';

  // Install gate: a Safari tab keeps separate data from the icon, so nothing but
  // Install and Phone check runs in a tab. No setting skips it.
  if (!isStandalone()) {
    if (route === '#/check') { root.appendChild(renderCheck(ctx)); return; }
    document.body.dataset.route = 'install';
    root.appendChild(renderInstall(ctx));
    return;
  }

  // The Day done screen (15 Part 14): a pushed full screen with no bottom bar. The day id from
  // the address is checked by the store and must name the day this session just finished.
  if (route.startsWith(DAYDONE)) { root.appendChild(renderDayDone(ctx, route.slice(DAYDONE.length))); return; }
  if (route.startsWith(DAYVIEW)) { root.appendChild(renderDayView(ctx, route.slice(DAYVIEW.length))); root.appendChild(tabbar('#/block')); return; }
  const make = STANDALONE_ROUTES[route];
  if (!make) { go('#/today'); return; }
  root.appendChild(make());
  setTimeout(releaseHeld, 0);
  if (NO_BAR.has(route)) return;
  const tabRoute = route === '#/check' ? '#/settings' : route;
  root.appendChild(tabbar(tabRoute));
}

function go(route) {
  if (location.hash === route) render();
  else location.hash = route;
}

// Storage blocked (LOOK 3.6 Blocked skin, DESIGN 15 Part 19): in place of the whole screen, no
// bottom bar, no button. Never the fail color: nothing here is a not-saved set row.
function storageBlocked(err) {
  clear(root);
  root.appendChild(el('section', { class: 'screen' },
    el('div', { class: 'blocked', id: 'storage-blocked', role: 'alert' },
      el('div', { class: 'blocked-head' }, glyph('warn'), el('h2', {}, t('storage.title'))),
      el('p', {}, t('storage.line')),
      el('p', { class: 'raw' }, String((err && (err.name || err.message)) || err)))));
}

// The two upgrade lines (16 B.5 row 16, LOOK 3.6 Blocked skin): no title, the one line leads with
// the glyph, in place of the whole screen. db.upgradefail adds the raw error line.
function dbBlocked(key, err) {
  clear(root);
  root.appendChild(el('section', { class: 'screen' },
    el('div', { class: 'blocked', id: 'db-blocked', role: 'alert' },
      el('div', { class: 'blocked-head' }, glyph('warn'), el('p', {}, t(key))),
      err ? el('p', { class: 'raw' }, String(err.name || err.message || err)) : null)));
}

// ---------------- boot ----------------

async function boot() {
  // Register first, so the offline copy is built even if storage fails below.
  registerWorker();

  // A newer version closed this page's link: one line, and nothing more is written here.
  store.onVersionClosed(() => dbBlocked('db.reopen'));
  try {
    await db.ready();
  } catch (e) {
    knowDay();
    if (store.upgradeFailed()) dbBlocked('db.upgradefail', e);
    else storageBlocked(e);
    return;
  }
  // The look is set before the first render.
  try { applyTheme(await db.setting('theme', 'phone')); } catch (e) { /* the phone's own setting is used */ }
  try { await store.seed(); } catch (e) { /* seeding again next boot */ }
  await refreshDayOpen();
  knowDay();
  if (ctx.dayOpen) wake.request();
  backup.rebuild();

  if (navigator.storage && navigator.storage.persist) {
    try { ctx.persistAnswer = await navigator.storage.persist(); } catch (e) { ctx.persistAnswer = false; }
  }

  window.addEventListener('hashchange', render);
  render();
  // The line a restore or undo left for this boot, shown once after the first paint (A3-R8).
  store.takeRestoreNote().then((n) => { if (n !== null) toast(t('restore.done', { n })); }).catch(() => {});
}

boot();
