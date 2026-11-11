// rules.js - the round adjust rule table (TD-2 to TD-7). Data only: no function value
// is exported, nothing is imported, every object is frozen deep at load.
// Signed by health-coach (signed-1). Field names and numbers are the signed ones.
// Comments name a source only as "health-coach verdict item N" or "TD-n".

const SIGNALS_FIXED = {
  pump:      { scale: [1, 4], asked: 'end' },
  soreness:  { scale: [1, 4], asked: 'end' },          // Fixed: every question on the one end sheet (TD-2)
  workload:  { scale: [1, 4], asked: 'end' },
  checks:    { asked: 'each_set' },                    // health-coach verdict item R4-03: after every saved tick, warm-ups included
  scores:    { scale: [0, 10], asked: 'session_end' }, // once per session after the last exercise
  sleep:     { asked: 'day_card' }                     // short_sleep_since_last
};
const SIGNALS_ADAPTIVE = { ...SIGNALS_FIXED, soreness: { scale: [1, 4], asked: 'first_tick' } }; // TD-2

const CAPS = {
  start_max: 1,                    // health-coach verdict item 3
  add_per_pass_max: 1,             // TD-3
  cut_per_pass_max: 1,             // TD-3
  top_sets: 3,                     // TD-3
  min_sets: 1,                     // TD-3, health-coach verdict item 3; the engine never removes an exercise
  no_add_after_short_sleep: true,  // TD-3; a null answer also blocks (an engine rule, not a field)
  short_sleep_hours: 6,            // TD-3; named in the sleep card words
  no_add_if_check_yes: true,       // health-coach verdict item 3
  no_add_if_missed: true           // TD-3: a missed rep goal blocks an add that round, never forces a cut
};

const START_SETS = { default: 1, by_priority: { top: 1, middle: 1, bottom: 1 } }; // TD-5, health-coach verdict item 3

const EFFORT_ADAPTIVE = {
  // TD-4: hard rounds then the easy round, by block length (rounds, the easy one counted).
  // Floor 1; 0 only on the one marked machine set of a session.
  reps_left_by_pass: { 4: [2, 1, 1, 8], 5: [3, 2, 1, 1, 8], 6: [3, 2, 2, 1, 1, 8], 7: [3, 2, 2, 2, 1, 1, 8], 8: [3, 2, 2, 2, 1, 1, 1, 8] },
  length_min: 4,
  length_max: 8,
  failure_reps_left: 0,            // health-coach verdict item 3: the one set his block marks, machine only, one per session, never in the easy round
  short_sleep_failure_reps_left: 2 // health-coach verdict item R4-13: the marked set stops 2 short after a short night
};
const EFFORT_FIXED = { reps_left_by_pass: null, length_min: 1, length_max: 100, failure_reps_left: 0, short_sleep_failure_reps_left: 2 }; // as written; health-coach verdict item R4-13

const LOAD_ADAPTIVE = {
  add_when: 'goal_met',            // TD-6: every work set met its rep goal last round (the marked set left out)
  step_source: 'exercise',         // TD-6: smallest step on the exercise's own list
  default_steps: {                 // TD-6; read last, after the exercise's own steps (health-coach verdict item R4-06)
    lb: { barbell: [5], machine: [5], cable: [5], dumbbell: [5] },  // dumbbell: the load of one dumbbell
    kg: {}
  },
  no_step: 'add_rep',              // no usable step: plus 1 rep, same weight
  rep_floor: 5,
  rep_ceiling: 30,                 // at 30 with no step: weight kept, effort goal only
  on_miss: 'done_plus_one',        // goal = reps done + 1, weight kept, per set
  on_two_misses: 'step_down',      // second miss in a row: load down one step, rep goal back to the planned goal, no add
  retarget_band: { lb: 15, kg: 7, reps_per_step: 1 }, // inside: 1 rep per step, never saved over typed values
  new_sets: 'effort_only',         // a set the engine adds starts with an effort goal only
  round_1: 'effort_only'           // a block the builder makes on this profile (a later slice)
};
const LOAD_FIXED = { ...LOAD_ADAPTIVE, add_when: 'never', on_miss: 'as_written', on_two_misses: 'as_written' }; // load and reps as written

const EASY_ADAPTIVE = {
  auto: true,                      // TD-4: the last round of a block with a length
  set_factor: 2,                   // sets become 2, or sets now if fewer
  load_factor: 0.9,                // nearest step; nearest 1 unit when the list is empty
  reps_factor: 0.67,               // nearest rep
  reps_left: 8,                    // shows as "4 or more" on the chips
  drop: []                         // no muscle dropped
};
const EASY_FIXED = { ...EASY_ADAPTIVE, auto: false };  // no easy round in Fixed (TD-4)

const CARRY = {
  added_set: { today: 'no_carry', rest: 'request_plus_1' }, // TD-7: a 'rest' add is the round's one add and obeys every add gate; never carries against a cut row (health-coach verdict item C13)
  skipped_set: 'keep_effort_only',  // kept in the count, comes back with an effort goal only
  swapped: 'keep_count_clear_targets',
  skipped_day: 'as_done_no_answers' // hold, or cut if a soreness answer said 4
};
const CARRY_FIXED = { ...CARRY, added_set: { today: 'no_carry', rest: 'no_carry' } }; // health-coach verdict item 2

const LIVE_EDITS = {                // TD-7: default scope when none is passed
  add_set: 'today', skip_set: 'today', swap: 'rest', move: 'today',
  remove: 'today', add_exercise: 'rest', relabel: 'rest'
};

// TD-3: first match wins, the last row catches all.
const ROWS_ADAPTIVE = [
  { id: 'R1',  when: { soreness: [4] },                                                   delta: -1, why: 'why.R1' },
  { id: 'R2',  when: { workload: [4] },                                                   delta: -1, why: 'why.R2' },
  { id: 'R3',  when: { workload: [3] },                                                   delta: 0,  why: 'why.R3' },
  { id: 'R4',  when: { pump: [4] },                                                       delta: 0,  why: 'why.R4' },
  { id: 'R5',  when: { soreness: [3] },                                                   delta: 0,  why: 'why.R5' },
  { id: 'R6',  when: { score_max: [5, 6, 7, 8, 9, 10] },                                  delta: 0,  why: 'why.R6' },
  { id: 'R7',  when: { level: ['bottom'] },                                               delta: 0,  why: 'why.R7' },
  { id: 'R8',  when: { level: ['top'], pump: [1, 2], soreness: [1, 2], workload: [1, 2] }, delta: 1,  why: 'why.R8' },
  { id: 'R9',  when: { level: ['top'], pump: [3], soreness: [1, 2], workload: [1] },       delta: 1,  why: 'why.R9' },
  { id: 'R10', when: { level: ['middle'], pump: [1, 2], soreness: [1, 2], workload: [1] }, delta: 1, why: 'why.R10' },
  { id: 'R11', when: {},                                                                  delta: 0,  why: 'why.R11' }
];

const SET_KINDS = [                 // health-coach verdict item R4-12: warm-ups stay kind 'warmup'; no drop-set kind
  { key: 'normal',  counts: 1, miss_check: true },
  { key: 'failure', counts: 1, miss_check: false }
];

const BUILDER = {};                 // a later slice fills this (TD-8, TD-9)

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

export const RULES = deepFreeze({
  rules_version: 'signed-1',
  set_kinds: SET_KINDS,
  profiles: {
    fixed: {
      signals: SIGNALS_FIXED,
      set_rules: { source: 'newest_for_muscle', rows: [{ id: 'F1', when: {}, delta: 0, why: 'why.plan' }] },
      caps: CAPS, start_sets: START_SETS, effort: EFFORT_FIXED, load: LOAD_FIXED,
      easy_week: EASY_FIXED, carry_forward: CARRY_FIXED, live_edits: LIVE_EDITS, builder: BUILDER
    },
    adaptive: {
      signals: SIGNALS_ADAPTIVE,
      set_rules: { source: 'newest_for_muscle', rows: ROWS_ADAPTIVE },
      caps: CAPS, start_sets: START_SETS, effort: EFFORT_ADAPTIVE, load: LOAD_ADAPTIVE,
      easy_week: EASY_ADAPTIVE, carry_forward: CARRY, live_edits: LIVE_EDITS, builder: BUILDER
    }
  }
});

// Every version a block can be frozen on. A block keeps its version for life.
// 'none' is the first freeze; it reads as the Fixed profile, which plans exactly as before.
export const RULES_BY_VERSION = deepFreeze({ 'signed-1': RULES });
export const RULE_VERSIONS = deepFreeze(['none', 'signed-1']);
