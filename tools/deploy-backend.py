"""One-command backend deploy.

Builds backend/COMBINED.gs, pushes it to the Apps Script project via clasp,
and rolls EVERY web-app deployment the clients call to a new version — the
/exec URLs never change, so app/console configs stay valid.

Every endpoint, not just the one in .clasp.json: the app fails over between
two deployments, and rolling only one of them turns the failover path into a
downgrade path. Each is then verified by pinging it and demanding it report
the build fingerprint that was just pushed.

One-time prerequisites (see chat notes / RUNBOOK):
  1. Enable the Apps Script API for the district account:
     https://script.google.com/home/usersettings
  2. `clasp login` in a terminal, signing in as the district account.
  3. backend/clasp/.clasp.json containing:
       { "scriptId": "<from Project Settings>", "rootDir": ".",
         "deploymentId": "<the live web-app deployment id>" }
     (gitignored — script ids are never committed.)

Then every deploy is just:  python tools/deploy-backend.py
"""
import json
import re
import shutil
import subprocess
import sys
import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLASP_DIR = ROOT / "backend" / "clasp"
CFG = CLASP_DIR / ".clasp.json"


def run(cmd, cwd=None):
    print("+ " + cmd)
    r = subprocess.run(cmd, cwd=cwd or CLASP_DIR, shell=True)
    if r.returncode != 0:
        sys.exit(f"FAILED (exit {r.returncode}): {cmd}")


def target_deployments(dep_id):
    """Every deployment the clients actually call, in the order they call them.

    THE ONE IN .clasp.json IS NOT THE WHOLE ANSWER. The app fails over between
    two deployments of this project (api.js: Apps Script has served HTML error
    pages with sticky per-connection routing, seen 2026-08-19). Rolling only
    the one named here left the other on the previous version for a whole
    release on 2026-08-30 — it answered every request perfectly, with last
    week's code, and the failover path silently became a downgrade path.

    The client configs are the authority on what is reachable, so the ids come
    from them. They are gitignored, so a missing config is not an error; it
    just means there is nothing extra to roll.
    """
    ids = [dep_id]
    for rel in ("app/js/config.js", "console/js/config.js"):
        p = ROOT / rel
        if not p.exists():
            continue
        for m in re.finditer(r"macros/s/([A-Za-z0-9_\-]+)/exec", p.read_text(encoding="utf-8")):
            if m.group(1) not in ids:
                ids.append(m.group(1))
    return ids


def local_build():
    """The fingerprint stamped into COMBINED.gs by tools/build-combined.py."""
    m = re.search(r"const BACKEND_BUILD = '([a-f0-9]+)';",
                  (ROOT / "backend" / "COMBINED.gs").read_text(encoding="utf-8"))
    if not m:
        sys.exit("COMBINED.gs carries no BACKEND_BUILD — rebuild with tools/build-combined.py.")
    return m.group(1)


def main():
    if not CFG.exists():
        sys.exit("backend/clasp/.clasp.json missing — do the one-time clasp setup first.")
    cfg = json.loads(CFG.read_text())
    dep_id = cfg.get("deploymentId")
    if not cfg.get("scriptId"):
        sys.exit(".clasp.json has no scriptId.")
    if not dep_id:
        sys.exit(".clasp.json has no deploymentId — run `clasp list-deployments` and add it.")

    run(f'python "{ROOT / "tools" / "build-combined.py"}"', cwd=ROOT)
    shutil.copy(ROOT / "backend" / "COMBINED.gs", CLASP_DIR / "Code.gs")
    shutil.copy(ROOT / "backend" / "appsscript.json", CLASP_DIR / "appsscript.json")

    want = local_build()
    targets = target_deployments(dep_id)
    print(f"\nbuild {want} -> {len(targets)} deployment(s) the clients call")

    # One push, then roll every deployment onto it. clasp push updates the
    # project's source; a versioned deployment stays pinned until it is rolled,
    # which is exactly how one of them fell behind.
    run("clasp push -f")
    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    for i, dep in enumerate(targets, 1):
        print(f"\n--- deployment {i}/{len(targets)}  ...{dep[-12:]}")
        run(f'clasp deploy -i {dep} -d "auto-deploy {stamp}"')
    for i, dep in enumerate(targets, 1):
        print(f"\n--- verify {i}/{len(targets)}  ...{dep[-12:]}")
        verify(dep, want=want)
    print(f"\nDeployed and verified: {len(targets)} deployment(s) all serving build {want}.")
    print("The /exec URLs are unchanged; new code is live on every endpoint the app calls.")


def verify(dep_id, want=None, attempts=4):
    """Ping /exec and demand JSON carrying the build we just pushed.

    Two distinct failures, and only a real request finds either. A deployment
    can roll 'successfully' yet serve Google's 'Page not found' page (seen
    2026-08-19, took the whole district offline) — caught by demanding JSON.
    Or it can serve the API perfectly from an OLDER version, which is what
    happened on 2026-08-30 and which answering-JSON cannot detect at all —
    caught by demanding the fingerprint match.
    """
    import time
    import urllib.request
    url = f"https://script.google.com/macros/s/{dep_id}/exec"
    last = ""
    for i in range(attempts):
        if i:
            time.sleep(10)
        try:
            req = urllib.request.Request(
                url, data=b'{"action":"ping"}',
                headers={"Content-Type": "text/plain"})
            last = urllib.request.urlopen(req, timeout=30).read(300).decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001 - any failure just means retry
            last = f"<request failed: {e}>"
        if last.lstrip().startswith("{"):
            got = ""
            try:
                got = json.loads(last).get("build", "")
            except ValueError:
                pass
            if want is None or got == want:
                print(f"Verified: serving build {got or '(unstamped)'}")
                return
            # Apps Script can take a few seconds to route to the new version.
            print(f"verify attempt {i + 1}/{attempts}: serving build {got!r}, want {want!r}")
            continue
        print(f"verify attempt {i + 1}/{attempts}: not JSON yet: {last[:80]!r}")
    sys.exit(f"DEPLOY VERIFY FAILED for deployment ...{dep_id[-12:]}: it is not serving "
             f"build {want}. The app fails over to this endpoint, so leaving it behind "
             "means some requests silently get older code. Re-run this script; if it "
             "still fails, open Manage deployments in the Apps Script editor and roll "
             "it manually.")


if __name__ == "__main__":
    main()
