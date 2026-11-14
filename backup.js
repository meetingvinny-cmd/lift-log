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
  // Schema 2 (16 B.1 step 3 b, B.6.1a; 17 C.0.2): his Make my own exercise question lines, and a
  // day's body weight (R4-21). ADJUST_EARLIEST_MS is the first instant it is 2026-12-01 anywhere:
  // a stored switch to Adjust each round is never older than it (16 B.6.1, B.9).
  FLAG_Q: 200, BODY_WEIGHT_MIN: 20, BODY_WEIGHT_MAX: 1000, ADJUST_EARLIEST_MS: Date.UTC(2026, 10, 30, 10),
  // Input box lengths for typed numbers (the values are still checked by range).
  LOAD_CHARS: 7, REPS_CHARS: 4, PASSES_CHARS: 3, SETS_CHARS: 2,
  ROWS: { settings: 50, exercises: 5000, templates: 200, blocks: 500, days: 10000, sets: 100000, feedback: 40000 },
  FLAT_LOG_ROWS: 100000,
  // Worked out from the row caps by scripts/tests/unit/backup.test.js (it fails if these are lower).
  MAX_STORES_BYTES: 2765511664,
  MAX_RAW_BYTES: 4205577202,
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

export const SETTING_KEYS = ['unit', 'active_block_id', 'profile', 'last_backup_at', 'persist_answer', 'theme', 'seeded_version', 'carry_down', 'rep_ask',
  'equipment_saved', 'tips_seen', 'seen_version'];
// Device keys describe this phone. restore_note (A3-R8) is never read from a file and never
// written from one: a file row with that key is dropped like any key the app does not know.
// tips_seen and seen_version (17 C.0.2) describe this phone too: restore keeps the phone's.
export const DEVICE_KEYS = ['last_backup_at', 'persist_answer', 'theme', 'seeded_version', 'restore_note', 'tips_seen', 'seen_version'];
// Why a safety copy was made (A2-10; before-delete, 17 C.0.2). Any other reason is refused.
export const SNAPSHOT_REASONS = ['before-restore', 'before-erase', 'before-upgrade', 'before-undo', 'before-reset', 'before-delete'];
export const MUSCLES = ['chest', 'back', 'shoulders', 'arms', 'legs', 'core'];
export const EQUIPMENT = ['machine', 'cable', 'barbell', 'dumbbell', 'bodyweight', 'other'];
export const COUNT_LABELS = ['reps', 'seconds', 'laps'];
// The seven Slice 1 why texts: read in a schema 1 file only. From schema 2 a set stores a key.
export const WHY = ['As written on your block', 'Added by you', 'Skipped by you', 'Stopped by a block check', 'Swapped by you', 'Not done', 'Day skipped'];

// ---------------- schema 2 lists (16 B.1 step 3 a, B.5.1, B.6.1a; 17 C.0.2, C.2.2) ----------------
// backup.js keeps its own copies and imports neither rules.js nor data/exercises.js; static tests
// hold each list equal to its twin there.
export const SET_KINDS = Object.freeze(['normal', 'failure']);
// Every why key a set may store (16 B.5.1): the 7 Slice 1 keys, R1 to R11, then the 15 after them.
export const WHY_KEYS = Object.freeze([
  'why.plan', 'why.added', 'why.skipped', 'why.stopped', 'why.swapped', 'why.notdone', 'why.dayskipped',
  'why.R1', 'why.R2', 'why.R3', 'why.R4', 'why.R5', 'why.R6', 'why.R7', 'why.R8', 'why.R9', 'why.R10', 'why.R11',
  'why.top', 'why.floor', 'why.sleep', 'why.check', 'why.score', 'why.missed', 'why.flag', 'why.hand_add', 'why.easy',
  'why.load_up', 'why.rep_up', 'why.on_miss', 'why.step_down', 'why.new_set', 'why.swap_hold'
]);
// The seven Slice 1 texts to their keys (R4-29), used by MIGRATIONS[1] only.
export const WHY_KEY_OF = Object.freeze({
  'As written on your block': 'why.plan', 'Added by you': 'why.added', 'Skipped by you': 'why.skipped',
  'Stopped by a block check': 'why.stopped', 'Swapped by you': 'why.swapped', 'Not done': 'why.notdone',
  'Day skipped': 'why.dayskipped'
});
// Every rule table name a block can be frozen on (0.3.0).
export const RULE_VERSIONS = Object.freeze(['none', 'signed-1']);
export const MUSCLE_DETAILS = Object.freeze(['chest', 'back', 'traps_neck', 'shoulders', 'biceps', 'triceps', 'forearms_grip', 'abs_core', 'quads', 'hamstrings', 'glutes', 'calves']);
export const MUSCLE_DETAIL_CHIP = Object.freeze({ chest: 'chest', back: 'back', traps_neck: 'back', shoulders: 'shoulders', biceps: 'arms', triceps: 'arms', forearms_grip: 'arms', abs_core: 'core', quads: 'legs', hamstrings: 'legs', glutes: 'legs', calves: 'legs' });
export const EQUIPMENT_DETAILS = Object.freeze(['machine', 'smith', 'cable', 'barbell', 'landmine', 'dumbbell', 'kettlebell', 'band', 'body', 'other']);
export const EQUIPMENT_DETAIL_CHIP = Object.freeze({ machine: 'machine', smith: 'machine', cable: 'cable', barbell: 'barbell', landmine: 'barbell', dumbbell: 'dumbbell', kettlebell: 'other', band: 'other', body: 'bodyweight', other: 'other' });
export const LOAD_KINDS = Object.freeze(['external', 'body', 'body_plus', 'assist']);
export const TAG_CODES = Object.freeze(['overhead', 'spotter']);
// The tip and intro ids (17 C.3.16); the twin is ui/tips.js, built in Slice 3.
export const TIP_IDS = Object.freeze(['tip_warmup', 'tip_rest', 'tip_start', 'intro_board', 'intro_picker', 'intro_builder']);
const PROFILES = ['fixed', 'adaptive'];
const LEVELS = ['top', 'middle', 'bottom'];
const ADD_SCOPES = ['today', 'rest'];
// 17 C.0.2: equipment_detail from equipment, for a row written before schema 2.
const DETAIL_OF_EQUIPMENT = Object.freeze({ machine: 'machine', cable: 'cable', barbell: 'barbell', dumbbell: 'dumbbell', bodyweight: 'body', other: 'other' });

const ID_RE = /^[A-Za-z0-9:_-]{1,120}$/;
const KEY_RE = /^[a-z0-9_]{1,30}$/;
const LINK_RE = /^https:\/\/[^\s<>"]{1,500}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// One of his own templates (17 C.0.3).
const TEMPLATE_ID_RE = /^m[A-Za-z0-9-]{1,60}$/;
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

// The allow table. schema 1 is the table as it was before the bump; schema 2 adds the B.6.1a
// fields (16 B.6.1a, 17 C.0.3), each required unless its row says otherwise.
function rowSpecs(c, schema = SCHEMA) {
  const L = LIMITS;
  const two = schema >= 2;
  const load = c.num(0, L.LOAD_MAX), loadN = c.numOrNull(0, L.LOAD_MAX);
  const reps = c.int(0, L.REPS_MAX), repsN = c.intOrNull(0, L.REPS_MAX);
  const liftSpec = {
    slot: c.int(1, L.SLOT_MAX), exercise_id: c.id, sets: c.int(1, L.SETS_MAX), rep_low: repsN, rep_high: repsN,
    start_load: loadN, failure_set: c.bool, reps_left_target: c.intOrNull(0, 4),
    warmups: c.arr(L.WARMUPS, c.shape({ reps, load: loadN })),
    sides: c.oneOf(['none', 'LR']), load_basis: c.oneOf(['total', 'per_side', 'per_hand']),
    count_label: c.oneOfOrNull(COUNT_LABELS), note: c.text(L.NOTE),
    // His words from his block file (R4-04): a quiet line on the card, and the goal part of
    // the helper for a lift with no rep range. Missing = '' (the Slice 1 behavior).
    short_note: c.opt(c.line(L.WORDS), () => ''), goal_line: c.opt(c.line(L.WORDS), () => '')
  };
  if (two) liftSpec.set_type = c.oneOf(SET_KINDS);
  const lift = c.shape(liftSpec);
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
  const targetSpec = { load: loadN, rep_low: repsN, rep_high: repsN, load_basis: c.oneOf(['total', 'per_side', 'per_hand']), count_label: c.oneOfOrNull(COUNT_LABELS), reps_left_target: c.intOrNull(0, 4) };
  const specs = {
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
      target: c.shape(targetSpec),
      draft, done, status: c.oneOf(['planned', 'done', 'skipped']), origin: c.oneOf(['plan', 'added']),
      saved_at: c.timeOrNull, first_done_at: c.timeOrNull, why: c.oneOf(WHY)
    },
    feedback: {
      id: c.id, day_id: c.id, exercise_id: c.id, muscle: c.oneOf(MUSCLES), pump: answer, soreness: answer, workload: answer,
      checks: c.map(L.CHECKS, c.key, c.boolOrNull), note: c.text(L.NOTE), pending: c.bool, saved_at: c.timeOrNull,
      label_set: c.exact('w1')
    }
  };
  if (!two) return specs;

  // ---- schema 2 (16 B.6.1a) ----
  const profile = c.oneOf(PROFILES);
  // Exactly 0 or 3 lines, each 1 to 120 (his three Adjust each round condition lines).
  const switchConditions = (v, w) => {
    const out = c.arr(3, c.line(L.WORDS))(v, w);
    if ((out.length !== 0 && out.length !== 3) || out.some(x => x.length < 1)) bad(w + ': 0 or 3 lines of 1 or more characters');
    return out;
  };
  const words2 = {
    levels: c.map(MUSCLE_DETAILS.length, c.oneOf(MUSCLE_DETAILS), c.oneOf(LEVELS)),
    switch_conditions: switchConditions,
    sleep_hint: c.line(L.WORDS),
    flag_questions: c.shape({ machine: c.line(L.FLAG_Q), no_added_sets: c.line(L.FLAG_Q), left_out_of_builder: c.line(L.FLAG_Q) })
  };
  const ticks = (v, w) => (Array.isArray(v) && v.length === 3 && v.every(x => x === true)) ? [true, true, true] : bad(w + ': three ticks');
  // A block file never sets a profile (16 B.6.4): Fixed only, no switch.
  specs.blockBody = {
    ...blockBody, profile: c.exact('fixed'),
    rules_frozen: c.shape({ profile: c.exact('fixed'), rules_version: c.oneOf(RULE_VERSIONS) }),
    profile_switch: c.opt(c.nullOnly, () => null), ...words2
  };
  specs.blocks = {
    ...specs.blocks, ...words2, profile,
    rules_frozen: c.shape({ profile, rules_version: c.oneOf(RULE_VERSIONS) }),
    profile_switch: c.shapeOrNull({ switched_at: c.time, ticks, back_at: c.timeOrNull }),
    template_id: c.idOrNull,
    copied_from: c.shapeOrNull({ block_id: c.id, pass: c.int(1, L.PASS_MAX) }),
    finished_at: c.timeOrNull
  };
  specs.exercises = {
    ...specs.exercises, muscle_detail: c.oneOfOrNull(MUSCLE_DETAILS), equipment_detail: c.oneOf(EQUIPMENT_DETAILS),
    load_kind: c.oneOf(LOAD_KINDS), tags: c.arrUnique(0, 2, c.oneOf(TAG_CODES))
  };
  // A body weight: 20 to 1000 with one decimal at most (R4-21).
  const bodyWeight = (v, w) => v === null ? null :
    (typeof v === 'number' && Number.isFinite(v) && v >= L.BODY_WEIGHT_MIN && v <= L.BODY_WEIGHT_MAX && Math.round(v * 10) / 10 === v) ? v : bad(w + ': bad body weight');
  specs.days = { ...specs.days, short_sleep_since_last: c.boolOrNull, profile, body_weight: bodyWeight };
  specs.sets = {
    ...specs.sets,
    // failure_set: optional (a missing key is read by the engine's position rule); effort_only:
    // optional, missing = false (16 B.6.1). Neither is written by the migration.
    target: c.shape({ ...targetSpec, failure_set: c.opt(c.bool, () => ABSENT), effort_only: c.opt(c.bool, () => ABSENT) }),
    set_type: c.oneOf(SET_KINDS), set_type_by_hand: c.bool, add_scope: c.oneOfOrNull(ADD_SCOPES), why: c.oneOf(WHY_KEYS)
  };
  specs.feedback = { ...specs.feedback, muscle: c.oneOf([...MUSCLES, ...MUSCLE_DETAILS]) };
  // His own templates only (17 C.0.3).
  const slot = c.shape({ exercise_id: c.id, rep_low: repsN, rep_high: repsN, priority: c.oneOfOrNull(LEVELS), sets: c.intOrNull(1, L.SETS_MAX) });
  const listOf = (min, max, item) => (v, w) => { const out = c.arr(max, item)(v, w); if (out.length < min) bad(w + ': bad list'); return out; };
  specs.templates = {
    id: (v, w) => (typeof v === 'string' && TEMPLATE_ID_RE.test(v)) ? v : bad(w + ': bad template id'),
    // name: the exercise name rule (1 to NAME characters, textOk('name')).
    author: c.exact('mine'), name: specs.exercises.name, made_at: c.time, from_block_id: c.idOrNull,
    days: listOf(1, L.DAYS_PER_BLOCK, c.shape({ label: c.line(L.LABEL), slots: listOf(1, L.LIFTS_PER_DAY, slot) }))
  };
  return specs;
}

// A settings row. A key the app does not know (or restore_note, a device key never read from
// a file) gives null: the row is dropped and the file still reads, so a newer file never
// locks out an older copy of the app (15, settings rule). Every known key is checked by type.
function settingRow(c, v, w) {
  const tipKey = c.oneOf(TIP_IDS);
  if (!isObj(v) || !own(v, 'key') || !own(v, 'value') || typeof v.key !== 'string') bad(w + ': bad settings row');
  if (!SETTING_KEYS.includes(v.key)) return null;
  const key = v.key;
  const val = v.value;
  const check = {
    unit: c.oneOf(['lb', 'kg']), active_block_id: c.idOrNull, profile: c.exact('fixed'),
    last_backup_at: c.timeOrNull, persist_answer: c.boolOrNull, theme: c.oneOf(['phone', 'light', 'dark']),
    seeded_version: (x, ww) => x === null ? null : c.text(LIMITS.VERSION_STR, 1)(x, ww),
    carry_down: c.bool, rep_ask: c.bool,
    // 17 C.0.2: 1 to 10 kinds (an empty list refuses the file); the tips he closed; the version
    // whose what-changed note he saw (the two last are device keys).
    equipment_saved: c.arrUnique(1, 10, c.oneOf(EQUIPMENT_DETAILS)),
    tips_seen: c.map(TIP_IDS.length, tipKey, c.exact(true)),
    seen_version: (x, ww) => versionText(x) === x ? x : bad(ww + ': bad version')
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

// Rules that span fields of one row (5.5a; schema 2, 16 B.6.1a).
function rowRules(store, r, w, schema = SCHEMA) {
  if (schema >= 2) rowRules2(store, r, w);
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

function rowRules2(store, r, w) {
  if (store === 'exercises') {
    if (r.muscle_detail !== null && MUSCLE_DETAIL_CHIP[r.muscle_detail] !== r.muscle) bad(w + ': muscle detail is not in its muscle group');
    if (EQUIPMENT_DETAIL_CHIP[r.equipment_detail] !== r.equipment) bad(w + ': equipment detail is not in its equipment group');
  }
  if (store === 'blocks') {
    if (r.rules_frozen.profile !== r.profile) bad(w + ': frozen profile differs from the block profile');
    if (r.profile === 'adaptive' && r.rules_frozen.rules_version !== 'signed-1') bad(w + ': an adaptive block needs the signed rules');
    const ps = r.profile_switch;
    if (ps !== null) {
      if (ps.switched_at < LIMITS.ADJUST_EARLIEST_MS) bad(w + ': switched before the earliest day');
      if (ps.back_at !== null && !(ps.back_at > ps.switched_at)) bad(w + ': back to Fixed before the switch');
    }
    if (r.profile === 'adaptive' && (ps === null || ps.back_at !== null)) bad(w + ': an adaptive block needs a switch in force');
    if (r.profile === 'fixed' && ps !== null && ps.back_at === null) bad(w + ': a Fixed block holds a switch in force');
    if (own(r, 'finished_at') && r.finished_at !== null && r.status !== 'done') bad(w + ': finished time on a block that is not done');
  }
  if (store === 'sets') {
    if (r.kind === 'warmup' && (r.set_type !== 'normal' || r.set_type_by_hand !== false)) bad(w + ': a warm-up has a set kind');
    if (r.origin === 'plan' && r.add_scope !== null) bad(w + ': a planned set has an add scope');
    if (r.origin === 'added' && r.add_scope === null) bad(w + ': an added set has no add scope');
    if (r.target.failure_set === true && r.kind !== 'work') bad(w + ': a failure goal on a warm-up');
  }
  if (store === 'templates') {
    for (const d of r.days) for (const sl of d.slots) if (sl.rep_low !== null && sl.rep_high !== null && sl.rep_low > sl.rep_high) bad(w + ': bad rep range');
  }
}

// ---------------- schema 2 helpers (16 B.6.2, 17 C.0.2) ----------------

// An exercise row with the schema 2 fields: every field it already holds is kept, a missing one
// takes the 17 C.0.2 default. Pure; reads no list (r4.4 R10: muscle_detail is null, the seed
// upsert after the upgrade writes the list values).
export function exerciseDefaults2(row) {
  const out = { ...row };
  if (!own(out, 'muscle_detail')) out.muscle_detail = null;
  if (!own(out, 'equipment_detail')) out.equipment_detail = own(DETAIL_OF_EQUIPMENT, row.equipment) ? DETAIL_OF_EQUIPMENT[row.equipment] : null;
  if (!own(out, 'load_kind')) out.load_kind = row.id === 'assisted_pull_up' ? 'assist' : row.equipment === 'bodyweight' ? 'body' : 'external';
  if (!own(out, 'tags')) out.tags = [];
  return out;
}

// A schema 1 block body (a stored block or a block file) with the schema 2 block-file fields
// (16 B.6.4): lift set_type 'normal', no levels, no condition lines, no hint, no questions.
function liftBlockBody2(b) {
  return {
    ...b, levels: {}, switch_conditions: [], sleep_hint: '',
    flag_questions: { machine: '', no_added_sets: '', left_out_of_builder: '' },
    day_templates: b.day_templates.map(dt => ({ ...dt, lifts: dt.lifts.map(l => ({ ...l, set_type: 'normal' })) }))
  };
}

// MIGRATIONS[1] (16 B.6.2): the seven stores of schema 1 to schema 2. Pure and never edited after
// ship: every row of every store is kept (settings rows untouched), ids, texts and times never
// change, and an unknown why text throws.
function migrate1(stores) {
  const s = structuredClone(stores);
  const list = (n) => Array.isArray(s[n]) ? s[n] : [];
  const blockProfile = new Map(list('blocks').map(b => [b.id, b.profile]));
  if (Array.isArray(s.exercises)) s.exercises = s.exercises.map(exerciseDefaults2);
  if (Array.isArray(s.blocks)) s.blocks = s.blocks.map(b => ({ ...liftBlockBody2(b), profile_switch: null, template_id: null, copied_from: null, finished_at: null }));
  if (Array.isArray(s.days)) s.days = s.days.map(d => ({ ...d, short_sleep_since_last: null, body_weight: null, profile: blockProfile.get(d.block_id) || 'fixed' }));
  if (Array.isArray(s.sets)) s.sets = s.sets.map(x => {
    if (!own(WHY_KEY_OF, x.why)) throw new BadFile('a set holds a why text this version does not know');
    return { ...x, set_type: 'normal', set_type_by_hand: false, add_scope: x.origin === 'added' ? 'today' : null, why: WHY_KEY_OF[x.why] };
  });
  return s;
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

  let out = checkStores(f.stores, f.counts, c, f.schema, opts);
  // An older file is checked by its own table, migrated, then checked again by this version's
  // table and the whole reference pass (16 B.6.2), so it comes out as a schema SCHEMA object that
  // passes every check a SCHEMA file must pass. The row counts must not change.
  if (f.schema < SCHEMA) {
    const kept = Object.fromEntries(STORE_NAMES.map(s => [s, out[s].length]));
    out = checkStores(migrate(out, f.schema), kept, c, SCHEMA, opts);
  }
  const counts = Object.fromEntries(STORE_NAMES.map(s => [s, out[s].length]));
  return { stores: out, counts, schema: SCHEMA, exported_at: f.exported_at, exported_ms: Date.parse(f.exported_at), app_version: versionText(f.app_version) };
}

// Every row of the seven stores through the allow table of one schema, then the references
// inside the file. Returns the rebuilt stores.
function checkStores(stores, counts, c, schema, opts) {
  const specs = rowSpecs(c, schema);
  const out = {};
  for (const s of STORE_NAMES) {
    const rows = stores[s];
    if (!Array.isArray(rows)) bad(s + ': not a list');
    // Schema 1 has no templates rows (17 C.0.3 adds them with schema 2).
    const cap = s === 'templates' && schema < 2 ? 0 : LIMITS.ROWS[s];
    if (rows.length > cap) bad(s + ': too many rows');
    if (counts[s] !== rows.length) bad(s + ': count does not match');
    const seen = new Set();
    out[s] = [];
    rows.forEach((v, i) => {
      const w = s + '[' + i + ']';
      const r = s === 'settings' ? settingRow(c, v, w) : buildRow(specs[s], v, w);
      if (r === null) return;   // a settings key the app does not know: dropped
      const k = s === 'settings' ? r.key : r.id;
      if (seen.has(k)) bad(w + ': duplicate id');
      seen.add(k);
      rowRules(s, r, w, schema);
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
  // A template slot names an exercises row in the same file (17 C.0.3).
  for (const r of out.templates) for (const d of r.days) for (const sl of d.slots) if (!ex.has(sl.exercise_id)) bad('templates: names a missing exercise');
  return out;
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

// One pure step per schema (16 B.6.2). migrate() returns every store.
export const MIGRATIONS = { 1: migrate1 };
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

// Met or missed (16 B.3 shared terms, B.5 row 5): a done work set with a rep goal met it when
// done.reps reaches target.rep_low. Null on a warm-up, a skipped set, an effort-only set, the
// planned failure set and a set with no rep goal.
function metOf(x) {
  if (x.kind !== 'work' || x.status !== 'done' || !x.done || x.done.reps === null) return null;
  if (x.target.rep_low === null || x.target.effort_only === true || x.target.failure_set === true) return null;
  return x.done.reps >= x.target.rep_low;
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
    // Schema 2 columns (R4-26, 16 B.6.4, 17 C.0.2). A field a row does not hold reads null.
    row.set_type = own(x, 'set_type') ? x.set_type : null;
    row.why = x.why;
    row.goal_load = x.target.load;
    row.goal_reps_low = x.target.rep_low;
    row.goal_reps_high = x.target.rep_high;
    row.goal_failure_set = own(x.target, 'failure_set') ? x.target.failure_set : null;
    row.met = metOf(x);
    row.exercise_id = x.exercise_id;
    row.done_at = day.done_at === null ? null : isoLocal(day.done_at);
    row.short_sleep_since_last = own(day, 'short_sleep_since_last') ? day.short_sleep_since_last : null;
    row.body_weight = own(day, 'body_weight') ? day.body_weight : null;
    row.profile = own(day, 'profile') ? day.profile : null;
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
    const source_id = c.id(f.source_id, 'source_id');
    const version = c.int(1, LIMITS.BLOCK_VERSION_MAX)(f.version, 'version');
    const read = (body, list, schema) => {
      const specs = rowSpecs(c, schema);
      const b = buildRow(specs.blockBody, body, 'block');
      rowRules('blocks', b, 'block', schema);
      const e = c.arr(LIMITS.BLOCK_EXERCISES, (v, w) => { const r = buildRow(specs.exercises, v, w); rowRules('exercises', r, w, schema); return r; })(list, 'exercises');
      return [b, e];
    };
    let [block, exs] = read(f.block, f.exercises, f.schema);
    // An older block file is checked by its own table, lifted with the shared helpers, then checked
    // again by this version's table (16 B.6.4, B.6.2).
    if (f.schema < SCHEMA) [block, exs] = read(liftBlockBody2(block), exs.map(exerciseDefaults2), SCHEMA);
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
    // A level names only a muscle one of the block's own lifts trains (17 C.0.3, r4 review R18):
    // the lift's exercise is a row of the file or a list row the caller passes in opts.seedRows.
    // With no seedRows a list lift trains no known muscle, so a level on it refuses the file.
    const detail = new Map((opts.seedRows || []).map(r => [r.id, r.muscle_detail]));
    for (const e of exs) detail.set(e.id, e.muscle_detail);
    const trained = new Set();
    for (const dt of block.day_templates) for (const l of dt.lifts) if (detail.get(l.exercise_id)) trained.add(detail.get(l.exercise_id));
    for (const k of Object.keys(block.levels)) if (!trained.has(k)) bad('block: a level names a muscle no lift of the block trains');
    return { ok: true, source_id, version, block, exercises: exs };
  } catch (e) {
    if (e instanceof BadFile) return { ok: false, code: e.code, why: e.message };
    return { ok: false, code: 'bad', why: String(e && e.message) };
  }
}
