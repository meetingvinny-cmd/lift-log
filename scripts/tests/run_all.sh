#!/bin/zsh
# run_all.sh <slice0|slice1|live|twoapp|sim> [--url URL]
# Runs one suite, writes its output to $LIFTLOG_LOG_DIR/<date>_<suite>.log, exits non-zero on any fail.
# Needs LIFTLOG_PRIVATE_DIR (the folder that holds the four word lists, kept outside the repo).
# slice0, slice1 and twoapp also need LIFTLOG_AT_DIR (the other app's folder); without it the twoapp step fails by name. Every node and python run uses TZ=America/New_York.
set -u
export TZ=America/New_York
# The e2e run writes one made-up sample backup here for the health coach (never into app/).
export LIFTLOG_SAMPLE_OUT="${LIFTLOG_SAMPLE_OUT:-${LIFTLOG_PRIVATE_DIR:-/nonexistent}/samples/sample_backup_for_health_coach.json}"
SUITE="${1:-}"; shift || true
URL=""
if [[ "${1:-}" == "--url" ]]; then URL="${2:-}"; fi
HERE="${0:A:h}"
APP="${HERE:h:h}"
LOG_DIR="${LIFTLOG_LOG_DIR:-$APP/test-output}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$(date +%Y-%m-%d)_${SUITE:-none}.log"
cd "$APP" || exit 2

print -- "run_all $SUITE at $(date '+%Y-%m-%d %H:%M:%S %Z')" | tee "$LOG"
# HN1: name the commit and the dirty count, so a green line is tied to the code it ran on.
print -- "commit $(git -C "$APP" rev-parse --short HEAD) dirty $(git -C "$APP" status --porcelain | wc -l | tr -d ' ')" | tee -a "$LOG"

# Mac load rule (DESIGN 4.6): nothing heavy between 1:00 and 6:00 AM. Only live may run then.
HOUR=$(date +%H)
if [[ "$SUITE" != "live" ]] && (( 10#$HOUR >= 1 && 10#$HOUR < 6 )); then
  print -- "Mac quiet hours (1:00 to 6:00 AM). Not run." | tee -a "$LOG"; exit 3
fi
# Headless browsers already running before this run (other tools may own some).
BROWSERS_BEFORE=" $(pgrep -f 'chrome-headless-shell|Chromium.*--headless' | tr '\n' ' ') "

# The copy base (mutant, update-build and served copies) must never sit inside app/.
if [[ -n "${LIFTLOG_LOG_DIR:-}" ]]; then
  mkdir -p "$LIFTLOG_LOG_DIR/tmp"
  BASE_REAL="$(cd "$LIFTLOG_LOG_DIR/tmp" && pwd -P)"
  APP_REAL="$(cd "$APP" && pwd -P)"
  if [[ "$BASE_REAL" == "$APP_REAL" || "$BASE_REAL" == "$APP_REAL"/* ]]; then
    print -- "FAIL copy base sits inside app/" | tee -a "$LOG"; exit 2
  fi
fi

# The guard hooks must be installed (they are not tracked).
for h in commit-msg pre-push; do
  if [[ ! -x "$APP/.git/hooks/$h" ]]; then
    print -- "FAIL git hook $h missing: run node scripts/tests/repo_guard.js --install-hooks" | tee -a "$LOG"; exit 2
  fi
done

FAILS=0
step() {
  local name="$1"; shift
  print -- "== $name" | tee -a "$LOG"
  "$@" 2>&1 | tee -a "$LOG"
  local rc=${pipestatus[1]}
  if (( rc != 0 )); then FAILS=$((FAILS + 1)); print -- "== $name: FAIL (exit $rc)" | tee -a "$LOG"
  else print -- "== $name: PASS" | tee -a "$LOG"; fi
}

case "$SUITE" in
  slice0)
    step "static" node --test scripts/tests/unit/static.test.js
    step "repo_guard" node scripts/tests/repo_guard.js
    step "repo_guard self-test" node scripts/tests/repo_guard.js --self-test
    step "e2e slice0" python3 scripts/tests/e2e.py --suite slice0 --viewport both
    step "e2e update" python3 scripts/tests/e2e.py --suite update
    step "e2e twoapp" python3 scripts/tests/e2e.py --suite twoapp
    step "origin check self-test" python3 scripts/tests/origin_check.py --self-test
    step "mutants" node scripts/tests/mutants.js
    ;;
  live)
    [[ -z "$URL" ]] && { print "live needs --url"; exit 2; }
    step "live_check" python3 scripts/tests/live_check.py --url "$URL"
    step "e2e slice0 live" python3 scripts/tests/e2e.py --suite slice0 --url "$URL"
    # Item (10): the origin root, Lift Log and each sibling (LIFTLOG_SIBLINGS, space separated
    # paths). LIFTLOG_PATH2 names the siblings that take path 2 of 4.7 row 10 (their manual line).
    sib=(); for x in ${=LIFTLOG_SIBLINGS:-}; do sib+=(--sibling "$x"); done
    p2=(); for x in ${=LIFTLOG_PATH2:-}; do p2+=(--path2 "$x"); done
    step "origin check (10)" python3 scripts/tests/origin_check.py --url "$URL" "${sib[@]}" "${p2[@]}"
    ;;
  twoapp)
    step "e2e twoapp" python3 scripts/tests/e2e.py --suite twoapp
    ;;
  sim)
    step "sim pass" zsh scripts/tests/sim_pass.sh
    ;;
  slice1)
    step "static" node --test scripts/tests/unit/static.test.js
    step "unit backup" node --test scripts/tests/unit/backup.test.js
    step "unit migrate" node --test scripts/tests/unit/migrate.test.js
    step "unit store" node --test scripts/tests/unit/store.test.js
    step "check_backup fixture" node scripts/tests/check_backup.mjs scripts/tests/fixtures/backup_v1.json
    step "check_backup block fixture" node scripts/tests/check_backup.mjs scripts/tests/fixtures/block_v1.json --block
    step "repo_guard" node scripts/tests/repo_guard.js
    step "repo_guard self-test" node scripts/tests/repo_guard.js --self-test
    step "e2e slice0" python3 scripts/tests/e2e.py --suite slice0 --viewport both
    step "e2e slice1" python3 scripts/tests/e2e.py --suite slice1 --viewport both
    step "e2e update" python3 scripts/tests/e2e.py --suite update
    step "e2e twoapp" python3 scripts/tests/e2e.py --suite twoapp
    step "origin check self-test" python3 scripts/tests/origin_check.py --self-test
    step "mutants" node scripts/tests/mutants.js
    ;;
  *) print "usage: run_all.sh <slice0|slice1|live|twoapp|sim> [--url URL]"; exit 2 ;;
esac
# Mac load rule: no test server or headless browser started by this run is left running.
LEFT=""
for pid in $(pgrep -f 'chrome-headless-shell|Chromium.*--headless'); do
  [[ "$BROWSERS_BEFORE" == *" $pid "* ]] || LEFT="$LEFT $pid"
done
for pid in $(pgrep -f 'scripts/tests/e2e.py|http.server .*sim-serve'); do LEFT="$LEFT $pid"; done
if [[ -n "$LEFT" ]]; then
  print -- "FAIL left running after the run:$LEFT" | tee -a "$LOG"; FAILS=$((FAILS + 1))
else
  print -- "== cleanup: PASS no test server or headless browser left running" | tee -a "$LOG"
fi
print -- "run_all $SUITE: $FAILS failing step(s). Log: ${LOG:t}" | tee -a "$LOG"
(( FAILS == 0 ))
