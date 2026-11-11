// backup.js - builds the backup file and checks every file read back in (DESIGN 5.4, 5.4b, 5.5, 5.5a).
// Pure: no database, no clock, no page. "now" is passed in by the caller.
// Every stored row is rebuilt field by field from the allow table below, so an
// unknown key (including __proto__) never reaches the database.
import { APP_VERSION, SCHEMA } from './version.js';

export const STORE_NAMES = ['settings', 'exercises', 'templates', 'blocks', 'days', 'sets', 'feedback'];

// Every text and number limit, in one place. Input boxes read their maxlength from here.
export const LIMITS = {
  ID: 120, STR: 500, NOTE: 2000, WORDS: 120, NAME: 120, LABEL: 4, KEY: 30, VERSION_STR: 20,
  LOAD_MAX: 2000, REPS_MAX: 1000, SCORE_MAX: 10, SETS_MAX: 20, PASSES_MAX: 100,
  PASS_MAX: 1000, DAY_MAX: 100, SLOT_MAX: 1000, SET_N_MAX: 1000, BLOCK_VERSION_MAX: 1000000,
  DAYS_PER_BLOCK: 14, LIFTS_PER_DAY: 30, WARMUPS: 5, CHECKS: 10, SCORES: 10, STEPS: 40,
  // FLAGS: his block file screens every list row with one entry each (r4.1 C2, 533 rows today), so
  // the cap is above the list with room for his own rows.
  ID_MAP: 500, FLAGS: 1000, BLOCK_EXERCISES: 500,
  // r4 block file fields (R4-04, r4.1 Q18): ids a check is asked on, and a block's own step size.
  CHECK_LIFTS: 50, BLOCK_STEP_MIN: 0.5, BLOCK_STEP_MAX: 200,
  // Breaks on a laps set (15 Part 16, R4-14): 0, 1, 2 or 3, where 3 means three or more.
  BREAKS_MAX: 3,
  // A day's card order (A1-5): at most this many slot numbers.
  SLOT_ORDER: 50,
  // Input box lengths for typed numbers (the values are still checked by range).
  LOAD_CHARS: 7, REPS_CHARS: 4, PASSES_CHARS: 3, SETS_CHARS: 2,
  ROWS: { settings: 50, exercises: 5000, templates: 0, blocks: 500, days: 10000, sets: 100000, feedback: 40000 },
  FLAT_LOG_ROWS: 100000,
  // Worked out from the row caps by scripts/tests/unit/backup.test.js (it fails if these are lower).
  MAX_STORES_BYTES: 2729987864,
  MAX_RAW_BYTES: 4128953402,
  // A block file is a few KB; this cap is a set number above the largest block the caps
  // allow (backup.test.js builds that block and fails if it is not below), so a wrong pick
  // (a video) is refused before it is read (A2-5).
  MAX_BLOCK_BYTES: 16 * 1024 * 1024,
  // A restore file is checked on its size before it is read (A3-R2, A4-1). MAX_RAW_BYTES
  // stays the validator's correctness bound; this is the phone's practical cap.
  MAX_PICK_BYTES: 67108864,
  // From this size Settings says the backup is getting big (75 percent of the pick cap).
  BACKUP_BIG_BYTES: 50331648,
  MIN_TIME: 1577836800000,
  FUTURE_SLACK: 2 * 24 * 3600 * 1000
};

export const SETTING_KEYS = ['unit', 'active_block_id', 'profile', 'last_backup_at', 'persist_answer', 'theme', 'seeded_version', 'carry_down', 'rep_ask'];
// Device keys describe this phone. restore_note (A3-R8) is never read from a file and never
// written from one: a file row with that key is dropped like any key the app does not know.
export const DEVICE_KEYS = ['last_backup_at', 'persist_answer', 'theme', 'seeded_version', 'restore_note'];
// Why a safety copy was made (A2-10). Any other reason is refused.
export const SNAPSHOT_REASONS = ['before-restore', 'before-erase', 'before-upgrade', 'before-undo', 'before-reset'];
export const MUSCLES = ['chest', 'back', 'shoulders', 'arms', 'legs', 'core'];
export const EQUIPMENT = ['machine', 'cable', 'barbell', 'dumbbell', 'bodyweight', 'other'];
export const COUNT_LABELS = ['reps', 'seconds', 'laps'];
export const WHY = ['As written on your block', 'Added by you', 'Skipped by you', 'Stopped by a block check', 'Swapped by you', 'Not done', 'Day skipped'];

const ID_RE = /^[A-Za-z0-9:_-]{1,120}$/;
const KEY_RE = /^[a-z0-9_]{1,30}$/;
const LINK_RE = /^https:\/\/[^\s<>"]{1,500}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// The end of a set id after <dayId>:x<slot>:s or :w: the id number and the side (SR9).
const SET_TAIL_RE = /^\d+:(L|R|none)$/;
// No control characters but tab and newline, no lone surrogates: keeps the size math true.
const BAD_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

// One line of his words (a day label, a short note, a goal line): no control character at all,
// C0, DEL and C1 (so no tab, new line or NEL), and no line or paragraph separator (SR6). The same
// rule for a file and for every store write, so the app never stores a line its restore refuses.
const BAD_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
export function lineOk(v, max) {
  return typeof v === 'string' && v.length <= max && !BAD_TEXT.test(v) && !BAD_LINE.test(v);
}

// A video link (5.5a, SR14), one helper for the validator, the store and Today: LINK_RE, no
// character BAD_TEXT refuses (a lone surrogate passes LINK_RE), and a parsed https address with
// no user name or password and a host, so a link can never show one site and open another
// (a site name, an at sign, then another host opens that other host). Pure: URL parsing makes
// no network call.
export function isLink(v) {
  if (typeof v !== 'string' || !LINK_RE.test(v) || BAD_TEXT.test(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.username === '' && u.password === '' && u.hostname !== '';
  } catch (e) {
    return false;
  }
}
// A stored link: empty, or a link isLink takes.
export function linkOk(v) {
  return v === '' || isLink(v);
}

// One piece of his typed text, checked before any store write with the validator's own rules
// and LIMITS (SR3, SR11), so the app never stores text its restore refuses. kind: 'note' (tab and
// new line allowed), 'name' (an exercise name, 1 or more characters), 'blockname' (may be empty),
// 'words' (one line, a short note or a goal line), 'label' (one line, a day label), 'link'.
export function textOk(kind, v) {
  const text = (max, min) => typeof v === 'string' && v.length >= min && v.length <= max && !BAD_TEXT.test(v);
  if (kind === 'note') return text(LIMITS.NOTE, 0);
  if (kind === 'name') return text(LIMITS.NAME, 1);
  if (kind === 'blockname') return text(LIMITS.NAME, 0);
  if (kind === 'words') return lineOk(v, LIMITS.WORDS);
  if (kind === 'label') return lineOk(v, LIMITS.LABEL);
  if (kind === 'link') return linkOk(v);
  return false;
}

export class BadFile extends Error {
  constructor(msg, code) { super(msg); this.code = code || 'bad'; }
}
const bad = (msg) => { throw new BadFile(msg); };
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// __proto__, constructor, toString and the rest read back an object or a function from a
// plain object, so they are never an id or a key (C9).
const reserved = (v) => v === '__proto__' || v in Object.prototype;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------- times ----------------

// The backup marker the phone keeps (last_backup_at): null, or a whole number from MIN_TIME to
// now + FUTURE_SLACK, the same range the validator reads back (SR1, SR10).
export function markerOk(v, now) {
  return v === null || (Number.isInteger(v) && v >= LIMITS.MIN_TIME && v <= now + LIMITS.FUTURE_SLACK);
}

// One form for every text time in a file: ISO 8601 with the local offset.
export function isoLocal(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3) +
    (off >= 0 ? '+' : '-') + p(Math.floor(a / 60)) + ':' + p(a % 60);
}

export function isRealDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// ---------------- field checks ----------------

const ABSENT = Symbol('absent');
// Copy the named fields of v. A missing field refuses the row, unless the spec marks it
// optional: then it takes its default, or stays out when the default is ABSENT.
function fields(spec, v, w) {
  const out = {};
  for (const [k, fn] of Object.entries(spec)) {
    if (!own(v, k)) {
      if (!fn.dflt) bad(w + ': missing ' + k);
      const d = fn.dflt();
      if (d !== ABSENT) out[k] = d;
      continue;
    }
    out[k] = fn(v[k], w + '.' + k);
  }
  return out;
}

function makeChecks(now) {
  const maxTime = now + LIMITS.FUTURE_SLACK;
  const c = {
    id: (v, w) => (typeof v === 'string' && ID_RE.test(v) && !reserved(v)) ? v : bad(w + ': bad id'),
    idOrNull: (v, w) => v === null ? null : c.id(v, w),
    key: (v, w) => (typeof v === 'string' && KEY_RE.test(v) && !reserved(v)) ? v : bad(w + ': bad key'),
    text: (max, min = 0) => (v, w) => (typeof v === 'string' && v.length >= min && v.length <= max && !BAD_TEXT.test(v)) ? v : bad(w + ': bad text'),
    oneOf: (list) => (v, w) => list.includes(v) ? v : bad(w + ': not allowed'),
    oneOfOrNull: (list) => (v, w) => v === null ? null : c.oneOf(list)(v, w),
    bool: (v, w) => typeof v === 'boolean' ? v : bad(w + ': not a boolean'),
    boolOrNull: (v, w) => v === null ? null : c.bool(v, w),
    num: (lo, hi) => (v, w) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi) ? v : bad(w + ': number out of range'),
    numOrNull: (lo, hi) => (v, w) => v === null ? null : c.num(lo, hi)(v, w),
    int: (lo, hi) => (v, w) => (Number.isInteger(v) && v >= lo && v <= hi) ? v : bad(w + ': whole number out of range'),
    intOrNull: (lo, hi) => (v, w) => v === null ? null : c.int(lo, hi)(v, w),
    time: (v, w) => (Number.isInteger(v) && v >= LIMITS.MIN_TIME && v <= maxTime) ? v : bad(w + ': bad time'),
    timeOrNull: (v, w) => v === null ? null : c.time(v, w),
    dateOrNull: (v, w) => v === null ? null : (isRealDate(v) ? v : bad(w + ': bad date')),
    link: (v, w) => linkOk(v) ? v : bad(w + ': bad link'),
    nullOnly: (v, w) => v === null ? null : bad(w + ': must be empty'),
    exact: (x) => (v, w) => v === x ? v : bad(w + ': not allowed'),
    arr: (max, item) => (v, w) => {
      if (!Array.isArray(v) || v.length > max) bad(w + ': bad list');
      return v.map((x, i) => item(x, w + '[' + i + ']'));
    },
    arrOrNull: (max, item) => (v, w) => v === null ? null : c.arr(max, item)(v, w),
    // A list of loads: 1 to max numbers, rising, no repeats (r4.1 Q14, Q41).
    loads: (max, item) => (v, w) => {
      const out = c.arr(max, item)(v, w);
      if (!out.length || out.some((x, i) => i > 0 && !(x > out[i - 1]))) bad(w + ': loads must rise with no repeats');
      return out;
    },
    // A list of min to max entries, no two the same.
    arrUnique: (min, max, item) => (v, w) => {
      const out = c.arr(max, item)(v, w);
      if (out.length < min || new Set(out).size !== out.length) bad(w + ': bad list');
      return out;
    },
    // One line of his words: no control character at all, not even a tab or a new line.
    line: (max) => (v, w) => lineOk(v, max) ? v : bad(w + ': bad text'),
    // A field that may be missing (r4 schema 1 fields: missing means the Slice 1 behavior).
    // dflt() gives the value to store, or ABSENT to leave the key out.
    opt: (fn, dflt) => Object.assign((v, w) => fn(v, w), { dflt }),
    // A fixed-shape object: only the named fields are copied, each required unless optional.
    shape: (spec) => (v, w) => {
      if (!isObj(v)) bad(w + ': not an object');
      return fields(spec, v, w);
    },
    shapeOrNull: (spec) => (v, w) => v === null ? null : c.shape(spec)(v, w),
    // A map with checked keys and values; never more than max entries.
    map: (max, keyFn, valFn) => (v, w) => {
      if (!isObj(v)) bad(w + ': not an object');
      const ks = Object.keys(v);
      if (ks.length > max) bad(w + ': too many entries');
      const out = {};
      for (const k of ks) { keyFn(k, w + ' key'); out[k] = valFn(v[k], w + '.' + k); }
      return out;
    }
  };
  return c;
}

function rowSpecs(c) {
  const L = LIMITS;
  const load = c.num(0, L.LOAD_MAX), loadN = c.numOrNull(0, L.LOAD_MAX);
  const reps = c.int(0, L.REPS_MAX), repsN = c.intOrNull(0, L.REPS_MAX);
  const lift = c.shape({
    slot: c.int(1, L.SLOT_MAX), exercise_id: c.id, sets: c.int(1, L.SETS_MAX), rep_low: repsN, rep_high: repsN,
    start_load: loadN, failure_set: c.bool, reps_left_target: c.intOrNull(0, 4),
    warmups: c.arr(L.WARMUPS, c.shape({ reps, load: loadN })),
    sides: c.oneOf(['none', 'LR']), load_basis: c.oneOf(['total', 'per_side', 'per_hand']),
    count_label: c.oneOfOrNull(COUNT_LABELS), note: c.text(L.NOTE),
    // His words from his block file (R4-04): a quiet line on the card, and the goal part of
    // the helper for a lift with no rep range. Missing = '' (the Slice 1 behavior).
    short_note: c.opt(c.line(L.WORDS), () => ''), goal_line: c.opt(c.line(L.WORDS), () => '')
  });
  const blockBody = {
    name: c.text(L.NAME), unit: c.oneOf(['lb', 'kg']), profile: c.exact('fixed'),
    rules_frozen: c.shape({ profile: c.exact('fixed'), rules_version: c.exact('none') }),
    passes: c.intOrNull(1, L.PASSES_MAX), notes: c.text(L.NOTE),
    // lifts: null = asked on every exercise, else only on these (R4-04). Missing = null.
    checks: c.arr(L.CHECKS, c.shape({ key: c.key, ask: c.text(L.WORDS), stop_note: c.text(L.WORDS),
      lifts: c.opt((v, w) => v === null ? null : c.arrUnique(1, L.CHECK_LIFTS, c.id)(v, w), () => null) })),
    scores: c.arr(L.SCORES, c.shape({ key: c.key, label: c.text(L.WORDS), min: c.exact(0), max: c.exact(10) })),
    rule_notes: c.shape({ one_failure_set: c.text(L.WORDS), failure_on_machine: c.text(L.WORDS) }),
    // machine, weight_steps (a list of loads) and step (one step size) override the exercise row
    // for this block only (R4-04, R4-06, r4.1 Q14, Q18); missing = the key stays out and the
    // exercise row's value is used.
    exercise_flags: c.map(L.FLAGS, c.id, c.shape({ no_added_sets: c.bool, left_out_of_builder: c.bool,
      machine: c.opt(c.bool, () => ABSENT),
      weight_steps: c.opt(c.loads(L.STEPS, load), () => ABSENT),
      step: c.opt(c.num(L.BLOCK_STEP_MIN, L.BLOCK_STEP_MAX), () => ABSENT) })),
    day_templates: c.arr(L.DAYS_PER_BLOCK, c.shape({ day: c.int(1, L.DAY_MAX), label: c.line(L.LABEL), lifts: c.arr(L.LIFTS_PER_DAY, lift) }))
  };
  const answer = c.intOrNull(1, 4);
  // breaks (15 Part 16, R4-14): 0 to 3 on a laps set (3 means three or more), null when not answered.
  const breaks = c.intOrNull(0, L.BREAKS_MAX);
  const done = c.shapeOrNull({ load: loadN, reps: repsN, reps_left: c.intOrNull(0, 4), reps_left_plus: c.bool, failure: c.bool, unit: c.oneOf(['lb', 'kg']), breaks });
  // from_copy (15 Part 6): a draft copied down from an earlier set. A file without it reads false.
  // A draft without breaks reads null (15 Part 16).
  const draft = c.shapeOrNull({ load: loadN, reps: repsN, reps_left: c.intOrNull(0, 4), reps_left_plus: c.bool, failure: c.bool,
    from_copy: c.opt(c.bool, () => false), breaks: c.opt(breaks, () => null) });
  return {
    exercises: {
      id: c.id, name: c.text(L.NAME, 1), muscle: c.oneOf(MUSCLES), equipment: c.oneOf(EQUIPMENT),
      count_label: c.oneOf(COUNT_LABELS), weight_steps: (v, w) => v === null ? null : c.loads(L.STEPS, load)(v, w), step_default: load,
      unilateral: c.bool, machine: c.bool, no_added_sets: c.bool, left_out_of_builder: c.bool,
      flags_set: c.bool, link: c.link, notes: c.text(L.NOTE), custom: c.bool, edited: c.bool
    },
    blockBody,
    blocks: {
      id: c.id, source_id: c.idOrNull, version: c.intOrNull(1, L.BLOCK_VERSION_MAX),
      id_map: c.map(L.ID_MAP, c.id, c.id), created_at: c.time, ...blockBody, status: c.oneOf(['active', 'done'])
    },
    days: {
      id: c.id, block_id: c.id, pass: c.int(1, L.PASS_MAX), day: c.int(1, L.DAY_MAX), label: c.line(L.LABEL),
      status: c.oneOf(['planned', 'open', 'done', 'skipped']), started_at: c.timeOrNull, done_at: c.timeOrNull,
      done_date: c.dateOrNull, scores: c.map(L.SCORES, c.key, c.intOrNull(0, L.SCORE_MAX)), notes: c.text(L.NOTE),
      saved_at: c.timeOrNull,
      // The day's card order (A1-5): null = slot number order. Missing = null.
      slot_order: c.opt((v, w) => v === null ? null : c.arrUnique(1, L.SLOT_ORDER, c.int(1, L.SLOT_MAX))(v, w), () => null)
    },
    sets: {
      id: c.id, day_id: c.id, block_id: c.id, exercise_id: c.id, slot: c.int(1, L.SLOT_MAX), set_n: c.int(1, L.SET_N_MAX),
      side: c.oneOf(['L', 'R', 'none']), kind: c.oneOf(['warmup', 'work']),
      target: c.shape({ load: loadN, rep_low: repsN, rep_high: repsN, load_basis: c.oneOf(['total', 'per_side', 'per_hand']), count_label: c.oneOfOrNull(COUNT_LABELS), reps_left_target: c.intOrNull(0, 4) }),
      draft, done, status: c.oneOf(['planned', 'done', 'skipped']), origin: c.oneOf(['plan', 'added']),
      saved_at: c.timeOrNull, first_done_at: c.timeOrNull, why: c.oneOf(WHY)
    },
    feedback: {
      id: c.id, day_id: c.id, exercise_id: c.id, muscle: c.oneOf(MUSCLES), pump: answer, soreness: answer, workload: answer,
      checks: c.map(L.CHECKS, c.key, c.boolOrNull), note: c.text(L.NOTE), pending: c.bool, saved_at: c.timeOrNull,
      label_set: c.exact('w1')
    }
  };
}

// A settings row. A key the app does not know (or restore_note, a device key never read from
// a file) gives null: the row is dropped and the file still reads, so a newer file never
// locks out an older copy of the app (15, settings rule). Every known key is checked by type.
function settingRow(c, v, w) {
  if (!isObj(v) || !own(v, 'key') || !own(v, 'value') || typeof v.key !== 'string') bad(w + ': bad settings row');
  if (!SETTING_KEYS.includes(v.key)) return null;
  const key = v.key;
  const val = v.value;
  const check = {
    unit: c.oneOf(['lb', 'kg']), active_block_id: c.idOrNull, profile: c.exact('fixed'),
    last_backup_at: c.timeOrNull, persist_answer: c.boolOrNull, theme: c.oneOf(['phone', 'light', 'dark']),
    seeded_version: (x, ww) => x === null ? null : c.text(LIMITS.VERSION_STR, 1)(x, ww),
    carry_down: c.bool, rep_ask: c.bool
  }[key];
  return { key, value: check(val, w + '.value') };
}

function buildRow(spec, v, w) {
  if (!isObj(v)) bad(w + ': not an object');
  return fields(spec, v, w);
}

// A lift's rep range (R4-05): both null, or rep_low set with rep_high set (low at or below
// high) or null (an open top: "rep_low or more"). rep_high with no rep_low refuses.
export function repPairOk(low, high) {
  if (low === null) return high === null;
  return high === null || low <= high;
}

// Rules that span fields of one row (5.5a).
function rowRules(store, r, w) {
  if (store === 'sets') {
    if (r.status === 'done' && r.done === null) bad(w + ': done set has no done values');
    if (r.status === 'planned' && r.done !== null) bad(w + ': planned set has done values');
    if (r.status !== 'planned' && r.draft !== null) bad(w + ': only a planned set holds a draft');
    if (r.status === 'done' && r.first_done_at === null) bad(w + ': done set has no first done time');
  }
  if (store === 'days' && r.status === 'done' && (r.done_at === null || r.done_date === null)) bad(w + ': done day has no date');
  // A skipped day was never done, so it has no done dates (15 Part 15, R4-02).
  if (store === 'days' && r.status === 'skipped' && (r.done_at !== null || r.done_date !== null)) bad(w + ': skipped day has a done date');
  if (store === 'blocks') {
    const ck = r.checks.map(x => x.key), sk = r.scores.map(x => x.key);
    if (new Set(ck).size !== ck.length || new Set(sk).size !== sk.length) bad(w + ': duplicate check or score key');
    for (const dt of r.day_templates) for (const l of dt.lifts) if (!repPairOk(l.rep_low, l.rep_high)) bad(w + ': bad rep range');
    // Set ids and the day order are built from these numbers, so none may repeat (SR12).
    const dayNs = r.day_templates.map(dt => dt.day);
    if (new Set(dayNs).size !== dayNs.length) bad(w + ': a day number repeats');
    for (const dt of r.day_templates) { const sl = dt.lifts.map(l => l.slot); if (new Set(sl).size !== sl.length) bad(w + ': a slot number repeats in one day'); }
  }
}

// ---------------- the backup file ----------------

function readText(text, max = LIMITS.MAX_RAW_BYTES) {
  if (typeof text !== 'string') bad('not text');
  // The byte length is worked out without making a copy of the file.
  if (text.length > max) bad('file too large');
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    n += code < 0x80 ? 1 : code < 0x800 ? 2 : (code >= 0xd800 && code <= 0xdbff) ? (i++, 4) : 3;
    if (n > max) bad('file too large');
  }
  try { return JSON.parse(text); } catch (e) { bad('not JSON'); }
}

function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    n += code < 0x80 ? 1 : code < 0x800 ? 2 : (code >= 0xd800 && code <= 0xdbff) ? (i++, 4) : 3;
  }
  return n;
}

// Check one parsed backup object (a file, or a safety copy read back from the phone).
export function validateBackupObject(f, opts) {
  const now = opts.now;
  if (!isObj(f)) bad('not an object');
  if (f.format !== 'liftlog-backup') bad('not a backup file');
  if (!Number.isInteger(f.schema) || f.schema < 1) bad('bad schema');
  if (!(f.schema <= SCHEMA)) throw new BadFile('newer schema', 'toonew');
  if (!isObj(f.counts) || !isObj(f.stores)) bad('no stores');
  const want = [...STORE_NAMES].sort().join(',');
  if (Object.keys(f.counts).sort().join(',') !== want) bad('counts do not name the 7 stores');
  if (Object.keys(f.stores).sort().join(',') !== want) bad('stores are not the 7 stores');
  if (f.flat_log !== undefined && (!Array.isArray(f.flat_log) || f.flat_log.length > LIMITS.FLAT_LOG_ROWS)) bad('bad flat_log');
  if (typeof f.exported_at !== 'string' || !Number.isFinite(Date.parse(f.exported_at))) bad('bad exported_at');
  const c = makeChecks(now);
  // The file time becomes the phone's backup marker on a restore, so it takes the same range
  // check as every *_at field (SR1, SR10): never before MIN_TIME, never past now + FUTURE_SLACK.
  c.time(Date.parse(f.exported_at), 'exported_at');
  let storeBytes = 0;
  for (const s of STORE_NAMES) storeBytes += utf8Length(JSON.stringify(f.stores[s]) || '');
  if (storeBytes > LIMITS.MAX_STORES_BYTES) bad('stores too large');

  const specs = rowSpecs(c);
  const out = {};
  for (const s of STORE_NAMES) {
    const rows = f.stores[s];
    if (!Array.isArray(rows)) bad(s + ': not a list');
    if (rows.length > LIMITS.ROWS[s]) bad(s + ': too many rows');
    if (f.counts[s] !== rows.length) bad(s + ': count does not match');
    const seen = new Set();
    out[s] = [];
    rows.forEach((v, i) => {
      const w = s + '[' + i + ']';
      const r = s === 'settings' ? settingRow(c, v, w) : buildRow(specs[s], v, w);
      if (r === null) return;   // a settings key the app does not know: dropped
      const k = s === 'settings' ? r.key : r.id;
      if (seen.has(k)) bad(w + ': duplicate id');
      seen.add(k);
      rowRules(s, r, w);
      out[s].push(r);
    });
  }
  // References inside the file.
  const ids = (s) => new Set(out[s].map(r => r.id));
  const blocks = ids('blocks'), days = ids('days'), ex = ids('exercises');
  const blockRow = new Map(out.blocks.map(b => [b.id, b]));
  const dayRow = new Map(out.days.map(d => [d.id, d]));
  const seedIds = new Set((opts && opts.seedIds) || []);
  const exRow = new Map(out.exercises.map(e => [e.id, e]));
  for (const b of out.blocks) {
    for (const v of Object.values(b.id_map)) {
      if (!ex.has(v)) bad('blocks: id_map names a missing exercise');
      // 5.5a: an id_map value is a custom exercise id in the same file, never a list row (SR2).
      if (exRow.get(v).custom !== true || seedIds.has(v)) bad('blocks: id_map names a row that is not a custom exercise');
    }
    for (const dt of b.day_templates) for (const l of dt.lifts) if (!ex.has(l.exercise_id)) bad('blocks: names a missing exercise');
    for (const k of Object.keys(b.exercise_flags)) if (!ex.has(k)) bad('blocks: flags name a missing exercise');
    // A check's lifts: a seed id, a row of the file, or a value of this block's id_map (R13).
    // Never tied to day_templates, so a lift taken out of the block never breaks a restore.
    const mapped = new Set(Object.values(b.id_map));
    for (const ck of b.checks) for (const id of (ck.lifts || [])) {
      if (!seedIds.has(id) && !ex.has(id) && !mapped.has(id)) bad('blocks: a check names a missing exercise');
    }
  }
  const slotsOf = new Map();
  for (const r of out.sets) {
    if (!slotsOf.has(r.day_id)) slotsOf.set(r.day_id, new Set());
    slotsOf.get(r.day_id).add(r.slot);
  }
  for (const d of out.days) {
    if (!blocks.has(d.block_id)) bad('days: names a missing block');
    const keys = new Set(blockRow.get(d.block_id).scores.map(x => x.key));
    for (const k of Object.keys(d.scores)) if (!keys.has(k)) bad('days: score key not in its block');
    // Each slot in the card order holds a set on that day (A1-5).
    for (const sl of (d.slot_order || [])) if (!(slotsOf.get(d.id) || new Set()).has(sl)) bad('days: card order names a slot with no set');
    // 5.2: a day id is <blockId>:p<pass>:d<day>, and the store keys its writes on it (SR9).
    if (d.id !== d.block_id + ':p' + d.pass + ':d' + d.day) bad('days: id does not match its block, round and day');
  }
  for (const r of out.sets) {
    if (!days.has(r.day_id) || !blocks.has(r.block_id) || !ex.has(r.exercise_id)) bad('sets: names a missing row');
    // 5.2: a set id is <dayId>:x<slot>:s|w<n>:<side>, its block is its day's block (SR9).
    const pre = r.day_id + ':x' + r.slot + ':' + (r.kind === 'warmup' ? 'w' : 's');
    if (!r.id.startsWith(pre) || !SET_TAIL_RE.test(r.id.slice(pre.length)) || !r.id.endsWith(':' + r.side)) bad('sets: id does not match its day, slot, kind and side');
    if (r.block_id !== dayRow.get(r.day_id).block_id) bad('sets: block does not match its day');
  }
  for (const r of out.feedback) {
    if (!days.has(r.day_id) || !ex.has(r.exercise_id)) bad('feedback: names a missing row');
    // 5.2: a feedback id is <dayId>:x<slot>, the slot a whole number from 1 to SLOT_MAX (SR9).
    const n = r.id.startsWith(r.day_id + ':x') ? r.id.slice(r.day_id.length + 2) : '';
    if (!/^[1-9]\d*$/.test(n) || Number(n) > LIMITS.SLOT_MAX) bad('feedback: id does not match its day and slot');
    const keys = new Set(blockRow.get(dayRow.get(r.day_id).block_id).checks.map(x => x.key));
    for (const k of Object.keys(r.checks)) if (!keys.has(k)) bad('feedback: check key not in its block');
  }
  for (const r of out.settings) {
    if (r.key === 'active_block_id' && r.value !== null && !blocks.has(r.value)) bad('settings: active block missing');
  }
  const counts = Object.fromEntries(STORE_NAMES.map(s => [s, out[s].length]));
  return { stores: out, counts, schema: f.schema, exported_at: f.exported_at, exported_ms: Date.parse(f.exported_at), app_version: versionText(f.app_version) };
}

// The version shown on the restore sheet: only a plain x.y.z version, else nothing (C10).
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
function versionText(v) {
  return typeof v === 'string' && v.length <= LIMITS.VERSION_STR && VERSION_RE.test(v) ? v : '';
}

// Read a file's text. Returns {ok:true, ...} or {ok:false, code:'toonew'|'bad', why}.
export function validateBackup(text, opts) {
  try {
    return { ok: true, ...validateBackupObject(readText(text), opts) };
  } catch (e) {
    if (e instanceof BadFile) return { ok: false, code: e.code, why: e.message };
    return { ok: false, code: 'bad', why: String(e && e.message) };
  }
}

// Schema 1 has nothing to migrate. migrate() still returns every store.
export const MIGRATIONS = {};
export function migrate(stores, fromSchema) {
  let d = stores;
  for (let v = fromSchema; v < SCHEMA; v++) d = MIGRATIONS[v](d);
  const out = {};
  for (const s of STORE_NAMES) out[s] = d[s];
  return out;
}

// ---------------- building the file ----------------

// The smallest and the largest number of a list, by a plain loop (14.10 J9, SR13): a spread
// into Math.min or Math.max passes every entry as an argument and can throw on a long log.
// Both give null for an empty list.
export function minOf(list) {
  let m = null;
  for (let i = 0; i < list.length; i++) if (m === null || list[i] < m) m = list[i];
  return m;
}
export function maxOf(list) {
  let m = null;
  for (let i = 0; i < list.length; i++) if (m === null || list[i] > m) m = list[i];
  return m;
}

// stores: {settings, exercises, templates, blocks, days, sets, feedback} as arrays.
export function buildBackup(stores, opts) {
  const now = opts.now;
  const s = {};
  for (const n of STORE_NAMES) s[n] = (stores[n] || []).slice();
  // Only the settings keys the app knows go in a file (SR7, SR15): a device row like restore_note
  // or a leftover phonecheck_probe never rides out, and the count is taken from what is kept.
  s.settings = s.settings.filter(r => r && SETTING_KEYS.includes(r.key));
  const unitRow = s.settings.find(r => r.key === 'unit');
  const flat = flatLog(s);
  const firsts = flat.map(r => Date.parse(r.first_done_at)).filter(Number.isFinite);
  return {
    format: 'liftlog-backup',
    schema: SCHEMA,
    app_version: opts.appVersion || APP_VERSION,
    exported_at: isoLocal(now),
    flat_log_since: firsts.length ? isoLocal(minOf(firsts)) : null,
    unit: unitRow ? unitRow.value : 'lb',
    counts: Object.fromEntries(STORE_NAMES.map(n => [n, s[n].length])),
    stores: s,
    flat_log: flat
  };
}

export function backupFileName(now) {
  const iso = isoLocal(now);
  return 'liftlog-backup-' + iso.slice(0, 10) + '-' + iso.slice(11, 13) + iso.slice(14, 16) + '.json';
}

// One row per set with status done or skipped, from days with status done only (DESIGN 5.4).
export function flatLog(s) {
  const ex = new Map(s.exercises.map(r => [r.id, r]));
  const blocks = new Map(s.blocks.map(r => [r.id, r]));
  const fb = new Map(s.feedback.map(r => [r.id, r]));
  const doneDays = new Map(s.days.filter(d => d.status === 'done').map(d => [d.id, d]));
  const rows = [];
  const sorted = s.sets.filter(x => doneDays.has(x.day_id) && (x.status === 'done' || x.status === 'skipped'))
    .sort((a, b) => a.day_id < b.day_id ? -1 : a.day_id > b.day_id ? 1 : a.slot - b.slot ||
      (a.kind === b.kind ? 0 : a.kind === 'warmup' ? -1 : 1) || a.set_n - b.set_n || (a.side < b.side ? -1 : a.side > b.side ? 1 : 0));
  for (const x of sorted) {
    const day = doneDays.get(x.day_id);
    const block = blocks.get(day.block_id);
    const e = ex.get(x.exercise_id);
    const f = fb.get(x.day_id + ':x' + x.slot) || null;
    const d = x.done;
    const row = {
      date: day.done_date, session: day.label || null, lift: e ? e.name : null,
      weight: d ? d.load : null, unit: d ? d.unit : null, load_basis: x.target.load_basis,
      reps: d ? d.reps : null, count_label: x.target.count_label || (e ? e.count_label : null),
      set_number: x.set_n, side: x.side, kind: x.kind, status: x.status, origin: x.origin,
      failure: d ? d.failure : null, reps_left: d ? d.reps_left : null, reps_left_plus: d ? d.reps_left_plus : null,
      reps_left_target: x.target.reps_left_target, breaks: d ? d.breaks : null
    };
    for (const ck of (block ? block.checks : [])) row['check_' + ck.key] = f && own(f.checks, ck.key) ? f.checks[ck.key] : null;
    for (const sk of (block ? block.scores : [])) row['score_' + sk.key] = own(day.scores, sk.key) ? day.scores[sk.key] : null;
    row.pump = f ? f.pump : null;
    row.soreness = f ? f.soreness : null;
    row.workload = f ? f.workload : null;
    row.notes = [f && f.note, day.notes].filter(Boolean).join(' | ');
    row.block = day.block_id;
    row.pass = day.pass;
    row.day = day.day;
    row.set_id = x.id;
    row.saved_at = x.saved_at === null ? null : isoLocal(x.saved_at);
    row.first_done_at = isoLocal(x.first_done_at !== null ? x.first_done_at : (x.saved_at !== null ? x.saved_at : day.done_at));
    rows.push(row);
  }
  return rows;
}

// The app must never write a backup it cannot restore: from 48 MiB Settings says so (A4-1).
export function backupBig(bytes) {
  return Number.isFinite(bytes) && bytes >= LIMITS.BACKUP_BIG_BYTES;
}
// Whole MB, rounded up, for the backup.big line.
export function backupMB(bytes) {
  return Math.ceil(bytes / (1024 * 1024));
}

// ---------------- safety copies (5.2 snapshots, A2-10) ----------------

// A safety copy read back from the phone: its fields, its reason from the fixed list, and
// its data through the same allow table as any file. Returns the checked backup object.
export function validateSnapshotRow(row, opts) {
  const c = makeChecks(opts.now);
  if (!isObj(row)) bad('snapshot: not an object');
  c.id(row.id, 'snapshot.id');
  c.time(row.made_at, 'snapshot.made_at');
  c.oneOf(SNAPSHOT_REASONS)(row.reason, 'snapshot.reason');
  c.timeOrNull(row.last_backup_at_then, 'snapshot.last_backup_at_then');
  return validateBackupObject(row.data, opts);
}

// ---------------- the block file (5.4b) ----------------

export function validateBlock(text, opts) {
  try {
    const f = readText(text, LIMITS.MAX_BLOCK_BYTES);
    if (!isObj(f) || f.format !== 'liftlog-block') bad('not a block file');
    if (!Number.isInteger(f.schema) || f.schema < 1) bad('bad schema');
    if (!(f.schema <= SCHEMA)) throw new BadFile('newer schema', 'toonew');
    const c = makeChecks(opts.now);
    const specs = rowSpecs(c);
    const source_id = c.id(f.source_id, 'source_id');
    const version = c.int(1, LIMITS.BLOCK_VERSION_MAX)(f.version, 'version');
    const block = buildRow(specs.blockBody, f.block, 'block');
    rowRules('blocks', block, 'block');
    const exs = c.arr(LIMITS.BLOCK_EXERCISES, (v, w) => buildRow(specs.exercises, v, w))(f.exercises, 'exercises');
    const local = new Set();
    // A local exercise may never take a list id (SB2): a first load and a later update would map
    // the same lift two different ways (a custom copy first, the list row later).
    const seeds = new Set(opts.seedIds || []);
    for (const e of exs) {
      if (local.has(e.id)) bad('exercises: duplicate id');
      if (seeds.has(e.id)) throw new BadFile('local id is a list id', 'badref');
      local.add(e.id);
      e.custom = true;
    }
    const known = (id) => seeds.has(id) || local.has(id);
    for (const dt of block.day_templates) for (const l of dt.lifts) if (!known(l.exercise_id)) throw new BadFile('unknown exercise', 'badref');
    for (const k of Object.keys(block.exercise_flags)) if (!known(k)) throw new BadFile('unknown exercise', 'badref');
    for (const ck of block.checks) for (const id of (ck.lifts || [])) if (!known(id)) throw new BadFile('unknown exercise', 'badref');
    return { ok: true, source_id, version, block, exercises: exs };
  } catch (e) {
    if (e instanceof BadFile) return { ok: false, code: e.code, why: e.message };
    return { ok: false, code: 'bad', why: String(e && e.message) };
  }
}
