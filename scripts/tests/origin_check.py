#!/usr/bin/env python3
"""Origin check, DESIGN 4.6 item (10) and 4.7 row 10. Run by run_all.sh live only.

    python3 scripts/tests/origin_check.py --url https://host/lift-log/ [--sibling /other-app/ ...] [--path2 /other-app/]
    python3 scripts/tests/origin_check.py --self-test

Loads the origin root, the Lift Log page and each sibling path. A page passes the strict
rule only if it answers 200 and carries a CSP meta whose default-src is 'self' or 'none'
and whose connect-src, img-src, script-src, style-src, font-src, media-src, frame-src,
worker-src, manifest-src, object-src and form-action are each no wider than 'self'
(after falling back to default-src where absent; form-action has no fallback, so it must
be present). Lift Log must pass the strict rule. A sibling named with --path2 is reported
as "path 2" and needs its manual line in the security log (4.7 row 10); any other
sibling must pass the strict rule. "Stores no secret" is a manual line, never a script.
--self-test serves good and bad pages on 127.0.0.1 and proves the check can fail.
Exit 0 = every page passed. Nothing here writes anywhere.
"""
import argparse
import http.server
import os
import re
import shutil
import sys
import tempfile
import threading
import urllib.parse
import urllib.request

DIRECTIVES = ["connect-src", "img-src", "script-src", "style-src", "font-src", "media-src",
              "frame-src", "worker-src", "manifest-src", "object-src", "form-action"]
NO_WIDER = ({"'self'"}, {"'none'"})
# The CSP text itself holds single quotes ('self'), so the closing quote must match the opening one.
META_RE = re.compile(r"""<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=(?:"([^"]*)"|'([^']*)')""", re.I)


def parse_csp(text):
    out = {}
    for part in text.split(";"):
        bits = part.strip().split()
        if bits:
            out.setdefault(bits[0].lower(), bits[1:])
    return out


def strict_reasons(status, html):
    """Every reason the page fails the strict rule; an empty list is a pass."""
    if status != 200:
        return ["answers %s, not 200" % status]
    m = META_RE.search(html)
    if not m:
        return ["no CSP meta"]
    csp = parse_csp(m.group(1) if m.group(1) is not None else m.group(2))
    why = []
    default = csp.get("default-src")
    if default is None or set(default) not in NO_WIDER:
        why.append("default-src is %s, not 'self' or 'none'" % (" ".join(default) if default else "missing"))
    for d in DIRECTIVES:
        vals = csp.get(d)
        if vals is None and d != "form-action":
            vals = default
        if vals is None:
            why.append("%s missing (it has no fallback)" % d)
        elif not vals or set(vals) - {"'self'", "'none'"} or ("'self'" in vals and "'none'" in vals):
            why.append("%s is %s, wider than 'self'" % (d, " ".join(vals) or "empty"))
    return why


def fetch(url):
    req = urllib.request.Request(url, headers={"Cache-Control": "no-cache"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:
        return type(e).__name__, ""


def run(app_url, siblings, path2):
    app_url = app_url if app_url.endswith("/") else app_url + "/"
    o = urllib.parse.urlparse(app_url)
    origin = o.scheme + "://" + o.netloc
    pages = [("origin root", origin + "/", "sibling"), ("Lift Log", app_url, "app")]
    pages += [("sibling " + s, origin + (s if s.startswith("/") else "/" + s), "path2" if s in path2 else "sibling") for s in siblings]
    fails = 0
    for name, url, kind in pages:
        status, html = fetch(url)
        why = strict_reasons(status, html)
        if not why:
            print("PASS  origin (10) %s: strict CSP | %s" % (name, url))
        elif kind == "path2":
            print("PATH2 origin (10) %s: not strict (%s); needs its path 2 line in the security log | %s" % (name, "; ".join(why[:3]), url))
        elif name == "origin root" and status == 404:
            print("PASS  origin (10) origin root: answers 404, serves no page | %s" % url)
        else:
            fails += 1
            print("FAIL  origin (10) %s: %s | %s" % (name, "; ".join(why[:4]), url))
    print("origin check: %d page(s), %d failing" % (len(pages), fails))
    return 1 if fails else 0


GOOD = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"


def page(csp):
    meta = '<meta http-equiv="Content-Security-Policy" content="%s">' % csp if csp is not None else ""
    return "<!doctype html><html><head><meta charset=\"utf-8\">%s<title>t</title></head><body>x</body></html>" % meta


def self_test():
    """Good and bad pages on a private local server. Each bad page must fail, the good one pass."""
    d = tempfile.mkdtemp(prefix="origin-check-")
    cases = {
        "good/": (page(GOOD), []),
        "nocsp/": (page(None), ["no CSP meta"]),
        "wide/": (page(GOOD.replace("connect-src 'self'", "connect-src *")), ["connect-src"]),
        "noform/": (page(GOOD.replace("; form-action 'none'", "")), ["form-action missing"]),
        "fallback/": (page("default-src *; form-action 'none'"), ["default-src"]),
        "inline/": (page(GOOD.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")), ["script-src"]),
    }
    open(os.path.join(d, "index.html"), "w").write(page(GOOD))   # the origin root
    for path, (html, _) in cases.items():
        os.makedirs(os.path.join(d, path), exist_ok=True)
        open(os.path.join(d, path, "index.html"), "w").write(html)

    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=d, **k)

        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d/" % srv.server_address[1]
    bad = 0
    try:
        for path, (_, want) in cases.items():
            status, html = fetch(base + path)
            why = strict_reasons(status, html)
            ok = (not why) if not want else all(any(w in r for r in why) for w in want)
            print("%s  self-test %s: %s" % ("PASS" if ok else "FAIL", path, "; ".join(why) or "strict"))
            bad += 0 if ok else 1
        # Our own shipped index.html passes the strict rule as it stands.
        os.makedirs(os.path.join(d, "ours"), exist_ok=True)
        shutil.copy2(os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "index.html"), os.path.join(d, "ours", "index.html"))
        status, html = fetch(base + "ours/")
        ok = not strict_reasons(status, html)
        print("%s  self-test ours/: the Lift Log index.html passes the strict rule" % ("PASS" if ok else "FAIL"))
        bad += 0 if ok else 1
        status, html = fetch(base + "missing/")
        ok = bool(strict_reasons(status, html))
        print("%s  self-test missing/: a page that is not 200 fails" % ("PASS" if ok else "FAIL"))
        bad += 0 if ok else 1
        # The real run on the local server: Lift Log good, one sibling strict, one sibling path 2.
        rc = run(base + "good/", ["/good/", "/nocsp/"], ["/nocsp/"])
        print("%s  self-test run(): good app, strict sibling, path 2 sibling exits 0" % ("PASS" if rc == 0 else "FAIL"))
        bad += 0 if rc == 0 else 1
        rc = run(base + "good/", ["/wide/"], [])
        print("%s  self-test run(): a wide sibling not on the path 2 list exits 1" % ("PASS" if rc == 1 else "FAIL"))
        bad += 0 if rc == 1 else 1
    finally:
        srv.shutdown()
        shutil.rmtree(d, ignore_errors=True)
    print("origin check self-test: %d fail(s)" % bad)
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url")
    ap.add_argument("--sibling", action="append", default=[])
    ap.add_argument("--path2", action="append", default=[])
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        return self_test()
    if not a.url:
        print("origin_check needs --url or --self-test")
        return 2
    return run(a.url, a.sibling, a.path2)


if __name__ == "__main__":
    sys.exit(main())
