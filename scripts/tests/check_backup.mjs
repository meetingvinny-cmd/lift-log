// check_backup.mjs - check one backup or block file on the Mac (DESIGN 5.6).
//   node scripts/tests/check_backup.mjs <file> [--block] [--since <ISO time>]
// Prints counts per store and the flat_log row count. Never prints a value from the file.
// --since: for flat_log rows only, prints "NEW <set_id>" when the row first entered the
// log after the time, "EDIT <set_id>" when it entered before and changed after.
// Exit 0 = the file imports clean.
import { readFileSync } from 'node:fs';
import { validateBackup, validateBlock, migrate, STORE_NAMES } from '../../backup.js';
import { SEED_IDS } from '../../data/exercises.js';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--since');
const isBlock = args.includes('--block');
const si = args.indexOf('--since');
const since = si >= 0 ? args[si + 1] : null;
if (!file) { console.log('usage: check_backup.mjs <file> [--block] [--since <ISO>]'); process.exit(2); }

let text;
try { text = readFileSync(file, 'utf8'); } catch (e) { console.log('FAIL cannot read the file'); process.exit(2); }
const now = Date.now();

if (isBlock) {
  const r = validateBlock(text, { now, seedIds: SEED_IDS });
  if (!r.ok) { console.log('FAIL block file refused: ' + r.code + ' (' + r.why + ')'); process.exit(1); }
  const lifts = r.block.day_templates.reduce((n, d) => n + d.lifts.length, 0);
  console.log('block file ok: days ' + r.block.day_templates.length + ', lifts ' + lifts + ', custom exercises ' + r.exercises.length +
    ', checks ' + r.block.checks.length + ', scores ' + r.block.scores.length + ', version ' + r.version);
  process.exit(0);
}

const r = validateBackup(text, { now });
if (!r.ok) { console.log('FAIL backup refused: ' + r.code + ' (' + r.why + ')'); process.exit(1); }
const data = migrate(r.stores, r.schema);
for (const s of STORE_NAMES) console.log(s + ' ' + data[s].length);
const parsed = JSON.parse(text);
const flat = Array.isArray(parsed.flat_log) ? parsed.flat_log : [];
console.log('flat_log ' + flat.length);

if (since !== null) {
  const t = Date.parse(since);
  if (!Number.isFinite(t)) { console.log('FAIL --since is not a time'); process.exit(2); }
  for (const row of flat) {
    const first = Date.parse(row.first_done_at), saved = row.saved_at === null ? NaN : Date.parse(row.saved_at);
    if (first > t) console.log('NEW ' + row.set_id);
    else if (saved > t) console.log('EDIT ' + row.set_id);
  }
}
console.log('ok');
