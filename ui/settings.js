// ui/settings.js - Settings (LOOK 4.9): backup, restore, undo, block files, units, look,
// Phone check, the version facts and Erase all. Everything read from a file is shown
// with textContent only.
import { el, clear, glyph, sheet, toast, typedConfirm, untyped } from './dom.js';
import { t, tn } from './strings.js';
import { LIMITS, backupBig, backupMB } from '../backup.js';

const DAY_MS = 24 * 3600 * 1000;
const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const fmtWhen = (ms) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function row(label, value, id) {
  return el('div', { class: 'row', 'data-fact': id },
    el('span', { class: 'grow' }, label),
    el('span', { class: 'val' }, value));
}

function seg(items, current, onPick, id) {
  const box = el('div', { class: 'seg', id });
  const btns = items.map(([k, word]) => el('button', { class: 'chip' + (k === current ? ' is-on' : ''), type: 'button', 'data-k': k, 'aria-pressed': String(k === current),
    on: { click: () => { btns.forEach(b => { const on = b.getAttribute('data-k') === k; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', String(on)); }); onPick(k); } } },
    glyph('check'), word));
  box.append(...btns);
  return box;
}

export function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  else document.documentElement.removeAttribute('data-theme');
}

export function renderSettings(ctx) {
  const store = ctx.store;
  const lastLine = el('span', { class: 'grow', id: 'backup-last' });
  const duePill = el('span', { class: 'pill pill-unsure', id: 'backup-due', hidden: true }, glyph('share'), t('settings.backup.due'));
  const backupBtn = el('button', { class: 'btn btn-secondary', type: 'button', id: 'backup-now' }, t('settings.backupnow'));
  ctx.backup.bind(backupBtn);
  backupBtn.addEventListener('click', () => ctx.backup.share(backupBtn, () => paint()));
  const restoreBtn = el('button', { class: 'btn btn-secondary', type: 'button', id: 'restore-file', on: { click: () => restoreFlow(ctx) } }, t('settings.restore'));
  const undoRow = el('button', { class: 'row row-link menu-row', type: 'button', id: 'undo-row', hidden: true, on: { click: () => undoList(ctx) } },
    el('span', { class: 'grow' }, t('settings.undo')), glyph('chevron'));
  const storageBox = el('div', { class: 'banner banner-storage', id: 'storage-banner', role: 'status', hidden: true }, el('p', { class: 'grow' }, t('storage.unprotected')));
  const bigLine = el('p', { class: 'small what-to-do', id: 'backup-big', role: 'status', hidden: true });

  async function paint() {
    const last = await store.getSetting('last_backup_at', null);
    lastLine.textContent = last === null ? t('backup.never') : t('backup.last', { n: Math.max(0, Math.floor((Date.now() - last) / DAY_MS)) });
    duePill.hidden = !(await store.backupDue());
    undoRow.hidden = !(await store.listSnapshots()).length;
    if (ctx.isStandalone() && navigator.storage && navigator.storage.persisted) {
      try { storageBox.hidden = await navigator.storage.persisted(); } catch (_) { storageBox.hidden = false; }
    }
  }

  const screen = el('section', { class: 'screen', id: 'settings' },
    el('h1', {}, t('settings.title')),
    storageBox,
    el('div', { class: 'group', id: 'backup-group' },
      el('p', { class: 'label' }, t('settings.group.backup')),
      el('div', { class: 'card' },
        el('div', { class: 'row' }, lastLine, duePill),
        el('div', { class: 'row' }, backupBtn),
        bigLine,
        el('div', { class: 'row' }, restoreBtn),
        undoRow)),
    el('div', { class: 'group', id: 'logging-group' },
      el('p', { class: 'label' }, t('settings.group.logging')),
      el('div', { class: 'card' }, ...loggingRows(ctx))),
    el('div', { class: 'group', id: 'block-group' },
      el('p', { class: 'label' }, t('settings.group.block')),
      el('div', { class: 'card' },
        el('button', { class: 'row row-link menu-row', type: 'button', id: 'load-block-row', on: { click: () => ctx.loadBlockFile() } },
          el('span', { class: 'grow' }, t('settings.load')), glyph('chevron')))),
    el('div', { class: 'group', id: 'units-group' },
      el('p', { class: 'label' }, t('settings.units')),
      el('div', { class: 'card' }, el('div', { class: 'row check-row' }, unitsSeg(ctx), el('span', { class: 'what-to-do' }, t('settings.units.line'))))),
    el('div', { class: 'group', id: 'look-group' },
      el('p', { class: 'label' }, t('settings.look')),
      el('div', { class: 'card' }, el('div', { class: 'row' }, lookSeg(ctx)))),
    el('div', { class: 'group' },
      el('p', { class: 'label' }, t('settings.phone')),
      el('div', { class: 'card' },
        el('a', { class: 'row row-link', href: '#/check', id: 'open-check' },
          el('span', { class: 'grow' }, t('settings.check')), glyph('chevron')))),
    el('div', { class: 'group' },
      el('p', { class: 'label' }, t('settings.about')),
      el('div', { class: 'card' },
        row(t('settings.version'), ctx.version, 'version'),
        row(t('settings.schema'), String(ctx.schema), 'schema'),
        row(t('settings.rules'), ctx.rulesVersion === 'none' ? t('settings.rules.none') : ctx.rulesVersion, 'rules'))),
    el('div', { class: 'group', id: 'danger-group' },
      el('p', { class: 'label' }, t('settings.group.danger')),
      el('button', { class: 'btn btn-danger', type: 'button', id: 'erase-open', on: { click: () => eraseFlow(ctx, false) } }, glyph('warn'), t('settings.erase'))));
  // A backup near the pick cap says so under Back up now; the share still runs (A4-1).
  ctx.backup.rebuild().then(() => {
    const n = ctx.backup.bytes;
    bigLine.hidden = !backupBig(n);
    if (!bigLine.hidden) bigLine.textContent = t('backup.big', { n: backupMB(n) });
  });
  paint();
  return screen;
}

// The one on/off switch skin (LOOK 4.9): the whole row is the switch, the word On or Off
// sits beside it, and one helper line goes under the row. The word changes only after the
// write commits; a write that fails says so and leaves the switch as it was.
export function switchRow(id, label, line, get, set) {
  const word = el('span', { class: 'small switch-word' });
  const btn = el('button', { class: 'row switch-row', type: 'button', role: 'switch', id, 'aria-checked': 'false', 'aria-describedby': id + '-line' },
    el('span', { class: 'grow' }, label), el('span', { class: 'switch', 'aria-hidden': 'true' }, el('span', { class: 'switch-knob' })), word);
  const paint = (on) => { btn.setAttribute('aria-checked', String(on)); word.textContent = t(on ? 'switch.on' : 'switch.off'); };
  paint(false);
  get().then(paint).catch(() => {});
  btn.addEventListener('click', async () => {
    const on = btn.getAttribute('aria-checked') !== 'true';
    try { await set(on); } catch (e) { toast(t('today.notsaved')); return; }
    paint(on);
  });
  return [btn, el('p', { class: 'small switch-line', id: id + '-line' }, line)];
}

function loggingRows(ctx) {
  const s = ctx.store;
  return [
    ...switchRow('carry-switch', t('carry.label'), t('carry.line'), async () => (await s.getSetting('carry_down', false)) === true, (on) => s.setSetting('carry_down', on)),
    // The rep range ask is on by default; "do not ask again" turns it off, this turns it back on (15 Part 8).
    ...switchRow('range-switch', t('range.setting'), t('range.setting.line'), async () => (await s.getSetting('rep_ask', true)) !== false, (on) => s.setSetting('rep_ask', on))
  ];
}

function unitsSeg(ctx) {
  const box = el('div', { class: 'grow' });
  ctx.store.getSetting('unit', 'lb').then((u) => {
    box.appendChild(seg([['lb', t('unit.lb')], ['kg', t('unit.kg')]], u, (k) => ctx.store.setSetting('unit', k), 'units'));
  });
  return box;
}

function lookSeg(ctx) {
  const box = el('div', { class: 'grow' });
  ctx.store.getSetting('theme', 'phone').then((th) => {
    box.appendChild(seg([['phone', t('look.phone')], ['light', t('look.light')], ['dark', t('look.dark')]], th,
      (k) => { applyTheme(k); ctx.store.setSetting('theme', k); }, 'look'));
  });
  return box;
}

// ---------------- restore and undo (DESIGN 5.3, 5.5) ----------------

// Run a whole-database job from a sheet. A failed job calls failed() and never done(),
// so the page is not reloaded and he sees the line that says nothing was changed. A job
// that worked calls done() once (R1).
export async function runJob(job, done, failed) {
  try {
    await job();
  } catch (e) {
    failed(e);
    return false;
  }
  done();
  return true;
}

function previewSheet(ctx, info, header, onGo) {
  const go = el('button', { class: 'btn btn-primary', type: 'button', id: 'restore-go' }, t('restore.go'));
  const cancel = el('button', { class: 'btn btn-quiet', type: 'button', id: 'restore-cancel' }, t('restore.cancel'));
  // The file next to the phone (DESIGN 5.3 Restore, C30): the file's numbers, then the phone's.
  const lines = [
    el('p', { id: 'restore-saved' }, t('restore.saved', { date: fmtWhen(header.exportedMs) })),
    header.appVersion ? el('p', { class: 'small' }, t('settings.version.line', { v: header.appVersion })) : null,
    el('p', { id: 'restore-blocks' }, t('restore.blocks', { n: info.blocks })),
    el('p', { id: 'restore-days' }, t('restore.days', { n: info.days })),
    el('p', { id: 'restore-sets' }, t('restore.sets', { n: info.sets })),
    info.last ? el('p', {}, t('restore.last', { date: info.last })) : null,
    info.phone ? el('p', { class: 'small', id: 'restore-phone' }, t('restore.phone', {
      blocks: tn('count.blocks', info.phone.blocks), days: tn('count.days', info.phone.days), sets: tn('count.sets', info.phone.sets) })) : null,
    info.newerOnPhone > 0 ? el('p', { class: 'inset inset-backup', id: 'restore-newer' }, t('restore.newer', { n: info.newerOnPhone })) : null
  ];
  // A scrim tap closes it only while nothing is typed (LOOK 3.3, review P19).
  const conf = typedConfirm(t('restore.type'), 'RESTORE', go);
  const sh = sheet({ id: 'restore-sheet', title: t('settings.restore'), canDismiss: () => untyped(conf) }, ...lines, conf, go, el('div', { class: 'quiet-row' }, cancel));
  cancel.addEventListener('click', () => sh.close());
  // The failed line stays inside the open sheet: an open sheet also holds back an update
  // reload, so nothing takes the line away before he reads it.
  const bad = el('p', { class: 'inset inset-backup', id: 'restore-failed', role: 'status', hidden: true }, t('restore.bad'));
  sh.panel.insertBefore(bad, go);
  go.addEventListener('click', async () => {
    go.disabled = true;
    await runJob(onGo, () => { ctx.wake.release(); ctx.reload(); }, () => {
      bad.hidden = false;
      go.disabled = false;
      toast(t('restore.bad'));
    });
  });
}

function refusal(code) {
  return code === 'toonew' ? t('restore.toonew') : code === 'old' ? t('block.old') : code === 'badref' ? t('block.badref') : t('restore.bad');
}

export function restoreFlow(ctx) {
  ctx.pickFile(LIMITS.MAX_PICK_BYTES).then(async (text) => {
    if (text === null) return;
    if (text.tooBig) { toast(t('file.toobig')); return; }
    const r = await ctx.store.readBackupFile(text);
    if (!r.ok) { toast(refusal(r.code)); return; }
    previewSheet(ctx, r.info, { exportedMs: r.exported_ms, appVersion: r.app_version }, () => ctx.store.restoreFile(text));
  });
}

async function undoList(ctx) {
  const snaps = await ctx.store.listSnapshots();
  const why = { 'before-restore': 'undo.restore', 'before-erase': 'undo.erase', 'before-upgrade': 'undo.upgrade', 'before-undo': 'undo.undo', 'before-reset': 'undo.reset' };
  let sh = null;
  sh = sheet({ id: 'undo-sheet', title: t('settings.undo') }, el('div', { class: 'card' }, snaps.map(s =>
    el('button', { class: 'menu-row', type: 'button', 'data-snap': s.id, on: { click: async () => {
      sh.close();
      const r = await ctx.store.readSnapshot(s.id);
      if (!r.ok) { toast(t('restore.bad')); return; }
      previewSheet(ctx, r.info, { exportedMs: Date.parse(r.exported_at), appVersion: '' }, () => ctx.store.undoSnapshot(s.id));
    } } }, el('span', { class: 'grow' }, fmtWhen(s.made_at)), el('span', { class: 'small' }, t(why[s.reason]))))));
}

// ---------------- erase (DESIGN 5.3 Erase all) ----------------

function eraseFlow(ctx, snapsOnly) {
  const go = el('button', { class: 'btn btn-danger', type: 'button', id: snapsOnly ? 'erase-snaps-go' : 'erase-go' }, glyph('warn'), t(snapsOnly ? 'erase.snaps' : 'settings.erase'));
  const parts = [];
  if (!snapsOnly) parts.push(el('button', { class: 'btn btn-secondary', type: 'button', id: 'erase-backup', on: { click: () => ctx.backup.share(document.getElementById('erase-backup'), () => {}) } }, t('erase.first')));
  const conf = typedConfirm(t('erase.type'), 'ERASE', go);
  parts.push(conf, go);
  if (!snapsOnly) parts.push(el('p', { class: 'small' }, t('erase.kept')));
  const more = snapsOnly ? null : el('button', { class: 'btn btn-quiet', type: 'button', id: 'erase-snaps' }, t('erase.snaps'));
  if (more) parts.push(el('div', { class: 'quiet-row' }, more));
  // A scrim tap closes it only while nothing is typed (LOOK 3.3, review P19).
  const sh = sheet({ id: snapsOnly ? 'erase-snaps-sheet' : 'erase-sheet', title: t(snapsOnly ? 'erase.snaps' : 'settings.erase'), canDismiss: () => untyped(conf) }, ...parts);
  if (!snapsOnly) ctx.backup.bind(document.getElementById('erase-backup'));
  if (more) more.addEventListener('click', () => { sh.close(); eraseFlow(ctx, true); });
  go.addEventListener('click', async () => {
    go.disabled = true;
    const failed = () => { go.disabled = false; toast(t('today.notsaved')); };
    if (snapsOnly) { await runJob(() => ctx.store.clearSnapshots(), () => { sh.close(); ctx.render(); }, failed); return; }
    await runJob(() => ctx.store.eraseAll(), () => { ctx.wake.release(); ctx.reload(); }, failed);
  });
}

// ---------------- block files (DESIGN 5.3 Load a block file) ----------------

export function loadBlockFlow(ctx) {
  ctx.pickFile(LIMITS.MAX_BLOCK_BYTES).then(async (text) => {
    if (text === null) return;
    // file.toobig names the 64 MB restore cap; a block file has its own smaller cap, so it
    // gets the line that stays true for it.
    if (text.tooBig) { toast(t('restore.bad')); return; }
    const r = await ctx.store.readBlockFile(text);
    if (!r.ok) { toast(refusal(r.code)); return; }
    const exMap = await ctx.store.exercisesMap();
    const local = new Map(r.exercises.map(e => [e.id, e.name]));
    const nameOf = (id) => local.get(id) || (exMap.get(id) || { name: id }).name;
    const lines = [el('p', { class: 'q-text', id: 'block-preview-name' }, r.block.name),
      el('p', { class: 'small' }, r.block.passes === null ? t('today.round', { r: 1 }) : t('today.round.of', { r: 1, n: r.block.passes }))];
    for (const d of r.block.day_templates) {
      lines.push(el('p', { 'data-preview-day': d.label }, t('builder.dayline', { label: d.label, lifts: d.lifts.map(l => tn('builder.liftsets', l.sets, { name: nameOf(l.exercise_id) })).join(', ') })));
    }
    // '165 lb to 150 lb', and a missing load says none, never the word null (C26).
    const unit = t(r.block.unit === 'kg' ? 'unit.kg' : 'unit.lb');
    const loadWord = (x) => (x === null || x === undefined) ? t('block.none') : t('block.load', { n: x, unit });
    for (const c of (r.changes || [])) {
      lines.push(el('p', { class: 'small', 'data-change': c.kind }, c.kind === 'newex' ? t('block.newex', { name: c.name }) : t('block.change', { name: c.name, from: loadWord(c.from), to: loadWord(c.to) })));
    }
    for (const label of (r.keepDraft || [])) lines.push(el('p', { class: 'small' }, t('block.keepdraft', { label })));
    const save = el('button', { class: 'btn btn-primary', type: 'button', id: 'block-file-save' }, t('block.save'));
    const cancel = el('button', { class: 'btn btn-quiet', type: 'button', id: 'block-file-cancel' }, t('block.cancel'));
    const sh = sheet({ id: 'block-sheet', title: t('settings.load') }, ...lines, save, el('div', { class: 'quiet-row' }, cancel));
    cancel.addEventListener('click', () => sh.close());
    save.addEventListener('click', async () => {
      sh.close();
      const finish = async (activate) => {
        try { await ctx.store.importBlock(text, activate); } catch (e) { toast(refusal(e.code)); return; }
        // Load a block file never touches an unsaved build (15 Part 4).
        ctx.go('#/today');
      };
      if (!r.otherActive) return finish(true);
      const yes = el('button', { class: 'btn btn-primary', type: 'button', id: 'switch-yes' }, t('fb.yes'));
      const no = el('button', { class: 'btn btn-quiet', type: 'button', id: 'switch-no' }, t('fb.no'));
      const s2 = sheet({ id: 'switch-sheet', title: t('block.switch') }, yes, el('div', { class: 'quiet-row' }, no));
      yes.addEventListener('click', () => { s2.close(); finish(true); });
      no.addEventListener('click', () => { s2.close(); finish(false); });
      return undefined;
    });
  });
}
