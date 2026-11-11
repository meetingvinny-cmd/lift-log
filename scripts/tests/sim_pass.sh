#!/bin/zsh
# sim_pass.sh - iPhone simulator pass on screens reachable by address (Install, Phone check in a tab).
# simctl cannot tap, so data screens are proven in Chromium and on the phone.
# The app is served from a temp parent folder at /lift-log/ on a free port.
# Screenshots go to $LIFTLOG_LOG_DIR/sim/ and never into the repo.
set -u
# Mac load rule (DESIGN 4.6): quiet hours, and never a second simulator.
HOUR=$(date +%H)
if (( 10#$HOUR >= 1 && 10#$HOUR < 6 )); then print "Mac quiet hours (1:00 to 6:00 AM). Not run."; exit 3; fi
if xcrun simctl list devices booted | grep -q "(Booted)"; then
  print "FAIL another simulator is already booted; this pass never boots a second one"; exit 2
fi
DEVICE="${LIFTLOG_SIM_DEVICE:-iPhone 18 Pro Max}"
RUNTIME="${LIFTLOG_SIM_RUNTIME:-iOS 27.2}"
HERE="${0:A:h}"; APP="${HERE:h:h}"
# HN1: name the commit and the dirty count, so a green line is tied to the code it ran on.
print "commit $(git -C "$APP" rev-parse --short HEAD) dirty $(git -C "$APP" status --porcelain | wc -l | tr -d ' ')"
OUT="${LIFTLOG_LOG_DIR:-$APP/test-output}/sim"
mkdir -p "$OUT"
if [[ -n "${LIFTLOG_LOG_DIR:-}" ]]; then BASE="$LIFTLOG_LOG_DIR/tmp"; mkdir -p "$BASE"; else BASE="$(mktemp -d -t liftlog)"; fi
PARENT="$BASE/sim-serve"
rm -rf "$PARENT"; mkdir -p "$PARENT/lift-log"
( cd "$APP" && git ls-files --cached --others --exclude-standard | grep -v '^scripts/' | while read -r f; do
    [[ -f "$f" ]] && mkdir -p "$PARENT/lift-log/${f:h}" && cp "$f" "$PARENT/lift-log/$f"; done )
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
# The device on the named runtime only (C19): the section header names the runtime.
UDID=$(xcrun simctl list devices available | awk -v rt="-- $RUNTIME --" -v dev="    $DEVICE (" '
  /^-- / { on = ($0 == rt) } on && index($0, dev) == 1 { print; exit }' | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')
[[ -z "$UDID" ]] && { print "FAIL no simulator named $DEVICE on $RUNTIME"; exit 2; }
print "sim pass: $DEVICE on $RUNTIME ($UDID)"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$PARENT" >/dev/null 2>&1 &
SRV=$!
cleanup() {
  local rc=$?
  kill $SRV 2>/dev/null
  xcrun simctl shutdown "$UDID" 2>/dev/null
  # A simulator left booted fails the run, not only the line (C19).
  if xcrun simctl list devices booted | grep -q "(Booted)"; then print "FAIL a simulator is still booted"; rc=1
  else print "sim pass: no simulator left booted"; fi
  exit $rc
}
trap cleanup EXIT INT TERM
xcrun simctl boot "$UDID" || { print "FAIL boot"; exit 2; }
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1
ROOT="http://127.0.0.1:$PORT/lift-log/"
FAILS=0
# A blank screen is the size floor: a shot within 5 percent of the size of an empty page on the same
# screen is a blank or near blank page, and fails (C19). A person still looks at every shot.
BLANK=0
grab() {
  local name="$1"
  if ! xcrun simctl io "$UDID" screenshot "$OUT/$name" >/dev/null 2>&1; then print "FAIL screenshot $name"; FAILS=$((FAILS+1)); return; fi
  local size=$(stat -f%z "$OUT/$name")
  if (( BLANK > 0 && size * 100 <= BLANK * 105 )); then print "FAIL screenshot $name is blank ($size bytes, blank frame $BLANK)"; FAILS=$((FAILS+1)); return; fi
  print "PASS screenshot $name ($size bytes)"
}
shot() {
  local url="$1" name="$2"
  xcrun simctl openurl "$UDID" "$url" || { print "FAIL openurl $url"; FAILS=$((FAILS+1)); return; }
  sleep 6
  grab "$name"
}
# The blank frame: a page with no content on this same screen, the size floor for every shot.
mkdir -p "$PARENT/blank"; print '<!doctype html><title>x</title><body></body>' > "$PARENT/blank/index.html"
xcrun simctl openurl "$UDID" "http://127.0.0.1:$PORT/blank/" >/dev/null 2>&1; sleep 12
xcrun simctl io "$UDID" screenshot "$OUT/sim_blank.png" >/dev/null 2>&1 && BLANK=$(stat -f%z "$OUT/sim_blank.png")
print "sim pass: blank frame $BLANK bytes"
# Warm-up: a cold Safari needs time on its first page load.
xcrun simctl openurl "$UDID" "$ROOT" >/dev/null 2>&1; sleep 12
shot "$ROOT" "sim_install.png"
shot "$ROOT#/check" "sim_check_tab.png"
sleep 12
grab "sim_check_tab_done.png"
# The version the simulator got: the Phone check footer line names it.
shot "$ROOT#/today" "sim_today_tab.png"
print "sim pass: $FAILS fail(s); screenshots in sim/ of the log folder (each one still needs a look by eye)"
(( FAILS == 0 ))
