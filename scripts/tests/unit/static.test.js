// Static checks on the shipped files (DESIGN 4.6). Run: node --test scripts/tests/unit/static.test.js
// The file list always comes from git (tracked plus untracked, not ignored), never from the disk walk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const NOT_SHIPPED = new Set(['README.md', 'HOW_TO.md', 'package.json', '.gitignore', 'robots.txt']);

// The exact Slice 0 file list (DESIGN 4.2), no globs.
const MANIFEST_SLICE0 = [
  '.gitignore', 'HOW_TO.md', 'README.md', 'app.js', 'db.js',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'index.html', 'manifest.webmanifest', 'package.json',
  'scripts/tests/e2e.py', 'scripts/tests/live_check.py', 'scripts/tests/mutants.js',
  'scripts/tests/repo_guard.js', 'scripts/tests/run_all.sh', 'scripts/tests/shell_versions.json',
  'scripts/tests/sim_pass.sh', 'scripts/tests/unit/static.test.js',
  'styles.css', 'sw.js', 'ui/check.js', 'ui/dom.js', 'ui/install.js', 'ui/settings.js',
  'ui/strings.js', 'version.js'
].sort();
// Slice 1 manifest = the Slice 0 manifest plus these (DESIGN 5.1).
const MANIFEST_SLICE1 = [...MANIFEST_SLICE0, 'robots.txt', 'backup.js', 'store.js', 'data/exercises.js', 'ui/today.js',
  'ui/builder.js', 'scripts/tests/check_backup.mjs', 'scripts/tests/unit/backup.test.js', 'scripts/tests/unit/migrate.test.js',
  'scripts/tests/unit/store.test.js', 'scripts/tests/unit/fake_db.js', 'scripts/tests/fixtures/backup_v1.json',
  'scripts/tests/fixtures/block_v1.json', 'scripts/tests/fixtures/seed_ids.json',
  'scripts/tests/origin_check.py'].sort();
// The rules engine, built ahead of Slice 2 (DESIGN 16 B.1 steps 1 and 2). Not wired into the app yet.
const MANIFEST_ENGINE = [...MANIFEST_SLICE1, 'rules.js', 'engine.js', 'scripts/tests/unit/rules.test.js',
  'scripts/tests/unit/engine.test.js',
  // Slice 1 polish pass, stage 2 (DESIGN 15 P.3, review R36): the pure screen helpers.
  'scripts/tests/unit/today.test.js',
  // Slice 1 polish pass (DESIGN 15): the 39 seed rows as shipped in 0.2.1, read by the private list tool.
  'scripts/tests/fixtures/seed_rows_v1.json',
  // Slice 1 polish pass, step 5 (DESIGN 15 P.1): the polish fixture and the script that builds it through the store.
  'scripts/tests/fixtures/backup_v1_polish.json', 'scripts/tests/make_fixture_polish.mjs'].sort();
// Slice 2 so far (16 B.1 step 3, r4.4 R5): the frozen migration results and the schema 2 block
// fixture. The later steps add the rest of MANIFEST_SLICE2 (ui/block.js, make_fixture_v2.mjs,
// backup_v2.json, block_rounds.json) and point the file list test at it.
const MANIFEST_SLICE2_STEP3 = [...MANIFEST_ENGINE, 'scripts/tests/fixtures/backup_v1_as_v2.json',
  'scripts/tests/fixtures/backup_v1_polish_as_v2.json', 'scripts/tests/fixtures/block_v2.json'].sort();
// The schema commit (16 B.1 steps 3 to 5, r4.4 R12): the schema 2 fixture made by the store and its
// script. Later steps add ui/block.js and block_rounds.json (MANIFEST_SLICE2).
const MANIFEST_SLICE2_STEP5 = [...MANIFEST_SLICE2_STEP3, 'scripts/tests/make_fixture_v2.mjs', 'scripts/tests/fixtures/backup_v2.json'].sort();
// 16 B.1 step 8: the Block tab file. block_rounds.json (step 11) completes MANIFEST_SLICE2.
const MANIFEST_SLICE2_STEP8 = [...MANIFEST_SLICE2_STEP5, 'ui/block.js'].sort();
// MANIFEST_SLICE2 (16 B.1 Slice 2 manifest paragraph, r4.4 R5): MANIFEST_ENGINE plus ui/block.js,
// make_fixture_v2.mjs, backup_v2.json, backup_v1_as_v2.json, backup_v1_polish_as_v2.json,
// block_v2.json and block_rounds.json (B.1 step 11). Step 11 also adds block_rounds_script.json,
// the answer script and its table, read by engine.test.js and e2e.py (B.12 last paragraph).
const MANIFEST_SLICE2 = [...MANIFEST_ENGINE, 'ui/block.js', 'scripts/tests/make_fixture_v2.mjs', 'scripts/tests/fixtures/backup_v2.json',
  'scripts/tests/fixtures/backup_v1_as_v2.json', 'scripts/tests/fixtures/backup_v1_polish_as_v2.json',
  'scripts/tests/fixtures/block_v2.json', 'scripts/tests/fixtures/block_rounds.json',
  'scripts/tests/fixtures/block_rounds_script.json'].sort();
// MANIFEST_SLICE3 (17 C.0.1, r4.4 R18): MANIFEST_SLICE2 plus the Slice 3 files. Each step adds the
// files it creates (S1 integration: the templates data, stats.js and their tests and fixtures).
const MANIFEST_SLICE3 = [...MANIFEST_SLICE2, 'data/templates.js', 'stats.js', 'ui/blocks.js', 'ui/templates.js', 'ui/guided.js', 'scripts/tests/unit/stats.test.js',
  'scripts/tests/unit/templates.test.js', 'scripts/tests/fixtures/template_ids.json',
  'scripts/tests/fixtures/templates_sample.js',
  // Track S3 (C.3.9 to C.3.16): History, the trend line, the library and the tips.
  'ui/history.js', 'ui/trend.js', 'ui/library.js', 'ui/tips.js'].sort();

const EXPECTED_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const EXPECTED_HEAD = [
  '<meta charset="utf-8">',
  '<meta http-equiv="Content-Security-Policy" content="' + EXPECTED_CSP + '">',
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
  '<meta name="robots" content="noindex, nofollow">',
  '<title>Lift Log</title>',
  '<meta name="theme-color" content="#F4F1EA" media="(prefers-color-scheme: light)">',
  '<meta name="theme-color" content="#111315" media="(prefers-color-scheme: dark)">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="default">',
  '<meta name="apple-mobile-web-app-title" content="Lift Log">',
  '<link rel="manifest" href="manifest.webmanifest">',
  '<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">',
  '<link rel="stylesheet" href="styles.css">'
];
const SVG_NS = 'http://www.w3.org/2000/svg';
const NS_ALLOWED_IN = new Set(['ui/dom.js', 'index.html']);
const PNG_OK = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
const RETIRED = ['lift', 'Swap', 'Swap lift', 'Add lift', 'Add your own', 'Add it as your own exercise',
  'Restore data', 'Not saved, tap to retry', 'Look around anyway', 'Tap again to erase', 'Week', 'Pass',
  'draft-0', 'draft-1', 'Adjusts weekly', 'Weekly adjust'];
const SLICE0_KEYS = ['install.title', 'install.head', 'install.why', 'install.step1', 'install.step2', 'install.step3',
  'install.addressbar', 'install.tab', 'install.check', 'check.title', 'check.sub', 'check.busy', 'check.back',
  'check.backtab', 'check.row1', 'check.row2', 'check.row3', 'check.row4', 'check.row5', 'check.row6', 'check.row7',
  'check.yes', 'check.unsure', 'check.no', 'check.count', 'check.noanswer', 'check.unknown', 'check.error',
  'check.row1.no', 'check.row2.unsure', 'check.row2.no', 'check.row2.mixed', 'check.row3.icon', 'check.row3.tab',
  'check.row3.nosay', 'check.row3.usage', 'check.row4.no', 'check.row5.first', 'check.row5.unsure',
  'check.row6.unsure', 'check.row7.no', 'check.ios', 'check.ios.newer', 'check.ios.none', 'check.ios.hint',
  'check.info', 'check.again', 'check.footer', 'tab.today', 'tab.block', 'tab.history', 'tab.settings',
  'settings.title', 'settings.phone', 'settings.check', 'settings.about', 'settings.version', 'settings.schema',
  'settings.rules', 'settings.rules.none', 'empty.today.title', 'empty.today.s0', 'empty.block.s0',
  'empty.history.title', 'empty.history.line', 'storage.title', 'storage.line', 'update.title', 'update.later',
  'update.now'];

const read = (rel) => readFileSync(join(APP, rel), 'utf8');
const gitList = () => execFileSync('git', ['-C', APP, 'ls-files', '--cached', '--others', '--exclude-standard'],
  { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
const isShipped = (f) => !NOT_SHIPPED.has(f) && !f.startsWith('scripts/');
const shipped = gitList().filter(isShipped);
const textShipped = shipped.filter(f => /\.(js|html|css|webmanifest|json)$/.test(f));

function shellList() {
  const m = /const SHELL = \[([\s\S]*?)\];/.exec(read('sw.js'));
  assert.ok(m, 'SHELL array not found in sw.js');
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

const HASH_LINE = /^const SHELL_HASH = '[0-9a-f]{64}';$/;
export function shellHash(shell) {
  const h = createHash('sha256');
  for (const f of shell.filter(x => x !== './').sort()) {
    let bytes = readFileSync(join(APP, f));
    if (f === 'sw.js') {
      bytes = Buffer.from(bytes.toString('utf8').split('\n').filter(l => !HASH_LINE.test(l)).join('\n'), 'utf8');
    }
    h.update(f + '\n');
    h.update(bytes);
  }
  return h.digest('hex');
}

test('SHELL equals the git shell list (M10, M10b)', () => {
  const shell = shellList();
  assert.ok(shell.includes('./'), 'SHELL must hold ./');
  assert.equal(new Set(shell).size, shell.length, 'SHELL has a duplicate');
  assert.deepEqual(shell.filter(x => x !== './').sort(), shipped, 'SHELL and the git shell list differ');
});

test('no other shipped file holds a shell list', () => {
  const names = shellList().filter(x => x !== './');
  for (const f of textShipped.filter(x => x !== 'sw.js' && x.endsWith('.js'))) {
    const src = read(f);
    const n = names.filter(p => src.includes("'" + p + "'") || src.includes('"' + p + '"')).length;
    assert.ok(n < 3, f + ' names ' + n + ' shell files in quotes; only sw.js holds the shell list');
  }
});

test('sw.js VERSION equals APP_VERSION', () => {
  const v = /const VERSION = '([^']+)'/.exec(read('sw.js'));
  const a = /APP_VERSION = '([^']+)'/.exec(read('version.js'));
  assert.ok(v && a);
  assert.equal(v[1], a[1]);
  assert.match(read('sw.js'), /const CACHE = 'liftlog-' \+ VERSION;/);
});

test('SHELL_HASH matches the shell files (M19, M19b)', () => {
  const lines = read('sw.js').split('\n').filter(l => HASH_LINE.test(l));
  assert.equal(lines.length, 1, 'sw.js must hold exactly one SHELL_HASH line');
  const have = /'([0-9a-f]{64})'/.exec(lines[0])[1];
  const want = shellHash(shellList());
  if (have !== want) {
    console.log('# new SHELL_HASH: ' + want);
    console.log('# A shell file changed. Bump VERSION in sw.js and APP_VERSION in version.js (patch at least), then paste the new SHELL_HASH.');
  }
  assert.equal(have, want, 'SHELL_HASH does not match the shell files');
  const version = /const VERSION = '([^']+)'/.exec(read('sw.js'))[1];
  const ledger = JSON.parse(read('scripts/tests/shell_versions.json'));
  assert.ok(Array.isArray(ledger), 'shell_versions.json must be a list');
  for (const row of ledger) {
    assert.ok(!(row.version === version && row.hash !== want), 'version ' + version + ' was pushed with a different hash: bump VERSION');
  }
});

test('activate deletes only our own caches (M11s)', () => {
  const src = read('sw.js');
  const act = src.slice(src.indexOf("addEventListener('activate'"), src.indexOf("addEventListener('fetch'"));
  assert.ok(act.includes("k.startsWith('liftlog-') && k !== CACHE"), 'activate filter must keep the liftlog- prefix check');
});

test('install is all or nothing with a version check', () => {
  const src = read('sw.js');
  const inst = src.slice(src.indexOf("addEventListener('install'"), src.indexOf("addEventListener('activate'"));
  assert.ok(inst.includes("u + '?v=' + VERSION"), 'install must fetch u?v=VERSION');
  assert.ok(inst.includes("cache: 'reload'"), 'install must fetch with cache reload');
  assert.ok(inst.includes("APP_VERSION = '\" + VERSION + \"'"), 'install must check version.js');
  assert.ok(inst.includes('Promise.all('), 'install must use Promise.all');
  assert.ok(!inst.includes('skipWaiting'), 'no skipWaiting in install');
  assert.ok(!inst.includes('allSettled'), 'no allSettled in install');
  const fetchPart = src.slice(src.indexOf("addEventListener('fetch'"), src.indexOf("addEventListener('message'"));
  assert.ok(!/\.put\(/.test(fetchPart), 'fetch handler must not write to the cache');
});

test('manifest icons and index.html links are tracked and in SHELL', () => {
  const shell = new Set(shellList());
  const tracked = new Set(gitList());
  const man = JSON.parse(read('manifest.webmanifest'));
  const refs = man.icons.map(i => i.src);
  for (const m of read('index.html').matchAll(/\s(?:href|src)="([^"]+)"/g)) refs.push(m[1]);
  for (const r of refs) {
    assert.ok(tracked.has(r), r + ' is not a tracked file');
    assert.ok(shell.has(r), r + ' is not in SHELL');
  }
});

test('git file list equals the engine manifest', () => {
  assert.deepEqual(gitList(), MANIFEST_SLICE3, 'files in app/ differ from MANIFEST_SLICE3 (the Slice 2 manifest plus the Slice 3 files)');
  // The step chain and the paragraph list name the same files (16 B.1 Slice 2 manifest paragraph).
  assert.deepEqual([...MANIFEST_SLICE2_STEP8, 'scripts/tests/fixtures/block_rounds.json', 'scripts/tests/fixtures/block_rounds_script.json'].sort(), MANIFEST_SLICE2);
});

test('every import is relative', () => {
  for (const f of shipped.filter(x => x.endsWith('.js'))) {
    const src = read(f);
    for (const m of src.matchAll(/(?:^|\s)import\s[^'"]*['"]([^'"]+)['"]/gm)) assert.ok(/^\.\.?\//.test(m[1]), f + ' imports ' + m[1]);
    for (const m of src.matchAll(/import\(\s*['"]([^'"]+)['"]/g)) assert.ok(/^\.\.?\//.test(m[1]), f + ' imports ' + m[1]);
  }
});

test('no outside address in shipped files (M14s)', () => {
  for (const f of textShipped) {
    let src = read(f);
    if (NS_ALLOWED_IN.has(f)) src = src.split(SVG_NS).join('');
    assert.ok(!/https?:\/\//i.test(src), f + ' holds an http or https address');
  }
  const ns = (read('ui/dom.js').match(/http:\/\/www\.w3\.org\/2000\/svg/g) || []).length;
  assert.ok(ns <= 1, 'ui/dom.js holds the namespace more than once');
  assert.match(read('ui/dom.js'), /const SVG_NS = 'http:\/\/www\.w3\.org\/2000\/svg';/);
});

test('no banned browser features', () => {
  const banned = [
    [/\blocalStorage\b/, 'localStorage'], [/\bsessionStorage\b/, 'sessionStorage'], [/document\.cookie/, 'document.cookie'],
    [/\binnerHTML\b/, 'innerHTML'], [/\bouterHTML\b/, 'outerHTML'], [/insertAdjacentHTML/, 'insertAdjacentHTML'],
    [/document\.write/, 'document.write'], [/\beval\s*\(/, 'eval'], [/new\s+Function\b/, 'new Function'], [/\.style\./, '.style.']
  ];
  for (const f of shipped.filter(x => x.endsWith('.js'))) {
    const src = read(f);
    for (const [re, name] of banned) assert.ok(!re.test(src), f + ' uses ' + name);
  }
});

test('index.html: exact head, no inline style or script', () => {
  const html = read('index.html');
  const head = /<head>\n([\s\S]*?)\n<\/head>/.exec(html);
  assert.ok(head, 'head not found');
  assert.deepEqual(head[1].split('\n'), EXPECTED_HEAD, 'head tags differ from DESIGN 4.3');
  assert.ok(!/\sstyle\s*=/i.test(html), 'style= attribute found');
  assert.ok(!/<style\b/i.test(html), '<style> tag found');
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    assert.ok(/\bsrc=/.test(m[1]), 'script without src');
    assert.equal(m[2].trim(), '', 'inline script body found');
  }
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'inline event handler found');
  assert.match(html, /<div id="app"><\/div>/);
  assert.match(html, /<script type="module" src="app.js"><\/script>/);
});

test('Phone check expects the same CSP as index.html', () => {
  const m = /export const EXPECTED_CSP = "([^"]*)";/.exec(read('ui/check.js'));
  assert.ok(m);
  assert.equal(m[1], EXPECTED_CSP);
});

test('no ui file imports db.js', () => {
  for (const f of shipped.filter(x => x.startsWith('ui/'))) assert.ok(!/from\s+['"][./]*db\.js['"]/.test(read(f)), f + ' imports db.js');
  for (const f of shipped.filter(x => x.endsWith('.js') && x !== 'db.js')) assert.ok(!/\bindexedDB\b/.test(read(f)), f + ' touches indexedDB');
});

test('no em or en dashes in shipped files', () => {
  for (const f of textShipped) assert.ok(!/[\u2013\u2014]/.test(read(f)), f + ' holds an em or en dash');
});

test('styles.css: no raw hex, px or ms after the token block', () => {
  const css = read('styles.css');
  const at = css.indexOf('/* ==== end of token block');
  assert.ok(at > 0, 'token block end marker missing');
  const rest = css.slice(css.indexOf('*/', at) + 2).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(rest), 'raw hex color below the token block');
  const px = [...rest.matchAll(/(\d*\.?\d+)px/g)].map(m => m[1]).filter(n => n !== '0' && n !== '1');
  assert.deepEqual(px, [], 'raw px below the token block');
  assert.ok(!/\d+ms\b/.test(rest), 'raw ms below the token block');
});

test('version.js, package.json and manifest are exact', () => {
  // Slice 3 (17 C.0, r4.4 R17): 0.4.0, schema 2 kept, the signed-2 rules (builder and copy parts).
  assert.equal(read('version.js').trim(), "export const APP_VERSION = '0.4.1'; export const SCHEMA = 2; export const RULES_VERSION = 'signed-2';");
  assert.equal(read('package.json').trim(), '{"private":true,"type":"module"}');
  const man = JSON.parse(read('manifest.webmanifest'));
  assert.deepEqual(Object.keys(man).sort(), ['background_color', 'display', 'icons', 'id', 'name', 'orientation', 'scope', 'short_name', 'start_url', 'theme_color']);
  assert.equal(man.name, 'Lift Log');
  assert.equal(man.short_name, 'Lift Log');
  assert.equal(man.id, './');
  assert.equal(man.start_url, './');
  assert.equal(man.scope, './');
  assert.equal(man.display, 'standalone');
  assert.equal(man.orientation, 'portrait');
  assert.equal(man.background_color, '#F4F1EA');
  assert.equal(man.theme_color, '#F4F1EA');
  assert.deepEqual(man.icons.map(i => i.src + ' ' + i.sizes + ' ' + i.purpose),
    ['icons/icon-192.png 192x192 any', 'icons/icon-512.png 512x512 any', 'icons/icon-512.png 512x512 maskable']);
});

test('icons: PNG, right size, only IHDR PLTE tRNS IDAT IEND', () => {
  const want = { 'icons/apple-touch-icon.png': 180, 'icons/icon-192.png': 192, 'icons/icon-512.png': 512 };
  for (const [f, px] of Object.entries(want)) {
    assert.ok(existsSync(join(APP, f)), f + ' missing');
    const b = readFileSync(join(APP, f));
    assert.equal(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', f + ' is not a PNG');
    assert.equal(b.readUInt32BE(16), px, f + ' width');
    assert.equal(b.readUInt32BE(20), px, f + ' height');
    let i = 8; const kinds = [];
    while (i < b.length) { const n = b.readUInt32BE(i); kinds.push(b.subarray(i + 4, i + 8).toString('latin1')); i += 12 + n; }
    assert.deepEqual(kinds.filter(k => !PNG_OK.has(k)), [], f + ' carries extra chunks');
  }
});

test('ui/strings.js holds every Slice 0 key', async () => {
  const { S } = await import('../../../ui/strings.js');
  for (const k of SLICE0_KEYS) assert.ok(k in S, 'missing string key ' + k);
});

test('no retired glossary form in ui/strings.js', async () => {
  const { S } = await import('../../../ui/strings.js');
  const retired = new Set(RETIRED.map(x => x.trim().toLowerCase()));
  for (const [k, v] of Object.entries(S)) {
    for (const s of [v].flat()) assert.ok(!retired.has(String(s).trim().toLowerCase()), k + ' is a retired form');
  }
});

test('no literal screen string outside ui/strings.js', () => {
  const code = shipped.filter(f => f.endsWith('.js') && f !== 'ui/strings.js' && (f.startsWith('ui/') || f === 'app.js'));
  for (const f of code) {
    read(f).split('\n').forEach((line, i) => {
      if (/^\s*\/\//.test(line) || !/\bel\(|\btoast\(|textContent\s*=/.test(line)) return;
      line = line.replace(/\bclass:\s*'[^']*'/g, '');
      for (const m of line.matchAll(/'([^'\\]*)'|"([^"\\]*)"/g)) {
        const s = m[1] !== undefined ? m[1] : m[2];
        assert.ok(!(/^[A-Z][a-z]/.test(s) || /[A-Za-z] [A-Za-z]/.test(s)), f + ':' + (i + 1) + ' passes a literal screen string');
      }
    });
  }
});

test('no shipped file names Max or an agent', () => {
  for (const f of textShipped) assert.ok(!/\bMax\b|\bMaxxx\b/.test(read(f)), f + ' names Max');
});

// ---------------- Slice 1 (DESIGN 5.7 static row) ----------------

const SLICE1_KEYS = ['update.close', 'storage.unprotected', 'empty.today.line', 'empty.next.title', 'empty.next.line',
  'check.row3.usage.asked', 'check.summary.mode', 'setup.title', 'setup.line', 'unit.lb', 'unit.kg', 'setup.build',
  'setup.load', 'today.position', 'today.round.of', 'today.round', 'today.stale', 'today.goal', 'today.stop', 'today.fail',
  'today.last', 'today.side', 'today.hand', 'today.repsleft', 'today.chip4', 'today.chip4.aria', 'today.failure',
  'today.since', 'menu', 'today.finish', 'today.saving', 'today.notsaved', 'num.load', 'num.reps', 'fb.title', 'fb.sub',
  'fb.q.pump', 'fb.q.soreness', 'fb.q.workload', 'fb.a.pump', 'fb.a.soreness', 'fb.a.workload', 'fb.no', 'fb.yes',
  'fb.note', 'fb.save', 'fb.later', 'fb.skip', 'check.says', 'check.stop', 'check.keep', 'note.onefail', 'note.machine',
  'day.title', 'day.sub', 'day.scale', 'day.save', 'day.skip', 'nudge.now', 'nudge.later', 'backup.last', 'backup.never',
  'backup.ready', 'backup.again', 'backup.not', 'backup.ask', 'backup.yes', 'backup.no', 'settings.units',
  'settings.units.line', 'settings.look', 'look.phone', 'look.light', 'look.dark', 'settings.restore', 'settings.undo',
  'settings.load', 'settings.erase', 'erase.first', 'erase.type', 'erase.kept', 'erase.snaps', 'restore.saved',
  'restore.days', 'restore.sets', 'restore.last', 'restore.newer', 'restore.type', 'restore.go', 'restore.cancel',
  'restore.done', 'restore.toonew', 'restore.bad', 'undo.restore', 'undo.erase', 'undo.upgrade', 'block.save',
  'block.cancel', 'block.old', 'block.switch', 'block.newex', 'block.keepdraft', 'block.badref', 'builder.steps',
  'builder.rounds', 'builder.rounds.help', 'builder.next', 'builder.back', 'builder.loadinstead', 'builder.addday',
  'builder.addex', 'builder.how', 'builder.how.line', 'picker.search', 'picker.make', 'picker.nomatch', 'picker.addq',
  'picker.chips'];

test('ui/strings.js holds every Slice 1 key', async () => {
  const { S } = await import('../../../ui/strings.js');
  for (const k of SLICE1_KEYS) assert.ok(k in S, 'missing string key ' + k);
  assert.deepEqual(S['fb.a.pump'], ['None', 'A little', 'Good', 'Big']);
  assert.deepEqual(S['menu'], ['Add set', 'Skip set', 'Skip exercise', 'Swap exercise', 'Notes', 'Video link']);
});

test('seed exercises: ids unique, frozen list kept, every field typed', async () => {
  const { SEED_EXERCISES } = await import('../../../data/exercises.js');
  const { MUSCLES, EQUIPMENT, COUNT_LABELS } = await import('../../../backup.js');
  const ids = SEED_EXERCISES.map(e => e.id);
  assert.equal(new Set(ids).size, ids.length, 'a seed id is used twice');
  for (const e of SEED_EXERCISES) {
    assert.match(e.id, /^[a-z0-9_]+$/);
    assert.ok(MUSCLES.includes(e.muscle) && EQUIPMENT.includes(e.equipment) && COUNT_LABELS.includes(e.count_label), e.id + ' bad kind');
    for (const b of ['unilateral', 'machine', 'no_added_sets', 'left_out_of_builder', 'flags_set', 'custom', 'edited']) assert.equal(typeof e[b], 'boolean', e.id + ' ' + b);
    assert.equal(e.no_added_sets, false);
    assert.equal(e.left_out_of_builder, false);
  }
  const frozen = JSON.parse(read('scripts/tests/fixtures/seed_ids.json'));
  assert.deepEqual(ids, frozen, 'the seed id list differs from fixtures/seed_ids.json');
});

// ---------------- the exercise list (DESIGN 17 C.2.7, schema 1 fields; R4-07, R4-08, R4-09) ----------------

test('exercise list: the 39 seed rows are frozen, every list row starts unflagged (R4-08)', async () => {
  const { SEED_EXERCISES, MUSCLE_DETAIL_CHIP, EQUIPMENT_DETAIL_CHIP, TAG_CODES, LOAD_KINDS } = await import('../../../data/exercises.js');
  const v1 = JSON.parse(read('scripts/tests/fixtures/seed_rows_v1.json'));
  const frozen = JSON.parse(read('scripts/tests/fixtures/seed_ids.json'));
  assert.equal(v1.length, 39);
  assert.deepEqual(frozen.slice(0, 39), v1.map(r => r.id), 'seed_ids.json starts with the 39 shipped ids in order');
  const byId = new Map(SEED_EXERCISES.map(e => [e.id, e]));
  for (const id of frozen) assert.ok(byId.has(id), 'a frozen id is missing from the list: ' + id);
  for (const s of v1) {
    const e = byId.get(s.id);
    for (const f of ['name', 'muscle', 'equipment', 'count_label', 'unilateral']) assert.deepEqual(e[f], s[f], s.id + ' ' + f + ' changed');
    assert.equal(e.flags_set, true, s.id + ' seed row keeps flags_set true');
  }
  const seedIds = new Set(v1.map(r => r.id));
  for (const e of SEED_EXERCISES) {
    assert.match(e.id, /^[a-z0-9_]{1,60}$/);
    if (!seedIds.has(e.id)) assert.equal(e.flags_set, false, e.id + ': a list row starts with flags_set false');
    assert.equal(e.link, '', e.id + ' ships a link');
    assert.equal(e.notes, '', e.id + ' ships a note');
    assert.equal(e.custom, false);
    assert.equal(e.edited, false);
    assert.equal(e.weight_steps, null, e.id + ': the list ships no weight steps');
    // Schema 2 fields (17 C.2.7): the detail belongs to its group, the equipment detail's chip is
    // the equipment, tags only from TAG_CODES (at most 2, no repeat), a known load kind.
    assert.ok(e.muscle_detail === null || MUSCLE_DETAIL_CHIP[e.muscle_detail] === e.muscle, e.id + ': muscle_detail is not in its muscle group');
    assert.equal(EQUIPMENT_DETAIL_CHIP[e.equipment_detail], e.equipment, e.id + ': equipment_detail chip differs from equipment');
    assert.ok(Array.isArray(e.tags) && e.tags.length <= 2 && new Set(e.tags).size === e.tags.length && e.tags.every(x => TAG_CODES.includes(x)), e.id + ': bad tags');
    assert.ok(LOAD_KINDS.includes(e.load_kind), e.id + ': bad load_kind');
    assert.ok(e.name.length >= 1 && e.name.length <= 120, e.id + ' name length');
  }
  const names = SEED_EXERCISES.map(e => e.name.toLowerCase());
  assert.equal(new Set(names).size, names.length, 'two rows share a name, ignoring case');
  assert.ok(SEED_EXERCISES.length > 39, 'the list holds more than the seed rows');
});

test('exercise list: every muscle and equipment value has a data word (R4-09)', async () => {
  const { SEED_EXERCISES, MUSCLE_NAMES, EQUIPMENT_NAMES } = await import('../../../data/exercises.js');
  for (const e of SEED_EXERCISES) {
    assert.ok(typeof MUSCLE_NAMES[e.muscle] === 'string' && MUSCLE_NAMES[e.muscle].length, e.id + ': muscle has no data word');
    assert.ok(typeof EQUIPMENT_NAMES[e.equipment] === 'string' && EQUIPMENT_NAMES[e.equipment].length, e.id + ': equipment has no data word');
  }
});

test('exercise list: every trap bar row is a barbell row (14.8 CHANGE A1, C17)', async () => {
  const { SEED_EXERCISES } = await import('../../../data/exercises.js');
  const trap = SEED_EXERCISES.filter(e => e.id.startsWith('trap_bar_'));
  assert.equal(trap.length, 5, 'the list holds the five trap bar rows');
  for (const e of trap) {
    assert.equal(e.equipment, 'barbell', e.id + ': a trap bar row must have equipment barbell');
    assert.equal(e.machine, false, e.id + ': a trap bar row is never a machine seat');
  }
});

test('exercise list: a Smith machine row is never a machine seat (R4-07)', async () => {
  const { SEED_EXERCISES } = await import('../../../data/exercises.js');
  const smith = SEED_EXERCISES.filter(e => /^smith_machine_/.test(e.id) || / smith machine /i.test(' ' + e.name + ' '));
  assert.ok(smith.length > 0, 'the list holds Smith machine rows');
  for (const e of smith) {
    assert.equal(e.equipment, 'machine', e.id + ' sits on the Machine chip');
    assert.equal(e.machine, false, e.id + ' must have machine false');
  }
});

test('every input maxlength is a LIMITS constant and the validator uses the same constants (M21)', () => {
  const ui = shipped.filter(f => f.startsWith('ui/') || f === 'app.js');
  for (const f of ui) {
    for (const m of read(f).matchAll(/maxlength:\s*([^,}\n]+)/g)) {
      assert.match(m[1].trim(), /^String\(LIMITS(\.[A-Z_]+|\[limitKey\])\)$/, f + ' sets a maxlength that is not a LIMITS constant: ' + m[1].trim());
    }
  }
  const src = read('backup.js');
  const texts = [...src.matchAll(/c\.text\(([^)]*)\)/g)].map(m => m[1].trim()).filter(a => a !== 'max, min = 0' && a !== 'LIMITS.VERSION_STR, 1');
  assert.ok(texts.length > 10, 'validator text checks not found');
  for (const a of texts) assert.match(a, /^L\.[A-Z_]+(, 1)?$/, 'a validator text limit is not exactly a LIMITS constant: ' + a);
  const used = new Set([...ui.flatMap(f => [...read(f).matchAll(/String\(LIMITS\.([A-Z_]+)\)/g)].map(m => m[1]))]);
  const textKeys = new Set(texts.map(a => a.replace(/^L\./, '').replace(/, 1$/, '')));
  for (const k of ['NAME', 'NOTE']) assert.ok(used.has(k) && textKeys.has(k), k + ' must be used by an input and by the validator');
});

test('no UTC date cutting in store.js or ui files (M24)', () => {
  for (const f of shipped.filter(x => x === 'store.js' || x.startsWith('ui/'))) {
    const src = read(f);
    assert.ok(!/toISOString\(\)\s*\.slice/.test(src), f + ' cuts a date from toISOString()');
    assert.ok(!/\.split\(\s*['"]T['"]\s*\)/.test(src), f + " splits a time on 'T'");
  }
});

test('the builder offers no profile choice', () => {
  const src = read('ui/builder.js');
  assert.ok(!/adaptive/i.test(src), 'builder names another profile');
  assert.ok(!/profile/i.test(src.replace(/^\s*\/\/.*$/gm, '')), 'builder touches the profile');
});

test('linkStats returns two numbers and touches no store', () => {
  const src = read('db.js');
  assert.match(src, /const _stats = \{ opens: 0, retries: 0 \};/);
  const m = /linkStats\(\)\s*\{([^}]*\})?[^}]*\}/.exec(src);
  assert.ok(m, 'linkStats not found');
  assert.match(m[0], /^linkStats\(\) \{ return \{ \.\.\._stats \}; \}$/);
});

test('robots.txt is the two lines', () => {
  assert.equal(read('robots.txt'), 'User-agent: *\nDisallow: /\n');
});

// ---------------- review fixes (2026-11-09) ----------------

test('every text input has a maxlength, and each one matches its own validator field (C17)', () => {
  const ui = shipped.filter(f => f.startsWith('ui/') || f === 'app.js');
  for (const f of ui) {
    const src = read(f);
    for (const m of src.matchAll(/el\(\s*'(input|textarea)',\s*\{/g)) {
      const body = src.slice(m.index, src.indexOf('})', m.index));
      if (/type:\s*'file'/.test(body)) continue;
      assert.ok(/maxlength:/.test(body), f + ': an ' + m[1] + ' has no maxlength');
    }
  }
  const back = read('backup.js');
  // [file, a text unique to that input, the LIMITS constant it must use, the validator line it must match]
  const MAP = [
    ['ui/builder.js', "id: 'block-name'", 'NAME', /blockBody = \{\s*name: c\.text\(L\.NAME\)/],
    ['ui/builder.js', "id: 'block-notes-in'", 'NOTE', /passes: c\.intOrNull\(1, L\.PASSES_MAX\), notes: c\.text\(L\.NOTE\)/],
    ['ui/builder.js', "rows: '2'", 'NOTE', /count_label: c\.oneOfOrNull\(COUNT_LABELS\), note: c\.text\(L\.NOTE\)/],
    ['ui/builder.js', "id: 'make-name'", 'NAME', /exercises: \{\s*id: c\.id, name: c\.text\(L\.NAME, 1\)/],
    ['ui/today.js', "id: 'ex-text', 'aria-label': t('note.title')", 'NOTE', /link: c\.link, notes: c\.text\(L\.NOTE\)/],
    ['ui/today.js', "maxlength: String(LIMITS.STR), id: 'ex-text'", 'STR', /LINK_RE = \/\^https:\\\/\\\/\[\^\\s<>"\]\{1,500\}\$\//],
    ['ui/today.js', "id: 'fb-note'", 'NOTE', /checks: c\.map\(L\.CHECKS, c\.key, c\.boolOrNull\), note: c\.text\(L\.NOTE\)/]
  ];
  for (const [f, marker, constant, validator] of MAP) {
    const src = read(f);
    const at = src.indexOf(marker);
    assert.ok(at >= 0, f + ': input not found: ' + marker);
    const line = src.slice(src.lastIndexOf('\n', at), src.indexOf('\n', at));
    assert.ok(line.includes('String(LIMITS.' + constant + ')'), f + ': ' + marker + ' must use LIMITS.' + constant);
    assert.match(back, validator, 'the validator field for ' + marker + ' must use L.' + constant);
  }
  assert.equal(/STR: (\d+)/.exec(back)[1], '500', 'LIMITS.STR is the link length in LINK_RE');
});

test('no screen text joined in code: separators, set counts, arrows and marks come from strings.js (C26)', () => {
  const code = shipped.filter(f => f.endsWith('.js') && f !== 'ui/strings.js' && (f.startsWith('ui/') || f === 'app.js'));
  for (const f of code) {
    read(f).split('\n').forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return;
      assert.ok(!/' → '|→/.test(line), f + ':' + (i + 1) + ' builds an arrow in code');
      assert.ok(!/\+ ': ' \+|\+ ' · ' \+/.test(line), f + ':' + (i + 1) + ' joins screen words with a literal separator');
      assert.ok(!/\+ 'x'\)/.test(line), f + ':' + (i + 1) + ' builds a set count in code');
      assert.ok(!/\? 'W' :/.test(line), f + ':' + (i + 1) + ' writes the warmup mark in code');
    });
  }
});

test('a backup file built while a change comes in is thrown away (C2)', () => {
  const src = read('app.js');
  const stale = /stale\(\) \{([\s\S]*?)\n  \},/.exec(src);
  assert.ok(stale, 'backup.stale() not found');
  assert.match(stale[1], /this\.running = null;/, 'stale() must drop the build already in flight');
  assert.match(read('store.js'), /const t = now\(\);\s*const data = await readAll\(\);/, 'backupObject reads the time before the rows');
});

test('a picked file is size-checked before it is read (C11)', () => {
  const src = read('app.js');
  const at = src.indexOf("fileInput.addEventListener('change'");
  const body = src.slice(at, src.indexOf('document.body.appendChild(fileInput)', at));
  assert.ok(body.indexOf('f.size > fileMax') >= 0 && body.indexOf('f.size > fileMax') < body.indexOf('f.text()'), 'f.size is checked before f.text()');
  assert.match(read('ui/settings.js'), /pickFile\(LIMITS\.MAX_BLOCK_BYTES\)/, 'block files use their own small cap');
});

test('Phone check prints the cache name the worker gave, never one the page worked out (C8)', () => {
  assert.ok(!/ctx\.cache/.test(read('ui/check.js')), 'check.js reads ctx.cache');
  assert.ok(!/const CACHE =/.test(read('app.js')), 'app.js works out its own cache name');
});

// ---------------- review fix guards (R6, 2026-11-09): each one fails if its fix comes back out ----------------

// The text from the first line that holds `start` to the first later line that holds `end`.
function span(src, start, end) {
  const i = src.indexOf(start);
  assert.ok(i >= 0, 'not found: ' + start);
  const j = src.indexOf(end, i);
  assert.ok(j > i, 'not found after it: ' + end);
  return src.slice(i, j + end.length);
}

test('a failed restore shows its line and never reloads; one that worked reloads once (R1)', async () => {
  const { runJob } = await import('../../../ui/settings.js');
  const calls = [];
  const okGo = await runJob(async () => { throw new Error('write failed'); }, () => calls.push('reload'), () => calls.push('line'));
  assert.equal(okGo, false);
  assert.deepEqual(calls, ['line'], 'a failed restore shows the line and does not reload');
  calls.length = 0;
  assert.equal(await runJob(async () => 7, () => calls.push('reload'), () => calls.push('line')), true);
  assert.deepEqual(calls, ['reload'], 'a restore that worked reloads once');
  const s = read('ui/settings.js');
  assert.equal((s.match(/location\.reload\(/g) || []).length, 0, 'settings.js reloads only through ctx.reload');
  const a = read('app.js');
  assert.match(span(a, 'ctx.reload = () => {', '};'), /if \(reloading\) return;\s*reloading = true;/, 'ctx.reload reloads once');
  assert.match(span(a, "addEventListener('controllerchange'", 'location.reload();'), /if \(!askedToSwap \|\| reloading\) return;/, 'an update swap never reloads a second time');
});

test('an update reload waits for writes still in flight (C7)', () => {
  const h = span(read('app.js'), "addEventListener('controllerchange'", 'location.reload();');
  assert.match(h, /await Promise\.race\(\[store\.idle\(\),/, 'the reload no longer waits for store.idle()');
  assert.ok(h.indexOf('store.idle()') < h.indexOf('location.reload()'));
});

test('a share in progress counts as busy, so an update never reloads under it (C6)', () => {
  const a = read('app.js');
  const share = span(a, '  share(btn, onDone) {', 'navigator.share(data)');
  assert.match(share, /this\.sharing = true;/, 'share() no longer sets the flag before the share sheet');
  assert.match(span(a, 'function isBusy() {', '}'), /backup\.sharing/, 'isBusy forgets the share flag');
  assert.match(share, /const settled = \(\) => \{ this\.sharing = false; releaseHeld\(\); \};/);
});

test('every builder number field is named by its own column label (C24)', () => {
  const b = read('ui/builder.js');
  assert.match(b, /'aria-label': aria \}\)/, 'numField drops its label');
  assert.match(b, /const heads = \[t\('builder\.sets'\), t\('builder\.replow'\), t\('builder\.rephigh'\), t\('builder\.load'\)\];/);
  assert.match(b, /const aria = \{ sets: heads\[0\], rep_low: heads\[1\], rep_high: heads\[2\], start_load: heads\[3\] \};/, 'a field takes another column label');
  const words = ['builder.sets', 'builder.replow', 'builder.rephigh', 'builder.load'].map(k => new RegExp("'" + k.replace('.', '\\.') + "': '([^']+)'").exec(read('ui/strings.js')));
  assert.ok(words.every(Boolean), 'a builder label key has no words');
  assert.equal(new Set(words.map(m => m[1])).size, 4, 'two builder labels say the same thing');
});

test('a block whose last day is done shows the Block finished state, not No block (C27)', () => {
  const td = read('ui/today.js');
  assert.match(td, /block && block\.status === 'done' \? blockDone\(ctx, block\) : noBlock\(ctx\)/, 'a finished block reads as no block');
  // Slice 3 (17 C.3.9): the title with Start a new block and Copy this block, no line.
  const bd = span(td, 'function blockDone(ctx, block) {', '\n}');
  assert.match(bd, /t\('empty\.done\.title'\)[\s\S]*t\('fin\.new'\)[\s\S]*t\('fin\.copy'\)/);
  assert.doesNotMatch(bd, /empty\.done\.line/, 'the Slice 3 row has no line');
});

test('the No pill is grey with dark text, never the danger color (C28)', () => {
  const css = read('styles.css');
  const m = /\.pill-no\{([^}]*)\}/.exec(css);
  assert.ok(m, 'no .pill-no rule');
  assert.match(m[1], /color:var\(--ink\)/, 'the No pill text is not the ink color');
  assert.match(m[1], /background:var\(--surface-2\)/, 'the No pill is not grey');
  assert.ok(!/danger|warn|red|error/i.test(m[1]), 'the No pill uses a danger color');
});

test('reorder buttons move a lift up and down and stop at the ends (C32)', async () => {
  const { moveLift } = await import('../../../ui/builder.js');
  const d = { lifts: ['a', 'b', 'c'] };
  let n = 0;
  const redraw = () => { n++; };
  moveLift(d, 0, 1, redraw);
  assert.deepEqual(d.lifts, ['b', 'a', 'c']);
  moveLift(d, 2, -1, redraw);
  assert.deepEqual(d.lifts, ['b', 'c', 'a']);
  moveLift(d, 0, -1, redraw);
  moveLift(d, 2, 1, redraw);
  assert.deepEqual(d.lifts, ['b', 'c', 'a'], 'a move past an end changes nothing');
  assert.equal(n, 2, 'only a real move redraws');
  const b = read('ui/builder.js');
  assert.match(b, /'data-move': di \+ ':' \+ li \+ \(dir > 0 \? 'down' : 'up'\)/, 'the up and down buttons are gone');
  // The remove button sits after the pair (LOOK 4.6, 15 Part 3).
  assert.match(b, /move\(-1\), move\(1\), remove\)/, 'the buttons are not on the lift row');
});

test('the feedback sheet never closes on a scrim tap (C39)', () => {
  const td = read('ui/today.js');
  const call = span(td, "const sh = sheet({ id: 'feedback'", 'onClose: () => resolve() }');
  assert.match(call, /canDismiss: \(\) => false/, 'a scrim tap can close the feedback sheet');
});

test('the start weight steps move along the exercise own steps (C41)', async () => {
  const { stepLoad } = await import('../../../ui/today.js');
  const plates = { weight_steps: [10, 25, 40, 55], step_default: 5 };
  assert.equal(stepLoad(plates, 25, 1), 40);
  assert.equal(stepLoad(plates, 25, -1), 10);
  assert.equal(stepLoad(plates, 30, 1), 40, 'a load between steps goes to the next step');
  assert.equal(stepLoad(plates, 55, 1), 55, 'the top step stays');
  assert.equal(stepLoad(plates, null, 1), 10, 'no start weight goes to the first step');
  assert.equal(stepLoad({ weight_steps: null, step_default: 2.5 }, 20, 1), 22.5, 'no steps: the exercise own step size');
  assert.equal(stepLoad({ weight_steps: null, step_default: 2.5 }, 0, -1), 0, 'never below zero');
  assert.match(read('ui/builder.js'), /l\.start_load = stepStart\(b, ex, l\.start_load, dir\);/, 'the builder buttons do not use stepStart');
  assert.match(read('ui/builder.js'), /return stepLoad\(ex, load, dir, b && b\.unit === 'kg' \? 'kg' : 'lb'\);/, 'stepStart does not step through stepLoad in the build unit');
  // Stage 4 N3: Save hands createBlock the unit the start weights were stepped in.
  assert.match(read('ui/builder.js'), /await ctx\.store\.createBlock\(blockSpec\(b\), null, \{ activate \}\);/, 'Save does not build its spec with blockSpec');
  assert.match(read('ui/builder.js'), /day_templates: buildDays\(b\), unit: b\.unit \|\| undefined \}/, 'blockSpec does not carry the build unit');
});

// ---------------- the rules engine (DESIGN 16 B.10 item 1, B.12 static row) ----------------

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('engine.js and rules.js import nothing and never read the clock or a random number', () => {
  for (const f of ['engine.js', 'rules.js']) {
    const src = read(f);
    assert.ok(!/(^|\s)import[\s({'"]/m.test(src) && !/import\(/.test(src), f + ' imports');
    assert.ok(!/\bDate\b/.test(src), f + ' names Date');
    assert.ok(!/Math\.random|performance\.now|crypto\./.test(src), f + ' reads a clock or a random number');
    assert.ok(!/\b(localStorage|sessionStorage|indexedDB|window|document|globalThis|self|fetch|navigator)\b/.test(strip(src)), f + ' touches a global');
  }
  assert.ok(shellList().includes('engine.js') && shellList().includes('rules.js'), 'SHELL must hold engine.js and rules.js');
  assert.ok(shellList().includes('ui/block.js'), 'SHELL must hold ui/block.js (16 B.12)');
});

test('rules.js is data only: frozen, no function value, clean on both profiles', async () => {
  const m = await import('../../../rules.js');
  assert.deepEqual(Object.keys(m).sort(), ['RULES', 'RULES_BY_VERSION', 'RULE_VERSIONS']);
  const walk = (o, path) => {
    assert.notEqual(typeof o, 'function', 'function value at ' + path);
    if (o && typeof o === 'object') { assert.ok(Object.isFrozen(o), path + ' is not frozen'); for (const k of Object.keys(o)) walk(o[k], path + '.' + k); }
  };
  walk(m.RULES, 'RULES');
  const copy = m.RULES.profiles.adaptive.caps;
  assert.throws(() => { copy.top_sets = 4; }, TypeError);
  const { validateRules } = await import('../../../engine.js');
  assert.deepEqual(validateRules(m.RULES), { ok: true, errors: [] });
  assert.equal(m.RULES.rules_version, 'signed-2');
});

// 16 B.1 step 3 a, B.10 item 3, B.12 (r4.4 R14): backup.js keeps its own lists and imports neither
// rules.js nor data/exercises.js; each list equals its twin.
test('backup.js lists equal their twins in rules.js and data/exercises.js', async () => {
  const b = await import('../../../backup.js');
  const r = await import('../../../rules.js');
  const x = await import('../../../data/exercises.js');
  assert.ok(!/from\s+['"][./]*(rules|engine|data\/exercises)\.js['"]/.test(read('backup.js')), 'backup.js imports a twin');
  assert.deepEqual([...b.SET_KINDS], r.RULES.set_kinds.map(k => k.key), 'SET_KINDS');
  assert.deepEqual([...b.RULE_VERSIONS].sort(), [...new Set(['none', ...Object.keys(r.RULES_BY_VERSION)])].sort(), 'RULE_VERSIONS');
  assert.deepEqual([...b.RULE_VERSIONS], [...r.RULE_VERSIONS], 'RULE_VERSIONS equals the rules.js list');
  assert.ok(b.RULE_VERSIONS.includes(r.RULES.rules_version));
  assert.deepEqual([...b.MUSCLE_DETAILS], [...x.MUSCLE_DETAILS], 'MUSCLE_DETAILS');
  assert.deepEqual({ ...b.MUSCLE_DETAIL_CHIP }, { ...x.MUSCLE_DETAIL_CHIP }, 'MUSCLE_DETAIL_CHIP');
  assert.deepEqual([...b.EQUIPMENT_DETAILS], [...x.EQUIPMENT_DETAILS], 'EQUIPMENT_DETAILS');
  assert.deepEqual({ ...b.EQUIPMENT_DETAIL_CHIP }, { ...x.EQUIPMENT_DETAIL_CHIP }, 'EQUIPMENT_DETAIL_CHIP');
  assert.deepEqual([...b.TAG_CODES], [...x.TAG_CODES], 'TAG_CODES');
  assert.deepEqual([...b.LOAD_KINDS], [...x.LOAD_KINDS], 'LOAD_KINDS');
  // Every why a rules.js row names is a key a set may store (16 B.5.1).
  const whys = [];
  const walk = (o) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k === 'why') whys.push(v); else walk(v); } };
  walk(r.RULES);
  assert.ok(whys.length >= 12, 'the rule rows were read');
  for (const w of whys) assert.ok(b.WHY_KEYS.includes(w), w + ' is not in WHY_KEYS');
  assert.equal(b.WHY_KEYS.length, 33);
  assert.equal(new Set(b.WHY_KEYS).size, 33);
});

test('no shipped file but store.js imports engine.js or rules.js (16 B.1 step 5 R4 d)', () => {
  // The screens reach the engine through store calls, the way no screen imports db.js.
  const users = [];
  for (const f of shipped.filter(x => x.endsWith('.js') && x !== 'engine.js' && x !== 'rules.js')) {
    const src = read(f);
    const imp = /from\s+['"][./]*(engine|rules)\.js['"]/.test(src) || /import\(\s*['"][./]*(engine|rules)\.js['"]/.test(src);
    if (imp) users.push(f);
  }
  assert.deepEqual(users, ['store.js'], 'only store.js imports the engine and the rule table');
  assert.match(read('store.js'), /from '\.\/rules\.js'/);
  assert.match(read('store.js'), /from '\.\/engine\.js'/);
});

// r4.4 R4 a: from schema 2 on a set stores a why key; the seven Slice 1 texts live only in
// backup.js (WHY and WHY_KEY_OF, read by MIGRATIONS[1]).
test('no shipped file but backup.js names a Slice 1 why text', async () => {
  const b = await import('../../../backup.js');
  assert.equal(b.WHY.length, 7);
  // ui/strings.js holds the words of every why key (16 B.5.1), so it may name each text once, as
  // the value of its own key and nowhere else (Slice 2 step 6 provisional call, BUILD_LOG).
  for (const f of textShipped.filter(x => x !== 'backup.js')) {
    let src = read(f);
    if (f === 'ui/strings.js') {
      for (const [w, k] of Object.entries(b.WHY_KEY_OF)) {
        const line = "  '" + k + "': '" + w + "',\n";
        assert.equal(src.split(line).length - 1, 1, 'ui/strings.js holds the words of ' + k + ' once, on its own line');
        src = src.replace(line, '');
      }
    }
    for (const w of b.WHY) assert.ok(!src.includes(w), f + ' names the Slice 1 why text "' + w + '"');
  }
});

// ---------------- Slice 2 step 6: the 5.11 keys of B.5 (16 B.1 step 6) ----------------

// B.5 rows 1 to 18 (rows 2, 4, 14, 15 are the step 8 and 9 builders' parts; their words go in now).
const SLICE2_KEYS = {
  1: ['sleep.q', 'fb.no', 'fb.yes'],
  2: ['day.notplanned', 'day.notplanned.line', 'day.later.line', 'check.backtab'],
  3: ['pill.easy'],
  4: ['easy.title', 'easy.line', 'easy.line.one', 'easy.go', 'text.cancel'],
  5: ['mark.met', 'mark.under'],
  6: ['daymenu.skip', 'skipday.title', 'skipday.line', 'text.cancel'],
  7: ['daymenu.end', 'end.title', 'end.line', 'end.open', 'empty.done.title', 'empty.done.line'],
  8: ['menu.answers'],
  9: ['fb.sore.title', 'fb.sub.one', 'fb.q.soreness', 'fb.a.soreness', 'fb.save', 'fb.later', 'fb.skip'],
  10: ['scope.title', 'scope.today', 'scope.rest', 'scope.rest.line', 'text.cancel', 'scope.refused.flag', 'scope.refused.last'],
  11: ['set.kind', 'setkind.normal.name', 'setkind.normal.line', 'setkind.failure.name', 'setkind.failure.line'],
  13: ['today.retarget'],
  14: ['block.title', 'block.head', 'block.head.open', 'profile.fixed', 'profile.adjust', 'round.short', 'round.done', 'round.now',
    'round.easy', 'round.label', 'blockday.done', 'blockday.now', 'day.notplanned', 'block.musclesets', 'block.musclediff', 'daymenu.end'],
  15: ['adjust.row', 'adjust.title', 'adjust.line', 'adjust.type', 'adjust.go', 'text.cancel', 'adjust.back', 'adjust.back.title', 'adjust.back.line'],
  16: ['db.reopen', 'db.upgradefail'],
  17: ['daymenu.addex', 'addex.sets', 'text.save', 'text.cancel'],
  18: ['menu.remove']
};

test('ui/strings.js holds every 5.11 key of the Slice 2 screen parts (16 B.5, B.1 step 6)', async () => {
  const { S } = await import('../../../ui/strings.js');
  for (const [row, keys] of Object.entries(SLICE2_KEYS)) {
    for (const k of keys) assert.ok(k in S && S[k].length > 0, 'B.5 row ' + row + ' key missing: ' + k);
  }
  // Each set kind of rules.js has its name and its line (R4-12); the picker lists exactly these.
  const r = await import('../../../rules.js');
  for (const k of r.RULES.set_kinds.map(x => x.key)) {
    assert.equal(typeof S['setkind.' + k + '.name'], 'string', 'setkind.' + k + '.name');
    assert.equal(typeof S['setkind.' + k + '.line'], 'string', 'setkind.' + k + '.line');
  }
  // The count key and its .one form fill the same slots (easy.line).
  assert.ok('easy.line.one' in S && /\{n\}/.test(S['easy.line']));
  // No placeholder is left in the words (B.12 static row).
  for (const [k, v] of Object.entries(S)) for (const x of [v].flat()) assert.ok(!/OWED|TODO|TBD|DRAFT/.test(String(x)), k + ' holds a placeholder');
});

test('every why key in rules.js and in WHY_KEYS has its words in ui/strings.js (16 B.5.1)', async () => {
  const { S } = await import('../../../ui/strings.js');
  const b = await import('../../../backup.js');
  const r = await import('../../../rules.js');
  const whys = [];
  const walk = (o) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k === 'why') whys.push(v); else walk(v); } };
  walk(r.RULES);
  for (const k of new Set([...whys, ...b.WHY_KEYS])) assert.ok(typeof S[k] === 'string' && S[k].length > 0, k + ' has no words in ui/strings.js');
  // The words are those 5.11 gives the Slice 1 texts (R4-29): each key reads back its old text.
  for (const [w, k] of Object.entries(b.WHY_KEY_OF)) assert.equal(S[k], w);
});

test('version.js RULES_VERSION is the rules.js rules_version, written as a literal (16 B.2 note 4)', async () => {
  const r = await import('../../../rules.js');
  const v = await import('../../../version.js');
  assert.equal(v.RULES_VERSION, r.RULES.rules_version);
  assert.ok(!/import\s/.test(read('version.js')), 'version.js imports nothing');
});

// The engine line-up with r4.1 (DESIGN 16 B.1 step 0 list), shipped as 0.2.5, schema 1, still not wired.
test('engine.js and rules.js cite a source only as "health-coach verdict item N" or "TD-n"', () => {
  for (const f of ['engine.js', 'rules.js']) {
    const comments = [...read(f).matchAll(/(?:^|[^:])\/\/(.*)$/gm)].map(m => m[1]);
    for (const c of comments) {
      assert.ok(!/signed ruling|\bW\d\b|\breview\b|\bQ\d+\b|\bDESIGN\b|\bblueprint\b/i.test(c), f + ' cites a source in another form: ' + c.trim());
      for (const m of c.matchAll(/\b(R4-\d+|C\d+)\b/g)) assert.ok(c.slice(0, m.index).endsWith('health-coach verdict item '), f + ' names ' + m[1] + ' without "health-coach verdict item"');
    }
  }
});

test('the effort key of record is short_sleep_failure_reps_left on both profiles, read by the engine', async () => {
  const m = await import('../../../rules.js');
  for (const p of ['fixed', 'adaptive']) {
    assert.deepEqual(Object.keys(m.RULES.profiles[p].effort).sort(), ['failure_reps_left', 'length_max', 'length_min', 'reps_left_by_pass', 'short_sleep_failure_reps_left']);
    assert.equal(m.RULES.profiles[p].effort.short_sleep_failure_reps_left, 2);
  }
  assert.equal((read('engine.js').match(/\.short_sleep_failure_reps_left\b/g) || []).length, 2, 'validateRules and planDay read the key');
});

// ---------------- Slice 1 polish pass, step 0 (DESIGN 15 P.3 static row) ----------------

test('a restore pick is capped at MAX_PICK_BYTES before it is read; a block file keeps its own cap (A3-R2)', () => {
  const app = read('app.js');
  assert.match(app, /let fileMax = LIMITS\.MAX_PICK_BYTES;/, 'the pick default is the 64 MiB cap');
  assert.match(app, /fileMax = maxBytes \|\| LIMITS\.MAX_PICK_BYTES;/);
  assert.match(read('ui/settings.js'), /restoreFlow\(ctx\) \{\n  ctx\.pickFile\(LIMITS\.MAX_PICK_BYTES\)/, 'Restore picks with the 64 MiB cap');
  assert.ok(!/MAX_RAW_BYTES/.test(app + read('ui/settings.js')), 'no screen picks with the validator bound');
});

test('the restore note is read once after the first render (A3-R8)', () => {
  const app = read('app.js');
  const boot = span(app, 'async function boot()', '\nboot();');
  assert.ok(boot.indexOf('render();') < boot.indexOf('store.takeRestoreNote()'), 'the note is read after the first render');
  assert.match(boot, /toast\(t\('restore\.done', \{ n \}\)\)/);
});

// ---------------- A1-3: every screen word has a key, every control a name (DESIGN 14.4 A1-3, 5.11 D.1, D.2) ----------------

const GAP_KEYS = ['today.tick', 'today.tick.done', 'today.tick.saving', 'pill.skipped', 'pill.skipped.aria',
  'step.load.less', 'step.load.more', 'step.reps.less', 'step.reps.more', 'field.load', 'field.reps', 'tally.aria',
  'tally.aria.one', 'video.watch', 'link.label', 'link.bad', 'link.clear', 'note.title', 'tab.settings.due', 'settings.group.backup',
  'settings.group.block', 'settings.group.danger', 'settings.backup.due', 'settings.backupnow', 'builder.name', 'builder.notes',
  'builder.liftnote', 'builder.fail', 'builder.progress', 'builder.liftsets.one', 'count.blocks.one', 'count.blocks', 'count.days.one',
  'count.days', 'count.sets.one', 'count.sets', 'backup.big', 'undo.reset', 'restore.phone', 'file.toobig'];

test('ui/strings.js holds every Slice 1 gap key and every count key (A1-3, A2-4)', async () => {
  const { S } = await import('../../../ui/strings.js');
  for (const k of GAP_KEYS) assert.ok(k in S, 'missing string key ' + k);
  assert.ok(!/\{blocks\} blocks|\{days\} finished days|\{sets\} done sets/.test(S['restore.phone']), 'restore.phone fills its counts from the count keys');
});

test('every key the screens ask for is in ui/strings.js (no old key name left)', async () => {
  const { S } = await import('../../../ui/strings.js');
  const code = shipped.filter(f => f.endsWith('.js') && f !== 'ui/strings.js' && (f.startsWith('ui/') || f === 'app.js'));
  let n = 0;
  for (const f of code) {
    for (const m of read(f).matchAll(/\bt[n]?\(\s*'([a-z0-9_.]+)'/g)) {
      n++;
      // A key built from a prefix (t('fb.q.' + key)) must name at least one key with that prefix.
      if (m[1].endsWith('.')) assert.ok(Object.keys(S).some(k => k.startsWith(m[1])), f + ' asks for a key prefix that is not in strings.js: ' + m[1]);
      else assert.ok(m[1] in S, f + ' asks for a key that is not in strings.js: ' + m[1]);
    }
  }
  assert.ok(n > 100, 'key reads not found');
});

test('the set tick has a name in every state; the tally is named and only its strokes are hidden (A1-3)', () => {
  const src = read('ui/today.js');
  const tick = span(src, "const tick = el('button', { class: 'tick'", '\n');
  assert.match(tick, /'aria-label': tickName/, 'the tick button has no name');
  assert.match(src, /const tickName = state === 'done' \? t\('today\.tick\.done', \{ set \}\)/);
  const tally = span(src, "const tally = el('span', { class: 'tally'", '\n');
  assert.ok(!/aria-hidden/.test(tally), 'the tally itself is hidden from a screen reader');
  assert.match(tally, /'aria-label': counted\.length === 1 \? t\('tally\.aria\.one'/);
  assert.match(src, /class: 'tally-stroke'[^\n]*'aria-hidden': 'true'/, 'the strokes stay hidden');
});

test('the Settings tab says in words that a backup is due; the dot stays a picture (A1-3)', () => {
  const app = read('app.js');
  assert.match(app, /if \(due\) tab\.setAttribute\('aria-label', t\('tab\.settings\.due'\)\); else tab\.removeAttribute\('aria-label'\);/);
  const set = read('ui/settings.js');
  for (const k of ['settings.group.backup', 'settings.group.block', 'settings.group.danger']) assert.ok(set.includes("t('" + k + "')"), 'Settings shows ' + k);
});

test('a refused video link shows the link line (A1-3)', () => {
  const src = read('ui/today.js');
  assert.match(src, /t\('link\.bad'\)/);
  assert.match(src, /input\.setAttribute\('aria-invalid', 'true'\); badLine\.hidden = false; return;/);
});

// ---------------- polish step 1: every key in every Part's Keys line (DESIGN 15 P.2, r4 review R29) ----------------

const P2_KEYS = {
  1: ['day.menu', 'day.relabel', 'relabel.title', 'relabel.help', 'relabel.clear', 'day.n', 'text.cancel', 'text.save'],
  2: ['builder.defaultname'],
  3: ['builder.remove', 'builder.dayempty'],
  4: ['draft.title', 'draft.line', 'draft.keep', 'draft.over'],
  5: ['today.noload', 'today.noload.range', 'today.noload.open', 'today.goal.open'],
  7: ['settings.group.logging', 'carry.label', 'carry.line', 'switch.on', 'switch.off'],
  8: ['range.title', 'range.line', 'range.line.open', 'range.log', 'range.noask', 'range.setting', 'range.setting.line', 'text.cancel'],
  9: ['set.menu', 'set.menu.title', 'set.addbelow'],
  10: ['set.delete', 'set.delete.done', 'set.delete.draft', 'set.delete.last'],
  11: ['menu.up', 'menu.down', 'builder.up', 'builder.down'],
  12: ['day.reset', 'reset.title', 'reset.line', 'reset.line.one', 'reset.type', 'undo.reset', 'text.cancel'],
  13: ['today.progress', 'today.progress.one'],
  14: ['done.title', 'done.tally', 'done.tally.one', 'done.sets.one', 'done.sets', 'done.ex.one', 'done.ex', 'done.skipped.one', 'done.skipped', 'done.go'],
  15: ['daymenu.skip', 'skipday.title', 'skipday.line', 'today.finish.none', 'text.cancel'],
  16: ['breaks.title', 'breaks.more', 'breaks.aria'],
  17: ['check.inset.title', 'menu.checks', 'check.says', 'check.stop', 'check.keep', 'check.sticky', 'fb.no', 'fb.yes']
};

test('ui/strings.js holds every key of every polish Part (P.2 Keys lines, R29)', async () => {
  const { S } = await import('../../../ui/strings.js');
  for (const [part, keys] of Object.entries(P2_KEYS)) {
    for (const k of keys) assert.ok(k in S && typeof S[k] === 'string' && S[k].length > 0, 'Part ' + part + ' key missing: ' + k);
  }
  // A count key and its .one form fill the same slots, so the right one can always be picked.
  for (const k of ['reset.line', 'today.progress', 'done.tally', 'done.sets', 'done.ex', 'done.skipped', 'tally.aria']) assert.ok((k + '.one') in S, k + ' has no .one form');
  // The Day done screen and the empty Block finished state keep apart (R4-27).
  assert.ok('empty.done.title' in S && 'done.title' in S && S['empty.done.title'] !== S['done.title']);
});

test('the relabel input maxlength equals LIMITS.LABEL (15 Part 1)', () => {
  assert.match(read('ui/today.js'), /id: 'relabel-in', maxlength: String\(LIMITS\.LABEL\)/, 'the relabel field is not capped by LIMITS.LABEL');
});

// ---------------- Slice 1 polish pass, stage 3 (DESIGN 15 Parts 13, 19) ----------------

// No set row draws a Done, Goal or Not saved pill (14.8 X1): only .set.is-failed rules may read the fail color.
test('only the failed-save row reads the fail color (Part 19, PD53, X1)', () => {
  const css = read('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const allowed = (sel) => sel.split(',').every(x => /^\s*\.set\.is-failed\b/.test(x));
  let readers = 0;
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/var\(--fail(-bg)?\)/.test(m[2])) continue;
    readers++;
    assert.ok(allowed(m[1].trim()), m[1].trim() + ' reads the fail color');
  }
  assert.ok(readers >= 1, 'the failed-save row still reads the fail color');
  assert.ok(!/banner-fail/.test(read('app.js')), 'app.js still uses the red banner');
  const sb = span(read('app.js'), 'function storageBlocked(err) {', '\n}');
  assert.match(sb, /class: 'blocked'/, 'storage blocked uses the Blocked skin');
  assert.match(sb, /role: 'alert'/);
  assert.ok(!/el\('button'/.test(sb), 'the Blocked skin has no button');
});

test('the day progress line is a native progress set by setAttribute, never .style (Part 13)', () => {
  const td = read('ui/today.js');
  const fn = span(td, 'function progressLine(sets) {', '\n}');
  assert.match(fn, /el\('progress'/);
  assert.match(fn, /setAttribute\('max'/);
  assert.match(fn, /setAttribute\('value'/);
  assert.ok(!/\.style\b/.test(fn), 'no .style on the progress bar');
  assert.ok(!/\bprogress[^\n]*\.style\b/.test(td), 'no .style on the progress bar anywhere in today.js');
});

test('the Day done route checks its id and goes to Today otherwise; no bottom bar (Part 14)', () => {
  const app = read('app.js');
  assert.match(app, /route\.startsWith\(DAYDONE\)\) \{ root\.appendChild\(renderDayDone\(ctx, route\.slice\(DAYDONE\.length\)\)\); return; \}/, 'the route returns before the bottom bar');
  const fn = span(read('ui/today.js'), 'export function renderDayDone(ctx, dayId) {', '\n}');
  assert.match(fn, /want && want\.id === dayId \? await ctx\.store\.dayTotals\(dayId\)/, 'only the day this session finished');
  assert.match(fn, /if \(!r\) \{ ctx\.dayDone = null; ctx\.go\('#\/today'\); return; \}/);
  assert.match(read('store.js'), /async function dayTotals\(dId\) \{\n    const day = await db\.get\('days', checkId\(dId\)\);\n    if \(!day \|\| day\.status !== 'done'\) return null;/, 'checkId and a done day');
});

// ---------------- polish review fixes, stage 1 ----------------

// G3 (review P2, P23, P32; DESIGN 15 P.4 item 9, 14.7 L1): the pending label check runs over the
// values of ui/strings.js only, whole word, case-sensitive. Every entry here is made up, never a
// real list entry; the made-up lists live in a temp folder that is removed after the test.
import { mkdtempSync as mkTemp, writeFileSync as writeTemp, rmSync as rmTemp } from 'node:fs';
import { tmpdir as tmpDir } from 'node:os';
import { spawnSync as spawnTemp } from 'node:child_process';
const guardMod = await import('../repo_guard.js');
function madeUpLists(pending) {
  const dir = mkTemp(join(tmpDir(), 'liftlog-pend-'));
  writeTemp(join(dir, 'banned_words.txt'), 'qzx' + 'bannedword\n');
  writeTemp(join(dir, 'banned_substrings.txt'), 'qzx' + 'substr\n');
  writeTemp(join(dir, 'allowed_words.txt'), 'qzx' + 'allowedword\n');
  writeTemp(join(dir, 'personal_words.txt'), 'qzx' + 'personword\n');
  if (pending !== null) writeTemp(join(dir, 'banned_pending.txt'), pending);
  return dir;
}

test('pending label check: a planted value fails and names the key only (G3, P.4 item 9)', () => {
  const dir = madeUpLists('# made up\nZorvexa\n');
  try {
    const pend = guardMod.loadPending(dir);
    assert.equal(pend.error, undefined);
    const hits = guardMod.pendingHits(pend, { 'a.key': 'Try Zorvexa today', 'b.list': ['plain', 'Zorvexa.'], 'c.ok': 'plain' });
    assert.deepEqual(hits, ['ui/strings.js value a.key  pending label #1', 'ui/strings.js value b.list[1]  pending label #1']);
    assert.ok(hits.every(h => !h.includes('Zorvexa')), 'a hit never prints the entry');
  } finally { rmTemp(dir, { recursive: true, force: true }); }
});

test('pending label check: the same letters inside a longer word pass, another case passes, keys are left out (G3, P.4 item 9)', () => {
  const dir = madeUpLists('Zorvexa\n');
  try {
    const pend = guardMod.loadPending(dir);
    assert.deepEqual(guardMod.pendingHits(pend, { a: 'Zorvexas', b: 'unZorvexa', c: 'zorvexa', d: 'ZORVEXA', 'Zorvexa.key': 'plain' }), []);
  } finally { rmTemp(dir, { recursive: true, force: true }); }
});

test('pending label check: a missing or empty pending list fails like the other lists (G3, P.4 item 9)', () => {
  const none = madeUpLists(null);
  const empty = madeUpLists('# only a note\n\n');
  try {
    assert.match(guardMod.loadPending(none).error, /list missing: banned_pending\.txt/);
    assert.match(guardMod.loadPending(empty).error, /list has no terms: banned_pending\.txt/);
    for (const dir of [none, empty]) {
      const r = spawnTemp('node', [join(APP, 'scripts', 'tests', 'repo_guard.js')], { cwd: APP, env: { ...process.env, LIFTLOG_PRIVATE_DIR: dir }, encoding: 'utf8' });
      assert.equal(r.status, 2, 'the guard exits 2 with no usable pending list');
      assert.match(r.stdout, /FAIL repo_guard list (missing|has no terms): banned_pending\.txt/);
    }
  } finally { for (const d of [none, empty]) rmTemp(d, { recursive: true, force: true }); }
});

test('pending label check: the guard reads strings.js values only, never other files (G3, 14.7 L1)', () => {
  // A made-up entry that is a real word of the app name: it sits in many repo files, yet only
  // strings.js values may be named, and each hit names a key.
  const dir = madeUpLists('Lift\n');
  try {
    const r = spawnTemp('node', [join(APP, 'scripts', 'tests', 'repo_guard.js')], { cwd: APP, env: { ...process.env, LIFTLOG_PRIVATE_DIR: dir }, encoding: 'utf8' });
    const fails = r.stdout.split('\n').filter(l => l.startsWith('FAIL repo_guard'));
    assert.equal(r.status, 1);
    assert.ok(fails.length > 0, 'a value holding the entry fails');
    assert.ok(fails.every(l => l.startsWith('FAIL repo_guard ui/strings.js value ') && l.endsWith('  pending label #1')), 'only strings values are named');
    assert.ok(fails.some(l => l.includes(' value install.title ')), 'the key is named');
  } finally { rmTemp(dir, { recursive: true, force: true }); }
});

test('repo_guard wordRe: a space in a listed term matches a space, _, - or nothing, never inside a longer word (r4.2 X2, 14.5 R1)', () => {
  // A made-up two-word term, never a real list entry.
  const re = guardMod.wordRe('Qzx Vorb');
  const hit = (t) => { re.lastIndex = 0; return re.test(t); };
  for (const t of ['a qzx vorb b', 'qzx_vorb', 'qzx-vorb', 'qzxvorb', 'QzxVorb_x: 6', 'x.qzx-vorb.js']) assert.ok(hit(t), 'matches the form ' + JSON.stringify(t));
  for (const t of ['aqzx vorb', 'qzx vorbs', 'qzxvorbing', 'xqzx_vorb', 'qzx  vorb', 'qzx__vorb']) assert.ok(!hit(t), 'no match inside a longer word or a wider gap: ' + JSON.stringify(t));
  const re4 = guardMod.wordRe4('Qzx Vorb');
  assert.ok(re4.test('qzx vorb'), 'the r4 rule keeps the space form');
  for (const t of ['qzx_vorb', 'qzx-vorb', 'qzxvorb']) { re4.lastIndex = 0; assert.ok(!re4.test(t), 'the r4 rule is the old whole-word rule'); }
});

test('the update busy check counts a draft only, and still holds on the builder route (G11, review P6)', () => {
  const src = read('app.js');
  const body = src.slice(src.indexOf('function isBusy()'), src.indexOf('function releaseHeld()'));
  assert.match(body, /hasDraft\(ctx\.build\)/, 'isBusy reads hasDraft(ctx.build)');
  assert.doesNotMatch(body, /!!ctx\.build/, 'an empty build is not busy');
  assert.match(body, /r === '#\/builder'/, 'the builder route still holds an update');
  assert.match(src, /import \{[^}]*\bhasDraft\b[^}]*\} from '\.\/ui\/builder\.js';/);
});

test('the reset, restore and erase sheets close on a scrim tap only while nothing is typed (G17, review P19, LOOK 3.3)', () => {
  const today = read('ui/today.js'), settings = read('ui/settings.js'), dom = read('ui/dom.js');
  assert.match(today, /sheet\(\{ id: 'reset-sheet', title: t\('reset\.title'\), canDismiss: \(\) => untyped\(conf\) \}/);
  assert.match(settings, /sheet\(\{ id: 'restore-sheet', title: t\('settings\.restore'\), canDismiss: \(\) => untyped\(conf\) \}/);
  assert.match(settings, /title: t\(snapsOnly \? 'erase\.snaps' : 'settings\.erase'\), canDismiss: \(\) => untyped\(conf\) \}/);
  assert.match(dom, /export function untyped\(confirmLabel\) \{\n  const input = confirmLabel && confirmLabel\.querySelector\('input'\);\n  return !input \|\| input\.value === '';/);
});

test('the range line puts its numbers in .num, text only (G18 a, review P21 a, LOOK 4.10)', () => {
  const today = read('ui/today.js');
  assert.match(today, /el\('p', \{ id: 'range-line' \}, numSplit\(ask\.key, ask\.vals\)\.map\(p => \(p\.num !== undefined \? el\('span', \{ class: 'num' \}, p\.num\) : p\.text\)\)\)/);
});

test('the field placeholder shows in --ink-2 (G18 b, review P21 b, LOOK 4.6)', () => {
  assert.match(read('styles.css'), /\n\.field::placeholder\{color:var\(--ink-2\); opacity:1\}/);
});

// ---------------- Polish review fixes, stage 2 (DESIGN 14.8) ----------------

test('the builder Cancel button goes through cancelBuild, which keeps a typed draft (G4, review P13)', () => {
  const src = read('ui/builder.js');
  assert.match(src, /id: 'builder-cancel', on: \{ click: \(\) => cancelBuild\(ctx\) \}/, 'Cancel does not call cancelBuild');
  const body = span(src, 'export function cancelBuild(ctx) {', '\n}');
  assert.match(body, /if \(!hasDraft\(ctx\.build\)\) ctx\.build = null;/, 'cancelBuild drops a typed draft');
});

test('the empty-day Review line starts with our own info glyph, sized by --glyph-sm in --ink (G18 c, review P21 c, LOOK 4.6)', () => {
  const html = read('index.html');
  const g = /<svg id="g-info"[^>]*>/.exec(html);
  assert.ok(g, 'no g-info glyph in the index.html sprite');
  assert.match(g[0], /aria-hidden="true"/, 'g-info is not hidden from a screen reader');
  assert.match(g[0], /stroke="currentColor"/, 'g-info does not take the text color');
  const src = read('ui/builder.js');
  assert.match(src, /'data-dayempty': String\(b\.days\.indexOf\(d\)\) \},\n      glyph\('info'\), el\('span', \{ class: 'grow' \}, t\('builder\.dayempty'/, 'the dayempty row does not start with the info glyph');
  assert.match(read('styles.css'), /\n\.row\[data-dayempty\] svg\{width:var\(--glyph-sm\); height:var\(--glyph-sm\); flex:none; color:var\(--ink\)\}/);
});

test('the struck pill keys are gone from ui/strings.js (X1)', async () => {
  const { S } = await import('../../../ui/strings.js');
  for (const k of ['pill.done', 'pill.goal', 'pill.notsaved']) assert.ok(!(k in S), 'struck key still in strings.js: ' + k);
  assert.ok(!/pill-(done|goal|notsaved)/.test(read('styles.css')), 'a struck pill still has a style');
});

test('the long toast: measured, 6 s, 3 lines, left-aligned, --r-lg (stage 4 B4, LOOK 3.7, DESIGN 4.2)', () => {
  const css = read('styles.css');
  const dom = read('ui/dom.js');
  assert.match(css, /--t-toast-action:6000ms;/, 'the --t-toast-action token is 6000ms');
  const reduce = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.ok(!/--t-toast-action/.test(reduce.slice(0, reduce.indexOf('}\n}') + 3)), 'reduced motion never zeroes a toast time');
  const rule = /\.toast\.is-long\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'there is a .toast.is-long rule');
  for (const want of ['border-radius:var(--r-lg)', 'text-align:left', '-webkit-line-clamp:3']) assert.ok(rule[1].includes(want), '.toast.is-long lacks ' + want);
  assert.match(dom, /const wraps = measureWraps\(toastNode\);/, 'toast() measures the rendered toast');
  assert.match(dom, /toastTime\(wraps, tokenMs\('--toast-ms', 3000\), tokenMs\('--t-toast-action', 6000\)\)/, 'toast() picks its time from the two tokens');
  assert.ok(!/text\)?\.length\s*>/.test(dom.slice(dom.indexOf('export function toast(')).split('\n}')[0]), 'toast() never counts characters');
});

test('the primary button text is --fs-btn 18px (stage 4 B5, LOOK 3.4 Primary)', () => {
  const css = read('styles.css');
  assert.match(css, /--fs-btn:18px;/, 'the --fs-btn token is 18px');
  const rule = /\.btn-primary\{([^}]*)\}/.exec(css);
  assert.ok(rule && rule[1].includes('font-size:var(--fs-btn)'), 'the primary button text uses --fs-btn');
});

test('every disabled control is drawn at opacity .4 (stage 4 B6, LOOK 3.2 sticky yes, 3.4 states)', () => {
  const css = read('styles.css');
  const rules = [...css.matchAll(/([^{}\n]*(?:\[disabled\]|:disabled)[^{}\n]*)\{([^}]*)\}/g)].filter(m => /opacity:/.test(m[2]));
  assert.ok(rules.length >= 2, 'the disabled rules are found');
  for (const m of rules) assert.match(m[2], /opacity:\.4\b/, m[1].trim() + ' must use opacity .4');
});

test('the tally slash and the group gap are drawn (stage 4 B3, LOOK 3.9)', () => {
  const css = read('styles.css');
  const src = read('ui/today.js');
  assert.match(css, /--tally-slash:34px;/);
  assert.match(css, /--tally-group-gap:10px;/);
  assert.match(css, /\.tally\.tally-grouped\{gap:var\(--tally-group-gap\)\}/, 'groups are set apart by --tally-group-gap');
  const slash = /\.tally-slash\{([^}]*)\}/.exec(css);
  assert.ok(slash && /position:absolute/.test(slash[1]) && /rotate\(62deg\)/.test(slash[1]) && /height:var\(--tally-slash\)/.test(slash[1]), 'the slash is absolute, 34px long and turned 62deg');
  assert.match(css, /\.tally-slash\.is-done\{background:var\(--chalk\)\}/);
  assert.equal((src.match(/^\s+fillTally\(tally, /gm) || []).length, 2, 'the card tally and the Day done tally both draw groups');
  assert.match(src, /class: 'tally-slash'[^\n]*'aria-hidden': 'true'/, 'the slash is hidden from a screen reader like the strokes');
});

// ---------------- r4.3 light pass (DESIGN 14.9) ----------------

// H14: every planted row's find text matches its file exactly once, on every light run, so a
// find text that drifts fails here at once and never as ERROR in the heavy run. The edits of one
// row are applied in order in memory (a later edit reads the file as the earlier one left it);
// a replace that is a function (it reads a private list) is never called here. Inside a planted
// copy the runner sets LIFTLOG_MUTANT_ROW, because that row has used up its own find text.
test('every planted find text matches its file exactly once', { skip: process.env.LIFTLOG_MUTANT_ROW ? 'inside a planted copy' : false }, async () => {
  const { ROWS } = await import('../mutants.js');
  const bad = [];
  for (const row of ROWS) {
    const mem = new Map(Object.entries(row.create || {}));
    for (const e of row.edits || []) {
      if (!mem.has(e.file)) {
        if (!existsSync(join(APP, e.file))) { bad.push(row.id + ': ' + e.file + ' is missing'); continue; }
        mem.set(e.file, readFileSync(join(APP, e.file), 'utf8'));
      }
      const src = mem.get(e.file);
      const n = typeof e.find === 'string' ? src.split(e.find).length - 1 : (src.match(new RegExp(e.find.source, 'g')) || []).length;
      if (n !== 1) { bad.push(row.id + ': the find text matched ' + n + ' times in ' + e.file); continue; }
      const rep = typeof e.replace === 'function' ? '/* planted */' : e.replace;
      mem.set(e.file, typeof e.find === 'string' ? src.split(e.find).join(rep) : src.replace(e.find, rep));
    }
  }
  assert.ok(ROWS.length > 100, 'the planted table was read');
  assert.deepEqual(bad, []);
});

// H8 named tests for built contract rows (P.3 r4.3 rows).
// r4.6 Q1 narrowed E16: no write deletes a day row, except resize on the typed REMOVE (resizeRounds),
// and then only planned days with untouched sets (untouchedDays, re-checked inside the job).
test('E16: no write deletes a day row', async () => {
  const { S } = await import('../../../ui/strings.js');
  assert.doesNotMatch(read('backup.js'), /store:\s*'days',\s*del\b/, 'backup.js holds a day delete op');
  const st = read('store.js');
  const hits = [...st.matchAll(/store:\s*'days',\s*del\b/g)].map(m => m.index);
  const at = st.indexOf('  function resizeRounds(');
  const end = st.indexOf('\n  }\n', at);
  assert.equal(hits.length, 1, 'store.js holds one day delete op');
  assert.ok(at > 0 && hits[0] > at && hits[0] < end, 'the one day delete op sits in resizeRounds');
  const body = st.slice(at, end);
  assert.match(body, /if \(delta === -1 && typed !== REMOVE_WORD\) return Promise\.reject/, 'minus needs REMOVE typed');
  assert.match(body, /const rows = await untouchedDays\(block, days, r\.remove\);\s*if \(!rows\) throw new Refused\('day past the end'\);/, 'only untouched planned days');
  const keys = Object.keys(S);
  assert.deepEqual(keys.filter(k => /^days?\./.test(k) && /(delete|remove|erase)/i.test(k)), [], 'ui/strings.js holds no day delete key');
});

test('E18: Erase all is the only whole reset', () => {
  const src = read('store.js');
  assert.equal(src.split('db.replaceAll(').length - 1, 2, 'db.replaceAll( appears in replaceWith and eraseAll only');
  const at = src.lastIndexOf('\n  return {\n');
  const names = src.slice(at, src.indexOf('\n  };\n', at)).match(/[A-Za-z_]\w*(?=\s*[:,(]|\s*$)/gm) || [];
  const resets = [...new Set(names.filter(n => /reset|erase|wipe|clear/i.test(n)))].sort();
  assert.deepEqual(resets, ['clearSnapshots', 'eraseAll', 'resetDay'], 'the store names no other reset');
});

test('O05: the since line counts up and nothing counts down', async () => {
  const { S } = await import('../../../ui/strings.js');
  assert.equal(read('ui/today.js').split('const ms = Date.now() - base;').length - 1, 1, 'the since line counts up from the last set');
  for (const f of shipped.filter(x => x.endsWith('.js'))) assert.doesNotMatch(read(f), /\bNotification\b|vibrate\(|AudioContext/, f + ' holds a timer alert');
  assert.deepEqual(Object.keys(S).filter(k => k.startsWith('rest.') || k.startsWith('timer.')), [], 'no rest or timer words');
});

// SR6 follow-up (builder's own add): a typed escape can land as the real character. No tracked
// code or data file holds a raw control character (tab, new line and carriage return aside), a
// C1 control or a line or paragraph separator: those are written as escapes, so a reader sees them.
test('no tracked text file holds a raw control, C1 or separator character', () => {
  const raw = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/;
  const hits = gitList().filter(f => /\.(js|mjs|py|css|html|json|webmanifest|md|sh|txt)$/.test(f) && existsSync(join(APP, f)))
    .filter(f => raw.test(readFileSync(join(APP, f), 'utf8')));
  assert.deepEqual(hits, []);
});

test('SR3, SR11: the text sheet, the feedback sheet and Make my own exercise catch a refused save and keep the sheet', () => {
  const today = read('ui/today.js');
  assert.match(today, /try \{\n\s+await ctx\.store\.saveExerciseText\(ex\.id, field, val\);\n\s+\} catch \(e\) \{[\s\S]{0,200}badLine\.hidden = false; \}\n\s+else toast\(t\('today\.notsaved'\)\);\n\s+return;\n\s+\}/);
  assert.match(today, /try \{ await ctx\.store\.saveFeedback\(v\.day\.id, slot, a, false\); \} catch \(e\) \{ toast\(t\('today\.notsaved'\)\); return; \}/);
  assert.match(today, /askedLater\.add\(v\.day\.id \+ ':x' \+ slot\); \}\n\s+\} catch \(e\) \{ toast\(t\('today\.notsaved'\)\); return; \}/);
  assert.match(read('ui/builder.js'), /try \{ row = await ctx\.store\.addCustomExercise\(\{ name: n, muscle, equipment, flags \}\); \} catch \(e\) \{ toast\(t\('today\.notsaved'\)\); return; \}/);
});

test('SR15: phone check row 4 goes through the store probe and skips while a write is in flight', () => {
  const src = read('ui/check.js');
  assert.match(src, /if \(ctx\.store\.busy\(\)\) await withTimeout\(ctx\.store\.idle\(\), 4000\)\.catch\(\(\) => \{\}\);\n\s+if \(ctx\.store\.busy\(\)\) return result\(UNSURE, '', t\('check\.row5\.first'\)\);/);
  assert.match(src, /await ctx\.store\.probe\(stamp\)/);
  assert.doesNotMatch(src, /ctx\.db\.(put|get|del|closeForTest)\(/, 'no direct db call');
});

// The look flags of this pass (LB1 to LB3), read from styles.css. Every rule body of one exact
// selector, joined, so a property set in any of its rules is seen.
const cssOf = (sel) => {
  const css = read('styles.css');
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...css.matchAll(new RegExp('(^|\\n)' + esc + '\\{([^}]*)\\}', 'g'))].map(m => m[2]).join(';');
};
test('LB1: the Step 4 day line is 15px, its glyph first with an --s2 gap on the first text line (LOOK 4.6)', () => {
  const row = cssOf('.row[data-dayempty]');
  for (const p of ['font-size:var(--fs-small)', 'gap:var(--s2)', 'align-items:flex-start']) assert.ok(row.includes(p), 'missing ' + p);
  assert.ok(cssOf('.row[data-dayempty] svg').replace(/\s+/g, ' ').includes('margin-top:calc((var(--fs-small) * var(--lh-body) - var(--glyph-sm)) / 2)'));
});
test('LB2: the rep range line is 15px --ink (LOOK 4.10)', () => {
  const r = cssOf('#range-line');
  assert.ok(r.includes('font-size:var(--fs-small)') && r.includes('color:var(--ink)'), r);
  assert.ok(!/font-size/.test(cssOf('.num')), 'the number spans keep the line size');
});
test('LB3: a toast sits above every sheet and scrim, and never takes a tap (LOOK 3.7)', () => {
  const z = (body) => { const m = /z-index:\s*(\d+)/.exec(body); return m ? Number(m[1]) : null; };
  const toast = z(cssOf('.toast')), sheet = z(cssOf('.sheet-wrap'));
  assert.ok(sheet !== null && toast !== null && toast > sheet, 'toast ' + toast + ' over sheet ' + sheet);
  assert.ok(cssOf('.toast').includes('pointer-events:none'));
  const css = read('styles.css');
  const others = [...css.matchAll(/z-index:\s*(\d+)/g)].map(m => Number(m[1]));
  assert.ok(others.every(n => n <= toast), 'no layer above the toast');
});

// 14.10 J9 (SR13): a spread into Math.min or Math.max passes one argument per entry and can throw on
// a long list. The blueprint's pattern, plus a wider one that also sees a spread after a first argument
// (Math.max(0, ...list)), which the light pass found in engine.js and store.js.
test('SR13: no shipped file spreads a list into Math.min or Math.max', () => {
  const hits = [];
  for (const f of shipped.filter(x => x.endsWith('.js'))) {
    read(f).split('\n').forEach((l, i) => {
      if (/Math\.(min|max)\(\s*\.\.\./.test(l) || /Math\.(min|max)\([^)]*\.\.\./.test(l)) hits.push(f + ':' + (i + 1));
    });
  }
  assert.deepEqual(hits, []);
});

// 14.10 J7: every toast key fits three lines of 15px at 375pt (120 characters with each {x} as 7 characters).
test('J7: every toast key fits three lines (120 characters or fewer)', async () => {
  const { S } = await import('../../../ui/strings.js');
  const KEY = /^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/;
  const literals = (src) => [...src.matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"/g)].map(m => m[1] ?? m[2]).filter(x => KEY.test(x));
  // The argument of a call that opens at index i (the open paren), read to its close paren; quoted text is skipped.
  const argAt = (src, i) => {
    let depth = 0, q = null;
    for (let j = i; j < src.length; j++) {
      const c = src[j];
      if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; }
      if (c === "'" || c === '"' || c === '`') { q = c; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) return src.slice(i + 1, j); }
    }
    return null;
  };
  const settings = read('ui/settings.js');
  const rStart = settings.indexOf('function refusal(');
  assert.ok(rStart >= 0, 'ui/settings.js must hold function refusal');
  const rBody = settings.slice(rStart, settings.indexOf('\n}', rStart));
  const keys = new Set(), bad = [];
  const files = shipped.filter(f => f === 'app.js' || (f.startsWith('ui/') && f.endsWith('.js')));
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/toast\(/g)) {
      if (src.slice(Math.max(0, m.index - 9), m.index) === 'function ') continue;
      const line = src.slice(0, m.index).split('\n').length;
      const arg = argAt(src, m.index + 5);
      if (arg === null) { bad.push(f + ':' + line + ' has no close paren'); continue; }
      const a = arg.trim();
      if (!a.startsWith('t(') && !a.startsWith('refusal(')) { bad.push(f + ':' + line + ' toast argument is not t( or refusal('); continue; }
      for (const k of literals(a)) keys.add(k);
      if (a.startsWith('refusal(')) for (const k of literals(rBody)) keys.add(k);
    }
  }
  assert.deepEqual(bad, []);
  for (const k of ['today.notsaved', 'today.finish.none', 'restore.bad']) assert.ok(keys.has(k), 'the scan must find ' + k);
  const long = [];
  for (const k of keys) {
    assert.equal(typeof S[k], 'string', k + ' must be a string in ui/strings.js');
    const filled = S[k].replace(/\{[a-zA-Z0-9_]+\}/g, '0000000');
    if ([...filled].length > 120) long.push(k + ' is ' + [...filled].length + ' characters');
  }
  assert.deepEqual(long, []);
});

// Contract row X03 (14.10 J8, health-coach KEEP): six muscle groups; the hip in and hip out lifts stay under legs.
test('X03: the list keeps six muscle groups, and the hip in and hip out lifts sit under legs', async () => {
  const { MUSCLES } = await import('../../../backup.js');
  const { SEED_EXERCISES, MUSCLE_NAMES } = await import('../../../data/exercises.js');
  const SIX = ['chest', 'back', 'shoulders', 'arms', 'legs', 'core'];
  assert.deepEqual([...MUSCLES], SIX);
  assert.deepEqual(Object.keys(MUSCLE_NAMES), SIX);
  const off = SEED_EXERCISES.filter(r => !MUSCLES.includes(r.muscle)).map(r => r.id);
  assert.deepEqual(off, []);
  const byId = new Map(SEED_EXERCISES.map(r => [r.id, r]));
  for (const id of ['hip_abduction', 'hip_adduction']) {
    assert.ok(byId.has(id), id + ' must be a list row');
    assert.equal(byId.get(id).muscle, 'legs', id + ' must sit under legs');
  }
});

// SB1 and SB6: the backup marker is called only through markSaved, whose call sits inside a try.
test('SB1: every backup marker call sits inside a try, and both share paths go through markSaved', () => {
  const hits = [];
  for (const f of shipped.filter(x => x === 'app.js' || (x.startsWith('ui/') && x.endsWith('.js')))) {
    read(f).split('\n').forEach((l, i) => { if (l.includes('markBackedUp(')) hits.push([f, i + 1, l]); });
  }
  assert.ok(hits.length >= 1, 'the scan must find the marker call');
  for (const [f, n, l] of hits) assert.match(l, /try \{ await store\.markBackedUp\(ms\); \} catch \(e\) \{[^}]*\} finally \{ settled\(\); \}/, f + ':' + n + ' calls the marker outside a try');
  const app = read('app.js');
  assert.equal((app.match(/await markSaved\(store, ms, settled, \(\) => toast\(t\('backup\.not'\)\)\)/g) || []).length, 2, 'both share paths use markSaved');
  assert.match(app, /await markSaved\([^\n]*\); sh\.close\(\); if \(onDone\) onDone\(\); \}\);/, 'the download path always closes the sheet and calls onDone');
});

// LOOK 6 item 25 (r4.4, LF13): every inline glyph drawn by el(...) inside a classed element gets a
// width and height rule from that element or an element around it in the same el(...) call. An
// unsized svg fills its box (the 130px check glyphs of the r4.4 screenshot read).
test('LF13: every glyph inside a button, row, pill or heading has a width and height rule', () => {
  const css = read('styles.css');
  const sized = [];   // [class, attribute name or null]
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/(^|;)\s*width\s*:/.test(m[2]) || !/(^|;)\s*height\s*:/.test(m[2])) continue;
    for (const sel of m[1].split(',')) {
      const x = /\.([A-Za-z0-9_-]+)(?:\[([a-z-]+)\])?\s*>?\s*svg\s*$/.exec(sel.trim());
      if (x) sized.push([x[1], x[2] || null]);
    }
  }
  const argAt = (src, i) => {
    let d = 0, q = null;
    for (let j = i; j < src.length; j++) {
      const c = src[j];
      if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; }
      if (c === "'" || c === '"' || c === '`') { q = c; continue; }
      if (c === '(') d++;
      else if (c === ')') { d--; if (d === 0) return [i + 1, j]; }
    }
    return null;
  };
  const own = (body) => {   // the call's text with nested el(...) calls taken out
    let k;
    while ((k = body.search(/\bel\(/)) >= 0) { const r = argAt(body, k + 2); if (!r) break; body = body.slice(0, k) + body.slice(r[1] + 1); }
    return body;
  };
  // HN5 (checker read of bf2a98a): a glyph put in outside a classed el(...) call (appendChild,
  // replaceChildren, a variable) is not seen by the scan above, so every glyph( call is counted. A call
  // outside the scan must be on this short list, with its find text and the CSS rule that sizes it.
  const OUTSIDE = [
    { file: 'ui/today.js', find: "if (noask) mark.appendChild(glyph('check'));", sel: '.check-box-row .box svg' },
  ];
  const sizedSel = (sel) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].some(m => m[1].split(',').map(x => x.trim()).includes(sel)
    && /(^|;)\s*width\s*:/.test(m[2]) && /(^|;)\s*height\s*:/.test(m[2]));
  const counts = [];
  const miss = [];
  let seen = 0;
  for (const f of shipped.filter(x => x === 'app.js' || (x.startsWith('ui/') && x.endsWith('.js')))) {
    const src = read(f);
    const calls = [];
    let inScan = 0;
    for (const m of src.matchAll(/\bel\(\s*'([a-z0-9]+)'\s*,\s*\{\s*class:\s*'([^']*)'/g)) {
      const r = argAt(src, m.index + 2);
      if (!r) continue;
      const body = own(src.slice(r[0], r[1]));
      inScan += (body.match(/\bglyph\(/g) || []).length;
      calls.push({ at: m.index, end: r[1], cls: m[2].split(/\s+/).filter(Boolean), body, glyph: /\bglyph\(/.test(body) });
    }
    const all = [...src.matchAll(/\bglyph\(/g)].filter(m => !/function\s+$/.test(src.slice(Math.max(0, m.index - 12), m.index))).length;
    const out = OUTSIDE.filter(o => o.file === f);
    for (const o of out) {
      assert.equal(src.split(o.find).length - 1, 1, f + ': the find text of a listed glyph must match once: ' + o.find);
      assert.ok(sizedSel(o.sel), o.sel + ' must exist in styles.css with a width and a height');
    }
    if (all !== inScan + out.length) counts.push(f + ': ' + all + ' glyph calls, ' + inScan + ' seen by the scan, ' + out.length + ' on the list');
    const hit = (c) => sized.some(([k, attr]) => c.cls.includes(k) && (!attr || c.body.includes("'" + attr + "'")));
    for (const c of calls.filter(x => x.glyph)) {
      seen++;
      if (hit(c) || calls.some(o => o !== c && o.at < c.at && o.end > c.end && hit(o))) continue;
      miss.push(f + ':' + src.slice(0, c.at).split('\n').length + ' .' + c.cls.join('.'));
    }
  }
  assert.ok(seen >= 30, 'the scan must find the glyphs (found ' + seen + ')');
  assert.deepEqual(miss, []);
  assert.deepEqual(counts, [], 'a glyph outside a classed el() call must be on the list with the rule that sizes it');
});

// The r4.4 look flags of the design lead's screenshot read (LF1 to LF12, LOOK 3.1 to 4.10, 6 items 25 and 26).
const hasAll = (sel, props) => { const b = cssOf(sel).replace(/\s+/g, ' '); return props.filter(p => !b.includes(p)); };
test('LF1: the failure toggle draws a 24px box that holds the 18px check only when on (LOOK 3.1 strip 3)', () => {
  assert.deepEqual(hasAll('.toggle .box', ['flex:none', 'width:var(--glyph)', 'height:var(--glyph)', 'border:var(--bw) solid var(--edge)']), []);
  assert.deepEqual(hasAll('.toggle .box svg', ['width:var(--glyph-sm)', 'height:var(--glyph-sm)']), []);
  assert.ok(cssOf('.toggle[aria-pressed="false"] .box svg').includes('display:none'), 'no check while off');
  for (const f of ['ui/today.js', 'ui/builder.js']) {
    const src = read(f);
    assert.match(src, /el\('span', \{ class: 'box', 'aria-hidden': 'true' \}, glyph\('check'\)\), t\('(today\.failure|builder\.fail)'\)/, f + ': the check sits inside the box');
    assert.doesNotMatch(src, /\}, glyph\('check'\), t\('(today\.failure|builder\.fail)'\)/, f + ': no bare check on the toggle');
  }
});
test('LF2: the quiet button stays on one line with an 18px glyph (LOOK 3.2 add set row)', () => {
  assert.deepEqual(hasAll('.btn-quiet', ['white-space:nowrap', 'gap:var(--s1)']), []);
  assert.deepEqual(hasAll('.btn-quiet svg', ['width:var(--glyph-sm)', 'height:var(--glyph-sm)', 'flex:none']), []);
});
test('LF3: a done card name holds a 20px --done check on its first line (LOOK 3.2)', () => {
  assert.deepEqual(hasAll('.ex-name', ['display:inline-flex', 'align-items:center', 'gap:var(--s2)']), []);
  assert.deepEqual(hasAll('.ex-name svg', ['width:var(--card-check)', 'height:var(--card-check)', 'color:var(--done)', 'flex:none']), []);
  assert.match(read('styles.css'), /--card-check:20px;/);
});
test('LF4: a skipped row keeps only the ring in its tick and shows the pill in the helper slot (LOOK 3.1 r4.4)', () => {
  const src = read('ui/today.js');
  assert.doesNotMatch(src, /state === 'skipped' \? el\('span', \{ class: 'small'/, 'no word beside the ring');
  assert.match(src, /else if \(state === 'skipped'\) helper\.appendChild\(el\('span', \{ class: 'pill pill-skip', 'aria-hidden': 'true' \}, glyph\('skip'\), t\('pill\.skipped'\)\)\);/);
  assert.deepEqual(hasAll('.set.is-skipped', ['min-height:var(--row-h-help)']), []);
  assert.deepEqual(hasAll('.pill-skip', ['background:var(--skip-bg)', 'color:var(--skip)']), []);
  assert.match(read('styles.css'), /--row-h-help:72px;/);
});
test('LF5: a pill in the day head is only as wide as its content (LOOK 3.5)', () => {
  assert.ok(cssOf('.day-head > .pill').includes('align-self:flex-start'));
});
test('LF6: a toast grows to its text before it wraps (LOOK 3.7)', () => {
  assert.deepEqual(hasAll('.toast', ['width:max-content', 'max-width:calc(100% - 2 * var(--gutter))']), []);
});
test('LF7: while a sheet is open the toast sits at the top and rises from above, still above it and still untappable (LOOK 3.7 r4.4)', () => {
  assert.deepEqual(hasAll('body:has(.sheet-wrap) .toast', ['top:calc(env(safe-area-inset-top) + var(--s3))', 'bottom:auto', 'transform:translate(-50%, calc(-1 * var(--toast-rise)))']), []);
  assert.ok(cssOf('body:has(.sheet-wrap) .toast.is-on').includes('transform:translate(-50%, 0)'));
  assert.ok(cssOf('.toast').includes('pointer-events:none') && cssOf('.toast').includes('z-index:30'));
});
test('LF8: the switch row drops the browser button skin and its line starts at the row text edge (LOOK 4.9)', () => {
  // The hairline under the row moved under the helper line in r4.4 R16 (G15), so border-bottom is checked there.
  assert.deepEqual(hasAll('.switch-row', ['appearance:none', 'background:none', 'border:0']), []);
  assert.ok(cssOf('.switch-line').includes('margin:0 var(--s4) var(--s2)'));
});
test('G15: the hairline sits under each switch helper line and none after the last pair; the switch sits on the first label line (LOOK 4.9 R16)', () => {
  const css = read('styles.css');
  const at = (sel) => css.search(new RegExp('(^|\\n)' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{'));
  const g15 = css.indexOf('\n.switch-row{border-bottom:0;');
  assert.ok(g15 > 0, 'the R16 switch row rule must exist');
  assert.ok(g15 > at('.row'), 'the R16 rule must come after .row, or .row wins on border, padding and centering');
  assert.deepEqual(hasAll('.switch-row', ['border-bottom:0', 'align-items:flex-start', 'padding-block:calc((var(--tap) - var(--switch-h)) / 2)']), []);
  assert.ok(cssOf('.switch-row .grow').includes('margin-top:calc((var(--switch-h) - var(--fs-body) * var(--lh-body)) / 2)'));
  assert.deepEqual(hasAll('.switch-line', ['padding-bottom:var(--s3)', 'border-bottom:1px solid var(--line)']), []);
  assert.ok(cssOf('.switch-line:last-child').includes('border-bottom:0'));
  assert.doesNotMatch(cssOf('.switch-row'), /border-bottom:1px/, 'no hairline between a switch and its own line');
});
test('LF9: a segmented chip is one line, sized to its words (LOOK 4.9)', () => {
  assert.deepEqual(hasAll('.seg .chip', ['flex:1 1 auto', 'white-space:nowrap', 'padding:0 var(--s3)', 'gap:var(--s2)']), []);
});
test('LF10: the check row is the boxed row with no browser skin (LOOK 4.10)', () => {
  assert.deepEqual(hasAll('.check-box-row', ['appearance:none', 'background:var(--surface)', 'border:var(--bw) solid var(--edge)', 'border-radius:var(--r-md)', 'padding:0 var(--s3)', 'align-items:flex-start']), []);
});
test('LF11: a raw line breaks a word only when it alone is too wide (LOOK 3.6, 4.2)', () => {
  const b = cssOf('.raw');
  assert.ok(b.includes('word-break:normal') && b.includes('overflow-wrap:anywhere') && !b.includes('break-all'), b);
});
test('LF12: a one-line empty-day row is centered in its 56px (LOOK 4.6 r4.4)', () => {
  assert.ok(cssOf('.row[data-dayempty]').includes('padding-block:calc((var(--tap) - var(--fs-small) * var(--lh-body)) / 2)'));
});

// HN1 (checker read of bf2a98a): a gate log must name the commit it ran on and how dirty the tree
// was, on its own lines, so a green claim never rests on clock times alone. run_all.sh is run for real
// with a suite name it does not know (it prints its head lines and stops at the usage line); sim_pass.sh
// boots a simulator, so it is read, and its line must come before any simulator or server step.
test('HN1: run_all.sh and sim_pass.sh print the commit and the dirty count at the top of every run', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  let dir;
  if (process.env.LIFTLOG_LOG_DIR) { dir = join(process.env.LIFTLOG_LOG_DIR, 'hn1'); mkdirSync(dir, { recursive: true }); }
  else dir = mkdtempSync(join(tmpdir(), 'liftlog-hn1-'));
  const r = spawnSync('zsh', [join(APP, 'scripts/tests/run_all.sh'), 'hn1probe'], { cwd: APP, encoding: 'utf8', env: { ...process.env, LIFTLOG_LOG_DIR: dir } });
  const lines = (r.stdout || '').split('\n');
  assert.match(lines[0], /^run_all hn1probe at /, lines[0]);
  const head = execFileSync('git', ['-C', APP, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  const m = /^commit ([0-9a-f]{7,40}) dirty (\d+)$/.exec(lines[1] || '');
  assert.ok(m, 'line 2 must read commit <hash> dirty <count>: ' + lines[1]);
  assert.equal(m[1], head);
  const sim = read('scripts/tests/sim_pass.sh').split('\n');
  const at = sim.findIndex(l => /^print "commit \$\(git -C "\$APP" rev-parse --short HEAD\) dirty \$\(git -C "\$APP" status --porcelain \| wc -l \| tr -d ' '\)"$/.test(l));
  assert.ok(at > 0, 'sim_pass.sh must print the commit line');
  const first = sim.findIndex(l => /simctl (boot|list devices available)|http\.server/.test(l));
  assert.ok(first > at, 'the commit line must come before the simulator and server steps');
});
test('G16: the tab-mode Back link on Phone check takes the back glyph, as the icon-mode link does (LOOK 4.2 R17)', () => {
  const src = read('ui/check.js');
  assert.match(src, /href: '#\/install', id: 'check-back' \}, glyph\('back'\), t\('check\.backtab'\)\)/);
  assert.match(src, /href: '#\/settings', id: 'check-back' \}, glyph\('back'\), t\('check\.back'\)\)/);
});
test('G17: on Phone check the storage banner sits under the subtitle, not between the title and the subtitle (LOOK 4.2, 3.6)', () => {
  assert.match(read('ui/check.js'), /el\('h1', \{\}, t\('check\.title'\)\),\n    el\('p', \{ class: 'lead' \}, t\('check\.sub'\)\),\n    storageBox,\n    rowsBox,/);
});

// ---------------- Slice 2 step 7: the Today parts (16 B.1 step 7, B.5) ----------------

// B.1 step 7 a: the steppers and stepFor read one order. On every shipped row in an lb block, in both
// profiles, with no block entry and with a block step or list, loadStep gives the step stepFor gives.
// Left out on purpose: assist rows (the engine never moves the assist, C11, S6a) and rows where the
// engine has no step at all (a kind the signed table does not list), where the steppers keep the
// 5 lb fallback so he can still move the weight by hand (provisional call, BUILD_LOG).
test('loadStep and stepFor give the same step on every shipped row in an lb block except assist rows (16 B.1 step 7 a)', async () => {
  const { loadStep } = await import('../../../ui/today.js');
  const { stepFor } = await import('../../../engine.js');
  const { RULES } = await import('../../../rules.js');
  const { SEED_EXERCISES } = await import('../../../data/exercises.js');
  const { effectiveExercise } = await import('../../../store.js');
  let same = 0, assist = 0, none = 0;
  const bad = [];
  for (const p of ['fixed', 'adaptive']) {
    const rules = RULES.profiles[p];
    for (const row of SEED_EXERCISES) {
      for (const f of [null, { no_added_sets: false, left_out_of_builder: false, step: 10 }, { no_added_sets: false, left_out_of_builder: false, weight_steps: [40, 50, 70] }]) {
        const block = f ? { exercise_flags: { [row.id]: f } } : {};
        const eng = stepFor(rules, row, 'lb', f);
        if (row.load_kind === 'assist') { assist++; continue; }
        if (eng === null) { none++; assert.deepEqual(loadStep(effectiveExercise(block, row), 'lb', rules), { size: 5 }, row.id + ': no engine step keeps the 5 lb fallback'); continue; }
        const mine = loadStep(effectiveExercise(block, row), 'lb', rules);
        if (JSON.stringify(mine) !== JSON.stringify(eng)) bad.push(p + ' ' + row.id + ' ' + JSON.stringify(f) + ': ' + JSON.stringify(mine) + ' vs ' + JSON.stringify(eng));
        else same++;
      }
    }
  }
  assert.deepEqual(bad, []);
  assert.ok(same > 1000, 'the rows were compared (' + same + ' same, ' + assist + ' assist, ' + none + ' with no engine step)');
});

// The Adjust each round parts never show on a Fixed block (16 B.5 rows 3, 5, 9, 10, 12, 13; the brief:
// a Fixed block looks and behaves as 0.2.6 but for the sleep card, Close block, Change answers, Set
// kind, Add exercise and Take out this exercise).
test('Slice 2: the marks, the why line, the retarget line, the soreness sheet and the scope sheet on Add set, Move and Swap sit behind Adjust each round', () => {
  const src = read('ui/today.js');
  assert.match(src, /const mk = adaptive\(v\) \? markOf\(s\) : null;/, 'met and missed marks');
  assert.match(src, /const whyLine = adaptive\(v\) && why && /, 'the why line');
  assert.match(src, /const whys = adaptive\(v\) \? await store\.slotWhy\(day\.id\) : \{\};/, 'the why read');
  assert.match(src, /if \(adaptive\(v\) && open && open\.kind === 'work'\) \{/, 'the retarget read');
  assert.match(src, /if \(adaptive\(v\) && firstOfSlot\) \{/, 'the soreness-alone sheet');
  assert.match(src, /\[0, adj \? scoped\(\{ type: 'add_set' \}\) : act\(\(\) => ctx\.store\.addSet\(dayId, slot\)\)\]/, 'Add set in the card menu');
  assert.match(src, /\['up', adj \? scoped\(/, 'Move up');
  assert.match(src, /\['down', adj \? scoped\(/, 'Move down');
  assert.match(src, /scoped: adj \}; ctx\.go\('#\/picker'\);/, 'Swap');
  assert.match(src, /if \(!adaptive\(v\)\) \{\n\s+await ctx\.store\.addSet\(v\.day\.id, slot\);/, 'the Add set button');
  assert.match(src, /const adaptive = \(v\) => !!v && v\.profile === 'adaptive';/);
  // The profile comes from the store's own clock and rule check (dayView), never worked out on the page.
  assert.ok(!/Date\.now\(\)[^\n]*profile|profileFor\(/.test(src), 'today.js works out no profile itself');
  assert.match(read('store.js'), /const profile = block \? profileOf\(block, t0\) : 'fixed';/);
});

// B.10 item 5: his own words from the block file (the sleep hint, check words) reach the page as text only.
test('Slice 2: the sleep hint is his words as text, and the sleep card leaves on the first tick (B.5 row 1, B.10 item 5)', () => {
  const src = read('ui/today.js');
  assert.match(src, /el\('p', \{ class: 'sleep-hint', id: 'sleep-hint' \}, block\.sleep_hint\)/);
  assert.match(src, /if \(day\.status === 'planned'\) box\.appendChild\(sleepCard\(ctx, screen, day, b\)\);/);
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(src), 'no markup is built from text');
  // A chip tap writes the answer only: no tick, no draft, no keep-awake.
  const card = src.slice(src.indexOf('function sleepCard('), src.indexOf('\n}\n', src.indexOf('function sleepCard(')));
  assert.ok(/ctx\.store\.answerSleep\(day\.id, cur === val \? null : val\)/.test(card), 'tapping the picked chip clears it');
  assert.ok(!/\.tick\(|saveDraft|wake\./.test(card), 'the sleep card never opens the day');
});

// ---------------- Slice 2, B.1 steps 8 and 9 ----------------

test('Slice 2: the Adjust each round row is in the DOM only when the store allows the switch; Back to Fixed only on an adaptive block; condition words as text (16 B.9, B.10 item 5)', () => {
  const src = read('ui/settings.js');
  const fn = span(src, 'async function adjustRow(ctx, card) {', '\n}');
  assert.match(fn, /const block = await store\.activeBlock\(\);\n  if \(!block\) return;/, 'the active block only');
  assert.match(fn, /if \(await store\.switchAllowed\(block\.id\)\) \{\n    card\.appendChild\(el\('button', \{ class: 'row row-link menu-row', type: 'button', id: 'adjust-row'/, 'the row is put in only when switchAllowed is true');
  assert.match(fn, /\} else if \(await store\.switchBackAllowed\(block\.id\)\) \{\n    card\.appendChild\(el\('button', \{ class: 'row row-link menu-row', type: 'button', id: 'adjust-back'/, 'Back to Fixed');
  assert.equal(src.split("id: 'adjust-row'").length - 1, 1, 'one Adjust each round row');
  assert.ok(!/hidden/.test(fn), 'the row is left out, never hidden');
  // The settings page works out no date and no profile itself: the store's clock decides (M27).
  assert.ok(!/Date|2026-12|localDate|profileFor/.test(fn), 'settings.js works out no date or profile');
  assert.match(src, /el\('span', \{ class: 'grow' \}, words\)\);/, 'the condition words are a text child');
  assert.match(src, /await ctx\.store\.switchProfile\(block\.id, ticks\.slice\(\), input\.value\);/, 'the store gets the ticks and the typed word as typed (M39)');
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(src), 'no markup is built from text');
});

test('Slice 2: the #/day/ route goes through the store check and to the Block tab otherwise; the view has no tick button, stepper, menu or Finish day (16 B.5 row 2, B.10 item 9)', () => {
  const app = read('app.js');
  // 0.4.1 Q3a: the view lights the tab it was opened from (History or Block; Block on a cold load); the e2e look041 part proves it live.
  assert.match(app, /if \(route\.startsWith\(DAYVIEW\)\) \{ const from = lastTab === '#\/history' \? '#\/history' : '#\/block'; root\.appendChild\(renderDayView\(ctx, route\.slice\(DAYVIEW\.length\), from\)\); root\.appendChild\(tabbar\(from\)\); return; \}/);
  assert.match(app, /'#\/block': \(\) => renderBlock\(ctx\),/);
  const src = read('ui/block.js');
  const fn = span(src, 'async function drawDay(ctx, screen, dayId, from) {', '\n}');
  assert.match(fn, /try \{ p = await ctx\.store\.dayPreview\(dayId\); \} catch \(e\) \{ p = null; \}\n  if \(!p\) \{ ctx\.go\('#\/block'\); return; \}/, 'a bad id goes to the Block tab');
  const view = src.slice(src.indexOf('export function renderDayView('));
  assert.ok(!/'data-tick'|'data-step'|'data-setmenu'|'data-menu'|'data-addset'|finish-day|day-menu|sleepCard|\.tick\(|saveDraft|liveEdit/.test(view), 'nothing on the view can write');
  assert.ok(!/el\('(button|input)'/.test(view), 'no button and no field on the read-only view');
  assert.match(read('store.js'), /async function dayPreview\(dId\) \{\n    checkId\(dId\);/, 'checkId first');
});

test('Slice 2: a day of the easy round opens the stop sheet while hard days are left (16 B.5 row 4)', () => {
  const fn = span(read('ui/block.js'), 'function openDay(ctx, ov, d) {', '\n}');
  assert.match(fn, /const n = easyStop\(ov, d\);\n  if \(n > 0\) \{ easySheet\(ctx, n\); return; \}/);
});

test('Slice 2: Phone check prints the rules fact as Error when the rule table fails, with no new word (16 B.2 note 5)', () => {
  const src = read('ui/check.js');
  assert.match(src, /if \(ctx\.store && !ctx\.store\.rulesOk\(\)\) factsBox\.appendChild\(factRow\(t\('settings\.rules'\), t\('check\.error'\), 'rules'\)\);/);
});


test('r4.5 ruling 1: the Add an exercise sets stepper names its buttons by addex.less and addex.more, never the rep words', () => {
  const src = read('ui/today.js');
  assert.ok(src.includes("id: 'addex-less', 'aria-label': t('addex.less')"), 'addex-less is named by addex.less');
  assert.ok(src.includes("id: 'addex-more', 'aria-label': t('addex.more')"), 'addex-more is named by addex.more');
  const strings = read('ui/strings.js');
  assert.ok(strings.includes("'addex.less': '1 set less'") && strings.includes("'addex.more': '1 set more'"), 'the two words are the architect words of r4.5');
});

// 17 C.2.2 (r4 review R16): no machine row is a body-load row (M90).
test('M90: no row with equipment machine has load_kind body', async () => {
  const { SEED_EXERCISES } = await import('../../../data/exercises.js');
  const bad = SEED_EXERCISES.filter(e => e.equipment === 'machine' && e.load_kind === 'body').map(e => e.id);
  assert.deepEqual(bad, []);
  assert.ok(SEED_EXERCISES.filter(e => e.equipment === 'machine').length > 40);
});


// ---------------- Slice 3, track S3 (17 C.3.12, C.3.16, C.4) ----------------

test('C.3.16 M70 guard: strings.js holds the what-changed line for the current APP_VERSION', async () => {
  const { S } = await import('../../../ui/strings.js');
  const { APP_VERSION } = await import('../../../version.js');
  const key = 'changed.v' + APP_VERSION.split('.').join('_');
  assert.ok(typeof S[key] === 'string' && S[key].length > 0, 'no ' + key + ' key: every version ships with its note');
  assert.ok(typeof S['changed.head'] === 'string');
});

test('C.3.12: ui/trend.js draws only through svg() (createElementNS) and never writes markup', () => {
  const src = read('ui/trend.js');
  assert.match(read('ui/dom.js'), /document\.createElementNS\(SVG_NS, tag\)/, 'svg() builds by createElementNS');
  assert.doesNotMatch(src, /\bel\(|createElement\(|innerHTML|outerHTML|insertAdjacentHTML/, 'trend.js builds only SVG nodes');
  assert.match(src, /svg\('title'/, 'a <title>');
  assert.match(src, /'aria-label': label/, 'an aria-label with the trend in words');
});

test('C.3.14: the exercise detail link is set only after isLink, with rel noopener noreferrer, and no player tag anywhere', () => {
  const src = read('ui/library.js');
  assert.match(src, /if \(ex\.link && isLink\(ex\.link\)\) \{[\s\S]*?a\.setAttribute\('href', ex\.link\);/);
  assert.match(src, /const LINK_REL = 'noopener noreferrer';/);
  for (const f of shipped.filter(x => x.startsWith('ui/'))) assert.doesNotMatch(read(f), /'(iframe|video|embed)'/, f + ' builds a player tag');
});

test('C.0.1: every Slice 3 route id from the hash is checked by ID_RE before any read', () => {
  const src = read('app.js');
  for (const r of ['FINISHED', 'SUMMARY', 'EXERCISE']) {
    const at = src.indexOf('if (route.startsWith(' + r + ')) {');
    assert.ok(at > 0, r + ' route');
    const body = src.slice(at, src.indexOf('\n  }\n', at));
    assert.match(body, /if \(!ID_RE\.test\(id\)/, r + ' checks its id');
  }
});
