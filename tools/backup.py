# -*- coding: utf-8 -*-
"""Take a restorable backup of the attendance system.

    python tools/backup.py

Writes to  C:/Users/<you>/attendance-backups/attendance-<timestamp>/

Three pieces, because they fail in different ways:

  repo.bundle       a complete git bundle - every branch, every commit, the
                    whole history in one file. Restore with:
                        git clone repo.bundle attendance
                    This alone rebuilds the codebase, but it holds nothing
                    that git ignores.

  local-only.zip    the files git deliberately does not track: the deployment
                    configuration, the clasp project pointer, the district
                    master data, and the generated reports. Without these a
                    restored clone runs but is not connected to anything.

  MANIFEST.txt      what was taken, from which commit, and how to put it back.

Deliberately NOT included: the Apps Script project itself and the Google
Sheets, which live in Google's account and are outside this machine. The
manifest says so rather than implying the backup is complete.
"""
import datetime
import io
import os
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STAMP = datetime.datetime.now().strftime('%Y%m%d-%H%M')
DEST = os.path.join(os.path.expanduser('~'), 'attendance-backups', 'attendance-' + STAMP)

# Ignored by git, but the system does not work without them.
LOCAL_ONLY = [
    'app/js/config.js',
    'console/js/config.js',
    'backend/clasp/.clasp.json',
    'backend/clasp/appsscript.json',
    'master-data',
    'docs/report',
    'analysis',
    'evidence',
    'report',
]


def run(cmd, **kw):
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, shell=True, **kw)


def main():
    os.makedirs(DEST, exist_ok=True)

    # ---------------------------------------------------------- git bundle
    bundle = os.path.join(DEST, 'repo.bundle')
    r = run('git bundle create "%s" --all' % bundle)
    if r.returncode != 0:
        sys.exit('git bundle failed:\n' + r.stderr)
    verify = run('git bundle verify "%s"' % bundle)

    head = run('git rev-parse HEAD').stdout.strip()
    subject = run('git log -1 --format=%s').stdout.strip()
    branch = run('git rev-parse --abbrev-ref HEAD').stdout.strip()
    dirty = run('git status --porcelain --untracked-files=no').stdout.strip()

    # -------------------------------------------------------- local-only zip
    zpath = os.path.join(DEST, 'local-only.zip')
    added, missing = [], []
    with zipfile.ZipFile(zpath, 'w', zipfile.ZIP_DEFLATED) as z:
        for rel in LOCAL_ONLY:
            full = os.path.join(ROOT, rel)
            if not os.path.exists(full):
                missing.append(rel)
                continue
            if os.path.isfile(full):
                z.write(full, rel)
                added.append(rel)
                continue
            n = 0
            for base, _dirs, files in os.walk(full):
                for f in files:
                    p = os.path.join(base, f)
                    z.write(p, os.path.relpath(p, ROOT).replace('\\', '/'))
                    n += 1
            added.append('%s  (%d files)' % (rel, n))

    # ------------------------------------------------------------ manifest
    lines = [
        'Attendance system backup',
        '=' * 60,
        'Taken            ' + datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'Machine          ' + os.environ.get('COMPUTERNAME', '?'),
        'Source           ' + ROOT,
        '',
        'GIT',
        '  branch         ' + branch,
        '  commit         ' + head,
        '  subject        ' + subject,
        '  uncommitted    ' + ('none' if not dirty else dirty.replace('\n', '; ')),
        '  bundle check   ' + (verify.stderr.strip().splitlines()[-1]
                               if verify.stderr.strip() else 'ok'),
        '',
        'LOCAL-ONLY FILES (git ignores these; the system needs them)',
    ]
    lines += ['  + ' + a for a in added]
    if missing:
        lines += ['  - not present: ' + m for m in missing]
    lines += [
        '',
        'RESTORE',
        '  1. git clone repo.bundle attendance',
        '  2. cd attendance && git checkout ' + branch,
        '  3. unzip local-only.zip into the working copy, keeping paths',
        '  4. python tools/build-combined.py     (rebuild backend/COMBINED.gs)',
        '  5. python tools/deploy-backend.py     (needs clasp login)',
        '',
        'NOT IN THIS BACKUP',
        '  The Apps Script project and the Google Sheets live in the Google',
        '  account, not on this machine. backend/*.gs here is the source of',
        '  truth for the code, but the attendance rows, the leave register,',
        '  the user master and the attendance photographs are in Drive and',
        '  are not copied by this script. Those need a separate export from',
        '  the owning account (district.jana@gmail.com).',
        '',
        'HANDLE AS CONFIDENTIAL',
        '  local-only.zip carries the deployment URL, the Apps Script project',
        '  id, the district user master with real names and phone numbers,',
        '  and the per-worker location analysis. Keep it off any public or',
        '  shared location.',
    ]
    io.open(os.path.join(DEST, 'MANIFEST.txt'), 'w', encoding='utf-8').write('\n'.join(lines) + '\n')

    size = sum(os.path.getsize(os.path.join(DEST, f)) for f in os.listdir(DEST))
    print('Backup: ' + DEST)
    for f in sorted(os.listdir(DEST)):
        print('  %-16s %8.1f MB' % (f, os.path.getsize(os.path.join(DEST, f)) / 1048576))
    print('  total            %8.1f MB' % (size / 1048576))
    print('')
    print('commit ' + head[:12] + '  ' + subject)
    print('uncommitted changes: ' + ('none' if not dirty else 'YES - see MANIFEST.txt'))


if __name__ == '__main__':
    main()
