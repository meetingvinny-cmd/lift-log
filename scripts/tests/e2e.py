#!/usr/bin/env python3
"""Headless end to end checks for Lift Log, in a private headless Chromium (DESIGN 4.6).

    python3 scripts/tests/e2e.py --suite slice0 [--viewport 440|375|both]   local server
    python3 scripts/tests/e2e.py --suite update                             update tests, local only
    python3 scripts/tests/e2e.py --suite twoapp                             needs LIFTLOG_AT_DIR
    python3 scripts/tests/e2e.py --suite slice2 [--part NAME]               Slice 2 screens and the scripted rounds
    python3 scripts/tests/e2e.py --suite upgrade                            0.2.6 (git archive of bae7bec) to 0.3.0, local only
    python3 scripts/tests/e2e.py --suite slice0 --url URL                   against a live copy

The local server serves a temp parent folder with the app at /lift-log/, on a free port.
Every request to another origin is recorded and blocked. Logs go to $LIFTLOG_LOG_DIR
(default ./test-output/). Copies go to the copy base: $LIFTLOG_LOG_DIR/tmp/ when the
variable is set, else a new system temp folder. Exit code 0 = all passed.
"""
import argparse
import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlparse, unquote

APP_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LOG_DIR = os.environ.get("LIFTLOG_LOG_DIR") or os.path.join(APP_DIR, "test-output")
UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 "
      "(KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1")
STANDALONE = "Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true });"
# Slice 3 one-time intros (17 C.3.16): the older suites tap Got it on any intro sheet the moment it
# shows, as he would, so their flows run unchanged. The slice3 tips part opens its pages without it.
INTRO_AUTO = ("(() => { const go = () => { const b = document.querySelector('[data-intro-ok]'); if (b) b.click(); };"
              " new MutationObserver(go).observe(document, { childList: true, subtree: true }); })();")
# Counts Content-Security-Policy refusals through a binding (no string waits, the CSP blocks those).
CSP_COUNTER = ("document.addEventListener('securitypolicyviolation', (e) => {"
               " if (window.__cspHit) window.__cspHit(e.violatedDirective + ' ' + e.blockedURI); });")
# Makes the next IDBDatabase.transaction call throw an UnknownError once, when armed (item 7c).
TX_FAIL_ONCE = ("(() => { const orig = IDBDatabase.prototype.transaction; window.__failTxOnce = false;"
                " IDBDatabase.prototype.transaction = function (...a) {"
                " if (window.__failTxOnce) { window.__failTxOnce = false; throw new DOMException('test', 'UnknownError'); }"
                " return orig.apply(this, a); }; })();")
# A keep-awake stand-in that counts requests (item 3).
WAKE_STUB = ("window.__wakeAsks = 0; Object.defineProperty(Navigator.prototype, 'wakeLock', { configurable: true,"
             " get: () => ({ request: () => { window.__wakeAsks++; return Promise.resolve({ release: () => Promise.resolve() }); } }) });")
def _app_version():
    import re as _re
    with open(os.path.join(APP_DIR, "version.js")) as f:
        return _re.search(r"APP_VERSION = '([^']+)'", f.read()).group(1)


APP_VERSION = _app_version()


def _rules_version():
    import re as _re
    with open(os.path.join(APP_DIR, "version.js")) as f:
        return _re.search(r"RULES_VERSION = '([^']+)'", f.read()).group(1)


RULES_VERSION = _rules_version()


def bump(v, n):
    a, b, c = v.split(".")
    return "%s.%s.%d" % (a, b, int(c) + n)


V_A, V_B, V_C = APP_VERSION, bump(APP_VERSION, 1), bump(APP_VERSION, 2)
VIEWPORTS = {"440": {"width": 440, "height": 956, "scale": 3}, "375": {"width": 375, "height": 667, "scale": 2}}
BASE_PATH = "/lift-log/"

RESULTS = []
CASES = []   # --case names: a fix loop rerun of single polish cases


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print(("  PASS  " if ok else "  FAIL  ") + name + ((" | " + str(detail)[:300]) if detail else ""), flush=True)
    return bool(ok)


# ---------------- copies and the local server ----------------

def copy_base():
    if os.environ.get("LIFTLOG_LOG_DIR"):
        base = os.path.join(os.environ["LIFTLOG_LOG_DIR"], "tmp")
        os.makedirs(base, exist_ok=True)
    else:
        base = tempfile.mkdtemp(prefix="liftlog-")
    real = os.path.realpath(base)
    if real == os.path.realpath(APP_DIR) or real.startswith(os.path.realpath(APP_DIR) + os.sep):
        raise SystemExit("FAIL copy base sits inside app/")
    return real


def git_files():
    out = subprocess.run(["git", "-C", APP_DIR, "ls-files", "--cached", "--others", "--exclude-standard"],
                         capture_output=True, text=True, check=True).stdout
    return [f for f in out.split("\n") if f]


def make_build(base, name, version=None, delete=None, version_js_from=None):
    """A served copy of the app: the git file list minus scripts/, optionally changed."""
    dst = os.path.join(base, name)
    shutil.rmtree(dst, ignore_errors=True)
    for f in git_files():
        if f.startswith("scripts/") or not os.path.exists(os.path.join(APP_DIR, f)):
            continue
        os.makedirs(os.path.dirname(os.path.join(dst, f)), exist_ok=True)
        shutil.copy2(os.path.join(APP_DIR, f), os.path.join(dst, f))
    if version:
        for f in ("version.js", "sw.js"):
            p = os.path.join(dst, f)
            src = open(p).read()
            if src.count("'" + APP_VERSION + "'") != 1:
                raise RuntimeError("version string not found once in " + f)
            open(p, "w").write(src.replace("'" + APP_VERSION + "'", "'" + version + "'"))
    if version_js_from:
        shutil.copy2(os.path.join(version_js_from, "version.js"), os.path.join(dst, "version.js"))
    if delete:
        os.remove(os.path.join(dst, delete))
    return dst


SERVE = {"app": None, "at": None}


class Handler(http.server.SimpleHTTPRequestHandler):
    """Serves SERVE['app'] at /lift-log/ and SERVE['at'] at /articulation-trainer/.
    Never answers 'not modified', so a new build is always seen."""

    def translate_path(self, path):
        path = unquote(path.split("?", 1)[0].split("#", 1)[0])
        for prefix, key in ((BASE_PATH, "app"), ("/articulation-trainer/", "at")):
            if path.startswith(prefix) and SERVE[key]:
                return os.path.join(SERVE[key], path[len(prefix):])
        return os.path.join(SERVE["app"] or APP_DIR, "__nothing_here__")

    def do_GET(self):
        if "If-Modified-Since" in self.headers:
            del self.headers["If-Modified-Since"]
        if self.path.split("?")[0] == BASE_PATH.rstrip("/"):
            self.send_response(301)
            self.send_header("Location", BASE_PATH)
            self.end_headers()
            return
        return super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass


class Server:
    def __init__(self, port=0):
        http.server.ThreadingHTTPServer.allow_reuse_address = True
        # The worker install fetches every shell file at once; the default listen queue
        # of 5 drops some of them (connection reset), which looked like a boot flake.
        http.server.ThreadingHTTPServer.request_queue_size = 128
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()


# ---------------- audit ----------------

class Audit:
    """Every request, failed request, websocket and CSP refusal, plus console errors."""

    def __init__(self, origin):
        self.origin = origin
        self.requests, self.foreign, self.failed, self.sockets, self.csp, self.errors = [], [], [], [], [], []

    def ours(self, url):
        return url.startswith(self.origin + "/") or url == self.origin or url.startswith("data:") or url.startswith("blob:")

    def attach_context(self, ctx):
        # No ctx.route: routing breaks service worker installs in this Playwright build.
        # The browser is launched behind a dead proxy instead (see launch()), so any
        # request to another host fails at once, and the request event still records it.
        ctx.on("request", lambda req: self.requests.append(req.url))
        ctx.on("requestfailed", lambda req: self.failed.append(req.url))
        ctx.expose_binding("__cspHit", lambda source, what: self.csp.append(what))
        ctx.add_init_script(CSP_COUNTER)

    def attach_page(self, page):
        page.on("console", lambda m: self.errors.append("console: " + m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: self.errors.append("pageerror: " + str(e)))
        page.on("websocket", lambda ws: self.sockets.append(ws.url))

    def off_origin(self):
        return [u for u in self.requests + self.failed if not self.ours(u)] + self.foreign + self.sockets


def new_context(browser, audit, standalone, vp="440", extra=(), intros=True):
    v = VIEWPORTS[vp]
    ctx = browser.new_context(
        viewport={"width": v["width"], "height": v["height"]}, device_scale_factor=v["scale"], is_mobile=True,
        has_touch=True, user_agent=UA, service_workers="allow")
    if standalone:
        ctx.add_init_script(STANDALONE)
        if intros:
            ctx.add_init_script(INTRO_AUTO)
    for s in extra:
        ctx.add_init_script(s)
    audit.attach_context(ctx)
    page = ctx.new_page()
    audit.attach_page(page)
    return ctx, page


def new_page(ctx, audit):
    page = ctx.new_page()
    audit.attach_page(page)
    return page


def poll(page, js, timeout=15000, every=200):
    """Wait until page.evaluate(js) is true. Playwright's in-page wait builds code
    from a string, which our CSP blocks, so poll from Python instead."""
    end = time.time() + timeout / 1000.0
    while time.time() < end:
        try:
            if page.evaluate(js):
                return True
        except Exception:
            pass
        time.sleep(every / 1000.0)
    raise TimeoutError("poll timed out: " + js[:80])


def wait_controller(page):
    page.evaluate("async () => { await navigator.serviceWorker.ready; return true; }")
    poll(page, "() => !!(navigator.serviceWorker && navigator.serviceWorker.controller)")


def check_rows(page):
    page.wait_for_selector("#check-rows[aria-busy='false']", timeout=30000)
    rows = page.eval_on_selector_all(
        "#check-rows [data-row]",
        "els => els.map(e => ({n: e.dataset.row, r: e.dataset.result, v: (e.querySelector('.val')||{}).textContent || ''}))")
    return {x["n"]: x for x in rows}, page.inner_text("#check-summary")


def wait_boot(page, sel, audit, timeout=15000):
    """Wait for the first screen; on a timeout print what the page shows, then raise."""
    try:
        page.wait_for_selector(sel, timeout=timeout)
    except Exception:
        try:
            body = page.inner_text("body")[:200].replace("\n", " ")
        except Exception as e:
            body = "(no body: %s)" % e
        print("  INFO  boot wait for %s timed out at %s | body: %s | errors: %s" % (sel, page.url, body, audit.errors[-3:]), flush=True)
        raise


def ev(page, js):
    """page.evaluate that turns a thrown error into {'error': ...}, so one broken
    part fails its own named check and the suite goes on to the audit."""
    try:
        return page.evaluate(js)
    except Exception as e:
        return {"error": str(e).split("\n")[0][:200]}


def section(name, fn):
    """Run one part of a suite; a crash fails a check named for that part, then the suite goes on."""
    try:
        fn()
    except Exception as e:
        check(name + " ran to the end", False, repr(e)[:300])
        print("  INFO  full error of " + name + " | " + repr(e).replace("\\n", " / "), flush=True)


def shot(page, name):
    """A P.1 step 7 screenshot for the design lead: waits until no animation is running (at most
    2 s, a state wait), so a sheet or toast is drawn where it rests, then saves the full page."""
    try:
        poll(page, "() => document.getAnimations().every(a => a.playState !== 'running')", 2000)
    except Exception:
        pass
    screenshot(page, name)


def screenshot(page, name):
    os.makedirs(LOG_DIR, exist_ok=True)
    page.screenshot(path=os.path.join(LOG_DIR, name), full_page=True)


LAYOUT_JS = """() => {
  const bad = [];
  if (document.documentElement.scrollWidth > window.innerWidth) bad.push('page scrolls sideways: ' + document.documentElement.scrollWidth + ' > ' + window.innerWidth);
  for (const n of document.querySelectorAll('button, a, input, select, textarea')) {
    const r = n.getBoundingClientRect();
    const cs = getComputedStyle(n);
    if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (n.closest('[hidden]')) continue;
    if (r.width < 44 || r.height < 44) bad.push((n.id || n.className || n.tagName) + ' is ' + Math.round(r.width) + 'x' + Math.round(r.height));
  }
  return bad;
}"""


def layout(page, tag, screen):
    bad = page.evaluate(LAYOUT_JS)
    check(tag + "(9) layout on " + screen + ": no side scroll, every tap 44x44", not bad, bad[:4])


def shell_total(page):
    return page.evaluate("""() => new Promise(res => { const ch = new MessageChannel();
        ch.port1.onmessage = e => res(e.data.shell.length);
        navigator.serviceWorker.controller.postMessage({type:'SHELL'}, [ch.port2]); })""")


# ---------------- suite slice0 ----------------

ATOMIC_JS = """async () => {
  const { db } = await import('./db.js');
  const stores = ['settings','exercises','templates','blocks','days','sets','feedback'];
  const counts = (o) => Object.fromEntries(stores.map(s => [s, (o[s] || []).length]));
  const snap = async () => JSON.stringify(Object.fromEntries(await Promise.all(stores.map(async s => [s, await db.all(s)]))));
  const known = { settings: [{key: 'k1', value: 1}], exercises: [{id: 'e1', muscle: 'm', equipment: 'q'}],
    templates: [{id: 't1'}], blocks: [{id: 'b1', status: 'active'}], days: [{id: 'd1', block_id: 'b1', done_date: '2026-01-01'}],
    sets: [{id: 's1', day_id: 'd1', block_id: 'b1', exercise_id: 'e1'}], feedback: [{id: 'f1', day_id: 'd1', exercise_id: 'e1'}] };
  await db.replaceAll(known, counts(known));
  const before = await snap();
  const fresh = { settings: [{key: 'k2', value: 2}], exercises: [{id: 'e2', muscle: 'm', equipment: 'q'}],
    templates: [{id: 't2'}], blocks: [{id: 'b2', status: 'active'}], days: [{id: 'd2', block_id: 'b2', done_date: '2026-01-02'}],
    sets: [{id: 's2', day_id: 'd2', block_id: 'b2', exercise_id: 'e2'}], feedback: [{id: 'f2', day_id: 'd2', exercise_id: 'e2'}] };
  const noId = { ...fresh, sets: [...fresh.sets, {day_id: 'd2', block_id: 'b2', exercise_id: 'e2'}] };
  let r1 = 'resolved'; try { await db.replaceAll(noId, counts(noId)); } catch (e) { r1 = 'rejected'; }
  const after1 = await snap();
  const wrong = { ...counts(fresh), sets: 5 };
  let r2 = 'resolved'; try { await db.replaceAll(fresh, wrong); } catch (e) { r2 = 'rejected'; }
  const after2 = await snap();
  const empty = Object.fromEntries(stores.map(s => [s, 0]));
  await db.replaceAll({}, empty);
  return { r1, r2, same1: after1 === before, same2: after2 === before };
}"""


def suite_slice0(browser, base, vp, local):
    tag = "[%s] " % vp
    o = urlparse(base)
    origin = o.scheme + "://" + o.netloc
    audit = Audit(origin)

    # (1) Tab mode: Install shows; every other route lands on Install; Phone check has no bottom bar.
    def part_tab():
        ctx, page = new_context(browser, audit, standalone=False, vp=vp)
        page.goto(base)
        wait_boot(page, "#install", audit)
        check(tag + "(1) tab: install screen shows", page.is_visible("#install"))
        check(tag + "(1) tab: no bottom bar on install", page.locator(".tabbar").count() == 0)
        check(tag + "(1) tab: install steps and address bar line show",
              page.locator("#install-addressbar").count() == 1 and page.locator("#run-check-here").inner_text().strip() == "Run Phone check here")
        layout(page, tag, "install")
        sent_back = []
        for r in ["#/today", "#/block", "#/history", "#/settings", "#/builder", "#/picker", "#/nothing", "#/install"]:
            page.evaluate("h => { location.hash = h; }", r)
            page.wait_for_timeout(150)
            if not page.is_visible("#install") or page.locator("#settings").count() or page.locator(".tabbar").count():
                sent_back.append(r)
        check(tag + "(1) tab: every route but Install and Phone check lands on Install", not sent_back, sent_back or "8 routes")
        page.click("#run-check-here")
        rows, summary = check_rows(page)
        check(tag + "(1) tab: Phone check runs in a tab, row 1 says No", rows.get("1", {}).get("r") == "no", summary)
        check(tag + "(1) tab: Phone check has no bottom bar", page.locator(".tabbar").count() == 0)
        back = page.locator("#check-back")
        check(tag + "(1) tab: top link reads Back (the glyph is the arrow, 0.4.1 Q2) and goes to Install",
              back.inner_text().strip() == "Back" and back.get_attribute("href") == "#/install")
        check(tag + "(1) tab: top link draws the back glyph, sized as on the icon (G16, LOOK 4.2 R17)",
              back.locator("svg").count() == 1 and back.evaluate("a => { const r = a.querySelector('svg').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }") == [18, 18],
              back.evaluate("a => { const s = a.querySelector('svg'); return s ? [s.getBoundingClientRect().width, s.getBoundingClientRect().height] : 'no svg'; }"))
        layout(page, tag, "check in a tab")
        screenshot(page, "e2e_%s_tab_check.png" % vp)
        back.click()
        page.wait_for_selector("#install")
        screenshot(page, "e2e_%s_install.png" % vp)
        ctx.close()

    section(tag + "(1) tab mode", part_tab)

    # (2) Standalone through an init script (no test hook in app code).
    def part_icon():
        ctx, page = new_context(browser, audit, standalone=True, vp=vp, extra=[TX_FAIL_ONCE])
        page.goto(base)
        page.wait_for_selector(".tabbar", timeout=15000)
        check(tag + "(2) icon: opens on Today with the bottom bar", page.locator(".tab.is-active").inner_text().strip() == "Today")
        layout(page, tag, "today")
        wait_controller(page)
        page.reload()
        page.wait_for_selector(".tabbar")
        for route, screen in (("#/block", "block"), ("#/history", "history")):
            page.evaluate("h => { location.hash = h; }", route)
            page.wait_for_timeout(150)
            layout(page, tag, screen)
        # Slice 3 (17 C.0.1): #/history stops showing Coming next; with no finished day it shows its own empty state.
        check(tag + "(2) icon: Block and History show their empty states",
              page.locator(".empty h2").inner_text().strip() == "Nothing logged yet")
        page.click("a.tab[href='#/settings']")
        page.wait_for_selector("#settings")
        check(tag + "(2) icon: settings shows version " + APP_VERSION, page.inner_text("[data-fact='version'] .val") == APP_VERSION)
        check(tag + "(2) icon: settings shows rules " + RULES_VERSION, page.inner_text("[data-fact='rules'] .val") == RULES_VERSION)
        layout(page, tag, "settings")
        page.click("#open-check")

        # (3) Phone check rows 2, 4, 7 Yes after one reload; row 5 Unsure on open.
        rows, summary = check_rows(page)
        total = shell_total(page)
        check(tag + "(3) row 1 Opened from the icon = Yes", rows["1"]["r"] == "yes")
        check(tag + "(3) row 2 Works with no signal = Yes, N of N", rows["2"]["r"] == "yes" and rows["2"]["v"] == "%d of %d" % (total, total), rows["2"]["v"])
        check(tag + "(3) row 3 Storage protected is Yes or Unsure, never No", rows["3"]["r"] in ("yes", "unsure"), rows["3"]["r"])
        check(tag + "(3) row 4 Saves and reads back = Yes", rows["4"]["r"] == "yes", rows["4"]["v"])
        check(tag + "(3) row 5 Screen stays awake = Unsure on open", rows["5"]["r"] == "unsure", rows["5"]["r"])
        check(tag + "(3) row 6 Can save a backup file is Yes or Unsure, never No", rows["6"]["r"] in ("yes", "unsure"), rows["6"]["r"])
        check(tag + "(3) row 7 Lock tag in place = Yes", rows["7"]["r"] == "yes")
        check(tag + "(3) summary line has no iOS number", summary.startswith(APP_VERSION + " | icon | ") and summary.endswith(" of 7") and "iOS" not in summary, summary)
        check(tag + "(3) no screen text names Max", "Max" not in page.inner_text("body"))
        print("  INFO  " + tag + "rows: " + ", ".join(k + "=" + v["r"] for k, v in sorted(rows.items())), flush=True)
        order = page.evaluate("""() => { const c = document.getElementById('check');
            return [...c.children].map(e => e.id || e.className || e.tagName.toLowerCase()); }""")
        check(tag + "(3) the storage banner sits under the subtitle, above the rows (G17, LOOK 4.2, 3.6)",
              "lead" in order and "storage-banner" in order and order.index("storage-banner") == order.index("lead") + 1
              and order.index("check-rows") == order.index("storage-banner") + 1, order)
        layout(page, tag, "check from the icon")
        screenshot(page, "e2e_%s_icon_check.png" % vp)
        v = page.evaluate("""async () => { const m = await import('./ui/check.js');
            return [m.iosVersion('iPhone OS 18_7 like Mac OS X'), m.iosVersion('iPhone OS 17_5 like Mac OS X'), m.iosVersion('x')]; }""")
        check(tag + "(3) iOS version: 18.7 reads 'or newer', 17.5 plain, none 'Not found'", v == ["18.7 or newer", "17.5", "Not found"], v)

        # (7) Reconnect.
        r7a = ev(page, """async () => { const { db } = await import('./db.js');
            const s0 = db.linkStats(); db.closeForTest();
            await db.put('settings', {key: 'e2e_7a', value: 1}); const row = await db.get('settings', 'e2e_7a');
            await db.del('settings', 'e2e_7a'); const s1 = db.linkStats();
            return { v: row ? row.value : null, retried: s1.retries > s0.retries }; }""")
        check(tag + "(7a) closeForTest, then a write and read back work through the error retry", r7a.get("v") == 1 and r7a.get("retried"), r7a)
        r7b = ev(page, """async () => { const { db } = await import('./db.js');
            await db.ready(); const s0 = db.linkStats(); db.simulateDrop();
            await db.put('settings', {key: 'e2e_7b', value: 2}); const row = await db.get('settings', 'e2e_7b');
            await db.del('settings', 'e2e_7b'); const s1 = db.linkStats();
            return { v: row ? row.value : null, reopened: s1.opens === s0.opens + 1, retried: s1.retries > s0.retries }; }""")
        check(tag + "(7b) simulateDrop, then a write and read back work through the close listener",
              r7b.get("v") == 2 and r7b.get("reopened") and not r7b.get("retried"), r7b)
        r7c = ev(page, """async () => { const { db } = await import('./db.js');
            await db.ready(); window.__failTxOnce = true; let err = null;
            try { await db.put('settings', {key: 'e2e_7c', value: 3}); } catch (e) { err = e.name; }
            const row = await db.get('settings', 'e2e_7c'); await db.del('settings', 'e2e_7c');
            return { v: row ? row.value : null, err, armed: window.__failTxOnce }; }""")
        check(tag + "(7c) an UnknownError on a transaction, then a write and read back work", r7c.get("v") == 3 and r7c.get("err") is None and r7c.get("armed") is False, r7c)

        # (8) Real-db atomicity of replaceAll.
        r8 = ev(page, ATOMIC_JS)
        check(tag + "(8) replaceAll with a row missing its id rejects and changes nothing", r8.get("r1") == "rejected" and r8.get("same1") is True, r8)
        check(tag + "(8) replaceAll with a wrong count rejects and changes nothing", r8.get("r2") == "rejected" and r8.get("same2") is True, r8)
        ctx.close()

    section(tag + "(2) to (8) icon mode", part_icon)

    # (3) Row 5 with a stubbed keep-awake: never asked on open, Yes after a tap.
    def part_wake():
        ctx, page = new_context(browser, audit, standalone=True, vp=vp, extra=[WAKE_STUB])
        page.goto(base + "#/check")
        rows, _ = check_rows(page)
        asks = page.evaluate("window.__wakeAsks")
        check(tag + "(3) row 5 not requested on open", rows["5"]["r"] == "unsure" and asks == 0, {"r": rows["5"]["r"], "asks": asks})
        page.click("#check-again")
        page.wait_for_timeout(300)
        rows, _ = check_rows(page)
        check(tag + "(3) row 5 Yes after a tap on Run check again", rows["5"]["r"] == "yes" and page.evaluate("window.__wakeAsks") == 1, rows["5"])
        ctx.close()

    section(tag + "(3) keep-awake tap", part_wake)

    # (4) Offline: server stopped, network off, a new page boots from the cache.
    def part_offline():
        if local:
            ctx, page = new_context(browser, audit, standalone=True, vp=vp)
            page.goto(base)
            try:
                page.wait_for_selector(".tabbar", timeout=15000)
            except Exception:
                print("  INFO  offline setup page: " + page.url + " | " + page.inner_text("body")[:200].replace("\n", " ") + " | " + str(audit.errors[-3:]), flush=True)
                raise
            wait_controller(page)
            page.reload()
            page.wait_for_selector(".tabbar")
            local["server"].stop()
            ctx.set_offline(True)
            page.close()
            page = new_page(ctx, audit)
            errs_before = len(audit.errors)
            try:
                page.goto(base)
                page.wait_for_selector(".tabbar", timeout=15000)
                booted = page.locator("#today").count() == 1 and page.locator(".empty h2").inner_text().strip() in ("Set up", "No block yet")
            except Exception as e:
                booted = False
            check(tag + "(4) offline: server stopped, a new page boots on Today", booted)
            if booted:
                page.evaluate("location.hash = '#/check'")
                rows, summary = check_rows(page)
                n_shell = shell_total(page)
                check(tag + "(4) offline: row 2 shows N of N", rows["2"]["r"] == "yes" and rows["2"]["v"] == "%d of %d" % (n_shell, n_shell),
                      {"value": rows["2"]["v"], "shell": n_shell})
                page.evaluate("""async () => { const { db } = await import('./db.js'); await db.put('settings', {key: 'offline_probe', value: 7}); }""")
                page.reload()
                page.wait_for_selector(".tabbar", timeout=15000)
                kept = page.evaluate("""async () => { const { db } = await import('./db.js'); const r = await db.get('settings', 'offline_probe');
                    await db.del('settings', 'offline_probe'); return r ? r.value : null; }""")
                check(tag + "(4) offline: a probe row saves and a reload keeps it", kept == 7, kept)
                page.evaluate("""() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
                    document.dispatchEvent(new Event('visibilitychange')); }""")
                page.wait_for_timeout(2000)
                check(tag + "(4) offline: visibilitychange to visible leaves zero console errors", len(audit.errors) == errs_before, audit.errors[errs_before:][:3])
                screenshot(page, "e2e_%s_offline_check.png" % vp)
            ctx.close()
            # Control: a context that never visited cannot load with the server down.
            cctx, cpage = new_context(browser, Audit(origin), standalone=True, vp=vp)
            try:
                cpage.goto(base, timeout=8000)
                control_loaded = cpage.locator(".tabbar").count() > 0
            except Exception:
                control_loaded = False
            check(tag + "(4) offline control: a never-visited context fails to load", not control_loaded)
            cctx.close()

    section(tag + "(4) offline", part_offline)

    # (5) Network audit and (6) console errors.
    os.makedirs(LOG_DIR, exist_ok=True)
    with open(os.path.join(LOG_DIR, "e2e_%s_network.json" % vp), "w") as f:
        json.dump({"origin": origin, "requests": audit.requests, "failed": audit.failed, "foreign_blocked": audit.foreign,
                   "websockets": audit.sockets, "csp_violations": audit.csp}, f, indent=1)
    off = audit.off_origin()
    check(tag + "(5) network audit: zero requests off our origin and zero CSP violations", not off and not audit.csp,
          "%d requests, %d off origin, %d CSP violations %s" % (len(audit.requests), len(off), len(audit.csp), (off + audit.csp)[:3]))
    check(tag + "(6) zero console errors", not audit.errors, audit.errors[:5])


# ---------------- suite update ----------------

def ask_version(page):
    return page.evaluate("""() => new Promise(res => { const c = navigator.serviceWorker.controller; if (!c) return res(null);
        const ch = new MessageChannel(); ch.port1.onmessage = e => res(e.data.version); c.postMessage({type:'SHELL'}, [ch.port2]); })""")


def settle_takeover(page, cache_want, timeout=25000):
    try:
        poll(page, "async () => (await caches.keys()).includes('%s')" % cache_want, timeout=timeout)
        poll(page, "() => window.__beforeUpdate !== true", timeout=10000)
    except Exception:
        pass
    page.wait_for_selector(".tabbar", timeout=15000)


def version_text(page):
    page.evaluate("location.hash = '#/settings'")
    page.wait_for_selector("#settings")
    return page.inner_text("[data-fact='version'] .val")


def suite_update(browser, base, cb):
    o = urlparse(base)
    origin = o.scheme + "://" + o.netloc
    audit = Audit(origin)
    A = make_build(cb, "build-a")
    B = make_build(cb, "build-b", version=V_B)
    MIXED = make_build(cb, "build-mixed", version=V_B, version_js_from=A)
    BROKEN = make_build(cb, "build-b-missing", version=V_B, delete="ui/settings.js")
    C = make_build(cb, "build-c", version=V_C)

    def fresh(tag_warm=False):
        SERVE["app"] = A
        ctx, page = new_context(browser, audit, standalone=True)
        page.goto(base)
        wait_boot(page, ".tabbar", audit)
        wait_controller(page)
        if tag_warm:
            page.reload()
            page.wait_for_selector(".tabbar")
        page.evaluate("""async () => { const c = await caches.open('artic-test');
            await c.put('/artic-probe', new Response('kept')); window.__beforeUpdate = true; }""")
        return ctx, page

    def artic_kept(page):
        return page.evaluate("""async () => { if (!(await caches.has('artic-test'))) return null;
            const c = await caches.open('artic-test'); const r = await c.match('/artic-probe'); return r ? r.text() : null; }""")

    # Case 1, both ways: first open then update, and opened with the worker already in charge.
    def case_1():
        for warm in (False, True):
            tag = "case 1 (%s): " % ("worker in charge at load" if warm else "first-open case")
            ctx, page = fresh(warm)
            keys = page.evaluate("caches.keys()")
            check(tag + "A running, caches liftlog-" + V_A + " and artic-test", "liftlog-" + V_A in keys and "artic-test" in keys, keys)
            SERVE["app"] = B
            page.evaluate("navigator.serviceWorker.getRegistration().then(r => r.update())")
            settle_takeover(page, "liftlog-" + V_B)
            keys = page.evaluate("caches.keys()")
            check(tag + "old cache liftlog-" + V_A + " gone", "liftlog-" + V_A not in keys, keys)
            check(tag + "new cache liftlog-" + V_B + " present", "liftlog-" + V_B in keys, keys)
            check(tag + "other app's cache artic-test kept with its entry (M11e)", artic_kept(page) == "kept")
            check(tag + "page reloaded once on its own", page.evaluate("window.__beforeUpdate !== true"))
            vt = version_text(page)
            check(tag + "version text shows B (" + V_B + ")", vt == V_B, vt)
            ctx.close()

    section("case 1", case_1)

    # The what-changed note (17 C.3.16, AW1, JW2, M70): a first install shows none; an update from A
    # to B shows it once on Today, and not again after the next reload.
    def case_changed():
        ctx, page = fresh(False)
        settle(page, 600)
        first = page.locator("#changed-banner").count()
        SERVE["app"] = B
        page.evaluate("navigator.serviceWorker.getRegistration().then(r => r.update())")
        settle_takeover(page, "liftlog-" + V_B)
        page.wait_for_selector("#today > *", timeout=15000)
        try:
            page.wait_for_selector("#changed-banner", timeout=6000)
            shown = True
        except Exception:
            shown = False
        head = page.inner_text("#changed-banner").strip() if shown else ""
        page.reload(); page.wait_for_selector("#today > *"); settle(page, 800)
        again = page.locator("#changed-banner").count()
        check("M70: a first install shows no what-changed note", first == 0)
        check("AW1 JW2: an update from A to B shows the note once on Today, and not after the next reload",
              shown and head.startswith("Updated to " + V_B + ".") and again == 0, {"shown": shown, "head": head, "again": again})
        ctx.close()

    section("what-changed case", case_changed)

    # Update after visibilitychange: returning to the app checks for a new version.
    def case_vis():
        ctx, page = fresh(True)
        SERVE["app"] = B
        page.evaluate("""() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
            document.dispatchEvent(new Event('visibilitychange')); }""")
        settle_takeover(page, "liftlog-" + V_B)
        vt = version_text(page)
        check("update-after-visibility case: the app finds B and reloads to it", vt == V_B and page.evaluate("window.__beforeUpdate !== true"), vt)
        ctx.close()

    section("update-after-visibility case", case_vis)

    # Worker already waiting at boot: a first page holds B back, a second page boots and takes it.
    def case_wait():
        ctx, page = fresh(True)
        page.evaluate("""() => { const orig = ServiceWorker.prototype.postMessage;
            ServiceWorker.prototype.postMessage = function (m, ...rest) { if (m && m.type === 'SKIP_WAITING') return; return orig.call(this, m, ...rest); }; }""")
        SERVE["app"] = B
        page.evaluate("navigator.serviceWorker.getRegistration().then(r => r.update())")
        try:
            poll(page, "async () => { const r = await navigator.serviceWorker.getRegistration(); return !!(r && r.waiting); }", timeout=20000)
            waiting = True
        except Exception:
            waiting = False
        check("worker-waiting-at-boot case: B waits while the first page holds it", waiting)
        loads = []
        p2 = ctx.new_page()
        audit.attach_page(p2)
        p2.on("load", lambda: loads.append(time.time()))
        p2.goto(base)
        try:
            poll(p2, "async () => (await caches.keys()).includes('liftlog-%s') && !!navigator.serviceWorker.controller" % V_B, timeout=20000)
        except Exception:
            pass
        p2.wait_for_timeout(2500)
        p2.wait_for_selector(".tabbar", timeout=15000)
        vt = version_text(p2)
        check("worker-waiting-at-boot case: the new page takes B and reloads once", vt == V_B and len(loads) == 2, {"version": vt, "loads": len(loads)})
        ctx.close()

    section("worker-waiting-at-boot case", case_wait)

    # A worker waiting at boot while a day is open: banner, no reload; Finish day and close the nudge: B.
    def case_open_day():
        SERVE["app"] = A
        ctx, page = new_context(browser, audit, standalone=True)
        page.set_default_timeout(10000)
        page.goto(base)
        page.wait_for_selector("#today > *", timeout=15000)
        wait_controller(page)
        page.click("#unit-lb")
        load_block_file(page, os.path.join(FIXTURES, "block_v1.json"))
        tick(page, fb="save")
        SERVE["app"] = B
        page.evaluate("navigator.serviceWorker.getRegistration().then(r => r.update())")
        try:
            poll(page, "async () => { const r = await navigator.serviceWorker.getRegistration(); return !!(r && r.waiting); }", timeout=20000)
        except Exception:
            pass
        loads = []
        p2 = new_page(ctx, audit)
        p2.set_default_timeout(10000)
        p2.on("load", lambda: loads.append(time.time()))
        p2.goto(base)
        p2.wait_for_selector("#today[data-day]", timeout=15000)
        p2.wait_for_timeout(3000)
        banner = p2.locator("#update-banner").count() == 1
        check("open-day case: a waiting worker at boot with a day open shows the banner and does not reload",
              banner and len(loads) == 1 and ask_version(p2) == V_A, {"banner": banner, "loads": len(loads)})
        page.close()
        # The reload waits for the nudge (15 Part 14, P.3 update row; review P1, P26): with the Day
        # done screen and the nudge both up, the page has still loaded once.
        try:
            at = finish(p2, at_nudge=True)
            p2.wait_for_timeout(1500)
            shown = p2.locator("#daydone").count() == 1 and p2.locator("#nudge").count() == 1
        except Exception:
            at, shown = False, False
        check("open-day case: Finish day shows the Day done screen and the nudge, with no reload yet",
              at is True and shown and len(loads) == 1, {"finish reached the nudge": at, "daydone and nudge": shown, "loads": len(loads)})
        try:
            p2.click("#nudge-later")
            poll(p2, "() => !!navigator.serviceWorker.controller", timeout=5000)
            p2.wait_for_timeout(3000)
            p2.wait_for_selector(".tabbar", timeout=15000)
        except Exception:
            pass
        vt = version_text(p2)
        check("open-day case: Later on the nudge, then the reload to B", vt == V_B and len(loads) == 2, {"version": vt, "loads": len(loads)})
        ctx.close()

    section("open-day case", case_open_day)

    # Busy with no day open: a half-built block, then an open sheet. A found update waits,
    # nothing typed is lost, and it loads once he is done (C5, C6).
    def case_busy():
        for how in ("builder", "sheet"):
            ctx, page = fresh(True)
            if how == "builder":
                page.evaluate("location.hash = '#/builder'")
                page.wait_for_selector("#builder[data-step='1']")
                page.fill("#block-name", "Half built")
            else:
                page.evaluate("location.hash = '#/settings'")
                page.wait_for_selector("#settings")
                page.click("#erase-open")
                page.wait_for_selector("#erase-sheet")
            SERVE["app"] = B
            page.evaluate(VIS)
            try:
                poll(page, "async () => { const r = await navigator.serviceWorker.getRegistration(); return !!(r && r.waiting); }", timeout=20000)
                waiting = True
            except Exception:
                waiting = False
            page.wait_for_timeout(2500)
            held = waiting and page.evaluate("window.__beforeUpdate === true")
            kept = page.input_value("#block-name") == "Half built" if how == "builder" else page.locator("#erase-sheet").count() == 1
            check("busy case (%s): a found update does not reload while he is busy, nothing is lost" % how, held and kept,
                  {"B waiting": waiting, "no reload": held, "kept": kept, "version": ask_version(page)})
            if how == "builder":
                # Cancel keeps a typed draft (14.8 G4), and a kept draft still holds the update
                # (Part 4, G11). He is done once he drops it: Start over, then Cancel on the empty builder.
                page.click("#builder-cancel")
                page.wait_for_selector("#setup-build")
                page.click("#unit-lb")
                build_click(page, "#setup-build")
                page.wait_for_selector("#draft-sheet")
                page.click("#draft-over")
                page.wait_for_selector("#builder[data-step='1']")
                page.click("#builder-cancel")
            else:
                scrim_tap(page)
            try:
                settle_takeover(page, "liftlog-" + V_B)
            except Exception:
                pass
            page.wait_for_timeout(1500)
            try:
                page.wait_for_selector(".tabbar", timeout=15000)
            except Exception:
                pass
            vt = version_text(page)
            check("busy case (%s): when he is done, the update loads" % how, vt == V_B and page.evaluate("window.__beforeUpdate !== true"), vt)
            ctx.close()

    section("busy case", case_busy)

    # G11 (review P6): the builder opened, then Load a block file instead. The empty build left in
    # memory is not a draft, so a found update loads once he is on Today, with no relaunch.
    def case_builder_load():
        ctx, page = fresh(True)
        page.click("#unit-lb")
        page.evaluate("location.hash = '#/builder'")
        page.wait_for_selector("#builder[data-step='1']")
        with page.expect_file_chooser() as chooser:
            page.click("#builder-load")
        chooser.value.set_files(os.path.join(FIXTURES, "block_v1.json"))
        page.wait_for_selector("#block-sheet")
        page.click("#block-file-save")
        settle(page, 400)
        if page.locator("#switch-sheet").count():
            page.click("#switch-yes")
        page.wait_for_selector("#today[data-day]")
        settle(page)
        page.evaluate("window.__beforeUpdate = true")
        SERVE["app"] = B
        page.evaluate(VIS)
        try:
            settle_takeover(page, "liftlog-" + V_B)
        except Exception:
            pass
        page.wait_for_timeout(1500)
        try:
            page.wait_for_selector(".tabbar", timeout=15000)
        except Exception:
            pass
        vt = version_text(page)
        check("builder-load case: after Load a block file instead, a found update loads with no relaunch",
              vt == V_B and page.evaluate("window.__beforeUpdate !== true"), vt)
        ctx.close()

    section("builder-load case", case_builder_load)

    # Mixed set: B's sw.js with A's version.js. B's install fails, A stays.
    def case_mixed():
        ctx, page = fresh(True)
        SERVE["app"] = MIXED
        page.evaluate("navigator.serviceWorker.getRegistration().then(r => r.update()).catch(() => {})")
        page.wait_for_timeout(4000)
        st = page.evaluate("""async () => { const r = await navigator.serviceWorker.getRegistration();
            return { waiting: !!r.waiting, installing: !!r.installing, keys: await caches.keys() }; }""")
        check("mixed set: B's install fails and A stays in charge",
              not st["waiting"] and "liftlog-" + V_B not in st["keys"] and ask_version(page) == V_A, st)
        ctx.close()

    section("mixed set", case_mixed)

    # Case 2, failed update: one SHELL file missing from B.
    def case_2():
        ctx, page = fresh(True)
        SERVE["app"] = BROKEN
        page.evaluate("navigator.serviceWorker.getRegistration().then(r => r.update()).catch(() => {})")
        page.wait_for_timeout(5000)
        st = page.evaluate("""async () => { const r = await navigator.serviceWorker.getRegistration();
            const keys = await caches.keys(); let have = 0, total = 0;
            const info = await new Promise(res => { const ch = new MessageChannel(); ch.port1.onmessage = e => res(e.data);
              navigator.serviceWorker.controller.postMessage({type:'SHELL'}, [ch.port2]); });
            if (keys.includes('liftlog-__VA__')) { const c = await caches.open('liftlog-__VA__');
              for (const u of info.shell) { total++; if (await c.match(new URL(u, r.scope).href)) have++; } }
            return { waiting: !!r.waiting, version: info.version, keys, have, total }; }""".replace("__VA__", V_A))
        check("case 2: no worker waiting and the controller is still A", not st["waiting"] and st["version"] == V_A, st)
        check("case 2: liftlog-" + V_A + " holds every SHELL entry and no liftlog-" + V_B + " exists",
              st["have"] == st["total"] and st["total"] > 0 and ("liftlog-" + V_B) not in st["keys"], st)
        ctx.set_offline(True)
        page.close()
        page = new_page(ctx, audit)
        try:
            page.goto(base)
            page.wait_for_selector(".tabbar", timeout=15000)
            ok = True
        except Exception:
            ok = False
        check("case 2: the offline boot still works", ok)
        ctx.set_offline(False)
        ctx.close()

    section("case 2", case_2)

    # Case 3, rollback rehearsal: B in charge, a row written, then C (A's code, higher version).
    def case_3():
        ctx, page = fresh(True)
        SERVE["app"] = B
        page.evaluate("navigator.serviceWorker.getRegistration().then(r => r.update())")
        settle_takeover(page, "liftlog-" + V_B)
        page.evaluate("""async () => { const { db } = await import('./db.js'); await db.put('settings', {key: 'rollback_probe', value: 5});
            window.__beforeUpdate = true; }""")
        SERVE["app"] = C
        page.evaluate("navigator.serviceWorker.getRegistration().then(r => r.update())")
        settle_takeover(page, "liftlog-" + V_C)
        keys = page.evaluate("caches.keys()")
        row = page.evaluate("""async () => { const { db } = await import('./db.js'); const r = await db.get('settings', 'rollback_probe');
            await db.del('settings', 'rollback_probe'); return r ? r.value : null; }""")
        vt = version_text(page)
        check("case 3: C takes over, liftlog-" + V_B + " gone, artic-test kept, the row kept",
              vt == V_C and "liftlog-" + V_B not in keys and artic_kept(page) == "kept" and row == 5,
              {"version": vt, "keys": keys, "row": row})
        ctx.close()

    section("case 3", case_3)

    # A3-R6 C6 (PD14): a share sheet still open holds a found update back; it loads after.
    def case_c6():
        SERVE["app"] = A
        ctx, page = new_context(browser, audit, standalone=True, extra=[SHARE_SLOW])
        page.goto(base)
        wait_boot(page, ".tabbar", audit)
        wait_controller(page)
        page.reload(); page.wait_for_selector(".tabbar")
        page.evaluate("window.__beforeUpdate = true")
        page.evaluate("location.hash = '#/settings'")
        page.wait_for_selector("#settings")
        poll(page, "() => { const b = document.getElementById('backup-now'); return b && !b.disabled; }")
        page.click("#backup-now")
        SERVE["app"] = B
        page.evaluate(VIS)
        page.wait_for_timeout(2200)
        held = page.evaluate("window.__beforeUpdate === true && window.__shared === null")
        try:
            settle_takeover(page, "liftlog-" + V_B)
        except Exception:
            pass
        page.wait_for_timeout(1500)
        try:
            page.wait_for_selector(".tabbar", timeout=15000)
        except Exception:
            pass
        vt = version_text(page)
        check("C6: a share in progress holds the update back, and it loads after the share settles",
              held and vt == V_B, {"held": held, "version": vt})
        ctx.close()

    section("C6", case_c6)

    # A3-R6 C7 (PD13): a write still committing when the new version takes over lands first.
    def case_c7():
        SERVE["app"] = A
        ctx, page = new_context(browser, audit, standalone=True, extra=[TX_HOLD])
        page.goto(base)
        wait_boot(page, ".tabbar", audit)
        wait_controller(page)
        page.reload(); page.wait_for_selector(".tabbar")
        page.click("#unit-lb")
        load_block_file(page, os.path.join(FIXTURES, "block_v1.json"))
        # T2: one tick first, so the day is open and B waits behind the banner (4.4). With no day
        # open and nothing busy the app would take B at once and the hold below would test nothing.
        tick(page, fb="save")
        SERVE["app"] = B
        page.evaluate("navigator.serviceWorker.getRegistration().then(r => r.update())")
        page.wait_for_selector("#update-banner", timeout=20000)
        sid = open_set(page)
        page.evaluate("window.__holdTx = true; window.__beforeUpdate = true")
        page.click(q(sid) + " [data-tick]")
        # Update now goes through applyUpdate, which sets askedToSwap; the reload then waits on
        # store.idle(). The test never posts SKIP_WAITING itself (the page would ignore that swap).
        page.click("#update-banner .btn-quiet")
        try:
            settle_takeover(page, "liftlog-" + V_B)
        except Exception:
            pass
        page.wait_for_timeout(3000)
        try:
            page.wait_for_selector("#today[data-day]", timeout=15000)
        except Exception:
            pass
        vt = version_text(page) if page.locator(".tabbar").count() else None
        go_route(page, "#/today", "#today[data-day]")
        check("C7: an update reload waits for a write still committing, and after it the set shows Done",
              state_of(page, sid) == "done" and page.evaluate("window.__beforeUpdate !== true"), {"state": state_of(page, sid), "version": vt})
        ctx.close()

    section("C7", case_c7)

    SERVE["app"] = A
    check("update: zero console errors", not audit.errors, audit.errors[:5])
    check("update: zero requests off our origin", not audit.off_origin(), audit.off_origin()[:5])


# ---------------- suite twoapp (only while Lift Log shares a web address, gate 4.8 a) ----------------

def suite_twoapp(browser, base, cb):
    """Both apps on one address (DESIGN 4.6 twoapp). The other app runs from a temp copy of
    its own git file list with the one-line cache fix applied to the copy only. The control
    run uses a copy without the fix and must lose our cache, so the suite can fail."""
    if not os.environ.get("LIFTLOG_AT_DIR") or not os.path.isdir(os.environ["LIFTLOG_AT_DIR"]):
        check("twoapp: LIFTLOG_AT_DIR names the other app's folder", False)
        return
    o = urlparse(base)
    origin = o.scheme + "://" + o.netloc
    at_base = origin + "/articulation-trainer/"
    A = make_build(cb, "build-a")
    B = make_build(cb, "build-b", version=V_B)

    def pair(fixed):
        audit = Audit(origin)
        SERVE["app"], SERVE["at"] = A, make_at_copy(cb, "at-a-%s" % fixed, fixed=fixed)
        at_next = make_at_copy(cb, "at-b-%s" % fixed, fixed=fixed, touch=True)
        ctx, page = new_context(browser, audit, standalone=True)
        page.goto(base)
        page.wait_for_selector(".tabbar", timeout=15000)
        wait_controller(page)
        p2 = new_page(ctx, audit)
        p2.goto(at_base)
        p2.wait_for_timeout(5000)
        SERVE["app"] = B
        page.evaluate("navigator.serviceWorker.getRegistration().then(r => r.update())")
        settle_takeover(page, "liftlog-" + V_B)
        SERVE["at"] = at_next
        p2.evaluate("navigator.serviceWorker.getRegistration().then(r => r && r.update()).catch(() => {})")
        p2.wait_for_timeout(6000)
        st = page.evaluate("""async () => ({ keys: await caches.keys(),
            dbs: (indexedDB.databases ? (await indexedDB.databases()).map(d => d.name) : []) })""")
        ok1 = ok2 = False
        if fixed:
            ctx.set_offline(True)
            p3 = new_page(ctx, audit)
            try:
                p3.goto(base)
                p3.wait_for_selector(".tabbar", timeout=15000)
                ok1 = True
            except Exception:
                ok1 = False
            p4 = new_page(ctx, audit)
            try:
                p4.goto(at_base)
                # Its real first screen, not just any page with text (an error page has text too) (C18).
                try:
                    poll(p4, "() => document.title === 'Articulation Trainer' && !!document.querySelector('#app > *')", timeout=10000)
                    ok2 = True
                except Exception:
                    ok2 = False
                if not ok2:
                    print("  INFO  other app offline body is empty at " + p4.url, flush=True)
            except Exception as e:
                print("  INFO  other app offline load: " + str(e).split("\n")[0][:160], flush=True)
                ok2 = False
        ctx.close()
        return st, ok1, ok2, audit

    st, ok1, ok2, audit = pair(True)
    check("twoapp: after both updates a liftlog- cache and an artic- cache remain",
          any(k.startswith("liftlog-") for k in st["keys"]) and any(k.startswith("artic-") for k in st["keys"]), st["keys"])
    check("twoapp: both databases remain", "liftlog" in st["dbs"] and "artic" in st["dbs"], st["dbs"])
    check("twoapp: both apps boot offline", ok1 and ok2, {"liftlog": ok1, "other": ok2})
    check("twoapp: zero requests off our origin", not audit.off_origin(), audit.off_origin()[:3])
    cst, _, _, _ = pair(False)
    check("twoapp control: a copy WITHOUT the cache fix deletes our cache (the suite can fail)",
          not any(k.startswith("liftlog-") for k in cst["keys"]), cst["keys"])


# ---------------- suite slice1 (DESIGN 5.7) ----------------

FIXTURES = os.path.join(APP_DIR, "scripts", "tests", "fixtures")
STORES7 = "['settings','exercises','templates','blocks','days','sets','feedback']"
DUMP_JS = """async () => { const { db } = await import('./db.js'); const out = {};
  for (const s of %s) { const rows = await db.all(s); rows.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1); out[s] = rows; }
  return JSON.stringify(out); }""" % STORES7
# Makes every readwrite transaction never complete, while armed (M12b, DESIGN 5.7): no row it
# holds ever lands and no complete, error or abort event reaches the page. Hiding only
# oncomplete was not enough: the real commit still landed, so the store's retry (G13, review
# P9) read the row back as saved and the case saw Done. Reads are never held, so the screen
# can still redraw the row red. Each one is aborted in a microtask, after the app has placed
# its requests in the same task and before the transaction can commit.
TX_HANG = ("(() => { const orig = IDBDatabase.prototype.transaction; window.__hangTx = false;"
           " IDBDatabase.prototype.transaction = function (...a) { const tx = orig.apply(this, a);"
           " if (window.__hangTx && a[1] === 'readwrite') {"
           " for (const k of ['oncomplete', 'onerror', 'onabort']) Object.defineProperty(tx, k, { set() {}, get() { return null; }, configurable: true });"
           " queueMicrotask(() => { try { tx.abort(); } catch (_) { /* already finished */ } }); }"
           " return tx; }; })();")
NO_SHARE = "delete Navigator.prototype.share; delete Navigator.prototype.canShare;"
# Holds the next readwrite transaction's commit for 2 s, when armed (A3-R6 C7).
# Holds the next readwrite transaction open 2 s before it may commit (stage 4 N5). It chains a
# cheap count() on one of the transaction's own stores, each success asking the next, so the
# commit itself waits: a reload that does not wait for store.idle() aborts the write. The app's
# oncomplete is left as is (it fires when the real commit lands).
TX_HOLD = ("(() => { const orig = IDBDatabase.prototype.transaction; window.__holdTx = false;"
           " IDBDatabase.prototype.transaction = function (...a) { const tx = orig.apply(this, a);"
           " if (window.__holdTx && a[1] === 'readwrite') { window.__holdTx = false;"
           " const names = typeof a[0] === 'string' ? [a[0]] : Array.from(a[0]); const until = Date.now() + 2000;"
           " const spin = () => { if (Date.now() >= until) return; const r = tx.objectStore(names[0]).count(); r.onsuccess = spin; };"
           " spin(); }"
           " return tx; }; })();")
# Counts every read of a picked file's text (A4-1: an over-cap file is never read).
TEXT_SPY = ("window.__textReads = 0; (() => { const orig = Blob.prototype.text;"
            " Blob.prototype.text = function (...a) { window.__textReads++; return orig.apply(this, a); }; })();")
# A share sheet that stays open 3 s, then saves (A3-R6 C6).
SHARE_SLOW = ("window.__shared = null;"
              " Object.defineProperty(Navigator.prototype, 'canShare', { configurable: true, value: () => true });"
              " Object.defineProperty(Navigator.prototype, 'share', { configurable: true, value: (d) =>"
              " new Promise((res) => setTimeout(() => { window.__shared = 'saved'; res(); }, 3000)) });")
# Counts page loads of this tab across reloads (A3-R1 (b): a good restore reloads exactly once).
LOAD_COUNT = ("(() => { const n = Number(sessionStorage.getItem('__loads') || '0') + 1;"
              " sessionStorage.setItem('__loads', String(n)); window.__loads = n; })();")
SHARE_STUB = ("window.__shareMode = 'resolve'; window.__shared = null;"
              " Object.defineProperty(Navigator.prototype, 'canShare', { configurable: true, value: () => true });"
              " Object.defineProperty(Navigator.prototype, 'share', { configurable: true, value: (d) => {"
              " if (window.__shareMode === 'abort') return Promise.reject(new DOMException('closed', 'AbortError'));"
              " return d.files[0].text().then(tx => { window.__shared = tx; }); } });")
WAKE_COUNT = ("window.__wakeAsks = 0; window.__sentinels = [];"
              " Object.defineProperty(Navigator.prototype, 'wakeLock', { configurable: true, get: () => ({ request: () => {"
              " window.__wakeAsks++; const s = new EventTarget(); s.released = false;"
              " s.release = () => { s.released = true; s.dispatchEvent(new Event('release')); return Promise.resolve(); };"
              " window.__sentinels.push(s); return Promise.resolve(s); } }) });")
VIS = """() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange')); }"""


def q(sid):
    return '[data-set="%s"]' % sid


def open_set(page):
    return page.evaluate("() => { const r = document.querySelector('.set.is-open'); return r ? r.getAttribute('data-set') : null; }")


def state_of(page, sid):
    return page.evaluate("(id) => { const r = document.querySelector('[data-set=\"' + id + '\"]'); return r ? r.getAttribute('data-state') : null; }", sid)


def wait_state(page, sid, want, timeout=10000):
    poll(page, "() => { const r = document.querySelector('[data-set=\"%s\"]'); return !!r && r.getAttribute('data-state') === '%s'; }" % (sid, want), timeout)


def scrim_tap(page):
    """A real tap on the scrim: a point where the scrim itself is the top element. A sheet in
    typing mode sits at the top of the screen (LOOK 3.3 Typing mode), so a fixed corner can be
    the sheet; the corners are tried in turn and a missing scrim point fails loudly."""
    pt = page.evaluate("""() => { const w = innerWidth, h = innerHeight;
        for (const [x, y] of [[10, 10], [10, h - 10], [w - 10, h - 10], [w - 10, 10], [10, h / 2]]) {
          const hit = document.elementFromPoint(x, y); if (hit && hit.classList.contains('sheet-scrim')) return [x, y]; }
        return null; }""")
    if not pt:
        raise AssertionError("no point on the screen where the scrim is on top")
    page.mouse.click(pt[0], pt[1])


def settle(page, ms=250):
    page.wait_for_timeout(ms)


def answer_fb(page, how):
    if how == "none":
        return
    settle(page, 300)
    if page.locator("#feedback").count():
        page.click({"save": "#fb-save", "later": "#fb-later", "skip": "#fb-skip"}[how])
        poll(page, "() => !document.getElementById('feedback')")
        settle(page)


def tick(page, sid=None, fb="save"):
    sid = sid or open_set(page)
    page.click(q(sid) + " [data-tick]")
    try:
        wait_state(page, sid, "done")
    except TimeoutError:
        print("  INFO  tick %s stayed %s | %s" % (sid[-24:], state_of(page, sid), page.inner_text(q(sid))[:80].replace("\n", " ") if page.locator(q(sid)).count() else "row gone"), flush=True)
        raise
    answer_fb(page, fb)
    return sid


def finish(page, score=None, stay=False, at_nudge=False):
    # at_nudge=True stops with the backup nudge still open over the Day done screen, so a case
    # can look at the page before the nudge closes (review P1, P26).
    page.click("#finish-day")
    for _ in range(12):
        settle(page, 300)
        if page.locator("#feedback").count():
            page.click("#fb-skip")
            continue
        if page.locator("#overall").count():
            if score is not None:
                for el_ in page.query_selector_all("#overall [data-score$='-%d']" % score):
                    el_.click()
                page.click("#day-save")
            else:
                page.click("#day-skip")
            continue
        if page.locator("#nudge").count():
            if at_nudge:
                return True
            page.click("#nudge-later")
            poll(page, "() => !document.getElementById('nudge')")
            # The Day done screen stays after the nudge (15 Part 14); its button goes to Today.
            # stay=True leaves it up for the cases that look at it.
            if not stay:
                leave_day_done(page)
            return True
    return False


def poll_quiet(page, js, timeout=3000):
    """poll() that answers False instead of raising when the time runs out."""
    try:
        return poll(page, js, timeout=timeout)
    except Exception:
        return False


def leave_day_done(page):
    try:
        settle(page, 200)
        if page.locator("#done-go").count():
            page.click("#done-go")
        # On the last day of a block the button goes to Block finished (17 C.3.9).
        page.wait_for_selector("#today > *, #finished > *", timeout=10000)
    except Exception:
        pass   # a reload to a new version lands on Today by itself


def dump(page, keep_marker=False):
    """Every store but snapshots. The backup marker is a device key that restore sets on
    purpose, so it is compared on its own unless keep_marker is set."""
    d = json.loads(page.evaluate(DUMP_JS))
    # restore_note is the one-shot "Restored" line a restore leaves for the next boot (A3-R8).
    d["settings"] = [r for r in d["settings"] if r["key"] != "restore_note"]
    if not keep_marker:
        d["settings"] = [r for r in d["settings"] if r["key"] != "last_backup_at"]
    return json.dumps(d, sort_keys=True)


DEVICE_KEYS = ("last_backup_at", "persist_answer", "theme", "seeded_version", "restore_note")


def norm_stores(stores):
    """The 7 stores, rows in a fixed order, device settings left out (restore keeps the phone's own)."""
    out = {}
    for s_ in ("settings", "exercises", "templates", "blocks", "days", "sets", "feedback"):
        rows = stores.get(s_, [])
        if s_ == "settings":
            rows = [r_ for r_ in rows if r_["key"] not in DEVICE_KEYS]
        out[s_] = sorted(rows, key=lambda r_: json.dumps(r_, sort_keys=True))
    return json.dumps(out, sort_keys=True)


def norm_dump(d):
    return norm_stores(json.loads(d))


def file_dump(path):
    return norm_stores(json.load(open(path))["stores"])


def differs(a, b):
    a, b = json.loads(a), json.loads(b)
    return [k for k in a if a[k] != b.get(k)]


def build_click(page, sel):
    """Build a block (setup or empty Today). From 0.4.0 it opens the New block chooser (17 C.3.3);
    this taps Build from scratch there, so a case written for the builder reaches it as before.
    An older build with no chooser goes straight on."""
    page.click(sel)
    try:
        poll(page, "() => !!document.getElementById('new') || !!document.getElementById('builder') || !!document.getElementById('draft-sheet')", 5000)
    except Exception:
        return
    if page.locator("#new").count():
        page.click("#new-scratch")


def go_route(page, route, sel):
    page.evaluate("h => { location.hash = h; }", route)
    page.wait_for_selector(sel, timeout=10000)
    settle(page)


def fill_change(page, sel, value):
    page.fill(sel, value)
    page.dispatch_event(sel, "change")


def build_two_day_block(page):
    """First run by taps: units, then a 2-day block with 2 exercises each, rounds 3."""
    page.wait_for_selector("#setup")
    page.click("#unit-lb")
    build_click(page, "#setup-build")
    page.wait_for_selector("#builder[data-step='1']")
    page.fill("#block-name", "Test block")
    page.click("#builder-next")
    page.wait_for_selector("#builder[data-step='2']")
    fill_change(page, "#block-rounds", "3")
    page.click("#builder-next")
    page.wait_for_selector("#builder[data-step='3']")
    for day, picks in ((0, ("leg_press", "lat_pulldown")), (1, ("chest_press_machine", "leg_extension"))):
        if day == 1:
            page.click("#add-day")
            page.wait_for_selector("[data-day-card='1']")
        for ex in picks:
            page.click("[data-addex='%d']" % day)
            page.wait_for_selector("#picker")
            page.click("[data-pick='%s']" % ex)
            page.wait_for_selector("#builder[data-step='3']")
    for i, sel in enumerate(["[data-lift='0:0']", "[data-lift='0:1']", "[data-lift='1:0']", "[data-lift='1:1']"]):
        fill_change(page, sel + " .lift-nums input:nth-child(1)", "2")
        if i < 3:   # leg extension keeps no start weight, so its sets have no goal line (C23)
            fill_change(page, sel + " .lift-nums input:nth-child(4)", str(100 + 10 * i))
    page.click("#builder-next")
    page.wait_for_selector("#builder[data-step='4']")
    page.click("#block-save")
    page.wait_for_selector("#today[data-day]")
    settle(page)


def load_block_file(page, path, switch=True):
    go_route(page, "#/settings", "#settings")
    with page.expect_file_chooser() as fc:
        page.click("#load-block-row")
    fc.value.set_files(path)
    page.wait_for_selector("#block-sheet")
    page.click("#block-file-save")
    settle(page, 400)
    if page.locator("#switch-sheet").count():
        page.click("#switch-yes" if switch else "#switch-no")
    page.wait_for_selector("#today[data-day]")
    settle(page)


def marker(page):
    return page.evaluate("async () => { const { db } = await import('./db.js'); return db.setting('last_backup_at', null); }")


def due(page):
    return page.evaluate("async () => !!document.getElementById('backup-dot')")


def backup_download(page, answer, out_dir):
    go_route(page, "#/settings", "#settings")
    poll(page, "() => { const b = document.getElementById('backup-now'); return b && !b.disabled; }")
    with page.expect_download() as download_wait:
        page.click("#backup-now")
    download_file = download_wait.value
    os.makedirs(out_dir, exist_ok=True)
    # Two backups in one minute get the same suggested name; each saved copy keeps its own (C12).
    path = os.path.join(out_dir, "%d_%s" % (int(time.time() * 1000), download_file.suggested_filename))
    download_file.save_as(path)
    page.wait_for_selector("#saved-ask")
    page.click("#saved-yes" if answer else "#saved-no")
    settle(page, 400)
    return path


def restore_from(page, path, typed=True):
    go_route(page, "#/settings", "#settings")
    with page.expect_file_chooser() as fc:
        page.click("#restore-file")
    fc.value.set_files(path)
    settle(page, 600)
    if not page.locator("#restore-sheet").count():
        return "refused"
    if not typed:
        return "preview"
    page.fill("#restore-sheet .confirm-input", "RESTORE")
    with page.expect_navigation():
        page.click("#restore-go")
    page.wait_for_selector(".tabbar", timeout=15000)
    settle(page, 500)
    return "restored"


def make_at_copy(base, name, fixed=True, touch=False):
    """A temp copy of the other house app from its own git file list. The one-line cache
    fix is applied to this copy only (DESIGN 4.6 Local AT copy rule). Its folder is never touched."""
    src = os.environ.get("LIFTLOG_AT_DIR")
    if not src or not os.path.isdir(src):
        return None
    dst = os.path.join(base, name)
    shutil.rmtree(dst, ignore_errors=True)
    out = subprocess.run(["git", "-C", src, "ls-files"], capture_output=True, text=True, check=True).stdout
    for f in [x for x in out.split("\n") if x]:
        if f.startswith(("scripts/", "tests/")) or not os.path.exists(os.path.join(src, f)):
            continue
        os.makedirs(os.path.dirname(os.path.join(dst, f)), exist_ok=True)
        shutil.copy2(os.path.join(src, f), os.path.join(dst, f))
    sw = os.path.join(dst, "sw.js")
    text = open(sw).read()
    old = "keys.filter(k => k !== CACHE)"
    done_form = "keys.filter(k => k.startsWith('artic-') && k !== CACHE)"
    # Since its 7ef2e0a the other app ships the fix itself. A fixed copy keeps (or gets) the fixed
    # line; an unfixed copy (the twoapp control) gets the old line back. Each form must be found once.
    if text.count(old) + text.count(done_form) != 1:
        raise RuntimeError("the other app's cache filter line was not found once")
    if fixed:
        text = text.replace(old, done_form)
    else:
        text = text.replace(done_form, old)
    if touch:
        text += "\n// twoapp test build\n"
    open(sw, "w").write(text)
    return dst


def suite_slice1(browser, base, vp, local, cb, parts):
    tag = "[%s] " % vp
    o = urlparse(base)
    origin = o.scheme + "://" + o.netloc
    audit = Audit(origin)
    out_dir = os.path.join(LOG_DIR, "downloads")
    want = lambda name: (not parts) or name in parts

    def new(extra=()):
        ctx, page = new_context(browser, audit, standalone=True, vp=vp, extra=list(extra))
        page.set_default_timeout(10000)
        page.goto(base)
        page.wait_for_selector("#today > *", timeout=15000)
        wait_controller(page)
        settle(page, 300)
        return ctx, page

    # Logging by taps on a block built in the app.
    def part_log():
        ctx, page = new([TX_HANG])
        layout(page, tag, "set up")
        build_two_day_block(page)
        check(tag + "log: the built block opens on round 1 day A", page.inner_text("#day-position").strip() == "ROUND 1 · DAY A", page.inner_text("#day-position"))
        layout(page, tag, "today")
        s1 = tick(page)
        check(tag + "log: the first tick shows Done after its write", state_of(page, s1) == "done")
        page.reload(); page.wait_for_selector("#today[data-day]"); settle(page)
        check(tag + "log: reload mid day, the tick is still there", state_of(page, s1) == "done")
        sid = open_set(page)
        page.click(q(sid) + " [data-step='load+']"); settle(page, 400)
        page.click(q(sid) + " [data-step='load+']"); settle(page, 400)
        page.reload(); page.wait_for_selector("#today[data-day]"); settle(page)
        v = page.inner_text(q(sid) + " [data-val='load']").strip()
        check(tag + "log: two plus taps without a tick survive a reload as a draft, not done", v == "110" and state_of(page, sid) != "done", {"value": v, "state": state_of(page, sid)})
        layout(page, tag, "open set row")
        page.click(q(sid) + " [data-val='load']")
        page.wait_for_selector("[data-input='load']")
        page.keyboard.press("Meta+A")
        page.keyboard.type("102,5")
        page.click(q(sid) + " [data-tick]")
        wait_state(page, sid, "done")
        answer_fb(page, "save")
        page.reload(); page.wait_for_selector("#today[data-day]"); settle(page)
        v = page.inner_text(q(sid) + " [data-val='load']").strip()
        check(tag + "log: a comma decimal typed then ticked saves as 102.5 with a dot", v == "102.5" and state_of(page, sid) == "done", v)
        fbrows = page.evaluate("async () => { const { db } = await import('./db.js'); return (await db.all('feedback')).length; }")
        check(tag + "log: the feedback sheet after the last set of an exercise saves a row", fbrows == 1, fbrows)
        # Never-complete write: the row turns red and never shows Done (M12b).
        sid = open_set(page)
        page.evaluate("window.__hangTx = true")
        page.click(q(sid) + " [data-tick]")
        seen_done = False
        end = time.time() + 12
        while time.time() < end:
            st = state_of(page, sid)
            if st == "done":
                seen_done = True
            if st == "failed":
                break
            time.sleep(0.2)
        check(tag + "log: a write that never completes turns red with Not saved and never shows Done (M12b)",
              state_of(page, sid) == "failed" and not seen_done and "Not saved. Tap to retry." in page.inner_text(q(sid)), {"state": state_of(page, sid), "seen_done": seen_done})
        page.evaluate("window.__hangTx = false")
        page.reload(); page.wait_for_selector("#today[data-day]"); settle(page)
        # Add set, Skip set, Skip exercise, Swap exercise.
        n0 = page.locator("[data-slot='2'] .set").count()
        page.click("[data-addset='2']"); settle(page, 400)
        check(tag + "log: Add set adds a row", page.locator("[data-slot='2'] .set").count() == n0 + 1)
        page.click("[data-menu='2']"); page.click("#card-menu [data-item='1']"); settle(page, 400)
        check(tag + "log: Skip set marks one row skipped", page.locator("[data-slot='2'] .set[data-state='skipped']").count() == 1)
        answer_fb(page, "later")
        page.click("[data-menu='2']"); page.click("#card-menu [data-item='3']")
        page.wait_for_selector("#picker")
        layout(page, tag, "picker")
        page.click("[data-pick='cable_row']")
        page.wait_for_selector("#today[data-day]"); settle(page)
        check(tag + "log: Swap exercise adds a new card in a new slot", page.locator("[data-exercise='cable_row']").count() == 1)
        page.click("[data-exercise='cable_row'] [data-menu]"); page.click("#card-menu [data-item='2']"); settle(page, 400)
        answer_fb(page, "later")
        check(tag + "log: Skip exercise marks every set not done as skipped",
              page.locator("[data-exercise='cable_row'] .set[data-state='skipped']").count() == page.locator("[data-exercise='cable_row'] .set").count())
        # Finish: the pending sheet comes back, Skip leaves answers null, the day still finishes.
        ok = finish(page)
        check(tag + "log: Finish day runs the pending sheets and ends at the nudge", ok)
        days = page.evaluate("async () => { const { db } = await import('./db.js'); return (await db.all('days')).map(d => [d.day, d.pass, d.status]); }")
        check(tag + "log: round 1 day A is done and day B is planned", [1, 1, "done"] in days and [2, 1, "planned"] in days, days)
        # A set with no start weight still says why a typed number is refused (C23).
        ext = page.evaluate("() => { const r = document.querySelector(\"[data-exercise='leg_extension'] .set\"); return r ? r.getAttribute('data-set') : null; }")
        page.click(q(ext) + " [data-val='load']"); settle(page, 400)
        page.click(q(ext) + " [data-val='load']")
        page.wait_for_selector(q(ext) + " [data-input='load']")
        fill_change(page, q(ext) + " [data-input='load']", "9999")
        settle(page, 300)
        helper = page.locator(q(ext) + " .helper")
        shown = helper.count() == 1 and helper.is_visible() and helper.inner_text().strip() == "Use a number from 0 to 2000"
        check(tag + "log: a refused number on a set with no start weight shows the number line (C23)", shown,
              helper.inner_text() if helper.count() else "no helper")
        page.click("#day-label"); settle(page, 300)
        # Round 1 day B, then round 2 day A shows Last time equal to round 1 day A.
        while open_set(page):
            tick(page)
        finish(page)
        check(tag + "log: round 2 day A is next", page.inner_text("#day-position").strip() == "ROUND 2 · DAY A")
        last = page.inner_text("[data-exercise='leg_press'] .ex-last").strip()
        check(tag + "log: Last time on round 2 day A equals round 1 day A", last == "last 100 x 8, last 102.5 x 8", last)
        ctx.close()

    # The fixture block: checks, failure notes, the overall sheet, the PA2 Mac half offline.
    def part_block():
        ctx, page = new()
        page.click("#unit-lb")
        load_block_file(page, os.path.join(FIXTURES, "block_v1.json"))
        check(tag + "block: the block file loads on day A", page.inner_text("#day-label").strip() == "A")
        check(tag + "block: warmups show first with W", page.locator("[data-slot='1'] .set .set-no").first.inner_text().strip() == "W")
        check(tag + "block: a per hand load reads lb a hand and LR rows read 1L, 1R",
              "lb a hand" in page.inner_text("[data-slot='2']") and "1L" in page.inner_text("[data-slot='2']") and "1R" in page.inner_text("[data-slot='2']"))
        if local:
            local["server"].stop(); local["stopped"] = True
            ctx.set_offline(True)
            page.reload(); page.wait_for_selector("#today[data-day]"); settle(page)
            check(tag + "block: offline, the day still opens", page.locator("[data-slot='1']").count() == 1)
        while open_set(page) and open_set(page).split(":x")[1].startswith("1:"):
            tick(page)
        # Slot 2 (free weight): the failure toggle shows the machine note and still saves.
        sid = open_set(page)
        page.click(q(sid) + " #fail-toggle"); settle(page, 400)
        check(tag + "block: failure on a free weight shows the machine note", page.locator(q(sid) + " [data-note='machine']").count() == 1)
        tick(page, sid, fb="none")
        sid2 = open_set(page)
        page.click(q(sid2) + " #fail-toggle"); settle(page, 400)
        check(tag + "block: a second failure set shows the one-per-day note", page.locator(q(sid2) + " [data-note='onefail']").count() == 1)
        tick(page, sid2, fb="none")
        done = page.evaluate("async (id) => { const { db } = await import('./db.js'); const s = await db.get('sets', id); return s.status === 'done' && s.done.failure; }", sid2)
        check(tag + "block: the failure set still saves", done)
        while open_set(page) and open_set(page).split(":x")[1].startswith("2:"):
            tick(page, fb="none")
        settle(page, 400)
        if page.locator("#feedback").count():
            page.click("[data-answer='check-check_a-2']"); settle(page)
            # After the last set nothing is left to stop: the sheet shows the check.says line and no
            # Stop or Keep going button (R4-03, DESIGN 5.3, the r4 test named in 14 "a yes shows the
            # line and no Stop button", LOOK 4.4).
            says = page.inner_text("#feedback [data-stop='check_a']") if page.locator("#feedback [data-stop='check_a']").count() else ""
            check(tag + "block: a block check answered yes on the sheet shows the line and no Stop button",
                  page.is_visible("#feedback [data-stop='check_a']") and "Made-up stop note." in says
                  and page.locator("#feedback [data-stopnow], #feedback [data-keep]").count() == 0, says)
            layout(page, tag, "feedback sheet")
            page.click("#fb-save"); settle(page)
        else:
            check(tag + "block: a block check answered yes on the sheet shows the line and no Stop button", False, "no feedback sheet")
        while open_set(page):
            tick(page, fb="later")
        page.click("#finish-day")
        seen_overall = False
        for _ in range(10):
            settle(page, 300)
            if page.locator("#feedback").count():
                page.click("#fb-skip"); continue
            if page.locator("#overall").count():
                seen_overall = True
                layout(page, tag, "overall sheet")
                page.click("#overall [data-score='score_a-7']"); page.click("#day-save"); continue
            if page.locator("#nudge").count():
                break
        check(tag + "block: the Today overall sheet shows for a block with scores", seen_overall)
        page.click("#nudge-later"); settle(page); leave_day_done(page)
        fb = page.evaluate("async () => { const { db } = await import('./db.js'); return (await db.all('feedback')).filter(f => f.id.endsWith(':x3')).map(f => [f.pending, f.pump]); }")
        check(tag + "block: Ask me later then Skip at Finish leaves answers null, pending off", fb == [[False, None]], fb)
        # Back up through the download path and check the file on the Mac.
        path = backup_download(page, True, out_dir)
        rows3 = [r_ for r_ in json.load(open(path))["flat_log"] if ":x3:" in str(r_.get("set_id"))]
        check(tag + "block: the skipped answers are null in the backup's flat_log too (C22)",
              rows3 and all(r_["pump"] is None and r_["soreness"] is None and r_["workload"] is None for r_ in rows3), rows3[:1])
        r = subprocess.run(["node", os.path.join(APP_DIR, "scripts", "tests", "check_backup.mjs"), path], capture_output=True, text=True, env={**os.environ, "TZ": "America/New_York"})
        check(tag + "block: offline full day, backup by download, check_backup.mjs exit 0 (PA2 Mac half)", r.returncode == 0, r.stdout[-200:])
        flat = json.load(open(path))["flat_log"]
        check(tag + "block: flat_log carries the check and score columns from the block", flat and "check_check_a" in flat[0] and flat[0].get("score_score_a") == 7, flat[0] if flat else None)
        sample = os.environ.get("LIFTLOG_SAMPLE_OUT")
        if sample and vp == "440":
            os.makedirs(os.path.dirname(sample), exist_ok=True)
            shutil.copy2(path, sample)
        ctx.set_offline(False)
        ctx.close()

    # Backup marker, erase, undo, restore, refused files, the other app's data kept.
    def part_data():
        ctx, page = new([NO_SHARE])
        at = local.get("at") if local else None
        at_keys0 = []
        if at:
            p2 = new_page(ctx, audit)
            p2.goto(origin + "/articulation-trainer/")
            p2.wait_for_timeout(4000)
            at_keys0 = sorted(k for k in page.evaluate("caches.keys()") if k.startswith("artic-"))
        page.click("#unit-lb")
        load_block_file(page, os.path.join(FIXTURES, "block_v1.json"))
        while open_set(page):
            tick(page, fb="save")
        finish(page, score=5)
        path1 = backup_download(page, True, out_dir)
        m1 = marker(page)
        check(tag + "data: download path, Yes saved sets the marker", m1 is not None)
        layout(page, tag, "settings")
        go_route(page, "#/today", "#today[data-day]")
        tick(page, fb="save")
        go_route(page, "#/settings", "#settings")
        settle(page, 1500)
        check(tag + "data: an unbacked tick shows the Settings dot", due(page))
        path2 = backup_download(page, False, out_dir)
        check(tag + "data: No on a second backup leaves the marker", marker(page) == m1)
        before = dump(page)
        before_marker = marker(page)
        # Erase (type ERASE), then Undo last erase brings every store back.
        page.click("#erase-open")
        page.wait_for_selector("#erase-sheet")
        layout(page, tag, "erase sheet")
        check(tag + "data: Erase all data stays disabled until ERASE is typed", page.is_disabled("#erase-go"))
        page.fill("#erase-sheet .confirm-input", "ERASE")
        with page.expect_navigation():
            page.click("#erase-go")
        page.wait_for_selector(".tabbar"); settle(page, 500)
        blocks = page.evaluate("async () => { const { db } = await import('./db.js'); return [(await db.all('blocks')).length, (await db.all('exercises')).length]; }")
        go_route(page, "#/today", "#today > *")
        check(tag + "data: Erase empties the data and the seed comes back", blocks[0] == 0 and blocks[1] > 30 and page.locator("#setup, #no-block").count() == 1, blocks)
        go_route(page, "#/settings", "#settings")
        page.click("#undo-row"); page.wait_for_selector("#undo-sheet")
        page.click("#undo-sheet [data-snap]")
        page.wait_for_selector("#restore-sheet")
        page.fill("#restore-sheet .confirm-input", "RESTORE")
        with page.expect_navigation():
            page.click("#restore-go")
        page.wait_for_selector(".tabbar"); settle(page, 500)
        now_ = dump(page)
        check(tag + "data: Undo last erase brings every store back, the marker too", now_ == before and marker(page) == before_marker, differs(now_, before))
        # Restore the first file: the stores equal the state when it was made.
        go_route(page, "#/settings", "#settings")
        res = restore_from(page, path1, typed=False)
        newer = page.inner_text("#restore-newer") if page.locator("#restore-newer").count() else ""
        check(tag + "data: a restore preview shows before anything is written", res == "preview", res)
        page.click("#restore-cancel")
        check(tag + "data: Cancel changes nothing", dump(page) == before)
        # Restore the OLDER file onto different phone data: every store must equal the file (C12).
        res = restore_from(page, path1)
        now_ = dump(page)
        want1 = file_dump(path1)
        check(tag + "data: Restore an older file, every store equal to that file and not to the phone before",
              res == "restored" and norm_dump(now_) == want1 and now_ != before, differs(norm_dump(now_), want1))
        # Then the newer file: the phone moves back to it, every store equal.
        res = restore_from(page, path2)
        now_ = dump(page)
        check(tag + "data: Restore the file, every store equal to before", res == "restored" and now_ == before and norm_dump(now_) == file_dump(path2), differs(now_, before))
        # An older file: the warning shows the right day count; Undo last restore brings it back.
        go_route(page, "#/today", "#today[data-day]")
        while open_set(page):
            tick(page, fb="save")
        finish(page, score=6)
        before2 = dump(page)
        res = restore_from(page, path2, typed=False)
        newer = page.inner_text("#restore-newer").strip() if page.locator("#restore-newer").count() else ""
        check(tag + "data: an older file warns about the finished days it would remove", newer.startswith("1 finished days on this phone"), newer)
        page.fill("#restore-sheet .confirm-input", "RESTORE")
        with page.expect_navigation():
            page.click("#restore-go")
        page.wait_for_selector(".tabbar"); settle(page, 500)
        mid = dump(page)
        check(tag + "data: the older-file restore wrote the file's rows, not the phone's (C12)",
              norm_dump(mid) == file_dump(path2) and mid != before2, differs(norm_dump(mid), file_dump(path2)))
        go_route(page, "#/settings", "#settings")
        page.click("#undo-row"); page.wait_for_selector("#undo-sheet")
        page.click("#undo-sheet [data-snap]")
        page.wait_for_selector("#restore-sheet")
        page.fill("#restore-sheet .confirm-input", "RESTORE")
        with page.expect_navigation():
            page.click("#restore-go")
        page.wait_for_selector(".tabbar"); settle(page, 500)
        check(tag + "data: Undo last restore brings every store back", dump(page) == before2)
        # Open a day, restore, tap one set: every restored row is the same but that set.
        go_route(page, "#/today", "#today[data-day]")
        tick(page, fb="save")
        pre = dump(page)
        res = restore_from(page, path2)
        check(tag + "data: the restore before the one tap changed the phone (C12)", dump(page) != pre)
        restored = json.loads(dump(page))
        go_route(page, "#/today", "#today[data-day]")
        sid = tick(page, fb="save")
        after = json.loads(dump(page))
        diff = [r_["id"] for r_ in after["sets"] if r_ not in restored["sets"]]
        others = all(after[k] == restored[k] for k in ("blocks", "exercises", "templates"))
        check(tag + "data: restore then one tap changes only that set", res == "restored" and diff == [sid] and others, {"diff": diff[:3], "sid": sid})
        # Refused files: truncated, newer schema, unknown store. Nothing changes.
        before3 = dump(page)
        bad_dir = os.path.join(out_dir, "bad")
        os.makedirs(bad_dir, exist_ok=True)
        good = json.load(open(path2))
        variants = {"truncated.json": open(path2).read()[:500]}
        g = json.loads(json.dumps(good)); g["schema"] = 9; variants["newer.json"] = json.dumps(g)
        g = json.loads(json.dumps(good)); g["stores"]["extra"] = []; g["counts"]["extra"] = 0; variants["unknown.json"] = json.dumps(g)
        refused = []
        for name, text in variants.items():
            fp = os.path.join(bad_dir, name)
            open(fp, "w").write(text)
            refused.append(restore_from(page, fp, typed=False))
        check(tag + "data: a truncated, a newer-schema and an unknown-store file are refused, nothing changes",
              refused == ["refused"] * 3 and dump(page) == before3, refused)
        if at:
            st = page.evaluate("""async () => ({ dbs: (await indexedDB.databases()).map(d => d.name), keys: await caches.keys() })""")
            keys1 = sorted(k for k in st["keys"] if k.startswith("artic-"))
            check(tag + "data: after erase and restore the other app's database and every one of its caches are still there",
                  "artic" in st["dbs"] and at_keys0 and keys1 == at_keys0, {"dbs": st["dbs"], "before": at_keys0, "after": keys1})
        else:
            check(tag + "data: the other app's copy is loaded for this check (LIFTLOG_AT_DIR)", False, "LIFTLOG_AT_DIR not set")
        ctx.close()

    # Share path: resolve sets the marker; AbortError leaves it and the dot (M18).
    def part_share():
        ctx, page = new([SHARE_STUB])
        page.click("#unit-lb")
        load_block_file(page, os.path.join(FIXTURES, "block_v1.json"))
        tick(page, fb="save")
        go_route(page, "#/settings", "#settings")
        poll(page, "() => { const b = document.getElementById('backup-now'); return b && !b.disabled; }")
        page.evaluate("window.__shareMode = 'abort'")
        page.click("#backup-now"); settle(page, 800)
        check(tag + "share: AbortError leaves the marker and the dot (M18)", marker(page) is None and due(page), {"marker": marker(page)})
        page.evaluate("window.__shareMode = 'resolve'")
        poll(page, "() => { const b = document.getElementById('backup-now'); return b && !b.disabled; }")
        page.click("#backup-now"); settle(page, 800)
        shared = page.evaluate("window.__shared")
        ok = page.evaluate("""async (text) => { const { validateBackup } = await import('./backup.js'); return validateBackup(text, { now: Date.now() }).ok; }""", shared or "")
        check(tag + "share: a resolved share hands over a file that passes validateBackup and sets the marker", ok and marker(page) is not None)
        settle(page, 1500)
        check(tag + "share: the dot goes away after the backup", not due(page))
        ctx.close()

    # Keep-awake: the release listener (M22), and the link-close retry.
    def part_wake():
        ctx, page = new([WAKE_COUNT])
        page.click("#unit-lb")
        load_block_file(page, os.path.join(FIXTURES, "block_v1.json"))
        tick(page, fb="save")
        settle(page, 300)
        asks = page.evaluate("window.__wakeAsks")
        page.evaluate("() => window.__sentinels[window.__sentinels.length - 1].release()")
        settle(page, 200)
        page.evaluate(VIS); settle(page, 400)
        a1 = page.evaluate("window.__wakeAsks") - asks
        check(tag + "wake case 1: after a release, visible again asks once more (M22)", a1 == 1, {"asks": a1})
        a0 = page.evaluate("window.__wakeAsks")
        page.evaluate(VIS); settle(page, 400)
        check(tag + "wake case 2: with the lock held, visible again asks nothing", page.evaluate("window.__wakeAsks") == a0)
        page.evaluate("async () => { const { db } = await import('./db.js'); db.closeForTest(); }")
        sid = tick(page, fb="save")
        page.reload(); page.wait_for_selector("#today[data-day]"); settle(page)
        check(tag + "wake: closeForTest, then a set still saves", state_of(page, sid) == "done")
        ctx.close()

    # Offline the same way as Slice 0 item (4): log a set, reload, it is still there.
    def part_offline():
        if not local:
            return
        ctx, page = new()
        page.click("#unit-lb")
        load_block_file(page, os.path.join(FIXTURES, "block_v1.json"))
        page.reload(); page.wait_for_selector("#today[data-day]")
        local["server"].stop(); local["stopped"] = True
        ctx.set_offline(True)
        page.close()
        page = new_page(ctx, audit)
        page.goto(base)
        page.wait_for_selector("#today[data-day]", timeout=15000); settle(page)
        sid = tick(page, fb="save")
        page.reload(); page.wait_for_selector("#today[data-day]"); settle(page)
        check(tag + "offline: a set logged with no server and no network is there after a reload", state_of(page, sid) == "done")
        # From 0.3.0 the Block tab shows the Block overview (16 B.1 step 8); from 0.4.0 History is built (17 C.3.12).
        go_route(page, "#/block", "#block #round-grid")
        check(tag + "offline: the block tab shows the Block overview", page.locator("#block [data-blockday]").count() >= 1)
        layout(page, tag, "block tab")
        go_route(page, "#/history", "#history > *")
        check(tag + "offline: the history tab shows Coming next", page.locator("#history h1").count() == 1 and page.inner_text("#history").find("Coming next") < 0)
        layout(page, tag, "history tab")
        ctx.set_offline(False)
        ctx.close()

    # Slice 1 polish pass, stage 1 (DESIGN 15 P.1 steps 0 and 1; 14.4 A1-3, A3-R1, A3-R6, A3-R8, A4-1).
    # Each check title below is the expect text of its planted row in mutants.js.
    def toast_text(page):
        return page.evaluate("() => { const t = document.querySelector('.toast.is-on'); return t ? t.textContent : null; }")

    def one_round_one_day_block():
        f = json.load(open(os.path.join(FIXTURES, "block_v1.json")))
        f["source_id"] = "polish-one-day"
        f["block"]["passes"] = 1
        f["block"]["day_templates"] = [f["block"]["day_templates"][0]]
        os.makedirs(out_dir, exist_ok=True)
        path = os.path.join(out_dir, "block_one_round_one_day.json")
        json.dump(f, open(path, "w"))
        return path

    def builder_day_a(page, picks):
        go_route(page, "#/builder", "#builder[data-step='1']")
        page.fill("#block-name", "Polish block")
        page.click("#builder-next")
        page.wait_for_selector("#builder[data-step='2']")
        page.click("#builder-next")
        page.wait_for_selector("#builder[data-step='3']")
        for ex in picks:
            page.click("[data-addex='0']")
            page.wait_for_selector("#picker")
            page.click("[data-pick='%s']" % ex)
            page.wait_for_selector("#builder[data-step='3']")

    def part_polish():
        # --case NAME runs only the named cases of polish_parts (a fix loop rerun; never a green run).
        if CASES:
            for fn in polish_parts:
                if fn.__name__ in CASES:
                    section(tag + "polish " + fn.__name__, fn)
            return
        # A3-R8: a good restore shows the Restored line once; a second reload shows nothing.
        ctx, page = new([NO_SHARE, TEXT_SPY, LOAD_COUNT])
        page.click("#unit-lb")
        load_block_file(page, os.path.join(FIXTURES, "block_v1.json"))
        tick(page, fb="save")
        path = backup_download(page, True, out_dir)
        loads0 = page.evaluate("window.__loads")
        res = restore_from(page, path)
        line = toast_text(page)
        check(tag + "polish: a good restore shows the Restored line with its row count (A3-R8)",
              res == "restored" and bool(line) and re.match(r"^Restored\. \d+ rows checked\.$", line or "") is not None, line)
        # A3-R1 (b): the good restore reloaded the page exactly once.
        check(tag + "polish: (b) a good restore reloads exactly once (A3-R1)", page.evaluate("window.__loads") - loads0 == 1, page.evaluate("window.__loads") - loads0)
        page.reload(); page.wait_for_selector(".tabbar"); settle(page, 1500)
        check(tag + "polish: a second reload shows no Restored line (A3-R8)", toast_text(page) is None, toast_text(page))
        # A3-R1 (a): a restore whose write fails shows the bad line, keeps the page and changes nothing.
        before = dump(page)
        page.evaluate("async () => { const { db } = await import('./db.js'); window.__keep = 41; db.replaceAll = () => Promise.reject(new DOMException('test', 'AbortError')); }")
        go_route(page, "#/settings", "#settings")
        with page.expect_file_chooser() as fc:
            page.click("#restore-file")
        fc.value.set_files(path)
        page.wait_for_selector("#restore-sheet")
        page.fill("#restore-sheet .confirm-input", "RESTORE")
        page.click("#restore-go")
        # T1: the toast lasts --toast-ms (3000 ms; 6000 ms once it wraps, B4) and the failure is fast, so read it the moment the
        # failed line shows, then wait out the rest of the 4 s no-reload window (A3-R1).
        try:
            page.wait_for_selector("#restore-failed", state="visible", timeout=4000)
        except Exception:
            pass
        failed_toast = toast_text(page)
        settle(page, 3500)
        kept = page.evaluate("window.__keep === 41")
        bad_line = page.locator("#restore-failed").count() and page.is_visible("#restore-failed")
        page.evaluate("async () => { delete (await import('./db.js')).db.replaceAll; }")
        check(tag + "polish: (a) a failed restore shows its line, never reloads and changes nothing (A3-R1)",
              kept and bool(bad_line) and (failed_toast or "").startswith("This file could not be read") and dump(page) == before,
              {"kept": kept, "line": bad_line, "toast": failed_toast})
        page.reload(); page.wait_for_selector(".tabbar"); settle(page, 800)
        # A4-1: a 65 MiB pick shows the too-big line and its text is never read; a 1 MiB good file restores.
        big = os.path.join(out_dir, "too_big.json")
        with open(big, "wb") as fh:
            fh.truncate(65 * 1048576 + 1)
        reads0 = page.evaluate("window.__textReads")
        go_route(page, "#/settings", "#settings")
        with page.expect_file_chooser() as fc:
            page.click("#restore-file")
        fc.value.set_files(big)
        settle(page, 1200)
        check(tag + "polish: a 65 MiB pick shows the too big line and is never read (A4-1)",
              toast_text(page) == "This file is over 64 MB, too big to open here. Nothing was changed." and page.evaluate("window.__textReads") == reads0,
              {"toast": toast_text(page), "reads": page.evaluate("window.__textReads") - reads0})
        padded = os.path.join(out_dir, "one_mib.json")
        text = open(path).read()
        open(padded, "w").write(text + " " * max(0, 1048576 - len(text)))
        check(tag + "polish: a 1 MiB good file restores (A4-1)", restore_from(page, padded) == "restored")
        os.remove(big)
        ctx.close()

        # A1-3: every control has a name; a refused link says why.
        ctx, page = new()
        page.click("#unit-lb")
        load_block_file(page, os.path.join(FIXTURES, "block_v1.json"))
        names = page.evaluate("() => [...document.querySelectorAll('[data-tick]')].map(b => b.getAttribute('aria-label') || '')")
        check(tag + "polish: every set tick has a name (A1-3)", bool(names) and all(names), names[:3])
        tallies = page.evaluate("() => [...document.querySelectorAll('.tally')].map(t => [t.getAttribute('aria-label') || '', t.hasAttribute('aria-hidden')])")
        check(tag + "polish: every tally is named and not hidden (A1-3)", bool(tallies) and all(n and not h for n, h in tallies), tallies[:3])
        tick(page, fb="save")
        settle(page, 1500)
        tab = page.get_attribute("a.tab[data-tab='#/settings']", "aria-label")
        check(tag + "polish: the Settings tab names a due backup in words (A1-3)", tab == "Settings, changes not backed up", tab)
        page.click("[data-menu]")
        page.wait_for_selector("#card-menu")
        page.click("#card-menu [data-item='5']")
        page.wait_for_selector("#text-sheet")
        page.fill("#ex-text", "http://plain.example")
        page.click("#ex-text-save")
        settle(page, 300)
        shown = page.is_visible("#ex-text-bad") and page.inner_text("#ex-text-bad").strip() == "Use a link that starts with https://"
        check(tag + "polish: a refused video link shows the link line (A1-3)", shown, page.inner_text("#text-sheet")[:120])
        page.click("#ex-text-clear")
        settle(page, 300)
        check(tag + "polish: Clear link closes the sheet with no link", page.locator("#text-sheet").count() == 0)
        # C39: a scrim tap on the feedback sheet leaves it open (PD19).
        go_route(page, "#/today", "#today[data-day]")
        first = page.evaluate("() => document.querySelector('.ex-card').getAttribute('data-slot')")
        while True:
            sid = page.evaluate("(sl) => { const r = document.querySelector('.ex-card[data-slot=\"' + sl + '\"] .set.is-open, .ex-card[data-slot=\"' + sl + '\"] .set.is-todo'); return r ? r.getAttribute('data-set') : null; }", first)
            if not sid:
                break
            tick(page, sid, fb="none")
            if page.locator("#feedback").count():
                break
        page.wait_for_selector("#feedback")
        scrim_tap(page)
        settle(page, 400)
        check(tag + "polish: C39 a scrim tap on the feedback sheet leaves it open", page.locator("#feedback").count() == 1)
        page.click("#fb-save")
        ctx.close()

        # C27: a finished 1-round 1-day block shows Block finished with Build and Load (PD16).
        ctx, page = new()
        page.click("#unit-lb")
        load_block_file(page, one_round_one_day_block())
        while open_set(page):
            tick(page, fb="save")
        finish(page)
        go_route(page, "#/today", "#today > *")
        # Slice 3 (17 C.3.9): the row holds Start a new block and Copy this block, no Load.
        check(tag + "polish: C27 a finished block shows Block finished with Start a new block and Copy this block",
              page.locator("#block-done").count() == 1 and page.locator("#block-done #fin-new").count() == 1 and page.locator("#block-done #fin-copy").count() == 1,
              page.inner_text("#today")[:120])
        ctx.close()

        # C32 and C41: builder reorder and start weight steps (PD18, PD20).
        ctx, page = new()
        page.click("#unit-lb")
        build_click(page, "#setup-build") if page.locator("#setup-build").count() else None
        builder_day_a(page, ("leg_press", "lat_pulldown"))
        fill_change(page, "[data-lift='0:0'] .lift-nums input:nth-child(4)", "100")
        page.click("[data-loadstep='0:0+']")
        settle(page, 200)
        check(tag + "polish: C41 start weight plus on a lift with steps 5 goes 100 to 105",
              page.input_value("[data-lift='0:0'] .lift-nums input:nth-child(4)") == "105", page.input_value("[data-lift='0:0'] .lift-nums input:nth-child(4)"))
        both = page.locator("[data-move='0:0up']").count() == 1 and page.is_disabled("[data-move='0:0up']") and page.locator("[data-move='0:1down']").count() == 1 and page.is_disabled("[data-move='0:1down']")
        page.click("[data-move='0:1up']")
        settle(page, 200)
        page.click("#builder-next")
        page.wait_for_selector("#builder[data-step='4']")
        page.click("#block-save")
        page.wait_for_selector("#today[data-day]")
        settle(page)
        got = page.evaluate("""async () => { const { db } = await import('./db.js'); const id = await db.setting('active_block_id', null);
            const b = await db.get('blocks', id); const sets = await db.all('sets');
            return { order: b.day_templates[0].lifts.map(l => [l.slot, l.exercise_id]),
                     slots: [...new Set(sets.filter(s => s.block_id === id && s.day_id.endsWith(':p1:d1')).map(s => s.slot + ':' + s.exercise_id))].sort() }; }""")
        check(tag + "polish: C32 Move up then Save, the block and the planned slots follow, both end buttons kept disabled",
              both and got["order"] == [[1, "lat_pulldown"], [2, "leg_press"]] and got["slots"] == ["1:lat_pulldown", "2:leg_press"], got)
        ctx.close()

        # Stage 4 A3 (14.8 CHANGE A3): a kg build steps the start weight 1 kg on a step 5 row.
        ctx, page = new()
        page.click("#unit-kg")
        build_click(page, "#setup-build") if page.locator("#setup-build").count() else None
        builder_day_a(page, ("leg_press",))
        fill_change(page, "[data-lift='0:0'] .lift-nums input:nth-child(4)", "20")
        page.click("[data-loadstep='0:0+']")
        settle(page, 200)
        got = page.input_value("[data-lift='0:0'] .lift-nums input:nth-child(4)")
        check(tag + "polish: A3 a kg build steps the start weight in kg, plus on 20 gives 21", got == "21", got)
        ctx.close()

        # Stage 4 N3: a kept lb draft, the unit then switched to kg in Settings, Keep my draft and
        # Save: the block is lb and its start weight is the lb step he made.
        ctx, page = new()
        page.click("#unit-lb")
        build_click(page, "#setup-build") if page.locator("#setup-build").count() else None
        builder_day_a(page, ("leg_press",))
        fill_change(page, "[data-lift='0:0'] .lift-nums input:nth-child(4)", "100")
        page.click("[data-loadstep='0:0+']")
        settle(page, 200)
        page.click("#builder-cancel")
        page.wait_for_selector("#build-block")
        go_route(page, "#/settings", "#units [data-k='kg']")
        page.click("#units [data-k='kg']")
        settle(page, 300)
        go_route(page, "#/today", "#build-block")
        build_click(page, "#build-block")
        # No draft ask: this case fails by its own name and the part goes on (PD28 is caught by Part 4).
        try:
            page.wait_for_selector("#draft-sheet", timeout=5000)
            asked_n3 = True
        except Exception:
            asked_n3 = False
        got = {"draft ask": False}
        if asked_n3:
            page.click("#draft-keep")
            page.wait_for_selector("#builder[data-step='3']")
            page.click("[data-loadstep='0:0+']")
            settle(page, 200)
            page.click("#builder-next")
            page.wait_for_selector("#builder[data-step='4']")
            page.click("#block-save")
            page.wait_for_selector("#today[data-day]")
            settle(page)
            got = page.evaluate("""async () => { const { db } = await import('./db.js'); const id = await db.setting('active_block_id', null);
                const b = await db.get('blocks', id); return { unit: b.unit, load: b.day_templates[0].lifts[0].start_load }; }""")
        check(tag + "polish: N3 a kept lb draft saved after the unit moved to kg is an lb block", got == {"unit": "lb", "load": 110}, got)
        ctx.close()

        for fn in polish_parts:
            section(tag + "polish " + fn.__name__, fn)

    # Slice 1 polish pass, stage 2 (DESIGN 15 P.2 parts 1 to 12). Written and compile-checked in a
    # light job; each title is the expect text of its planted row in mutants.js.
    def active_block(page):
        return page.evaluate("""async () => { const { db } = await import('./db.js'); const id = await db.setting('active_block_id', null);
            const b = id ? await db.get('blocks', id) : null; const days = (await db.all('days')).filter(d => b && d.block_id === b.id);
            const sets = (await db.all('sets')).filter(s => b && s.block_id === b.id);
            return b ? { name: b.name, lifts: b.day_templates.map(d => d.lifts.map(l => [l.slot, l.exercise_id])), labels: b.day_templates.map(d => d.label),
                         days: days.map(d => [d.id, d.status, d.label, d.slot_order]), sets: sets.map(s => [s.id, s.slot, s.set_n, s.status, s.draft, s.kind]) } : null; }""")

    def to_review_and_save(page):
        page.click("#builder-next")
        page.wait_for_selector("#builder[data-step='4']")
        page.click("#block-save")
        page.wait_for_selector("#today[data-day]")
        settle(page)

    def polish_builder():
        # Part 2: a blank name saves the default name and opens round 1 day 1 (BW11).
        ctx, page = new()
        page.click("#unit-lb")
        build_click(page, "#setup-build")
        page.wait_for_selector("#builder[data-step='1']")
        settle(page, 300)
        ph = page.get_attribute("#block-name", "placeholder")
        page.click("#builder-next"); page.wait_for_selector("#builder[data-step='2']")
        page.click("#builder-next"); page.wait_for_selector("#builder[data-step='3']")
        page.click("[data-addex='0']"); page.wait_for_selector("#picker")
        page.click("[data-pick='leg_press']"); page.wait_for_selector("#builder[data-step='3']")
        to_review_and_save(page)
        b = active_block(page)
        check(tag + "polish: Save with a blank name opens round 1 day 1 with the default name (Part 2)",
              ph == "Block 1" and b["name"] == "Block 1" and page.inner_text("#day-position").strip() == "ROUND 1 · DAY A", {"placeholder": ph, "name": b["name"]})
        ctx.close()

        # Part 3: one tap removes the middle exercise; Save keeps the other two in order (S06, BW8).
        ctx, page = new()
        page.click("#unit-lb")
        build_click(page, "#setup-build")
        builder_day_a(page, ("leg_press", "lat_pulldown", "leg_extension"))
        layout(page, tag, "builder step 3 with the remove buttons")
        page.click("[data-remove='0:1']")
        settle(page, 200)
        no_sheet = page.locator(".sheet").count() == 0
        to_review_and_save(page)
        b = active_block(page)
        day1 = sorted(set(s[1] for s in b["sets"] if ":p1:d1:" in s[0]))
        check(tag + "polish: builder remove the middle exercise then Save (Part 3)",
              no_sheet and b["lifts"] == [[[1, "leg_press"], [2, "leg_extension"]]] and day1 == [1, 2], {"lifts": b["lifts"], "slots": day1})
        ctx.close()

        # Part 3: a day with no exercise left blocks Save and names the day.
        ctx, page = new()
        page.click("#unit-lb")
        build_click(page, "#setup-build")
        builder_day_a(page, ("leg_press",))
        page.click("#add-day"); page.wait_for_selector("[data-day-card='1']")
        page.click("[data-addex='1']"); page.wait_for_selector("#picker")
        page.click("[data-pick='lat_pulldown']"); page.wait_for_selector("#builder[data-step='3']")
        page.click("[data-remove='1:0']")
        settle(page, 200)
        page.click("#builder-next"); page.wait_for_selector("#builder[data-step='4']")
        line = page.locator("[data-dayempty='1']").count() == 1 and "has no exercise yet" in page.inner_text("[data-dayempty='1']")
        # The line starts with our info glyph, hidden from a screen reader (14.8 G18c, review P21 c).
        info = page.evaluate("() => { const r = document.querySelector(\"[data-dayempty='1']\"); const g = r && r.firstElementChild; return !!g && g.tagName.toLowerCase() === 'svg' && g.getAttribute('aria-hidden') === 'true'; }")
        line = line and info
        layout(page, tag, "review with the empty-day line")
        shot(page, "polish_builder_review_empty_%s.png" % vp)   # LB1, P.1 step 7
        check(tag + "polish: a day with no exercise blocks Save and shows its line (Part 3)", page.is_disabled("#block-save") and line,
              page.inner_text("#builder-review")[:160])
        ctx.close()

        # Part 4: Cancel keeps a typed draft, and Build a block asks about it first (B10; 14.8 G4,
        # review P13). Every step is a tap he can make: no hash jump. The first tap on Set up saves
        # the unit, so Today then shows the No block screen and its button is #build-block (T3).
        ctx, page = new()
        page.click("#unit-lb")
        build_click(page, "#setup-build")
        page.wait_for_selector("#builder[data-step='1']")
        page.fill("#block-name", "Kept draft")
        page.click("#builder-cancel")
        page.wait_for_selector("#build-block")
        build_click(page, "#build-block")
        # No ask sheet: the case fails here by its own name, never on a wait timeout.
        try:
            page.wait_for_selector("#draft-sheet", timeout=5000)
        except Exception:
            pass
        asked = page.locator("#draft-sheet").count() == 1
        kept = fresh = no_ask = False
        if asked:
            layout(page, tag, "draft ask sheet")
            page.click("#draft-keep")
            page.wait_for_selector("#builder[data-step='1']")
            kept = page.input_value("#block-name") == "Kept draft"
            page.click("#builder-cancel")
            page.wait_for_selector("#build-block")
            build_click(page, "#build-block")
            page.wait_for_selector("#draft-sheet")
            page.click("#draft-over")
            page.wait_for_selector("#builder[data-step='1']")
            fresh = page.input_value("#block-name") == ""
            page.click("#builder-cancel")
            page.wait_for_selector("#build-block")
            build_click(page, "#build-block")
            page.wait_for_selector("#builder[data-step='1']")
            settle(page, 300)
            no_ask = page.locator("#draft-sheet").count() == 0
        check(tag + "polish: Build a block with a draft asks first (Part 4)", asked and kept and fresh and no_ask,
              {"asked": asked, "kept": kept, "fresh": fresh, "no_ask": no_ask})
        ctx.close()

    def relabel(page, value=None, look=False):
        page.click("#day-menu")
        page.wait_for_selector("#day-menu-sheet")
        if look:
            layout(page, tag, "day menu sheet")
        page.click("#day-menu-sheet [data-dayitem='relabel']")
        page.wait_for_selector("#relabel-sheet")
        if look:
            layout(page, tag, "relabel sheet")
        if value is None:
            page.click("#relabel-clear")
        else:
            page.fill("#relabel-in", value)
            page.click("#relabel-save")
        page.wait_for_selector("#relabel-sheet", state="detached")
        settle(page, 400)

    def polish_relabel():
        # Part 1: relabel today (E14), clear it (B04, G25), and an unlabeled day from the builder.
        ctx, page = new()
        page.click("#unit-lb")
        load_block_file(page, os.path.join(FIXTURES, "block_v1.json"))
        relabel(page, "Z", look=True)
        z = page.inner_text("#day-label").strip() == "Z" and page.inner_text("#day-position").strip().endswith("DAY Z")
        check(tag + "polish: relabel to Z shows Z (Part 1)", z, page.inner_text(".day-head"))
        relabel(page, None)
        h1 = page.inner_text("#day-label").strip()
        pos = page.inner_text("#day-position").strip()
        check(tag + "polish: cleared label shows the numbered name (Part 1)", h1 == "Day 1" and pos == "ROUND 1 · DAY 1", {"h1": h1, "position": pos})
        page.reload(); page.wait_for_selector("#today[data-day]"); settle(page)
        check(tag + "polish: a cleared label is still cleared after a reload (Part 1)", page.inner_text("#day-label").strip() == "Day 1")
        ctx.close()

        ctx, page = new()
        page.click("#unit-lb")
        build_click(page, "#setup-build")
        builder_day_a(page, ("leg_press",))
        page.click("[data-relabel='0']")
        page.wait_for_selector("#relabel-sheet")
        page.click("#relabel-clear")
        page.wait_for_selector("#relabel-sheet", state="detached")
        to_review_and_save(page)
        check(tag + "polish: a block built with one unlabeled day shows the numbered name on round 1 (Part 1)",
              page.inner_text("#day-label").strip() == "Day 1" and active_block(page)["labels"] == [""], page.inner_text(".day-head"))
        ctx.close()

    def polish_helper():
        # Part 5: a block with no start weight opens round 1 with empty weight boxes and the no-weight line (W02, CW1).
        ctx, page = new()
        page.click("#unit-lb")
        build_click(page, "#setup-build")
        builder_day_a(page, ("leg_press", "lat_pulldown"))
        to_review_and_save(page)
        sid = open_set(page)
        boxes = page.evaluate("() => [...document.querySelectorAll('.set [data-val=\\'load\\']')].map(b => b.textContent)")
        helper = page.inner_text(q(sid) + " .helper").strip()
        check(tag + "polish: no start weight shows empty boxes and the no-weight line (Part 5)",
              bool(boxes) and all(b == "" for b in boxes) and helper == "no weight yet, 8-12 reps", {"boxes": boxes[:3], "helper": helper})
        ctx.close()

    def three_set_block(page, start="100"):
        """Day A: leg press 3 sets at the given start weight, then lat pulldown 3 sets. Saved from the builder."""
        page.click("#unit-lb")
        build_click(page, "#setup-build")
        builder_day_a(page, ("leg_press", "lat_pulldown"))
        for sel in ("[data-lift='0:0']", "[data-lift='0:1']"):
            fill_change(page, sel + " .lift-nums input:nth-child(1)", "3")
            fill_change(page, sel + " .lift-nums input:nth-child(4)", start)
        to_review_and_save(page)

    def slot_rows(page, slot=1):
        return page.evaluate("""(sl) => [...document.querySelectorAll('.ex-card[data-slot="' + sl + '"] .set')].map(r => [r.getAttribute('data-set'), r.getAttribute('data-state'), (r.querySelector("[data-val='load']") || {}).textContent])""", slot)

    def polish_copy():
        # Part 6: weight plus twice on set 1, reload: sets 2 and 3 show the new weight, not done (L01).
        ctx, page = new()
        three_set_block(page)
        sid = open_set(page)
        page.click(q(sid) + " [data-step='load+']"); settle(page, 400)
        page.click(q(sid) + " [data-step='load+']"); settle(page, 400)
        page.reload(); page.wait_for_selector("#today[data-day]"); settle(page)
        rows = slot_rows(page)
        check(tag + "polish: weight plus twice on set 1, reload, later sets show it (Part 6)",
              [r[2] for r in rows] == ["110", "110", "110"] and all(r[1] != "done" for r in rows), rows)
        ctx.close()

    def polish_carry():
        # Part 7: the switch reads Off by default (R42, S18); On, set 1 from 100 to 105 moves a typed 100 too (DW5).
        ctx, page = new([NO_SHARE])
        three_set_block(page)
        go_route(page, "#/settings", "#settings")
        settle(page, 400)
        off = page.get_attribute("#carry-switch", "aria-checked") == "false" and "Off" in page.inner_text("#carry-switch")
        page.click("#carry-switch"); settle(page, 400)
        on = page.get_attribute("#carry-switch", "aria-checked") == "true" and "On" in page.inner_text("#carry-switch")
        page.reload(); page.wait_for_selector(".tabbar"); go_route(page, "#/settings", "#settings"); settle(page, 400)
        kept = page.get_attribute("#carry-switch", "aria-checked") == "true"
        check(tag + "polish: switch reads Off by default, On after a tap and a reload (Part 7)", off and on and kept, {"off": off, "on": on, "kept": kept})
        go_route(page, "#/today", "#today[data-day]")
        rows = slot_rows(page)
        page.evaluate("""async (id) => { const { db } = await import('./db.js'); const s = await db.get('sets', id);
            s.draft = { load: 100, reps: 8, reps_left: null, reps_left_plus: false, failure: false, from_copy: false }; await db.put('sets', s); }""", rows[2][0])
        page.reload(); page.wait_for_selector("#today[data-day]"); settle(page)
        sid = open_set(page)
        page.click(q(sid) + " [data-step='load+']"); settle(page, 500)
        page.reload(); page.wait_for_selector("#today[data-day]"); settle(page)
        loads = [r[2] for r in slot_rows(page)]
        check(tag + "polish: switch on, 100 to 105 moves later sets that read 100 (Part 7)", loads == ["105", "105", "105"], loads)
        path = backup_download(page, True, out_dir)
        held = any(r.get("key") == "carry_down" and r.get("value") is True for r in json.load(open(path))["stores"]["settings"])
        go_route(page, "#/settings", "#settings"); page.click("#carry-switch"); settle(page, 400)
        res = restore_from(page, path)
        go_route(page, "#/settings", "#settings"); settle(page, 400)
        back = page.get_attribute("#carry-switch", "aria-checked") == "true"
        check(tag + "polish: the backup holds carry_down and a restore brings it back (Part 7)", held and res == "restored" and back, {"held": held, "restore": res, "back": back})
        ctx.close()

    def type_reps(page, sid, n):
        page.click(q(sid) + " [data-val='reps']")
        page.wait_for_selector(q(sid) + " [data-input='reps']")
        page.keyboard.press("Meta+A")
        page.keyboard.type(str(n))

    def tick_asked(page, sid):
        """Tap the tick; return True when the range ask opened, False when the set saved with no ask."""
        page.click(q(sid) + " [data-tick]")
        poll(page, "() => !!document.getElementById('range-sheet') || (document.querySelector('[data-set=\"%s\"]') || {}).getAttribute?.('data-state') === 'done'" % sid)
        return page.locator("#range-sheet").count() == 1

    def rep_ask_setting(page):
        return page.evaluate("async () => { const { db } = await import('./db.js'); return db.setting('rep_ask', null); }")

    def polish_range():
        # Part 8: range 8 to 12 asks below and above, Cancel keeps the row, the box stops the ask, the switch brings it back (L05).
        ctx, page = new()
        three_set_block(page)
        s1 = open_set(page)
        type_reps(page, s1, 5)
        asked = tick_asked(page, s1)
        if asked:
            layout(page, tag, "rep range ask sheet")
            shot(page, "polish_range_ask_%s.png" % vp)   # LB2, P.1 step 7
        page.click("#range-cancel")
        page.wait_for_selector("#range-sheet", state="detached")
        settle(page, 400)
        kept = state_of(page, s1) == "open" and page.inner_text(q(s1) + " [data-val='reps']").strip() == "5"
        check(tag + "polish: rep range Cancel keeps the row open (Part 8)", asked and kept, {"asked": asked, "state": state_of(page, s1)})
        tick_asked(page, s1)
        page.click("#range-log")
        wait_state(page, s1, "done")
        saved5 = page.inner_text(q(s1) + " [data-val='reps']").strip() == "5"
        s2 = open_set(page)
        type_reps(page, s2, 16)
        above = tick_asked(page, s2)
        check(tag + "polish: rep range ask above the top (Part 8)", saved5 and above, {"saved 5": saved5, "asked at 16": above})
        page.click("#range-noask")
        page.click("#range-log")
        wait_state(page, s2, "done")
        off = rep_ask_setting(page) is False
        s3 = open_set(page)
        type_reps(page, s3, 3)
        no_ask = not tick_asked(page, s3)
        answer_fb(page, "save")
        go_route(page, "#/settings", "#settings"); settle(page, 400)
        switch_off = page.get_attribute("#range-switch", "aria-checked") == "false"
        page.click("#range-switch"); settle(page, 400)
        go_route(page, "#/today", "#today[data-day]")
        s4 = open_set(page)
        type_reps(page, s4, 5)
        back = tick_asked(page, s4)
        page.click("#range-cancel")
        check(tag + "polish: do not ask again stops the ask and the switch brings it back (Part 8)", off and no_ask and switch_off and back,
              {"off": off, "no ask at 3": no_ask, "switch read off": switch_off, "asked again": back})
        ctx.close()

        # R38: an open top 8 asks below only, with the open line.
        f = json.load(open(os.path.join(FIXTURES, "block_v1.json")))
        f["source_id"] = "polish-open-top"
        for d in f["block"]["day_templates"]:
            for l in d["lifts"]:
                l["rep_low"], l["rep_high"], l["warmups"] = 8, None, []
        path = os.path.join(out_dir, "block_open_top.json")
        os.makedirs(out_dir, exist_ok=True)
        json.dump(f, open(path, "w"))
        ctx, page = new()
        page.click("#unit-lb")
        load_block_file(page, path)
        sa = open_set(page)
        type_reps(page, sa, 20)
        no20 = not tick_asked(page, sa)
        answer_fb(page, "save")
        sb = open_set(page)
        type_reps(page, sb, 5)
        yes5 = tick_asked(page, sb) and page.inner_text("#range-line").strip() == "5 reps. Your goal is 8 or more."
        check(tag + "polish: an open top asks only below, with the open line (Part 8, R38)", no20 and yes5, {"no ask at 20": no20, "ask at 5": yes5})
        ctx.close()

    def set_menu(page, sid, item):
        page.click(q(sid) + " [data-setmenu]")
        page.wait_for_selector("#set-menu")
        page.click("#set-menu [data-setitem='%s']" % item)
        page.wait_for_selector("#set-menu", state="detached")
        settle(page, 400)

    def polish_setmenu():
        # Part 9: add below on set 1 puts the new row between sets 1 and 2 (E02). The day must be open (R15).
        ctx, page = new()
        three_set_block(page)
        first2 = slot_rows(page, 2)[0][0]
        page.click(q(first2) + " [data-tick]")
        wait_state(page, first2, "done")
        before = [r[0] for r in slot_rows(page, 1)]
        s1 = open_set(page)
        set_menu(page, s1, "addbelow")
        after = slot_rows(page, 1)
        nums = page.evaluate("() => [...document.querySelectorAll('.ex-card[data-slot=\"1\"] .set .set-no')].map(n => n.textContent)")
        check(tag + "polish: add below on set 1 puts the new row between sets 1 and 2 (Part 9)",
              len(after) == 4 and after[0][0] == before[0] and after[2][0] == before[1] and after[1][0] not in before and nums == ["1", "2", "3", "4"],
              {"before": before, "after": [r[0] for r in after], "numbers": nums})
        # Part 10: a deleted planned set is gone from the day (E03); a done set shows the disabled row with its reason.
        last = slot_rows(page, 1)[-1][0]
        page.click(q(last) + " [data-val='load']")
        settle(page, 300)
        set_menu(page, last, "delete")
        gone = page.locator(q(last)).count() == 0 and len(slot_rows(page, 1)) == 3
        check(tag + "polish: a deleted planned set is gone from the day (Part 10)", gone, [r[0] for r in slot_rows(page, 1)])
        # A typed draft shows Delete disabled with its reason line (LOOK 3.1).
        sid = open_set(page)
        page.click(q(sid) + " [data-step='reps+']"); settle(page, 400)
        page.click(q(sid) + " [data-setmenu]")
        page.wait_for_selector("#set-menu")
        off = page.is_disabled("#set-menu [data-setitem='delete']") and page.inner_text("#set-delete-why").strip() == "Clear the typed numbers first."
        scrim_tap(page)
        check(tag + "polish: Delete on a typed draft is disabled with its reason (Part 10)", off, page.inner_text("#set-menu")[:120] if page.locator("#set-menu").count() else "")
        ctx.close()

    def card_order(page):
        return page.evaluate("() => [...document.querySelectorAll('.ex-card')].map(c => c.getAttribute('data-slot'))")

    def polish_move():
        # Part 11: moving an exercise up changes its place today, and the change is still there after a reload (E05, E06).
        ctx, page = new()
        three_set_block(page)
        page.click("[data-menu='2']")
        page.wait_for_selector("#card-menu")
        page.click("#card-menu [data-item='up']")
        settle(page, 500)
        moved = card_order(page) == ["2", "1"]
        page.click("[data-menu='2']")
        page.wait_for_selector("#card-menu")
        first_has_up = page.locator("#card-menu [data-item='up']").count() == 0 and page.locator("#card-menu [data-item='down']").count() == 1
        scrim_tap(page)
        page.reload(); page.wait_for_selector("#today[data-day]"); settle(page)
        kept = card_order(page) == ["2", "1"]
        opened = page.evaluate("() => document.querySelector('.set.is-open').closest('.ex-card').getAttribute('data-slot')") == "2"
        check(tag + "polish: move up is still there after a reload (Part 11)", moved and kept and first_has_up and opened,
              {"moved": moved, "kept": kept, "first card has no Move up": first_has_up, "open row follows the order": opened})
        ctx.close()

    def polish_reset():
        # Part 12: the row is absent on a day not started; Reset after typed RESET clears the done sets, the day stays open (E11, G16).
        ctx, page = new()
        three_set_block(page)
        page.click("#day-menu")
        page.wait_for_selector("#day-menu-sheet")
        absent = page.locator("#day-menu-sheet [data-dayitem='reset']").count() == 0
        scrim_tap(page)
        settle(page, 300)
        a = tick(page, fb="none")
        b = tick(page, fb="none")
        page.click("#day-menu")
        page.wait_for_selector("#day-menu-sheet")
        page.click("#day-menu-sheet [data-dayitem='reset']")
        page.wait_for_selector("#reset-sheet")
        layout(page, tag, "reset sheet")
        locked = page.is_disabled("#reset-go")
        page.fill("#reset-sheet .confirm-input", "RESET")
        # A scrim tap with RESET typed keeps the sheet and the word (LOOK 3.3; G17, review P19).
        scrim_tap(page)
        settle(page, 300)
        kept_typed = page.locator("#reset-sheet").count() == 1 and page.input_value("#reset-sheet .confirm-input") == "RESET"
        check(tag + "polish: a scrim tap keeps the reset sheet and the typed RESET (G17)", kept_typed)
        page.click("#reset-go")
        page.wait_for_selector("#reset-sheet", state="detached")
        settle(page, 600)
        states = [state_of(page, a), state_of(page, b)]
        still_open = page.get_attribute("#today", "data-status") == "open"
        snap = page.evaluate("async () => { const { db } = await import('./db.js'); return (await db.all('snapshots')).map(s => s.reason); }")
        check(tag + "polish: reset after typed RESET; the row is absent on a day not started (Part 12)",
              absent and locked and all(st in ("open", "todo") for st in states) and still_open and "before-reset" in snap,
              {"absent": absent, "locked": locked, "states": states, "open": still_open, "snapshots": snap})
        ctx.close()

    # Slice 1 polish pass, stage 3 (DESIGN 15 P.2 parts 13 to 19). Written and compile-checked in
    # a light job, not run; each title is the expect text of its planted row in mutants.js.
    def block_file(name, passes, days, flags=None, checks=None, exercises=None):
        """A made-up block file written to the run folder; returns its path."""
        f = json.load(open(os.path.join(FIXTURES, "block_v1.json")))
        f["source_id"] = "polish-" + name
        f["block"]["passes"] = passes
        f["block"]["day_templates"] = days
        f["block"]["checks"] = checks if checks is not None else []
        f["block"]["scores"] = []
        if flags is not None:
            f["block"]["exercise_flags"] = flags
        if exercises is not None:
            f["exercises"] = exercises
        os.makedirs(out_dir, exist_ok=True)
        path = os.path.join(out_dir, "block_%s.json" % name)
        json.dump(f, open(path, "w"))
        return path

    def blift(slot, ex, sets, load, **more):
        row = {"slot": slot, "exercise_id": ex, "sets": sets, "rep_low": 8, "rep_high": 12, "start_load": load, "failure_set": False,
               "reps_left_target": 2, "warmups": [], "sides": "none", "load_basis": "total", "count_label": None, "note": ""}
        row.update(more)
        return row

    def day_menu(page, item):
        page.click("#day-menu")
        page.wait_for_selector("#day-menu-sheet")
        page.click("#day-menu-sheet [data-dayitem='%s']" % item)

    def db_rows(page, store):
        return page.evaluate("async (s) => { const { db } = await import('./db.js'); return db.all(s); }", store)

    def polish_skipday():
        # Part 15: Skip day from the day menu opens the next day (E10, E17) and releases keep-awake (R42).
        ctx, page = new([WAKE_COUNT])
        page.click("#unit-lb")
        load_block_file(page, block_file("skip", 2, [
            {"day": 1, "label": "A", "lifts": [blift(1, "leg_press", 2, 100)]},
            {"day": 2, "label": "B", "lifts": [blift(1, "lat_pulldown", 2, 80)]}]))
        first = page.get_attribute("#today", "data-day")
        sid = open_set(page)
        page.click(q(sid) + " [data-tick]"); wait_state(page, sid, "done"); answer_fb(page, "none")
        page.click(q(sid) + " [data-tick]"); settle(page, 500)
        held = page.evaluate("() => window.__sentinels.filter(s => !s.released).length")
        day_menu(page, "skip")
        page.wait_for_selector("#skipday-sheet")
        layout(page, tag, "Skip day sheet")
        page.click("#skipday-go")
        page.wait_for_selector("#skipday-sheet", state="detached")
        page.wait_for_selector("#today[data-day]")
        settle(page, 500)
        now_day = page.get_attribute("#today", "data-day")
        freed = page.evaluate("() => window.__sentinels.filter(s => s.released).length")
        no_sheets = page.locator("#feedback").count() == 0 and page.locator("#overall").count() == 0 and page.locator("#nudge").count() == 0
        d1 = [d for d in db_rows(page, "days") if d["id"] == first]
        check(tag + "polish: Skip day releases keep-awake and opens the next day (Part 15)",
              held >= 1 and freed >= 1 and now_day != first and now_day.endswith(":p1:d2") and no_sheets and d1 and d1[0]["status"] == "skipped",
              {"held": held, "released": freed, "day": now_day, "no sheets": no_sheets, "first day": d1[0]["status"] if d1 else None})
        # After a done set the row is left out.
        sid = open_set(page)
        page.click(q(sid) + " [data-tick]"); wait_state(page, sid, "done"); answer_fb(page, "none")
        page.click("#day-menu"); page.wait_for_selector("#day-menu-sheet")
        gone = page.locator("#day-menu-sheet [data-dayitem='skip']").count() == 0
        scrim_tap(page)
        check(tag + "polish: Skip day is left out of the day menu once a set is done (Part 15)", gone)
        ctx.close()

        # Finish day on an open day with every set skipped: the toast, the day stays open (R4-02).
        ctx, page = new()
        page.click("#unit-lb")
        load_block_file(page, block_file("skipall", 2, [{"day": 1, "label": "A", "lifts": [blift(1, "leg_press", 2, 100)]},
                                                         {"day": 2, "label": "B", "lifts": [blift(1, "lat_pulldown", 2, 80)]}]))
        sid = open_set(page)
        page.click(q(sid) + " [data-tick]"); wait_state(page, sid, "done"); answer_fb(page, "none")
        page.click(q(sid) + " [data-tick]"); settle(page, 500)
        page.click("[data-menu='1']"); page.wait_for_selector("#card-menu")
        page.click("#card-menu [data-item='2']"); settle(page, 600); answer_fb(page, "later")
        before = dump(page)
        page.click("#finish-day"); settle(page, 500)
        msg = toast_text(page)
        check(tag + "polish: Finish day on an open day with every set skipped shows the toast and the day stays open (Part 15)",
              msg is not None and "Skip day" in msg and page.get_attribute("#today", "data-status") == "open" and not differs(before, dump(page)),
              {"toast": msg, "status": page.get_attribute("#today", "data-status")})
        # Stage 4 B4 (LOOK 3.7 long toast): this two-sentence toast wraps, so it takes the long
        # skin (left-aligned, --r-lg corners, at most 3 lines) and stays up past 3 s, gone by 6.8 s.
        skin = page.evaluate("""() => { const t = document.querySelector('.toast'); const cs = getComputedStyle(t);
            return { long: t.classList.contains('is-long'), align: cs.textAlign, radius: cs.borderTopLeftRadius,
                     lines: Math.round((t.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / parseFloat(cs.lineHeight)) }; }""")
        t_shot = time.time()
        shot(page, "polish_toast_long_%s.png" % vp)   # B4, P.1 step 7; its time comes off the wait below
        page.wait_for_timeout(max(0, 4000 - int((time.time() - t_shot) * 1000)))
        still = toast_text(page) is not None
        page.wait_for_timeout(2300)
        gone = toast_text(page) is None
        check(tag + "polish: B4 a wrapped toast is left-aligned with the large corners, at most 3 lines, and stays 6 s",
              skin["long"] and skin["align"] == "left" and skin["radius"] == "18px" and 2 <= skin["lines"] <= 3 and still and gone,
              {"skin": skin, "still_at_4_5s": still, "gone_at_6_8s": gone})
        ctx.close()

        # Stage 4 B3 (LOOK 3.9): six sets, five done. The card tally draws one group of four strokes
        # and the slash across them, then a second group holding one ghost; the slash sits over the
        # four strokes, and the groups are set apart by the group gap.
        ctx, page = new()
        page.click("#unit-lb")
        load_block_file(page, block_file("tally5", 2, [{"day": 1, "label": "A", "lifts": [blift(1, "leg_press", 6, 100)]},
                                                        {"day": 2, "label": "B", "lifts": [blift(1, "lat_pulldown", 2, 80)]}]))
        for _ in range(5):
            tick(page, fb="none")
        settle(page, 400)
        got = page.evaluate("""() => { const t = document.querySelector('.ex-head .tally'); const g = [...t.querySelectorAll('.tally-group')];
            const box = (e) => e.getBoundingClientRect(); const s = t.querySelector('.tally-slash');
            const st = [...g[0].querySelectorAll('.tally-stroke')].map(box);
            const sb = s ? box(s) : null;
            return { groups: g.map(x => [...x.children].map(c => (c.classList.contains('tally-slash') ? '/' : '|') + (c.classList.contains('is-done') ? '' : '.')).join('')),
                     over: !!sb && sb.left <= st[0].right && sb.right >= st[3].left && sb.top < st[0].bottom && sb.bottom > st[0].top,
                     gap: g.length > 1 ? Math.round(box(g[1]).left - box(g[0]).right) : null,
                     label: t.getAttribute('aria-label') }; }""")
        check(tag + "polish: B3 five done sets draw four strokes and the slash across them, then a new group",
              got["groups"] == ["||||/", "|."] and got["over"] and got["gap"] == 10 and bool(got["label"]), got)
        shot(page, "polish_card_tally_%s.png" % vp)   # LB4, P.1 step 7: the slash at 62deg on the card tally
        # The same day finished: the Day done tally shows the six done work sets with no ghost (LOOK 3.9, 4.10).
        tick(page, fb="later")
        page.click("#finish-day")
        for _ in range(12):
            settle(page, 300)
            if page.locator("#feedback").count():
                page.click("#fb-skip"); continue
            if page.locator("#daydone").count() and page.locator("#done-tally").count():
                break
        if page.locator("#nudge").count():
            page.click("#nudge-later"); poll(page, "() => !document.getElementById('nudge')")
        big = page.evaluate("""() => { const t = document.getElementById('done-tally'); if (!t) return null;
            return [...t.querySelectorAll('.tally-group')].map(x => [...x.children].map(c => (c.classList.contains('tally-slash') ? '/' : '|') + (c.classList.contains('is-done') ? '' : '.')).join('')); }""")
        check(tag + "polish: B3 the Day done tally draws six done work sets as a full group and one stroke, with no ghost", big == ["||||/", "|"], big)
        shot(page, "polish_daydone_tally_%s.png" % vp)   # LB4, P.1 step 7: the slash at 62deg on the large tally
        ctx.close()

        # Skip the last day of a 1-round block: the Block finished choices show (R21, R45).
        ctx, page = new()
        page.click("#unit-lb")
        load_block_file(page, block_file("skiplast", 1, [{"day": 1, "label": "A", "lifts": [blift(1, "leg_press", 2, 100)]}]))
        day_menu(page, "skip")
        page.wait_for_selector("#skipday-sheet")
        page.click("#skipday-go")
        # Slice 3 (17 C.3.9): the Block finished screen first, the nudge over it once.
        page.wait_for_selector("#finished #fin-new")
        if page.locator("#nudge").count() or poll_quiet(page, "() => !!document.getElementById('nudge')", 3000):
            page.click("#nudge-later")
        check(tag + "polish: Skip day on the last day of a 1-round block shows the Block finished choices (Part 15)",
              page.locator("#finished #fin-new").count() == 1 and page.locator("#finished #fin-copy").count() == 1)
        ctx.close()

    def polish_breaks():
        # Part 16: a 3-lap carry ticked with 1 break shows done; the backup flat_log row reads breaks 1.
        ctx, page = new([NO_SHARE])
        page.click("#unit-lb")
        load_block_file(page, block_file("laps", 2, [{"day": 1, "label": "A", "lifts": [
            blift(1, "leg_press", 3, 50, rep_low=None, rep_high=None, count_label="laps"), blift(2, "lat_pulldown", 1, 80)]}]))
        sid = open_set(page)
        chips = page.locator(q(sid) + " [data-br]").count()
        layout(page, tag, "break chip row")
        page.click(q(sid) + " [data-br='1']"); settle(page, 400)
        page.click(q(sid) + " [data-tick]"); wait_state(page, sid, "done"); answer_fb(page, "none")
        # The reps lift of the same day, counted on its own open row (review P30): no break chips.
        reps_chips = None
        while open_set(page):
            o = open_set(page)
            if page.evaluate("(id) => document.querySelector('[data-set=\"' + id + '\"]').closest('.ex-card').getAttribute('data-slot')", o) == "2":
                reps_chips = page.locator(q(o) + " [data-br]").count()
            page.click(q(o) + " [data-tick]"); wait_state(page, o, "done"); answer_fb(page, "later")
        no_reps_chips = reps_chips == 0
        finish(page)
        path = backup_download(page, True, out_dir)
        flat = json.load(open(path))["flat_log"]
        row = [r for r in flat if r["set_id"] == sid]
        check(tag + "polish: a 3-lap carry ticked with 1 break shows done and the backup row reads breaks 1 (Part 16)",
              chips == 4 and row and row[0]["breaks"] == 1 and row[0]["status"] == "done", {"chips": chips, "row": row[:1]})
        ctx.close()
        # A reps lift shows no chips.
        ctx, page = new()
        three_set_block(page)
        sid = open_set(page)
        check(tag + "polish: a reps lift shows no break chips (Part 16)", page.locator(q(sid) + " [data-br]").count() == 0 and no_reps_chips,
              {"reps lift on the laps day": reps_chips})
        ctx.close()

    CHECK_A = [{"key": "check_a", "ask": "Made-up check question?", "stop_note": "Made-up stop note.", "lifts": None}]

    def checks_block(page, name):
        page.click("#unit-lb")
        load_block_file(page, block_file(name, 2, [{"day": 1, "label": "A", "lifts": [
            blift(1, "leg_press", 3, 100, warmups=[{"reps": 5, "load": 60}]), blift(2, "lat_pulldown", 1, 80)]}], checks=CHECK_A))
        return [r[0] for r in slot_rows(page, 1)]

    def inset_after(page):
        """The id of the set row the check inset sits under, or None when no inset shows."""
        return page.evaluate("() => { const i = document.querySelector('[data-inset]'); if (!i) return null; const p = i.previousElementSibling; return p && p.getAttribute('data-set') ? p.getAttribute('data-set') : 'top'; }")

    def tick_row(page, sid):
        page.click(q(sid) + " [data-tick]")
        wait_state(page, sid, "done")
        settle(page, 300)

    def set_why(page, sid):
        return [r for r in db_rows(page, "sets") if r["id"] == sid][0]

    def polish_checks():
        # Part 17 (R4-03, review R37): after a warm-up tick the inset shows.
        ctx, page = new()
        rows = checks_block(page, "checks1")
        warm, s1, s2, s3 = rows
        tick_row(page, warm)
        warm_inset = inset_after(page) == warm
        layout(page, tag, "check inset with No and Yes")
        # A Yes after set 1 of 3 offers Stop, and Stop skips sets 2 and 3 (PD23).
        tick_row(page, s1)
        under_s1 = inset_after(page) == s1
        page.click("[data-checkans='check_a-yes']"); settle(page, 500)
        offered = page.locator("[data-inset] [data-stopnow='check_a']").count() == 1
        layout(page, tag, "check inset with Stop and Keep going")
        page.click("[data-inset] [data-stopnow='check_a']"); settle(page, 600)
        answer_fb(page, "later")
        whys = [set_why(page, x) for x in (s2, s3)]
        check(tag + "polish: check Yes after set 1 offers Stop and Stop skips the rest (Part 17)",
              warm_inset and under_s1 and offered and all(w["status"] == "skipped" and w["why"] == "why.stopped" for w in whys),
              {"warm-up inset": warm_inset, "under set 1": under_s1, "offered": offered, "rest": [(w["status"], w["why"]) for w in whys]})
        ctx.close()

        # After set 2 of 3 (No answered after set 1) the inset shows again and a Yes there offers Stop, which skips set 3 (PD48).
        ctx, page = new()
        warm, s1, s2, s3 = checks_block(page, "checks2")
        tick_row(page, warm); tick_row(page, s1)
        page.click("[data-checkans='check_a-no']"); settle(page, 400)
        tick_row(page, s2)
        again = inset_after(page) == s2
        # With no inset after set 2 the case fails here by its own name, never on a click timeout.
        w3 = {"status": None, "why": None}
        if again:
            page.click("[data-checkans='check_a-yes']"); settle(page, 500)
            page.click("[data-inset] [data-stopnow='check_a']"); settle(page, 600)
            answer_fb(page, "later")
            w3 = set_why(page, s3)
        check(tag + "polish: check inset after set 2 offers Stop and Stop skips set 3 (Part 17)",
              again and w3["status"] == "skipped" and w3["why"] == "why.stopped", {"again": again, "set 3": (w3["status"], w3["why"])})
        ctx.close()

        # Once Yes, the next inset shows No disabled with the sticky line; a Yes after the last set shows the line and no Stop.
        ctx, page = new()
        warm, s1, s2, s3 = checks_block(page, "checks3")
        tick_row(page, warm)
        page.click("[data-checkans='check_a-yes']"); settle(page, 500)
        page.click("[data-inset] [data-keep='check_a']"); settle(page, 400)
        tick_row(page, s1)
        sticky = page.is_disabled("[data-checkans='check_a-no']") and "rest of today" in page.inner_text("[data-inset]")
        tick_row(page, s2)
        page.click(q(s3) + " [data-tick]"); wait_state(page, s3, "done"); settle(page, 500)
        on_sheet = page.locator("#feedback").count() == 1
        prefilled = on_sheet and page.get_attribute("#feedback [data-answer='check-check_a-2']", "aria-pressed") == "true"
        line_only = on_sheet and page.locator("#feedback [data-stop='check_a']").is_visible() and page.locator("#feedback [data-stopnow]").count() == 0
        answer_fb(page, "save")
        check(tag + "polish: once Yes the No chip is disabled with the sticky line; after the last set the sheet shows the line and no Stop (Part 17)",
              sticky and prefilled and line_only, {"sticky": sticky, "prefilled": prefilled, "line only": line_only})
        ctx.close()

        # The card menu row opens the inset mid exercise.
        ctx, page = new()
        warm, s1, s2, s3 = checks_block(page, "checks4")
        tick_row(page, warm)
        # The tick put the inset up; it lives in module memory, so a reload clears it (review P14, P24).
        page.reload(); page.wait_for_selector("#today[data-day]"); settle(page)
        none_before = page.locator("[data-inset]").count() == 0
        page.click("[data-menu='1']"); page.wait_for_selector("#card-menu")
        has_row = page.locator("#card-menu [data-item='checks']").count() == 1
        page.click("#card-menu [data-item='checks']"); settle(page, 400)
        # Opened from the menu, the inset sits directly above the first planned row (LOOK 3.2, the
        # r4.2 place of record; DESIGN 16 B.2 as built): here set 1, with the warm-up done above it.
        above = page.evaluate("() => { const i = document.querySelector('[data-inset]'); const n = i && i.nextElementSibling; return n ? n.getAttribute('data-set') : null; }")
        at_first = above == s1
        check(tag + "polish: the card menu Checks row opens the inset mid exercise (Part 17)", none_before and has_row and at_first,
              {"no inset before": none_before, "row": has_row, "inset above the first planned row": at_first, "row under it": above})
        ctx.close()

        # After the last set the Checks row is left out (LOOK 3.2; 14.8 G10, review P5, P17): the
        # feedback sheet opens by itself and holds the check, and the card menu has no dead row.
        ctx, page = new()
        warm, s1, s2, s3 = checks_block(page, "checks5")
        tick_row(page, warm); tick_row(page, s1); tick_row(page, s2)
        page.click(q(s3) + " [data-tick]"); wait_state(page, s3, "done"); settle(page, 500)
        on_sheet = page.locator("#feedback").count() == 1
        sheet_check = on_sheet and page.locator("#feedback [data-answer^='check-check_a-']").count() >= 1
        answer_fb(page, "later")
        page.click("[data-menu='1']"); page.wait_for_selector("#card-menu")
        no_row = page.locator("#card-menu [data-item='checks']").count() == 0
        check(tag + "polish: after the last set the card menu has no Checks row and the feedback sheet shows the check (Part 17, G10)",
              on_sheet and sheet_check and no_row, {"sheet": on_sheet, "check on the sheet": sheet_check, "no Checks row": no_row})
        ctx.close()

    def polish_lift_words():
        # Part 18 (R4-04, r4.1 Q6, Q14, Q18): block step 15 takes 185 to 200.
        ctx, page = new()
        page.click("#unit-lb")
        load_block_file(page, block_file("step15", 2, [{"day": 1, "label": "A", "lifts": [blift(1, "leg_press", 2, 185)]}],
                                          flags={"leg_press": {"no_added_sets": False, "left_out_of_builder": False, "step": 15}}))
        sid = open_set(page)
        page.click(q(sid) + " [data-step='load+']"); settle(page, 400)
        got = page.inner_text(q(sid) + " [data-val='load']").strip()
        check(tag + "polish: with block step 15 the weight plus on 185 shows 200 (Part 18)", got == "200", got)
        ctx.close()
        # The list [170, 185, 200]: plus on 185 shows 200, minus shows 170.
        ctx, page = new()
        page.click("#unit-lb")
        load_block_file(page, block_file("list", 2, [{"day": 1, "label": "A", "lifts": [blift(1, "leg_press", 2, 185)]}],
                                          flags={"leg_press": {"no_added_sets": False, "left_out_of_builder": False, "weight_steps": [170, 185, 200]}}))
        sid = open_set(page)
        page.click(q(sid) + " [data-step='load+']"); settle(page, 400)
        up = page.inner_text(q(sid) + " [data-val='load']").strip()
        page.click(q(sid) + " [data-step='load-']"); settle(page, 400)
        page.click(q(sid) + " [data-step='load-']"); settle(page, 400)
        down = page.inner_text(q(sid) + " [data-val='load']").strip()
        check(tag + "polish: with block weight_steps [170, 185, 200] plus on 185 shows 200 and minus shows 170 (Part 18)", up == "200" and down == "170", {"up": up, "down": down})
        ctx.close()
        # Machine flag: the row says machine, the block entry says not, so the effective flag is
        # not a machine set and the note shows; the reverse case shows no note (r4.1 Q6). Both still save.
        ctx, page = new()
        page.click("#unit-lb")
        load_block_file(page, block_file("machine", 2, [{"day": 1, "label": "A", "lifts": [blift(1, "leg_press", 1, 100), blift(2, "bench_press", 1, 100)]}],
                                          flags={"leg_press": {"no_added_sets": False, "left_out_of_builder": False, "machine": False},
                                                 "bench_press": {"no_added_sets": False, "left_out_of_builder": False, "machine": True}}))
        a = open_set(page)
        page.click(q(a) + " #fail-toggle"); settle(page, 400)
        note_a = page.locator(q(a) + " [data-note='machine']").count() == 1
        page.click(q(a) + " [data-tick]"); wait_state(page, a, "done"); answer_fb(page, "later")
        b = open_set(page)
        page.click(q(b) + " #fail-toggle"); settle(page, 400)
        note_b = page.locator(q(b) + " [data-note='machine']").count()
        page.click(q(b) + " [data-tick]"); wait_state(page, b, "done"); answer_fb(page, "later")
        check(tag + "polish: block machine false over a machine row shows the machine note and saves; block machine true shows none (Part 18)",
              note_a and note_b == 0 and state_of(page, a) == "done" and state_of(page, b) == "done", {"row true block false": note_a, "row false block true": note_b})
        ctx.close()
        # His short note and goal line show on the card (text only).
        ctx, page = new()
        page.click("#unit-lb")
        load_block_file(page, block_file("words", 2, [{"day": 1, "label": "A", "lifts": [
            blift(1, "leg_press", 2, 100, rep_low=None, rep_high=None, short_note="Made-up lift note.", goal_line="Made-up goal words")]}]))
        sid = open_set(page)
        note = page.inner_text("[data-slot='1'] .ex-note").strip() if page.locator("[data-slot='1'] .ex-note").count() else None
        helper = page.inner_text(q(sid) + " .helper").strip()
        check(tag + "polish: his lift note shows under the card header and his goal line is the helper goal part (Part 18)",
              note == "Made-up lift note." and helper.startswith("Made-up goal words"), {"note": note, "helper": helper})
        ctx.close()
        # C23 on a row whose helper line is empty (a start weight and no rep range, no goal words):
        # the helper still sits on the row, so a refused number can say why (planted row R9).
        ctx, page = new()
        page.click("#unit-lb")
        load_block_file(page, block_file("c23", 2, [{"day": 1, "label": "A", "lifts": [
            blift(1, "leg_press", 2, 100, rep_low=None, rep_high=None)]}]))
        sid = open_set(page)
        empty = page.inner_text(q(sid) + " .helper").strip() if page.locator(q(sid) + " .helper").count() else None
        page.click(q(sid) + " [data-val='load']")
        page.wait_for_selector(q(sid) + " [data-input='load']")
        fill_change(page, q(sid) + " [data-input='load']", "9999")
        settle(page, 300)
        helper = page.locator(q(sid) + " .helper")
        line = helper.inner_text().strip() if helper.count() == 1 and helper.is_visible() else None
        check(tag + "polish: C23 a refused number on a row with an empty helper line still shows the number line",
              empty == "" and line == "Use a number from 0 to 2000", {"helper before": empty, "line": line})
        ctx.close()

    NO_IDB = ("Object.defineProperty(window, 'indexedDB', { configurable: true, get: () => ({ open: () => {"
              " throw new DOMException('blocked for the test', 'SecurityError'); }, databases: () => Promise.resolve([]) }) });")

    def polish_blocked():
        # Part 19: a blocked storage boot shows the Blocked skin, never the fail color, no bottom bar.
        ctx, page = new_context(browser, audit, standalone=True, vp=vp, extra=[NO_IDB])
        page.goto(base)
        page.wait_for_selector("#storage-blocked", timeout=15000)
        st = page.evaluate("""() => { const b = document.getElementById('storage-blocked'); const cs = getComputedStyle(b);
            const fail = getComputedStyle(document.documentElement).getPropertyValue('--fail-bg').trim();
            return { role: b.getAttribute('role'), bg: cs.backgroundColor, fail, glyph: !!b.querySelector('svg'),
                     buttons: b.querySelectorAll('button').length, bar: !!document.querySelector('.tabbar'), title: (b.querySelector('h2') || {}).textContent }; }""")
        hexv = st["fail"].lstrip("#")
        fail_rgb = "rgb(%d, %d, %d)" % tuple(int(hexv[i:i + 2], 16) for i in (0, 2, 4)) if len(hexv) == 6 else st["fail"]
        check(tag + "polish: a blocked storage boot shows the Blocked skin (Part 19)",
              st["role"] == "alert" and st["bg"] != fail_rgb and st["glyph"] and st["buttons"] == 0 and not st["bar"] and st["title"] == "Storage is blocked", st)
        layout(page, tag, "storage blocked")
        ctx.close()

    def four_set_day(page):
        """Day A: leg press 4 sets, no warm-up. Day B: one lat pulldown set."""
        page.click("#unit-lb")
        load_block_file(page, block_file("four", 2, [{"day": 1, "label": "A", "lifts": [blift(1, "leg_press", 4, 100)]},
                                                      {"day": 2, "label": "B", "lifts": [blift(1, "lat_pulldown", 1, 80)]}]))

    def progress(page):
        return page.evaluate("() => { const p = document.getElementById('day-progress'); return p ? [p.getAttribute('value'), p.getAttribute('max'), p.getAttribute('aria-label')] : null; }")

    def polish_progress():
        # Part 13 (DW2): a 4-set day reads 0 of 4; one tick then 1 of 4 only after the commit; skip one then 2 of 4;
        # full when no set is planned. A deleted planned set drops the max (Part 10).
        ctx, page = new([TX_HANG])
        four_set_day(page)
        p0 = progress(page)
        page.evaluate("window.__hangTx = true")
        sid = open_set(page)
        page.click(q(sid) + " [data-tick]")
        settle(page, 1500)
        held = progress(page)
        page.wait_for_timeout(9000)
        still = progress(page)
        ctx.close()
        check(tag + "polish: progress waits for the commit (Part 13)",
              p0 and p0[:2] == ["0", "4"] and held and held[0] == "0" and still and still[0] == "0", {"start": p0, "saving": held, "not saved": still})
        ctx, page = new()
        four_set_day(page)
        rows = slot_rows(page)
        tick_row(page, rows[0][0])
        p1 = progress(page)
        set_menu(page, open_set(page), "delete")
        p_del = progress(page)
        page.click("[data-menu='1']"); page.wait_for_selector("#card-menu")
        page.click("#card-menu [data-item='1']"); settle(page, 500)
        p2 = progress(page)
        while open_set(page):
            o = open_set(page)
            page.click(q(o) + " [data-tick]"); wait_state(page, o, "done"); answer_fb(page, "later")
        full = progress(page)
        # The rule is "full when no set is planned" (14.8 G19, review P28); Slice 1 has no done-day
        # view (R28), so the line is read again while the first Finish day sheet is open over Today.
        page.click("#finish-day")
        page.wait_for_selector("#feedback, #overall", timeout=5000)
        on_finish = progress(page)
        check(tag + "polish: 0 of 4, 1 of 4 after the commit, 2 after a skip, full when no set is planned; a delete drops the max (Parts 13, 10)",
              p1 and p1[:2] == ["1", "4"] and p_del and p_del[:2] == ["1", "3"] and p2 and p2[:2] == ["2", "3"] and full and full[0] == full[1]
              and on_finish and on_finish[0] == on_finish[1],
              {"after tick": p1, "after delete": p_del, "after skip": p2, "full": full, "Finish day sheet open": on_finish})
        ctx.close()

    def polish_daydone():
        # Part 14 (AW5): Finish day shows the counts, the nudge over it; Later closes the nudge and the screen stays;
        # the button opens the next day; a bad id in the address goes to Today.
        ctx, page = new([NO_SHARE])
        page.click("#unit-lb")
        load_block_file(page, block_file("done", 2, [{"day": 1, "label": "A", "lifts": [blift(1, "leg_press", 2, 100), blift(2, "lat_pulldown", 1, 80)]},
                                                      {"day": 2, "label": "B", "lifts": [blift(1, "leg_extension", 1, 60)]}]))
        tick_row(page, slot_rows(page, 1)[0][0])
        page.click("[data-menu='1']"); page.wait_for_selector("#card-menu")
        page.click("#card-menu [data-item='1']"); settle(page, 500); answer_fb(page, "later")
        page.click("[data-menu='2']"); page.wait_for_selector("#card-menu")
        page.click("#card-menu [data-item='2']"); settle(page, 500); answer_fb(page, "later")
        page.click("#finish-day")
        for _ in range(12):
            settle(page, 300)
            if page.locator("#feedback").count():
                page.click("#fb-skip"); continue
            if page.locator("#nudge").count():
                break
        under = page.locator("#daydone").count() == 1 and page.locator("#nudge").count() == 1 and page.locator(".tabbar").count() == 0
        layout(page, tag, "day done")
        screenshot(page, "polish_day_done_%s.png" % vp)
        page.click("#nudge-later"); poll(page, "() => !document.getElementById('nudge')"); settle(page, 400)
        stays = page.locator("#daydone").count() == 1
        nums = page.evaluate("() => [...document.querySelectorAll('.done-row')].map(r => [r.getAttribute('data-done'), r.querySelector('.done-n').textContent])")
        page.click("#done-go")
        page.wait_for_selector("#today[data-day]")
        nxt = page.get_attribute("#today", "data-day")
        check(tag + "polish: Finish day shows the counts and the button opens the next day (Part 14)",
              under and stays and nums == [["done.sets", "1"], ["done.ex", "1"], ["done.skipped", "1"]] and nxt.endswith(":p1:d2"),
              {"nudge over it": under, "stays": stays, "numbers": nums, "next": nxt})
        # Each address is followed until the route has run (review P25): the hash back on Today, no
        # Day done screen, and a fresh Today drawn, then a short settle.
        def back_on_today(h):
            page.evaluate("() => { const t = document.getElementById('today'); if (t) t.setAttribute('data-stale', ''); }")
            page.evaluate("h => { location.hash = h; }", h)
            try:
                poll(page, "() => location.hash === '#/today' && !document.getElementById('daydone') && !!document.querySelector('#today[data-day]:not([data-stale])')", timeout=8000)
            except Exception:
                return False
            settle(page, 400)
            return page.evaluate("() => location.hash") == "#/today" and page.locator("#daydone").count() == 0
        bad = back_on_today("#/daydone/__proto__")
        not_done = back_on_today("#/daydone/" + nxt)
        check(tag + "polish: a bad id or a day not done in the address goes to Today (Part 14)", bad and not_done)
        ctx.close()

    def polish_shots():
        # P.1 step 7 (review R34): the polish screens the simulator cannot reach, at this phone size,
        # for a look by eye logged in BUILD_LOG: Today with the progress line and the set menu open,
        # and the Settings LOGGING group. The Day done shot is taken in polish_daydone.
        ctx, page = new()
        four_set_day(page)
        tick_row(page, slot_rows(page)[0][0])
        page.click(q(open_set(page)) + " [data-setmenu]")
        page.wait_for_selector("#set-menu")
        layout(page, tag, "today with the set menu open")
        screenshot(page, "polish_today_setmenu_%s.png" % vp)
        scrim_tap(page)
        go_route(page, "#/settings", "#settings")
        settle(page, 400)
        if page.locator("#carry-switch").count():
            page.locator("#carry-switch").scroll_into_view_if_needed()
        layout(page, tag, "settings logging group")
        # G15 (LOOK 4.9 R16), read from the computed styles, since source order decides it: no hairline under a
        # switch row, one under its own helper line, none under the last line, and the switch 12px from the row top.
        g15 = page.evaluate("""() => {
            const bw = (e) => e ? getComputedStyle(e).borderBottomWidth : 'none';
            const row = document.getElementById('carry-switch'), sw = row && row.querySelector('.switch');
            return { rows: [bw(row), bw(document.getElementById('range-switch'))],
                     lines: [bw(document.getElementById('carry-switch-line')), bw(document.getElementById('range-switch-line'))],
                     top: row && sw ? Math.round(sw.getBoundingClientRect().top - row.getBoundingClientRect().top) : null }; }""")
        check(tag + "polish: the switch hairline sits under each helper line, none after the last, the switch on the first label line (G15, LOOK 4.9 R16)",
              g15["rows"] == ["0px", "0px"] and g15["lines"] == ["1px", "0px"] and g15["top"] == 12, g15)
        screenshot(page, "polish_settings_logging_%s.png" % vp)
        check(tag + "polish: step 7 screenshots taken (Today set menu, Settings LOGGING, Day done in its own case)", True)
        ctx.close()

    # r4.3 light pass (DESIGN 14.9 H8, LB3): named browser cases for built contract rows. Written and
    # compile-checked in a light job, not run; each title is the expect text of its planted row.
    def r43_s16():
        # S16: Make my own exercise from the picker adds the new lift to the day, and the saved block uses it.
        ctx, page = new()
        builder_day_a(page, ())
        page.click("[data-addex='0']")
        page.wait_for_selector("#picker")
        page.click("#picker-make")
        page.wait_for_selector("#make-sheet")
        page.fill("#make-name", "Made-up press")
        page.click("#make-save")
        page.wait_for_selector("#builder[data-step='3']")
        in_day = page.locator("[data-lift='0:0']").count() == 1
        to_review_and_save(page)
        got = active_block(page)
        ex = [e for e in db_rows(page, "exercises") if e["name"] == "Made-up press"]
        check(tag + "S16 make my own lift from the picker adds it to the day",
              in_day and len(ex) == 1 and ex[0]["custom"] is True and ex[0]["id"].startswith("c-") and got and got["lifts"][0] == [[1, ex[0]["id"]]],
              {"in day": in_day, "rows": [(e["id"][:2], e["custom"]) for e in ex], "lifts": got and got["lifts"]})
        ctx.close()

    def r43_l07():
        # L07: an each-side lift shows L and R rows, and the open row moves from L to R after the L tick.
        ctx, page = new()
        page.click("#unit-lb")
        load_block_file(page, block_file("sides", 1, [{"day": 1, "label": "A", "lifts": [blift(1, "leg_press", 2, 50, sides="LR", load_basis="per_side")]}]))
        rows = slot_rows(page)
        sides = [r[0].rsplit(":", 1)[1] for r in rows]
        first = open_set(page)
        tick_row(page, first)
        after = open_set(page)
        check(tag + "L07 an each-side lift shows L and R rows and the open row moves from L to R",
              sides == ["L", "R", "L", "R"] and first and first.endswith(":s1:L") and after and after.endswith(":s1:R"),
              {"sides": sides, "open before": first, "open after": after})
        ctx.close()

    def r43_dw1():
        # DW1: on a fresh day exactly one row is open, it is the first planned row in card order, no
        # other row holds an input or a stepper, and after its tick the next planned row is open.
        ctx, page = new()
        four_set_day(page)
        st = page.evaluate("""() => { const rows = [...document.querySelectorAll('.set')];
            const open = rows.filter(r => r.classList.contains('is-open'));
            // A planned set shows as data-state open (the open row) or todo (setRow); planned is never a screen state.
            const planned = rows.filter(r => ['open', 'todo'].includes(r.getAttribute('data-state')));
            const others = rows.filter(r => !r.classList.contains('is-open') && r.querySelector('input, [data-step]'));
            return { open: open.map(r => r.getAttribute('data-set')), first: planned.length ? planned[0].getAttribute('data-set') : null,
                     second: planned.length > 1 ? planned[1].getAttribute('data-set') : null, others: others.length }; }""")
        tick_row(page, st["first"])
        after = open_set(page)
        check(tag + "DW1 only the open row has controls, and it is the first planned row",
              len(st["open"]) == 1 and st["open"][0] == st["first"] and st["others"] == 0 and after == st["second"], {"start": st, "after tick": after})
        ctx.close()

    def r43_ew4():
        # EW4: on a lift with 2 sets, tick set 1, then Skip set on set 2: the feedback sheet opens for that slot.
        ctx, page = new()
        page.click("#unit-lb")
        load_block_file(page, block_file("ew4", 1, [{"day": 1, "label": "A", "lifts": [blift(1, "leg_press", 2, 100), blift(2, "lat_pulldown", 1, 80)]}]))
        tick_row(page, slot_rows(page)[0][0])
        page.click(".ex-card[data-slot='1'] [data-menu='1']")
        page.wait_for_selector("#card-menu")
        page.click("#card-menu [data-item='1']")
        opened = True
        try:
            page.wait_for_selector("#feedback", timeout=5000)
        except Exception:
            opened = False
        title = page.evaluate("() => { const h = document.querySelector('#feedback .sheet-title'); return h ? h.textContent : null; }") if opened else None
        check(tag + "EW4 skipping the last set opens the feedback sheet", opened and bool(title), {"opened": opened, "title": title})
        ctx.close()

    def r43_o02():
        # O02: Light and Dark set data-theme, Match phone removes it, and after a reload the pick still applies.
        ctx, page = new()
        go_route(page, "#/settings", "#settings")
        page.wait_for_selector("#look [data-k='dark']")
        theme = lambda: page.evaluate("() => document.documentElement.getAttribute('data-theme')")
        page.click("#look [data-k='light']"); settle(page, 300); light = theme()
        page.click("#look [data-k='dark']"); settle(page, 300); dark = theme()
        page.click("#look [data-k='phone']"); settle(page, 300); phone = theme()
        page.click("#look [data-k='dark']"); settle(page, 500)
        page.reload(); page.wait_for_selector(".tabbar"); settle(page, 800)
        kept = theme()
        check(tag + "O02 the look choice sets the theme and survives a reload",
              light == "light" and dark == "dark" and phone is None and kept == "dark", {"light": light, "dark": dark, "phone": phone, "after reload": kept})
        ctx.close()

    def r43_lb3():
        # LB3 (LOOK 3.7 stack order): a toast fired while a sheet is open is the top element at its
        # center, so a failed save inside a sheet (the Skip day toast) is never hidden under the panel.
        ctx, page = new()
        four_set_day(page)
        day_menu(page, "skip")
        page.wait_for_selector(".sheet-wrap")
        page.evaluate("""async () => { const { toast } = await import('./ui/dom.js'); const { t } = await import('./ui/strings.js'); toast(t('today.notsaved')); }""")
        page.wait_for_selector(".toast.is-on")
        settle(page, 400)
        # LN2: hit testing skips an element with pointer-events:none, and .toast must keep it (LOOK 3.7).
        # So the probe makes the toast hit-testable through its inline style only for the one
        # elementFromPoint call and puts the old value back in a finally. The stylesheet is untouched.
        top = page.evaluate("""() => { const el = document.querySelector('.toast.is-on'); const r = el.getBoundingClientRect();
            const old = el.style.pointerEvents; let hit = null;
            try { el.style.pointerEvents = 'auto'; hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); }
            finally { el.style.pointerEvents = old; }
            return { onTop: !!hit && !!hit.closest('.toast'), z: getComputedStyle(el).zIndex, sheet: !!document.querySelector('.sheet-wrap'),
                     cssNone: getComputedStyle(el).pointerEvents === 'none' }; }""")
        check(tag + "LB3 a toast fired with a sheet open is the top element at its center", top["onTop"] and top["sheet"] and top["cssNone"], top)
        shot(page, "polish_toast_over_sheet_%s.png" % vp)   # LB3, P.1 step 7
        ctx.close()

    polish_parts = [polish_builder, polish_relabel, polish_helper, polish_copy, polish_carry, polish_range, polish_setmenu, polish_move, polish_reset,
                    polish_skipday, polish_breaks, polish_checks, polish_lift_words,
                    polish_blocked, polish_progress, polish_daydone, polish_shots,
                    r43_s16, r43_l07, r43_dw1, r43_ew4, r43_o02, r43_lb3]

    for name, fn in (("log", part_log), ("block", part_block), ("data", part_data), ("share", part_share), ("wake", part_wake), ("offline", part_offline), ("polish", part_polish)):
        if not want(name):
            continue
        section(tag + name, fn)
        if local and local.get("stopped"):
            local["server"] = Server(port=local["port"])
            local["stopped"] = False

    os.makedirs(LOG_DIR, exist_ok=True)
    with open(os.path.join(LOG_DIR, "e2e_slice1_%s_network.json" % vp), "w") as f:
        json.dump({"origin": origin, "requests": len(audit.requests), "off_origin": audit.off_origin(), "csp_violations": audit.csp}, f, indent=1)
    off = audit.off_origin()
    check(tag + "slice1 network audit: zero requests off our origin and zero CSP violations", not off and not audit.csp,
          "%d requests, %d off origin, %d CSP %s" % (len(audit.requests), len(off), len(audit.csp), (off + audit.csp)[:3]))
    check(tag + "slice1 zero console errors", not audit.errors, audit.errors[:5])


# ---------------- Slice 2 (DESIGN 16 B.12 e2e slice2), the Today cases of B.1 step 7 ----------------

def clock_at(ms):
    """An init script that sets the page clock: Date is replaced by a class that runs from the
    given instant (16 B.12: init script, no app hook). The worker keeps the real clock."""
    return ("(() => { const R = Date; const off = %d - R.now();"
            " class D extends R { constructor(...a) { if (a.length) super(...a); else super(R.now() + off); }"
            " static now() { return R.now() + off; } }"
            " globalThis.Date = D; })();" % ms)


def ny_ms(y, mo, d, h=12, mi=0):
    """A New York wall time as epoch ms (EST, UTC-5, for the November and December dates used here)."""
    import calendar
    return (calendar.timegm((y, mo, d, h + 5, mi, 0)) * 1000)


DB_ALL = "async (s) => { const { db } = await import('./db.js'); return db.all(s); }"
FIXED_NOW = ny_ms(2026, 11, 20, 12)     # before 2026-12-01: every block plans as Fixed
ADAPT_NOW = ny_ms(2026, 12, 5, 9)       # after the backup_v2.json switch (2026-12-02) and its export (12-04)
BLOCK_V2 = os.path.join(APP_DIR, "scripts", "tests", "fixtures", "block_v2.json")
BACKUP_V2 = os.path.join(APP_DIR, "scripts", "tests", "fixtures", "backup_v2.json")
ROUNDS = os.path.join(APP_DIR, "scripts", "tests", "fixtures", "block_rounds.json")
ROUNDS_SCRIPT = os.path.join(APP_DIR, "scripts", "tests", "fixtures", "block_rounds_script.json")


def suite_slice2(browser, base, vp, parts):
    tag = "[%s] slice2 " % vp
    o = urlparse(base)
    origin = o.scheme + "://" + o.netloc
    audit = Audit(origin)
    want = lambda name: (not parts) or name in parts

    def new(now_ms):
        ctx, page = new_context(browser, audit, standalone=True, vp=vp, extra=[clock_at(now_ms)])
        page.set_default_timeout(10000)
        page.goto(base)
        page.wait_for_selector("#today > *", timeout=15000)
        wait_controller(page)
        settle(page, 300)
        return ctx, page

    def rows(page, store):
        return page.evaluate(DB_ALL, store)

    def toast_text(page):
        return page.evaluate("() => { const t = document.querySelector('.toast.is-on'); return t ? t.textContent : null; }")

    def fixed_page():
        ctx, page = new(FIXED_NOW)
        page.click("#unit-lb")
        load_block_file(page, BLOCK_V2)
        return ctx, page

    def adaptive_page():
        ctx, page = new(ADAPT_NOW)
        out = restore_from(page, BACKUP_V2)
        go_route(page, "#/today", "#today[data-day]")
        return ctx, page, out

    def day_row(page):
        did = page.get_attribute("#today", "data-day")
        return next((d for d in rows(page, "days") if d["id"] == did), None)

    def menu_item(page, slot, item):
        page.click("[data-menu='%s']" % slot)
        page.wait_for_selector("#card-menu")
        page.click("#card-menu [data-item='%s']" % item)
        settle(page, 300)

    def day_item(page, item):
        page.click("#day-menu")
        page.wait_for_selector("#day-menu-sheet")
        page.click("#day-menu-sheet [data-dayitem='%s']" % item)
        settle(page, 300)

    def scope(page, which):
        page.wait_for_selector("#scope-sheet")
        page.click("#scope-" + which)
        poll(page, "() => !document.getElementById('scope-sheet')")
        settle(page, 300)

    # (a) Fixed: the sleep card, no Adjust each round part, the set kind picker.
    def part_fixed():
        ctx, page = fixed_page()
        check(tag + "fixed: Today shows the Fixed profile", page.get_attribute("#today", "data-profile") == "fixed")
        card = page.locator("#sleep-card")
        check(tag + "sleep card: on a planned day, above the header, with the question and his sleep hint",
              card.count() == 1 and page.inner_text("#sleep-q").strip() == "Any night under 6 hours of sleep since your last lift day?"
              and page.inner_text("#sleep-hint").strip() == "Made-up sleep hint."
              and page.evaluate("() => { const c = document.getElementById('sleep-card'), h = document.querySelector('.day-head'); return !!c && !!h && !!(c.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING); }"),
              page.inner_text("#today")[:120])
        check(tag + "sleep card: no answer shows both chips plain", page.get_attribute("#sleep-no", "aria-pressed") == "false" and page.get_attribute("#sleep-yes", "aria-pressed") == "false")
        page.click("#sleep-no"); settle(page, 400)
        d = day_row(page)
        check(tag + "sleep card: No is stored and picked, and the day stays planned (a chip never opens the day)",
              page.get_attribute("#sleep-no", "aria-pressed") == "true" and d["short_sleep_since_last"] is False and d["status"] == "planned", d and d["status"])
        page.click("#sleep-no"); settle(page, 400)
        d = day_row(page)
        check(tag + "sleep card: tapping the picked chip clears it", d["short_sleep_since_last"] is None and page.get_attribute("#sleep-no", "aria-pressed") == "false")
        page.click("#sleep-yes"); settle(page, 400)
        d = day_row(page)
        check(tag + "sleep card: Yes is stored and picked", d["short_sleep_since_last"] is True and page.get_attribute("#sleep-yes", "aria-pressed") == "true" and d["status"] == "planned")
        layout(page, tag, "sleep card")
        # The first tick hides the card and keeps the answer.
        sid = open_set(page)
        tick(page, sid)
        d = day_row(page)
        check(tag + "sleep card: hidden once the day opens; the answer stays", page.locator("#sleep-card").count() == 0 and d["status"] == "open" and d["short_sleep_since_last"] is True)
        # No Adjust each round part on a Fixed block.
        check(tag + "fixed: no why line, no soreness sheet, no marks", page.locator(".ex-why").count() == 0 and page.locator("#sore-sheet").count() == 0
              and page.locator(".mark").count() == 0)
        # Set kind (both profiles): a warm-up has no Set kind row; a work set's picker has the two kinds.
        warm = page.evaluate("() => { const r = [...document.querySelectorAll('.set.is-open')][0]; return r ? r.getAttribute('data-set') : null; }")
        if warm and ":w" in warm:
            page.click("[data-setmenu='%s']" % warm); page.wait_for_selector("#set-menu")
            check(tag + "set kind: never offered on a warm-up", page.locator("#set-menu [data-setitem='kind']").count() == 0)
            page.keyboard.press("Escape"); scrim_tap(page) if page.locator("#set-menu").count() else None; settle(page)
            while (open_set(page) or "").find(":w") >= 0:
                tick(page)
        sid = open_set(page)
        page.click("[data-setmenu='%s']" % sid); page.wait_for_selector("#set-menu")
        page.click("#set-menu [data-setitem='kind']")
        page.wait_for_selector("#setkind-sheet")
        chips = page.eval_on_selector_all("#setkind-sheet [data-kind]", "els => els.map(e => [e.getAttribute('data-kind'), e.getAttribute('aria-pressed'), e.innerText.replace(/\\s+/g, ' ').trim()])")
        check(tag + "set kind: the picker lists Work then To failure with their lines, the current one picked",
              [c[0] for c in chips] == ["normal", "failure"] and chips[0][1] == "true" and chips[1][1] == "false"
              and "Work" in chips[0][2] and "Counts in your totals and in sets per muscle." in chips[0][2]
              and "To failure" in chips[1][2] and "Counts as a work set." in chips[1][2], chips)
        layout(page, tag, "set kind picker")
        page.click("#setkind-sheet [data-kind='failure']")
        poll(page, "() => !document.getElementById('setkind-sheet')"); settle(page, 400)
        row = next(r for r in rows(page, "sets") if r["id"] == sid)
        pill = page.locator(q(sid) + " .helper .pill-kind[data-kind='failure']")
        check(tag + "set kind: To failure shows its pill in the helper slot and is stored as his pick",
              pill.count() == 1 and pill.inner_text().strip() == "To failure" and row["set_type"] == "failure" and row["set_type_by_hand"] is True, row["set_type"])
        ctx.close()

    # (a) Fixed: round 2 day A's first tick opens no soreness sheet (none in Fixed, 16 B.3.14).
    def part_fixed_round2():
        ctx, page = fixed_page()
        for _ in range(2):   # round 1 day A, then day B, every set ticked with its target
            guard = 0
            while open_set(page) and guard < 40:
                tick(page, fb="save")
                guard += 1
            check(tag + "fixed round 2: a day finishes", finish(page))
        d = day_row(page)
        check(tag + "fixed round 2: Today is round 2 day A", d and d["pass"] == 2 and d["day"] == 1, d and (d["pass"], d["day"]))
        sid = open_set(page)
        page.click(q(sid) + " [data-tick]")
        wait_state(page, sid, "done"); settle(page, 600)
        check(tag + "soreness sheet: none at round 2 day A's first tick in Fixed", page.locator("#sore-sheet").count() == 0)
        ctx.close()

    # Close block (both profiles; shown here on Fixed): refused with a day open, then the Block finished state.
    def part_close():
        ctx, page = fixed_page()
        sid = open_set(page)
        tick(page, sid)
        day_item(page, "end")
        check(tag + "close block: refused while a day is open with the end.open toast, no sheet",
              page.locator("#end-sheet").count() == 0 and toast_text(page) == "Finish the open day first.", toast_text(page))
        ctx.close()
        ctx, page = fixed_page()
        page.click("#day-menu"); page.wait_for_selector("#day-menu-sheet")
        items = page.eval_on_selector_all("#day-menu-sheet [data-dayitem]", "els => els.map(e => [e.getAttribute('data-dayitem'), e.classList.contains('menu-row-sep')])")
        check(tag + "day menu: Add an exercise first, Close block last, the hairline on the first block-moving row",
              items and items[0][0] == "addex" and items[-1][0] == "end" and [k for k, s_ in items if s_] == ["skip"], items)
        page.click("#day-menu-sheet [data-dayitem='end']")
        page.wait_for_selector("#end-sheet")
        check(tag + "close block: the confirm says what happens", "The block is marked finished. Your logged days stay." in page.inner_text("#end-sheet")
              and page.inner_text("#end-go").strip() == "Close block")
        layout(page, tag, "close block confirm")
        page.click("#end-go")
        # PD210: a missing Block finished state fails this check by its name, never a timeout.
        # Slice 3 (17 C.3.9): the Block finished screen first, with the nudge over it once; Today then
        # shows the Block finished row.
        try:
            page.wait_for_selector("#finished #fin-new", timeout=10000)
            if poll_quiet(page, "() => !!document.getElementById('nudge')", 3000):
                page.click("#nudge-later")
            go_route(page, "#/today", "#block-done")
            shown = True
        except Exception:
            shown = False
        blocks = rows(page, "blocks"); days = rows(page, "days")
        check(tag + "close block: Today shows the Block finished state; the block is done and its planned day stays",
              shown and blocks[0]["status"] == "done" and any(d["status"] == "planned" for d in days), {"shown": shown, "days": [d["status"] for d in days]})
        ctx.close()

    # Add exercise and Take out this exercise (both profiles; Fixed here): the picker, the sets sheet, the scope sheet.
    def part_add_remove():
        ctx, page = fixed_page()
        day_item(page, "addex")
        page.wait_for_selector("#picker")
        page.click("[data-pick='cable_row']")
        page.wait_for_selector("#addex-sheet")
        check(tag + "add exercise: the sets sheet starts at 1 in Fixed, minus off at 1", page.inner_text("#addex-count").strip() == "1" and page.is_disabled("#addex-less"))
        page.click("#addex-more"); settle(page, 200)
        check(tag + "add exercise: plus moves the count", page.inner_text("#addex-count").strip() == "2")
        layout(page, tag, "add exercise sets sheet")
        page.click("#addex-save")
        page.wait_for_selector("#scope-sheet")
        check(tag + "rest of block: the sheet asks Change which days? with Today only first, then Rest of block and its line",
              page.inner_text("#scope-sheet h2").strip() == "Change which days?"
              and page.eval_on_selector_all("#scope-sheet [data-scope]", "els => els.map(e => e.getAttribute('data-scope'))") == ["today", "rest"]
              and page.inner_text("#scope-rest-line").strip() == "Later days that have this slot. Done days never change.")
        layout(page, tag, "rest of block choice")
        scope(page, "today")
        added = [r for r in rows(page, "sets") if r["exercise_id"] == "cable_row"]
        tpl = rows(page, "blocks")[0]["day_templates"][0]["lifts"]
        check(tag + "add exercise: Today only adds a card with 2 sets and leaves the block as written",
              page.locator("[data-exercise='cable_row'] .set").count() == 2 and len(added) == 2 and all(r["origin"] == "added" for r in added)
              and not any(l["exercise_id"] == "cable_row" for l in tpl), len(added))
        day_item(page, "addex")
        page.wait_for_selector("#picker")
        page.click("[data-pick='leg_extension']")
        page.wait_for_selector("#addex-sheet")
        page.click("#addex-save")
        scope(page, "rest")
        tpl = rows(page, "blocks")[0]["day_templates"][0]["lifts"]
        check(tag + "add exercise: Rest of block also adds the lift to the block's day", any(l["exercise_id"] == "leg_extension" for l in tpl), [l["exercise_id"] for l in tpl])
        # Take out this exercise, Today only: every set not done is skipped.
        slot = page.get_attribute("[data-exercise='cable_row']", "data-slot")
        menu_item(page, slot, "remove")
        scope(page, "today")
        st = [r["status"] for r in rows(page, "sets") if r["exercise_id"] == "cable_row"]
        check(tag + "remove: Today only skips every set not done", st and all(x == "skipped" for x in st), st)
        ctx.close()
        # The day's last exercise is refused, with its reason in the sheet.
        ctx, page = fixed_page()
        for s_ in ("2", "3"):
            menu_item(page, s_, "remove")
            scope(page, "today")
            answer_fb(page, "later")
        menu_item(page, "1", "remove")
        page.wait_for_selector("#scope-sheet")
        check(tag + "remove: the last exercise is refused with A day keeps at least 1 exercise.",
              page.is_disabled("#scope-rest") and page.get_attribute("#scope-rest", "aria-disabled") == "true"
              and page.inner_text("#scope-rest-line").strip() == "A day keeps at least 1 exercise.")
        page.click("#scope-cancel"); settle(page)
        ctx.close()

    # Change answers (both profiles): the saved sheet reopens with its answers, and Save writes a new saved_at.
    def part_answers():
        ctx, page = fixed_page()
        slot = "3"   # seated leg curl: 2 sets, then the feedback sheet
        guard = 0
        while guard < 4 and page.locator("[data-slot='%s'] .set[data-state='todo'], [data-slot='%s'] .set.is-open" % (slot, slot)).count():
            sid = page.evaluate("(sl) => { const r = document.querySelector('[data-slot=\"' + sl + '\"] .set:not([data-state=\"done\"]):not([data-state=\"skipped\"])'); return r ? r.getAttribute('data-set') : null; }", slot)
            if not sid:
                break
            page.click(q(sid) + " [data-tick]")
            wait_state(page, sid, "done"); settle(page, 500)
            if page.locator("#feedback").count():
                page.click("#feedback [data-answer='pump-2']")
                page.click("#fb-save"); poll(page, "() => !document.getElementById('feedback')"); settle(page)
            guard += 1
        before = next(f for f in rows(page, "feedback") if f["id"].endswith(":x" + slot))
        menu_item(page, slot, "answers")
        page.wait_for_selector("#feedback")
        check(tag + "change answers: the sheet opens with the saved answer picked", page.get_attribute("#feedback [data-answer='pump-2']", "aria-pressed") == "true")
        page.click("#feedback [data-answer='pump-4']")
        page.wait_for_timeout(1100)   # a new saved_at, later than the first
        page.click("#fb-save"); poll(page, "() => !document.getElementById('feedback')"); settle(page)
        after = next(f for f in rows(page, "feedback") if f["id"].endswith(":x" + slot))
        check(tag + "change answers: Save writes the new answer with a new saved_at", after["pump"] == 4 and after["saved_at"] > before["saved_at"] and after["pending"] is False,
              {"before": before["pump"], "after": after["pump"]})
        ctx.close()

    # (b) Adjust each round (the backup_v2.json block, switched on 2026-12-02; clock 2026-12-05).
    def part_adaptive():
        ctx, page, out = adaptive_page()
        check(tag + "adaptive: the restore worked and Today shows Adjust each round", out == "restored" and page.get_attribute("#today", "data-profile") == "adaptive", out)
        d = day_row(page)
        check(tag + "adaptive: Today is round 2 day A, planned", d and d["pass"] == 2 and d["day"] == 1 and d["status"] == "planned", d and (d["pass"], d["day"], d["status"]))
        check(tag + "sleep card: shown in Adjust each round too", page.locator("#sleep-card").count() == 1)
        whys = page.eval_on_selector_all(".ex-why", "els => els.map(e => [e.closest('.ex-card').getAttribute('data-slot'), e.getAttribute('data-why'), e.innerText.trim()])")
        check(tag + "why line: each card shows its plan reason under the header",
              ["1", "why.sleep", "Sleep was short or not answered this round."] in whys and ["2", "why.R11", "No clear signal. Sets stay the same."] in whys
              and ["3", "why.R7", "This muscle is on Hold. Sets stay the same."] in whys, whys)
        layout(page, tag, "adaptive today")
        # The first saved tick (the leg press warm-up): the soreness question alone (quads trained in round 1).
        sid = open_set(page)
        page.click(q(sid) + " [data-tick]")
        wait_state(page, sid, "done")
        # PD214: a sheet that never opens fails this check by its name, never a timeout.
        try:
            page.wait_for_selector("#sore-sheet", timeout=8000)
            sore_shown = True
        except Exception:
            sore_shown = False
        check(tag + "soreness sheet: alone at round 2 day A's first tick in Adjust each round",
              sore_shown and page.locator("#feedback").count() == 0 and page.inner_text("#sore-sheet h2").strip().endswith(", one question")
              and "1 quick question" in page.inner_text("#sore-sheet") and page.locator("#sore-sheet [data-answer^='soreness-']").count() == 4
              and page.locator("#sore-save").count() == 1 and page.locator("#sore-later").count() == 1 and page.locator("#sore-skip").count() == 1)
        if not sore_shown:
            ctx.close()
            return
        layout(page, tag, "soreness sheet")
        page.click("#sore-sheet [data-answer='soreness-2']")
        page.click("#sore-save"); poll(page, "() => !document.getElementById('sore-sheet')"); settle(page)
        f = next((x for x in rows(page, "feedback") if x["id"] == d["id"] + ":x1"), None)
        check(tag + "soreness sheet: Save stores soreness in the slot's row, still pending", f and f["soreness"] == 2 and f["pending"] is True, f)
        # The retarget line: the open work row at a weight inside the band, then outside it.
        sid = open_set(page)
        page.click(q(sid) + " [data-step='load+']"); settle(page, 500)
        h = page.locator(q(sid) + " .helper")
        check(tag + "retarget line: inside the band the helper gives the goal at this weight",
              h.get_attribute("data-retarget") == "goal" and h.inner_text().strip().startswith("goal at this weight: 7 reps"), h.inner_text())
        for _ in range(4):
            page.click(q(sid) + " [data-step='load+']"); settle(page, 400)
        check(tag + "retarget line: outside the band only the effort part shows", h.get_attribute("data-retarget") == "effort" and h.inner_text().strip() == "stop 1 short", h.inner_text())
        for _ in range(5):
            page.click(q(sid) + " [data-step='load-']"); settle(page, 400)
        check(tag + "retarget line: back at the target the goal line stands", h.get_attribute("data-retarget") is None, h.inner_text())
        # Met and missed marks: a set at its goal is met; one rep under is under goal; the failure set has none.
        tick(page, sid, fb="none")
        check(tag + "marks: a done set that met its rep goal shows met", page.inner_text(q(sid) + " [data-mark='met']").strip() == "met")
        sid2 = open_set(page)
        page.click(q(sid2) + " [data-step='reps-']"); settle(page, 400)
        page.click(q(sid2) + " [data-tick]"); settle(page, 500)
        if page.locator("#range-sheet").count():
            page.click("#range-log")
        wait_state(page, sid2, "done"); settle(page, 500)
        answer_fb(page, "skip" if page.locator("#fb-skip").count() else "later")
        check(tag + "marks: a done set under its rep goal shows under goal, never in the fail color",
              page.inner_text(q(sid2) + " [data-mark='under']").strip() == "under goal"
              and page.evaluate("(id) => { const m = document.querySelector('[data-set=\"' + id + '\"] .mark'); return !!m && getComputedStyle(m).color !== getComputedStyle(document.documentElement).getPropertyValue('--fail'); }", sid2))
        check(tag + "marks: none on a warm-up", page.locator("[data-set$=':w1:none'] .mark").count() == 0)
        ctx.close()

    # (c) Live edits in Adjust each round: Add set, Move, Swap, Relabel, Add exercise, Take out; done days untouched.
    def part_live():
        ctx, page, out = adaptive_page()
        done_before = json.dumps(sorted([r for r in rows(page, "sets") if ":p1:" in r["id"]], key=lambda r: r["id"]), sort_keys=True)
        n0 = page.locator("[data-slot='1'] .set").count()
        page.click("[data-addset='1']")
        scope(page, "today")
        check(tag + "rest of block: Add set asks first in Adjust each round; Today only adds one row", page.locator("[data-slot='1'] .set").count() == n0 + 1)
        menu_item(page, "1", "down")
        scope(page, "rest")
        order = [l["slot"] for l in rows(page, "blocks")[0]["day_templates"][0]["lifts"]]
        check(tag + "rest of block: Move down with Rest of block reorders the block's day", order[:2] == [2, 1], order)
        menu_item(page, "2", "3")
        page.wait_for_selector("#picker")
        page.click("[data-pick='leg_extension']")
        scope(page, "rest")
        lifts = rows(page, "blocks")[0]["day_templates"][0]["lifts"]
        check(tag + "rest of block: a later planned day shows the new exercise (the block's day now holds it)",
              any(l["exercise_id"] == "leg_extension" for l in lifts) and page.locator("[data-exercise='leg_extension']").count() == 1, [l["exercise_id"] for l in lifts])
        day_item(page, "relabel")
        page.wait_for_selector("#relabel-sheet")
        page.fill("#relabel-in", "Z")
        page.click("#relabel-save")
        scope(page, "rest")
        poll(page, "() => !document.getElementById('relabel-sheet')")
        check(tag + "rest of block: Relabel with Rest of block writes the block's day label", rows(page, "blocks")[0]["day_templates"][0]["label"] == "Z")
        day_item(page, "addex")
        page.wait_for_selector("#picker")
        page.click("[data-pick='cable_fly']")
        page.wait_for_selector("#addex-sheet")
        page.click("#addex-save")
        scope(page, "rest")
        check(tag + "rest of block: Add exercise with Rest of block adds a card and a block lift",
              page.locator("[data-exercise='cable_fly']").count() == 1 and any(l["exercise_id"] == "cable_fly" for l in rows(page, "blocks")[0]["day_templates"][0]["lifts"]))
        menu_item(page, "3", "remove")
        scope(page, "today")
        answer_fb(page, "later")
        st = [r["status"] for r in rows(page, "sets") if r["id"].startswith(page.get_attribute("#today", "data-day") + ":x3:")]
        check(tag + "remove: Today only in Adjust each round skips the card's sets", st and all(x == "skipped" for x in st), st)
        done_after = json.dumps(sorted([r for r in rows(page, "sets") if ":p1:" in r["id"]], key=lambda r: r["id"]), sort_keys=True)
        check(tag + "rest of block: the done days are the same before and after every edit", done_before == done_after)
        ctx.close()

    # ---------------- B.1 steps 8 and 9: the Block tab, the read-only day view, the switch ----------------

    def clear_sheets(page):
        """Pass the sheets a tick can open (the soreness-alone sheet, the end sheet, the range ask)."""
        for _ in range(6):
            settle(page, 300)
            if page.locator("#sore-sheet").count():
                page.click("#sore-skip"); poll(page, "() => !document.getElementById('sore-sheet')"); continue
            if page.locator("#feedback").count():
                # The end sheet after a tick has Ask me later; the Finish day one has Skip (today.js noLater).
                page.click("#fb-skip" if page.locator("#fb-skip").count() else "#fb-later")
                poll(page, "() => !document.getElementById('feedback')"); continue
            if page.locator("#range-sheet").count():
                page.click("#range-log"); continue
            break

    def play_day(page):
        """Tick every set of the day Today shows at its target, then Finish day (through Day done)."""
        guard = 0
        while open_set(page) and guard < 60:
            sid = open_set(page)
            page.click(q(sid) + " [data-tick]")
            wait_state(page, sid, "done")
            clear_sheets(page)
            guard += 1
        finish(page)
        leave_day_done(page)
        go_route(page, "#/today", "#today[data-day]")

    # Slice 3 (17 C.3.11): the round grid replaced the round strip; every round's days show at once.
    def block_tab(page, rnd=None):
        go_route(page, "#/block", "#block #round-grid")
        settle(page, 300)

    def strip(page):
        return page.eval_on_selector_all("#round-grid [data-round]", "els => els.map(e => [e.getAttribute('data-round'), e.getAttribute('data-state'), e.getAttribute('data-easy'), e.innerText.replace(/\\s+/g, ' ').trim()])")

    # The cells of one round (the current round by default): [ref, status, now, aria-label].
    def day_rows(page, rnd=None):
        r = rnd or int(page.get_attribute("#round-grid [data-round][data-state='now']", "data-round") or 1)
        return page.eval_on_selector_all("#round-grid [data-blockday*=':p%d:d']" % r, "els => els.map(e => [e.getAttribute('data-blockday'), e.getAttribute('data-status'), e.getAttribute('data-now'), e.getAttribute('aria-label')])")

    def no_write_controls(page):
        return page.evaluate("() => { const v = document.getElementById('dayview'); return !!v && v.querySelectorAll('button, input, [data-tick], [data-step], [data-setmenu], [data-menu], #day-menu, #finish-day, #sleep-card').length === 0; }")

    # (e) Block overview: strip states, day rows, muscle sets with the change line; the views of a
    # day not planned yet and of a round 1 day planned but not current; the bad id route case.
    def part_block():
        ctx, page, out = adaptive_page()
        block_tab(page)
        st = strip(page)
        check(tag + "(e) block overview: the round grid shows R1 done, R2 now, R3 later and R4 easy",
              [x[:3] for x in st] == [["1", "done", "false"], ["2", "now", "false"], ["3", "later", "false"], ["4", "later", "true"]]
              and [x[3].split(" ")[0] for x in st] == ["R1", "R2", "R3", "R4"], st)
        check(tag + "(e) block overview: the head line names the block, its rounds and Adjust each round",
              page.inner_text("#block-head").strip() == "Made-up schema two block · 4 rounds · Adjust each round", page.inner_text("#block-head"))
        check(tag + "(e) block overview: the current round has the accent border",
              page.evaluate("() => { const c = document.querySelector(\"#round-grid [data-round='2']\"), o = document.querySelector(\"#round-grid [data-round='3']\"); return getComputedStyle(c).borderTopWidth === '2px' && getComputedStyle(o).borderTopWidth === '1px'; }"))
        dr = day_rows(page)
        check(tag + "(e) block overview: ROUND 2 day rows read Day A Now and Day B Not planned yet",
              len(dr) == 2 and dr[0][1] == "planned" and dr[0][2] == "true" and dr[0][3].endswith(": current")
              and dr[1][1] == "notplanned" and dr[1][3].endswith(": not planned yet"), dr)
        # Slice 3 (17 C.3.10, LOOK 4.7): the sets-by-muscle table moved to the Block summary (e2e slice3 summary part).
        check(tag + "(e) block overview: Close block is a secondary button", page.locator("#block-end.btn-secondary").count() == 1)
        layout(page, tag, "block overview")
        # A round 4 day (easy round, not planned yet) with hard days left: the stop sheet (plural line).
        block_tab(page, 4)
        page.click("#round-grid [data-blockday$=':p4:d1']")
        page.wait_for_selector("#easy-sheet")
        check(tag + "stop sheet: with 4 hard days left the line counts them",
              page.inner_text("#easy-line").strip() == "4 hard days are not finished yet." and page.inner_text("#easy-sheet h2").strip() == "Finish the hard days first")
        page.click("#easy-cancel"); poll(page, "() => !document.getElementById('easy-sheet')")
        # Round 3 day A: not planned yet, read only.
        block_tab(page, 3)
        page.click("#round-grid [data-blockday$=':p3:d1']")
        page.wait_for_selector("#dayview[data-state='notplanned']")
        check(tag + "(e) not planned yet: the pill and its line, one row per set, empty cells, nothing that writes",
              page.inner_text("#state-pill").strip() == "Not planned yet" and page.inner_text("#day-line").strip() == "Its numbers are set when the day before it is finished."
              and page.locator("#dayview .set.is-notplanned").count() >= 3 and no_write_controls(page)
              and page.inner_text("#day-back").strip() == "Back" and page.locator(".tab.is-active[data-tab='#/block']").count() == 1)
        layout(page, tag, "not planned yet")
        # Bad ids: each goes to the Block tab.
        bid = rows(page, "blocks")[0]["id"]
        for bad in ("nope", "__proto__", bid + ":p9:d1", bid + ":p1:d7", "x%20y"):
            page.evaluate("h => { location.hash = h; }", "#/day/" + bad)
            try:
                page.wait_for_selector("#block #round-grid", timeout=6000)
                ok = True
            except Exception:
                ok = False
            check(tag + "(e) bad id: #/day/" + bad[-12:] + " goes to the Block tab", ok and page.locator("#dayview").count() == 0)
        ctx.close()
        # A round 1 day planned but not current: its targets read only with day.later.line.
        ctx, page = fixed_page()
        block_tab(page)
        page.click("#round-grid [data-blockday$=':p1:d2']")
        page.wait_for_selector("#dayview[data-state='later']")
        helpers = page.eval_on_selector_all("#dayview .set .helper", "els => els.map(e => e.innerText.trim()).filter(Boolean)")
        check(tag + "(e) planned not current: the line names the day before, the targets show read only",
              page.inner_text("#day-line").strip() == "Opens after Day A." and page.locator("#state-pill").count() == 0 and len(helpers) >= 1 and no_write_controls(page), helpers[:2])
        page.click("#day-back")
        page.wait_for_selector("#block #round-grid")
        check(tag + "(e) the Back link goes to the Block tab", page.locator("#dayview").count() == 0)
        ctx.close()

    # (d) Skip day, then open that day from the Block tab: read only, status stays skipped (R47).
    def part_skipview():
        ctx, page = fixed_page()
        d = day_row(page)
        day_item(page, "skip")
        page.wait_for_selector("#skipday-sheet")
        page.click("#skipday-go")
        page.wait_for_selector("#skipday-sheet", state="detached")
        settle(page, 400)
        block_tab(page)
        dr = day_rows(page)
        check(tag + "(d) block overview: the skipped day shows the Skipped pill, the next day Now",
              dr[0][1] == "skipped" and dr[0][3].endswith(": skipped") and dr[1][2] == "true", dr)
        page.click("#round-grid [data-blockday='%s']" % d["id"])
        page.wait_for_selector("#dayview[data-state='skipped']")
        page.evaluate("() => { const r = document.querySelector('#dayview .set'); if (r) r.click(); }")
        settle(page, 400)
        after = next(x for x in rows(page, "days") if x["id"] == d["id"])
        check(tag + "(d) read only: a skipped day opened from the Block tab has no tick, set tap or day menu and stays skipped",
              no_write_controls(page) and page.inner_text("#state-pill").strip() == "Skipped" and after["status"] == "skipped"
              and page.locator("#dayview .set.is-skipped").count() >= 1, after["status"])
        layout(page, tag, "skipped day read only")
        ctx.close()

    # (a) and (b) the switch: absent before 2026-12-01; by three ticks and typed ADJUST after; no
    # condition words keep it shut; Back to Fixed with one confirm.
    def part_switch():
        ctx, page = fixed_page()
        go_route(page, "#/settings", "#settings #block-card")
        settle(page, 600)
        check(tag + "(a) settings: the Adjust each round row is not in the DOM at 2026-11-20",
              page.locator("#adjust-row").count() == 0 and page.locator("#adjust-back").count() == 0 and page.locator("#load-block-row").count() == 1)
        ctx.close()
        ctx, page = new(ADAPT_NOW)
        page.click("#unit-lb")
        load_block_file(page, BLOCK_V2)
        go_route(page, "#/settings", "#settings #block-card")
        page.wait_for_selector("#adjust-row", timeout=8000)
        check(tag + "(b) settings: the row reads Adjust each round inside the BLOCK group",
              page.inner_text("#adjust-row").strip() == "Adjust each round" and page.locator("#block-group #adjust-row").count() == 1)
        page.click("#adjust-row")
        page.wait_for_selector("#adjust-sheet")
        conds = page.eval_on_selector_all("#adjust-sheet [data-cond]", "els => els.map(e => [e.getAttribute('aria-checked'), e.innerText.trim()])")
        check(tag + "(b) switch: the sheet shows his three condition lines as check rows, then the line and the field",
              [c[1] for c in conds] == ["Made-up condition line one.", "Made-up condition line two.", "Made-up condition line three."]
              and all(c[0] == "false" for c in conds) and page.inner_text("#adjust-line").strip() == "Your coach must say yes to all 3 first."
              and page.is_disabled("#adjust-go"), conds)
        layout(page, tag, "adjust sheet")
        page.click("#adjust-sheet [data-cond='0']"); page.click("#adjust-sheet [data-cond='1']")
        page.fill("#adjust-in", "ADJUST")
        check(tag + "(b) switch: two ticks and ADJUST keep the primary disabled", page.is_disabled("#adjust-go"))
        page.click("#adjust-sheet [data-cond='2']")
        page.fill("#adjust-in", "adjust")
        check(tag + "(b) switch: three ticks and the word in small letters keep it disabled", page.is_disabled("#adjust-go"))
        page.fill("#adjust-in", " ADJUST ")
        check(tag + "(b) switch: three ticks and ADJUST turn the primary on", not page.is_disabled("#adjust-go"))
        page.click("#adjust-go")
        poll(page, "() => !document.getElementById('adjust-sheet')")
        page.wait_for_selector("#adjust-back", timeout=8000)
        b = rows(page, "blocks")[0]
        check(tag + "(b) switch: the block is on Adjust each round with his three ticks; the row now reads Back to Fixed",
              b["profile"] == "adaptive" and b["profile_switch"]["ticks"] == [True, True, True] and b["profile_switch"]["back_at"] is None
              and page.inner_text("#adjust-back").strip() == "Back to Fixed" and page.locator("#adjust-row").count() == 0, b["profile"])
        go_route(page, "#/today", "#today[data-day]")
        check(tag + "(b) switch: Today shows Adjust each round", page.get_attribute("#today", "data-profile") == "adaptive")
        go_route(page, "#/settings", "#settings #block-card")
        page.wait_for_selector("#adjust-back")
        page.click("#adjust-back")
        page.wait_for_selector("#adjust-back-sheet")
        check(tag + "(b) back to Fixed: one confirm with its title and line, no typed word",
              page.inner_text("#adjust-back-sheet h2").strip() == "Go back to Fixed?" and "Days not started go back to as written. Logged days stay." in page.inner_text("#adjust-back-sheet")
              and page.locator("#adjust-back-sheet input").count() == 0)
        page.click("#adjust-back-go")
        poll(page, "() => !document.getElementById('adjust-back-sheet')")
        page.wait_for_selector("#adjust-row", timeout=8000)
        b = rows(page, "blocks")[0]
        check(tag + "(b) back to Fixed: the block is Fixed, back_at is set, the Adjust each round row is back",
              b["profile"] == "fixed" and b["profile_switch"]["back_at"] is not None, b["profile"])
        ctx.close()
        # A block with no condition words: no check rows, and the primary never turns on.
        ctx, page = new(ADAPT_NOW)
        page.click("#unit-lb")
        load_block_file(page, os.path.join(FIXTURES, "block_v1.json"))
        go_route(page, "#/settings", "#settings #block-card")
        page.wait_for_selector("#adjust-row", timeout=8000)
        page.click("#adjust-row")
        page.wait_for_selector("#adjust-sheet")
        page.fill("#adjust-in", "ADJUST")
        check(tag + "(b) switch: with no condition words the sheet has no check rows and stays shut",
              page.locator("#adjust-sheet [data-cond]").count() == 0 and page.locator("#adjust-line").count() == 1 and page.is_disabled("#adjust-go"))
        ctx.close()

    # (b) the stop sheet when an easy-round day is opened from the Block tab while round 3 day B is open (M40).
    def part_stop():
        ctx, page, out = adaptive_page()
        for _ in range(3):      # round 2 day A, round 2 day B, round 3 day A
            play_day(page)
        d = day_row(page)
        check(tag + "stop sheet: Today is round 3 day B", d and d["pass"] == 3 and d["day"] == 2, d and (d["pass"], d["day"]))
        sid = open_set(page)
        page.click(q(sid) + " [data-tick]")
        wait_state(page, sid, "done")
        clear_sheets(page)
        block_tab(page, 4)
        page.click("#round-grid [data-blockday$=':p4:d1']")
        try:
            page.wait_for_selector("#easy-sheet", timeout=6000)
            shown = True
        except Exception:
            shown = False
        check(tag + "stop sheet: an easy-round day opened from the Block tab while round 3 day B is open shows the stop sheet",
              shown and page.inner_text("#easy-line").strip() == "1 hard day is not finished yet." and page.inner_text("#easy-go").strip() == "Go to the open day"
              and page.locator("#dayview").count() == 0)
        layout(page, tag, "easy round stop sheet")
        if shown:
            page.click("#easy-go")
            page.wait_for_selector("#today[data-day]")
            check(tag + "stop sheet: the primary goes to the open day", page.get_attribute("#today", "data-day") == d["id"] and page.get_attribute("#today", "data-status") == "open")
        ctx.close()

    # ---------------- B.1 step 11: block_rounds.json played by taps with its answer script ----------------
    # The same script and table engine.test.js plays through the store (16 B.12 last paragraph), so the
    # browser and node prove the same numbers: counts, loads, rep goals and reps-left goals per round.

    SCRIPT = json.load(open(ROUNDS_SCRIPT))
    ROUND_LIFTS = {d["day"]: {l["slot"]: l for l in d["lifts"]} for d in json.load(open(ROUNDS))["block"]["day_templates"]}

    def day_sets(page, did):
        return sorted([r for r in rows(page, "sets") if r["day_id"] == did], key=lambda r: (r["slot"], r["set_n"], r["id"]))

    def table_of(page, did):
        """The planned work sets of a day as the table writes them: {slot: {why, sets: [[load, low, high, left]]}}."""
        out = {}
        for r in day_sets(page, did):
            if r["kind"] != "work" or r["origin"] != "plan" or r["side"] not in ("none", "L"):
                continue
            s_ = out.setdefault(str(r["slot"]), {"why": r["why"], "sets": []})
            t_ = r["target"]
            s_["sets"].append([t_["load"], t_["rep_low"], t_["rep_high"], t_["reps_left_target"]])
        return out

    def fmt_num(v):
        return str(int(v)) if float(v).is_integer() else str(v)

    def type_val(page, sid, kind, value):
        """Types a value into the open row's load or reps cell (the val button turns into its field)."""
        page.click(q(sid) + " [data-val='%s']" % kind)
        sel = q(sid) + " [data-input='%s']" % kind
        page.wait_for_selector(sel, timeout=5000)
        fill_change(page, sel, fmt_num(value))
        settle(page, 300)

    def pick(page, sel):
        """Taps a chip unless it is already picked (a second tap would clear it)."""
        if page.locator(sel).count() and page.get_attribute(sel, "aria-pressed") != "true":
            page.click(sel)

    def answer_sheets(page, key, seen):
        """Answers what a tick opened by the script: the range ask (log it), the soreness-alone sheet
        (the slot's soreness, Save) and the feedback sheet (every question it shows, the check, Save)."""
        sc = SCRIPT["days"].get(key, {})
        for i_ in range(8):
            settle(page, 600 if i_ == 0 else 300)   # a sheet opens after the redraw that follows the tick
            if page.locator("#range-sheet").count():
                page.click("#range-log"); continue
            if page.locator("#sore-sheet").count():
                seen["sore"] = seen.get("sore", 0) + 1
                slot = seen["slot"]
                a = dict(SCRIPT["defaults"]); a.update((sc.get("fb") or {}).get(str(slot), {}))
                pick(page, "#sore-sheet [data-answer='soreness-%d']" % a["soreness"])
                page.click("#sore-save"); poll(page, "() => !document.getElementById('sore-sheet')")
                continue
            if page.locator("#feedback").count():
                slot = seen["slot"]
                a = dict(SCRIPT["defaults"]); a.update((sc.get("fb") or {}).get(str(slot), {}))
                for k in ("pump", "soreness", "workload"):
                    pick(page, "#feedback [data-answer='%s-%d']" % (k, a[k]))
                pick(page, "#feedback [data-answer='check-check_a-%d']" % (2 if a["check_a"] else 1))
                page.click("#fb-save"); poll(page, "() => !document.getElementById('feedback')")
                continue
            break

    def log_open_sets(page, key, profile, seen, stop_after=None):
        """Logs every set of the day Today shows at its fill values, in the order the app opens them.
        stop_after=n returns after n sets (the rest are logged by a second call)."""
        sc = SCRIPT["days"].get(key, {})
        day_n = int(key.split(":")[1])
        guard, done = 0, 0
        while open_set(page) and guard < 40:
            sid = open_set(page)
            row = next(r for r in rows(page, "sets") if r["id"] == sid)
            lift = ROUND_LIFTS[day_n][row["slot"]]
            named = ((sc.get("reps") or {}).get(str(row["slot"])) or {}).get(str(row["set_n"]))
            want_load = row["target"]["load"] if row["target"]["load"] is not None else lift["start_load"]
            want_reps = named if named is not None else (row["target"]["rep_low"] if row["target"]["rep_low"] is not None else lift["rep_low"])
            # What the row shows before typing: a draft (a weight copied down from an earlier set) else the target.
            draft = row.get("draft") or {}
            shown_load = draft["load"] if draft.get("load") is not None else row["target"]["load"]
            shown_reps = draft["reps"] if draft.get("reps") is not None else row["target"]["rep_low"]
            if shown_load != want_load:
                type_val(page, sid, "load", want_load)
            if shown_reps != want_reps:
                type_val(page, sid, "reps", want_reps)
            seen["slot"] = row["slot"]
            page.click(q(sid) + " [data-tick]")
            settle(page, 400)
            if page.locator("#range-sheet").count():
                page.click("#range-log")
            wait_state(page, sid, "done")
            answer_sheets(page, key, seen)
            guard += 1
            done += 1
            if stop_after is not None and done >= stop_after:
                return

    def check_plan(page, tag_, key, profile):
        did = page.get_attribute("#today", "data-day")
        have = table_of(page, did)
        want = SCRIPT["expect"][profile][key]
        check(tag_ + key + ": every planned count, load, rep goal and reps-left goal equals the script table", have == want, {"have": have, "want": want})
        # Each planned row's helper line on the screen reads the table's target (ui/today.js helperLine on the table row).
        bad = []
        for slot, w in want.items():
            plan = [r for r in day_sets(page, did) if r["slot"] == int(slot) and r["kind"] == "work" and r["origin"] == "plan" and r["side"] in ("none", "L")]
            for r, t_ in zip(plan, w["sets"]):
                tgt = dict(r["target"]); tgt.update({"load": t_[0], "rep_low": t_[1], "rep_high": t_[2], "reps_left_target": t_[3]})
                line = page.evaluate("async ([s]) => { const m = await import('./ui/today.js'); return m.helperLine(s, null); }", [dict(r, target=tgt)])
                shown = page.inner_text(q(r["id"]) + " .helper").strip() if page.locator(q(r["id"]) + " .helper").count() else None
                if shown is None or not shown.endswith(line.strip()):
                    bad.append([r["id"][-12:], shown, line])
        check(tag_ + key + ": every planned row's helper line reads the table's goal", not bad, bad[:3])
        if profile == "adaptive" and page.get_attribute("#today", "data-profile") == "adaptive":
            whys = {s_: page.get_attribute("[data-slot='%s'] .ex-why" % s_, "data-why") if page.locator("[data-slot='%s'] .ex-why" % s_).count() else None for s_ in want}
            check(tag_ + key + ": each card's why line names the table's reason", whys == {s_: w["why"] for s_, w in want.items()}, whys)

    def switch_on(page):
        """Adjust each round by his three ticks and typed ADJUST (16 B.9), back on Today after."""
        go_route(page, "#/settings", "#settings #block-card")
        page.wait_for_selector("#adjust-row", timeout=8000)
        page.click("#adjust-row")
        page.wait_for_selector("#adjust-sheet")
        for i in range(3):
            page.click("#adjust-sheet [data-cond='%d']" % i)
        page.fill("#adjust-in", "ADJUST")
        page.click("#adjust-go")
        poll(page, "() => !document.getElementById('adjust-sheet')")
        page.wait_for_selector("#adjust-back", timeout=8000)
        go_route(page, "#/today", "#today[data-day]")

    def play_rounds(profile):
        tag_ = tag + "rounds " + profile + " "
        now_ms = ny_ms(2026, 11, 20, 12) if profile == "fixed" else ny_ms(2026, 12, 2, 12)
        ctx, page = new(now_ms)
        page.click("#unit-lb")
        load_block_file(page, ROUNDS)
        seen = {}
        for pass_n in range(1, 5):
            for day_n in (1, 2):
                key = "%d:%d" % (pass_n, day_n)
                sc = dict(SCRIPT["defaults"]); sc.update(SCRIPT["days"].get(key, {}))
                if profile == "adaptive" and key == SCRIPT["switch_on"]:
                    switch_on(page)
                    b = rows(page, "blocks")[0]
                    check(tag_ + key + ": switched to Adjust each round by three ticks and ADJUST", b["profile"] == "adaptive" and b["profile_switch"]["ticks"] == [True, True, True])
                if profile == "fixed" and day_n == 1:
                    go_route(page, "#/settings", "#settings #block-card")
                    settle(page, 400)
                    check(tag_ + key + ": the Adjust each round row is not in the DOM", page.locator("#adjust-row").count() == 0 and page.locator("#adjust-back").count() == 0)
                    go_route(page, "#/today", "#today[data-day]")
                d = day_row(page)
                if not check(tag_ + key + ": Today is round %d day %d" % (pass_n, day_n), d and d["pass"] == pass_n and d["day"] == day_n, d and (d["pass"], d["day"])):
                    break
                page.click("#sleep-yes" if sc["sleep"] else "#sleep-no")
                poll(page, "() => { const c = document.getElementById('%s'); return !!c && c.getAttribute('aria-pressed') === 'true'; }" % ("sleep-yes" if sc["sleep"] else "sleep-no"))
                settle(page, 400)
                check_plan(page, tag_, key, profile)
                easy = page.locator("#easy-pill").count() == 1
                if profile == "fixed":
                    check(tag_ + key + ": no Easy round pill in Fixed", not easy)
                elif pass_n == 4:
                    check(tag_ + key + ": the Easy round pill shows in round 4", easy and page.inner_text("#easy-pill").strip() == "Easy round", page.inner_text("#today")[:80])
                if sc.get("add_rest"):
                    n0 = page.locator("[data-slot='%d'] .set" % sc["add_rest"]).count()
                    page.click("[data-addset='%d']" % sc["add_rest"])
                    if profile == "adaptive":
                        scope(page, "rest")
                    settle(page, 400)
                    added = [r for r in day_sets(page, d["id"]) if r["slot"] == sc["add_rest"] and r["origin"] == "added"]
                    check(tag_ + key + ": Add set on slot %d adds one row (%s)" % (sc["add_rest"], "Rest of block" if profile == "adaptive" else "Today only, no scope sheet in Fixed"),
                          page.locator("[data-slot='%d'] .set" % sc["add_rest"]).count() == n0 + 1 and [r["add_scope"] for r in added] == (["rest"] if profile == "adaptive" else ["today"]),
                          [r["add_scope"] for r in added])
                if profile == "adaptive" and key == "3:2":
                    # (b) the stop sheet: an easy-round day opened from the Block tab while round 3 day B is open.
                    log_open_sets(page, key, profile, seen, stop_after=1)
                    block_tab(page, 4)
                    page.click("#round-grid [data-blockday$=':p4:d1']")
                    try:
                        page.wait_for_selector("#easy-sheet", timeout=6000)
                        shown = True
                    except Exception:
                        shown = False
                    check(tag_ + key + ": an easy-round day opened from the Block tab while round 3 day B is open shows the stop sheet",
                          shown and page.inner_text("#easy-line").strip() == "1 hard day is not finished yet.")
                    if shown:
                        page.click("#easy-go")
                        page.wait_for_selector("#today[data-day]")
                    else:
                        go_route(page, "#/today", "#today[data-day]")
                    settle(page, 300)
                log_open_sets(page, key, profile, seen)
                ok = finish(page, score=sc["score_a"], stay=True)
                on_done = page.locator("#daydone").count() == 1 and page.evaluate("() => location.hash.startsWith('#/daydone/')")
                check(tag_ + key + ": Finish day goes through the Day done screen", ok and on_done)
                leave_day_done(page)
                go_route(page, "#/today", "#today > *")
                fin = next((x for x in rows(page, "days") if x["id"] == d["id"]), None)
                check(tag_ + key + ": the day is done with the script's score", fin and fin["status"] == "done" and fin["scores"].get("score_a") == sc["score_a"], fin and (fin["status"], fin["scores"]))
        if profile == "fixed":
            check(tag_ + "no first-tick sheet on any day of the Fixed run", seen.get("sore", 0) == 0, seen.get("sore", 0))
            whys = {r["why"] for r in rows(page, "sets") if r["origin"] == "plan"}
            check(tag_ + "no easy round and no reason but the plan on any planned row", whys == {"why.plan"}, sorted(whys))
        else:
            check(tag_ + "the soreness-alone sheet opened at first ticks in Adjust each round", seen.get("sore", 0) >= 1, seen.get("sore", 0))
        layout(page, tag_, "rounds end")
        ctx.close()

    def part_rounds_fixed():
        play_rounds("fixed")

    def part_rounds_adaptive():
        play_rounds("adaptive")

    # (c) the live edits of B.12 not covered above: swap Today only (next round back to the block
    # lift), swap Rest of block (later days show the new exercise with no weight), Add exercise
    # Rest of block (1 set, effort only); a done day is deep-equal before and after each.
    def part_live2():
        ctx, page, out = adaptive_page()
        did = page.get_attribute("#today", "data-day")
        done_before = json.dumps(sorted([r for r in rows(page, "sets") if ":p1:" in r["id"]], key=lambda r: r["id"]), sort_keys=True)
        tpl0 = [l["exercise_id"] for l in rows(page, "blocks")[0]["day_templates"][0]["lifts"]]
        # Swap Today only on slot 2.
        menu_item(page, "2", "3")
        page.wait_for_selector("#picker")
        page.click("[data-pick='lying_leg_curl']")
        scope(page, "today")
        tpl1 = [l["exercise_id"] for l in rows(page, "blocks")[0]["day_templates"][0]["lifts"]]
        check(tag + "(c) swap Today only: today's card is the new exercise, the block's day keeps its lift",
              # Today only is the Slice 1 slot rule (16 B.3.13): the new exercise takes a new slot in the old
              # card's place and the old slot's planned sets are skipped.
              page.locator("[data-exercise='lying_leg_curl']").count() == 1
              and page.locator("[data-slot='2'] .set").count() == page.locator("[data-slot='2'] .set[data-state='skipped']").count() > 0
              and tpl1 == tpl0, {"before": tpl0, "after": tpl1})
        # Swap Rest of block on slot 1: the block's day takes the new exercise with no weight.
        menu_item(page, "1", "3")
        page.wait_for_selector("#picker")
        page.click("[data-pick='hack_squat']")
        scope(page, "rest")
        lift1 = next(l for l in rows(page, "blocks")[0]["day_templates"][0]["lifts"] if l["slot"] == 1)
        check(tag + "(c) swap Rest of block: the block's day holds the new exercise with no weight",
              lift1["exercise_id"] == "hack_squat" and lift1["start_load"] is None and page.locator("[data-exercise='hack_squat']").count() == 1, lift1)
        block_tab(page, 3)
        page.click("#round-grid [data-blockday$=':p3:d1']")
        page.wait_for_selector("#dayview")
        check(tag + "(c) swap Rest of block: a later day shows the new exercise; the Today only swap does not reach it",
              page.locator("#dayview [data-slot='1'][data-exercise='hack_squat']").count() == 1
              and page.locator("#dayview [data-slot='2'][data-exercise='seated_leg_curl']").count() == 1)
        go_route(page, "#/today", "#today[data-day]")
        # Add exercise with Rest of block: 1 set, effort only.
        day_item(page, "addex")
        page.wait_for_selector("#picker")
        page.click("[data-pick='cable_fly']")
        page.wait_for_selector("#addex-sheet")
        start = page.inner_text("#addex-count").strip()
        page.click("#addex-save")
        scope(page, "rest")
        new_rows = [r for r in day_sets(page, did) if r["exercise_id"] == "cable_fly" and r["kind"] == "work"]
        lift_new = next((l for l in rows(page, "blocks")[0]["day_templates"][0]["lifts"] if l["exercise_id"] == "cable_fly"), None)
        check(tag + "(c) Add exercise with Rest of block: 1 set, an effort goal only, on today and on the block's day",
              start == "1" and len(new_rows) == 1 and new_rows[0]["target"]["load"] is None and new_rows[0]["target"]["rep_low"] is None
              and lift_new is not None and lift_new["sets"] == 1, {"start": start, "rows": [r["target"] for r in new_rows], "lift": lift_new})
        done_mid = json.dumps(sorted([r for r in rows(page, "sets") if ":p1:" in r["id"]], key=lambda r: r["id"]), sort_keys=True)
        check(tag + "(c) the done days are the same before and after the swaps and the add", done_before == done_mid)
        # Next round: the Today only swap is gone (slot 2 is the block lift again), the Rest of block swap stays.
        for _ in range(2):
            play_day(page)
        d = day_row(page)
        check(tag + "(c) swap Today only: the next round's day A has the block lift back on slot 2; Rest of block keeps the new one on slot 1",
              d and d["pass"] == 3 and d["day"] == 1 and page.locator("[data-slot='2'][data-exercise='seated_leg_curl']").count() == 1
              and page.locator("[data-slot='1'][data-exercise='hack_squat']").count() == 1, d and (d["pass"], d["day"]))
        ctx.close()

    for name, fn in (("fixed", part_fixed), ("fixed2", part_fixed_round2), ("close", part_close), ("addremove", part_add_remove),
                     ("answers", part_answers), ("adaptive", part_adaptive), ("live", part_live),
                     ("block", part_block), ("skipview", part_skipview), ("switch", part_switch), ("stop", part_stop),
                     ("roundsfixed", part_rounds_fixed), ("roundsadaptive", part_rounds_adaptive), ("live2", part_live2)):
        if not want(name):
            continue
        section(tag + name, fn)

    os.makedirs(LOG_DIR, exist_ok=True)
    with open(os.path.join(LOG_DIR, "e2e_slice2_%s_network.json" % vp), "w") as f:
        json.dump({"origin": origin, "requests": len(audit.requests), "off_origin": audit.off_origin(), "csp_violations": audit.csp}, f, indent=1)
    off = audit.off_origin()
    check(tag + "network audit: zero requests off our origin and zero CSP violations", not off and not audit.csp,
          "%d requests, %d off origin, %d CSP %s" % (len(audit.requests), len(off), len(audit.csp), (off + audit.csp)[:3]))
    check(tag + "zero console errors", not audit.errors, audit.errors[:5])


# ---------------- suite slice3 (17 C.4 row "e2e.py --suite slice3") ----------------

# Each Slice 3 step adds its named parts to SLICE3_PARTS (name, function(ctx3)); ctx3 carries the helpers.
SLICE3_PARTS = []


def slice3_part(name):
    def deco(fn):
        SLICE3_PARTS.append((name, fn))
        return fn
    return deco


def suite_slice3(browser, base, vp, parts):
    tag = "[%s] slice3 " % vp
    o = urlparse(base)
    origin = o.scheme + "://" + o.netloc
    audit = Audit(origin)
    want = lambda name: (not parts) or name in parts

    def new(now_ms=None):
        extra = [clock_at(now_ms)] if now_ms else []
        ctx, page = new_context(browser, audit, standalone=True, vp=vp, extra=extra)
        page.set_default_timeout(10000)
        page.goto(base)
        page.wait_for_selector("#today > *", timeout=15000)
        wait_controller(page)
        settle(page, 300)
        return ctx, page

    def rows(page, store):
        return page.evaluate(DB_ALL, store)

    def toast_text(page):
        return page.evaluate("() => { const t = document.querySelector('.toast.is-on'); return t ? t.textContent : null; }")

    h = {"tag": tag, "base": base, "vp": vp, "new": new, "rows": rows, "toast": toast_text, "audit": audit, "browser": browser}
    for name, fn in SLICE3_PARTS:
        if not want(name):
            continue
        section(tag + name, lambda fn=fn: fn(h))

    os.makedirs(LOG_DIR, exist_ok=True)
    with open(os.path.join(LOG_DIR, "e2e_slice3_%s_network.json" % vp), "w") as f:
        json.dump({"origin": origin, "requests": len(audit.requests), "off_origin": audit.off_origin(), "csp_violations": audit.csp}, f, indent=1)
    off = audit.off_origin()
    check(tag + "network audit: zero requests off our origin and zero CSP violations", not off and not audit.csp,
          "%d requests, %d off origin, %d CSP %s" % (len(audit.requests), len(off), len(audit.csp), (off + audit.csp)[:3]))
    check(tag + "zero console errors", not audit.errors, audit.errors[:5])


# ---- Slice 3 helpers (S1) ----

S3_LIFT = "(slot, ex, sets, load) => ({ slot, exercise_id: ex, sets, rep_low: 8, rep_high: 12, start_load: load, failure_set: false, reps_left_target: 2, warmups: [], sides: 'none', load_basis: 'total', count_label: null, note: '' })"
# Make blocks straight through a second store on the same database (setup only), then reload.
S3_MAKE = """async (specs) => { const { db } = await import('./db.js'); const { createStore } = await import('./store.js');
  const st = createStore({ db }); const L = %s; const out = [];
  for (const sp of specs) { const b = await st.createBlock({ name: sp.name, passes: sp.passes, day_templates: sp.days.map((d, i) => ({ day: i + 1, label: d.label,
    lifts: d.lifts.map((x, j) => L(j + 1, x[0], x[1], x[2])) })) }, null, { activate: !!sp.activate }); out.push(b.id); await new Promise(r => setTimeout(r, 5)); }
  return out; }""" % S3_LIFT
S3_SETTING = "async (k) => { const { db } = await import('./db.js'); return db.setting(k, null); }"
S3_PUT_SETTING = "async ([k, v]) => { const { db } = await import('./db.js'); await db.setSetting(k, v); return true; }"


def s3_unit_first(page):
    """First run: pick lb so the empty screens show their Build a block button."""
    if page.locator("#setup").count():
        page.click("#unit-lb")


def s3_make(page, specs):
    ids = page.evaluate(S3_MAKE, specs)
    page.reload()
    page.wait_for_selector("#today > *", timeout=15000)
    settle(page, 300)
    return ids


TWO_BLOCKS = [{"name": "Older block", "passes": 3, "activate": True, "days": [{"label": "A", "lifts": [["leg_press", 2, 150], ["lat_pulldown", 2, 100]]},
                                                                             {"label": "B", "lifts": [["chest_press_machine", 2, 80]]}]},
              {"name": "Newer block", "passes": 2, "days": [{"label": "A", "lifts": [["push_up", 2, None], ["leg_extension", 2, 60]]}]}]


def s3_to_picker(page):
    """Today with no block, or setup: Build a block, Build from scratch, to the step 3 picker of day 1."""
    s3_unit_first(page)
    sel = "#setup-build" if page.locator("#setup-build").count() else "#build-block"
    build_click(page, sel)
    page.wait_for_selector("#builder[data-step='1']")
    page.fill("#block-name", "S3 block")
    page.click("#builder-next")
    page.wait_for_selector("#builder[data-step='2']")
    fill_change(page, "#block-rounds", "2")
    page.click("#builder-next")
    page.wait_for_selector("#builder[data-step='3']")
    page.click("[data-addex='0']")
    page.wait_for_selector("#picker")
    settle(page, 400)


def pick_ids(page):
    return page.eval_on_selector_all("[data-pick]", "els => els.map(e => e.getAttribute('data-pick'))")


@slice3_part("list")
def part_s3_list(h):
    tag = h["tag"]
    ctx, page = h["new"]()
    page.wait_for_selector("#setup")
    page.click("#unit-lb")
    page.click("#setup-build")
    try:
        page.wait_for_selector("#new", timeout=5000)
    except Exception:
        pass
    check(tag + "C.3.3: first run's Build a block opens the New block chooser", page.locator("#new").count() == 1 and page.locator("#new-scratch").count() == 1)
    if page.locator("#new-scratch").count():
        page.click("#new-scratch")
    page.wait_for_selector("#builder[data-step='1']")
    page.fill("#block-name", "Body block")
    page.click("#builder-next"); page.wait_for_selector("#builder[data-step='2']")
    fill_change(page, "#block-rounds", "2")
    page.click("#builder-next"); page.wait_for_selector("#builder[data-step='3']")
    page.click("[data-addex='0']"); page.wait_for_selector("#picker"); settle(page, 400)
    page.click("[data-chip='3']"); settle(page, 400)
    free = pick_ids(page)
    check(tag + "C.2.7: the picker Free chip shows a kettlebell row and never a band row", any("kettlebell" in i for i in free) and not any(i.startswith("band_") for i in free), free[:8])
    page.click("[data-chip='4']"); settle(page, 400)
    body = pick_ids(page)
    check(tag + "C.2.7: the Body chip shows push up", "push_up" in body, body[:8])
    layout(page, tag, "picker (Slice 3 chips)")
    page.click("[data-pick='push_up']")
    page.wait_for_selector("#builder[data-step='3']")
    page.click("#builder-next"); page.wait_for_selector("#builder[data-step='4']")
    page.click("#block-save")
    page.wait_for_selector("#today[data-day]"); settle(page, 400)
    card = "[data-exercise='push_up']"
    word = page.locator(card + " [data-val='body']").first
    check(tag + "C.2.7: a body-load lift on Today shows your body and no weight steppers",
          word.count() == 1 and word.inner_text().strip() == "your body" and page.locator(card + " [data-step='load+']").count() == 0
          and page.locator(card + " [data-step='reps+']").count() >= 1, page.inner_text(card)[:160])
    sid = open_set(page)
    tick(page, sid)
    done = [r for r in h["rows"](page, "sets") if r["exercise_id"] == "push_up" and r["status"] == "done"]
    check(tag + "C.2.7: the body-load tick saves load 0", len(done) == 1 and done[0]["done"]["load"] == 0, done and done[0]["done"])
    ctx.close()


@slice3_part("equipment")
def part_s3_equipment(h):
    tag = h["tag"]
    ctx, page = h["new"]()
    s3_unit_first(page)
    go_route(page, "#/settings", "#equip-group")
    chips = page.eval_on_selector_all("#equip-chips [data-equip]", "els => els.map(e => [e.getAttribute('data-equip'), e.getAttribute('aria-pressed')])")
    check(tag + "C.3.1: Settings shows the 10 kinds, every one picked on first run", len(chips) == 10 and all(c[1] == "true" for c in chips), chips)
    layout(page, tag, "Settings with the equipment group")
    page.click("#equip-chips [data-equip='band']"); settle(page, 400)
    saved = page.evaluate(S3_SETTING, "equipment_saved")
    check(tag + "C.3.1: untick Band stores the other 9 kinds", saved is not None and "band" not in saved and len(saved) == 9, saved)
    go_route(page, "#/today", "#today > *")
    s3_to_picker(page)
    ids = pick_ids(page)
    check(tag + "X04 M67: with Band unticked the picker hides every band row, in All", ids and not any(i.startswith("band_") for i in ids), [i for i in ids if "band" in i][:5])
    page.click("#picker-allgear"); settle(page, 400)
    ids2 = pick_ids(page)
    check(tag + "C.3.1: Show all equipment shows the band rows for this visit", any(i.startswith("band_") for i in ids2))
    page.click("#picker-back"); page.wait_for_selector("#builder[data-step='3']")
    page.click("[data-addex='0']"); page.wait_for_selector("#picker"); settle(page, 400)
    check(tag + "C.3.1: a new picker visit hides them again", not any(i.startswith("band_") for i in pick_ids(page)))
    page.click("#picker-back"); page.wait_for_selector("#builder[data-step='3']")
    page.click("#builder-cancel"); settle(page)
    # The last picked chip stays picked and says why (equip.min); empty is never stored.
    page.evaluate(S3_PUT_SETTING, ["equipment_saved", ["band"]])
    go_route(page, "#/settings", "#equip-group"); settle(page, 400)
    page.click("#equip-chips [data-equip='band']"); settle(page, 300)
    check(tag + "C.3.1: the last picked chip stays picked and shows Keep at least one kind picked",
          h["toast"](page) == "Keep at least one kind picked." and page.get_attribute("#equip-chips [data-equip='band']", "aria-pressed") == "true"
          and page.evaluate(S3_SETTING, "equipment_saved") == ["band"], h["toast"](page))
    ctx.close()


@slice3_part("blocks")
def part_s3_blocks(h):
    tag = h["tag"]
    ctx, page = h["new"]()
    s3_unit_first(page)
    older, newer = s3_make(page, TWO_BLOCKS)
    go_route(page, "#/block", "#block[data-block]")
    check(tag + "S01: the Block tab overview holds the All blocks row", page.locator("#blocks-all").count() == 1)
    page.click("#blocks-all"); page.wait_for_selector("#blocks-list")
    rows = page.eval_on_selector_all("[data-blockrow]", "els => els.map(e => [e.getAttribute('data-blockrow'), e.getAttribute('data-current'), e.innerText.replace(/\\s+/g, ' ').trim()])")
    check(tag + "C.3.2 S02: the list holds both blocks newest first, the Current pill on the current one only",
          [r[0] for r in rows] == [newer, older] and [r[1] for r in rows] == ["false", "true"] and page.locator("[data-pill='current']").count() == 1
          and "Current" in rows[1][2] and "2 rounds" in rows[0][2] and "0 days done" in rows[0][2], rows)
    check(tag + "C.3.2 M74: a new block made while one is current did not take the mark", page.evaluate(S3_SETTING, "active_block_id") == older)
    layout(page, tag, "block list")
    page.click("[data-blockmore='%s']" % newer); page.wait_for_selector("#row-menu")
    items = page.eval_on_selector_all("#row-menu [data-rowitem]", "els => els.map(e => [e.getAttribute('data-rowitem'), e.innerText.trim()])")
    check(tag + "C.3.2 S02: the row menu holds the 6 actions in order",
          [i[0] for i in items] == ["note", "rename", "copy", "summary", "template", "delete"]
          and [i[1] for i in items] == ["Note", "Rename", "Copy", "Summary", "Save as template", "Delete"], items)
    layout(page, tag, "block row menu")
    page.click("#row-menu [data-rowitem='delete']"); page.wait_for_selector("#del-sheet")
    off0 = page.is_disabled("#del-go")
    page.fill("#del-sheet input", "DELET")
    off1 = page.is_disabled("#del-go")
    page.fill("#del-sheet input", "DELETE")
    on = not page.is_disabled("#del-go")
    check(tag + "AW6 M54: Delete stays disabled until DELETE is typed", off0 and off1 and on, [off0, off1, on])
    page.click("#del-cancel"); settle(page)
    # A block note saves and shows after a reload (L10).
    page.click("[data-blockmore='%s']" % older); page.wait_for_selector("#row-menu")
    page.click("#row-menu [data-rowitem='note']"); page.wait_for_selector("#blocknote-sheet")
    page.fill("#blocknote-in", "Seat 4 on the press")
    page.click("#blocknote-save"); settle(page, 400)
    page.reload(); page.wait_for_selector("#blocks-list"); settle(page, 300)
    page.click("[data-blockmore='%s']" % older); page.wait_for_selector("#row-menu")
    page.click("#row-menu [data-rowitem='note']"); page.wait_for_selector("#blocknote-sheet")
    check(tag + "L10: a block note saves and shows after a reload", page.input_value("#blocknote-in") == "Seat 4 on the press")
    page.click("#blocknote-cancel"); settle(page)
    # Rename shows on the list and on the Block tab (HW4).
    page.click("[data-blockmore='%s']" % older); page.wait_for_selector("#row-menu")
    page.click("#row-menu [data-rowitem='rename']"); page.wait_for_selector("#rename-sheet")
    page.fill("#rename-in", "Legs first"); page.click("#rename-save"); settle(page, 400)
    named = page.inner_text("[data-blockrow='%s']" % older)
    go_route(page, "#/block", "#block-head")
    check(tag + "HW4: the new name shows on the list and on the Block tab", "Legs first" in named and "Legs first" in page.inner_text("#block-head"), named)
    # The overview of a block that is not current (R27, M93): no End block, Use this block, every day opens read only.
    go_route(page, "#/block/" + newer, "#block[data-block='%s']" % newer)
    check(tag + "M93: a block that is not current shows no End block, and offers Use this block",
          page.locator("#block-end").count() == 0 and page.locator("#block-use").count() == 1 and page.get_attribute("#block", "data-current") == "false")
    page.reload(); page.wait_for_selector("#block[data-block='%s']" % newer)
    check(tag + "C.3.2: a reload keeps that block's overview", page.locator("#block-use").count() == 1)
    page.click("[data-blockday]"); settle(page, 400)
    check(tag + "C.3.2 R27: a day of a block that is not current opens read only", page.evaluate("location.hash").startswith("#/day/"), page.evaluate("location.hash"))
    go_route(page, "#/block/@@bad", "#blocks-list")
    check(tag + "C.0.1: a bad block id goes to the block list", page.evaluate("location.hash") == "#/blocks")
    go_route(page, "#/block/" + newer, "#block-use")
    page.click("#block-use"); page.wait_for_selector("#today[data-day]"); settle(page, 300)
    check(tag + "C.3.2: Use this block makes it current", page.evaluate(S3_SETTING, "active_block_id") == newer)
    # A done block is read only.
    page.evaluate("async (id) => { const { db } = await import('./db.js'); const b = await db.get('blocks', id); await db.put('blocks', { ...b, status: 'done', finished_at: Date.now() }); return true; }", older)
    page.reload(); page.wait_for_selector("#today > *")
    go_route(page, "#/block/" + older, "#block[data-block='%s']" % older)
    check(tag + "C.3.2: a done block is read only (no Use this block, no End block)", page.locator("#block-use").count() == 0 and page.locator("#block-end").count() == 0)
    # Delete the current block: the mark moves (S02); its rows are gone.
    go_route(page, "#/blocks", "#blocks-list")
    page.click("[data-blockmore='%s']" % newer); page.wait_for_selector("#row-menu")
    page.click("#row-menu [data-rowitem='delete']"); page.wait_for_selector("#del-sheet")
    page.fill("#del-sheet input", "DELETE"); page.click("#del-go"); settle(page, 600)
    left = [r["id"] for r in h["rows"](page, "blocks")]
    sets_left = [r["id"] for r in h["rows"](page, "sets") if r["block_id"] == newer]
    check(tag + "AW6 S02: delete removes the block and its sets; the mark leaves it",
          left == [older] and not sets_left and page.evaluate(S3_SETTING, "active_block_id") != newer, {"blocks": left, "mark": page.evaluate(S3_SETTING, "active_block_id")})
    snaps = page.evaluate("async () => { const { db } = await import('./db.js'); return (await db.all('snapshots')).map(s => s.reason); }")
    check(tag + "M51: a before-delete safety copy is kept", "before-delete" in snaps, snaps)
    ctx.close()


@slice3_part("chooser")
def part_s3_chooser(h):
    tag = h["tag"]
    ctx, page = h["new"]()
    s3_unit_first(page)
    s3_make(page, TWO_BLOCKS[:1])
    go_route(page, "#/blocks", "#blocks-list")
    page.click("#blocks-new"); page.wait_for_selector("#new")
    names = page.eval_on_selector_all("#new .choice .choice-title", "els => els.map(e => e.innerText.trim())")
    check(tag + "S03 BW1: the chooser offers the three starts, then Load a block file",
          names == ["Build from scratch", "Start from a template", "Guided builder"] and page.locator("#new-load").count() == 1
          and page.locator("nav.tabbar").count() == 0, names)
    gaps = page.eval_on_selector_all("#new .choice", """els => els.map(b => { const o = b.getBoundingClientRect(), i = b.querySelector('.grow').getBoundingClientRect();
      return [Math.round(i.top - o.top), Math.round(o.bottom - i.bottom)]; })""")
    check(tag + "C.3.3 LOOK 3.4: each choice's words sit inside the button with room above and below (at least 8px)",
          len(gaps) == 3 and all(a >= 8 and b >= 8 for a, b in gaps), gaps)
    layout(page, tag, "New block chooser")
    page.click("#new-scratch"); page.wait_for_selector("#builder[data-step='1']")
    check(tag + "S03: Build from scratch opens the builder", True)
    page.click("#builder-cancel"); settle(page)
    ctx.close()


@slice3_part("makeflags")
def part_s3_makeflags(h):
    tag = h["tag"]
    ctx, page = h["new"]()
    page.click("#unit-lb")
    load_block_file(page, BLOCK_V2)
    go_route(page, "#/builder", "#builder")
    page.fill("#block-name", "Q")
    page.click("#builder-next"); page.wait_for_selector("#builder[data-step='2']")
    page.click("#builder-next"); page.wait_for_selector("#builder[data-step='3']")
    page.click("[data-addex='0']"); page.wait_for_selector("#picker"); settle(page, 300)
    page.click("#picker-make"); page.wait_for_selector("#make-sheet"); settle(page, 400)
    qs = page.eval_on_selector_all("#make-flags [data-flagq]", "els => els.map(e => e.getAttribute('data-flagq'))")
    check(tag + "C.2.5 item 4: Make my own exercise asks the block's three questions in his words",
          qs == ["machine", "no_added_sets", "left_out_of_builder"] and "Made-up machine question?" in page.inner_text("#make-flags"), qs)
    page.fill("#make-name", "Seat move")
    for k, yes in (("machine", True), ("no_added_sets", False), ("left_out_of_builder", False)):
        page.click("[data-flagans='%s-%s']" % (k, "yes" if yes else "no"))
    page.click("#make-save"); settle(page, 500)
    row = next((r for r in h["rows"](page, "exercises") if r["name"] == "Seat move"), None)
    check(tag + "C.2.5 item 4: three answers set the flags and flags_set", row is not None and row["machine"] is True and row["flags_set"] is True, row and {k: row[k] for k in ("machine", "flags_set")})
    ctx.close()


# ---- Slice 3 S2 parts: templates, guided builder, levels, copy ----

S3_TPL_COUNT = "async () => { const m = await import('./data/templates.js'); return m.TEMPLATES.length; }"


def tpl_ids(page):
    return page.eval_on_selector_all("[data-tpl]", "els => els.filter(e => e.tagName === 'BUTTON').map(e => e.getAttribute('data-tpl'))")


def tpl_filter(page, kind, values):
    page.click("[data-tplf='%s']" % kind); page.wait_for_selector("#tplf-sheet")
    for v in values:
        page.click("#tplf-sheet [data-tplopt='%s']" % v)
    page.click("#tplf-done"); settle(page, 400)


@slice3_part("templates")
def part_s3_templates(h):
    tag = h["tag"]
    ctx, page = h["new"]()
    s3_unit_first(page)
    n_ours = page.evaluate(S3_TPL_COUNT)
    go_route(page, "#/new", "#new")
    page.click("#new-template"); page.wait_for_selector("#tpl-list [data-tpl]"); settle(page, 300)
    all_ids = tpl_ids(page)
    check(tag + "S04: the browser lists every one of our templates from data/templates.js", n_ours >= 1 and len(all_ids) == n_ours, [n_ours, len(all_ids)])
    check(tag + "S01: Templates keeps the bottom bar on the Block tab", page.locator("nav.tabbar a.is-active[data-tab='#/block']").count() == 1)
    layout(page, tag, "template browser")
    tpl_filter(page, "days", ["3"])
    three = tpl_ids(page)
    lines = page.eval_on_selector_all(".tpl-line", "els => els.map(e => e.innerText)")
    check(tag + "S04 B11: the Days 3 filter narrows the list to 3-day templates and its chip shows the count",
          0 < len(three) < len(all_ids) and all(l.startswith("3 days") for l in lines) and "Days 1" in page.inner_text("[data-tplf='days']")
          and page.is_visible("#tpl-clear"), [len(three), lines[:3], page.inner_text("[data-tplf='days']")])
    page.click("#tpl-clear"); settle(page, 300)
    check(tag + "S04: Clear filters brings the whole list back and hides itself", len(tpl_ids(page)) == len(all_ids) and not page.is_visible("#tpl-clear"))
    tpl_filter(page, "focus", ["even"])
    even = tpl_ids(page)
    check(tag + "S04: a Focus filter narrows the list", 0 < len(even) < len(all_ids), len(even))
    page.click("#tpl-clear"); settle(page, 300)
    first_name = page.inner_text("[data-tpl='%s'] .tpl-name" % all_ids[2]).strip()
    page.fill("#tpl-search", first_name[:14].lower()); settle(page, 400)
    found = tpl_ids(page)
    check(tag + "S04: search finds a template by name, case blind", all_ids[2] in found and len(found) < len(all_ids), [first_name, found])
    page.fill("#tpl-search", "zzzz no such"); settle(page, 400)
    check(tag + "C.3.4: no match shows No templates match.", page.locator("#tpl-none").count() == 1 and "No templates match." in page.inner_text("#tpl-none"))
    page.fill("#tpl-search", ""); settle(page, 400)
    page.click("[data-tpl='%s']" % all_ids[0]); page.wait_for_selector("#template[data-tpl]"); settle(page, 300)
    days = page.locator("[data-tplday]").count()
    slots = page.locator("[data-tplslot]").count()
    first_slot = page.inner_text("[data-tplslot]").split("\n")[0].strip()
    check(tag + "r4.6 Q7: a 1-set slot in the preview reads '1 set', never '1 sets'", first_slot.endswith(", 1 set"), first_slot)
    line = page.inner_text("[data-tplslot] .tpl-slot-line")
    check(tag + "S05: the preview shows each day's slots with its sets, muscle, level and rep range",
          days >= 2 and slots >= days and " set" in page.inner_text("[data-tplslot]") and " · " in line and page.locator("#tpl-delete").count() == 0
          and page.locator("nav.tabbar").count() == 0, [days, slots, line])
    layout(page, tag, "template preview")
    page.click("#tpl-start"); page.wait_for_selector("#builder[data-step='2']"); settle(page, 300)
    check(tag + "C.3.4: Start opens the builder at Rounds", True)
    fill_change(page, "#block-rounds", "3")
    page.click("#builder-next"); page.wait_for_selector("#builder[data-step='3']")
    built = page.locator("[data-lift]").count()
    page.click("#builder-next"); page.wait_for_selector("#builder[data-step='4']")
    page.click("#block-save")
    page.wait_for_selector("#today[data-day]"); settle(page, 400)
    blk = h["rows"](page, "blocks")
    check(tag + "S05: Save makes a Fixed block that names its template", len(blk) == 1 and blk[0]["template_id"] == all_ids[0] and blk[0]["profile"] == "fixed"
          and sum(len(d["lifts"]) for d in blk[0]["day_templates"]) == built and all(l["reps_left_target"] == 2 for d in blk[0]["day_templates"] for l in d["lifts"]),
          blk and {"template_id": blk[0]["template_id"], "lifts": sum(len(d["lifts"]) for d in blk[0]["day_templates"]), "built": built})
    # Save as template from the row menu, then it lists under Made by mine with the Mine pill; its preview deletes it.
    go_route(page, "#/blocks", "#blocks-list")
    bid = blk[0]["id"]
    page.click("[data-blockmore='%s']" % bid); page.wait_for_selector("#row-menu")
    page.click("#row-menu [data-rowitem='template']"); page.wait_for_selector("#tplsave-sheet")
    page.fill("#tplsave-in", "My own copy"); page.click("#tplsave-save"); settle(page, 500)
    check(tag + "C.3.4: Save as template shows Saved as a template.", h["toast"](page) == "Saved as a template.", h["toast"](page))
    go_route(page, "#/templates", "#tpl-list [data-tpl]")
    tpl_filter(page, "author", ["mine"])
    mine = tpl_ids(page)
    check(tag + "BW13: his template lists under Made by mine with the Mine pill", len(mine) == 1 and mine[0].startswith("m") and page.locator("[data-pill='mine']").count() == 1, mine)
    page.click("#tpl-clear"); settle(page, 300)
    page.click("[data-tpl='%s']" % mine[0]); page.wait_for_selector("#template[data-tpl]")
    page.click("#tpl-delete"); page.wait_for_selector("#tpl-delete-sheet")
    page.click("#tpl-delete-go"); page.wait_for_selector("#templates"); settle(page, 500)
    snaps = page.evaluate("async () => { const { db } = await import('./db.js'); return (await db.all('snapshots')).map(s => s.reason); }")
    check(tag + "M91: Delete template removes it after a before-delete safety copy", not h["rows"](page, "templates") and "before-delete" in snaps, snaps)
    go_route(page, "#/template/@@bad", "#templates")
    check(tag + "C.0.1: a bad template id goes to the template list", page.evaluate("location.hash") == "#/templates")
    ctx.close()


def g_open(page):
    go_route(page, "#/new", "#new")
    page.click("#new-guided"); page.wait_for_selector("#guided[data-step='1']")


def g_add(page, level, muscles):
    page.click("[data-lvadd='%s']" % level); page.wait_for_selector("#addmuscle-sheet")
    for m in muscles:
        page.click("#addmuscle-sheet [data-addmuscle='%s']" % m)
    page.click("#addmuscle-done"); settle(page, 200)


def g_order(page):
    return page.evaluate("() => Object.fromEntries([...document.querySelectorAll('[data-level]')].map(c => [c.getAttribute('data-level'), [...c.querySelectorAll('[data-lvrow]')].map(r => r.getAttribute('data-lvrow'))]))")


@slice3_part("guided")
def part_s3_guided(h):
    tag = h["tag"]
    ctx, page = h["new"]()
    s3_unit_first(page)
    page.evaluate("async () => { const { db } = await import('./db.js'); await db.setSetting('unit', 'lb'); return true; }")
    g_open(page)
    chips = page.eval_on_selector_all("[data-gdays]", "els => els.map(e => e.getAttribute('data-gdays'))")
    check(tag + "B03 G26: step 1 offers 2 to 6 days and no 7; Next is off until one is picked",
          chips == ["2", "3", "4", "5", "6"] and page.is_disabled("#guided-next") and page.locator("nav.tabbar").count() == 0, chips)
    layout(page, tag, "guided step 1")
    page.click("[data-gdays='3']"); settle(page, 200)
    page.click("#guided-next"); page.wait_for_selector("#guided[data-step='2']")
    empties = page.locator("[data-levelempty]").count()
    check(tag + "ZW1: each empty level shows its line", empties == 3 and "No muscles here." in page.inner_text("[data-levelempty='top']"), empties)
    check(tag + "C.3.5: Next stays off on step 2 with no muscle", page.is_disabled("#guided-next"))
    g_add(page, "top", ["quads", "chest"])
    page.click("[data-lvadd='middle']"); page.wait_for_selector("#addmuscle-sheet")
    q = "#addmuscle-sheet [data-addmuscle='quads']"
    check(tag + "BW3 M50: a muscle on Grow shows taken and cannot be picked for Steady",
          page.is_disabled(q) and "on Grow" in page.inner_text(q), page.inner_text(q))
    page.click("#addmuscle-sheet [data-addmuscle='back']"); page.click("#addmuscle-done"); settle(page, 200)
    o1 = g_order(page)
    check(tag + "B06 M50: each muscle sits on one level", o1 == {"top": ["quads", "chest"], "middle": ["back"], "bottom": []}, o1)
    layout(page, tag, "guided levels")
    page.click("[data-lvmove='chest:up']"); settle(page, 200)
    page.click("[data-lvmove='quads:down']"); settle(page, 200)
    o2 = g_order(page)
    check(tag + "BW2: up moves inside a level; down past the end moves into the next level", o2 == {"top": ["chest"], "middle": ["quads", "back"], "bottom": []}, o2)
    page.click("[data-lvmove='quads:up']"); settle(page, 200)
    page.click("#guided-back"); page.wait_for_selector("#guided[data-step='1']")
    page.click("#guided-next"); page.wait_for_selector("#guided[data-step='2']")
    o3 = g_order(page)
    check(tag + "BW2: the rank is kept after Back and Next", o3 == {"top": ["chest", "quads"], "middle": ["back"], "bottom": []}, o3)
    check(tag + "C.3.5: the first muscle of the top level has its up shown off", page.is_disabled("[data-lvmove='chest:up']"))
    handle = page.get_attribute("[data-drag='chest']", "aria-hidden")
    check(tag + "r4.3 H7 c: the drag handle is aria-hidden with no label", handle == "true" and page.get_attribute("[data-drag='chest']", "aria-label") is None)
    page.click("#level-info"); page.wait_for_selector("#levels-sheet")
    lines = page.locator("#levels-sheet .level-line").count()
    page.click("#levels-close"); settle(page, 200)
    check(tag + "AW7: the levels sheet opens with the explain lines and closes", lines >= 6 and page.locator("#levels-sheet").count() == 0, lines)
    page.click("#guided-next"); page.wait_for_selector("#guided[data-step='3']"); settle(page, 500)
    intro = page.locator("#intro-board").count()
    if intro:
        page.click("#intro-ok"); settle(page, 300)
    cards = page.locator("[data-gday]").count()
    check(tag + "S07 BW7: Next fills the board, one card per day; the board intro shows on the first visit", cards == 3 and intro == 1, [cards, intro])
    layout(page, tag, "guided board")
    # Add muscle with a count of 2 adds 2 slots on that day (BW9).
    before = page.locator("[data-gday='1'] [data-gslot]").count()
    page.click("[data-gaddmuscle='1']"); page.wait_for_selector("#gmuscle-sheet")
    page.click("[data-gstep='calves+']"); page.click("[data-gstep='calves+']")
    check(tag + "r4.6 Q5: the count buttons read their own words", page.get_attribute("[data-gstep='calves+']", "aria-label") == "1 more Calves slot" and page.get_attribute("[data-gstep='calves-']", "aria-label") == "1 less Calves slot",
          [page.get_attribute("[data-gstep='calves+']", "aria-label"), page.get_attribute("[data-gstep='calves-']", "aria-label")])
    page.click("#gmuscle-done"); settle(page, 300)
    after = page.locator("[data-gday='1'] [data-gslot][data-muscle='calves']").count()
    check(tag + "BW9: a count of 2 adds 2 slots of that muscle on that day", after == 2 and page.locator("[data-gday='1'] [data-gslot]").count() == before + 2, [before, after])
    # Fill the day to 6, then 7 (warning, Next live), then 8 (full), then a ninth is refused.
    def day1():
        return page.locator("[data-gday='1'] [data-gslot]").count()
    page.click("[data-gaddmuscle='1']"); page.wait_for_selector("#gmuscle-sheet")
    while day1() < 6:
        page.click("[data-gstep='abs_core+']" if page.inner_text("[data-gcount='abs_core']") != "4" else "[data-gstep='biceps+']"); settle(page, 50)
        page.click("#gmuscle-done"); settle(page, 200)
        if day1() < 6:
            page.click("[data-gaddmuscle='1']"); page.wait_for_selector("#gmuscle-sheet")
    six_warn = page.locator("[data-gwarn='1']").count()
    page.click("[data-gaddmuscle='1']"); page.wait_for_selector("#gmuscle-sheet")
    page.click("[data-gstep='triceps+']"); page.click("#gmuscle-done"); settle(page, 300)
    seven_warn = page.locator("[data-gwarn='1']").count()
    check(tag + "B07 M49: 6 exercises shows no warning; 7 shows it and Next still works",
          day1() == 7 and six_warn == 0 and seven_warn == 1 and not page.is_disabled("#guided-next") and "30 minutes" in page.inner_text("[data-gwarn='1']"), [day1(), six_warn, seven_warn])
    page.click("[data-gaddmuscle='1']"); page.wait_for_selector("#gmuscle-sheet")
    page.click("[data-gstep='triceps+']"); page.click("[data-gstep='triceps+']"); settle(page, 300)
    refused = h["toast"](page)
    page.click("#gmuscle-done"); settle(page, 300)
    check(tag + "R4-16: a ninth exercise on a day is refused; a full day shows A day holds at most 8 exercises.",
          day1() == 8 and refused == "A day holds at most 8 exercises." and page.is_disabled("[data-gaddmuscle='1']") and page.locator("[data-gfull='1']").count() == 1, [day1(), refused])
    # Slot delete is one tap.
    page.click("[data-gday='1'] [data-gslot] [data-slotdel]"); settle(page, 300)
    check(tag + "C.3.5: a slot delete is one tap", day1() == 7)
    # Reset gives back the step 3 layout (BW6, S06).
    page.click("#guided-tools"); page.wait_for_selector("#gtools-sheet")
    page.click("[data-gtool='reset']"); page.wait_for_selector("#reset-sheet")
    page.click("#reset-sheet-go"); settle(page, 300)
    check(tag + "BW6 S06: Reset gives back the step 3 layout", day1() == before, [day1(), before])
    # The picker from a slot lists only that slot's muscle; a pick fills it (S12).
    slot = page.get_attribute("[data-gday='2'] [data-gslot]", "data-gslot")
    muscle = page.get_attribute("[data-gday='2'] [data-gslot]", "data-muscle")
    sel = "[data-gslot='%s'] [data-slotpick]" % slot
    if page.locator(sel).count() == 0:
        page.click("[data-gslot='%s'] [data-slotrec]" % slot); settle(page, 400)
    page.click(sel); page.wait_for_selector("#picker"); settle(page, 400)
    picks = page.eval_on_selector_all("[data-pick]", "els => els.map(e => e.getAttribute('data-pick'))")
    md = page.evaluate("async (ids) => { const m = await import('./data/exercises.js'); const by = new Map(m.SEED_EXERCISES.map(e => [e.id, e.muscle_detail])); return [...new Set(ids.map(i => by.get(i) || 'custom'))]; }", picks)
    check(tag + "S12: the picker from a slot lists only that muscle", picks and md == [muscle], [muscle, md, len(picks)])
    page.click("[data-pick='%s']" % picks[-1]); page.wait_for_selector("#guided[data-step='3']"); settle(page, 300)
    got = page.inner_text("[data-gslot='%s'] .slot-ex" % slot)
    check(tag + "S12: the pick fills the slot", page.get_attribute("[data-gslot='%s']" % slot, "data-filled") == "true", got)
    check(tag + "r4.6 Q7: a hand pick shows no Suggest one", page.locator("[data-gslot='%s'] [data-slotrec]" % slot).count() == 0)
    # Clear empties every pick and keeps the slots (BW6).
    n_slots = page.locator("[data-gslot]").count()
    page.click("#guided-tools"); page.wait_for_selector("#gtools-sheet")
    page.click("[data-gtool='clear']"); page.wait_for_selector("#clear-sheet")
    page.click("#clear-sheet-go"); settle(page, 300)
    check(tag + "BW6: Clear takes every pick off and keeps the slots",
          page.locator("[data-gslot][data-filled='true']").count() == 0 and page.locator("[data-gslot]").count() == n_slots)
    # Suggest one fills one slot (S12, IW6).
    first = page.get_attribute("[data-gslot]", "data-gslot")
    page.click("[data-gslot='%s'] [data-slotrec]" % first); settle(page, 400)
    one = page.locator("[data-gslot][data-filled='true']").count()
    check(tag + "S12 IW6: Suggest one fills that one slot", one == 1 and page.get_attribute("[data-gslot='%s']" % first, "data-filled") == "true", one)
    name1 = page.inner_text("[data-gslot='%s'] .slot-ex" % first)
    has_rec = page.locator("[data-gslot='%s'] [data-slotrec]" % first).count() == 1
    if has_rec:
        page.click("[data-gslot='%s'] [data-slotrec]" % first); settle(page, 400)
    name2 = page.inner_text("[data-gslot='%s'] .slot-ex" % first)
    check(tag + "r4.6 Q7: a suggested slot keeps Suggest one, and a second tap moves to the next exercise", has_rec and name2 != name1, [name1, name2])
    # Fill for me with Fill empty slots only fills only the empty slots and keeps the one he has (B08).
    kept = page.inner_text("[data-gslot='%s'] .slot-ex" % first)
    page.click("#guided-autofill"); page.wait_for_selector("#fill-sheet")
    check(tag + "C.3.6: the Fill for me sheet has the switch on and the 10 kinds", page.get_attribute("#fill-empty", "aria-checked") == "true" and page.locator("[data-fillk]").count() == 10)
    page.click("[data-fillk='band']"); page.click("#fill-go"); settle(page, 500)
    filled = page.locator("[data-gslot][data-filled='true']").count()
    check(tag + "B08: Fill for me fills the empty slots and keeps the one he had", filled > 1 and page.inner_text("[data-gslot='%s'] .slot-ex" % first) == kept, [filled, kept])
    layout(page, tag, "guided board filled")
    # Add day and Take out this day.
    page.click("#guided-addday"); settle(page, 300)
    four = page.locator("[data-gday]").count()
    page.click("[data-gremoveday='4']"); settle(page, 300)
    check(tag + "BW6 S06: Add day adds a day; Take out this day takes an empty one off at once", four == 4 and page.locator("[data-gday]").count() == 3)
    page.click("#guided-next"); page.wait_for_selector("#guided[data-step='4']"); settle(page, 400)
    review_days = page.locator("[data-greview]").count()
    check(tag + "C.3.5: Review lists every day with its lifts", review_days == 3 and not page.is_disabled("#guided-save"), review_days)
    layout(page, tag, "guided review")
    page.fill("#guided-name", "Guided e2e")
    page.click("#guided-save"); page.wait_for_selector("#today[data-day]"); settle(page, 400)
    blk = h["rows"](page, "blocks")
    check(tag + "C.3.5: Save makes a Fixed block with his levels", len(blk) == 1 and blk[0]["profile"] == "fixed" and blk[0]["levels"].get("chest") == "top"
          and blk[0]["levels"].get("back") == "middle" and blk[0]["name"] == "Guided e2e", blk and blk[0]["levels"])
    # The board intro never shows twice (BW7).
    g_open(page)
    page.click("[data-gdays='2']"); page.click("#guided-next"); page.wait_for_selector("#guided[data-step='2']")
    g_add(page, "top", ["chest"])
    page.click("#guided-next"); page.wait_for_selector("#guided[data-step='3']"); settle(page, 600)
    check(tag + "BW7: the board intro does not show on a second visit", page.locator("#intro-board").count() == 0)
    ctx.close()


@slice3_part("levels")
def part_s3_levels(h):
    tag = h["tag"]
    ctx, page = h["new"]()
    s3_unit_first(page)
    (bid,) = s3_make(page, TWO_BLOCKS[:1])
    go_route(page, "#/block", "#levels-row")
    check(tag + "C.3.7: the overview of the current block has the Muscle levels row first", page.inner_text("#block-links .row").startswith("Muscle levels"))
    page.click("#levels-row"); page.wait_for_selector("#levels[data-block]"); settle(page, 400)
    o = g_order(page)
    check(tag + "C.3.7: a block with no levels shows every muscle it trains on Steady with the unsaved line",
          page.locator("#levels-unsaved").count() == 1 and "Steady" in page.inner_text("#levels-unsaved") and not o["top"] and len(o["middle"]) >= 2, o)
    layout(page, tag, "muscle levels")
    first = o["middle"][0]
    page.click("[data-lvmove='%s:up']" % first); settle(page, 200)
    page.click("#levels-save"); page.wait_for_selector("#block[data-block]"); settle(page, 400)
    lv = h["rows"](page, "blocks")[0]["levels"]
    check(tag + "E15 C.3.7: Save levels writes the new level", lv.get(first) == "top", lv)
    page.click("#levels-row"); page.wait_for_selector("#levels[data-block]"); settle(page, 300)
    check(tag + "C.3.7: after a save the unsaved line is gone", page.locator("#levels-unsaved").count() == 0)
    ctx.close()


@slice3_part("copy")
def part_s3_copy(h):
    tag = h["tag"]
    ctx, page = h["new"]()
    s3_unit_first(page)
    (bid,) = s3_make(page, TWO_BLOCKS[:1])
    page.evaluate("async () => { const { db } = await import('./db.js'); await db.setSetting('unit', 'kg'); return true; }")
    go_route(page, "#/blocks", "#blocks-list")
    page.click("[data-blockmore='%s']" % bid); page.wait_for_selector("#row-menu")
    page.click("#row-menu [data-rowitem='copy']"); page.wait_for_selector("#copy[data-step='1'] [data-copyround]"); settle(page, 300)
    rounds = page.eval_on_selector_all("[data-copyround]", "els => els.map(e => e.getAttribute('data-copyround'))")
    check(tag + "C.3.8: step 1 offers every round of a block with a length", rounds == ["1", "2", "3"] and page.locator("nav.tabbar").count() == 0, rounds)
    layout(page, tag, "copy step 1")
    page.click("[data-copyround='1']"); page.wait_for_selector("#copy[data-step='2'] #copy-unit"); settle(page, 300)
    check(tag + "B09: Review says the weights stay in the source unit (lb) with Settings on kg", "lb" in page.inner_text("#copy-unit") and page.locator("[data-copylift]").count() == 3, page.inner_text("#copy-unit"))
    layout(page, tag, "copy review")
    page.click("#copy-next"); page.wait_for_selector("#copy-go")
    page.click("#copy-go"); page.wait_for_selector("#switch-sheet")
    page.click("#switch-no"); page.wait_for_selector("#blocks-list"); settle(page, 400)
    blks = h["rows"](page, "blocks")
    c = [b for b in blks if b["id"] != bid]
    check(tag + "AW4 B09 M74: the copy has the same days and exercises, keeps lb, names its source, and took no mark",
          len(c) == 1 and c[0]["unit"] == "lb" and c[0]["copied_from"] == {"block_id": bid, "pass": 1}
          and [[l["exercise_id"] for l in d["lifts"]] for d in c[0]["day_templates"]] == [[l["exercise_id"] for l in d["lifts"]] for d in [b for b in blks if b["id"] == bid][0]["day_templates"]]
          and page.evaluate(S3_SETTING, "active_block_id") == bid, c and {"unit": c[0]["unit"], "copied_from": c[0]["copied_from"]})
    go_route(page, "#/copy/@@bad", "#blocks-list")
    check(tag + "C.0.1: a bad copy id goes to the block list", page.evaluate("location.hash") == "#/blocks")

# ---- Slice 3 parts, track S3 (17 C.3.9 to C.3.16) ----

def s3_log_day(page):
    """Tick every set of the day on Today, then Finish day and close the nudge; stays on Day done."""
    page.wait_for_selector("#today[data-day]")
    guard = 0
    while open_set(page) and guard < 40:
        tick(page, fb="save")
        guard += 1
    return finish(page, stay=True)


def s3_day_item(page, item):
    page.click("#day-menu")
    page.wait_for_selector("#day-menu-sheet")
    page.click("#day-menu-sheet [data-dayitem='%s']" % item)


ONE_DAY = lambda name, passes, sets=1: {"name": name, "passes": passes, "activate": True, "days": [{"label": "A", "lifts": [["leg_press", sets, 100]]}]}


@slice3_part("finished")
def part_s3_finished(h):
    tag = h["tag"]
    ctx, page = h["new"]()
    s3_unit_first(page)
    bid = s3_make(page, [ONE_DAY("Last day block", 1)])[0]
    go_route(page, "#/today", "#today[data-day]")
    nudges = {"n": 0}
    page.expose_function("__s3nudge", lambda: nudges.__setitem__("n", nudges["n"] + 1))
    page.evaluate("() => { new MutationObserver(() => { const n = document.getElementById('nudge'); if (n && !n.dataset.seen) { n.dataset.seen = '1'; window.__s3nudge(); } }).observe(document.body, { childList: true, subtree: true }); }")
    s3_log_day(page)
    at_day_done = page.locator("#daydone").count() == 1
    page.click("#done-go")
    page.wait_for_selector("#finished #fin-new")
    settle(page, 1200)
    blk = next(b for b in h["rows"](page, "blocks") if b["id"] == bid)
    check(tag + "S19 C.3.9: the last day of the last round shows Block finished with Start a new block and Copy this block",
          at_day_done and page.locator("#finished #fin-new.btn-primary").count() == 1 and page.locator("#finished #fin-copy.btn-secondary").count() == 1
          and page.text_content("#fin-name").strip() == "Last day block" and page.locator(".tabbar").count() == 0
          and blk["status"] == "done" and isinstance(blk["finished_at"], (int, float)), {"block": [blk["status"], blk["finished_at"]]})
    rows_ = page.eval_on_selector_all("#finished [data-fin]", "els => els.map(e => [e.getAttribute('data-fin'), e.innerText.replace(/\\s+/g, ' ').trim()])")
    check(tag + "C.3.9: the stat rows read 1 round done and 1 day done; a zero row is left out",
          rows_ == [["fin.rounds", "1 round done"], ["fin.days", "1 day done"]], rows_)
    check(tag + "C.3.9 R22: the whole last-day chain shows exactly one backup nudge", nudges["n"] == 1 and page.locator("#nudge").count() == 0, nudges)
    layout(page, tag, "block finished")
    go_route(page, "#/today", "#block-done")
    check(tag + "C.3.9: Today then shows Block finished with Start a new block and Copy this block, no line",
          page.locator("#block-done #fin-new").count() == 1 and page.locator("#block-done #fin-copy").count() == 1 and page.locator("#block-done .lead").count() == 0)
    page.click("#block-done #fin-new"); page.wait_for_selector("#new")
    check(tag + "C.3.9: Start a new block opens the chooser", page.evaluate("location.hash") == "#/new")
    go_route(page, "#/finished/@@bad", "#today > *")
    check(tag + "C.0.1: a bad #/finished/ id goes to Today", page.evaluate("location.hash") == "#/today")
    ctx.close()


@slice3_part("summary")
def part_s3_summary(h):
    tag = h["tag"]
    ctx, page = h["new"]()
    s3_unit_first(page)
    spec = {"name": "Summary block", "passes": 3, "activate": True, "days": [{"label": "A", "lifts": [["leg_press", 2, 150], ["lat_pulldown", 2, 100]]},
                                                                         {"label": "B", "lifts": [["chest_press_machine", 2, 80]]}]}
    bid = s3_make(page, [spec])[0]
    go_route(page, "#/today", "#today[data-day]")
    s3_log_day(page)
    go_route(page, "#/summary/" + bid, "#summary-switch")
    tiles = page.eval_on_selector_all("#sum-tiles [data-tile]", "els => els.map(e => [e.getAttribute('data-tile'), e.querySelector('.sum-n').innerText.trim()])")
    page.click("#summary-switch [data-seg='1']"); page.wait_for_selector("#sum-muscles")
    head = page.eval_on_selector_all("#sum-muscles thead th", "els => els.map(e => e.textContent.trim())")
    body = page.eval_on_selector_all("#sum-muscles tbody tr", "els => els.map(e => [e.getAttribute('data-muscle'), ...[...e.querySelectorAll('td')].map(td => td.innerText.trim())])")
    exs = {e["id"]: e for e in h["rows"](page, "exercises")}
    want = {}
    seen = set()
    for x in h["rows"](page, "sets"):
        if x["block_id"] != bid or x["kind"] != "work" or x["status"] != "done":
            continue
        k = (x["day_id"], x["slot"], x["set_n"])
        if k in seen:
            continue
        seen.add(k)
        e = exs[x["exercise_id"]]
        m = e.get("muscle_detail") or e.get("muscle")
        want[m] = want.get(m, 0) + 1
    got = {r[0]: r[1:] for r in body}
    check(tag + "S14 S15: mid block the summary shows the day counts and a per-round sets-per-muscle table",
          tiles == [["done", "1"], ["skipped", "0"], ["notdone", "5"]] and head == ["Muscle", "R1", "R2", "R3"]
          and set(got) == set(want) and all(got[m] == [str(want[m]), "0", "0"] for m in want), {"tiles": tiles, "head": head, "got": got, "want": want})
    layout(page, tag, "summary muscles")
    page.click("#summary-switch [data-seg='2']"); page.wait_for_selector("#sum-exercises")
    ids = page.eval_on_selector_all("[data-sumex]", "els => els.map(e => e.getAttribute('data-sumex'))")
    check(tag + "C.3.10: the Exercises page lists the exercises done in this block", sorted(ids) == ["lat_pulldown", "leg_press"], ids)
    page.click("[data-sumex='leg_press']"); page.wait_for_selector("#summary .trend")
    check(tag + "C.3.10: an exercise opens its table and trend line for this block only",
          page.locator("#summary [data-histblock]").count() == 1 and page.locator("#summary .hist-round").count() == 1)
    go_route(page, "#/summary/@@bad", "#blocks-list")
    check(tag + "C.0.1: a bad #/summary/ id goes to the block list", page.evaluate("location.hash") == "#/blocks")
    ctx.close()


@slice3_part("grid")
def part_s3_grid(h):
    tag = h["tag"]
    ctx, page = h["new"]()
    s3_unit_first(page)
    spec = {"name": "Grid block", "passes": 2, "activate": True, "days": [{"label": "A", "lifts": [["leg_press", 1, 150]]}, {"label": "B", "lifts": [["lat_pulldown", 1, 100]]}]}
    bid = s3_make(page, [spec])[0]
    go_route(page, "#/block", "#round-grid")
    cols = page.eval_on_selector_all("#round-grid [data-round]", "els => els.map(e => e.innerText.replace(/\\s+/g, ' ').trim())")
    cells = page.eval_on_selector_all("#round-grid [data-blockday]", "els => els.map(e => [e.getAttribute('data-blockday').split(':').slice(-2).join(':'), e.getAttribute('data-cell')])")
    check(tag + "S11 C.3.11: the grid shows one column per round and one cell per day with its state (Fixed: no goal line)",
          cols == ["R1", "R2"] and cells == [["p1:d1", "now"], ["p2:d1", "notplanned"], ["p1:d2", "planned"], ["p2:d2", "notplanned"]], {"cols": cols, "cells": cells})
    check(tag + "C.3.11 r4.6 Q2: both minus and plus show on Fixed, live", page.is_enabled("#grid-less") and page.is_enabled("#grid-more"))
    # The grid is a real grid on screen: each day row on one line, each round's cell under its own
    # round head (a by-eye look found every cell stacked under R1 when the buttons were the cells).
    geo = page.evaluate("""() => { const box = (e) => e.getBoundingClientRect();
      const heads = [...document.querySelectorAll('#round-grid [data-round]')].map(e => { const b = box(e); return b.left + b.width / 2; });
      return [...document.querySelectorAll('#round-grid [data-gridday]')].map(r => [...r.querySelectorAll('[data-blockday]')].map((c, i) => {
        const b = box(c); return { top: Math.round(b.top), mid: Math.abs(b.left + b.width / 2 - heads[i]) < 2 }; })); }""")
    check(tag + "S11 C.3.11: each day's cells sit on one line, each under its round head",
          len(geo) == 2 and all(len(r) == 2 and len({c["top"] for c in r}) == 1 and all(c["mid"] for c in r) for r in geo)
          and geo[0][0]["top"] < geo[1][0]["top"], geo)
    layout(page, tag, "round grid")
    page.click("#grid-more"); settle(page, 500)
    check(tag + "C.3.11: plus adds a round at once and the toast shows the count",
          h["toast"](page) == "Rounds: 3" and page.locator("#round-grid [data-round]").count() == 3)
    page.click("#grid-less"); page.wait_for_selector("#grid-remove")
    off0 = page.is_disabled("#grid-remove-go")
    page.fill("#grid-remove input", "REMOV")
    off1 = page.is_disabled("#grid-remove-go")
    page.fill("#grid-remove input", "REMOVE")
    check(tag + "M59: minus stays disabled until REMOVE is typed", off0 and off1 and page.is_enabled("#grid-remove-go"), [off0, off1])
    page.click("#grid-remove-go"); settle(page, 600)
    check(tag + "C.3.11: REMOVE takes the round off the end", next(b for b in h["rows"](page, "blocks") if b["id"] == bid)["passes"] == 2)
    page.click("#round-grid [data-blockday$=':p1:d2']"); page.wait_for_selector("#dayview")
    check(tag + "S11: a day that is not the current one opens read only", page.get_attribute("#dayview", "data-state") == "later")
    go_route(page, "#/block", "#round-grid")
    page.click("#round-grid [data-cell='now']"); page.wait_for_selector("#today[data-day]")
    check(tag + "S11: the current cell goes to Today", page.evaluate("location.hash") == "#/today")
    # Down to 1 round: minus then shows its reason (r4.6 Q2, grid.min).
    go_route(page, "#/block", "#round-grid")
    page.click("#grid-less"); page.wait_for_selector("#grid-remove")
    page.fill("#grid-remove input", "REMOVE"); page.click("#grid-remove-go"); settle(page, 600)
    check(tag + "C.3.11 r4.6 Q2: at 1 round minus is disabled with grid.min",
          page.is_disabled("#grid-less") and page.inner_text("#grid-less-why").strip() == "A block needs at least 1 round.", page.inner_text("#grid-count"))
    ctx.close()
    # r4.6 Q1: REMOVE at the start of the last round finishes the block.
    ctx, page = h["new"]()
    s3_unit_first(page)
    bid = s3_make(page, [ONE_DAY("Two round block", 2)])[0]
    go_route(page, "#/today", "#today[data-day]")
    s3_log_day(page)
    page.click("#done-go"); page.wait_for_selector("#today[data-day]")
    go_route(page, "#/block", "#round-grid")
    page.click("#grid-less"); page.wait_for_selector("#grid-remove")
    end_line = page.locator("#grid-remove-end").count() == 1
    page.fill("#grid-remove input", "REMOVE"); page.click("#grid-remove-go")
    try:
        page.wait_for_selector("#finished #fin-new", timeout=8000)
        fin = True
    except Exception:
        fin = False
    blk = next(b for b in h["rows"](page, "blocks") if b["id"] == bid)
    check(tag + "r4.6 Q1: REMOVE at the start of the last round shows end.line, deletes its planned day and opens Block finished",
          end_line and fin and blk["status"] == "done" and blk["passes"] == 1 and not [d for d in h["rows"](page, "days") if d["pass"] == 2],
          {"end line": end_line, "finished": fin, "block": [blk["status"], blk["passes"]]})
    ctx.close()


@slice3_part("history")
def part_s3_history(h):
    tag = h["tag"]
    ctx, page = h["new"]()
    s3_unit_first(page)
    go_route(page, "#/history", "#history-none")
    check(tag + "C.3.12: with no finished day History shows its empty state", page.inner_text("#history-none h2").strip() == "Nothing logged yet")
    go_route(page, "#/today", "#today > *")
    s3_make(page, [ONE_DAY("History block", 3, sets=2)])
    for _ in range(2):
        go_route(page, "#/today", "#today[data-day]")
        s3_log_day(page)
        page.click("#done-go")
    go_route(page, "#/history", "#history-days")
    rows_ = page.eval_on_selector_all("[data-histday]", "els => els.map(e => e.querySelector('.hist-pos').innerText.trim())")
    check(tag + "S13 C.3.12: Days lists the finished days newest first by place, under the block label",
          rows_ == ["R2 D1 A", "R1 D1 A"] and page.text_content("[data-histlabel]").strip() == "BLOCK: History block", rows_)
    check(tag + "C.3.12: a day row's second line reads date, time and the set count", " · 2 sets" in page.inner_text("[data-histday] .hist-when"))
    ink = page.evaluate("""() => { const s = document.querySelector('[data-histday] .tally-stroke.is-done'); const g = document.createElement('span');
      g.className = 'tally-stroke'; document.body.appendChild(g); const ghost = getComputedStyle(g).backgroundColor; g.remove();
      return s ? { done: getComputedStyle(s).backgroundColor, ghost, h: s.getBoundingClientRect().height } : null; }""")
    check(tag + "C.3.12 LOOK 4.8: a History day row draws the large tally, done strokes in ink, not ghost",
          ink is not None and ink["done"] != ink["ghost"] and ink["h"] >= 30, ink)
    layout(page, tag, "history days")
    page.click("#history-switch [data-seg='1']"); page.wait_for_selector("[data-histex]")
    page.click("[data-histex='leg_press']"); page.wait_for_selector("#history .trend")
    dots = page.locator("#history .trend .trend-dot").count()
    aria = page.get_attribute("#history .trend", "aria-label")
    last = page.get_attribute("#history .trend .trend-last", "data-last")
    check(tag + "S13 C.3.12: the trend line has one dot per round, the last one labeled, and an aria-label in words",
          dots == 2 and last == "100" and aria.startswith("Leg press: top set 100 to 100 lb over 2 rounds") and page.locator("#history .trend title").count() == 1, [dots, last, aria])
    rounds = page.eval_on_selector_all("#history .hist-round", "els => els.map(e => e.innerText.replace(/\\s+/g, ' ').trim())")
    check(tag + "C.3.12: the by-round table shows each round's sets as load x reps", rounds[0].startswith("R1") and re.search(r"100 x \d+", rounds[0]) is not None, rounds)
    layout(page, tag, "history by exercise")
    page.reload(); page.wait_for_selector("#history-days")
    check(tag + "C.3.12: the view switch resets to Days after a reload (kept in memory only)", page.get_attribute("#history", "data-view") == "days")
    page.click("[data-histday]"); page.wait_for_selector("#dayview")
    check(tag + "C.3.12: a History day opens the read-only day view", page.get_attribute("#dayview", "data-state") == "done")
    ctx.close()


@slice3_part("look041")
def part_s3_look041(h):
    """0.4.1 look fixes (ai-ops-architect 2026-11-15): Q1 day.sub.one, Q2 one back arrow, Q3 the lit tab and Back."""
    tag = h["tag"]
    ctx, page = h["new"]()
    s3_unit_first(page)
    load_block_file(page, os.path.join(FIXTURES, "block_v1.json"))
    guard = 0
    while open_set(page) and guard < 40:
        tick(page, fb="later")
        guard += 1
    page.click("#finish-day")
    sub = None
    for _ in range(12):
        settle(page, 300)
        if page.locator("#feedback").count():
            page.click("#fb-skip"); continue
        if page.locator("#overall").count():
            sub = page.inner_text("#overall > p.small").strip()
            page.click("#day-skip"); continue
        if page.locator("#nudge").count():
            page.click("#nudge-later"); settle(page); break
    check(tag + "0.4.1 Q1: with one score the overall sheet reads '1 quick question'", sub == "1 quick question", sub)
    leave_day_done(page)

    def look(where):
        return page.evaluate("""() => { const b = document.getElementById('day-back'); const on = [...document.querySelectorAll('.tab.is-active')].map(e => e.getAttribute('data-tab'));
          return b ? { text: b.innerText.trim(), svgs: b.querySelectorAll('svg').length, href: b.getAttribute('href'), on } : null; }""")

    # From History: History is lit and Back lands on #/history.
    go_route(page, "#/history", "#history-days")
    page.click("[data-histday]"); page.wait_for_selector("#dayview[data-state='done']")
    a = look("history")
    screenshot(page, "e2e_look041_%s_dayview.png" % h["vp"])   # for the by-eye read (written to the log folder)
    check(tag + "0.4.1 Q2: the day view's Back link is one glyph and the word Back, no typed arrow",
          a is not None and a["text"] == "Back" and a["svgs"] == 1 and "<" not in a["text"], a)
    check(tag + "0.4.1 Q3a: a day opened from History lights the History tab", a is not None and a["on"] == ["#/history"], a)
    check(tag + "0.4.1 Q3b: a day opened from History has Back to History", a is not None and a["href"] == "#/history", a)
    page.click("#day-back")
    ok = True
    try:
        page.wait_for_selector("#history-days", timeout=8000)
    except Exception:
        ok = False
    check(tag + "0.4.1 Q3b: Back from a History day lands on History", ok and page.locator("#dayview").count() == 0)
    layout(page, tag, "history after day back")

    # A reload on the address: Block is lit and Back goes to Block.
    page.click("[data-histday]"); page.wait_for_selector("#dayview[data-state='done']")
    page.reload(); page.wait_for_selector("#dayview[data-state='done']", timeout=15000); settle(page, 300)
    c = look("reload")
    check(tag + "0.4.1 Q3a: a reload on a day address lights Block and Back goes to Block",
          c is not None and c["on"] == ["#/block"] and c["href"] == "#/block", c)

    # From the Block tab: Block is lit and Back lands on #/block.
    go_route(page, "#/block", "#block #round-grid")
    page.click("#round-grid [data-blockday$=':p1:d1']"); page.wait_for_selector("#dayview")
    b = look("block")
    check(tag + "0.4.1 Q3a: a day opened from the Block tab lights Block, Back goes to Block",
          b is not None and b["on"] == ["#/block"] and b["href"] == "#/block" and b["text"] == "Back" and b["svgs"] == 1, b)
    layout(page, tag, "day view from block")
    page.click("#day-back"); page.wait_for_selector("#block #round-grid")
    check(tag + "0.4.1 Q3b: Back from a Block day lands on the Block tab", page.locator("#dayview").count() == 0)
    ctx.close()


@slice3_part("library")
def part_s3_library(h):
    tag = h["tag"]
    ctx, page = h["new"]()
    s3_unit_first(page)
    s3_make(page, [ONE_DAY("Library block", 2)])
    go_route(page, "#/today", "#today[data-day]")
    s3_log_day(page)
    page.click("#done-go")
    go_route(page, "#/block", "#lib-row")
    page.click("#lib-row"); page.wait_for_selector("#lib-list [data-libex]")
    n = page.locator("[data-libex]").count()
    names = page.eval_on_selector_all("[data-libex]", "els => els.map(e => e.querySelector('.grow span').innerText.trim().toLowerCase())")
    check(tag + "AW2 C.3.13: the library lists every exercise by name", n == len(h["rows"](page, "exercises")) and names == sorted(names), n)
    layout(page, tag, "library")
    page.click("[data-libf='logged']"); settle(page, 300)
    check(tag + "AW2 IW2: Logged only shows only exercises with a done set", page.eval_on_selector_all("[data-libex]", "els => els.map(e => e.getAttribute('data-libex'))") == ["leg_press"])
    page.click("[data-libf='logged']"); settle(page, 300)
    page.click("[data-libf='muscle']"); page.wait_for_selector("#libpick-muscle")
    page.click("[data-libpick='calves']"); page.click("#libpick-close"); settle(page, 300)
    calves = page.eval_on_selector_all("[data-libex]", "els => els.map(e => e.getAttribute('data-libex'))")
    ex = {e["id"]: e for e in h["rows"](page, "exercises")}
    check(tag + "IW2: the Muscle filter narrows to that muscle and its chip shows the count",
          calves and all(ex[i].get("muscle_detail") == "calves" for i in calves) and page.inner_text("[data-libf='muscle']").strip() == "Muscle 1", calves[:4])
    page.click("#lib-clear"); settle(page, 300)
    # Equipment starts at saved equipment.
    page.evaluate(S3_PUT_SETTING, ["equipment_saved", ["machine", "smith", "cable", "barbell", "landmine", "dumbbell", "kettlebell", "body", "other"]])
    page.reload(); page.wait_for_selector("#lib-list [data-libex]")
    ids = page.eval_on_selector_all("[data-libex]", "els => els.map(e => e.getAttribute('data-libex'))")
    check(tag + "C.3.13: the equipment filter starts at the saved kinds", page.inner_text("[data-libf='equipment']").strip() == "Equipment 9"
          and not any(ex[i].get("equipment_detail") == "band" for i in ids), page.inner_text("#lib-filters"))
    # Exercise detail: the pinned note from Edit note, after a reload (L10); the link; History.
    go_route(page, "#/exercise/leg_press", "#exd-switch")
    page.click("#exd-editnote"); page.wait_for_selector("#exnote-sheet")
    page.fill("#exnote-in", "Seat 5, pin 3")
    page.click("#exnote-save"); settle(page, 400)
    page.evaluate("async () => { const { db } = await import('./db.js'); const { createStore } = await import('./store.js'); await createStore({ db }).saveExerciseText('leg_press', 'link', 'https://example.com/watch?v=1'); return true; }")
    page.reload(); page.wait_for_selector("#exd-switch")
    a = page.locator("#exd-link")
    check(tag + "AW3 IW3 L10: the pinned note shows after a reload; the link is an <a> with both rel words and no player",
          page.inner_text("#exd-note").strip() == "Seat 5, pin 3" and a.count() == 1 and a.get_attribute("rel") == "noopener noreferrer"
          and a.get_attribute("href") == "https://example.com/watch?v=1" and page.locator("iframe, video, embed").count() == 0)
    check(tag + "C.3.14: Edit note never marks the row edited", not ex["leg_press"].get("edited") and not next(e for e in h["rows"](page, "exercises") if e["id"] == "leg_press").get("edited"))
    layout(page, tag, "exercise detail")
    page.click("#exd-switch [data-seg='1']"); page.wait_for_selector("#exd-body [data-histblock]")
    check(tag + "AW3 IW4: the History tab lists past sets", re.search(r"100 x \d+", page.inner_text("#exd-body")) is not None, page.inner_text("#exd-body")[:120])
    go_route(page, "#/exercise/@@bad", "#library")
    check(tag + "C.0.1: a bad #/exercise/ id goes to the library", page.evaluate("location.hash") == "#/exercises")
    ctx.close()


@slice3_part("bodyweight")
def part_s3_bodyweight(h):
    tag = h["tag"]
    ctx, page = h["new"]()
    s3_unit_first(page)
    s3_make(page, [ONE_DAY("Weight block", 2)])
    go_route(page, "#/today", "#today[data-day]")
    s3_day_item(page, "bw"); page.wait_for_selector("#bw-sheet")
    layout(page, tag, "body weight sheet")
    page.fill("#bw-in", "1001"); page.click("#bw-save"); settle(page, 300)
    refused = page.inner_text("#bw-help").strip() == "Use a number from 20 to 1000" and page.locator("#bw-sheet").count() == 1
    page.fill("#bw-in", "182,5"); page.click("#bw-save"); settle(page, 500)
    did = page.get_attribute("#today", "data-day")
    day = next(d for d in h["rows"](page, "days") if d["id"] == did)
    check(tag + "DW8 C.3.15: 1001 is refused with num.bw; 182,5 saves 182.5 on the day", refused and day["body_weight"] == 182.5, {"refused": refused, "bw": day["body_weight"]})
    s3_log_day(page)
    page.click("#done-go")
    flat = page.evaluate("async () => { const { db } = await import('./db.js'); const { createStore } = await import('./store.js'); return (await createStore({ db }).backupObject()).flat_log; }")
    check(tag + "O06 DW8: the backup's flat_log carries body_weight on every row of that day", flat and all(r["body_weight"] == 182.5 for r in flat), [r.get("body_weight") for r in flat][:3])
    go_route(page, "#/history", "#history-days")
    check(tag + "C.3.15: History shows the body weight on the day's second line", "182.5 lb body weight" in page.inner_text("[data-histday] .hist-when"))
    ctx.close()


@slice3_part("tips")
def part_s3_tips(h):
    tag = h["tag"]
    audit = h["audit"]
    def tipless():
        c, p = new_context(h["browser"], audit, standalone=True, vp=h["vp"], intros=False)
        p.set_default_timeout(10000)
        p.goto(h["base"]); p.wait_for_selector("#today > *", timeout=15000); wait_controller(p); settle(p, 300)
        return c, p
    ctx, page = tipless()
    s3_unit_first(page)
    s3_make(page, [{"name": "Tip block", "passes": 2, "activate": True, "days": [{"label": "A", "lifts": [["leg_press", 2, 100], ["lat_pulldown", 2, 80]]}]}])
    go_route(page, "#/today", "#today[data-day]")
    first = page.evaluate("() => { const t = document.getElementById('tip'); const c = document.querySelector('#today .ex-card'); return !!t && !!c && t.getAttribute('data-tip') === 'tip_warmup' && (t.compareDocumentPosition(c) & 4) > 0; }")
    check(tag + "S17 W03: a round 1 day shows the warm-up tip above the first card", first and "log the weight you really lift" in page.inner_text("#tip"))
    layout(page, tag, "warm-up tip")
    tick(page, fb="save"); settle(page, 400)
    check(tag + "S17: after the first tick the rest tip shows (the newest event wins)", page.get_attribute("#tip", "data-tip") == "tip_rest", page.get_attribute("#tip", "data-tip") if page.locator("#tip").count() else None)
    page.click("#tip-close"); settle(page, 400)
    page.reload(); page.wait_for_selector("#today[data-day]"); settle(page, 400)
    seen = page.evaluate(S3_SETTING, "tips_seen")
    tick(page, fb="save"); settle(page, 400)
    check(tag + "M69: a closed tip does not come back after a reload", (seen or {}).get("tip_rest") is True
          and not (page.locator("#tip").count() and page.get_attribute("#tip", "data-tip") == "tip_rest"), seen)
    # A swap: the start tip under the new card (DW4).
    page.click("[data-menu]"); page.wait_for_selector("#card-menu")
    page.click("#card-menu [data-cardmenu='3'], #card-menu [data-item='3']")
    page.wait_for_selector("#picker"); settle(page, 400)
    if page.locator("#intro-ok").count():
        page.click("#intro-ok"); settle(page, 300)
    page.click("[data-pick='leg_extension']"); page.wait_for_selector("#today[data-day]"); settle(page, 500)
    check(tag + "DW4: after a swap the start tip shows under the new card",
          page.locator("#tip[data-tip='tip_start']").count() == 1 and page.evaluate("() => { const t = document.getElementById('tip'); const c = t && t.previousElementSibling; return !!c && c.getAttribute('data-exercise') === 'leg_extension'; }"))
    ctx.close()
    # One-time intros: the builder intro, then the picker intro, each once only (BW7).
    ctx, page = tipless()
    s3_unit_first(page)
    build_click(page, "#setup-build")
    page.wait_for_selector("#intro-sheet[data-intro='intro_builder']")
    check(tag + "C.3.16: the builder intro shows on the first visit with Got it", page.inner_text("#intro-ok").strip() == "Got it")
    page.click("#intro-ok"); settle(page, 300)
    page.fill("#block-name", "Intro block"); page.click("#builder-next"); page.wait_for_selector("#builder[data-step='2']"); settle(page, 300)
    builder_again = page.locator("#intro-sheet").count()
    fill_change(page, "#block-rounds", "2"); page.click("#builder-next"); page.wait_for_selector("#builder[data-step='3']")
    page.click("[data-addex='0']"); page.wait_for_selector("#intro-sheet[data-intro='intro_picker']")
    page.click("#intro-ok"); settle(page, 300)
    page.click("#picker-back"); page.wait_for_selector("#builder[data-step='3']")
    page.click("[data-addex='0']"); page.wait_for_selector("#picker"); settle(page, 600)
    page.reload(); page.wait_for_selector("#builder, #picker, #today > *"); settle(page, 600)
    seen = page.evaluate(S3_SETTING, "tips_seen") or {}
    check(tag + "BW7 C.3.16: each intro shows once only, and is kept after a reload",
          builder_again == 0 and page.locator("#intro-sheet").count() == 0 and seen.get("intro_builder") is True and seen.get("intro_picker") is True, seen)
    ctx.close()


# ---------------- suite upgrade (16 B.12 row "e2e.py --suite upgrade", r4.4 R8) ----------------

# The last schema 1 build: the live public 0.2.6, the same app files as main 383be49, the commit
# just before the schema commit (B.1 R1). It is exported with git archive into the copy base.
OLD_COMMIT = "bae7bec"
OLD_VERSION = "0.2.6"
# Keeps the 0.2.6 page running 0.2.6 after 0.3.0 takes the origin: on that page only, a waiting
# worker is never asked to take over and controllerchange never reloads it (a harness patch, the
# app is not changed). The new tab is not patched, so it takes 0.3.0 the way a phone does.
PIN_OLD = ("(() => { const pm = ServiceWorker.prototype.postMessage;"
           " ServiceWorker.prototype.postMessage = function (m, ...r) { if (m && m.type === 'SKIP_WAITING') return; return pm.call(this, m, ...r); };"
           " const add = ServiceWorkerContainer.prototype.addEventListener;"
           " ServiceWorkerContainer.prototype.addEventListener = function (t, ...r) { if (t === 'controllerchange') return; return add.call(this, t, ...r); }; })();")
# M38's first edit (mutants.js row M38): MIGRATIONS[1] throws half way through the sets.
M38_FIND = "  if (Array.isArray(s.sets)) s.sets = s.sets.map(x => {\n"
M38_REPLACE = "  if (Array.isArray(s.sets)) s.sets = s.sets.map((x, i, all) => {\n    if (i === Math.floor(all.length / 2)) throw new Error('planted throw half way');\n"
DB_INFO = "async () => { const l = indexedDB.databases ? await indexedDB.databases() : []; const d = l.find(x => x.name === 'liftlog'); return d ? d.version : null; }"
# Every store read straight from IndexedDB at the version the db is at (no app code), for the abort case.
RAW_DUMP = """async () => { const v = (await indexedDB.databases()).find(x => x.name === 'liftlog').version;
  const conn = await new Promise((res, rej) => { const r = indexedDB.open('liftlog', v); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const out = {}; for (const s of %s) { out[s] = await new Promise((res, rej) => { const q = conn.transaction(s).objectStore(s).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
  conn.close(); return JSON.stringify({ version: v, stores: out }); }""" % STORES7


def make_old_build(base, name):
    """The 0.2.6 served copy: git archive of OLD_COMMIT into the copy base, scripts/ left out."""
    src = os.path.join(base, name + "-archive")
    dst = os.path.join(base, name)
    for p_ in (src, dst):
        shutil.rmtree(p_, ignore_errors=True)
    os.makedirs(src)
    # A planted copy made by mutants.js is a fresh repo with one commit, so it reads the old build
    # from the source repo it was copied from (LIFTLOG_SOURCE_REPO, set by mutants.js).
    repo = os.environ.get("LIFTLOG_SOURCE_REPO") or APP_DIR
    tar = subprocess.run(["git", "-C", repo, "archive", "--format=tar", OLD_COMMIT], capture_output=True, check=True).stdout
    subprocess.run(["tar", "-x", "-C", src], input=tar, check=True)
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns("scripts"))
    v = open(os.path.join(dst, "version.js")).read()
    if ("APP_VERSION = '%s'" % OLD_VERSION) not in v or "SCHEMA = 1" not in v:
        raise RuntimeError("the archived build is not %s on schema 1" % OLD_VERSION)
    return dst


# The published 0.3.0 (public 5e6fb60, the tree of main 84bb94e): the last build before Slice 3.
OLD030_COMMIT = "5e6fb60"
PREV_VERSION = "0.3.0"


def make_archive_build(base, name, commit, version, schema):
    """A served copy of a published build: git archive of commit, scripts/ left out of the served copy."""
    src = os.path.join(base, name + "-archive")
    dst = os.path.join(base, name)
    for p_ in (src, dst):
        shutil.rmtree(p_, ignore_errors=True)
    os.makedirs(src)
    repo = os.environ.get("LIFTLOG_SOURCE_REPO") or APP_DIR
    tar = subprocess.run(["git", "-C", repo, "archive", "--format=tar", commit], capture_output=True, check=True).stdout
    subprocess.run(["tar", "-x", "-C", src], input=tar, check=True)
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns("scripts"))
    v = open(os.path.join(dst, "version.js")).read()
    if ("APP_VERSION = '%s'" % version) not in v or ("SCHEMA = %d" % schema) not in v:
        raise RuntimeError("the archived build is not %s on schema %d" % (version, schema))
    return dst


def make_m38_build(base, name):
    """0.3.0 with MIGRATIONS[1] throwing half way (the M38 build of 16 B.12), on a scratch copy."""
    dst = make_build(base, name)
    p_ = os.path.join(dst, "backup.js")
    text = open(p_).read()
    if text.count(M38_FIND) != 1:
        raise RuntimeError("the M38 find text is not in backup.js once")
    open(p_, "w").write(text.replace(M38_FIND, M38_REPLACE))
    return dst


def suite_upgrade(browser, base, cb):
    tag = "[440] upgrade "
    o = urlparse(base)
    origin = o.scheme + "://" + o.netloc
    audit = Audit(origin)
    OLD = make_old_build(cb, "upgrade-old")
    NEW = make_build(cb, "upgrade-new")
    M38 = make_m38_build(cb, "upgrade-m38")
    out_dir = os.path.join(cb, "upgrade-files")
    os.makedirs(out_dir, exist_ok=True)
    reopen_words = "New version ready. Close the app and open it again."
    fail_words = "The update could not finish. Nothing was changed. Close the app and open it again."

    def old_block():
        """A made-up schema 1 block for 0.2.6: day A has a laps lift (break chips), 2 rounds."""
        f = json.load(open(os.path.join(FIXTURES, "block_v1.json")))
        lift = lambda slot, ex, sets, load, **more: dict({"slot": slot, "exercise_id": ex, "sets": sets, "rep_low": 8, "rep_high": 12, "start_load": load,
                                                           "failure_set": False, "reps_left_target": 2, "warmups": [], "sides": "none", "load_basis": "total",
                                                           "count_label": None, "note": ""}, **more)
        f["source_id"] = "upgrade-old"
        f["block"]["passes"] = 2
        f["block"]["day_templates"] = [
            {"day": 1, "label": "A", "lifts": [lift(1, "leg_press", 2, 100), lift(2, "farmer_carry", 2, 50, rep_low=None, rep_high=None, count_label="laps", load_basis="per_hand")]},
            {"day": 2, "label": "B", "lifts": [lift(1, "lat_pulldown", 2, 80), lift(2, "leg_extension", 1, 60)]}]
        f["exercises"] = []
        # No custom rows here, so no flag may name one (the block check refuses an unknown id, badref).
        f["block"]["exercise_flags"] = {k: v for k, v in f["block"]["exercise_flags"].items() if not k.startswith("ex_")}
        path = os.path.join(out_dir, "block_upgrade_old.json")
        json.dump(f, open(path, "w"))
        return path

    def fb_save(page):
        settle(page, 300)
        if page.locator("#feedback").count():
            for k in ("pump", "soreness", "workload"):
                if page.locator("#feedback [data-answer='%s-2']" % k).count():
                    page.click("#feedback [data-answer='%s-2']" % k)
            page.click("#fb-save")
            poll(page, "() => !document.getElementById('feedback')")
            settle(page)

    def old_day(page, breaks=False, move=False):
        """0.2.6: one day ticked at its targets with feedback on every lift, then Finish day."""
        if move:
            page.click("[data-menu='2']")
            page.wait_for_selector("#card-menu")
            page.click("#card-menu [data-item='up']")
            settle(page, 500)
        guard = 0
        while open_set(page) and guard < 20:
            sid = open_set(page)
            if breaks and page.locator(q(sid) + " [data-br='1']").count():
                page.click(q(sid) + " [data-br='1']"); settle(page, 400)
                breaks = False
            page.click(q(sid) + " [data-tick]")
            settle(page, 400)
            if page.locator("#range-sheet").count():
                page.click("#range-log")
            wait_state(page, sid, "done")
            fb_save(page)
            guard += 1
        return finish(page)

    def norm_rows(stores):
        return {s_: sorted(stores.get(s_, []), key=lambda r_: json.dumps(r_, sort_keys=True)) for s_ in ("settings", "exercises", "templates", "blocks", "days", "sets", "feedback")}

    def ids(rows_):
        return sorted(r_.get("id", r_.get("key")) for r_ in rows_)

    def wait_new(page, timeout=40):
        """Waits until this tab runs 0.3.0 (it took the waiting worker and reloaded once)."""
        end = time.time() + timeout
        while time.time() < end:
            try:
                v = page.evaluate("async () => (await import('./version.js')).APP_VERSION")
                if v == APP_VERSION and page.locator(".tabbar").count():
                    return True
            except Exception:
                pass
            time.sleep(0.5)
        return False

    # (1) to (4): 0.2.6 logs its rows, 0.3.0 opens in a second tab of the same origin.
    def case_main():
        SERVE["app"] = OLD
        ctx, p1 = new_context(browser, audit, standalone=True)
        p1.add_init_script(PIN_OLD)
        p1.set_default_timeout(10000)
        p1.goto(base)
        p1.wait_for_selector("#today > *", timeout=15000)
        wait_controller(p1)
        check(tag + "the old tab runs " + OLD_VERSION, p1.evaluate("async () => (await import('./version.js')).APP_VERSION") == OLD_VERSION)
        p1.click("#unit-lb")
        load_block_file(p1, old_block())
        check(tag + "0.2.6: round 1 day A finished with feedback and a break chip", old_day(p1, breaks=True))
        check(tag + "0.2.6: round 1 day B finished with feedback and a moved card", old_day(p1, move=True))
        # Skip day on round 2 day A (no Day done screen on a skip).
        p1.click("#day-menu"); p1.wait_for_selector("#day-menu-sheet")
        p1.click("#day-menu-sheet [data-dayitem='skip']")
        p1.wait_for_selector("#skipday-sheet")
        p1.click("#skipday-go")
        p1.wait_for_selector("#skipday-sheet", state="detached")
        p1.wait_for_selector("#today[data-day]")
        settle(p1, 500)
        check(tag + "0.2.6: Skip day shows no Day done screen", p1.locator("#daydone").count() == 0)
        # A copied draft on round 2 day B: weight plus twice on set 1 copies down to set 2.
        sid = open_set(p1)
        p1.click(q(sid) + " [data-step='load+']"); settle(p1, 400)
        p1.click(q(sid) + " [data-step='load+']"); settle(p1, 500)
        before = json.loads(p1.evaluate(DUMP_JS))
        last_lines = p1.eval_on_selector_all(".ex-card", "els => els.map(e => [e.getAttribute('data-slot'), (e.querySelector('.ex-last') || {}).textContent || null])")
        day_b2 = p1.get_attribute("#today", "data-day")
        sets_b = [r_ for r_ in before["sets"] if r_["day_id"] == day_b2]
        own = next((r_ for r_ in sets_b if r_["id"] == sid), {})
        dl = (own.get("draft") or {}).get("load")
        copied = lambda rows_: any(r_.get("draft") and r_["draft"].get("from_copy") is True and r_["draft"].get("load") == dl for r_ in rows_)
        moved = lambda days_: any(d.get("slot_order") == [2, 1] for d in days_)
        check(tag + "0.2.6 rows hold every case: 2 done days with feedback, a break, a draft copied down, a moved card, a skipped day",
              sum(1 for d in before["days"] if d["status"] == "done") == 2 and sum(1 for d in before["days"] if d["status"] == "skipped") == 1
              and len(before["feedback"]) >= 4 and any((r_.get("done") or {}).get("breaks") == 1 for r_ in before["sets"])
              and dl is not None and dl != own["target"]["load"] and copied(sets_b)
              and moved(before["days"]) and any(x[1] for x in last_lines),
              {"days": [d["status"] for d in before["days"]], "draft": dl, "lines": last_lines})
        # 0.3.0 at the same origin, in a second tab of the same browser.
        SERVE["app"] = NEW
        p2 = new_page(ctx, audit)
        p2.set_default_timeout(10000)
        p2.goto(base)
        took = wait_new(p2)
        check(tag + "(2) a new tab takes 0.3.0", took)
        if not took:
            ctx.close()
            return
        p2.wait_for_selector("#today[data-day]", timeout=15000)
        settle(p2, 600)
        # The 0.2.6 tab, still open: its link is closed and never reconnects (0.2.6 db.js _versionClosed),
        # so its tick writes nothing. Found in this e2e loop: 16 B.5 row 16 and B.12 say the tick "shows
        # the built Not saved row", but 0.2.6's redraw() reads the store and swallows the closed-link
        # error, so the screen is never drawn again and the row stays as it was (open, never done).
        # 0.2.6 is frozen (no change to 0.2.6), so the check holds what 0.2.6 really does: no false
        # done, the link refused with its closed text, and no row of it in the new db (BUILD_LOG).
        sid1 = open_set(p1)
        p1.click(q(sid1) + " [data-tick]")
        settle(p1, 3000)
        st1 = state_of(p1, sid1)
        closed = p1.evaluate("async () => { const { db } = await import('./db.js'); try { await db.ready(); return 'open'; } catch (e) { return String(e && e.message); } }")
        row_now = next((r_ for r_ in p2.evaluate(DB_ALL, "sets") if r_["id"] == sid1), None)
        check(tag + "(2) the 0.2.6 tab closed its link and never reconnects: its tick never shows done and no row of it reaches the new db",
              st1 in ("open", "failed") and closed == "Database closed for a newer version"
              and row_now and row_now["status"] == "planned" and row_now["done"] is None,
              {"state": st1, "link": closed, "row": row_now and (row_now["status"], row_now["done"])})
        check(tag + "(2) the 0.2.6 tab never shows the db.reopen line (0.2.6 has none)", p1.locator("#db-blocked").count() == 0 and reopen_words not in p1.inner_text("body"))
        # (3) The new boot: a before-upgrade copy, every row counted and migrated, Last time unchanged.
        snaps = p2.evaluate(DB_ALL, "snapshots")
        up = [s_ for s_ in snaps if s_["reason"] == "before-upgrade"]
        old_counts = {s_: len(before[s_]) for s_ in before}
        check(tag + "(3) one before-upgrade copy, made from the schema 1 rows with every count",
              len(up) == 1 and up[0]["data"]["schema"] == 1 and {s_: len(up[0]["data"]["stores"].get(s_, [])) for s_ in old_counts} == old_counts,
              {"snaps": [s_["reason"] for s_ in snaps]})
        after = {s_: p2.evaluate(DB_ALL, s_) for s_ in ("settings", "exercises", "templates", "blocks", "days", "sets", "feedback")}
        same_ids = all(ids(after[s_]) == ids(before[s_]) for s_ in ("exercises", "templates", "blocks", "days", "sets", "feedback"))
        keys_kept = set(ids(before["settings"])) <= set(ids(after["settings"]))
        migrated = (all("set_type" in r_ and "set_type_by_hand" in r_ for r_ in after["sets"])
                    and all("muscle_detail" in r_ and "load_kind" in r_ for r_ in after["exercises"])
                    and all("levels" in r_ and "switch_conditions" in r_ for r_ in after["blocks"])
                    and all("short_sleep_since_last" in r_ for r_ in after["days"]))
        kept = (any((r_.get("done") or {}).get("breaks") == 1 for r_ in after["sets"])
                and copied([r_ for r_ in after["sets"] if r_["day_id"] == day_b2])
                and moved(after["days"]) and sum(1 for d in after["days"] if d["status"] == "skipped") == 1)
        check(tag + "(3) every row counted and migrated: the same ids, schema 2 fields on every row, the break, draft, order and skip kept",
              same_ids and keys_kept and migrated and kept, {"ids": same_ids, "settings": keys_kept, "migrated": migrated, "kept": kept})
        check(tag + "(3) the db is at version 2", p2.evaluate(DB_INFO) == 2, p2.evaluate(DB_INFO))
        lines_now = p2.eval_on_selector_all(".ex-card", "els => els.map(e => [e.getAttribute('data-slot'), (e.querySelector('.ex-last') || {}).textContent || null])")
        check(tag + "(3) Last time on Today is unchanged", lines_now == last_lines, {"before": last_lines, "after": lines_now})
        # (4) Undo on the before-upgrade copy brings the old rows back on schema 2.
        sid2 = open_set(p2)
        tick(p2, sid2, fb="later")
        go_route(p2, "#/settings", "#settings")
        poll(p2, "() => { const r = document.getElementById('undo-row'); return !!r && !r.hidden; }")
        p2.click("#undo-row")
        p2.wait_for_selector("#undo-sheet")
        snap_btn = p2.locator("#undo-sheet [data-snap='%s']" % up[0]["id"]) if up else None
        check(tag + "(4) the Undo list names the copy Before upgrade", snap_btn is not None and snap_btn.count() == 1 and "Before upgrade" in snap_btn.inner_text())
        snap_btn.click()
        p2.wait_for_selector("#restore-sheet")
        p2.fill("#restore-sheet .confirm-input", "RESTORE")
        with p2.expect_navigation():
            p2.click("#restore-go")
        p2.wait_for_selector(".tabbar", timeout=15000)
        settle(p2, 600)
        undone = {s_: p2.evaluate(DB_ALL, s_) for s_ in ("exercises", "templates", "blocks", "days", "sets", "feedback")}
        back = next((r_ for r_ in undone["sets"] if r_["id"] == sid2), None)
        old_sets = {r_["id"]: r_ for r_ in before["sets"]}
        same = all(ids(undone[s_]) == ids(before[s_]) for s_ in undone)
        core = all({k: r_[k] for k in ("status", "done", "draft", "target")} == {k: old_sets[r_["id"]].get(k) for k in ("status", "done", "draft", "target")}
                   for r_ in undone["sets"] if r_["id"] in old_sets)
        check(tag + "(4) Undo on the before-upgrade copy brings the old rows back on schema 2 (the tick after the upgrade is gone)",
              same and core and back and back["status"] == "planned" and all("set_type" in r_ for r_ in undone["sets"]) and p2.evaluate(DB_INFO) == 2,
              {"ids": same, "rows": core, "tick": back and back["status"]})
        ctx.close()

    # (5) The abort case: the M38 build leaves schema 1 whole and shows db.upgradefail.
    def case_abort():
        SERVE["app"] = OLD
        ctx, page = new_context(browser, audit, standalone=True)
        page.set_default_timeout(10000)
        page.goto(base)
        page.wait_for_selector("#today > *", timeout=15000)
        wait_controller(page)
        page.click("#unit-lb")
        load_block_file(page, old_block())
        sid = open_set(page)
        page.click(q(sid) + " [data-step='load+']"); settle(page, 500)   # a draft, so the day stays not started
        raw_before = json.loads(page.evaluate(RAW_DUMP))
        page.close()
        SERVE["app"] = M38
        p2 = new_page(ctx, audit)
        p2.set_default_timeout(10000)
        p2.goto(base)
        try:
            end = time.time() + 40
            while time.time() < end:
                try:
                    if p2.locator("#db-blocked").count():
                        break
                except Exception:
                    pass
                time.sleep(0.5)
            text = p2.inner_text("#db-blocked")
        except Exception as e:
            text = "none: %r" % e
        raw_after = json.loads(p2.evaluate(RAW_DUMP))
        check(tag + "(5) abort: with MIGRATIONS[1] throwing, the open fails with db.upgradefail", fail_words in text, text[:160])
        check(tag + "(5) abort: the db stays on version 1 with every row deep-equal",
              raw_before["version"] == 1 and raw_after["version"] == 1 and norm_rows(raw_after["stores"]) == norm_rows(raw_before["stores"]),
              {"before": raw_before["version"], "after": raw_after["version"],
               "differ": [s_ for s_ in norm_rows(raw_before["stores"]) if norm_rows(raw_before["stores"])[s_] != norm_rows(raw_after["stores"])[s_]]})
        ctx.close()

    # (6) Last: two 0.3.0 tabs open; a scratch page of the same origin opens liftlog at version 3.
    def case_two_tabs():
        SERVE["app"] = NEW
        ctx, t1 = new_context(browser, audit, standalone=True)
        t1.set_default_timeout(10000)
        t1.goto(base)
        t1.wait_for_selector("#today > *", timeout=15000)
        wait_controller(t1)
        t1.click("#unit-lb")
        load_block_file(t1, BLOCK_V2)
        t2 = new_page(ctx, audit)
        t2.goto(base)
        t2.wait_for_selector("#today[data-day]", timeout=15000)
        settle(t2, 500)
        before = norm_stores(json.loads(t1.evaluate(DUMP_JS)))
        scratch = new_page(ctx, audit)
        scratch.goto(origin + BASE_PATH + "robots.txt")
        res = scratch.evaluate("""() => new Promise((res) => { let blocked = false; const r = indexedDB.open('liftlog', 3);
            r.onblocked = () => { blocked = true; };
            r.onsuccess = () => { window.__v3 = r.result; res({ ok: true, blocked, version: r.result.version }); };
            r.onerror = () => res({ ok: false, error: String(r.error) });
            setTimeout(() => res({ ok: false, error: 'no answer in 15 s', blocked }), 15000); })""")
        check(tag + "(6) a scratch page of the same origin opens liftlog at version 3", res.get("ok") and res.get("version") == 3, res)
        shown = []
        for t_ in (t1, t2):
            try:
                t_.wait_for_selector("#db-blocked", timeout=10000)
                shown.append(reopen_words in t_.inner_text("#db-blocked"))
            except Exception:
                shown.append(False)
        check(tag + "(6) both 0.3.0 tabs show the db.reopen line", shown == [True, True], shown)
        check(tag + "(6) the reopen screen leaves nothing to tap that writes", all(t_.locator("[data-tick], #finish-day, #sleep-card").count() == 0 for t_ in (t1, t2)))
        settle(t1, 1500)
        after = scratch.evaluate("""() => new Promise((res) => { const c = window.__v3; const names = %s; const out = {}; let left = names.length;
            const t = c.transaction(names); for (const n of names) { const q = t.objectStore(n).getAll(); q.onsuccess = () => { out[n] = q.result; if (--left === 0) res(JSON.stringify(out)); }; } })""" % STORES7)
        check(tag + "(6) both tabs wrote nothing after the close", norm_stores(json.loads(after)) == before)
        ctx.close()

    # (7) Slice 3 (DoD T3, schema unchanged at 2): the published 0.3.0 build logs real rows, then
    # 0.4.0 takes the origin. Every row of every store is kept as it was, no upgrade copy is made
    # (no schema change), the db stays at version 2, and the logged day shows in History.
    def case_from030():
        old030 = make_archive_build(cb, "upgrade-030", OLD030_COMMIT, PREV_VERSION, 2)
        SERVE["app"] = old030
        ctx, p1 = new_context(browser, audit, standalone=True)
        p1.add_init_script(PIN_OLD)
        p1.set_default_timeout(10000)
        p1.goto(base)
        p1.wait_for_selector("#today > *", timeout=15000)
        wait_controller(p1)
        check(tag + "(7) the old tab runs " + PREV_VERSION, p1.evaluate("async () => (await import('./version.js')).APP_VERSION") == PREV_VERSION)
        p1.click("#unit-lb")
        load_block_file(p1, os.path.join(old030 + "-archive", "scripts", "tests", "fixtures", "block_v2.json"))
        check(tag + "(7) 0.3.0: round 1 day 1 finished with feedback", old_day(p1))
        sid = open_set(p1)
        if sid:
            p1.click(q(sid) + " [data-step='load+']"); settle(p1, 500)   # a draft on the next day
        before = {s_: p1.evaluate(DB_ALL, s_) for s_ in ("settings", "exercises", "templates", "blocks", "days", "sets", "feedback", "snapshots")}
        p1.close()
        SERVE["app"] = NEW
        p2 = new_page(ctx, audit)
        p2.set_default_timeout(10000)
        p2.goto(base)
        took = wait_new(p2)
        check(tag + "(7) a new tab takes " + APP_VERSION, took)
        if not took:
            ctx.close()
            return
        p2.wait_for_selector("#today > *", timeout=15000)
        settle(p2, 800)
        after = {s_: p2.evaluate(DB_ALL, s_) for s_ in before}
        n = lambda rows_: sorted(json.dumps(r_, sort_keys=True) for r_ in rows_)
        same = {s_: n(after[s_]) == n(before[s_]) for s_ in ("exercises", "templates", "blocks", "days", "sets", "feedback", "snapshots")}
        old_keys = {r_["key"]: r_ for r_ in before["settings"]}
        new_keys = {r_["key"]: r_ for r_ in after["settings"]}
        # seeded_version is the seed upsert's own marker: it moves to the new version by design (5.2).
        changed = sorted(k_ for k_, v_ in old_keys.items() if new_keys.get(k_) != v_ and k_ != "seeded_version")
        settings_kept = not changed and (new_keys.get("seeded_version") or {}).get("value") == APP_VERSION
        added = sorted(set(new_keys) - set(old_keys))
        check(tag + "(7) every 0.3.0 row is kept deep-equal on 0.4.0 (exercises, blocks, days, sets, answers, copies) and every setting kept",
              all(same.values()) and settings_kept, {"same": same, "changed": [(k_, old_keys[k_].get("value"), (new_keys.get(k_) or {}).get("value")) for k_ in changed], "added": added})
        check(tag + "(7) only device keys are added (seen_version on the first 0.4.0 boot)", set(added) <= {"seen_version", "tips_seen"}, added)
        check(tag + "(7) no before-upgrade copy is made and the db stays at version 2",
              not any(s_["reason"] == "before-upgrade" for s_ in after["snapshots"]) and p2.evaluate(DB_INFO) == 2, p2.evaluate(DB_INFO))
        go_route(p2, "#/history", "#history")
        settle(p2, 600)
        check(tag + "(7) the day logged on 0.3.0 shows in History on 0.4.0", p2.locator("#history [data-histday]").count() >= 1,
              p2.locator("#history [data-histday]").count())
        ctx.close()

    for name, fn in (("main", case_main), ("abort", case_abort), ("twotabs", case_two_tabs), ("from030", case_from030)):
        section(tag + name, fn)
    os.makedirs(LOG_DIR, exist_ok=True)
    with open(os.path.join(LOG_DIR, "e2e_upgrade_network.json"), "w") as f:
        json.dump({"origin": origin, "requests": len(audit.requests), "off_origin": audit.off_origin(), "csp_violations": audit.csp, "console": audit.errors[:20]}, f, indent=1)
    off = audit.off_origin()
    check(tag + "network audit: zero requests off our origin and zero CSP violations", not off and not audit.csp,
          "%d requests, %d off origin, %d CSP %s" % (len(audit.requests), len(off), len(audit.csp), (off + audit.csp)[:3]))
    # A closed link and a failed upgrade may log on purpose here; the lines are kept, not counted.
    print("  INFO  upgrade console lines: %d %s" % (len(audit.errors), audit.errors[:3]), flush=True)


# ---------------- main ----------------

def launch(p, url=None):
    """Private headless Chromium. Every host but 127.0.0.1 goes to a dead proxy, so
    nothing can leave the Mac even if a planted defect drops the CSP. In --url mode the
    live host joins the bypass list, so that one host loads and every other still fails (C16)."""
    bypass = ["127.0.0.1"]
    if url:
        host = urlparse(url).hostname
        if host:
            bypass.append(host)
    return p.chromium.launch(headless=True, proxy={"server": "http://127.0.0.1:9", "bypass": ",".join(bypass)})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--suite", choices=["slice0", "slice1", "slice2", "slice3", "update", "twoapp", "upgrade"], default="slice0")
    ap.add_argument("--part", action="append", default=[])
    ap.add_argument("--url", default=None)
    ap.add_argument("--viewport", choices=["440", "375", "both"], default="both")
    ap.add_argument("--case", action="append", default=[], help="slice1 polish only: run just these cases (fix loop)")
    args = ap.parse_args()
    CASES.extend(args.case)

    from playwright.sync_api import sync_playwright

    cb = copy_base()
    t0 = time.time()
    vps = ["440", "375"] if args.viewport == "both" else [args.viewport]
    if args.url and args.suite != "slice0":
        print("the %s suite runs on the local server only" % args.suite)
        return 2
    with sync_playwright() as p:
        browser = launch(p, args.url)
        try:
            if args.suite == "slice1":
                for vp in vps:
                    SERVE["app"] = make_build(cb, "served1-" + vp)
                    SERVE["at"] = make_at_copy(cb, "at-served-" + vp)
                    srv = Server()
                    port = srv.port
                    local = {"server": srv, "port": port, "at": SERVE["at"]}
                    base = "http://127.0.0.1:%d%s" % (port, BASE_PATH)
                    print("e2e suite=slice1 viewport=%s base=%s" % (vp, base), flush=True)
                    try:
                        suite_slice1(browser, base, vp, local, cb, args.part)
                    finally:
                        try:
                            local["server"].stop()
                        except Exception:
                            pass
            elif args.suite == "slice2":
                for vp in vps:
                    SERVE["app"] = make_build(cb, "served2-" + vp)
                    srv = Server()
                    base = "http://127.0.0.1:%d%s" % (srv.port, BASE_PATH)
                    print("e2e suite=slice2 viewport=%s base=%s" % (vp, base), flush=True)
                    try:
                        suite_slice2(browser, base, vp, args.part)
                    finally:
                        try:
                            srv.stop()
                        except Exception:
                            pass
            elif args.suite == "slice3":
                for vp in vps:
                    SERVE["app"] = make_build(cb, "served3-" + vp)
                    srv = Server()
                    base = "http://127.0.0.1:%d%s" % (srv.port, BASE_PATH)
                    print("e2e suite=slice3 viewport=%s base=%s" % (vp, base), flush=True)
                    try:
                        suite_slice3(browser, base, vp, args.part)
                    finally:
                        try:
                            srv.stop()
                        except Exception:
                            pass
            elif args.suite == "upgrade":
                srv = Server()
                base = "http://127.0.0.1:%d%s" % (srv.port, BASE_PATH)
                print("e2e suite=upgrade base=%s" % base, flush=True)
                try:
                    suite_upgrade(browser, base, cb)
                finally:
                    srv.stop()
            elif args.suite == "slice0":
                for vp in vps:
                    if args.url:
                        print("e2e suite=slice0 viewport=%s base=%s" % (vp, args.url), flush=True)
                        suite_slice0(browser, args.url, vp, None)
                    else:
                        SERVE["app"] = make_build(cb, "served-" + vp)
                        srv = Server()
                        base = "http://127.0.0.1:%d%s" % (srv.port, BASE_PATH)
                        print("e2e suite=slice0 viewport=%s base=%s" % (vp, base), flush=True)
                        try:
                            suite_slice0(browser, base, vp, {"server": srv})
                        finally:
                            try:
                                srv.stop()
                            except Exception:
                                pass
            else:
                srv = Server()
                base = "http://127.0.0.1:%d%s" % (srv.port, BASE_PATH)
                print("e2e suite=%s base=%s" % (args.suite, base), flush=True)
                try:
                    (suite_update if args.suite == "update" else suite_twoapp)(browser, base, cb)
                finally:
                    srv.stop()
        except SystemExit:
            raise
        except Exception as e:
            check("suite ran to the end", False, repr(e)[:300])
        finally:
            browser.close()
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    print("e2e %s: %d of %d passed in %.1fs" % (args.suite, passed, len(RESULTS), time.time() - t0), flush=True)
    return 0 if RESULTS and passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
