// mutants.js - planted defects (DESIGN 4.6, 5.8).
// (1) Baseline: every check runs on a clean copy first and must pass, or the run stops with ERROR.
// (2) Each row copies the git file list into its own folder under the copy base (never inside
//     app/), makes it a git repo with a baseline commit, plants one defect (left uncommitted)
//     and runs one check.
// (3) CAUGHT only if the check fails AND a failing line names the row's expected test.
// (4) Any other failure is ERROR, never caught. A find text that does not match exactly once
//     is ERROR. ERROR fails the run.
// Guard rows read their planted term from the private lists at run time, so no term is here.
// Run: node scripts/tests/mutants.js
// Importing this file runs nothing: it exports ROWS, CMD and apply for a scratch prover and for the
// static test that checks every find text matches its file exactly once (r4.3 H14).
import { copyFileSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAIN = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

// Mac load rule (DESIGN 4.6 rule 3): nothing heavy between 1:00 and 6:00 AM (C20).
const HOUR = new Date().getHours();
if (MAIN && HOUR >= 1 && HOUR < 6) { console.log('Mac quiet hours (1:00 to 6:00 AM). Not run.'); process.exit(3); }

export const CMD = {
  static: ['node', ['--test', 'scripts/tests/unit/static.test.js']],
  guard: ['node', ['scripts/tests/repo_guard.js']],
  guard_self: ['node', ['scripts/tests/repo_guard.js', '--self-test']],
  e2e_slice0: ['python3', ['scripts/tests/e2e.py', '--suite', 'slice0', '--viewport', '440']],
  e2e_update: ['python3', ['scripts/tests/e2e.py', '--suite', 'update']],
  unit_backup: ['node', ['--test', 'scripts/tests/unit/backup.test.js']],
  unit_migrate: ['node', ['--test', 'scripts/tests/unit/migrate.test.js']],
  unit_store: ['node', ['--test', 'scripts/tests/unit/store.test.js']],
  unit_rules: ['node', ['--test', 'scripts/tests/unit/rules.test.js']],
  unit_engine: ['node', ['--test', 'scripts/tests/unit/engine.test.js']],
  e2e_slice1_log: ['python3', ['scripts/tests/e2e.py', '--suite', 'slice1', '--viewport', '440', '--part', 'log']],
  e2e_slice1_share: ['python3', ['scripts/tests/e2e.py', '--suite', 'slice1', '--viewport', '440', '--part', 'share']],
  e2e_slice1_wake: ['python3', ['scripts/tests/e2e.py', '--suite', 'slice1', '--viewport', '440', '--part', 'wake']],
  e2e_slice1_data: ['python3', ['scripts/tests/e2e.py', '--suite', 'slice1', '--viewport', '440', '--part', 'data']],
  e2e_slice1_polish: ['python3', ['scripts/tests/e2e.py', '--suite', 'slice1', '--viewport', '440', '--part', 'polish']],
  unit_today: ['node', ['--test', 'scripts/tests/unit/today.test.js']],
  e2e_slice2: ['python3', ['scripts/tests/e2e.py', '--suite', 'slice2', '--viewport', '440']],
  e2e_upgrade: ['python3', ['scripts/tests/e2e.py', '--suite', 'upgrade']],
  // Slice 3 (17 C.4)
  unit_stats: ['node', ['--test', 'scripts/tests/unit/stats.test.js']],
  unit_templates: ['node', ['--test', 'scripts/tests/unit/templates.test.js']],
  e2e_slice3: ['python3', ['scripts/tests/e2e.py', '--suite', 'slice3', '--viewport', '440']],
  e2e_slice3_look041: ['python3', ['scripts/tests/e2e.py', '--suite', 'slice3', '--viewport', '440', '--part', 'look041']]
};

function listTerm(file, test) {
  const dir = process.env.LIFTLOG_PRIVATE_DIR;
  const lines = readFileSync(join(dir, file), 'utf8').split('\n').map(x => x.trim()).filter(x => x && !x.startsWith('#'));
  const hit = lines.find(test);
  if (!hit) throw new Error('no usable term in ' + file);
  return hit;
}

const RETRY = `  try {
    return await fn(conn);
  } catch (e) {
    if (!isDeadLink(e)) throw e;
    if (_db === conn) _db = null;
    _stats.retries++;
    return await fn(await open());
  }`;

const INSTALL_ALL = `    const got = await Promise.all(SHELL.map(async (u) => {`;
const INSTALL_SETTLED = `    const settled = await Promise.allSettled(SHELL.map(async (u) => {`;
const INSTALL_END = `      return [u, new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })];
    }));`;

export const ROWS = [
  { id: 'M9b', what: 'try/catch and t.abort() removed from replaceAll', cmd: 'e2e_slice0', expect: '(8) replaceAll with a row missing its id',
    edits: [{ file: 'db.js', find: '      try {\n        fill();\n      } catch (e) {\n        fail(e);\n      }\n', replace: '      fill();\n' }] },
  { id: 'M9c', what: 'replaceAll uses one transaction per store', cmd: 'e2e_slice0', expect: '(8) replaceAll with',
    edits: [{ file: 'db.js', find: '  async replaceAll(data, counts) {\n    data = data || {};\n',
      replace: '  async replaceAll(data, counts) {\n    data = data || {};\n    for (const n of DATA_STORES) await write(n, (os) => { os.clear(); for (const row of (data[n] || [])) os.put(row); });\n    if (data) return true;\n' }] },
  { id: 'M10', what: 'engine.js dropped from SHELL (16 B.13: M10 plants on engine.js from Slice 2)', cmd: 'static', expect: 'SHELL equals the git shell list',
    edits: [{ file: 'sw.js', find: "  'engine.js',\n", replace: '' }] },
  { id: 'M10b', what: 'new ui/extra.js imported by app.js, not in SHELL', cmd: 'static', expect: 'SHELL equals the git shell list',
    create: { 'ui/extra.js': 'export const extra = 1;\n' },
    edits: [{ file: 'app.js', find: "import { renderToday, renderDayDone } from './ui/today.js';\n", replace: "import { renderToday, renderDayDone } from './ui/today.js';\nimport './ui/extra.js';\n" }] },
  { id: 'M11s', what: 'activate filter without the liftlog- prefix', cmd: 'static', expect: 'activate deletes only our own caches',
    edits: [{ file: 'sw.js', find: "k.startsWith('liftlog-') && k !== CACHE", replace: 'k !== CACHE' }] },
  { id: 'M11e', what: 'activate filter without the liftlog- prefix', cmd: 'e2e_update', expect: 'artic-test kept',
    edits: [{ file: 'sw.js', find: "k.startsWith('liftlog-') && k !== CACHE", replace: 'k !== CACHE' }] },
  { id: 'M13a', what: 'the close event listener removed from db.js', cmd: 'e2e_slice0', expect: '(7b) simulateDrop',
    edits: [{ file: 'db.js', find: "      conn.addEventListener('close', () => { if (_db === conn) { _db = null; try { conn.close(); } catch (_) { /* gone */ } } });\n", replace: '' }] },
  { id: 'M13b', what: 'the error retry removed from db.js', cmd: 'e2e_slice0', expect: '(7a) closeForTest',
    edits: [{ file: 'db.js', find: RETRY, replace: '  return await fn(conn);' }] },
  { id: 'M14s', what: 'outside address added to app.js as plain text', cmd: 'static', expect: 'no outside address',
    edits: [{ file: 'app.js', find: '\nboot();\n', replace: "\nfetch('https://example.com').catch(() => {});\nboot();\n" }] },
  { id: 'M14e', what: 'outside address added to app.js as plain text', cmd: 'e2e_slice0', expect: 'zero console errors',
    edits: [{ file: 'app.js', find: '\nboot();\n', replace: "\nfetch('https://example.com').catch(() => {});\nboot();\n" }] },
  { id: 'M14b', what: 'CSP meta deleted and a fetch to an address built from parts', cmd: 'e2e_slice0', expect: 'network audit',
    edits: [
      { file: 'index.html', find: /<meta http-equiv="Content-Security-Policy"[^\n]*\n/, replace: '' },
      { file: 'app.js', find: '\nboot();\n', replace: "\nfetch(['http:', '', '127.0.0.2:8899'].join('/')).catch(() => {});\nboot();\n" }] },
  { id: 'M19', what: 'one character changed in ui/settings.js, sw.js left alone', cmd: 'static', expect: 'SHELL_HASH matches',
    edits: [{ file: 'ui/settings.js', find: 'Everything read from a file is shown', replace: 'Everything read from a file is shewn' }] },
  { id: 'M19b', what: 'one character changed in the sw.js fetch handler', cmd: 'static', expect: 'SHELL_HASH matches',
    edits: [{ file: 'sw.js', find: 'if (url.origin !== self.location.origin) return;', replace: 'if (url.origin != self.location.origin) return;' }] },
  { id: 'M23', what: 'install uses Promise.allSettled and caches whatever loaded', cmd: 'e2e_update', expect: 'case 2: no worker waiting',
    edits: [
      { file: 'sw.js', find: INSTALL_ALL, replace: INSTALL_SETTLED },
      { file: 'sw.js', find: INSTALL_END, replace: INSTALL_END + "\n    const got = settled.filter(s => s.status === 'fulfilled').map(s => s.value);" }] },
  { id: 'M25', what: 'one banned term (from the private list) as a comment in app.js', cmd: 'guard', expect: 'banned word',
    edits: [{ file: 'app.js', find: '\nboot();\n', replace: () => '\n// ' + listTerm('banned_words.txt', w => /^[A-Za-z][A-Za-z ]+$/.test(w)) + '\nboot();\n' }] },
  { id: 'M26', what: 'one personal word (from the private list) added to ui/strings.js', cmd: 'guard', expect: 'personal word',
    edits: [{ file: 'ui/strings.js', find: "  'install.title': 'Lift Log',\n", replace: () => "  'install.title': 'Lift Log',\n  'install.extra': 'Mind your " + listTerm('personal_words.txt', w => /^[A-Za-z]+$/.test(w)) + "',\n" }] },
  { id: 'S7', what: 'a copy of the SVG namespace address in app.js', cmd: 'static', expect: 'no outside address',
    edits: [{ file: 'app.js', find: '\nboot();\n', replace: "\nconst NS2 = 'http://www.w3.org/2000/svg';\nboot();\n" }] },
  { id: 'S5', what: 'a literal screen string in ui/settings.js', cmd: 'static', expect: 'no literal screen string',
    edits: [{ file: 'ui/settings.js', find: "el('h1', {}, t('settings.title')),", replace: "el('h1', {}, 'Settings here')," }] },
  { id: 'S16', what: 'a CSP that allows any image source', cmd: 'static', expect: 'exact head',
    edits: [{ file: 'index.html', find: "img-src 'self';", replace: "img-src 'self' blob: data:;" }] },
  // ---------------- Slice 1 rows (DESIGN 5.8) ----------------
  { id: 'M7', what: 'migrate drops feedback', cmd: 'unit_migrate', expect: 'migrate keeps every store',
    edits: [{ file: 'backup.js', find: '  for (const s of STORE_NAMES) out[s] = d[s];', replace: "  for (const s of STORE_NAMES) if (s !== 'feedback') out[s] = d[s];" }] },
  { id: 'M8', what: 'schema check uses <= against current plus 1', cmd: 'unit_backup', expect: 'newer schema refused',
    edits: [{ file: 'backup.js', find: "  if (!(f.schema <= SCHEMA)) throw new BadFile('newer schema', 'toonew');\n  if (!isObj(f.counts)", replace: "  if (!(f.schema <= SCHEMA + 1)) throw new BadFile('newer schema', 'toonew');\n  if (!isObj(f.counts)" }] },
  { id: 'M9', what: 'restore clears before it validates', cmd: 'unit_store', expect: 'restore of an invalid file is refused',
    edits: [{ file: 'store.js', find: "  async function restoreFile(text) {\n", replace: "  async function restoreFile(text) {\n    await db.replaceAll(Object.fromEntries(STORE_NAMES.map(s => [s, []])), Object.fromEntries(STORE_NAMES.map(s => [s, 0])));\n" }] },
  { id: 'M12', what: 'a set tick kept in memory, not written', cmd: 'unit_store', expect: 'a new store instance on the same db sees every tick',
    edits: [{ file: 'store.js', find: '      return batch(tickOps);', replace: '      changed(); return undefined;' }] },
  { id: 'M12b', what: 'row shown Done before the write completes', cmd: 'e2e_slice1_log', expect: 'never shows Done',
    edits: [{ file: 'ui/today.js', find: "    rowState.set(s.id, 'saving');", replace: "    rowState.set(s.id, 'done');" }] },
  ...[['reps_left', 'reps_left: d ? d.reps_left : null, '], ['reps_left_plus', 'reps_left_plus: d ? d.reps_left_plus : null,'],
    ['count_label', 'count_label: x.target.count_label || (e ? e.count_label : null),'], ['load_basis', ' load_basis: x.target.load_basis,'],
    ['reps_left_target', 'reps_left_target: x.target.reps_left_target, '], ['set_id', '    row.set_id = x.id;\n'],
    ['saved_at', '    row.saved_at = x.saved_at === null ? null : isoLocal(x.saved_at);\n'], ['date', 'date: day.done_date, '],
    ['breaks', ', breaks: d ? d.breaks : null']].map(([f, find]) => ({
    id: 'M15-' + f, what: 'flat_log row drops ' + f, cmd: 'unit_backup', expect: 'every flat_log row has every field',
    edits: [{ file: 'backup.js', find, replace: '' }] })),
  // 16 B.6.4, 17 C.0.2 (R4-26): one row per schema 2 flat_log column.
  ...['set_type', 'why', 'goal_load', 'goal_reps_low', 'goal_reps_high', 'goal_failure_set', 'met', 'exercise_id', 'done_at',
    'short_sleep_since_last', 'body_weight', 'profile'].map((f) => ({
    id: 'M15-' + f, what: 'flat_log row drops the schema 2 column ' + f, cmd: 'unit_backup', expect: 'every flat_log row has every field',
    edits: [{ file: 'backup.js', find: new RegExp('\\n    row\\.' + f + ' = [^\\n]*;'), replace: '' }] })),
  { id: 'M15b', what: 'the allow table drops flags_set from exercises rows', cmd: 'unit_backup', expect: 'flags_set is required',
    edits: [{ file: 'backup.js', find: 'flags_set: c.bool, link: c.link', replace: 'link: c.link' }] },
  { id: 'M16', what: 're-plan writes over a set that is not planned with done and draft null', cmd: 'unit_store', expect: 're-plan never writes over',
    edits: [{ file: 'store.js', find: "  const writable = (s) => s.status === 'planned' && s.done === null && s.draft === null;", replace: '  const writable = (s) => true;' }] },
  { id: 'M17', what: 'restore does not reset the backup marker', cmd: 'unit_store', expect: 'the backup badge follows',
    edits: [{ file: 'store.js', find: '      return replaceWith(data, v.exported_ms, job);', replace: "      return replaceWith(data, await db.setting('last_backup_at', null), job);" }] },
  { id: 'M17b', what: 'undo sets the marker to the copy exported_at', cmd: 'unit_store', expect: 'undo keeps the badge honest',
    edits: [{ file: 'store.js', find: '      return replaceWith(r.stores, r.snap.last_backup_at_then, job);', replace: '      return replaceWith(r.stores, Date.parse(r.exported_at), job);' }] },
  { id: 'M18', what: 'backup marker set before navigator.share resolves', cmd: 'e2e_slice1_share', expect: 'AbortError leaves the marker',
    edits: [{ file: 'app.js', find: '      navigator.share(data).then(async () => {\n', replace: '      store.markBackedUp(ms);\n      navigator.share(data).then(async () => {\n' }] },
  { id: 'M20', what: 'swap reuses the old slot', cmd: 'unit_store', expect: 'swap after a done set',
    edits: [{ file: 'store.js', find: '    const topSlot = maxOf([...used]);\n    let newSlot = (topSlot !== null && topSlot > 0 ? topSlot : 0) + 1;\n    while (used.has(newSlot)) newSlot++;', replace: '    let newSlot = slot;' }] },
  { id: 'M21', what: 'a validator text limit lower than the input limit', cmd: 'static', expect: 'every input maxlength is a LIMITS constant',
    edits: [{ file: 'backup.js', find: 'name: c.text(L.NAME, 1)', replace: 'name: c.text(L.NAME - 1, 1)' }] },
  { id: 'M22', what: 'the keep-awake release listener removed', cmd: 'e2e_slice1_wake', expect: 'wake case 1',
    edits: [{ file: 'app.js', find: "      l.addEventListener('release', () => { if (this.lock === l) this.lock = null; });\n", replace: '' }] },
  ...['unit_store', 'static'].map((cmd) => ({ id: 'M24' + (cmd === 'static' ? 's' : ''), what: 'done_date built from toISOString()', cmd,
    expect: cmd === 'static' ? 'no UTC date cutting' : 'done_date is the local date',
    edits: [{ file: 'store.js', find: "  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');",
      replace: '  return new Date(ms).toISOString().slice(0, 10);' }] })),
  // ---------------- review fix rows (2026-11-09, one per fixed finding) ----------------
  { id: 'R1', what: 'undo skips the safety copy of the current data (C1)', cmd: 'unit_store', expect: 'undo saves a safety copy',
    edits: [{ file: 'store.js', find: "      await snapshotNow('before-undo', job);\n", replace: '' }] },
  { id: 'R2', what: 'Finish day allowed on a day he never started (C34)', cmd: 'unit_store', expect: 'Finish day is refused on a day he never started',
    edits: [{ file: 'store.js', find: "  if (day.status === 'open') return true;", replace: "  if (day.status !== 'done') return true;" }] },
  { id: 'R3', what: 'the write queue removed (C15)', cmd: 'unit_store', expect: 'two quick drafts land in tap order',
    edits: [{ file: 'store.js', find: '    const next = Promise.all([prev.catch(() => {}), held.catch(() => {})]).then(() => attempt(fn));', replace: '    void held;\n    const next = attempt(fn);' }] },
  { id: 'R4', what: 'set writes queued per set, not per day (C3, C37)', cmd: 'unit_store', expect: 'queued behind a slow tick never undoes it',
    edits: [{ file: 'store.js', find: "  const setKey = (setId) => { const m = SET_DAY_RE.exec(String(setId)); return dayKey(m ? m[1] : String(setId).split(':x')[0]); };", replace: "  const setKey = (setId) => 'set:' + setId;" }] },
  { id: 'R5', what: 're-plan writes over a set he added (C4)', cmd: 'unit_store', expect: 're-plan never writes over a set he added',
    edits: [{ file: 'store.js', find: "if (was && (!writable(was) || was.origin === 'added' || was.set_type_by_hand === true)) continue;", replace: "if (was && (!writable(was) || was.set_type_by_hand === true)) continue;" },
      // From 0.3.0 a plan row whose id he holds takes another id first, and his rows are put again
      // after the plan rows with their new set_n (R15), so each of those alone hides the defect:
      // it drops all three.
      { file: 'store.js', find: "        if (held && held.origin === 'added') {", replace: '        if (false) {' },
      { file: 'store.js', find: "          if (s.set_n !== to) ops.push({ store: 'sets', put: { ...s, set_n: to } });\n", replace: '' }] },
  { id: 'R6', what: 'Last time picks the day by done_at (C13)', cmd: 'unit_store', expect: 'lastTime: the latest earlier done day by position wins',
    edits: [{ file: 'store.js', find: '      if (!best || before(bestPos, p)) { best = d; bestPos = p; }', replace: '      if (!best || d.done_at > best.done_at) { best = d; bestPos = p; }' }] },
  { id: 'R7', what: 'backup time read after the rows (C2)', cmd: 'unit_store', expect: 'a backup reads every store at once',
    edits: [{ file: 'store.js', find: '    const t = now();\n    const data = await readAll();', replace: '    const data = await readAll();\n    const t = now();' }] },
  { id: 'R8', what: 'ids named __proto__ or constructor let through (C9)', cmd: 'unit_backup', expect: '__proto__ or constructor is refused',
    edits: [{ file: 'backup.js', find: '&& ID_RE.test(v) && !reserved(v))', replace: '&& ID_RE.test(v))' }] },
  { id: 'R9', what: 'the helper line added only when it has text (C23)', cmd: 'e2e_slice1_polish', expect: 'polish: C23 a refused number on a row with an empty helper line still shows the number line',
    edits: [{ file: 'ui/today.js', find: '  row.appendChild(helper);', replace: '  if (helper.textContent) row.appendChild(helper);' }] },
  { id: 'R10', what: 'the update busy check forgets the builder (C5)', cmd: 'e2e_update', expect: 'busy case (builder)',
    edits: [{ file: 'app.js', find: "hasDraft(ctx.build) || !!ctx.picker || r === '#/builder' || r === '#/picker' ||\n    ", replace: '' }] },
  { id: 'R11', what: 'restore writes nothing to the real database (C12)', cmd: 'e2e_slice1_data', expect: 'Restore an older file',
    edits: [{ file: 'store.js', find: '    await job.write(() => db.replaceAll(data, counts));\n    return rows;', replace: '    void data;\n    return rows;' }] },
  { id: 'R12', what: 'an input uses another field limit than its validator (C17)', cmd: 'static', expect: 'each one matches its own validator field',
    edits: [{ file: 'ui/today.js', find: "maxlength: String(LIMITS.NOTE), id: 'fb-note'", replace: "maxlength: String(LIMITS.STR), id: 'fb-note'" }] },
  // ---------------- slice 1 leftovers (2026-11-09 night): R1, R3, R4 and the R6 guards ----------------
  { id: 'R13', what: 'a failed restore still reloads the page (R1)', cmd: 'static', expect: 'a failed restore shows its line and never reloads',
    edits: [{ file: 'ui/settings.js', find: '    failed(e);\n    return false;\n', replace: '    failed(e);\n' }] },
  { id: 'R14', what: 'a restore does not wait for the day queues to drain (R3)', cmd: 'unit_store', expect: 'no old row lands on the restored data',
    edits: [{ file: 'store.js', find: '    const run = drain.then(() => new Promise((resolve, reject) => {', replace: '    void drain;\n    const run = Promise.resolve().then(() => new Promise((resolve, reject) => {' }] },
  { id: 'R15', what: 'the Finish day check read outside the day queue (R4)', cmd: 'unit_store', expect: 'Finish day tapped while the first tick of the day is still saving',
    edits: [{ file: 'store.js', find: '  function finishDay(dId, scores) {\n    return exclusive(async (job) => {\n', replace: "  function finishDay(dId, scores) {\n    return (async () => {\n      const day0 = await db.get('days', dId);\n      if (!finishable(day0, day0 ? await db.byIndex('sets', 'day_id', dId) : [])) throw new Refused('day is not open');\n      return finishInside(dId, scores);\n    })();\n  }\n  function finishInside(dId, scores) {\n    return exclusive(async (job) => {\n" }] },
  { id: 'G7', what: 'the update reload no longer waits for writes (C7)', cmd: 'static', expect: 'an update reload waits for writes still in flight',
    edits: [{ file: 'app.js', find: '    await Promise.race([store.idle(), new Promise((res) => setTimeout(res, 10000))]);\n', replace: '' }] },
  { id: 'G6', what: 'the share flag is never set (C6)', cmd: 'static', expect: 'a share in progress counts as busy',
    edits: [{ file: 'app.js', find: '    this.sharing = true;\n', replace: '' }] },
  { id: 'G24', what: 'the rep fields swap their labels (C24)', cmd: 'static', expect: 'every builder number field is named by its own column label',
    edits: [{ file: 'ui/builder.js', find: 'rep_low: heads[1], rep_high: heads[2]', replace: 'rep_low: heads[2], rep_high: heads[1]' }] },
  { id: 'G27', what: 'a finished block shows No block (C27)', cmd: 'static', expect: 'a block whose last day is done shows the Block finished state',
    edits: [{ file: 'ui/today.js', find: "block && block.status === 'done' ? blockDone(ctx, block) : noBlock(ctx)", replace: 'noBlock(ctx)' }] },
  { id: 'G28', what: 'the No pill goes back to the danger color (C28)', cmd: 'static', expect: 'the No pill is grey with dark text',
    edits: [{ file: 'styles.css', find: '.pill-no{background:var(--surface-2); color:var(--ink);', replace: '.pill-no{background:var(--danger); color:var(--surface);' }] },
  { id: 'G32', what: 'a reorder past the end still moves and redraws (C32)', cmd: 'static', expect: 'reorder buttons move a lift up and down',
    edits: [{ file: 'ui/builder.js', find: '  if (j < 0 || j >= d.lifts.length) return;\n', replace: '' }] },
  { id: 'G39', what: 'a scrim tap closes the feedback sheet (C39)', cmd: 'static', expect: 'the feedback sheet never closes on a scrim tap',
    edits: [{ file: 'ui/today.js', find: "sub: t('fb.sub', { n }),\n      canDismiss: () => false, onClose", replace: "sub: t('fb.sub', { n }),\n      onClose" }] },
  { id: 'G41', what: 'the start weight steps ignore the exercise steps (C41)', cmd: 'static', expect: 'the start weight steps move along the exercise own steps',
    edits: [{ file: 'ui/today.js', find: '  if (ex && Array.isArray(ex.weight_steps) && ex.weight_steps.length) return { list:', replace: '  if (false) return { list:' }] },
  // ---------------- Slice 1 polish pass, step 0 (DESIGN 15 P.1, 14.4; PD numbers per 5.8) ----------------
  { id: 'PD6', what: 'one frozen id dropped from the exercise list', cmd: 'static', expect: 'the 39 seed rows are frozen',
    edits: [{ file: 'data/exercises.js', find: "  row('hip_adduction', 'Hip in (machine)', 'legs', 'machine'),\n", replace: '' }] },
  { id: 'PD4', what: 'a muscle value with no data word (R4-09)', cmd: 'static', expect: 'every muscle and equipment value has a data word',
    edits: [{ file: 'data/exercises.js', find: ", core: 'Core' });", replace: ' });' }] },
  { id: 'PD71', what: 'the list upsert drops a phone note (17 C.2.6)', cmd: 'unit_store', expect: 'the list upsert keeps a phone note and link',
    edits: [{ file: 'store.js', find: "put: { ...r, notes: old ? old.notes : r.notes, link: old ? old.link : r.link } });", replace: 'put: { ...r } });' }] },
  { id: 'PD72', what: 'a note marks a list row edited (17 C.2.6)', cmd: 'unit_store', expect: 'the list upsert keeps a phone note and link',
    edits: [{ file: 'store.js', find: '      row = { ...ex, [field]: value };', replace: '      row = { ...ex, [field]: value, edited: ex.custom ? ex.edited : true };' }] },
  { id: 'PD73', what: 'a Smith machine row marked a machine seat (R4-07)', cmd: 'static', expect: 'a Smith machine row is never a machine seat',
    edits: [{ file: 'data/exercises.js', find: "'Decline Smith machine press', 'chest', 'machine', { machine: false, flags_set: false,", replace: "'Decline Smith machine press', 'chest', 'machine', { flags_set: false," }] },
  { id: 'PD1', what: 'the rep range pair check removed (A1-1)', cmd: 'unit_backup', expect: 'rep range pair rule',
    edits: [{ file: 'backup.js', find: '  if (low === null) return high === null;\n  return high === null || low <= high;', replace: '  return true;' }] },
  { id: 'PD49', what: 'an open top refused by validateBlock (R4-05)', cmd: 'unit_backup', expect: 'open top rep range accepted and kept',
    edits: [{ file: 'backup.js', find: '  return high === null || low <= high;', replace: '  return high !== null && low <= high;' }] },
  { id: 'PD5', what: 'swap appends the new slot (A1-5)', cmd: 'unit_store', expect: 'swap the second of three exercises',
    edits: [{ file: 'store.js', find: 'slotsInOrder(day, all).map(sl => (sl === slot ? newSlot : sl))', replace: 'slotsInOrder(day, all).concat([newSlot])' }] },
  { id: 'PD7', what: 'the lift cap removed (A2-5)', cmd: 'unit_backup', expect: 'block caps',
    edits: [{ file: 'backup.js', find: 'lifts: c.arr(L.LIFTS_PER_DAY, lift)', replace: 'lifts: c.arr(L.SET_N_MAX, lift)' }] },
  { id: 'PD8', what: 'the work-set filter removed from Last time (A2-8)', cmd: 'unit_store', expect: 'Last time shows the done work sets only',
    edits: [{ file: 'store.js', find: ".filter(s => s.done !== null && s.kind === 'work');", replace: '.filter(s => s.done !== null);' }] },
  { id: 'PD11', what: 'setSetting straight to the db (A3-R3)', cmd: 'unit_store', expect: 'whole-database writes and setSetting get the 4 s limit',
    edits: [{ file: 'store.js', find: "  const setSetting = async (k, v) => { await queued('setting:' + k, () => db.setSetting(k, v)); };", replace: '  const setSetting = async (k, v) => { await db.setSetting(k, v); };' }] },
  { id: 'PD21', what: 'the restore note written outside the restore transaction (A3-R8)', cmd: 'unit_store', expect: 'a failed restore leaves no note',
    edits: [{ file: 'store.js', find: "    settings.push({ key: 'restore_note', value: { rows, at: now() } });", replace: "    await db.setSetting('restore_note', { rows, at: now() });" }] },
  { id: 'PD74', what: 'an unknown settings key refuses the file again (15 settings rule)', cmd: 'unit_backup', expect: 'unknown settings key dropped',
    edits: [{ file: 'backup.js', find: '  if (!SETTING_KEYS.includes(v.key)) return null;', replace: "  if (!SETTING_KEYS.includes(v.key)) bad(w + ': unknown key');" }] },
  { id: 'PD75', what: 'restore_note taken from a file (A3-R8)', cmd: 'unit_backup', expect: 'restore_note never taken from a file',
    edits: [{ file: 'backup.js', find: '  if (!SETTING_KEYS.includes(v.key)) return null;', replace: "  if (!SETTING_KEYS.includes(v.key)) return v.key === 'restore_note' ? { key: v.key, value: v.value } : null;" }] },
  { id: 'PD76', what: 'a safety copy reason no longer checked (A2-10)', cmd: 'unit_backup', expect: 'safety copy reasons',
    edits: [{ file: 'backup.js', find: "  c.oneOf(SNAPSHOT_REASONS)(row.reason, 'snapshot.reason');\n", replace: '' }] },
  { id: 'PD77', what: 'check lifts not rewritten through the id map (R13)', cmd: 'unit_store', expect: 'a block check asked on some lifts names them by phone id',
    edits: [{ file: 'store.js', find: '    for (const ck of out.checks) if (Array.isArray(ck.lifts)) ck.lifts = ck.lifts.map(map);\n', replace: '' }] },
  { id: 'PD78', what: 'effectiveExercise ignores the block machine flag (R4-04)', cmd: 'unit_store', expect: 'effectiveExercise',
    edits: [{ file: 'store.js', find: "for (const k of ['no_added_sets', 'left_out_of_builder', 'machine'])", replace: "for (const k of ['no_added_sets', 'left_out_of_builder'])" }] },
  { id: 'PD79', what: 'a backup check may name any exercise (R13)', cmd: 'unit_backup', expect: 'a backup check may name a seed id',
    edits: [{ file: 'backup.js', find: "      if (!seedIds.has(id) && !ex.has(id) && !mapped.has(id)) bad('blocks: a check names a missing exercise');\n", replace: '' }] },
  { id: 'PD80', what: 'a card order may name a slot with no set (A1-5)', cmd: 'unit_backup', expect: 'a day card order',
    edits: [{ file: 'backup.js', find: "    for (const sl of (d.slot_order || [])) if (!(slotsOf.get(d.id) || new Set()).has(sl)) bad('days: card order names a slot with no set');\n", replace: '' }] },
  { id: 'PD81', what: 'Restore picks with the validator bound again (A3-R2)', cmd: 'static', expect: 'a restore pick is capped at MAX_PICK_BYTES',
    edits: [{ file: 'ui/settings.js', find: '  ctx.pickFile(LIMITS.MAX_PICK_BYTES).then(async (text) => {', replace: '  ctx.pickFile(LIMITS.MAX_RAW_BYTES).then(async (text) => {' }] },
  { id: 'PD2', what: 'the tick aria-label dropped (A1-3)', cmd: 'static', expect: 'the set tick has a name in every state',
    edits: [{ file: 'ui/today.js', find: "'aria-pressed': String(s.status === 'done'), 'aria-label': tickName },", replace: "'aria-pressed': String(s.status === 'done') }," }] },
  { id: 'PD3', what: 'aria-hidden put back on the tally (A1-3)', cmd: 'static', expect: 'the tally is named and only its strokes are hidden',
    edits: [{ file: 'ui/today.js', find: "const tally = el('span', { class: 'tally', role: 'img',", replace: "const tally = el('span', { class: 'tally', 'aria-hidden': 'true', role: 'img'," }] },
  { id: 'PD82', what: 'the Settings tab no longer says a backup is due in words (A1-3)', cmd: 'static', expect: 'the Settings tab says in words',
    edits: [{ file: 'app.js', find: "    if (due) tab.setAttribute('aria-label', t('tab.settings.due')); else tab.removeAttribute('aria-label');\n", replace: '' }] },
  { id: 'PD83', what: 'a refused link never shows its line (A1-3)', cmd: 'static', expect: 'a refused video link shows the link line',
    edits: [{ file: 'ui/today.js', find: "input.setAttribute('aria-invalid', 'true'); badLine.hidden = false; return;", replace: "input.setAttribute('aria-invalid', 'true'); return;" }] },
  { id: 'PD84', what: 'a key renamed in strings.js but not in its caller (14.2)', cmd: 'static', expect: 'every key the screens ask for is in ui/strings.js',
    edits: [{ file: 'ui/strings.js', find: "  'video.watch': 'Watch video',\n", replace: "  'card.link': 'Watch video',\n" }] },
  { id: 'PD85', what: 'one polish Part key missing from strings.js (P.1 step 1)', cmd: 'static', expect: 'ui/strings.js holds every key of every polish Part',
    edits: [{ file: 'ui/strings.js', find: "  'check.sticky': 'A Yes stays for the rest of today.',\n", replace: "  'check.other': 'A Yes stays for the rest of today.',\n" }] },
  // The A3-R6 behavior cases (R35): each built static guard's defect, run against its e2e test.
  { id: 'PD9', what: 'a failed restore still reloads (A3-R1, the R13 defect)', cmd: 'e2e_slice1_polish', expect: '(a) a failed restore shows its line, never reloads',
    edits: [{ file: 'ui/settings.js', find: '    failed(e);\n    return false;\n', replace: '    failed(e);\n' }] },
  { id: 'PD13', what: 'the update reload no longer waits for writes (C7, the G7 defect)', cmd: 'e2e_update', expect: 'C7: an update reload waits',
    edits: [{ file: 'app.js', find: '    await Promise.race([store.idle(), new Promise((res) => setTimeout(res, 10000))]);\n', replace: '' }] },
  { id: 'PD14', what: 'the share flag is never set (C6, the G6 defect)', cmd: 'e2e_update', expect: 'C6: a share in progress holds the update back',
    edits: [{ file: 'app.js', find: '    this.sharing = true;\n', replace: '' }] },
  { id: 'PD16', what: 'Today ignores block status done (C27, the G27 defect)', cmd: 'e2e_slice1_polish', expect: 'C27 a finished block shows Block finished',
    edits: [{ file: 'ui/today.js', find: "block && block.status === 'done' ? blockDone(ctx, block) : noBlock(ctx)", replace: 'noBlock(ctx)' }] },
  { id: 'PD18', what: 'reorder changes the screen only (C32)', cmd: 'e2e_slice1_polish', expect: 'C32 Move up then Save',
    edits: [{ file: 'ui/builder.js', find: '  [d.lifts[li], d.lifts[j]] = [d.lifts[j], d.lifts[li]];\n  rerender();', replace: '  rerender();' }] },
  { id: 'PD19', what: 'scrim close back on the feedback sheet (C39, the G39 defect)', cmd: 'e2e_slice1_polish', expect: 'C39 a scrim tap on the feedback sheet leaves it open',
    edits: [{ file: 'ui/today.js', find: "sub: t('fb.sub', { n }),\n      canDismiss: () => false, onClose", replace: "sub: t('fb.sub', { n }),\n      onClose" }] },
  { id: 'PD20', what: 'start weight plus adds 1 (C41)', cmd: 'e2e_slice1_polish', expect: 'C41 start weight plus on a lift with steps 5 goes 100 to 105',
    edits: [{ file: 'ui/today.js', find: "  if (unit !== 'kg' && ex && typeof ex.step_default === 'number' && ex.step_default > 0) return { size: ex.step_default };\n  const byUnit = rules", replace: '  return { size: 1 };\n  const byUnit = rules' }] },
  { id: 'PD86', what: 'the restore note never shown at boot (A3-R8)', cmd: 'e2e_slice1_polish', expect: 'a good restore shows the Restored line',
    edits: [{ file: 'app.js', find: "  store.takeRestoreNote().then((n) => { if (n !== null) toast(t('restore.done', { n })); }).catch(() => {});\n", replace: '' }] },
  { id: 'PD87', what: 'an over-cap restore pick is read before the size check (A4-1)', cmd: 'e2e_slice1_polish', expect: 'a 65 MiB pick shows the too big line and is never read',
    edits: [{ file: 'app.js', find: '      if (f && f.size > fileMax) { done({ tooBig: true }); return; }\n', replace: '      if (f) await f.text();\n      if (f && f.size > fileMax) { done({ tooBig: true }); return; }\n' }] },
  { id: 'PD88', what: 'a list of loads that does not rise is accepted (r4.1 Q14, Q41)', cmd: 'unit_backup', expect: 'his block fields',
    edits: [{ file: 'backup.js', find: "      if (!out.length || out.some((x, i) => i > 0 && !(x > out[i - 1]))) bad(w + ': loads must rise with no repeats');\n", replace: '' }] },
  { id: 'PD89', what: 'effectiveExercise ignores the block step size (r4.1 Q18)', cmd: 'unit_store', expect: 'effectiveExercise',
    edits: [{ file: 'store.js', find: "  else if (typeof f.step === 'number' && f.step > 0) { out.weight_steps = null; out.step = f.step; }\n", replace: '' }] },
  { id: 'PD90', what: 'a block entry no longer screens the exercise (R4-15)', cmd: 'unit_store', expect: 'effectiveExercise',
    edits: [{ file: 'store.js', find: '  const out = { ...ex, flags_set: true };', replace: '  const out = { ...ex };' }] },
  // ---------------- Slice 1 polish pass, stage 2 (DESIGN 15 P.2 parts 1 to 12, P.3 table) ----------------
  { id: 'PD26', what: 'a blank block name saved as empty (Part 2)', cmd: 'unit_store', expect: 'blank block name gets the default name',
    edits: [{ file: 'store.js', find: "    if (!String(block.name).trim()) block.name = defaultBlockName(blocks.filter(b => b.id !== block.id));", replace: "    if (!String(block.name).trim()) block.name = '';" }] },
  { id: 'PD27', what: 'builder remove takes the row off the screen only (Part 3)', cmd: 'e2e_slice1_polish', expect: 'builder remove the middle exercise then Save',
    edits: [{ file: 'ui/builder.js', find: "      on: { click: () => { removeLift(d, li); rerender(); } } }, glyph('cross'));", replace: "      on: { click: (ev) => { ev.currentTarget.closest('.lift-row').remove(); } } }, glyph('cross'));" }] },
  { id: 'PD28', what: 'the draft ask skipped and the draft dropped (Part 4)', cmd: 'e2e_slice1_polish', expect: 'Build a block with a draft asks first',
    edits: [{ file: 'ui/builder.js', find: "  if (!hasDraft(ctx.build)) { ctx.build = null; ctx.go('#/builder'); return; }", replace: "  if (ctx.build || !ctx.build) { ctx.build = null; ctx.go('#/builder'); return; }" }] },
  { id: 'PD24', what: 'relabel allowed on a done day (Part 1)', cmd: 'unit_store', expect: 'relabel refused on a done day',
    edits: [{ file: 'store.js', find: "    if (day.status !== 'planned' && day.status !== 'open') throw new Refused('day is not open');\n    const row = { ...day, label: v, saved_at: now() };", replace: "    const row = { ...day, label: v, saved_at: now() };" }] },
  { id: 'PD25', what: 'the empty label shown as an empty h1 (Part 1)', cmd: 'e2e_slice1_polish', expect: 'cleared label shows the numbered name',
    edits: [{ file: 'ui/today.js', find: "    el('h1', { id: 'day-label' }, dayTitle(day)),", replace: "    el('h1', { id: 'day-label' }, day.label)," }] },
  { id: 'PD29', what: 'the helper blank when load is null (Part 5)', cmd: 'e2e_slice1_polish', expect: 'no start weight shows empty boxes and the no-weight line',
    edits: [{ file: 'ui/today.js', find: "    if (tg.rep_low === null) goal = t('today.noload');", replace: "    if (tg.rep_low !== undefined) return '';" }] },
  { id: 'PD30', what: 'weight copy goes up as well (Part 6)', cmd: 'unit_store', expect: 'weight copy never goes up',
    edits: [{ file: 'store.js', find: "x.side === s.side && x.set_n > s.set_n && x.status === 'planned');", replace: "x.side === s.side && x.set_n !== s.set_n && x.status === 'planned');" }] },
  { id: 'PD31', what: 'weight copy writes over a typed draft (Part 6)', cmd: 'unit_store', expect: 'weight copy never over a typed draft',
    edits: [{ file: 'store.js', find: '          const copyOk = x.draft === null || x.draft.from_copy === true;', replace: '          const copyOk = true;' }] },
  { id: 'PD32', what: 'weight copy done as separate writes (Part 6)', cmd: 'unit_store', expect: 'weight copy lands in one batch',
    edits: [{ file: 'store.js', find: '      return batch(ops);   // the edit and every copy in one write (15 Part 6)', replace: '      for (const o of ops) await batch([o]);\n      return undefined;' }] },
  { id: 'PD33', what: 'carry-down ignores the switch (Part 7)', cmd: 'unit_store', expect: 'carry-down off keeps a typed value',
    edits: [{ file: 'store.js', find: "        const carry = (await db.setting('carry_down', false)) === true;", replace: '        const carry = true;' }] },
  { id: 'PD34', what: 'carry-down changes a done set (Part 7)', cmd: 'unit_store', expect: 'carry-down never changes a done set',
    edits: [{ file: 'store.js', find: "x.set_n > s.set_n && x.status === 'planned');", replace: 'x.set_n > s.set_n);' }] },
  { id: 'PD35', what: 'the rep range ask fires only below (Part 8)', cmd: 'e2e_slice1_polish', expect: 'rep range ask above the top',
    edits: [{ file: 'ui/today.js', find: '  if (reps < tg.rep_low || reps > tg.rep_high) return', replace: '  if (reps < tg.rep_low) return' }] },
  { id: 'PD36', what: 'rep range Cancel saves the set anyway (Part 8)', cmd: 'e2e_slice1_polish', expect: 'rep range Cancel keeps the row open',
    edits: [{ file: 'ui/today.js', find: '      if (!r.save) {', replace: '      if (r.save === 7) {' }] },
  { id: 'PD37', what: 'Add set below leaves later set_n values, so two rows share a number (Part 9)', cmd: 'unit_store', expect: 'add set below moves later set numbers',
    edits: [{ file: 'store.js', find: '      for (const x of same) if (x.set_n > s.set_n) ops.push({ store: \'sets\', put: { ...x, set_n: x.set_n + 1 } });\n', replace: '' }] },
  { id: 'PD38', what: 'a done set can be deleted (Part 10)', cmd: 'unit_store', expect: 'delete refused on a done set',
    edits: [{ file: 'store.js', find: "  for (const x of pair) if (x.status !== 'planned') return 'done';\n", replace: '' }] },
  { id: 'PD50', what: 'Add set after a delete reuses an existing id (Part 10, review R12)', cmd: 'unit_store', expect: 'Add set after a delete keeps the done row',
    edits: [
      { file: 'store.js', find: "    const k = nextIdNum(sets, 's');\n    const sides = last.side", replace: "    const k = n;\n    const sides = last.side" },
      { file: 'store.js', find: "    if (sets.some(x => x.id === id)) throw new Refused('id in use');\n", replace: '' }] },
  { id: 'PD52', what: 'a copied draft blocks delete (Part 10, review R24)', cmd: 'unit_store', expect: 'delete allowed on a copied draft',
    edits: [{ file: 'store.js', find: "  for (const x of pair) if (x.draft !== null && x.draft.from_copy !== true) return 'draft';", replace: "  for (const x of pair) if (x.draft !== null) return 'draft';" }] },
  { id: 'PD39', what: 'the card order kept on the page only, never written (Part 11)', cmd: 'e2e_slice1_polish', expect: 'move up is still there after a reload',
    edits: [{ file: 'ui/today.js', find: "    ['up', adj ? scoped({ type: 'move', dir: -1 }) : act(() => ctx.store.moveSlot(dayId, slot, -1))],",
      replace: "    ['up', adj ? scoped({ type: 'move', dir: -1 }) : () => { sh.close(); const c = document.querySelector('.ex-card[data-slot=\"' + slot + '\"]'); c.parentNode.insertBefore(c, c.previousElementSibling); }]," }] },
  { id: 'PD40', what: 'reset with no safety copy (Part 12)', cmd: 'unit_store', expect: 'reset saves a safety copy first',
    edits: [{ file: 'store.js', find: "      await snapshotNow('before-reset', job);\n", replace: '' }] },
  { id: 'PD51', what: 'reset drops a check Yes (Part 12, review R20)', cmd: 'unit_store', expect: 'reset keeps a check Yes',
    edits: [{ file: 'store.js', find: '        const kept = Object.fromEntries(Object.entries(f.checks || {}).filter(([, val]) => val === true));', replace: '        const kept = {};' }] },
  // ---------------- Slice 1 polish pass, stage 3 (DESIGN 15 P.2 parts 13 to 19, P.3 table) ----------------
  { id: 'PD22', what: 'Finish day ends a day with no done set (Part 15, R4-02)', cmd: 'unit_store', expect: 'Finish day refused with zero done sets',
    edits: [{ file: 'store.js', find: "      if (!sets.some(s => s.status === 'done')) throw new Refused('no done set');\n", replace: '' }] },
  { id: 'PD44', what: 'Skip day leaves one planned set planned (Part 15)', cmd: 'unit_store', expect: 'Skip day skips every planned set',
    edits: [{ file: 'store.js', find: "      for (const s of sets) if (s.status === 'planned') ops.push({ store: 'sets', put: { ...s, status: 'skipped', why: 'why.dayskipped', draft: null, saved_at: t } });",
      replace: "      for (const s of sets.slice(1)) if (s.status === 'planned') ops.push({ store: 'sets', put: { ...s, status: 'skipped', why: 'why.dayskipped', draft: null, saved_at: t } });" }] },
  { id: 'PD54', what: 'Skip day on the last day leaves the block active (Part 15, review R21)', cmd: 'unit_store', expect: 'Skip day on the last day ends the block',
    edits: [{ file: 'store.js', find: "      if (next) ops.push(...await planDayOps(block, next.pass, next.day, { overlay: ops }));\n      else ops.push(finishBlock(block, t));\n      await job.write(() => batch(ops));\n      return next;\n    });\n  }\n\n  // The Day done numbers",
      replace: "      if (next) ops.push(...await planDayOps(block, next.pass, next.day, { overlay: ops }));\n      await job.write(() => batch(ops));\n      return next;\n    });\n  }\n\n  // The Day done numbers" }] },
  { id: 'PD55', what: 'Skip day keeps the screen awake (Part 15, review R42)', cmd: 'e2e_slice1_polish', expect: 'Skip day releases keep-awake',
    edits: [{ file: 'ui/today.js', find: '    sh.close();\n    ctx.wake.release();\n    openId = null;\n    // Skip day on the last day', replace: '    sh.close();\n    openId = null;\n    // Skip day on the last day' }] },
  { id: 'PD45', what: 'an unanswered breaks value saved as 0 (Part 16)', cmd: 'unit_store', expect: 'breaks not answered saves null',
    edits: [{ file: 'store.js', find: '  if (v === undefined || v === null) return null;\n  if (!Number.isInteger(v)', replace: '  if (v === undefined || v === null) return 0;\n  if (!Number.isInteger(v)' }] },
  { id: 'PD23', what: 'Stop skips nothing (Part 17)', cmd: 'e2e_slice1_polish', expect: 'check Yes after set 1 offers Stop and Stop skips the rest',
    edits: [{ file: 'ui/today.js', find: '          try { await ctx.store.stopExercise(v.day.id, slot); } catch (e) { toast(t(\'today.notsaved\')); }', replace: '          void slot;' }] },
  { id: 'PD43', what: 'a later No clears a Yes (Part 17, R4-03)', cmd: 'unit_store', expect: 'saveChecks keeps a Yes',
    edits: [{ file: 'store.js', find: '        if (checks[k] !== true) checks[k] = v;', replace: '        checks[k] = v;' }] },
  { id: 'PD46', what: 'a check with a lifts list asked on another exercise (Part 17)', cmd: 'unit_today', expect: 'checksFor keeps a check to its lifts',
    edits: [{ file: 'store.js', find: '(Array.isArray(c.lifts) && c.lifts.includes(exerciseId)));', replace: 'Array.isArray(c.lifts));' }] },
  { id: 'PD47', what: 'goal_line shown on a lift that has a rep range (Part 18)', cmd: 'unit_today', expect: 'goal_line only without a rep range',
    edits: [{ file: 'ui/today.js', find: '  if (tg.rep_low === null && own) {', replace: '  if (own) {' }] },
  { id: 'PD48', what: 'the check inset shown only after the first work set (Part 17, review R37)', cmd: 'e2e_slice1_polish', expect: 'check inset after set 2 offers Stop',
    edits: [{ file: 'ui/today.js', find: '      inset = checksFor(v.block, s.exercise_id).length ? { day: day.id, slot: s.slot, after: s.id } : null;',
      replace: "      inset = checksFor(v.block, s.exercise_id).length && s.kind === 'work' && s.set_n === 1 ? { day: day.id, slot: s.slot, after: s.id } : null;" }] },
  { id: 'PD53', what: 'a banner rule reads the fail color (Part 19)', cmd: 'static', expect: 'only the failed-save row reads the fail color',
    edits: [{ file: 'styles.css', find: '.blocked p{color:var(--ink)}', replace: '.blocked p{color:var(--fail)}' }] },
  { id: 'PD41', what: 'the progress line moves on the tap, before the write commits (Part 13)', cmd: 'e2e_slice1_polish', expect: 'progress waits for the commit',
    edits: [{ file: 'ui/today.js', find: "  const through = sets.filter(s => (s.status === 'done' || s.status === 'skipped') && !(states && states.has(s.id))).length;",
      replace: "  const through = sets.filter(s => s.status === 'done' || s.status === 'skipped' || (states && states.has(s.id))).length;" }] },
  { id: 'PD42', what: 'the swapped-out slot counted as skipped (Part 14)', cmd: 'unit_store', expect: 'day totals leave out a swapped-out slot',
    edits: [{ file: 'store.js', find: "    else if (!rows.some(s => s.status === 'skipped' && s.why === 'why.swapped')) exSkipped++;", replace: '    else exSkipped++;' }] },
  // ---------------- polish review fixes, stage 1 ----------------
  { id: 'PD96', what: 'a block update leaves a stale card order on a moved planned day (G1, review P8)', cmd: 'unit_store', expect: 'a block update that drops a moved lift trims the card order',
    edits: [{ file: 'store.js', find: '    if (existing.label !== tpl.label || !sameOrder || existing.profile !== profile) ops.unshift(', replace: '    if (existing.label !== tpl.label || existing.profile !== profile) ops.unshift(' }] },
  { id: 'PD97', what: 'Add set run twice after a late first commit (G13, review P9)', cmd: 'unit_store', expect: 'late first commit: Add set adds one set',
    edits: [{ file: 'store.js', find: "    if (prev.length && prev.every(id => sets.some(x => x.id === id))) return null;\n    const work", replace: '    const work' }] },
  { id: 'PD98', what: 'Add set below run twice after a late first commit (G13, review P9)', cmd: 'unit_store', expect: 'late first commit: Add set below adds one set',
    edits: [{ file: 'store.js', find: "      if (ids.length && ids.every(id => sets.some(x => x.id === id))) return undefined;\n      ids = [];", replace: '      ids = [];' }] },
  { id: 'PD99', what: 'Move run twice after a late first commit (G13, review P9)', cmd: 'unit_store', expect: 'late first commit: Move up moves once',
    edits: [{ file: 'store.js', find: "    if (prev && JSON.stringify(day.slot_order) === JSON.stringify(prev)) return null;\n", replace: '' }] },
  { id: 'PD100', what: 'Swap run twice after a late first commit (G13, review P9)', cmd: 'unit_store', expect: 'late first commit: Swap makes one new card',
    edits: [{ file: 'store.js', find: "    if (prevSlot !== null && all.some(s => s.slot === prevSlot && s.origin === 'added')) return null;\n", replace: '' }] },
  { id: 'PD101', what: 'Skip set run twice after a late first commit (G13, review P9)', cmd: 'unit_store', expect: 'late first commit: Skip set skips one set',
    edits: [{ file: 'store.js', find: "      if (tries++ && ids.length && ids.every(id => all.some(x => x.id === id && x.status === 'skipped'))) return undefined;\n", replace: '' }] },
  { id: 'PD102', what: 'a tick run twice puts the target over the draft (G13, review P9)', cmd: 'unit_store', expect: 'late first commit: a tick from the draft keeps the draft numbers',
    edits: [{ file: 'store.js', find: "      if (row && s.status === 'done' && s.saved_at === row.saved_at) return undefined;\n", replace: '' }] },
  { id: 'PD103', what: 'a day label from a file lets a tab or a new line through (G14, review P10)', cmd: 'unit_backup', expect: 'a label holding a tab or a new line is refused',
    edits: [{ file: 'backup.js', find: '      id: c.id, block_id: c.id, pass: c.int(1, L.PASS_MAX), day: c.int(1, L.DAY_MAX), label: c.line(L.LABEL),', replace: '      id: c.id, block_id: c.id, pass: c.int(1, L.PASS_MAX), day: c.int(1, L.DAY_MAX), label: c.text(L.LABEL),' }] },
  { id: 'PD104', what: 'a block day label lets a tab or a new line through (G14, review P10)', cmd: 'unit_backup', expect: 'a label holding a tab or a new line is refused',
    edits: [{ file: 'backup.js', find: 'day: c.int(1, L.DAY_MAX), label: c.line(L.LABEL), lifts:', replace: 'day: c.int(1, L.DAY_MAX), label: c.text(L.LABEL), lifts:' }] },
  { id: 'PD105', what: 'the pending label check finds nothing (G3, review P2)', cmd: 'static', expect: 'pending label check: a planted value fails',
    edits: [{ file: 'scripts/tests/repo_guard.js', find: "    for (const { id, re } of pend.pending) { re.lastIndex = 0; if (re.test(v)) hits.push('ui/strings.js value ' + key + '  ' + id); }", replace: '    void pend; void v;' }] },
  { id: 'PD106', what: 'the pending label check ignores case (G3, review P2)', cmd: 'static', expect: 'pending label check: the same letters inside a longer word pass',
    edits: [{ file: 'scripts/tests/repo_guard.js', find: "re: wordRe(w, 'g') })), count: terms.length };", replace: "re: wordRe(w, 'gi') })), count: terms.length };" }] },
  { id: 'PD107', what: 'a missing pending list passes the guard (G3, review P2)', cmd: 'static', expect: 'pending label check: a missing or empty pending list fails',
    edits: [{ file: 'scripts/tests/repo_guard.js', find: "      if (res.error || pend.error) {\n        console.log('FAIL repo_guard ' + (res.error || pend.error));", replace: "      if (res.error) {\n        console.log('FAIL repo_guard ' + res.error);" },
      { file: 'scripts/tests/repo_guard.js', find: "        res.hits.push(...pendingHits(pend, ", replace: "        if (!pend.error) res.hits.push(...pendingHits(pend, " }] },
  { id: 'PD108', what: 'the builder start weight steps in lb on a kg build (G8, review P3)', cmd: 'unit_today', expect: 'builder start weight steps in the unit of the build',
    edits: [{ file: 'ui/builder.js', find: "  return stepLoad(ex, load, dir, b && b.unit === 'kg' ? 'kg' : 'lb');", replace: '  return stepLoad(ex, load, dir);' }] },
  // Stage 4 N6: planted the moment the Day done screen opens, before its dayTotals read, so the
  // offer's own reads finish well before the nudge opens a frame after the paint (no race).
  { id: 'PD109', what: 'the pending update is offered the moment the Day done screen opens (G2, review P1, P26)', cmd: 'e2e_update', expect: 'open-day case: Finish day shows the Day done screen and the nudge, with no reload yet',
    edits: [{ file: 'ui/today.js', find: "  const want = ctx.dayDone;\n  (async () => {\n    const r = want && want.id === dayId", replace: "  const want = ctx.dayDone;\n  ctx.offerPendingUpdate();\n  (async () => {\n    const r = want && want.id === dayId" }] },
  { id: 'PD110', what: 'an empty build left after Load a block file instead holds every update (G11, review P6)', cmd: 'e2e_update', expect: 'builder-load case: after Load a block file instead, a found update loads',
    edits: [{ file: 'app.js', find: '  return hasDraft(ctx.build) || !!ctx.picker', replace: '  return !!ctx.build || !!ctx.picker' }] },
  { id: 'PD111', what: 'the update busy check counts any build (G11, review P6, static twin of PD110)', cmd: 'static', expect: 'the update busy check counts a draft only',
    edits: [{ file: 'app.js', find: '  return hasDraft(ctx.build) || !!ctx.picker', replace: '  return !!ctx.build || !!ctx.picker' }] },
  { id: 'PD112', what: 'Checks after Video link in the card menu (G16, review P18)', cmd: 'unit_today', expect: 'the card menu order of record',
    edits: [{ file: 'ui/today.js', find: "export const CARD_MENU_ORDER = [0, 1, 2, 3, 'up', 'down', 'remove', 4, 'checks', 'answers', 5];", replace: "export const CARD_MENU_ORDER = [0, 1, 2, 3, 'up', 'down', 'remove', 4, 'answers', 5, 'checks'];" }] },
  { id: 'PD113', what: 'a scrim tap drops a typed RESET (G17, review P19)', cmd: 'static', expect: 'the reset, restore and erase sheets close on a scrim tap only while nothing is typed',
    edits: [{ file: 'ui/today.js', find: "title: t('reset.title'), canDismiss: () => untyped(conf) }", replace: "title: t('reset.title') }" }] },
  { id: 'PD114', what: 'the range numbers drawn as plain text (G18 a, review P21 a)', cmd: 'static', expect: 'the range line puts its numbers in .num',
    edits: [{ file: 'ui/today.js', find: "numSplit(ask.key, ask.vals).map(p => (p.num !== undefined ? el('span', { class: 'num' }, p.num) : p.text))", replace: 't(ask.key, ask.vals)' }] },
  { id: 'PD115', what: 'the placeholder rule dropped (G18 b, review P21 b)', cmd: 'static', expect: 'the field placeholder shows in --ink-2',
    edits: [{ file: 'styles.css', find: '.field::placeholder{color:var(--ink-2); opacity:1}', replace: '' }] },
  { id: 'PD116', what: 'the card menu Checks row does nothing (G5, review P14, P24)', cmd: 'e2e_slice1_polish', expect: 'polish: the card menu Checks row opens the inset mid exercise',
    edits: [{ file: 'ui/today.js', find: "    ['checks', () => { sh.close(); inset = { day: dayId, slot, after: null }; if (screen) redraw(ctx, screen); }],", replace: "    ['checks', () => { sh.close(); }]," }] },
  { id: 'PD117', what: 'the Day done address shows any done or planned day (G7, review P25)', cmd: 'e2e_slice1_polish', expect: 'polish: a bad id or a day not done in the address goes to Today',
    edits: [{ file: 'ui/today.js', find: '    const r = want && want.id === dayId ? await ctx.store.dayTotals(dayId).catch(() => null) : null;', replace: "    const r = want && want.id === dayId ? await ctx.store.dayTotals(dayId).catch(() => null) : dayId === '__proto__' ? null : { day: { id: dayId, pass: 1, label: '', day: 1 }, totals: { workDone: 0, exDone: 0, exSkipped: 0 } };" },
      // Slice 3: the session day keeps its real totals, so the planted gap is only the other ids and the
      // earlier B3 tally check on a real Day done screen still passes (it hid the named check, ERROR in run_all e37a9f9).
      // With no session day the old line threw on want.nudge and its catch went to Today, which hid the planted gap (stage fix).
      { file: 'ui/today.js', find: '    if (want.nudge) {', replace: '    if (want && want.nudge) {' },
      // Slice 3 added want.finished: the same crash would hide the gap again, so it is guarded too.
      { file: 'ui/today.js', find: '    const blockOver = !!want.finished;', replace: '    const blockOver = !!(want && want.finished);' }] },
  { id: 'PD118', what: 'break chips on a reps lift (G20, review P30)', cmd: 'e2e_slice1_polish', expect: 'polish: a reps lift shows no break chips',
    edits: [{ file: 'ui/today.js', find: "  return s.kind === 'work' && countOf(s, ex) === 'laps';", replace: "  return s.kind === 'work';" }] },
  // ---------------- polish review fixes, stage 2 (DESIGN 14.8; A2: next free ids after PD118) ----------------
  { id: 'PD119', what: 'Cancel on the builder always drops the draft (14.8 PD-G4, review P13)', cmd: 'unit_today', expect: 'Cancel on the builder keeps a typed draft',
    edits: [{ file: 'ui/builder.js', find: '  if (!hasDraft(ctx.build)) ctx.build = null;\n  ctx.go(\'#/today\');', replace: '  ctx.build = null;\n  ctx.go(\'#/today\');' }] },
  { id: 'PD120', what: 'batch() loses its checkId loop (14.8 PD-G9, review P4, P34)', cmd: 'unit_store', expect: 'G9 (a): resetDay refuses a feedback row with a bad id',
    edits: [{ file: 'store.js', find: "    for (const o of ops) checkId(o.store === 'settings' ? 'k' : ('put' in o ? o.put.id : o.del));\n", replace: '' }] },
  { id: 'PD121', what: 'the card menu Checks row ignores planned sets (14.8 PD-G10, review P5, P17)', cmd: 'unit_today', expect: 'the card menu Checks row shows only while the exercise still has a planned set',
    edits: [{ file: 'ui/today.js', find: "  if (i === 'checks') return checksFor(v.block, ex ? ex.id : null).length > 0 && v.sets.some(s => s.slot === slot && s.status === 'planned');", replace: "  if (i === 'checks') return checksFor(v.block, ex ? ex.id : null).length > 0 && v.slots.includes(slot);" }] },
  { id: 'PD122', what: 'the slot order cap removed (14.8 PD-G15, review P12)', cmd: 'unit_store', expect: 'G15: 30 lifts and 21 swaps, then a Move',
    edits: [{ file: 'store.js', find: '  if (order.length <= LIMITS.SLOT_ORDER) return order;\n', replace: '  return order;\n' }] },
  { id: 'PD123', what: 'a Not saved pill rule reads the fail color (14.8 PD-X1)', cmd: 'static', expect: 'only the failed-save row reads the fail color',
    edits: [{ file: 'styles.css', find: '.blocked p{color:var(--ink)}', replace: '.blocked p{color:var(--ink)}\n.pill-notsaved{color:var(--fail)}' }] },
  // ---------------- polish review fixes, stage 4 (look flags; next free ids after PD123) ----------------
  { id: 'PD124', what: 'every toast takes the short time, a wrapped one too (stage 4 B4, LOOK 3.7)', cmd: 'static', expect: 'the long toast: measured, 6 s',
    edits: [{ file: 'ui/dom.js', find: "toastTime(wraps, tokenMs('--toast-ms', 3000), tokenMs('--t-toast-action', 6000))", replace: "tokenMs('--toast-ms', 3000)" }] },
  { id: 'PD125', what: 'a wrapped toast is never seen as wrapped (stage 4 B4, LOOK 3.7)', cmd: 'unit_today', expect: 'a toast that wraps shows for the long time',
    edits: [{ file: 'ui/dom.js', find: '&& lineHeight > 0 && textHeight > lineHeight * 1.5;', replace: '&& lineHeight > 0 && false;' }] },
  { id: 'PD126', what: 'the long toast skin dropped (stage 4 B4, LOOK 3.7)', cmd: 'e2e_slice1_polish', expect: 'polish: B4 a wrapped toast is left-aligned',
    edits: [{ file: 'styles.css', find: '.toast.is-long{border-radius:var(--r-lg); text-align:left;', replace: '.toast.is-long{' }] },
  { id: 'PD127', what: 'the primary button text back on --fs-body (stage 4 B5, LOOK 3.4)', cmd: 'static', expect: 'the primary button text is --fs-btn 18px',
    edits: [{ file: 'styles.css', find: 'color:var(--on-accent); font-size:var(--fs-btn);', replace: 'color:var(--on-accent); font-size:var(--fs-body);' }] },
  { id: 'PD128', what: 'a disabled check chip at opacity .5 (stage 4 B6, LOOK 3.4 states)', cmd: 'static', expect: 'every disabled control is drawn at opacity .4',
    edits: [{ file: 'styles.css', find: '.check-chips .chip[disabled]{opacity:.4}', replace: '.check-chips .chip[disabled]{opacity:.5}' }] },
  { id: 'PD129', what: 'the tally never draws the fifth-stroke slash (stage 4 B3, LOOK 3.9)', cmd: 'unit_today', expect: 'the tally draws groups of five',
    edits: [{ file: 'ui/today.js', find: "    groups[groups.length - 1].push({ slash: i % 5 === 4, done: !!done });", replace: "    groups[groups.length - 1].push({ slash: false, done: !!done });" }] },
  { id: 'PD130', what: 'the gap between tally groups dropped (stage 4 B3, LOOK 3.9)', cmd: 'static', expect: 'the tally slash and the group gap are drawn',
    edits: [{ file: 'styles.css', find: '.tally.tally-grouped{gap:var(--tally-group-gap)}\n', replace: '' }] },
  { id: 'PD131', what: 'the fifth mark drawn as a fifth upright stroke (stage 4 B3, LOOK 3.9)', cmd: 'e2e_slice1_polish', expect: 'polish: B3 five done sets draw four strokes',
    edits: [{ file: 'ui/today.js', find: "      if (m.slash) box.appendChild(el('span', { class: 'tally-slash'", replace: "      if (m.slash) box.appendChild(el('span', { class: 'tally-stroke'" }] },
  // ---------------- r4.3 light pass (DESIGN 14.9, 5.8 footer: PD132 to PD144, then the security fix rows) ----------------
  { id: 'PD132', what: 'the block update plans outside the exclusive job and writes in queued(block) (r4.3 H1, the old shape)', cmd: 'unit_store', expect: 'H1: a tick queued right after a block update starts lands after it and is kept',
    edits: [{ file: 'store.js', find: '  function importBlock(text, activate) {\n    return exclusive(async (job) => {\n',
      replace: "  function importBlock(text, activate) {\n    return (async () => {\n      const r = await readBlockFile(text);\n      if (r.ok && r.kind === 'update') {\n        const plan = await updatePlan(r.target, r);\n        const ops = [...plan.exOps, { store: 'blocks', put: plan.newBlock }, ...plan.dayOps];\n        if (activate) ops.push({ store: 'settings', put: { key: 'active_block_id', value: plan.newBlock.id } });\n        await queued('block', () => batch(ops));\n        return plan.newBlock;\n      }\n      return importNew(text, activate);\n    })();\n  }\n  function importNew(text, activate) {\n    return exclusive(async (job) => {\n" }] },
  // Since the 0.2.6 publish the ledger holds that entry, so the row plants a wrong entry for the
  // CURRENT version (read from sw.js) in front of it; the find text is the opening line and the
  // first entry's open brace, which the file holds once.
  { id: 'PD133', what: 'shell_versions.json lists the current VERSION with a hash of 64 zeros, next to the published entries (r4.3 H4)', cmd: 'static', expect: 'SHELL_HASH matches the shell files (M19, M19b)',
    edits: [{ file: 'scripts/tests/shell_versions.json', find: '[\n {\n',
      replace: () => '[\n {"version": "' + /const VERSION = '([^']+)'/.exec(readFileSync(join(APP, 'sw.js'), 'utf8'))[1] + '", "hash": "' + '0'.repeat(64) + '"},\n {\n' }] },
  { id: 'PD134', what: 'addCustomExercise writes custom: false (r4.3 H8, S16)', cmd: 'unit_store', expect: 'S16: a lift he makes is a custom row a block can use',
    edits: [{ file: 'store.js', find: "left_out_of_builder: flags.left_out_of_builder, flags_set: flagsSet, link: '', notes: '', custom: true, edited: false", replace: "left_out_of_builder: flags.left_out_of_builder, flags_set: flagsSet, link: '', notes: '', custom: false, edited: false" }] },
  { id: 'PD135', what: 'sideOrder puts R before L (r4.3 H8, L07)', cmd: 'unit_store', expect: 'L07: an each-side lift plans L then R for every set',
    edits: [{ file: 'store.js', find: 'const sideOrder = { L: 0, R: 1, none: 2 };', replace: 'const sideOrder = { L: 1, R: 0, none: 2 };' }] },
  { id: 'PD136', what: 'the set kind list in backup.js gains a third word (r4.3 H8, L09)', cmd: 'unit_backup', expect: 'L09: a set kind other than warmup or work is refused',
    edits: [{ file: 'backup.js', find: "side: c.oneOf(['L', 'R', 'none']), kind: c.oneOf(['warmup', 'work']),", replace: "side: c.oneOf(['L', 'R', 'none']), kind: c.oneOf(['warmup', 'work', 'superset'])," }] },
  { id: 'PD137', what: "resetDay ops gain { store: 'days', del: dId } (r4.3 H8, E16)", cmd: 'static', expect: 'E16: no write deletes a day row',
    edits: [{ file: 'store.js', find: "      ops.push({ store: 'days', put: { ...day, saved_at: t } });\n      await job.write(() => batch(ops));\n      return ops.length;",
      replace: "      ops.push({ store: 'days', put: { ...day, saved_at: t } });\n      ops.push({ store: 'days', del: dId });\n      await job.write(() => batch(ops));\n      return ops.length;" }] },
  { id: 'PD138', what: 'the store returned object gains resetBlock: eraseAll (r4.3 H8, E18)', cmd: 'static', expect: 'E18: Erase all is the only whole reset',
    edits: [{ file: 'store.js', find: '    clearSnapshots, readBlockFile, importBlock,', replace: '    clearSnapshots, resetBlock: eraseAll, readBlockFile, importBlock,' }] },
  { id: 'PD139', what: "pickerGroups puts every row in the first muscle's group (r4.3 H8, X01)", cmd: 'unit_today', expect: 'X01: the picker groups lifts by muscle in list order',
    edits: [{ file: 'ui/builder.js', find: '    const list = shown.filter(e => e.muscle === m).sort(', replace: '    const list = shown.filter(e => m === MUSCLES[0] || e.muscle === m).sort(' }] },
  { id: 'PD140', what: 'the name sort removed from pickerGroups (r4.3 H8, Q06)', cmd: 'unit_today', expect: 'Q06: inside a muscle the picker sorts by name, never by answers',
    edits: [{ file: 'ui/builder.js', find: '    const list = shown.filter(e => e.muscle === m).sort((a, b) => a.name.localeCompare(b.name));', replace: '    const list = shown.filter(e => e.muscle === m);' }] },
  { id: 'PD141', what: "applyTheme ignores 'dark' (r4.3 H8, O02)", cmd: 'e2e_slice1_polish', expect: 'O02 the look choice sets the theme and survives a reload',
    edits: [{ file: 'ui/settings.js', find: "  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);", replace: "  if (theme === 'light') document.documentElement.setAttribute('data-theme', theme);" }] },
  { id: 'PD142', what: 'the since line counts down from 2 minutes (r4.3 H8, O05)', cmd: 'static', expect: 'O05: the since line counts up and nothing counts down',
    edits: [{ file: 'ui/today.js', find: '      const ms = Date.now() - base;', replace: '      const ms = base + 120000 - Date.now();' }] },
  { id: 'PD143', what: 'the feedback sheet opens only after a done last set, not a skipped one (r4.3 H8, EW4)', cmd: 'e2e_slice1_polish', expect: 'EW4 skipping the last set opens the feedback sheet',
    edits: [{ file: 'ui/today.js', find: "  if (sets.some(s => s.status === 'planned')) return;\n  const f = v.feedback", replace: "  if (sets.some(s => s.status === 'planned')) return;\n  if (sets[sets.length - 1].status !== 'done') return;\n  const f = v.feedback" }] },
  { id: 'PD144', what: 'the open row is the last planned row (r4.3 H8, DW1)', cmd: 'e2e_slice1_polish', expect: 'DW1 only the open row has controls, and it is the first planned row',
    edits: [{ file: 'ui/today.js', find: '  let open = planned.find(s => s.id === openId) || planned[0] || null;', replace: '  let open = planned.find(s => s.id === openId) || planned[planned.length - 1] || null;' }] },
  // The security review fixes (SR rows), from PD145 (the next free id after r4.3's PD144).
  { id: 'PD145', what: 'the exported_at range check dropped from the validator (SR1, SR10)', cmd: 'unit_backup', expect: 'SR1, SR10: an exported_at outside the time range refuses the file',
    edits: [{ file: 'backup.js', find: "  c.time(Date.parse(f.exported_at), 'exported_at');\n", replace: '' }] },
  { id: 'PD146', what: 'markBackedUp stores any marker (SR1, SR10 backstop)', cmd: 'unit_store', expect: 'SR1, SR10: a restore file with a far or old exported_at is refused',
    edits: [{ file: 'store.js', find: "    if (!markerOk(exportedMs, now())) throw new Refused('bad');\n", replace: '' }] },
  { id: 'PD147', what: 'the validator takes an id_map value that names a list row (SR2)', cmd: 'unit_backup', expect: 'SR2: an id_map value that names a list row',
    edits: [{ file: 'backup.js', find: "      if (exRow.get(v).custom !== true || seedIds.has(v)) bad('blocks: id_map names a row that is not a custom exercise');\n", replace: '' }] },
  { id: 'PD148', what: 'a block update reuses any phone row its id_map names (SR2)', cmd: 'unit_store', expect: 'SR2: a block update whose id_map names a list row',
    edits: [{ file: 'store.js', find: '      const mine = phoneId && phoneEx.has(phoneId) && phoneEx.get(phoneId).custom === true && !SEED_IDS.includes(phoneId);', replace: '      const mine = phoneId && phoneEx.has(phoneId);' }] },
  { id: 'PD149', what: 'createBlock saves a day label with no line check (SR5)', cmd: 'unit_store', expect: 'SR5, SR6: createBlock refuses a day label',
    edits: [{ file: 'store.js', find: "      if (!lineOk(d.label === undefined || d.label === null ? '' : d.label, LIMITS.LABEL)) throw new Refused('bad label');\n", replace: '' }] },
  { id: 'PD150', what: 'the one line rule back to tab, new line and carriage return only (SR6)', cmd: 'unit_backup', expect: 'SR6: a day label, a short note and a goal line holding NEL',
    edits: [{ file: 'backup.js', find: 'const BAD_LINE = /[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]/;', replace: 'const BAD_LINE = /[\\t\\n\\r]/;' }] },
  { id: 'PD151', what: 'saveExerciseText stores his text with no check (SR3, SR11)', cmd: 'unit_store', expect: 'SR3, SR11: typed text the validator would refuse is refused on every store path',
    edits: [{ file: 'store.js', find: "    checkText(field === 'notes' ? 'note' : 'link', value);\n", replace: '' }] },
  { id: 'PD152', what: 'addCustomExercise stores the name with no check (SR3, SR11)', cmd: 'unit_store', expect: 'SR3, SR11: typed text the validator would refuse is refused on every store path',
    edits: [{ file: 'store.js', find: "    checkText('name', spec.name);\n", replace: '' }] },
  { id: 'PD153', what: 'createBlock stores a lift note with no check (SR3, SR11)', cmd: 'unit_store', expect: 'SR3, SR11: typed text the validator would refuse is refused on every store path',
    edits: [{ file: 'store.js', find: "        checkText('note', l.note);\n", replace: '' }] },
  { id: 'PD154', what: 'saveFeedback stores the note with no check (SR3, SR11)', cmd: 'unit_store', expect: 'SR3, SR11: typed text the validator would refuse is refused on every store path',
    edits: [{ file: 'store.js', find: "    if (!pending) checkText('note', a.note);\n", replace: '' }] },
  { id: 'PD155', what: 'the feedback Save tap has no catch, so a refused save leaves the sheet stuck (SR3, SR11)', cmd: 'static', expect: 'SR3, SR11: the text sheet, the feedback sheet and Make my own exercise catch a refused save',
    edits: [{ file: 'ui/today.js', find: "      try { await ctx.store.saveFeedback(v.day.id, slot, a, false); } catch (e) { toast(t('today.notsaved')); return; }\n", replace: "      await ctx.store.saveFeedback(v.day.id, slot, a, false);\n" }] },
  { id: 'PD156', what: 'isLink takes a link with a user name or password (SR14)', cmd: 'unit_backup', expect: 'SR14: a link that shows one site and opens another is refused',
    edits: [{ file: 'backup.js', find: "    return u.protocol === 'https:' && u.username === '' && u.password === '' && u.hostname !== '';", replace: "    return u.protocol === 'https:' && u.hostname !== '';" }] },
  { id: 'PD157', what: 'Today opens a link by its own pattern, not the shared helper (SR14)', cmd: 'unit_store', expect: 'SR14: saveExerciseText refuses a link with a user name',
    edits: [{ file: 'ui/today.js', find: '    ex && ex.link && isLink(ex.link) ? linkTo(ex.link) : null);', replace: '    ex && ex.link && /^https:/.test(ex.link) ? linkTo(ex.link) : null);' }] },
  { id: 'PD158', what: 'buildBackup copies every settings row, restore_note too (SR7, SR15)', cmd: 'unit_backup', expect: 'SR7, SR15: a backup holds only known settings keys',
    edits: [{ file: 'backup.js', find: "  s.settings = s.settings.filter(r => r && SETTING_KEYS.includes(r.key));\n", replace: '' }] },
  { id: 'PD159', what: 'Swap takes a slot above SLOT_MAX (SR8)', cmd: 'unit_store', expect: 'SR8: Swap stops at SLOT_MAX, Add set and Add set below stop at SET_N_MAX',
    edits: [{ file: 'store.js', find: "    if (newSlot > LIMITS.SLOT_MAX) throw new Refused('no slot');\n", replace: '' }] },
  { id: 'PD160', what: 'Add set takes a set number above SET_N_MAX (SR8)', cmd: 'unit_store', expect: 'SR8: Swap stops at SLOT_MAX, Add set and Add set below stop at SET_N_MAX',
    edits: [{ file: 'store.js', find: "    if (n > LIMITS.SET_N_MAX) throw new Refused('no set');\n", replace: '' }] },
  { id: 'PD161', what: 'Add set below moves a row above SET_N_MAX (SR8)', cmd: 'unit_store', expect: 'SR8: Swap stops at SLOT_MAX, Add set and Add set below stop at SET_N_MAX',
    edits: [{ file: 'store.js', find: "      if (s.set_n + 1 > LIMITS.SET_N_MAX || same.some(x => x.set_n > s.set_n && x.set_n + 1 > LIMITS.SET_N_MAX)) throw new Refused('no set');\n", replace: '' }] },
  { id: 'PD162', what: 'the day id check dropped (SR9)', cmd: 'unit_backup', expect: 'SR9: a day, set or feedback id that does not match its own fields refuses the file',
    edits: [{ file: 'backup.js', find: "    if (d.id !== d.block_id + ':p' + d.pass + ':d' + d.day) bad('days: id does not match its block, round and day');\n", replace: '' }] },
  { id: 'PD163', what: 'the set id check dropped (SR9)', cmd: 'unit_backup', expect: 'SR9: a day, set or feedback id that does not match its own fields refuses the file',
    edits: [{ file: 'backup.js', find: "    if (!r.id.startsWith(pre) || !SET_TAIL_RE.test(r.id.slice(pre.length)) || !r.id.endsWith(':' + r.side)) bad('sets: id does not match its day, slot, kind and side');\n", replace: '' }] },
  { id: 'PD164', what: "the set's block is never tied to its day's block (SR9)", cmd: 'unit_backup', expect: 'SR9: a day, set or feedback id that does not match its own fields refuses the file',
    edits: [{ file: 'backup.js', find: "    if (r.block_id !== dayRow.get(r.day_id).block_id) bad('sets: block does not match its day');\n", replace: '' }] },
  { id: 'PD165', what: 'the feedback id check dropped (SR9)', cmd: 'unit_backup', expect: 'SR9: a day, set or feedback id that does not match its own fields refuses the file',
    edits: [{ file: 'backup.js', find: "    if (!/^[1-9]\\d*$/.test(n) || Number(n) > LIMITS.SLOT_MAX) bad('feedback: id does not match its day and slot');\n", replace: '' }] },
  { id: 'PD166', what: "setKey cuts the set id at the first :x again (SR9)", cmd: 'unit_store', expect: 'SR9: a block id that holds :x still keys every set write on its own day',
    edits: [{ file: 'store.js', find: "  const setKey = (setId) => { const m = SET_DAY_RE.exec(String(setId)); return dayKey(m ? m[1] : String(setId).split(':x')[0]); };", replace: "  const setKey = (setId) => dayKey(String(setId).split(':x')[0]);" }] },
  { id: 'PD167', what: 'a repeated day number in a block passes (SR12)', cmd: 'unit_backup', expect: 'SR12: a repeated day number or a repeated slot in one day refuses',
    edits: [{ file: 'backup.js', find: "    if (new Set(dayNs).size !== dayNs.length) bad(w + ': a day number repeats');\n", replace: '' }] },
  { id: 'PD168', what: 'a repeated slot in one day of a block passes (SR12)', cmd: 'unit_backup', expect: 'SR12: a repeated day number or a repeated slot in one day refuses',
    edits: [{ file: 'backup.js', find: "if (new Set(sl).size !== sl.length) bad(w + ': a slot number repeats in one day');", replace: "if (sl.length < 0) bad(w + ': a slot number repeats in one day');" }] },
  { id: 'PD169', what: 'createBlock saves a block with a repeated day number (SR12, store side)', cmd: 'unit_store', expect: 'SR12: createBlock refuses a repeated day number',
    edits: [{ file: 'store.js', find: "    if (new Set(dayNs).size !== dayNs.length) throw new Refused('bad block');\n", replace: '' }] },
  { id: 'PD170', what: 'the probe runs outside the exclusive job (SR15)', cmd: 'unit_store', expect: 'SR15: the phone check probe waits for a write in flight',
    edits: [{ file: 'store.js', find: "  function probe(stamp) {\n    return exclusive(async (job) => {", replace: "  function probe(stamp) {\n    return (async (job) => {" }, { file: 'store.js', find: "      return row ? row.value : null;\n    });\n  }", replace: "      return row ? row.value : null;\n    })({ write: attempt });\n  }" }] },
  { id: 'PD171', what: 'phone check row 4 runs the probe while a write is in flight (SR15)', cmd: 'static', expect: 'SR15: phone check row 4 goes through the store probe',
    edits: [{ file: 'ui/check.js', find: "  if (ctx.store.busy()) return result(UNSURE, '', t('check.row5.first'));\n", replace: '' }] },
  // The look flags (LB rows): layout only.
  { id: 'PD172', what: 'the Step 4 day line back to the 17px row with centered glyph (LB1, LOOK 4.6)', cmd: 'static', expect: 'LB1: the Step 4 day line is 15px',
    edits: [{ file: 'styles.css', find: '.row[data-dayempty]{font-size:var(--fs-small); gap:var(--s2); align-items:flex-start; padding-block:calc((var(--tap) - var(--fs-small) * var(--lh-body)) / 2)}', replace: '.row[data-dayempty]{gap:var(--s2); padding-block:calc((var(--tap) - var(--fs-small) * var(--lh-body)) / 2)}' }] },
  { id: 'PD173', what: 'the rep range line reads the 17px body size (LB2, LOOK 4.10)', cmd: 'static', expect: 'LB2: the rep range line is 15px --ink',
    edits: [{ file: 'styles.css', find: '#range-line{font-size:var(--fs-small); color:var(--ink)}', replace: '#range-line{color:var(--ink)}' }] },
  { id: 'PD174', what: 'the toast has no stack level, so a sheet hides it (LB3, LOOK 3.7)', cmd: 'static', expect: 'LB3: a toast sits above every sheet and scrim',
    edits: [{ file: 'styles.css', find: '.toast{z-index:30}\n', replace: '' }] },
  { id: 'PD175', what: 'the toast sits under an open sheet (LB3, LOOK 3.7, browser proof)', cmd: 'e2e_slice1_polish', expect: 'LB3 a toast fired with a sheet open is the top element at its center',
    edits: [{ file: 'styles.css', find: '.toast{z-index:30}\n', replace: '.toast{z-index:10}\n' }] },
  { id: 'PD176', what: 'the Day done tally draws its done work sets as ghosts (LB4, LOOK 3.9, 4.10)', cmd: 'e2e_slice1_polish', expect: 'polish: B3 the Day done tally draws six done work sets as a full group and one stroke, with no ghost',
    edits: [{ file: 'ui/today.js', find: 'fillTally(tally, Array.from({ length: totals.workDone }, () => true));', replace: 'fillTally(tally, Array.from({ length: totals.workDone }, () => false));' }] },
  // r4.4 planted rows (DESIGN 15, the r4.4 planted table). The table names PD176 for J9, but PD176 was
  // taken by the LB4 browser row (dc368d5) before this pass, so J9 takes the next free id, PD179.
  { id: 'PD177', what: 'a toast key over 120 characters (14.10 J7)', cmd: 'static', expect: 'J7: every toast key fits three lines (120 characters or fewer)',
    edits: [{ file: 'ui/strings.js', find: "'today.finish.none': 'No set is done yet. To end this day, use Skip day in the day menu.',", replace: "'today.finish.none': 'No set is done yet. To end this day, use Skip day in the day menu. No set is done yet. To end this day, use Skip day in the day menu.'," }] },
  { id: 'PD178', what: 'the hip in lift moves from legs to core (14.10 J8, X03)', cmd: 'static', expect: 'X03: the list keeps six muscle groups, and the hip in and hip out lifts sit under legs',
    edits: [{ file: 'data/exercises.js', find: "row('hip_adduction', 'Hip in (machine)', 'legs', 'machine'),", replace: "row('hip_adduction', 'Hip in (machine)', 'core', 'machine')," }] },
  { id: 'PD179', what: 'buildBackup spreads the log into Math.min again (14.10 J9, SR13)', cmd: 'static', expect: 'SR13: no shipped file spreads a list into Math.min or Math.max',
    edits: [{ file: 'backup.js', find: 'flat_log_since: firsts.length ? isoLocal(minOf(firsts)) : null,', replace: 'flat_log_since: firsts.length ? isoLocal(Math.min(...firsts)) : null,' }] },
  // Security read 2 (SB1 to SB5), next free ids from PD180.
  { id: 'PD180', what: 'a refused backup marker skips settled(), so the share stays on (SB1, SB6)', cmd: 'unit_today', expect: 'SB1: a backup marker that throws still ends the share',
    edits: [{ file: 'ui/dom.js', find: '  try { await store.markBackedUp(ms); } catch (e) { ok = false; if (onFail) onFail(e); } finally { settled(); }', replace: '  await store.markBackedUp(ms); settled();' }] },
  { id: 'PD181', what: 'a block file exercise may take a list id again (SB2)', cmd: 'unit_backup', expect: 'SB2: a block file whose own exercise uses a list id is refused as badref',
    edits: [{ file: 'backup.js', find: "      if (seeds.has(e.id)) throw new BadFile('local id is a list id', 'badref');\n", replace: '' }] },
  { id: 'PD182', what: 'addCustomExercise stores any muscle or equipment value (SB3)', cmd: 'unit_store', expect: 'SB3: addCustomExercise refuses a muscle or an equipment value outside the fixed lists',
    edits: [{ file: 'store.js', find: "    if (!MUSCLES.includes(spec.muscle) || !EQUIPMENT.includes(spec.equipment)) throw new Refused('bad text');\n", replace: '' }] },
  { id: 'PD183', what: 'a whole-database job reads with no limit, so a hung read holds the gate for good (SB4)', cmd: 'unit_store', expect: 'SB4: a Finish day whose read never answers ends as Not saved',
    edits: [{ file: 'store.js', find: '      arm();\n      Promise.resolve().then(() => fn(job)).then(', replace: '      Promise.resolve().then(() => fn(job)).then(' }] },
  { id: 'PD184', what: 'a job cut off by the read limit still writes when its read answers late (SB4, no fence)', cmd: 'unit_store', expect: 'SB4: a Finish day whose read never answers ends as Not saved',
    edits: [{ file: 'store.js', find: '          if (job.aborted) throw new NotSaved();\n', replace: '' }] },
  { id: 'PD185', what: 'a block update that drops a lift keeps that slot feedback row (SB5, store)', cmd: 'unit_store', expect: 'SB5: a check answer on a planned day, then a block update that drops the lift, leaves no feedback row',
    edits: [{ file: 'store.js', find: "      if (!slots.has(Number(String(f.id).split(':x').pop()))) ops.push({ store: 'feedback', del: f.id });\n", replace: '' }] },
  { id: 'PD186', what: 'Finish day asks a pending row whose slot holds no set (SB5, Today loop)', cmd: 'unit_today', expect: 'SB5: Finish day passes over a pending feedback row whose slot holds no set',
    edits: [{ file: 'ui/today.js', find: '      if (!v.sets.some(s => s.slot === slot)) continue;\n', replace: '' }] },
  { id: 'PD187', what: 'the feedback sheet opens on a slot with no set (SB5, sheet)', cmd: 'unit_today', expect: 'SB5: Finish day passes over a pending feedback row whose slot holds no set',
    edits: [{ file: 'ui/today.js', find: '    if (!sets.length) { resolve(); return; }\n', replace: '' }] },
  { id: 'PD188', what: 'a second glyph put in by appendChild, outside any classed el() call and not on the list (HN5, LF13)', cmd: 'static', expect: 'LF13: every glyph inside a button, row, pill or heading has a width and height rule',
    edits: [{ file: 'ui/today.js', find: "      if (noask) mark.appendChild(glyph('check'));\n", replace: "      if (noask) mark.appendChild(glyph('check'));\n      mark.appendChild(glyph('cross'));\n" }] },
  { id: 'PD189', what: 'the R16 switch rule put back before .row, where .row wins on the hairline, padding and centering (G15, LOOK 4.9)', cmd: 'static', expect: 'G15: the hairline sits under each switch helper line',
    edits: [{ file: 'styles.css', find: '.switch-row{border-bottom:0; align-items:flex-start; padding-block:calc((var(--tap) - var(--switch-h)) / 2)}\n', replace: '' },
      { file: 'styles.css', find: 'background:none; border:0}\n.switch{', replace: 'background:none; border:0; border-bottom:0; align-items:flex-start; padding-block:calc((var(--tap) - var(--switch-h)) / 2)}\n.switch{' }] },
  { id: 'PD190', what: 'the tab-mode Back link on Phone check loses its back glyph (G16, LOOK 4.2 R17)', cmd: 'static', expect: 'G16: the tab-mode Back link on Phone check takes the back glyph',
    edits: [{ file: 'ui/check.js', find: "id: 'check-back' }, glyph('back'), t('check.backtab'))", replace: "id: 'check-back' }, t('check.backtab'))" }] },
  { id: 'PD191', what: 'the Phone check storage banner back between the title and the subtitle (G17, LOOK 4.2)', cmd: 'static', expect: 'G17: on Phone check the storage banner sits under the subtitle',
    edits: [{ file: 'ui/check.js', find: "    el('p', { class: 'lead' }, t('check.sub')),\n    storageBox,\n", replace: "    storageBox,\n    el('p', { class: 'lead' }, t('check.sub')),\n" }] },
  // Slice 2, B.1 step 3 (16 B.13; r4.4 R11, R32).
  { id: 'M87', what: 'the migration drops done.breaks (R32)', cmd: 'unit_migrate', expect: 'MIGRATIONS[1](backup_v1_polish) deep-equals backup_v1_polish_as_v2.json',
    edits: [{ file: 'backup.js', find: "    return { ...x, set_type: 'normal', set_type_by_hand: false,", replace: "    if (x.done) { x = { ...x, done: { ...x.done } }; delete x.done.breaks; }\n    return { ...x, set_type: 'normal', set_type_by_hand: false," }] },
  { id: 'PD192', what: "MIGRATIONS[1] maps 'Not done' to 'why.not_done', a key not in WHY_KEYS (r4.4 R11)", cmd: 'unit_migrate', expect: 'backup_v1 reads as schema 2 rows that pass every B.6.1a check',
    edits: [{ file: 'backup.js', find: "'Not done': 'why.notdone'", replace: "'Not done': 'why.not_done'" }] },
  // Slice 2, B.1 step 4 (16 B.13 M38, the store test half; the e2e half is the e2e.py --suite upgrade abort case).
  { id: 'M38', what: 'MIGRATIONS[1] throws half way and the upgrade is not aborted', cmd: 'unit_store', expect: 'upgrade: a migration that throws leaves schema 1 rows deep-equal (M38)',
    edits: [
      { file: 'backup.js', find: '  if (Array.isArray(s.sets)) s.sets = s.sets.map(x => {\n', replace: "  if (Array.isArray(s.sets)) s.sets = s.sets.map((x, i, all) => {\n    if (i === Math.floor(all.length / 2)) throw new Error('planted throw half way');\n" },
      { file: 'db.js', find: '  const out = hook(data);\n', replace: '  let out;\n  try { out = hook(data); } catch (e) { return { ops: [], counts: {} }; }\n' }] },
  // Slice 2, B.1 step 5 core (16 B.13; r4.4 rows with no id take the next free PD id).
  { id: 'M77', what: 'the short-sleep failure goal applied in adaptive only (R8, R31)', cmd: 'unit_store', expect: 'sleep: in Fixed a Yes sets the failure set goal to 2',
    edits: [{ file: 'engine.js', find: '      const goal = (n) => (shortSleep && lift.slot === failSlot && n === lift.sets ? markGoal : lift.reps_left_target);', replace: '      const goal = (n) => (shortSleep && !isFixed(rules) && lift.slot === failSlot && n === lift.sets ? markGoal : lift.reps_left_target);' }] },
  { id: 'M80', what: 'a sleep Yes on a planned day does not re-plan (R6)', cmd: 'unit_store', expect: 'sleep: R8 day, a Yes on the card brings the planned count back',
    edits: [{ file: 'store.js', find: '      const planOps = block ? await planDayOps(block, day.pass, day.day, { overlay: [dayOp] }) : [];', replace: '      const planOps = [];' }] },
  { id: 'M83', what: 'rulesFor plans an adaptive block before 2026-12-01 (R11)', cmd: 'unit_store', expect: 'rulesFor: a restored adaptive block on 2026-11-30 local plans as Fixed',
    edits: [{ file: 'store.js', find: "  if (localDate(nowMs) < ADJUST_FIRST_DATE) return 'fixed';\n", replace: '' }] },
  { id: 'M85', what: 'the guard compares set_type with the template lift (R14)', cmd: 'unit_store', expect: "R14: a block file update that changes the failure lift's load reaches the planned failure set",
    edits: [{ file: 'store.js', find: "if (was && (!writable(was) || was.origin === 'added' || was.set_type_by_hand === true)) continue;", replace: "if (was && (!writable(was) || was.origin === 'added' || was.set_type !== (lift.set_type || 'normal'))) continue;" }] },
  { id: 'M86', what: 'a re-plan leaves two rows on one set_n (R15)', cmd: 'unit_store', expect: 'R15: a re-plan after Add set on a planned day keeps set_n unique and in order',
    edits: [{ file: 'store.js', find: "          if (s.set_n !== to) ops.push({ store: 'sets', put: { ...s, set_n: to } });\n", replace: '' }] },
  { id: 'M92', what: 'a block file update leaves sleep_hint old (R18)', cmd: 'unit_store', expect: 'M92: a block file update changes sleep_hint',
    edits: [{ file: 'store.js', find: '      switch_conditions: nb.switch_conditions, sleep_hint: nb.sleep_hint, flag_questions:', replace: '      switch_conditions: nb.switch_conditions, flag_questions:' }] },
  { id: 'PD193', what: "addedRow writes the text 'Added by you' again (r4.4 R4)", cmd: 'static', expect: 'no shipped file but backup.js names a Slice 1 why text',
    edits: [{ file: 'store.js', find: "first_done_at: null, why: 'why.added',", replace: "first_done_at: null, why: 'Added by you'," }] },
  { id: 'PD194', what: "answerSleep queued under the key 'sleep' in place of its day key (r4.4 R7)", cmd: 'unit_store', expect: 'R15b: a sleep answer and a first tick on one day land in tap order',
    edits: [{ file: 'store.js', find: "    await queued(dayKey(dId), async () => {\n      const day = await db.get('days', dId);\n      if (!day) throw new Refused('no such day');\n      if (day.status !== 'planned')", replace: "    await queued('sleep', async () => {\n      const day = await db.get('days', dId);\n      if (!day) throw new Refused('no such day');\n      if (day.status !== 'planned')" }] },
  // Slice 2, B.1 step 5 rest (16 B.13; the r4.4 R7 liveEdit row takes the next free PD id, PD195).
  { id: 'M27', what: 'Adjust each round can be chosen on 2026-11-30', cmd: 'unit_store', expect: 'switch: refused at 2026-11-30 23:59 local, accepted at 2026-12-01 00:00 local',
    edits: [{ file: 'store.js', find: "      if (localDate(t) < ADJUST_FIRST_DATE) throw new Refused('too early');\n", replace: '' }] },
  { id: 'M39', what: 'switchProfile skips the typed word check', cmd: 'unit_store', expect: 'switch: refused with 2 ticks or the word "adjust"',
    edits: [{ file: 'store.js', find: "    if (typeof typed !== 'string' || typed.trim() !== ADJUST_WORD) return Promise.reject(new Refused('word'));\n", replace: '' }] },
  { id: 'M88', what: 'Change answers turns a true check to false (R20)', cmd: 'unit_store', expect: 'Change answers never turns a true check into false (M88)',
    edits: [{ file: 'store.js', find: '        checks[k] = checks[k] === true ? true : v;\n', replace: '        checks[k] = v;\n' }] },
  { id: 'M84s', what: "a rest swap in the store keeps the block's old checks[].lifts (review R13, store half)", cmd: 'unit_store', expect: 'R13: a check scoped to a custom lift survives a Rest of block swap and a remove',
    edits: [{ file: 'store.js', find: '        const nb = { ...eng.block, day_templates: fullTemplates(eng.block.day_templates) };\n', replace: '        const nb = { ...eng.block, checks: block.checks, day_templates: fullTemplates(eng.block.day_templates) };\n' }] },
  { id: 'PD195', what: "liveEdit with 'rest' runs in queued('block') in place of exclusive() (r4.4 R7)", cmd: 'unit_store', expect: 'R15a: a tick queued right after a Rest of block edit starts lands after it and is kept',
    edits: [{ file: 'store.js', find: "  function liveRest(e, dId, label) {\n    return exclusive(async (job) => {\n", replace: "  function liveRest(e, dId, label) {\n    return queued('block', async () => {\n      const job = { write: (w) => w() };\n" }] },
  // ---------------- Slice 2 B.1 step 7, the Today parts (16 B.5; next free PD ids, r4.4 R27) ----------------
  { id: 'PD196', what: 'canAdd reads no_added_sets only and lets an unscreened lift gain a set (B.1 step 7 b)', cmd: 'unit_today', expect: 'Slice 2 canAdd',
    edits: [{ file: 'ui/today.js', find: '  return !(e.no_added_sets === true || e.flags_set === false);\n', replace: '  return !(e.no_added_sets === true);\n' }] },
  { id: 'PD197', what: 'the planned failure set gets a met or missed mark (B.5 row 5)', cmd: 'unit_today', expect: 'Slice 2 met and missed marks',
    edits: [{ file: 'ui/today.js', find: '  if (tg.effort_only === true || tg.failure_set === true) return null;\n', replace: '  if (tg.effort_only === true) return null;\n' }] },
  { id: 'PD198', what: 'Add an exercise stays in the day menu on a full day (B.5 row 17)', cmd: 'unit_today', expect: 'Slice 2 day menu',
    edits: [{ file: 'ui/today.js', find: 'liveLifts(sets) < LIMITS.LIFTS_PER_DAY', replace: 'liveLifts(sets) <= LIMITS.LIFTS_PER_DAY' }] },
  { id: 'PD199', what: 'the steppers skip the signed default steps (B.1 step 7 a)', cmd: 'unit_today', expect: 'Slice 2 loadStep reads the signed default steps',
    edits: [{ file: 'ui/today.js', find: '  if (d.length) return { size: d[0] };\n', replace: '' }] },
  { id: 'PD200', what: 'the retarget line drops the effort part (B.5 row 13)', cmd: 'unit_today', expect: 'Slice 2 retarget line',
    edits: [{ file: 'ui/today.js', find: "  if (typeof r.rep_low === 'number') return t('today.retarget', { low: r.rep_low }) + effortPart(s);", replace: "  if (typeof r.rep_low === 'number') return t('today.retarget', { low: r.rep_low });" }] },
  { id: 'PD201', what: 'met and missed marks show on a Fixed block (B.5 row 5)', cmd: 'static', expect: 'Slice 2: the marks, the why line',
    edits: [{ file: 'ui/today.js', find: 'const mk = adaptive(v) ? markOf(s) : null;', replace: 'const mk = markOf(s);' }] },
  { id: 'PD202', what: 'the why line shows on a Fixed block (B.5 row 12)', cmd: 'static', expect: 'Slice 2: the marks, the why line',
    edits: [{ file: 'ui/today.js', find: 'const whyLine = adaptive(v) && why && ', replace: 'const whyLine = why && ' }] },
  { id: 'PD203', what: 'tapping the picked sleep chip cannot clear it (B.5 row 1)', cmd: 'static', expect: 'Slice 2: the sleep hint is his words',
    edits: [{ file: 'ui/today.js', find: 'ctx.store.answerSleep(day.id, cur === val ? null : val)', replace: 'ctx.store.answerSleep(day.id, val)' }] },
  { id: 'PD204', what: 'the soreness-alone sheet opens on a Fixed block (B.5 row 9)', cmd: 'static', expect: 'Slice 2: the marks, the why line',
    edits: [{ file: 'ui/today.js', find: 'if (adaptive(v) && firstOfSlot) {', replace: 'if (firstOfSlot) {' }] },
  { id: 'PD205', what: 'the end sheet reads the store plan on a Fixed block (B.4.4)', cmd: 'unit_today', expect: 'Slice 2 end sheet questions',
    edits: [{ file: 'ui/today.js', find: "  if (!adaptive(v)) return null;\n  const fid = v.day.id + ':x' + slot;\n  const plan", replace: "  const fid = v.day.id + ':x' + slot;\n  const plan" }] },
  { id: 'PD206', what: 'an Adjust each round swap is written Today only before the scope sheet (B.5 row 10)', cmd: 'unit_today', expect: 'Slice 2 the picker pick',
    edits: [{ file: 'ui/today.js', find: "  if (p.mode === 'swap' && !p.scoped) {", replace: "  if (p.mode === 'swap') {" }] },
  { id: 'PD207', what: 'Change answers offered on a pending feedback row (B.5 row 8)', cmd: 'unit_today', expect: 'Slice 2 card menu',
    edits: [{ file: 'ui/today.js', find: '  return f && f.pending === false ? f : null;\n', replace: '  return f || null;\n' }] },
  { id: 'PD208', what: 'a pending row with no soreness counts as still owed (B.5 row 9)', cmd: 'unit_today', expect: 'Slice 2 a row the soreness-alone sheet made',
    edits: [{ file: 'ui/today.js', find: 'f.pending === true && f.soreness !== null && f.pump === null', replace: 'f.pending === true && f.pump === null' }] },
  { id: 'PD209', what: 'loadStep skips the block step size, so it parts from stepFor (B.1 step 7 a)', cmd: 'static', expect: 'loadStep and stepFor give the same step',
    edits: [{ file: 'ui/today.js', find: "  if (ex && typeof ex.step === 'number' && ex.step > 0) return { size: ex.step };\n  if (unit !== 'kg' && ex && typeof ex.step_default", replace: "  if (unit !== 'kg' && ex && typeof ex.step_default" }] },
  // The e2e rows of step 7 (cmd e2e_slice2, HEAVY): proven by the lead's mutants.js run.
  { id: 'PD210', what: 'after Close block Today shows the planned day, not Block finished (B.5 row 7)', cmd: 'e2e_slice2', expect: 'close block: Today shows the Block finished state',
    edits: [{ file: 'ui/today.js', find: '  if (!day || closed) {\n', replace: '  if (!day) {\n' }] },
  { id: 'PD211', what: 'the Rest of block chip writes Today only (B.5 row 10)', cmd: 'e2e_slice2', expect: 'rest of block: a later planned day shows the new exercise',
    edits: [{ file: 'ui/today.js', find: "    rest.addEventListener('click', () => pick('rest', rest));\n", replace: "    rest.addEventListener('click', () => pick('today', rest));\n" }] },
  { id: 'PD212', what: 'a To failure set shows no pill in the helper slot (B.5 row 11)', cmd: 'e2e_slice2', expect: 'set kind: To failure shows its pill',
    edits: [{ file: 'ui/today.js', find: "  if (s.kind !== 'work' || !s.set_type || s.set_type === 'normal' ||", replace: "  if (true || s.kind !== 'work' || !s.set_type || s.set_type === 'normal' ||" }] },
  { id: 'PD213', what: 'Change answers closes without saving (B.5 row 8)', cmd: 'e2e_slice2', expect: 'change answers: Save writes the new answer',
    edits: [{ file: 'ui/today.js', find: "        try { await ctx.store.changeAnswers(change.id, a); } catch (e) { toast(t('today.notsaved')); return; }\n", replace: '' }] },
  { id: 'PD214', what: 'the soreness-alone sheet never opens (B.5 row 9)', cmd: 'e2e_slice2', expect: "soreness sheet: alone at round 2 day A's first tick in Adjust each round",
    edits: [{ file: 'ui/today.js', find: "    if (soreAsk) await soreSheet(ctx, v, s.slot);\n", replace: '' }] },
  // ---------------- Slice 2, B.1 steps 8 and 9 (16 B.13 M40, then the next free PD ids) ----------------
  { id: 'PD215', what: 'the Adjust each round row is put in without the store switch check (16 B.9, M27 screen half)', cmd: 'static', expect: 'Slice 2: the Adjust each round row is in the DOM only',
    edits: [{ file: 'ui/settings.js', find: '  if (await store.switchAllowed(block.id)) {\n', replace: '  if (true) {\n' }] },
  { id: 'PD216', what: 'the switch sheet enables its primary without the typed word (16 B.9)', cmd: 'unit_today', expect: 'Slice 2 Adjust each round: three ticks',
    edits: [{ file: 'ui/settings.js', find: ' && String(typed).trim() === ADJUST_WORD;', replace: ';' }] },
  { id: 'PD217', what: 'the read-only day view takes a place past the last round (16 B.10 item 9)', cmd: 'unit_store', expect: 'dayPreview: a day row gives its state',
    edits: [{ file: 'store.js', find: '    if (!tpl || pass > last || dayId(', replace: '    if (!tpl || dayId(' }] },
  { id: 'PD218', what: 'the stop sheet count takes a skipped hard day as not finished (16 B.5 row 4)', cmd: 'unit_store', expect: 'blockOverview: a shown round gives its day rows',
    edits: [{ file: 'store.js', find: "          if (!row || (row.status !== 'done' && row.status !== 'skipped')) hardLeft++;", replace: "          if (!row || row.status !== 'done') hardLeft++;" }] },
  { id: 'PD219', what: 'Phone check drops the rules Error fact line (16 B.2 note 5)', cmd: 'static', expect: 'Slice 2: Phone check prints the rules fact',
    edits: [{ file: 'ui/check.js', find: "    if (ctx.store && !ctx.store.rulesOk()) factsBox.appendChild(factRow(t('settings.rules'), t('check.error'), 'rules'));\n", replace: '' }] },
  { id: 'PD220', what: 'the change from last round loses its plus sign (LOOK 4.7)', cmd: 'unit_today', expect: 'Slice 2 Block tab: the day row word',
    edits: [{ file: 'ui/block.js', find: "  return change > 0 ? '+' + change : String(change);", replace: '  return String(change);' }] },
  { id: 'PD221', what: 'a bad #/day/ id goes to Today, not the Block tab (16 B.10 item 9)', cmd: 'static', expect: 'Slice 2: the #/day/ route goes through the store check',
    edits: [{ file: 'ui/block.js', find: "  if (!p) { ctx.go('#/block'); return; }\n", replace: "  if (!p) { ctx.go('#/today'); return; }\n" }] },
  // The e2e rows of steps 8 and 9 (cmd e2e_slice2, HEAVY): proven by the lead's mutants.js run.
  { id: 'M40', what: 'an easy-round day opens with a hard day still open (16 B.13)', cmd: 'e2e_slice2', expect: 'stop sheet: an easy-round day opened from the Block tab while round 3 day B is open',
    edits: [{ file: 'ui/block.js', find: '  if (n > 0) { easySheet(ctx, n); return; }\n', replace: '' }] },
  { id: 'PD222', what: 'a skipped day opened from the Block tab draws a tick button (16 B.12 d, r4 review R47)', cmd: 'e2e_slice2', expect: '(d) read only: a skipped day opened from the Block tab',
    edits: [{ file: 'ui/block.js', find: "    : state === 'skipped' ? el('span', { class: 'tick', 'aria-hidden': 'true' }, el('span', { class: 'ring' }, glyph('skip')))", replace: "    : state === 'skipped' ? el('button', { class: 'tick', type: 'button', 'data-tick': s.id }, el('span', { class: 'ring' }, glyph('skip')))" }] },
  // Slice 3 (17 C.3.10, LOOK 4.7): the muscle table moved off the Block overview to the summary, so
  // PD223 now plants its defect there (the table loses a round column) and the slice3 summary part catches it.
  { id: 'PD223', what: 'the summary sets-per-muscle table drops the last round column (17 C.3.10, was the 16 B.12 e change line)', cmd: 'e2e_slice3', expect: 'S14 S15: mid block the summary shows the day counts and a per-round sets-per-muscle table',
    edits: [{ file: 'ui/history.js', find: "r.cells.map(c => el('td', { class: 'num' }, String(c)))", replace: "r.cells.slice(0, -1).map(c => el('td', { class: 'num' }, String(c)))" }] },
  { id: 'PD224', what: 'the Adjust each round row shows at 2026-11-20 (16 B.12 a, M27 e2e half)', cmd: 'e2e_slice2', expect: '(a) settings: the Adjust each round row is not in the DOM at 2026-11-20',
    edits: [{ file: 'store.js', find: "block.profile === 'fixed' && RULES_OK_HERE && localDate(now()) >= ADJUST_FIRST_DATE;", replace: "block.profile === 'fixed' && RULES_OK_HERE;" }] },
  // B.1 step 11 (cmd e2e_upgrade, HEAVY): the e2e half of M38 (16 B.13). The upgrade suite's abort
  // case serves its own scratch 0.3.0 copy with MIGRATIONS[1] throwing; with this row db.js swallows
  // the throw, the upgrade goes through, and the case must fail.
  { id: 'PD225', what: 'db.js lets the version 2 upgrade finish when MIGRATIONS[1] throws (16 B.13 M38, the e2e half)', cmd: 'e2e_upgrade', expect: '(5) abort: with MIGRATIONS[1] throwing, the open fails with db.upgradefail',
    edits: [{ file: 'db.js', find: '  const out = hook(data);\n', replace: '  let out;\n  try { out = hook(data); } catch (e) { return { ops: [], counts: {} }; }\n' }] },
  { id: 'PD226', what: 'the Add an exercise sets stepper names its minus button by the rep word again (r4.5 ruling 1)', cmd: 'static', expect: 'r4.5 ruling 1: the Add an exercise sets stepper names its buttons by addex.less and addex.more, never the rep words',
    edits: [{ file: 'ui/today.js', find: "id: 'addex-less', 'aria-label': t('addex.less')", replace: "id: 'addex-less', 'aria-label': t('step.reps.less')" }] },
  // ---------------- the rules engine (DESIGN 16 B.13), each with the test that must fail ----------------
  { id: 'M1', what: 'add cap off by one (add_per_pass_max + 1)', cmd: 'unit_rules', expect: 'T26',
    edits: [{ file: 'engine.js', find: '  request = clamp(request, -caps.cut_per_pass_max, caps.add_per_pass_max);', replace: '  request = clamp(request, -caps.cut_per_pass_max, caps.add_per_pass_max + 1);' }] },
  { id: 'M2', what: 'nextWeekSets flips the sign of delta', cmd: 'unit_rules', expect: 'T01',
    edits: [{ file: 'engine.js', find: '  let request = rowDelta;', replace: '  let request = -rowDelta;' }] },
  { id: 'M3', what: 'easyWeekPlan keeps full sets', cmd: 'unit_rules', expect: 'T35',
    edits: [{ file: 'engine.js', find: '    const sets = Math.min(ew.set_factor, s.sets);', replace: '    const sets = s.sets;' }] },
  { id: 'M4', what: 'nextLoadTarget adds 5 and ignores the step list', cmd: 'unit_rules', expect: 'T32',
    edits: [{ file: 'engine.js', find: '  const up = met ? stepUp(step, doneLoad) : null;', replace: '  const up = met && num(doneLoad) ? doneLoad + 5 : null;' }] },
  { id: 'M5', what: 'load added when one work set missed its goal', cmd: 'unit_rules', expect: 'T33',
    edits: [
      { file: 'engine.js', find: '  const missed = missedIn(last);\n', replace: '  const missed = false;\n' },
      { file: 'engine.js', find: 'goals.length > 0 && goals.every(', replace: 'goals.length > 0 && goals.some(' }] },
  { id: 'M6', what: 'R11 removed from set_rules.rows', cmd: 'unit_rules', expect: 'validateRules is clean on both shipped profiles',
    edits: [{ file: 'rules.js', find: /\n  \{ id: 'R11', +when: \{\}, +delta: 0, +why: 'why\.R11' \}/, replace: '' }] },
  { id: 'M10e', what: 'engine.js dropped from SHELL', cmd: 'static', expect: 'SHELL equals the git shell list',
    edits: [{ file: 'sw.js', find: "  'engine.js',\n", replace: '' }] },
  { id: 'M28', what: 'a null sleep answer treated as false', cmd: 'unit_rules', expect: 'T18',
    edits: [{ file: 'engine.js', find: 'sleep.some(v => v !== false)', replace: 'sleep.some(v => v === true)' }] },
  { id: 'M29', what: 'sleep gate off: a true answer does not block', cmd: 'unit_rules', expect: 'T17',
    edits: [{ file: 'engine.js', find: "    else if (caps.no_add_after_short_sleep && sleep.some(v => v !== false)) gate = 'sleep';", replace: "    else if (false) gate = 'sleep';" }] },
  { id: 'M30', what: 'check gate off (check_yes ignored)', cmd: 'unit_rules', expect: 'T20',
    edits: [{ file: 'engine.js', find: "    else if (caps.no_add_if_check_yes && ctx.check_yes === true) gate = 'check';", replace: "    else if (false) gate = 'check';" }] },
  { id: 'M31', what: 'score band back to 7 to 10', cmd: 'unit_rules', expect: 'T06',
    edits: [{ file: 'rules.js', find: 'score_max: [5, 6, 7, 8, 9, 10]', replace: 'score_max: [7, 8, 9, 10]' }] },
  { id: 'M32', what: 'missed gate off', cmd: 'unit_rules', expect: 'T39',
    edits: [{ file: 'engine.js', find: "    else if (caps.no_add_if_missed && ctx.missed === true) gate = 'missed';", replace: "    else if (false) gate = 'missed';" }] },
  { id: 'M33', what: 'top clamp uses 4', cmd: 'unit_rules', expect: 'T15',
    edits: [{ file: 'engine.js', find: '  let sets = clamp(base + request, caps.min_sets, caps.top_sets);', replace: '  let sets = clamp(base + request, caps.min_sets, caps.top_sets + 1);' }] },
  { id: 'M34', what: 'hand add summed with the row delta', cmd: 'unit_rules', expect: 'T22',
    edits: [{ file: 'engine.js', find: "  if (ctx.hand_add === 'rest' && rowDelta >= 0 && request < 1) { request = 1; byHand = true; }", replace: "  if (ctx.hand_add === 'rest') { request = request + 1; byHand = true; }" }] },
  { id: 'M35', what: 'hand add skips the gates', cmd: 'unit_rules', expect: 'T23',
    edits: [{ file: 'engine.js', find: '  if (request > 0) {\n    const sleep', replace: '  if (request > 0 && !byHand) {\n    const sleep' }] },
  { id: 'M36', what: 'soreness asked at the end in Adjust each round', cmd: 'unit_engine', expect: 'feedbackDue: soreness alone at the first tick',
    edits: [{ file: 'engine.js', find: '    if (atFirstTick && c.trained_before === true', replace: '    if (false && c.trained_before === true' }] },
  { id: 'M37', what: "a 'rest' live edit re-plans a done day", cmd: 'unit_engine', expect: 'a done day is never touched',
    edits: [{ file: 'engine.js', find: "  const replan = (p.later || []).filter(d => d.status === 'planned' && !(", replace: '  const replan = (p.later || []).filter(d => !(' }] },
  { id: 'M41', what: 'on_two_misses acts like on_miss', cmd: 'unit_rules', expect: 'T42',
    edits: [{ file: 'engine.js', find: "  if (twoMisses && L.on_two_misses === 'step_down') {", replace: '  if (false) {' }] },
  { id: 'M42', what: 'the failure set counts as a miss', cmd: 'unit_rules', expect: 'T44',
    edits: [{ file: 'engine.js', find: "s.status === 'done' && s.done && !s.failure && s.target", replace: "s.status === 'done' && s.done && s.target" }] },
  { id: 'M43', what: 'an unflagged custom lift can gain a set', cmd: 'unit_rules', expect: 'T21',
    edits: [{ file: 'engine.js', find: "    if (ctx.no_added_sets === true || ctx.flags_set !== true) gate = 'flag';", replace: "    if (ctx.no_added_sets === true) gate = 'flag';" }] },
  { id: 'MF1', what: 'the Fixed profile plans through the adjust path', cmd: 'unit_rules', expect: 'the Fixed profile never changes a set',
    edits: [{ file: 'engine.js', find: '  if (isFixed(rules) || pass === 1) {', replace: '  if (pass === 1) {' }] },
  // r4.1 line-up rows (DESIGN 16 B.13 M78 to M84 engine parts; ME rows are extra engine rows for the B.1 step 0 items with no M id).
  // r4.2 X2 guard rows (DESIGN 16 B.13). M76 left OWED_ROWS: the wider word rule now finds a
  // joined listed term. The term is read from the private list at run time, so this file never holds it.
  { id: 'M76', what: 'a joined listed term planted as a key in rules.js (review R1)', cmd: 'guard', expect: 'personal word',
    edits: [{ file: 'rules.js', find: '  short_sleep_hours: 6,', replace: () => '  ' + listTerm('personal_words.txt', t => /^[a-z]+ [a-z]+$/i.test(t)).replace(/ /g, '_') + '_x: 6,\n  short_sleep_hours: 6,' }] },
  { id: 'M94', what: 'the wider wordRe reverted to whole words (r4.2 X2)', cmd: 'guard_self', expect: 'self-test: (a)',
    edits: [{ file: 'scripts/tests/repo_guard.js', find: "const widen = (s) => s.replace(/ /g, '[ _-]?');", replace: 'const widen = (s) => s;' }] },
  { id: 'M95', what: 'the publish scope skips refs/heads/public (r4.2 X2)', cmd: 'guard_self', expect: 'self-test: (b)',
    edits: [{ file: 'scripts/tests/repo_guard.js', find: "  if (scope === 'publish') return pub ? [PUBLIC_REF] : null;\n  return pub ? ['--all', '--not', PUBLIC_REF] : ['--all'];", replace: "  if (scope === 'publish') return null;\n  return ['--all'];" }] },
  { id: 'M96', what: 'a wider-only hit in a local-only blob made to fail (r4.2 X2)', cmd: 'guard_self', expect: 'self-test: (c)',
    edits: [{ file: 'scripts/tests/repo_guard.js', find: "      if (scope === 'publish') hits.push(...found.wider);", replace: '      if (true) hits.push(...found.wider);' }] },
  // Stage 4 A1 (14.8 CHANGE A1): a trap bar row back under Other.
  { id: 'M97', what: 'one trap bar row put back to equipment other (14.8 CHANGE A1, C17)', cmd: 'static', expect: 'every trap bar row is a barbell row',
    edits: [{ file: 'data/exercises.js', find: "row('trap_bar_deadlift', 'Trap bar deadlift', 'back', 'barbell',", replace: "row('trap_bar_deadlift', 'Trap bar deadlift', 'back', 'other'," }] },
  { id: 'M98', what: 'the local-only wider hit ceiling removed (stage 4 N9, DESIGN 4.7 row 1)', cmd: 'guard_self', expect: 'self-test: (f)',
    edits: [{ file: 'scripts/tests/repo_guard.js', find: '  if (widerLocal.length > MAX_LOCAL_WIDER) hits.push(', replace: '  if (false) hits.push(' }] },
  { id: 'M78', what: 'the score gate off for a hand add (review R4)', cmd: 'unit_rules', expect: 'score gate',
    edits: [{ file: 'engine.js', find: "    else if (scoreBlocks(rules, ctx.score_max)) gate = 'score';", replace: "    else if (!byHand && scoreBlocks(rules, ctx.score_max)) gate = 'score';" }] },
  { id: 'M79', what: 'check_yes read from the same day only (review R5)', cmd: 'unit_engine', expect: 'the window',
    edits: [{ file: 'engine.js', find: '    const winIds = new Set(windowDays.map(d => d.id));', replace: '    const winIds = new Set([lastId]);' }] },
  { id: 'M81', what: 'a hand-picked To failure set left out of the miss check (review R7)', cmd: 'unit_engine', expect: 'a set picked To failure by hand',
    edits: [{ file: 'engine.js', find: "r.target.failure_set === true : (slot === fs", replace: "(r.target.failure_set === true || r.set_type === 'failure') : (slot === fs" }] },
  { id: 'M82', what: 'a count above the top clamps straight to 3 (review R9)', cmd: 'unit_rules', expect: 'above the top',
    edits: [{ file: 'engine.js', find: '  if (base > caps.top_sets) sets = Math.max(sets, base - caps.cut_per_pass_max);\n', replace: '' }] },
  { id: 'M84', what: "a rest swap leaves checks[].lifts on the old exercise (review R13, engine part)", cmd: 'unit_engine', expect: 'a rest swap maps the block checks',
    edits: [{ file: 'engine.js', find: "      for (const ck of nb.checks || []) if (ck && Array.isArray(ck.lifts)) ck.lifts = ck.lifts.map(x => (x === oldId ? e.exercise_id : x));\n", replace: '' }] },
  { id: 'ME1', what: 'an assist row gets a step (health-coach verdict item C11)', cmd: 'unit_rules', expect: 'assist rows never change',
    edits: [{ file: 'engine.js', find: "  if (exercise && exercise.load_kind === 'assist') return null;\n", replace: '' }] },
  { id: 'ME2', what: 'the block step size is not read (r4.1 Q18)', cmd: 'unit_rules', expect: 'the block step size',
    edits: [{ file: 'engine.js', find: '  if (blockFlags && num(blockFlags.step) && blockFlags.step > 0) return { size: blockFlags.step };\n', replace: '' }] },
  { id: 'ME3', what: "the day's own sleep Yes is not counted (review R6, engine part)", cmd: 'unit_engine', expect: "the day's own sleep Yes",
    edits: [{ file: 'engine.js', find: '  if (shortSleep) sleep.push(true);\n', replace: '' }] },
  { id: 'ME4', what: 'add set takes top + 1 as its id (review R12)', cmd: 'unit_engine', expect: 'the new id takes 1 plus',
    edits: [{ file: 'engine.js', find: '      const mu = maxOf(used);\n      const idN = (mu !== null && mu > top ? mu : top) + 1;', replace: '      const idN = top + 1;' }] },
  { id: 'ME5', what: 'the missed gate reads the same day only (review R5)', cmd: 'unit_engine', expect: 'the window',
    edits: [{ file: 'engine.js', find: '      const sd = setDelta(rules, { ...sig, level, check_yes, missed: windowMissed });', replace: '      const sd = setDelta(rules, { ...sig, level, check_yes, missed: lastMissed });' },
      { file: 'engine.js', find: 'score_max: sig.score_max, missed: windowMissed,', replace: 'score_max: sig.score_max, missed: lastMissed,' }] },
  // ---------------- Slice 3 (17 C.4 planted defect map) ----------------
  { id: 'M62', what: 'the seed upsert drops a phone note (17 C.2.6)', cmd: 'unit_store', expect: 'the list upsert keeps a phone note and link on a seed row and a list row',
    edits: [{ file: 'store.js', find: "put: { ...r, notes: old ? old.notes : r.notes, link: old ? old.link : r.link } });", replace: "put: { ...r, notes: r.notes, link: old ? old.link : r.link } });" }] },
  { id: 'M63', what: 'a matched row ships the staging id in place of the seed id (17 C.2.3)', cmd: 'static', expect: 'exercise list: the 39 seed rows are frozen',
    edits: [{ file: 'data/exercises.js', find: "  row('chest_press_machine', 'Chest press (machine)',", replace: "  row('machine_chest_press', 'Chest press (machine)'," }] },
  { id: 'M66', what: 'setSavedEquipment stores an empty pick (17 C.3.1)', cmd: 'unit_store', expect: 'M66: saved equipment',
    edits: [{ file: 'store.js', find: "    if (!Array.isArray(list) || !list.length || list.length > EQUIPMENT_DETAILS.length", replace: "    if (!Array.isArray(list) || list.length > EQUIPMENT_DETAILS.length" }] },
  { id: 'M67', what: 'the picker ignores saved equipment (17 C.3.1)', cmd: 'unit_today', expect: 'C.3.1: saved equipment hides the kinds not saved',
    edits: [{ file: 'ui/builder.js', find: "  const gearOk = (e) => allGear || !saved || e.custom === true || saved.includes(e.equipment_detail);", replace: "  const gearOk = (e) => true;" }] },
  { id: 'M75', what: 'a custom exercise saved flags_set true with no questions asked (17 C.2.5 item 4)', cmd: 'unit_store', expect: 'M75: Make my own exercise',
    edits: [{ file: 'store.js', find: "    const flagsSet = qs.length === FLAG_KEYS.length && answered === FLAG_KEYS.length;", replace: "    const flagsSet = answered === qs.length;" }] },
  { id: 'M90', what: 'a machine row gets load_kind body (r4 review R16)', cmd: 'static', expect: 'M90: no row with equipment machine has load_kind body',
    edits: [{ file: 'data/exercises.js', find: "  row('chest_press_machine', 'Chest press (machine)', 'chest', 'machine', { muscle_detail: 'chest' }),", replace: "  row('chest_press_machine', 'Chest press (machine)', 'chest', 'machine', { muscle_detail: 'chest', load_kind: 'body' })," }] },
  { id: 'PD227', what: 'a body-load lift saves the typed load (17 C.2.2 Today change)', cmd: 'unit_store', expect: 'C.2.7: a body-load lift saves done.load 0',
    edits: [{ file: 'store.js', find: "    const bodyOnly = !!exRow && exRow.load_kind === 'body';", replace: "    const bodyOnly = false;" }] },
  { id: 'PD228', what: 'a phone-made block skips the flag source (17 C.2.5 item 2)', cmd: 'unit_store', expect: 'C.2.5 item 2: a phone-made block takes exercise_flags',
    edits: [{ file: 'store.js', find: "      const full = { ...spec, id: spec.id || 'b' + uuid(), unit, ...(src ? flagsOf(src) : {}) };", replace: "      const full = { ...spec, id: spec.id || 'b' + uuid(), unit };" }] },
  { id: 'M74', what: 'a new block takes the Current mark with no yes (17 C.3.2)', cmd: 'unit_store', expect: 'M74: a new block never takes the Current mark on its own',
    edits: [{ file: 'store.js', find: "      const activate = !current || o.activate === true;", replace: "      const activate = true;" }] },
  { id: 'PD229', what: 'the picker Free chip reads the coarse equipment again (17 C.3.1 R24)', cmd: 'unit_today', expect: 'C.3.1 R24: a chip filters by the finer equipment',
    edits: [{ file: 'ui/builder.js', find: "(!kinds || kinds.includes(e.equipment_detail))", replace: "(!kinds || kinds.includes(e.equipment))" }] },
  { id: 'M51', what: 'deleteBlock skips the safety copy (17 C.3.2)', cmd: 'unit_store', expect: 'M51: a before-delete safety copy exists',
    edits: [{ file: 'store.js', find: "      await snapshotNow('before-delete', job);\n", replace: '' }] },
  { id: 'M52', what: 'deleteBlock leaves the block feedback rows (17 C.3.2)', cmd: 'unit_store', expect: 'M52: deleteBlock removes every day, set and feedback row',
    edits: [{ file: 'store.js', find: "      const gone = feedback.filter(f => dayIds.has(f.day_id)).map(f => f.id);", replace: "      const gone = [];" }] },
  { id: 'M53', what: 'deleting the current block leaves active_block_id on it (17 C.3.2)', cmd: 'unit_store', expect: 'M53: deleting the current block moves the mark',
    edits: [{ file: 'store.js', find: "        puts.push({ key: 'active_block_id', value: next ? next.id : null });", replace: "        puts.push({ key: 'active_block_id', value: id });" }] },
  { id: 'M54', what: 'Delete block enabled before DELETE is typed (17 C.3.2)', cmd: 'e2e_slice3', expect: 'AW6 M54: Delete stays disabled until DELETE is typed',
    edits: [{ file: 'ui/blocks.js', find: "  const field = typedConfirm(t('del.type'), 'DELETE', go);", replace: "  const field = el('label', { class: 'confirm' }, el('span', { class: 'small' }, t('del.type')), el('input', { type: 'text', class: 'confirm-input' }));" }] },
  { id: 'M89', what: 'block delete runs outside exclusive() (r4 review R17)', cmd: 'unit_store', expect: 'M89: a tick held behind a slow write, then a delete',
    edits: [{ file: 'store.js', find: "    checkId(id);\n    return exclusive(async (job) => {\n      const b = await db.get('blocks', id);\n      if (!b) throw new Refused('no block');\n      await snapshotNow('before-delete', job);",
      replace: "    checkId(id);\n    const job = { write: (w) => w() };\n    return (async () => {\n      const b = await db.get('blocks', id);\n      if (!b) throw new Refused('no block');\n      await snapshotNow('before-delete', job);" },
      { file: 'store.js', find: "      return { deleted: id, current: puts.length ? puts[0].value : activeId };\n    });", replace: "      return { deleted: id, current: puts.length ? puts[0].value : activeId };\n    })();" }] },
  { id: 'M93', what: 'End block shown on a block that is not current (r4 review R27)', cmd: 'e2e_slice3', expect: 'M93: a block that is not current shows no End block',
    edits: [{ file: 'ui/block.js', find: "  if (ov.status !== 'done' && current) {", replace: "  if (ov.status !== 'done') {" }] },
  { id: 'PD230', what: 'a refused DELETE word is not refused by the store (17 C.3.2)', cmd: 'unit_store', expect: 'M52: deleteBlock removes every day, set and feedback row',
    edits: [{ file: 'store.js', find: "    if (typed !== DELETE_WORD) return Promise.reject(new Refused('word'));", replace: '' }] },
  { id: 'PD231', what: 'first run Build a block opens the builder, not the chooser (17 C.3.3)', cmd: 'e2e_slice3', expect: "C.3.3: first run's Build a block opens the New block chooser",
    edits: [{ file: 'ui/today.js', find: "await ctx.store.setSetting('unit', unit); ctx.go('#/new');", replace: "await ctx.store.setSetting('unit', unit); ctx.go('#/builder');" }] },
  // S2 rows (17 C.4 planted defect map): templates, guided builder, levels, copy.
  { id: 'M44', what: 'fillSlots drops the left_out_of_builder filter (17 C.3.6)', cmd: 'unit_engine', expect: 'never a lift left out of the builder (M44)',
    edits: [{ file: 'engine.js', find: "  if (row.left_out_of_builder === true) return false;\n", replace: '' }] },
  { id: 'M45', what: 'fillSlots drops the screened filter (17 C.3.6)', cmd: 'unit_engine', expect: 'never an unscreened one (M45)',
    edits: [{ file: 'engine.js', find: "  if (!screened) return false;\n", replace: '' }] },
  { id: 'M46', what: 'autofill with empty only refills a picked slot (17 C.3.6)', cmd: 'unit_engine', expect: 'fillSlots with Fill empty slots only leaves every picked slot as it was (M46, B08)',
    edits: [{ file: 'engine.js', find: "} else if (emptyOnly ? l.exercise_id !== null && l.exercise_id !== undefined : l.hand === true) continue;", replace: "} else if (emptyOnly ? false : l.hand === true) continue;" }] },
  { id: 'M47', what: 'fillSlots ignores the picked equipment (17 C.3.6)', cmd: 'unit_engine', expect: 'never outside the picked kinds (M47)',
    edits: [{ file: 'engine.js', find: "  if (kinds && !kinds.includes(row.equipment_detail)) return false;\n", replace: '' }] },
  { id: 'M48', what: 'autoBuildDays swaps the top and middle slot counts (17 C.3.5, BW4)', cmd: 'unit_engine', expect: 'autoBuildDays: a top muscle gets more slots per rotation than a middle one at every length 2 to 6 (M48, BW4, CW2)',
    edits: [{ file: 'engine.js', find: "    const count = b.slots_per_rotation[m.level][n];", replace: "    const count = b.slots_per_rotation[m.level === 'top' ? 'middle' : m.level === 'middle' ? 'top' : m.level][n];" }] },
  { id: 'M49', what: 'the size warning disables Next on the board (17 C.3.5, B07)', cmd: 'e2e_slice3', expect: 'B07 M49: 6 exercises shows no warning; 7 shows it and Next still works',
    edits: [{ file: 'ui/guided.js', find: "    screen.append(next(() => go(4)), back(2));", replace: "    screen.append(next(() => go(4), (g.board || []).some(d => ctx.store.dayWarning({ ...d, lifts: d.lifts.map(l => ({ ...l })) }))), back(2));" }] },
  { id: 'M50', what: 'a muscle can be added to a second level (17 C.3.5, BW3)', cmd: 'e2e_slice3', expect: 'BW3 M50: a muscle on Grow shows taken and cannot be picked for Steady',
    edits: [{ file: 'ui/guided.js', find: "    const taken = at && at !== lv;", replace: "    const taken = false;" }] },
  { id: 'M55', what: 'copy takes the settings unit (17 C.3.8, B09)', cmd: 'unit_store', expect: 'M55: the copy keeps the source unit',
    edits: [{ file: 'store.js', find: "      name: b.name, notes: b.notes || '', passes: b.passes, unit: b.unit, levels:", replace: "      name: b.name, notes: b.notes || '', passes: b.passes, unit: undefined, levels:" }] },
  { id: 'M56', what: 'copy drops exercise_flags (17 C.3.8)', cmd: 'unit_store', expect: 'M56: the copy keeps exercise_flags',
    edits: [{ file: 'store.js', find: "    return createBlock(spec, null, { ...(opts || {}), flagFrom: b.id });", replace: "    return createBlock(spec, null, { ...(opts || {}), flagFrom: 'no-such-block' });" }] },
  { id: 'M65', what: 'a template slot names an id not in data/exercises.js (17 C.3.4)', cmd: 'unit_templates', expect: 'every slot names an id in data/exercises.js (M65)',
    edits: [{ file: 'data/templates.js', find: "        { exercise_id: 'cable_row', rep_low: 10, rep_high: 15, priority: 'bottom' } ] }", replace: "        { exercise_id: 'no_such_lift_here', rep_low: 10, rep_high: 15, priority: 'bottom' } ] }" }] },
  { id: 'M71', what: 'template Start keeps a left-out exercise (17 C.3.4)', cmd: 'unit_store', expect: 'M71: a template slot whose exercise the flag source leaves out',
    edits: [{ file: 'store.js', find: "        if (!ex || !ex.screened || ex.left_out_of_builder === true) {", replace: "        if (!ex || !ex.screened) {" }] },
  { id: 'M72', what: "restore accepts a templates row with author 'ours' (17 C.0.3)", cmd: 'unit_backup', expect: 'B.6.1a templates rows: a bad value refuses the file',
    edits: [{ file: 'backup.js', find: "    author: c.exact('mine'), name: specs.exercises.name,", replace: "    author: c.oneOf(['mine', 'ours']), name: specs.exercises.name," }] },
  { id: 'M73', what: 'a level change re-plans a done day (17 C.3.7)', cmd: 'unit_store', expect: 'M73: a level change mid block writes blocks.levels only',
    edits: [{ file: 'store.js', find: "      return batch([{ store: 'blocks', put: { ...b, levels: clean } }]);", replace: "      const ds = await db.byIndex('days', 'block_id', blockId);\n      return batch([{ store: 'blocks', put: { ...b, levels: clean } }, ...ds.map(d => ({ store: 'days', put: { ...d, notes: d.notes + ' ' } }))]);" }] },
  { id: 'M91', what: 'template delete with no safety copy (r4 review R19)', cmd: 'unit_store', expect: 'M91: deleting one of his templates keeps a before-delete safety copy',
    edits: [{ file: 'store.js', find: "      await snapshotNow('before-delete', job); // r4 review R19, M91\n", replace: '' }] },
  // Slice 3, track S3 (17 C.4 planted map: M57 to M61, M68 to M70; M99 is the next free M id, for the
  // r4.6 Q1 round removal check; PD232 to PD235 take the next free PD ids, R27 rule).
  { id: 'M57', what: 'not done leaves out the easy round (17 C.3.10)', cmd: 'unit_stats', expect: 'ZW2: a 4-round, 3-day block after day 1',
    edits: [{ file: 'stats.js', find: '  const total = block && num(block.passes) ? block.passes * perRound : ds.length;', replace: '  const total = block && num(block.passes) ? (block.passes - 1) * perRound : ds.length;' }] },
  { id: 'M58', what: 'sets per muscle counts an L and R pair as two (17 C.3.10)', cmd: 'unit_stats', expect: 'M58: sets per muscle counts an L and R pair once',
    edits: [{ file: 'stats.js', find: "    const key = s.day_id + '|' + s.slot + '|' + s.set_n;", replace: "    const key = s.day_id + '|' + s.slot + '|' + s.set_n + '|' + s.side;" }] },
  { id: 'M59', what: 'grid minus runs without the typed word (17 C.3.11)', cmd: 'unit_store', expect: 'M59: the grid minus is refused without REMOVE typed',
    edits: [{ file: 'store.js', find: "    if (delta === -1 && typed !== REMOVE_WORD) return Promise.reject(new Refused('word'));\n", replace: '' }] },
  { id: 'PD232', what: 'the grid minus sheet leaves Remove round live before REMOVE is typed (17 C.3.11, M59 e2e half)', cmd: 'e2e_slice3', expect: 'M59: minus stays disabled until REMOVE is typed',
    edits: [{ file: 'ui/block.js', find: "  const conf = typedConfirm(t('grid.remove.type'), 'REMOVE', go);\n", replace: "  const conf = typedConfirm(t('grid.remove.type'), 'REMOVE', go);\n  go.disabled = false;\n  go.setAttribute('aria-disabled', 'false');\n" }] },
  { id: 'M60', what: 'trendPoints returns rounds newest first (17 C.3.12)', cmd: 'unit_stats', expect: 'M60: trendPoints gives rounds in order',
    edits: [{ file: 'stats.js', find: '  return out.sort((a, b) => a.pass - b.pass);', replace: '  return out.sort((a, b) => b.pass - a.pass);' }] },
  { id: 'M61', what: 'History by exercise lists blocks oldest first (17 C.3.12)', cmd: 'unit_store', expect: 'S13 M61: history for one exercise lists both blocks newest first',
    edits: [{ file: 'store.js', find: "blocks: [...blocks.values()].sort((a, b) => (b.created_at - a.created_at) || (a.block_id < b.block_id ? 1 : -1)) };", replace: "blocks: [...blocks.values()].sort((a, b) => (a.created_at - b.created_at) || (a.block_id < b.block_id ? -1 : 1)) };" }] },
  { id: 'M68', what: 'the body_weight range check removed (17 C.3.15)', cmd: 'unit_backup', expect: 'B.6.1a days.body_weight: a bad value refuses the file',
    edits: [{ file: 'backup.js', find: 'v >= L.BODY_WEIGHT_MIN && v <= L.BODY_WEIGHT_MAX && ', replace: '' }] },
  { id: 'PD233', what: 'the store saves a body weight outside 20 to 1000 (17 C.3.15)', cmd: 'unit_store', expect: 'C.3.15 DW8: body weight saves on an open or planned day',
    edits: [{ file: 'store.js', find: "      if (v < LIMITS.BODY_WEIGHT_MIN || v > LIMITS.BODY_WEIGHT_MAX) return Promise.reject(new Refused('bad number'));\n", replace: '' }] },
  { id: 'M69', what: 'a closed tip shows again after a reload (17 C.3.16)', cmd: 'e2e_slice3', expect: 'M69: a closed tip does not come back after a reload',
    edits: [{ file: 'ui/tips.js', find: '    try { await ctx.store.markTipSeen(id); } catch (e) { /* shown again next time, never lost silently */ }\n', replace: '' }] },
  { id: 'M70', what: 'the what-changed note shows on first install (17 C.3.16)', cmd: 'e2e_update', expect: 'M70: a first install shows no what-changed note',
    edits: [{ file: 'store.js', find: "    if (seen === null) { await queued('setting:seen_version', () => db.setSetting('seen_version', APP_VERSION)); return null; }", replace: "    if (seen === null) { await queued('setting:seen_version', () => db.setSetting('seen_version', APP_VERSION)); return APP_VERSION; }" }] },
  { id: 'M99', what: 'REMOVE deletes a planned day without checking its sets (r4.6 Q1)', cmd: 'unit_store', expect: 'M99 (r4.6 Q1): a planned day with a draft set is never deleted',
    edits: [{ file: 'store.js', find: "      if (sets.some(s => s.status !== 'planned' || (s.done !== null && s.done !== undefined) || (s.draft !== null && s.draft !== undefined))) return null;\n", replace: '' }] },
  { id: 'PD234', what: 'the Day done button of the last day opens Block finished with a second nudge (17 C.3.9, r4 review R22)', cmd: 'e2e_slice3', expect: 'C.3.9 R22: the whole last-day chain shows exactly one backup nudge',
    edits: [{ file: 'ui/today.js', find: '      if (blockOver) { ctx.finished = { id: want.finished, nudge: false };', replace: '      if (blockOver) { ctx.finished = { id: want.finished, nudge: true };' }] },
  { id: 'PD235', what: 'Finish day on the last day leaves finished_at null (17 C.3.9)', cmd: 'unit_store', expect: 'C.3.9 S19: Finish day on the last day of the last round',
    edits: [{ file: 'store.js', find: "  const finishBlock = (block, t) => ({ store: 'blocks', put: { ...block, status: 'done', finished_at: t } });", replace: "  const finishBlock = (block, t) => ({ store: 'blocks', put: { ...block, status: 'done', finished_at: null } });" }] },
  { id: 'PD236', what: 'the Adjust floor reason reads grid.min (r4.6 Q6)', cmd: 'unit_store', expect: 'C.3.11 r4.6 Q6: a refused minus below the fewest rounds reads grid.fewest',
    edits: [{ file: 'store.js', find: "return { key: 'grid.fewest', vals: { n: rules.effort.length_min } };", replace: "return { key: 'grid.min', vals: {} };" }] },
  { id: 'PD237', what: 'Erase all drops the tips_seen and seen_version device keys (C.0.2)', cmd: 'unit_store', expect: 'C.0.2 C.3.16: Erase all keeps the device keys',
    edits: [{ file: 'store.js', find: "['theme', 'persist_answer', 'seeded_version', 'tips_seen', 'seen_version'].includes(r.key)", replace: "['theme', 'persist_answer', 'seeded_version'].includes(r.key)" }] },
  { id: 'PD238', what: 'the round grid buttons are the table cells again, so every cell stacks under R1 (C.3.11, LOOK 4.12)', cmd: 'e2e_slice3', expect: "S11 C.3.11: each day's cells sit on one line, each under its round head",
    edits: [{ file: 'styles.css', find: '.grid-head,.grid-col,.grid-td{display:table-cell; vertical-align:middle}', replace: '.grid-head,.grid-col,.grid-cell{display:table-cell; vertical-align:middle}' },
      { file: 'styles.css', find: '.grid-cell{display:block; appearance:none;', replace: '.grid-cell{appearance:none;' },
      { file: 'ui/block.js', find: "line.appendChild(el('span', { class: 'grid-td' }, el('button', {", replace: "line.appendChild((el('button', {" }] },
  { id: 'PD239', what: 'the History day tally loses its large done skin, every stroke ghost (C.3.12, LOOK 4.8)', cmd: 'e2e_slice3', expect: 'C.3.12 LOOK 4.8: a History day row draws the large tally',
    edits: [{ file: 'ui/history.js', find: "{ class: 'tally tally-lg hist-tally', 'aria-hidden': 'true' }", replace: "{ class: 'tally hist-tally', 'aria-hidden': 'true' }" }] },
  { id: 'PD240', what: 'the chooser choices lose their padding, the words touch the edge (C.3.3, LOOK 3.4)', cmd: 'e2e_slice3', expect: "C.3.3 LOOK 3.4: each choice's words sit inside the button",
    edits: [{ file: 'styles.css', find: '.choice{padding:var(--s3) var(--s4); text-align:left}\n', replace: '' }] },
  { id: 'PD241', what: 'Suggest one shows on a hand pick (r4.6 Q7)', cmd: 'e2e_slice3', expect: 'r4.6 Q7: a hand pick shows no Suggest one',
    edits: [{ file: 'ui/guided.js', find: "name && !l.hand ? el('button'", replace: "name ? el('button'" }] },
  { id: 'PD242', what: 'the template preview says 1 sets (r4.6 Q7)', cmd: 'e2e_slice3', expect: "r4.6 Q7: a 1-set slot in the preview reads '1 set'",
    edits: [{ file: 'ui/strings.js', find: '  \'tpl.slot.one\': "{name}, 1 set",\n', replace: '' }] },
  // 0.4.1 look fixes (ai-ops-architect 2026-11-15, Q1 to Q3).
  { id: 'PD243', what: 'the overall sheet says 1 quick questions on one score (0.4.1 Q1)', cmd: 'e2e_slice3_look041', expect: "0.4.1 Q1: with one score the overall sheet reads '1 quick question'",
    edits: [{ file: 'ui/today.js', find: "sub: v.block.scores.length === 1 ? t('day.sub.one') : t('day.sub', { n: v.block.scores.length })", replace: "sub: t('day.sub', { n: v.block.scores.length })" }] },
  { id: 'PD244', what: 'the Back word carries its own typed arrow beside the glyph (0.4.1 Q2)', cmd: 'e2e_slice3_look041', expect: "0.4.1 Q2: the day view's Back link is one glyph and the word Back, no typed arrow",
    edits: [{ file: 'ui/strings.js', find: "  'check.backtab': 'Back',", replace: "  'check.backtab': '< Back'," }] },
  { id: 'PD245', what: 'the day view always lights the Block tab (0.4.1 Q3a)', cmd: 'e2e_slice3_look041', expect: '0.4.1 Q3a: a day opened from History lights the History tab',
    edits: [{ file: 'app.js', find: "root.appendChild(renderDayView(ctx, route.slice(DAYVIEW.length), from)); root.appendChild(tabbar(from));", replace: "root.appendChild(renderDayView(ctx, route.slice(DAYVIEW.length), from)); root.appendChild(tabbar('#/block'));" }] },
  { id: 'PD246', what: 'Back on a History day goes to the Block tab (0.4.1 Q3b)', cmd: 'e2e_slice3_look041', expect: '0.4.1 Q3b: a day opened from History has Back to History',
    edits: [{ file: 'ui/block.js', find: "href: from === '#/history' ? '#/history' : '#/block', id: 'day-back'", replace: "href: '#/block', id: 'day-back'" }] },
  // Must PASS: an ignored stray file inside app/ never breaks the shell check.
  { id: 'C1', what: 'an ignored stray file in test-output/', cmd: 'static', mustPass: true,
    create: { 'test-output/stray.js': 'export const stray = 1;\n', '.DS_Store': 'x' }, edits: [] }
];

// Rows that cannot be caught yet. Empty since r4.2 X2 (M76 is a live row above).
export const OWED_ROWS = [];

export function resolveBase() {
  let base;
  if (process.env.LIFTLOG_LOG_DIR) {
    base = join(process.env.LIFTLOG_LOG_DIR, 'tmp');
    mkdirSync(base, { recursive: true });
  } else {
    base = mkdtempSync(join(tmpdir(), 'liftlog-'));
  }
  const real = realpathSync(base), app = realpathSync(APP);
  if (real === app || real.startsWith(app + sep)) { console.log('ERROR copy base sits inside app/'); process.exit(2); }
  return real;
}

let BASE = null, LOGS = null;

function gitFiles() {
  return execFileSync('git', ['-C', APP, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
    .split('\n').filter(Boolean);
}

function copyApp(name) {
  const dst = join(BASE, 'mutant-' + name);
  rmSync(dst, { recursive: true, force: true });
  for (const f of gitFiles()) {
    if (!existsSync(join(APP, f))) continue;
    mkdirSync(dirname(join(dst, f)), { recursive: true });
    copyFileSync(join(APP, f), join(dst, f));
  }
  const g = (...a) => execFileSync('git', ['-C', dst, ...a], { stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'meetingvinny-cmd@users.noreply.github.com');
  g('config', 'user.name', 'Maxxx');
  g('add', '-A');
  g('-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'baseline');
  return dst;
}

function run(dir, cmdName, id) {
  const [bin, args] = CMD[cmdName];
  // Each run logs outside its copy, so the copy's own app/ check sees no folder inside it.
  const env = { ...process.env, LIFTLOG_LOG_DIR: join(LOGS, id) };
  delete env.LIFTLOG_SAMPLE_OUT;   // a broken copy never writes the health-coach sample
  // The upgrade suite serves the 0.2.6 build by git archive of a commit only this repo holds.
  env.LIFTLOG_SOURCE_REPO = APP;
  // A planted copy names its row, so the static find-text check (r4.3 H14) is skipped there: the
  // planted edit has used up its own find text. A baseline run never sets it.
  delete env.LIFTLOG_MUTANT_ROW;
  if (!id.startsWith('baseline')) env.LIFTLOG_MUTANT_ROW = id;
  mkdirSync(env.LIFTLOG_LOG_DIR, { recursive: true });
  const r = spawnSync(bin, args, { cwd: dir, env, encoding: 'utf8', timeout: 600000 });
  const text = (r.stdout || '') + (r.stderr || '');
  writeFileSync(join(env.LIFTLOG_LOG_DIR, cmdName + '.txt'), text);
  const fails = text.split('\n').filter(l => /FAIL|✖|not ok/.test(l)).map(s => s.trim());
  return { code: r.status, fails };
}

export function apply(dir, row) {
  for (const [f, body] of Object.entries(row.create || {})) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  for (const e of row.edits) {
    const p = join(dir, e.file);
    const src = readFileSync(p, 'utf8');
    const n = typeof e.find === 'string' ? src.split(e.find).length - 1 : (src.match(new RegExp(e.find.source, 'g')) || []).length;
    if (n !== 1) return 'find text matched ' + n + ' times in ' + e.file;
    const rep = typeof e.replace === 'function' ? e.replace() : e.replace;
    writeFileSync(p, typeof e.find === 'string' ? src.split(e.find).join(rep) : src.replace(e.find, rep));
  }
  return null;
}

if (MAIN) runAll();

function runAll() {
BASE = resolveBase();
LOGS = join(BASE, 'mutant-logs');
const report = [];
let errors = 0, survived = 0, caught = 0;
const say = (s) => { report.push(s); console.log(s); };

// (1) Baseline on a clean copy.
const clean = copyApp('baseline');
for (const name of [...new Set(ROWS.map(r => r.cmd))]) {
  const r = run(clean, name, 'baseline-' + name);
  if (r.code !== 0) {
    say('ERROR baseline  ' + name + ' fails on a clean copy (exit ' + r.code + ') | ' + (r.fails[0] || '').slice(0, 160));
    console.log('mutants: stopped, the baseline did not pass');
    process.exit(1);
  }
  say('PASS  baseline  ' + name + ' passes on a clean copy');
}

for (const row of ROWS) {
  const dir = copyApp(row.id);
  const problem = apply(dir, row);
  if (problem) { errors++; say('ERROR ' + row.id.padEnd(5) + ' ' + problem); continue; }
  const r = run(dir, row.cmd, row.id);
  if (row.mustPass) {
    if (r.code === 0) say('PASS  ' + row.id.padEnd(5) + ' ' + row.what + ' | ' + row.cmd + ' still passes');
    else { errors++; say('ERROR ' + row.id.padEnd(5) + ' ' + row.what + ' | ' + row.cmd + ' failed: ' + (r.fails[0] || '').slice(0, 160)); }
    continue;
  }
  const named = r.fails.find(l => l.includes(row.expect));
  if (r.code !== 0 && named) {
    caught++;
    say('CAUGHT ' + row.id.padEnd(5) + ' ' + row.what + ' | ' + row.cmd + ' | ' + named.slice(0, 140));
  } else if (r.code !== 0) {
    errors++;
    say('ERROR ' + row.id.padEnd(5) + ' ' + row.what + ' | ' + row.cmd + ' failed, but not on "' + row.expect + '" | ' + (r.fails[0] || 'exit ' + r.code).slice(0, 140));
  } else {
    survived++;
    say('FAIL  ' + row.id.padEnd(5) + ' ' + row.what + ' | ' + row.cmd + ' | SURVIVED');
  }
}

const planted = ROWS.filter(r => !r.mustPass).length;
console.log('mutants: ' + caught + ' of ' + planted + ' caught, ' + survived + ' survived, ' + errors + ' error(s)');
process.exit(survived || errors ? 1 : 0);
}
