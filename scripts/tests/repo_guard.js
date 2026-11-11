// repo_guard.js - fails if anything in this repo, or in its history, holds a banned
// word, a personal word, an email other than the allowed no-reply forms, a home
// folder path, an env file name, a key shape, a backup file name or a PNG chunk
// we do not allow (DESIGN 4.6).
//
// The four word lists live OUTSIDE the repo, in the folder named by
// LIFTLOG_PRIVATE_DIR. A missing list, an empty list or an empty file list is a
// FAIL (exit 2), never a pass. Hits print the place and the rule, never the text.
//
// One more list, banned_pending.txt (r4.1 label guard, DESIGN 15 P.4 item 9, 14.7 L1), is
// checked over the VALUES of ui/strings.js only: every string and every list item, keys left
// out, each entry as a whole word, case-sensitive. Never repo-wide, never over history. A hit
// prints the key name only. A missing or empty pending list is a FAIL like the other lists.
//
//   node scripts/tests/repo_guard.js                  full run (files, history, names)
//   node scripts/tests/repo_guard.js --message FILE   scan one commit message (commit-msg hook)
//   node scripts/tests/repo_guard.js --install-hooks  write the commit-msg and pre-push hooks
//   node scripts/tests/repo_guard.js --self-test      prove the rules in a temp repo
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, chmodSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const LISTS = ['banned_words.txt', 'banned_substrings.txt', 'allowed_words.txt', 'personal_words.txt'];
const PENDING = 'banned_pending.txt';
const PUBLIC_ACCOUNT = 'meetingvinny-cmd';
// Allowed emails, written so this file does not hold them as plain text.
const ALLOWED_EMAIL = new RegExp('^(' + PUBLIC_ACCOUNT + '|\\d+\\+' + PUBLIC_ACCOUNT + ')@users\\.noreply\\.github\\.com$|^noreply@anthropic\\.com$', 'i');
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PNG_OK = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);

// Patterns are written so this file does not match itself.
const SHAPES = [
  { id: 'home folder path', re: /\/Use[r]s\//i },
  { id: 'env file name', re: /(^|[^A-Za-z0-9])[.]en[v](?![A-Za-z0-9])/ },
  { id: 'key shape (sk)', re: /\bs[k]-[A-Za-z0-9_-]{8,}/ },
  { id: 'key shape (ghp)', re: /\bgh[p]_[A-Za-z0-9]{8,}/ },
  { id: 'key shape (github pat)', re: /\bgithub_pa[t]_[A-Za-z0-9_]{8,}/ },
  { id: 'key shape (aws)', re: /\bAKI[A][0-9A-Z]{12,}/ },
  { id: 'private key block', re: /-----BEGIN [A-Z ]*PRIVAT[E] KEY-----/ }
];
const BACKUP_NAME = new RegExp('liftlog-' + 'backup-', 'i');

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The wider word rule (DESIGN 14.5 R1, r4.2 X2): a space inside a listed term also matches
// _ or - or nothing, so a joined form (a key, a file name) is found too.
const widen = (s) => s.replace(/ /g, '[ _-]?');

// Whole word, any case. The edges that are letters or digits need a non-letter,
// non-digit neighbour, so a hit counts when the word touches _ - . or /.
export function wordRe(w, flags = 'gi') {
  const left = /^[A-Za-z0-9]/.test(w) ? '(?<![A-Za-z0-9])' : '';
  const right = /[A-Za-z0-9]$/.test(w) ? '(?![A-Za-z0-9])' : '';
  return new RegExp(left + widen(esc(w)) + right, flags);
}

// The r4 word rule: a space matches a space only. Kept beside the wider rule, so a removed
// allowed word can never make the wider scan pass a line the r4 scan fails.
export function wordRe4(w, flags = 'gi') {
  const left = /^[A-Za-z0-9]/.test(w) ? '(?<![A-Za-z0-9])' : '';
  const right = /[A-Za-z0-9]$/.test(w) ? '(?![A-Za-z0-9])' : '';
  return new RegExp(left + esc(w) + right, flags);
}

export function loadLists(dir) {
  if (!dir) return { error: 'LIFTLOG_PRIVATE_DIR is not set' };
  const out = {};
  for (const name of LISTS) {
    const p = join(dir, name);
    if (!existsSync(p)) return { error: 'list missing: ' + name };
    const terms = readFileSync(p, 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
    if (!terms.length) return { error: 'list has no terms: ' + name };
    out[name] = terms;
  }
  const set = (word, sub) => ({
    banned: out['banned_words.txt'].map((w, i) => ({ id: 'banned word #' + (i + 1), re: word(w) })),
    subs: out['banned_substrings.txt'].map((w, i) => ({ id: 'banned substring #' + (i + 1), re: new RegExp(sub(esc(w)), 'g') })),
    allowed: out['allowed_words.txt'].map(w => word(w)),
    personal: out['personal_words.txt'].map((w, i) => ({ id: 'personal word #' + (i + 1), re: word(w) }))
  });
  // wide: the wider rule on all four lists; r4: the old rule, kept for the local-only scope.
  return { ...set(wordRe, widen), r4: set(wordRe4, (x) => x), counts: LISTS.map(n => out[n].length) };
}

// The pending list (P.4 item 9): whole word, case-sensitive.
export function loadPending(dir) {
  if (!dir) return { error: 'LIFTLOG_PRIVATE_DIR is not set' };
  const p = join(dir, PENDING);
  if (!existsSync(p)) return { error: 'list missing: ' + PENDING };
  const terms = readFileSync(p, 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  if (!terms.length) return { error: 'list has no terms: ' + PENDING };
  // wordRe is the wider rule (r4.2 X2); it finds every r4 hit too, and no allowed word applies here.
  return { pending: terms.map((w, i) => ({ id: 'pending label #' + (i + 1), re: wordRe(w, 'g') })), count: terms.length };
}

// Every value of a strings table (strings and list items, nested lists too), with its key.
export function stringValues(table) {
  const out = [];
  const walk = (key, v) => {
    if (typeof v === 'string') out.push([key, v]);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(key + '[' + i + ']', x));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(key + '.' + k, x);
  };
  for (const [k, v] of Object.entries(table)) walk(k, v);
  return out;
}

// Check the values only. Returns 'strings <key>  pending label #n', never the entry.
export function pendingHits(pend, table) {
  const hits = [];
  for (const [key, v] of stringValues(table)) {
    for (const { id, re } of pend.pending) { re.lastIndex = 0; if (re.test(v)) hits.push('ui/strings.js value ' + key + '  ' + id); }
  }
  return hits;
}

// Scan one piece of text with one rule set. Returns rule ids per line, never the matched text.
function scanOne(lists, label, text) {
  const hits = [];
  text.split('\n').forEach((raw, i) => {
    const where = label + ':' + (i + 1);
    let line = raw;
    for (const m of raw.matchAll(EMAIL)) {
      if (ALLOWED_EMAIL.test(m[0])) line = line.split(m[0]).join(' ');
      else hits.push(where + '  email address');
    }
    line = line.split(PUBLIC_ACCOUNT).join(' ');
    for (const { id, re } of SHAPES) if (re.test(line)) hits.push(where + '  ' + id);
    // The personal list always wins: it runs before any allowed word is removed.
    for (const { id, re } of lists.personal) { re.lastIndex = 0; if (re.test(line)) hits.push(where + '  ' + id); }
    let open = line;
    for (const re of lists.allowed) { re.lastIndex = 0; open = open.replace(re, ' '); }
    for (const { id, re } of [...lists.banned, ...lists.subs]) { re.lastIndex = 0; if (re.test(open)) hits.push(where + '  ' + id); }
  });
  return hits;
}

// Both rules on one text: r4 holds the r4 hits, wider the hits only the wider rule finds.
export function scanSplit(lists, label, text) {
  const r4 = lists.r4 ? scanOne(lists.r4, label, text) : [];
  const seen = new Set(r4);
  const wider = [...new Set(scanOne(lists, label, text))].filter(h => !seen.has(h));
  return { r4, wider };
}

// The publish scope rule: every hit of either rule fails.
export function scanText(lists, label, text) {
  const { r4, wider } = scanSplit(lists, label, text);
  return [...r4, ...wider];
}

function pngChunks(buf) {
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  const kinds = [];
  let i = 8;
  while (i + 8 <= buf.length) { const n = buf.readUInt32BE(i); kinds.push(buf.subarray(i + 4, i + 8).toString('latin1')); i += 12 + n; }
  return kinds;
}

function git(repo, args, input) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'buffer', input: input ? Buffer.from(input, 'utf8') : undefined, maxBuffer: 1 << 28, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'ignore'] });
}

const PUBLIC_REF = 'refs/heads/public';

function hasPublic(repo) {
  try { git(repo, ['rev-parse', '--verify', '--quiet', PUBLIC_REF]); return true; } catch (e) { return false; }
}

// The two history scopes (r4.2 X2). publish: reachable from refs/heads/public. local: reachable
// from any ref but not from public. With no public branch every history object is local-only.
export function scopeRange(repo, scope) {
  const pub = hasPublic(repo);
  if (scope === 'publish') return pub ? [PUBLIC_REF] : null;
  return pub ? ['--all', '--not', PUBLIC_REF] : ['--all'];
}

// Every blob of one scope, with the path it had.
function historyBlobs(repo, range) {
  if (!range) return [];
  let listing = '';
  try { listing = git(repo, ['rev-list', '--objects', ...range]).toString('utf8'); } catch (e) { return []; }
  const rows = listing.split('\n').filter(Boolean).map(l => { const sp = l.indexOf(' '); return sp < 0 ? [l, ''] : [l.slice(0, sp), l.slice(sp + 1)]; });
  if (!rows.length) return [];
  const out = git(repo, ['cat-file', '--batch'], rows.map(r => r[0]).join('\n') + '\n');
  const blobs = [];
  let pos = 0, idx = 0;
  while (pos < out.length && idx < rows.length) {
    const nl = out.indexOf(10, pos);
    const [sha, type, size] = out.subarray(pos, nl).toString('utf8').split(' ');
    const n = Number(size);
    const body = out.subarray(nl + 1, nl + 1 + n);
    if (type === 'blob') blobs.push({ sha, path: rows[idx][1], body });
    pos = nl + 1 + n + 1;
    idx++;
  }
  return blobs;
}

// The local-only wider hit count on 2026-11-10 (DESIGN 4.7 row 1). Lower it when it goes down; never raise it.
export const MAX_LOCAL_WIDER = 6;

export function fullRun(repo, lists) {
  const hits = [];
  let files;
  try {
    files = git(repo, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean);
  } catch (e) {
    return { error: 'not a git repo' };
  }
  if (!files.length) return { error: 'file list is empty' };

  for (const f of files) {
    hits.push(...scanText(lists, 'name ' + f, f));
    if (BACKUP_NAME.test(f)) hits.push('name ' + f + '  backup file name');
    const full = join(repo, f);
    if (!existsSync(full)) continue;
    const buf = readFileSync(full);
    if (f.toLowerCase().endsWith('.png')) {
      const kinds = pngChunks(buf);
      if (!kinds) hits.push(f + '  not a PNG');
      else if (kinds.some(k => !PNG_OK.has(k))) hits.push(f + '  PNG chunk not allowed');
      continue;
    }
    if (buf.includes(0)) continue;
    hits.push(...scanText(lists, f, buf.toString('utf8')));
  }

  // Publish scope: every rule fails. Local-only scope: r4 hits fail, a hit only the wider rule
  // finds is counted (one count per hit line), named by the 8-character hash of its blob or
  // commit, and never fails.
  const widerLocal = [];
  const scopes = { publish: { blobs: 0, commits: 0 }, local: { blobs: 0, commits: 0 } };
  for (const scope of ['publish', 'local']) {
    const range = scopeRange(repo, scope);
    const tag = scope === 'publish' ? 'publish history ' : 'local-only history ';
    const take = (key, found) => {
      hits.push(...found.r4);
      if (!found.wider.length) return;
      if (scope === 'publish') hits.push(...found.wider);
      else for (let i = 0; i < found.wider.length; i++) widerLocal.push(key);
    };
    const blobs = historyBlobs(repo, range);
    scopes[scope].blobs = blobs.length;
    for (const b of blobs) {
      const label = tag + b.path + '@' + b.sha.slice(0, 8);
      const key = b.sha.slice(0, 8);
      if (b.path) take(key, scanSplit(lists, label + ' name', b.path));
      if (BACKUP_NAME.test(b.path)) hits.push(label + '  backup file name');
      if (b.body.includes(0)) continue;
      take(key, scanSplit(lists, label, b.body.toString('utf8')));
    }
    if (!range) continue;
    try {
      const log = git(repo, ['log', ...range, '--format=%H%n%an%n%ae%n%cn%n%ce%n%B%n---end---']).toString('utf8');
      const parts = log.split('---end---\n').filter(p => p.trim());
      scopes[scope].commits = parts.length;
      for (const p of parts) {
        const [sha, an, ae, cn, ce, ...body] = p.split('\n');
        const label = (scope === 'publish' ? 'publish ' : 'local-only ') + 'commit ' + sha.slice(0, 8);
        const key = sha.slice(0, 8);
        for (const [what, v] of [['author name', an], ['committer name', cn]]) take(key, scanSplit(lists, label + ' ' + what, v));
        for (const [what, v] of [['author email', ae], ['committer email', ce]]) {
          if (!ALLOWED_EMAIL.test(v)) hits.push(label + ' ' + what + '  email not allowed');
        }
        take(key, scanSplit(lists, label + ' message', body.join('\n')));
      }
    } catch (e) { /* no commits yet */ }
  }
  // DESIGN 4.7 row 1: the local-only wider hit count may only go down or stay (stage 4 N9). It is a
  // count, never an allow list of hashes (14.8 X2 bars that), so the 6 known hits still pass.
  if (widerLocal.length > MAX_LOCAL_WIDER) hits.push('local-only wider hits ' + widerLocal.length + ' rose above the ceiling of ' + MAX_LOCAL_WIDER + ' (DESIGN 4.7 row 1)');
  const blobs = { length: scopes.publish.blobs + scopes.local.blobs };
  const commits = scopes.publish.commits + scopes.local.commits;

  let refs = [];
  try { refs = git(repo, ['for-each-ref', '--format=%(refname:short)']).toString('utf8').split('\n').filter(Boolean); } catch (e) { refs = []; }
  for (const r of refs) hits.push(...scanText(lists, 'ref ' + r, r));

  return { hits, files: files.length, blobs: blobs.length, commits, refs: refs.length,
    publishObjects: scopes.publish.blobs, localObjects: scopes.local.blobs, widerLocal };
}

function messageRun(repo, lists, file) {
  const hits = scanText(lists, 'message', readFileSync(file, 'utf8'));
  for (const who of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    let ident = '';
    try { ident = git(repo, ['var', who]).toString('utf8'); } catch (e) { continue; }
    const m = /<([^>]*)>/.exec(ident);
    if (!m || !ALLOWED_EMAIL.test(m[1])) hits.push(who.toLowerCase() + '  email not allowed');
    hits.push(...scanText(lists, who.toLowerCase(), ident.replace(/<[^>]*>.*/, '')));
  }
  return hits;
}

function installHooks(repo) {
  const hooks = join(repo, '.git', 'hooks');
  if (!existsSync(join(repo, '.git'))) { console.log('FAIL repo_guard no .git folder'); return 2; }
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'commit-msg'), '#!/bin/sh\nexec node scripts/tests/repo_guard.js --message "$1"\n');
  writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\nexec node scripts/tests/repo_guard.js\n');
  chmodSync(join(hooks, 'commit-msg'), 0o755);
  chmodSync(join(hooks, 'pre-push'), 0o755);
  console.log('repo_guard: hooks installed (commit-msg, pre-push)');
  return 0;
}

// ---- self-test: every rule proven on a throwaway repo with the real lists ----
function selfTest(dir) {
  const real = loadLists(dir);
  if (real.error) { console.log('FAIL repo_guard self-test ' + real.error); return 2; }
  const raw = (n) => readFileSync(join(dir, n), 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  const banned = raw('banned_words.txt').find(w => /^[A-Za-z][A-Za-z ]+$/.test(w));
  const personal = raw('personal_words.txt').find(w => /^[A-Za-z]+$/.test(w));
  const NOREPLY = PUBLIC_ACCOUNT + '@users.noreply.github.com';
  const OTHER = ['someone', 'gmail.com'].join('@');
  const results = [];
  const base = mkdtempSync(join(tmpdir(), 'liftlog-guard-'));
  function repo(name, author) {
    const r = join(base, name);
    mkdirSync(r, { recursive: true });
    const g = (...a) => execFileSync('git', ['-C', r, ...a], { stdio: 'ignore' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', author || NOREPLY);
    g('config', 'user.name', 'Maxxx');
    g('config', 'commit.gpgsign', 'false');
    return { r, g };
  }
  // wantRule: the rule text a fail must name, so a fail for another reason never counts.
  function expect(name, wantFail, run, wantRule) {
    const res = run();
    const said = [res.error || '', ...(res.hits || [])].join('\n');
    const failed = !!(res.error || (res.hits && res.hits.length));
    const ok = failed === wantFail && (!wantFail || said.includes(wantRule));
    results.push(ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + 'repo_guard self-test: ' + name + (ok ? '' : ' (got ' + (failed ? 'a fail' : 'a pass') + ')'));
  }
  try {
    // 1. Clean repo with the house trailer passes.
    let a = repo('clean');
    writeFileSync(join(a.r, 'a.txt'), 'plain text\n');
    a.g('add', '-A'); a.g('commit', '-q', '-m', 'first\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
    expect('clean repo with the no-reply trailer passes', false, () => fullRun(a.r, real));
    // 2. A personal word also put on the allow list still fails.
    const allowDir = join(base, 'lists');
    mkdirSync(allowDir);
    for (const n of LISTS) writeFileSync(join(allowDir, n), readFileSync(join(dir, n)));
    writeFileSync(join(allowDir, 'allowed_words.txt'), readFileSync(join(dir, 'allowed_words.txt'), 'utf8') + '\n' + personal + '\n');
    a = repo('personal');
    writeFileSync(join(a.r, 'a.txt'), 'x ' + personal + ' y\n');
    expect('a personal word on the allow list still fails', true, () => fullRun(a.r, loadLists(allowDir)), 'personal word');
    // 3. A Gmail author fails.
    a = repo('gmail', OTHER);
    writeFileSync(join(a.r, 'a.txt'), 'plain\n');
    a.g('add', '-A'); a.g('commit', '-q', '-m', 'first');
    expect('a commit author outside the no-reply forms fails', true, () => fullRun(a.r, real), 'author email  email not allowed');
    // 4. An old blob with a banned word fails after the file is cleaned.
    a = repo('blob');
    writeFileSync(join(a.r, 'a.txt'), 'x ' + banned + ' y\n');
    a.g('add', '-A'); a.g('commit', '-q', '-m', 'first');
    writeFileSync(join(a.r, 'a.txt'), 'clean now\n');
    a.g('add', '-A'); a.g('commit', '-q', '-m', 'second');
    expect('an old file version with a banned word fails', true, () => fullRun(a.r, real), 'history a.txt@');
    // 5. A banned word joined by an underscore in a file name fails.
    a = repo('join');
    writeFileSync(join(a.r, banned.split(' ')[0].toLowerCase() + '_notes.txt'), 'plain\n');
    expect('a banned word touching an underscore in a name fails', true, () => fullRun(a.r, real), 'banned word');
    // 6. An empty file list fails.
    a = repo('empty');
    expect('an empty file list fails', true, () => fullRun(a.r, real), 'file list is empty');
    // 7. A missing list fails.
    expect('a missing list fails', true, () => loadLists(join(base, 'nowhere')), 'list missing');

    // r4.2 X2 cases (a) to (e): the wider word rule and the two history scopes. The two-word
    // term is read from the real lists; it is one whose joined forms only the wider rule finds,
    // so each case proves the wider rule and not an r4 rule. The term is never printed.
    const two = [...raw('banned_words.txt'), ...raw('personal_words.txt')].filter(w => /^[A-Za-z]+ [A-Za-z]+$/.test(w));
    const joins = ['_', '-', ''];
    const term = two.find(w => joins.every(j => {
      // Chosen by the r4 rule only, so a broken wider rule still reaches cases (a) and (e).
      const r = scanSplit(real, 't', 'x ' + w.split(' ').join(j) + ' y');
      return !r.r4.length;
    }));
    if (!term) {
      results.push(false);
      console.log('FAIL repo_guard self-test: (a) to (e) no listed two-word term whose joined forms the r4 rule does not find');
    } else {
      const joined = (j) => term.split(' ').join(j).toLowerCase();
      // A public branch made the P2 way: a new root commit of a tree, no shared history.
      const rootPublic = (g, r) => {
        const tree = execFileSync('git', ['-C', r, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
        const id = execFileSync('git', ['-C', r, 'commit-tree', tree, '-m', 'public root'], { encoding: 'utf8' }).trim();
        g('update-ref', PUBLIC_REF, id);
      };
      // (a) A working file with the term joined by an underscore fails.
      a = repo('x2a');
      writeFileSync(join(a.r, 'a.txt'), 'x ' + joined('_') + ' y\n');
      expect('(a) a working file with a listed two-word term joined by _ fails', true, () => fullRun(a.r, real), 'a.txt:1');
      // (b) The term in a commit on public, later removed from the file, fails as publish history.
      a = repo('x2b');
      writeFileSync(join(a.r, 'a.txt'), 'x ' + joined('_') + ' y\n');
      a.g('add', '-A'); a.g('commit', '-q', '-m', 'first');
      writeFileSync(join(a.r, 'a.txt'), 'clean now\n');
      a.g('add', '-A'); a.g('commit', '-q', '-m', 'second');
      a.g('branch', 'public');
      expect('(b) a joined term in a commit on public fails as publish history', true, () => fullRun(a.r, real), 'publish history a.txt@');
      // (c) The term in a cleaned-up old commit on main, with a clean public, passes and is counted.
      a = repo('x2c');
      writeFileSync(join(a.r, 'a.txt'), 'x ' + joined('_') + ' y\n');
      a.g('add', '-A'); a.g('commit', '-q', '-m', 'first');
      writeFileSync(join(a.r, 'a.txt'), 'clean now\n');
      a.g('add', '-A'); a.g('commit', '-q', '-m', 'second');
      rootPublic(a.g, a.r);
      {
        const res = fullRun(a.r, real);
        const ok = !res.error && res.hits.length === 0 && res.widerLocal.length === 1 && res.publishObjects > 0;
        results.push(ok);
        console.log((ok ? 'PASS ' : 'FAIL ') + 'repo_guard self-test: (c) a joined term in an old local-only commit passes, local-only wider hits: ' + (res.widerLocal ? res.widerLocal.length : 'none'));
      }
      // (d) A plain banned word in an old local-only blob still fails.
      a = repo('x2d');
      writeFileSync(join(a.r, 'a.txt'), 'x ' + banned + ' y\n');
      a.g('add', '-A'); a.g('commit', '-q', '-m', 'first');
      writeFileSync(join(a.r, 'a.txt'), 'clean now\n');
      a.g('add', '-A'); a.g('commit', '-q', '-m', 'second');
      rootPublic(a.g, a.r);
      expect('(d) a plain banned word in an old local-only blob still fails', true, () => fullRun(a.r, real), 'local-only history a.txt@');
      // (f) More local-only wider hits than the ceiling fails (stage 4 N9, DESIGN 4.7 row 1).
      a = repo('x2f');
      writeFileSync(join(a.r, 'a.txt'), Array.from({ length: MAX_LOCAL_WIDER + 1 }, () => 'x ' + joined('_') + ' y\n').join(''));
      a.g('add', '-A'); a.g('commit', '-q', '-m', 'first');
      writeFileSync(join(a.r, 'a.txt'), 'clean now\n');
      a.g('add', '-A'); a.g('commit', '-q', '-m', 'second');
      rootPublic(a.g, a.r);
      expect('(f) local-only wider hits above the ceiling fail', true, () => fullRun(a.r, real), 'rose above the ceiling');
      // (e) The hyphen form and the no-space form each fail in a working file.
      for (const [j, what] of [['-', 'the hyphen form'], ['', 'the no-space form']]) {
        a = repo('x2e' + (j ? 'h' : 'n'));
        writeFileSync(join(a.r, 'a.txt'), 'x ' + joined(j) + ' y\n');
        expect('(e) ' + what + ' of a listed two-word term fails in a working file', true, () => fullRun(a.r, real), 'a.txt:1');
      }
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  const bad = results.filter(x => !x).length;
  console.log('repo_guard self-test: ' + (results.length - bad) + ' of ' + results.length + ' passed');
  return bad ? 1 : 0;
}

// ---- main ----
// Importing this file runs nothing (the static test imports the pending check).
const MAIN = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (MAIN) {
  const APP = join(HERE, '..', '..');
  const args = process.argv.slice(2);
  let code;
  if (args[0] === '--install-hooks') {
    code = installHooks(APP);
  } else if (args[0] === '--self-test') {
    code = selfTest(process.env.LIFTLOG_PRIVATE_DIR);
  } else {
    const lists = loadLists(process.env.LIFTLOG_PRIVATE_DIR);
    if (lists.error) {
      console.log('FAIL repo_guard ' + lists.error);
      code = 2;
    } else if (args[0] === '--message') {
      const hits = messageRun(APP, lists, args[1]);
      for (const h of hits) console.log('FAIL repo_guard ' + h);
      if (!hits.length) console.log('PASS repo_guard message clean');
      code = hits.length ? 1 : 0;
    } else {
      const res = fullRun(APP, lists);
      const pend = loadPending(process.env.LIFTLOG_PRIVATE_DIR);
      if (res.error || pend.error) {
        console.log('FAIL repo_guard ' + (res.error || pend.error));
        code = 2;
      } else {
        res.hits.push(...pendingHits(pend, (await import(pathToFileURL(join(APP, 'ui', 'strings.js')).href)).S));
        console.log('repo_guard: ' + res.files + ' files, ' + res.blobs + ' history blobs, ' + res.commits + ' commits, ' + res.refs + ' refs; lists: banned ' + lists.counts[0] + ', substrings ' + lists.counts[1] + ', allowed ' + lists.counts[2] + ', personal ' + lists.counts[3] + ', pending ' + pend.count + ' (strings values only)');
        console.log('repo_guard: publish objects ' + res.publishObjects + ', local-only objects ' + res.localObjects + ', local-only wider hits: ' + res.widerLocal.length + (res.widerLocal.length ? ' (in ' + [...new Set(res.widerLocal)].sort().join(' ') + ')' : ''));
        for (const h of res.hits) console.log('FAIL repo_guard ' + h);
        if (!res.hits.length) console.log('PASS repo_guard clean');
        code = res.hits.length ? 1 : 0;
      }
    }
  }
  process.exit(code);
}
