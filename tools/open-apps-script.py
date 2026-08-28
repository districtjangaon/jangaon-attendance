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

script.google.com selects the account by a /u/N/ path segment, where N is the
position in the browser session. ?authuser=<email> is NOT honoured there: it
falls through to Drive's file opener, which produces exactly that error.

The script ID is read from backend/clasp/.clasp.json, which is gitignored,
and is never printed - the browser is opened directly.
"""
import io
import json
import os
import sys
import webbrowser
import base64
import urllib.parse

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
        print('The project is owned by whichever of these clasp is actively using -')
        print('that is the one at the root of ~/.clasprc.json.')
        print('')
        print('Open the editor pinned to the account that OWNS the project:')
        for a in accounts:
            print('  python tools/open-apps-script.py ' + a)
        print('')
        print('Note: the owner is not necessarily the account clasp is logged in as.')
        print('clasp can push to any project you have edit rights on.')
        return

    arg = sys.argv[1].strip()
    if '@' in arg:
        # AccountChooser resolves the account by address and only then follows
        # `continue`, so the target opens in the right account whatever
        # position it happens to occupy in this browser.
        target = 'https://script.google.com/home/projects/' + script_id + '/edit'
        url = ('https://accounts.google.com/AccountChooser?Email=' +
               urllib.parse.quote(arg) + '&continue=' + urllib.parse.quote(target, safe=''))
        print('Opening the Apps Script editor as ' + arg + ' ...')
        print('')
        print('If Google asks which account, pick ' + arg + '.')
        print('Then, in that tab: Run > sendDailyAttendanceEmailTest, and accept')
        print('the permission dialog THERE. Never use the link in the execution log.')
        webbrowser.open(url)
        return
    if not arg.isdigit():
        print('script.google.com selects an account by position in the browser session,')
        print('not by address. ?authuser=<email> is not honoured there - it falls through')
        print('to Drive, which is where "unable to open the file" comes from.')
        print('')
        print('Pass the position instead, counting from 0 in the order the accounts were')
        print('added to this browser:')
        print('  python tools/open-apps-script.py 0')
        print('  python tools/open-apps-script.py 1')
        print('')
        print('Or take the route that never needs the position at all:')
        print('  1. open https://script.google.com/home')
        print('  2. click the avatar, top right, and pick the owning account')
        print('  3. the project is in the list - open it from there')
        return

    url = 'https://script.google.com/u/' + arg + '/home/projects/' + script_id + '/edit'
    print('Opening the Apps Script editor as account position ' + arg + ' ...')
    print('')
    print('If it shows "unable to open the file", that position is a different')
    print('account - run this again with the next number.')
    print('If the project opens, accept any consent screen IN THAT TAB. Never use')
    print('the link from the execution log: it carries no account and misroutes.')
    webbrowser.open(url)


if __name__ == '__main__':
    main()
