# -*- coding: utf-8 -*-
"""Stamp a new build tag on the app, the console, and the app's service worker.

Why this exists: the service worker serves the app shell cache-first, and the
browser only re-installs it when the BYTES of app/sw.js change. Between
2026-08-22 and 2026-08-25 three app builds shipped without sw.js changing, so
every phone kept serving the old shell out of cache - there was no update for
it to find. The cache name and the build tag are now stamped together, by one
command, so the two cannot drift again.

Usage:
    python tools/bump-build.py --app 5.20 --console 4.21
    python tools/bump-build.py --app 5.20            # console left alone
    python tools/bump-build.py --console 4.21        # console-only change

Bumping the app version ALWAYS renames the service-worker cache: that rename
is what makes phones pick the build up.
"""
import argparse, io, os, re, sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_HTML = os.path.join(ROOT, 'app', 'index.html')
CON_HTML = os.path.join(ROOT, 'console', 'index.html')
SW = os.path.join(ROOT, 'app', 'sw.js')

TAG_RE = re.compile(r'BUILD: v(\d+\.\d+)-(\d{8}-\d{4})')
CACHE_RE = re.compile(r"const CACHE = '([^']+)';")


def read(p):
    return io.open(p, encoding='utf-8').read()


def write(p, s):
    io.open(p, 'w', encoding='utf-8').write(s)


def one(pattern, text, what):
    hits = pattern.findall(text)
    if len(hits) != 1:
        sys.exit('ANCHOR FAIL (%d matches): %s' % (len(hits), what))
    return hits[0]


def stamp_tag(path, version, when, label):
    s = read(path)
    old = one(TAG_RE, s, label + ' build tag')
    new = 'BUILD: v%s-%s' % (version, when)
    write(path, TAG_RE.sub(new, s))
    return 'v%s-%s' % (old[0], old[1]), new.replace('BUILD: ', '')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--app', help='new app version, e.g. 5.20')
    ap.add_argument('--console', help='new console version, e.g. 4.21')
    a = ap.parse_args()
    if not a.app and not a.console:
        sys.exit('nothing to do: pass --app and/or --console')

    when = datetime.now().strftime('%Y%m%d-%H%M')

    if a.app:
        old, new = stamp_tag(APP_HTML, a.app, when, 'app')
        print('app      %s -> %s' % (old, new))
        # The cache name IS the build tag. A build that forgets to rename it
        # cannot reach a phone that already has the old one.
        s = read(SW)
        old_cache = one(CACHE_RE, s, 'service-worker cache name')
        new_cache = 'attendance-' + new
        write(SW, CACHE_RE.sub("const CACHE = '%s';" % new_cache, s))
        print('sw cache %s -> %s' % (old_cache, new_cache))

    if a.console:
        old, new = stamp_tag(CON_HTML, a.console, when, 'console')
        print('console  %s -> %s' % (old, new))

    print('\nNow run: node tools/test-build.js')


if __name__ == '__main__':
    main()
