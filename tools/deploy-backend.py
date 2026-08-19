"""One-command backend deploy.

Builds backend/COMBINED.gs, pushes it to the Apps Script project via clasp,
and rolls the existing web-app deployment to a new version — the /exec URL
never changes, so app/console configs stay valid.

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

    run("clasp push -f")
    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    run(f'clasp deploy -i {dep_id} -d "auto-deploy {stamp}"')
    verify(dep_id)
    print("\nDeployed and verified. The web-app URL is unchanged; new code is live now.")


def verify(dep_id, attempts=4):
    """POST a probe to /exec and demand a JSON answer. A deployment can roll
    'successfully' yet serve Google's 'Page not found' page (seen 2026-08-19,
    took the whole district offline) — clasp cannot detect that, only an
    actual request can."""
    import time
    import urllib.request
    url = f"https://script.google.com/macros/s/{dep_id}/exec"
    last = ""
    for i in range(attempts):
        if i:
            time.sleep(10)
        try:
            req = urllib.request.Request(
                url, data=b'{"action":"deploy-verify"}',
                headers={"Content-Type": "text/plain"})
            last = urllib.request.urlopen(req, timeout=30).read(300).decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001 - any failure just means retry
            last = f"<request failed: {e}>"
        if last.lstrip().startswith("{"):
            print(f"Verified: /exec answers JSON: {last[:80]}")
            return
        print(f"verify attempt {i + 1}/{attempts}: not JSON yet: {last[:80]!r}")
    sys.exit("DEPLOY VERIFY FAILED: /exec is NOT serving the API (users cannot "
             "log in). Re-run this script; if it still fails, open Manage "
             f"deployments in the Apps Script editor and roll deployment {dep_id} manually.")


if __name__ == "__main__":
    main()
