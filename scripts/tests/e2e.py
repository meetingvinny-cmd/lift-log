#!/usr/bin/env python3
"""Headless end to end checks for Lift Log, in a private headless Chromium (DESIGN 4.6).

    python3 scripts/tests/e2e.py --suite slice0 [--viewport 440|375|both]   local server
    python3 scripts/tests/e2e.py --suite update                             update tests, local only
    python3 scripts/tests/e2e.py --suite twoapp                             needs LIFTLOG_AT_DIR
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


def new_context(browser, audit, standalone, vp="440", extra=()):
    v = VIEWPORTS[vp]
    ctx = browser.new_context(
        viewport={"width": v["width"], "height": v["height"]}, device_scale_factor=v["scale"], is_mobile=True,
        has_touch=True, user_agent=UA, service_workers="allow")
    if standalone:
        ctx.add_init_script(STANDALONE)
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
        check(tag + "(1) tab: top link reads < Back and goes to Install",
              back.inner_text().strip() == "< Back" and back.get_attribute("href") == "#/install")
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
        check(tag + "(2) icon: Block and History show their empty states",
              page.locator(".empty h2").inner_text().strip() == "Coming next")
        page.click("a.tab[href='#/settings']")
        page.wait_for_selector("#settings")
        check(tag + "(2) icon: settings shows version " + APP_VERSION, page.inner_text("[data-fact='version'] .val") == APP_VERSION)
        check(tag + "(2) icon: settings shows rules 'none yet'", page.inner_text("[data-fact='rules'] .val") == "none yet")
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
                page.click("#setup-build")
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


def leave_day_done(page):
    try:
        settle(page, 200)
        if page.locator("#done-go").count():
            page.click("#done-go")
        page.wait_for_selector("#today > *", timeout=10000)
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
    page.click("#setup-build")
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
    if fixed:
        if text.count(old) != 1:
            raise RuntimeError("the other app's cache filter line was not found once")
        text = text.replace(old, "keys.filter(k => k.startsWith('artic-') && k !== CACHE)")
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
        for route, sel, name in (("#/block", ".empty", "block tab"), ("#/history", ".empty", "history tab")):
            go_route(page, route, sel)
            check(tag + "offline: the " + name + " shows Coming next", page.inner_text(".empty h2").strip() == "Coming next")
            layout(page, tag, name)
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
        check(tag + "polish: C27 a finished block shows Block finished with Build and Load",
              page.locator("#block-done").count() == 1 and page.locator("#block-done #build-block").count() == 1 and page.locator("#block-done #load-block").count() == 1,
              page.inner_text("#today")[:120])
        ctx.close()

        # C32 and C41: builder reorder and start weight steps (PD18, PD20).
        ctx, page = new()
        page.click("#unit-lb")
        page.click("#setup-build") if page.locator("#setup-build").count() else None
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
        page.click("#setup-build") if page.locator("#setup-build").count() else None
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
        page.click("#setup-build") if page.locator("#setup-build").count() else None
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
        page.click("#build-block")
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
        page.click("#setup-build")
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
        page.click("#setup-build")
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
        page.click("#setup-build")
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
        page.click("#setup-build")
        page.wait_for_selector("#builder[data-step='1']")
        page.fill("#block-name", "Kept draft")
        page.click("#builder-cancel")
        page.wait_for_selector("#build-block")
        page.click("#build-block")
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
            page.click("#build-block")
            page.wait_for_selector("#draft-sheet")
            page.click("#draft-over")
            page.wait_for_selector("#builder[data-step='1']")
            fresh = page.input_value("#block-name") == ""
            page.click("#builder-cancel")
            page.wait_for_selector("#build-block")
            page.click("#build-block")
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
        page.click("#setup-build")
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
        page.click("#setup-build")
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
        page.click("#setup-build")
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
        page.wait_for_selector("#block-done")
        check(tag + "polish: Skip day on the last day of a 1-round block shows the Block finished choices (Part 15)",
              page.locator("#block-done #build-block").count() == 1 and page.locator("#block-done #load-block").count() == 1)
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
              warm_inset and under_s1 and offered and all(w["status"] == "skipped" and w["why"] == "Stopped by a block check" for w in whys),
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
              again and w3["status"] == "skipped" and w3["why"] == "Stopped by a block check", {"again": again, "set 3": (w3["status"], w3["why"])})
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
    ap.add_argument("--suite", choices=["slice0", "slice1", "update", "twoapp"], default="slice0")
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
