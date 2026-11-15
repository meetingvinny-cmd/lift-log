// fixtures/templates_sample.js - two made-up generic programs for the unit tests only (17 C.3.4,
// PROGRAMS item 1). Built from seed ids, ours by design; never shipped, never read by the app.
// Same shape as data/templates.js.

export const TEMPLATES = Object.freeze([
  { id: 't_sample_two_day', name: 'Sample two day', days_per_rotation: 2, focus_key: 'even', equipment: ['cable', 'machine'],
    why: 'A made-up plan for the tests.',
    levels: { chest: 'top', back: 'middle', quads: 'top', hamstrings: 'bottom' },
    days: [
      { label: 'A', slots: [
        { exercise_id: 'chest_press_machine', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'lat_pulldown', rep_low: 8, rep_high: 12, priority: 'middle' } ] },
      { label: 'B', slots: [
        { exercise_id: 'leg_press', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'seated_leg_curl', rep_low: 10, rep_high: 15, priority: 'bottom' } ] }
    ] },
  { id: 't_sample_three_day', name: 'Sample three day', days_per_rotation: 3, focus_key: 'even', equipment: ['body', 'cable', 'dumbbell', 'machine'],
    why: 'Another made-up plan for the tests.',
    levels: { chest: 'middle', back: 'top', shoulders: 'middle', biceps: 'bottom', abs_core: 'bottom' },
    days: [
      { label: 'A', slots: [
        { exercise_id: 'dumbbell_press', rep_low: 6, rep_high: 10, priority: 'middle' },
        { exercise_id: 'seated_row_machine', rep_low: 8, rep_high: 12, priority: 'top' } ] },
      { label: 'B', slots: [
        { exercise_id: 'shoulder_press_machine', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'cable_curl', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'C', slots: [
        { exercise_id: 'cable_row', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'plank', rep_low: 20, rep_high: 60, priority: 'bottom' } ] }
    ] }
]);

export const TEMPLATE_IDS = Object.freeze(TEMPLATES.map(t => t.id));
export const FOCUS_NAMES = Object.freeze({ even: 'Even whole body' });
