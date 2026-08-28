# -*- coding: utf-8 -*-
"""Open the Apps Script editor pinned to a named Google account.

    python tools/open-apps-script.py                       # list the accounts clasp knows
    python tools/open-apps-script.py jangaoncdm@gmail.com  # open the editor as that account

Why this exists: several Google accounts are signed in to the same browser.
Apps Script's own links - including the "Click here to provide permissions"
link in an execution error - carry no account hint, so Chrome routes them to
whichever account happens to be first in the session. When that is not the
account that owns the project, Google cannot resolve the URL and shows
"Sorry, unable to open the file at present".

Adding ?authuser=<email> pins the request to one account and the consent
screen then appears against the right one.

The script ID is read from backend/clasp/.clasp.json, which is gitignored,
and is never printed - the browser is opened directly.
"""
import io
import json
import os
import sys
import webbrowser
import base64

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, 'backend', 'clasp', '.clasp.json')


def known_accounts():
    """Emails clasp has credentials for. Tokens are never read or printed."""
    out = []
    p = os.path.expanduser('~/.clasprc.json')
    if not os.path.exists(p):
        return out

    def walk(o, depth=0):
        if depth > 5 or not isinstance(o, dict):
            return
        for k, v in o.items():
            if k == 'id_token' and isinstance(v, str) and v.count('.') == 2:
                mid = v.split('.')[1]
                mid += '=' * (-len(mid) % 4)
                try:
                    email = json.loads(base64.urlsafe_b64decode(mid)).get('email')
                    if email and email not in out:
                        out.append(email)
                except Exception:
                    pass
            walk(v, depth + 1)

    try:
        walk(json.load(io.open(p, encoding='utf-8')))
    except Exception:
        pass
    return out


def main():
    if not os.path.exists(CFG):
        sys.exit('backend/clasp/.clasp.json missing - do the one-time clasp setup first.')
    script_id = json.load(io.open(CFG, encoding='utf-8')).get('scriptId', '')
    if not script_id:
        sys.exit('No scriptId in backend/clasp/.clasp.json.')

    accounts = known_accounts()
    if len(sys.argv) < 2:
        print('Accounts clasp has credentials for:')
        for a in accounts:
            print('  ' + a)
        print('')
        print('Open the editor pinned to one of them:')
        print('  python tools/open-apps-script.py ' + (accounts[0] if accounts else 'you@example.com'))
        print('')
        print('Use the account that OWNS the Apps Script project. If you are not sure,')
        print('try each: the wrong one shows "unable to open the file".')
        return

    email = sys.argv[1].strip()
    url = ('https://script.google.com/home/projects/' + script_id +
           '/edit?authuser=' + email)
    print('Opening the Apps Script editor as ' + email + ' ...')
    print('If a consent screen appears, accept it in THIS window - do not use the')
    print('link from the execution log, which carries no account and will misroute.')
    webbrowser.open(url)


if __name__ == '__main__':
    main()
