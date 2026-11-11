#!/usr/bin/env python3
"""Checks that the live copy matches the last commit, file for file.

    python3 scripts/tests/live_check.py --url https://example.invalid/app/ [--wait 600] [--every 30]

For every SHELL entry in sw.js at HEAD: fetch it from the live address and
compare its sha256 with `git show HEAD:<file>`. Also checks the live APP_VERSION.
Polls until all match or the wait runs out (hosting can take minutes to catch up).
Exit 0 = every file matches.
"""
import argparse
import hashlib
import json
import re
import subprocess
import sys
import time
import urllib.request
import os

APP_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def head(path):
    return subprocess.run(["git", "-C", APP_DIR, "show", "HEAD:" + path], capture_output=True, check=True).stdout


def fetch(url):
    req = urllib.request.Request(url, headers={"Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.status, r.read()


def one_pass(base, shell, version):
    bad = []
    for entry in shell:
        path = "index.html" if entry == "./" else entry
        url = base + ("" if entry == "./" else entry) + "?v=" + str(int(time.time()))
        try:
            status, body = fetch(url)
        except Exception as e:
            bad.append("%s: %s" % (entry, type(e).__name__))
            continue
        want = hashlib.sha256(head(path)).hexdigest()
        got = hashlib.sha256(body).hexdigest()
        if status != 200 or want != got:
            bad.append("%s: status %s, sha %s want %s" % (entry, status, got[:12], want[:12]))
    try:
        _, body = fetch(base + "version.js?v=" + str(int(time.time())))
        live_v = re.search(rb"APP_VERSION = '([^']+)'", body)
        if not live_v or live_v.group(1).decode() != version:
            bad.append("APP_VERSION live %s want %s" % (live_v.group(1).decode() if live_v else None, version))
    except Exception as e:
        bad.append("version.js: %s" % type(e).__name__)
    return bad


def record(version, sw):
    """Append the pushed {version, hash} to shell_versions.json (DESIGN 4.4), once."""
    m = re.search(r"^const SHELL_HASH = '([0-9a-f]{64})';$", sw, re.M)
    if not m:
        print("FAIL live_check: no SHELL_HASH line in sw.js at HEAD")
        return
    path = os.path.join(APP_DIR, "scripts", "tests", "shell_versions.json")
    rows = json.load(open(path))
    if not any(r.get("version") == version and r.get("hash") == m.group(1) for r in rows):
        rows.append({"version": version, "hash": m.group(1)})
        with open(path, "w") as f:
            json.dump(rows, f, indent=1)
            f.write("\n")
        print("live_check: recorded %s in shell_versions.json (commit it)" % version)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--wait", type=int, default=600)
    ap.add_argument("--every", type=int, default=30)
    a = ap.parse_args()
    base = a.url if a.url.endswith("/") else a.url + "/"
    sw = head("sw.js").decode()
    shell = re.findall(r"'([^']+)'", re.search(r"const SHELL = \[([\s\S]*?)\];", sw).group(1))
    version = re.search(r"APP_VERSION = '([^']+)'", head("version.js").decode()).group(1)
    deadline = time.time() + a.wait
    n = 0
    while True:
        n += 1
        bad = one_pass(base, shell, version)
        if not bad:
            print("PASS live_check: %d of %d files match HEAD, version %s (pass %d)" % (len(shell), len(shell), version, n))
            record(version, sw)
            return 0
        print("pass %d: %d mismatch(es): %s" % (n, len(bad), "; ".join(bad[:4])), flush=True)
        if time.time() + a.every > deadline:
            print("FAIL live_check: still %d mismatch(es) after %ds" % (len(bad), a.wait))
            return 1
        time.sleep(a.every)


if __name__ == "__main__":
    sys.exit(main())
