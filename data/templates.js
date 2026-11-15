// data/templates.js - our starter programs (DESIGN 17 C.3.4).
// Made by a private tool from the programs our coach signed; do not edit it by hand.
// Data only, no imports. A template id is frozen once shipped (a block stores template_id).
// No set counts and no loads: a block started from a template gets its sets from the rules.

export const TEMPLATES = Object.freeze([
  { id: 't_lower_full_2_day_lower_lean', name: 'Lower and whole body, 2 days, lower lean', days_per_rotation: 2, focus_key: 'lower_lean', equipment: ['barbell', 'cable', 'dumbbell', 'machine'],
    why: 'Suits someone who wants stronger legs and glutes while keeping the upper body trained once a rotation. Leave at least one rest day between the two days.',
    levels: { chest: 'top', back: 'top', shoulders: 'middle', abs_core: 'bottom', quads: 'top', hamstrings: 'top', glutes: 'top', calves: 'bottom' },
    days: [
      { label: 'LOW', slots: [
        { exercise_id: 'barbell_back_squat', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'barbell_romanian_deadlift', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'dumbbell_bulgarian_split_squat', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'seated_leg_curl', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'calf_raise_machine', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'cable_crunch', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'FULL', slots: [
        { exercise_id: 'barbell_hip_thrust', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'leg_extension', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'dumbbell_press', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'lat_pulldown', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'seated_dumbbell_shoulder_press', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'cable_row', rep_low: 10, rep_high: 15, priority: 'bottom' } ] }
    ] },
  { id: 't_upper_full_2_day_upper_lean', name: 'Upper and whole body, 2 days, upper lean', days_per_rotation: 2, focus_key: 'upper_lean', equipment: ['barbell', 'cable', 'dumbbell', 'machine'],
    why: 'Suits someone who wants a bigger chest, back, shoulders and arms while keeping the legs trained once a rotation. Leave at least one rest day between the two days.',
    levels: { chest: 'top', back: 'top', shoulders: 'top', biceps: 'bottom', triceps: 'bottom', quads: 'top', hamstrings: 'top' },
    days: [
      { label: 'UP', slots: [
        { exercise_id: 'incline_dumbbell_press', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'bent_over_barbell_row', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'shoulder_press_machine', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'lat_pulldown', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'cable_fly', rep_low: 12, rep_high: 15, priority: 'middle' },
        { exercise_id: 'ez_bar_curl', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'overhead_cable_extension', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'FULL', slots: [
        { exercise_id: 'leg_press', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'dumbbell_romanian_deadlift', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'chest_press_machine', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'chest_supported_dumbbell_row', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'dumbbell_lateral_raise', rep_low: 12, rep_high: 20, priority: 'middle' },
        { exercise_id: 'dumbbell_hammer_curl', rep_low: 10, rep_high: 15, priority: 'bottom' } ] }
    ] },
  { id: 't_whole_body_2_day_even', name: 'Whole body, 2 days, even', days_per_rotation: 2, focus_key: 'even', equipment: ['barbell', 'cable', 'dumbbell', 'machine'],
    why: 'Suits someone with two gym days a week who wants every main muscle trained in a balanced way. Leave at least one rest day between the two days.',
    levels: { chest: 'top', back: 'top', shoulders: 'top', biceps: 'bottom', triceps: 'bottom', quads: 'top', hamstrings: 'top', calves: 'bottom' },
    days: [
      { label: 'A', slots: [
        { exercise_id: 'barbell_back_squat', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'bench_press', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'cable_row', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'lying_leg_curl', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'dumbbell_lateral_raise', rep_low: 12, rep_high: 20, priority: 'middle' },
        { exercise_id: 'cable_rope_triceps_pushdown', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'B', slots: [
        { exercise_id: 'barbell_romanian_deadlift', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'lat_pulldown', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'seated_dumbbell_shoulder_press', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'leg_press', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'dumbbell_curl', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'calf_raise_machine', rep_low: 10, rep_high: 15, priority: 'bottom' } ] }
    ] },
  { id: 't_lower_upper_lower_3_day_lower_lean', name: 'Lower, upper, lower, 3 days, lower lean', days_per_rotation: 3, focus_key: 'lower_lean', equipment: ['barbell', 'body', 'cable', 'dumbbell', 'machine'],
    why: 'Suits a lifter who wants stronger, bigger legs and glutes while still keeping one full upper day. Rest a day after Lo2 before starting the next round.',
    levels: { chest: 'top', back: 'top', shoulders: 'middle', biceps: 'bottom', triceps: 'bottom', abs_core: 'bottom', quads: 'top', hamstrings: 'top', glutes: 'top', calves: 'middle' },
    days: [
      { label: 'Lo1', slots: [
        { exercise_id: 'barbell_back_squat', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'leg_extension', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'seated_leg_curl', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'calf_raise_machine', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'dumbbell_lateral_raise', rep_low: 12, rep_high: 20, priority: 'bottom' },
        { exercise_id: 'plank', rep_low: 30, rep_high: 60, priority: 'bottom' } ] },
      { label: 'Up', slots: [
        { exercise_id: 'bench_press', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'lat_pulldown', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'seated_dumbbell_shoulder_press', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'cable_row', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'dumbbell_hammer_curl', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'cable_rope_triceps_pushdown', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'Lo2', slots: [
        { exercise_id: 'barbell_romanian_deadlift', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'barbell_hip_thrust', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'dumbbell_bulgarian_split_squat', rep_low: 8, rep_high: 12, priority: 'bottom' },
        { exercise_id: 'lying_leg_curl', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'seated_machine_calf_raise', rep_low: 12, rep_high: 20, priority: 'bottom' },
        { exercise_id: 'cable_crunch', rep_low: 10, rep_high: 15, priority: 'bottom' } ] }
    ] },
  { id: 't_push_legs_pull_3_day_upper_lean', name: 'Push, legs and pull, 3 days, upper lean', days_per_rotation: 3, focus_key: 'upper_lean', equipment: ['barbell', 'body', 'cable', 'dumbbell', 'machine'],
    why: 'Suits a lifter who wants a bigger chest, back, shoulders and arms and is happy with one leg day per rotation.',
    levels: { chest: 'top', back: 'top', shoulders: 'middle', biceps: 'middle', triceps: 'middle', abs_core: 'bottom', quads: 'top', hamstrings: 'middle', calves: 'bottom' },
    days: [
      { label: 'Push', slots: [
        { exercise_id: 'bench_press', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'seated_dumbbell_shoulder_press', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'cable_fly', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'dumbbell_lateral_raise', rep_low: 12, rep_high: 20, priority: 'middle' },
        { exercise_id: 'overhead_cable_extension', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'one_arm_dumbbell_row', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'Legs', slots: [
        { exercise_id: 'leg_press', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'dumbbell_romanian_deadlift', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'seated_leg_curl', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'calf_raise_machine', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'single_arm_cable_lateral_raise', rep_low: 12, rep_high: 20, priority: 'bottom' },
        { exercise_id: 'dumbbell_hammer_curl', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'Pull', slots: [
        { exercise_id: 'pull_up', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'chest_supported_t_bar_row', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'cable_reverse_fly', rep_low: 12, rep_high: 20, priority: 'middle' },
        { exercise_id: 'ez_bar_curl', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'incline_press_machine', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'cable_crunch', rep_low: 10, rep_high: 15, priority: 'bottom' } ] }
    ] },
  { id: 't_whole_body_3_day_even', name: 'Whole body, 3 days, even', days_per_rotation: 3, focus_key: 'even', equipment: ['barbell', 'body', 'cable', 'dumbbell', 'machine'],
    why: 'Suits most lifters, new or returning, who want every muscle trained each day with the hard work moved around. Best on three days a week with a rest day after each session.',
    levels: { chest: 'top', back: 'top', shoulders: 'middle', biceps: 'bottom', triceps: 'bottom', abs_core: 'bottom', quads: 'top', hamstrings: 'top', glutes: 'top', calves: 'bottom' },
    days: [
      { label: 'A', slots: [
        { exercise_id: 'barbell_back_squat', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'bench_press', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'cable_row', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'dumbbell_lateral_raise', rep_low: 12, rep_high: 20, priority: 'bottom' },
        { exercise_id: 'lying_leg_curl', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'cable_rope_triceps_pushdown', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'B', slots: [
        { exercise_id: 'barbell_romanian_deadlift', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'lat_pulldown', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'seated_dumbbell_shoulder_press', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'leg_extension', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'dumbbell_curl', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'calf_raise_machine', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'C', slots: [
        { exercise_id: 'barbell_hip_thrust', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'incline_press_machine', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'chest_supported_dumbbell_row', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'dumbbell_bulgarian_split_squat', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'face_pull', rep_low: 12, rep_high: 20, priority: 'bottom' },
        { exercise_id: 'plank', rep_low: 30, rep_high: 60, priority: 'bottom' } ] }
    ] },
  { id: 't_lower_upper_4_day_lower_lean', name: 'Lower and upper, 4 days, lower lean', days_per_rotation: 4, focus_key: 'lower_lean', equipment: ['barbell', 'body', 'cable', 'dumbbell', 'machine'],
    why: 'Suits someone who wants bigger, stronger legs and glutes while keeping the upper body ticking over.',
    levels: { chest: 'top', back: 'top', shoulders: 'middle', biceps: 'bottom', triceps: 'bottom', abs_core: 'bottom', quads: 'top', hamstrings: 'top', glutes: 'top', calves: 'middle' },
    days: [
      { label: 'QUAD', slots: [
        { exercise_id: 'barbell_back_squat', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'dumbbell_bulgarian_split_squat', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'leg_press', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'leg_extension', rep_low: 12, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'calf_raise_machine', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'hanging_knee_raise', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'UPGL', slots: [
        { exercise_id: 'bench_press', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'chest_supported_dumbbell_row', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'seated_dumbbell_shoulder_press', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'cable_hip_abduction', rep_low: 12, rep_high: 20, priority: 'bottom' },
        { exercise_id: 'cable_rope_triceps_pushdown', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'dumbbell_hammer_curl', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'HAM', slots: [
        { exercise_id: 'barbell_romanian_deadlift', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'barbell_hip_thrust', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'lying_leg_curl', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'walking_lunge', rep_low: 10, rep_high: 14, priority: 'middle' },
        { exercise_id: 'seated_machine_calf_raise', rep_low: 12, rep_high: 20, priority: 'middle' },
        { exercise_id: 'cable_crunch', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'UPG2', slots: [
        { exercise_id: 'lat_pulldown', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'incline_dumbbell_press', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'cable_row', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'dumbbell_lateral_raise', rep_low: 12, rep_high: 20, priority: 'middle' },
        { exercise_id: 'cable_glute_kickback', rep_low: 12, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'dumbbell_curl', rep_low: 10, rep_high: 15, priority: 'bottom' } ] }
    ] },
  { id: 't_upper_lower_4_day_even', name: 'Upper and lower, 4 days, even', days_per_rotation: 4, focus_key: 'even', equipment: ['barbell', 'body', 'cable', 'dumbbell', 'machine'],
    why: 'Suits most lifters who want every muscle worked twice per rotation with steady progress.',
    levels: { chest: 'top', back: 'top', shoulders: 'middle', biceps: 'bottom', triceps: 'bottom', abs_core: 'bottom', quads: 'top', hamstrings: 'top', glutes: 'top', calves: 'middle' },
    days: [
      { label: 'UA', slots: [
        { exercise_id: 'bench_press', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'bent_over_barbell_row', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'seated_dumbbell_shoulder_press', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'lat_pulldown', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'ez_bar_curl', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'cable_rope_triceps_pushdown', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'LA', slots: [
        { exercise_id: 'barbell_back_squat', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'barbell_romanian_deadlift', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'leg_press', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'seated_leg_curl', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'calf_raise_machine', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'reverse_crunch', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'UB', slots: [
        { exercise_id: 'incline_dumbbell_press', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'pull_up', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'cable_row', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'dumbbell_lateral_raise', rep_low: 12, rep_high: 20, priority: 'middle' },
        { exercise_id: 'cable_fly', rep_low: 12, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'dumbbell_hammer_curl', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'overhead_cable_extension', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'LB', slots: [
        { exercise_id: 'hack_squat', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'barbell_hip_thrust', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'lying_leg_curl', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'walking_lunge', rep_low: 10, rep_high: 14, priority: 'middle' },
        { exercise_id: 'seated_machine_calf_raise', rep_low: 12, rep_high: 20, priority: 'middle' },
        { exercise_id: 'cable_crunch', rep_low: 10, rep_high: 15, priority: 'bottom' } ] }
    ] },
  { id: 't_upper_legs_arms_4_day_upper_lean', name: 'Upper, legs and arms, 4 days, upper lean', days_per_rotation: 4, focus_key: 'upper_lean', equipment: ['barbell', 'body', 'cable', 'dumbbell', 'machine'],
    why: 'Suits someone whose chest, back, shoulders and arms lag and who is fine with one leg day per rotation.',
    levels: { chest: 'top', back: 'top', traps_neck: 'bottom', shoulders: 'top', biceps: 'middle', triceps: 'middle', abs_core: 'bottom', quads: 'top', hamstrings: 'top', calves: 'middle' },
    days: [
      { label: 'UPA', slots: [
        { exercise_id: 'incline_barbell_bench_press', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'bent_over_barbell_row', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'dumbbell_press', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'lat_pulldown', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'cable_fly', rep_low: 12, rep_high: 15, priority: 'bottom' } ] },
      { label: 'LEG', slots: [
        { exercise_id: 'barbell_back_squat', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'barbell_romanian_deadlift', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'leg_press', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'seated_leg_curl', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'calf_raise_machine', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'hanging_knee_raise', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'UPB', slots: [
        { exercise_id: 'bench_press', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'pull_up', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'cable_row', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'pec_fly_machine', rep_low: 12, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'dumbbell_shrug', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'ARMS', slots: [
        { exercise_id: 'seated_dumbbell_shoulder_press', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'dumbbell_lateral_raise', rep_low: 12, rep_high: 20, priority: 'middle' },
        { exercise_id: 'ez_bar_curl', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'cable_rope_triceps_pushdown', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'overhead_cable_extension', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'face_pull', rep_low: 12, rep_high: 20, priority: 'bottom' },
        { exercise_id: 'cable_crunch', rep_low: 10, rep_high: 15, priority: 'bottom' } ] }
    ] },
  { id: 't_lower_upper_5_day_lower_lean', name: 'Lower and upper, 5 days, lower lean', days_per_rotation: 5, focus_key: 'lower_lean', equipment: ['barbell', 'body', 'cable', 'dumbbell', 'machine'],
    why: 'Suits a lifter who wants stronger, bigger legs and glutes with two shorter upper days to keep the top half growing. Rest a day after GLUT before starting the next round.',
    levels: { chest: 'top', back: 'top', shoulders: 'middle', biceps: 'bottom', triceps: 'bottom', abs_core: 'bottom', quads: 'top', hamstrings: 'top', glutes: 'top', calves: 'middle' },
    days: [
      { label: 'QUAD', slots: [
        { exercise_id: 'barbell_back_squat', rep_low: 5, rep_high: 8, priority: 'top' },
        { exercise_id: 'leg_press', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'leg_extension', rep_low: 12, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'calf_raise_machine', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'hanging_leg_raise', rep_low: 8, rep_high: 15, priority: 'bottom' } ] },
      { label: 'UP1', slots: [
        { exercise_id: 'bench_press', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'bent_over_barbell_row', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'seated_dumbbell_shoulder_press', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'lat_pulldown', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'dumbbell_curl', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'cable_rope_triceps_pushdown', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'HIP', slots: [
        { exercise_id: 'barbell_romanian_deadlift', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'dumbbell_bulgarian_split_squat', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'dumbbell_hip_thrust', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'seated_leg_curl', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'seated_machine_calf_raise', rep_low: 12, rep_high: 20, priority: 'bottom' },
        { exercise_id: 'cable_crunch', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'UP2', slots: [
        { exercise_id: 'incline_dumbbell_press', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'pull_up', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'cable_row', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'dumbbell_lateral_raise', rep_low: 12, rep_high: 20, priority: 'bottom' },
        { exercise_id: 'overhead_cable_extension', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'dumbbell_hammer_curl', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'GLUT', slots: [
        { exercise_id: 'barbell_hip_thrust', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'lying_leg_curl', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'deficit_dumbbell_reverse_lunge', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'cable_pull_through', rep_low: 12, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'hip_abduction', rep_low: 12, rep_high: 20, priority: 'bottom' },
        { exercise_id: 'plank', rep_low: 30, rep_high: 60, priority: 'bottom' } ] }
    ] },
  { id: 't_upper_legs_5_day_upper_lean', name: 'Upper and legs, 5 days, upper lean', days_per_rotation: 5, focus_key: 'upper_lean', equipment: ['barbell', 'body', 'cable', 'dumbbell', 'machine'],
    why: 'Suits a lifter who wants a bigger chest, back, shoulders and arms while keeping two solid leg days.',
    levels: { chest: 'top', back: 'top', shoulders: 'top', biceps: 'middle', triceps: 'middle', abs_core: 'bottom', quads: 'top', hamstrings: 'middle', glutes: 'top', calves: 'bottom' },
    days: [
      { label: 'CB', slots: [
        { exercise_id: 'bench_press', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'pull_up', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'incline_dumbbell_press', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'cable_row', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'cable_fly', rep_low: 12, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'cable_straight_arm_pulldown', rep_low: 12, rep_high: 15, priority: 'bottom' } ] },
      { label: 'LEGA', slots: [
        { exercise_id: 'barbell_back_squat', rep_low: 5, rep_high: 8, priority: 'top' },
        { exercise_id: 'barbell_romanian_deadlift', rep_low: 6, rep_high: 10, priority: 'middle' },
        { exercise_id: 'leg_extension', rep_low: 12, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'seated_leg_curl', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'calf_raise_machine', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'SA', slots: [
        { exercise_id: 'standing_barbell_overhead_press', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'dumbbell_lateral_raise', rep_low: 12, rep_high: 20, priority: 'middle' },
        { exercise_id: 'reverse_fly_machine', rep_low: 12, rep_high: 20, priority: 'bottom' },
        { exercise_id: 'ez_bar_curl', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'ez_bar_skull_crusher', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'incline_dumbbell_curl', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'cable_rope_triceps_pushdown', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'UP', slots: [
        { exercise_id: 'incline_barbell_bench_press', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'chest_supported_t_bar_row', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'lat_pulldown', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'pec_fly_machine', rep_low: 12, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'face_pull', rep_low: 12, rep_high: 20, priority: 'bottom' } ] },
      { label: 'LEGB', slots: [
        { exercise_id: 'leg_press', rep_low: 10, rep_high: 15, priority: 'top' },
        { exercise_id: 'barbell_hip_thrust', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'lying_leg_curl', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'dumbbell_bulgarian_split_squat', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'seated_machine_calf_raise', rep_low: 12, rep_high: 20, priority: 'bottom' },
        { exercise_id: 'cable_crunch', rep_low: 10, rep_high: 15, priority: 'bottom' } ] }
    ] },
  { id: 't_upper_lower_push_pull_legs_5_day_even', name: 'Upper, lower, push, pull and legs, 5 days, even', days_per_rotation: 5, focus_key: 'even', equipment: ['barbell', 'body', 'cable', 'dumbbell', 'machine'],
    why: 'Suits a lifter who wants every muscle trained about twice per rotation with an even share of upper and lower work.',
    levels: { chest: 'top', back: 'top', traps_neck: 'bottom', shoulders: 'middle', biceps: 'middle', triceps: 'middle', abs_core: 'bottom', quads: 'top', hamstrings: 'top', glutes: 'top', calves: 'middle' },
    days: [
      { label: 'UP', slots: [
        { exercise_id: 'bench_press', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'bent_over_barbell_row', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'seated_dumbbell_shoulder_press', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'lat_pulldown', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'ez_bar_curl', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'cable_rope_triceps_pushdown', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'LOW', slots: [
        { exercise_id: 'barbell_back_squat', rep_low: 5, rep_high: 8, priority: 'top' },
        { exercise_id: 'barbell_romanian_deadlift', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'leg_press', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'seated_leg_curl', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'calf_raise_machine', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'hanging_knee_raise', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'PUSH', slots: [
        { exercise_id: 'incline_dumbbell_press', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'shoulder_press_machine', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'cable_fly', rep_low: 12, rep_high: 15, priority: 'middle' },
        { exercise_id: 'dumbbell_lateral_raise', rep_low: 12, rep_high: 20, priority: 'bottom' },
        { exercise_id: 'overhead_cable_extension', rep_low: 10, rep_high: 15, priority: 'middle' } ] },
      { label: 'PULL', slots: [
        { exercise_id: 'pull_up', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'chest_supported_dumbbell_row', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'face_pull', rep_low: 12, rep_high: 20, priority: 'bottom' },
        { exercise_id: 'incline_dumbbell_curl', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'dumbbell_hammer_curl', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'dumbbell_shrug', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'LEGS', slots: [
        { exercise_id: 'hack_squat', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'barbell_hip_thrust', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'lying_leg_curl', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'walking_lunge', rep_low: 10, rep_high: 12, priority: 'middle' },
        { exercise_id: 'seated_machine_calf_raise', rep_low: 12, rep_high: 20, priority: 'bottom' },
        { exercise_id: 'cable_crunch', rep_low: 10, rep_high: 15, priority: 'bottom' } ] }
    ] },
  { id: 't_lower_upper_6_day_lower_lean', name: 'Lower and upper, 6 days, lower lean', days_per_rotation: 6, focus_key: 'lower_lean', equipment: ['barbell', 'body', 'cable', 'dumbbell', 'machine'],
    why: 'Suits someone who wants stronger legs and glutes, with three lower days and three shorter upper days.',
    levels: { chest: 'top', back: 'top', shoulders: 'middle', biceps: 'bottom', triceps: 'bottom', abs_core: 'bottom', quads: 'top', hamstrings: 'top', glutes: 'top', calves: 'bottom' },
    days: [
      { label: 'Quad', slots: [
        { exercise_id: 'barbell_back_squat', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'leg_press', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'walking_lunge', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'leg_extension', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'calf_raise_machine', rep_low: 12, rep_high: 20, priority: 'bottom' } ] },
      { label: 'UpA', slots: [
        { exercise_id: 'bench_press', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'seated_dumbbell_shoulder_press', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'dumbbell_lateral_raise', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'cable_rope_triceps_pushdown', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'hanging_knee_raise', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'Hip', slots: [
        { exercise_id: 'barbell_romanian_deadlift', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'barbell_hip_thrust', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'seated_leg_curl', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'glute_focused_back_extension', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'hip_abduction', rep_low: 12, rep_high: 20, priority: 'bottom' },
        { exercise_id: 'seated_machine_calf_raise', rep_low: 12, rep_high: 20, priority: 'bottom' } ] },
      { label: 'UpB', slots: [
        { exercise_id: 'lat_pulldown', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'chest_supported_dumbbell_row', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'face_pull', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'ez_bar_curl', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'cable_crunch', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'LegC', slots: [
        { exercise_id: 'hack_squat', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'dumbbell_bulgarian_split_squat', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'dumbbell_hip_thrust', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'lying_leg_curl', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'cable_glute_kickback', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'leg_press_calf_raise', rep_low: 12, rep_high: 20, priority: 'bottom' } ] },
      { label: 'UpC', slots: [
        { exercise_id: 'incline_dumbbell_press', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'cable_row', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'lateral_raise_machine', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'dumbbell_hammer_curl', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'dumbbell_overhead_triceps_extension', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'dead_bug', rep_low: 10, rep_high: 15, priority: 'bottom' } ] }
    ] },
  { id: 't_push_pull_legs_6_day_even', name: 'Push, pull and legs, 6 days, even', days_per_rotation: 6, focus_key: 'even', equipment: ['barbell', 'body', 'cable', 'dumbbell', 'machine'],
    why: 'Suits someone who wants every muscle trained twice per rotation with an even share of upper and lower work.',
    levels: { chest: 'top', back: 'top', traps_neck: 'bottom', shoulders: 'top', biceps: 'bottom', triceps: 'bottom', abs_core: 'bottom', quads: 'top', hamstrings: 'top', glutes: 'top', calves: 'bottom' },
    days: [
      { label: 'PshA', slots: [
        { exercise_id: 'bench_press', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'seated_dumbbell_shoulder_press', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'incline_dumbbell_press', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'dumbbell_lateral_raise', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'cable_rope_triceps_pushdown', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'dumbbell_overhead_triceps_extension', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'PulA', slots: [
        { exercise_id: 'bent_over_barbell_row', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'lat_pulldown', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'cable_row', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'face_pull', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'ez_bar_curl', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'dumbbell_shrug', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'LegA', slots: [
        { exercise_id: 'barbell_back_squat', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'barbell_romanian_deadlift', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'leg_press', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'seated_leg_curl', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'calf_raise_machine', rep_low: 12, rep_high: 20, priority: 'bottom' },
        { exercise_id: 'hanging_knee_raise', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'PshB', slots: [
        { exercise_id: 'standing_barbell_overhead_press', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'dumbbell_press', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'cable_fly', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'lateral_raise_machine', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'ez_bar_skull_crusher', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'PulB', slots: [
        { exercise_id: 'pull_up', rep_low: 6, rep_high: 10, priority: 'top' },
        { exercise_id: 'chest_supported_dumbbell_row', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'single_arm_lat_pulldown', rep_low: 8, rep_high: 12, priority: 'middle' },
        { exercise_id: 'bent_over_dumbbell_reverse_fly', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'dumbbell_hammer_curl', rep_low: 10, rep_high: 15, priority: 'bottom' },
        { exercise_id: 'incline_dumbbell_curl', rep_low: 10, rep_high: 15, priority: 'bottom' } ] },
      { label: 'LegB', slots: [
        { exercise_id: 'dumbbell_bulgarian_split_squat', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'barbell_hip_thrust', rep_low: 8, rep_high: 12, priority: 'top' },
        { exercise_id: 'leg_extension', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'lying_leg_curl', rep_low: 10, rep_high: 15, priority: 'middle' },
        { exercise_id: 'seated_machine_calf_raise', rep_low: 12, rep_high: 20, priority: 'bottom' },
        { exercise_id: 'cable_crunch', rep_low: 10, rep_high: 15, priority: 'bottom' } ] }
    ] }
]);

export const TEMPLATE_IDS = Object.freeze(TEMPLATES.map(t => t.id));
// Words for the focus keys, shown as data (like the exercise names).
export const FOCUS_NAMES = Object.freeze({ even: 'Even whole body', lower_lean: 'More legs and glutes', upper_lean: 'More upper body' });
