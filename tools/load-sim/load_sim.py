#!/usr/bin/env python3
"""
load_sim.py — fires N concurrent synthetic attendance marks at the deployed
Apps Script backend so the real ceiling is measured BEFORE go-live.
Python stdlib only; no dependencies.

Three subcommands, run in order:

1) seed   — writes seed CSVs (test project/sector/AWC + N test users) to paste
            into the IMPORT_* tabs of ATTENDANCE_MASTER alongside the real
            data, then run importFromSheets() once.
                python load_sim.py seed --n 400

2) login  — logs every test user in (first login sets PIN 1234), saves tokens
            to tokens.json. One-time; tokens last 30 days.
                python load_sim.py login --endpoint https://script.google.com/.../exec --n 400

3) fire   — the actual test: N concurrent sync POSTs (1 IN mark each, today),
            client-faithful behaviour (BUSY -> exponential backoff + jitter,
            up to --retries). Prints OK/DUP/REJECTED/errors and latency
            percentiles. Run it twice: the second run must be 100% DUP —
            that is the idempotency proof.
                python load_sim.py fire --endpoint https://.../exec

Pass criteria (also in docs/TEST-PLAN.md):
  - dropped = 0 and (first run) OK = N
  - second identical run: DUP = N, OK = 0  (zero duplicates created)
  - p95 end-to-end latency (including retries) under 120 s

Cleanup: deactivate the U9xxx test users from the console (or delete their
rows in Users) and delete the LOADTEST sector rows in the month sheet if you
want pristine reports. Test marks are all in sector S99 so they are easy to
filter out.
"""
import argparse
import concurrent.futures
import csv
import json
import random
import sys
import time
import urllib.request
from datetime import datetime, timezone, timedelta

IST = timezone(timedelta(hours=5, minutes=30))
TEST_PIN = '1234'
TOKENS_FILE = 'tokens.json'

# Test org unit — obviously synthetic, easy to filter out of reports.
SEED_PROJECT = ('TST', 'Load Test Project')
SEED_SECTOR = ('S99', 'TST', 'Load Test Sector', '')
SEED_AWC = ('A9999', 'S99', 'TST', 'Load Test AWC', 17.72, 79.15, 200)


def test_users(n):
    for i in range(1, n + 1):
        uid = 'U9%03d' % i
        phone = '96%08d' % i
        yield uid, phone


def post(endpoint, body, timeout=90):
    data = json.dumps(body).encode()
    req = urllib.request.Request(endpoint, data=data,
                                 headers={'Content-Type': 'text/plain;charset=utf-8'})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode())


def cmd_seed(args):
    with open('SEED_IMPORT_PROJECTS.csv', 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.writer(f)
        w.writerow(['project_code', 'name'])
        w.writerow(SEED_PROJECT)
    with open('SEED_IMPORT_SECTORS.csv', 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.writer(f)
        w.writerow(['sector_code', 'project_code', 'name', 'supervisor_phone'])
        w.writerow(SEED_SECTOR)
    with open('SEED_IMPORT_AWCS.csv', 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.writer(f)
        w.writerow(['awc_id', 'sector_code', 'project_code', 'name', 'lat', 'lng', 'radius_m'])
        w.writerow(SEED_AWC)
    with open('SEED_IMPORT_USERS.csv', 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.writer(f)
        w.writerow(['user_id', 'phone', 'name', 'cadre', 'role', 'project_code', 'sector_code', 'awc_id'])
        for uid, phone in test_users(args.n):
            w.writerow([uid, phone, 'Load Test ' + uid, 'AWT', 'FIELD', 'TST', 'S99', 'A9999'])
    print(f'Wrote SEED_IMPORT_*.csv for {args.n} users.')
    print('APPEND these rows to the corresponding IMPORT_* tabs in ATTENDANCE_MASTER')
    print('(keep the real rows), run importFromSheets(), then run: load_sim.py login')


def login_one(endpoint, uid, phone):
    dev = 'loadsim-' + uid
    # First attempt: normal PIN login; on SET_PIN_REQUIRED set the test PIN.
    r = post(endpoint, {'action': 'login', 'phone': phone, 'userId': uid,
                        'pin': TEST_PIN, 'deviceId': dev})
    if not r.get('ok') and r.get('code') in ('SET_PIN_REQUIRED', 'PIN_REQUIRED'):
        r = post(endpoint, {'action': 'login', 'phone': phone, 'userId': uid,
                            'newPin': TEST_PIN, 'deviceId': dev})
    if r.get('ok'):
        return uid, r['token']
    return uid, None


def cmd_login(args):
    tokens = {}
    failed = []
    # Modest parallelism: login is CPU-heavy server-side (4000-iteration hash);
    # this is setup, not the load test itself.
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
        futs = {ex.submit(login_one, args.endpoint, uid, phone): uid
                for uid, phone in test_users(args.n)}
        for fut in concurrent.futures.as_completed(futs):
            uid, tok = fut.result()
            if tok:
                tokens[uid] = tok
            else:
                failed.append(uid)
            done = len(tokens) + len(failed)
            if done % 50 == 0:
                print(f'  {done}/{args.n} logins…')
    with open(TOKENS_FILE, 'w') as f:
        json.dump(tokens, f)
    print(f'{len(tokens)} tokens saved to {TOKENS_FILE}; {len(failed)} failed'
          + (': ' + ', '.join(failed[:10]) if failed else ''))


def fire_one(endpoint, uid, token, mark_type, retries):
    day = datetime.now(IST).strftime('%Y%m%d')
    key = f'{uid}_{day}_{mark_type}'
    now = datetime.now(IST)
    rec = {
        'key': key,
        'clientTs': now.strftime('%Y-%m-%dT%H:%M:%S+05:30'),
        'lat': SEED_AWC[4] + random.uniform(-0.0008, 0.0008),
        'lng': SEED_AWC[5] + random.uniform(-0.0008, 0.0008),
        'accuracy': random.randint(8, 60),
        'deviceId': 'loadsim-' + uid,
        'appVersion': 'loadsim-1.0',
        'netState': 'ONLINE',
        'photoB64': ''
    }
    t0 = time.time()
    attempts = 0
    while True:
        attempts += 1
        try:
            r = post(endpoint, {'action': 'sync', 'token': token,
                                'deviceNow': int(time.time() * 1000), 'records': [rec]})
        except Exception as e:
            r = {'ok': False, 'code': 'NET:' + type(e).__name__}
        if r.get('ok'):
            status = (r.get('acks') or [{}])[0].get('status', 'NO_ACK')
            return {'uid': uid, 'status': status, 'attempts': attempts, 'sec': time.time() - t0}
        if r.get('code') == 'BUSY' or str(r.get('code', '')).startswith('NET:'):
            if attempts > retries:
                return {'uid': uid, 'status': 'DROPPED(' + str(r.get('code')) + ')',
                        'attempts': attempts, 'sec': time.time() - t0}
            # Same policy as the real client: exponential backoff + jitter,
            # scaled down (cap 20 s) so the test finishes in minutes.
            time.sleep(min(20, 2 ** attempts) + random.uniform(0, 3))
            continue
        return {'uid': uid, 'status': str(r.get('code')), 'attempts': attempts, 'sec': time.time() - t0}


def cmd_fire(args):
    tokens = json.load(open(TOKENS_FILE))
    if not tokens:
        sys.exit('No tokens — run login first.')
    items = list(tokens.items())[:args.n]
    print(f'Firing {len(items)} concurrent "{args.type}" marks at {args.endpoint}')
    t0 = time.time()
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(items)) as ex:
        futs = [ex.submit(fire_one, args.endpoint, uid, tok, args.type, args.retries)
                for uid, tok in items]
        for fut in concurrent.futures.as_completed(futs):
            results.append(fut.result())
            if len(results) % 50 == 0:
                print(f'  {len(results)}/{len(items)} done…')
    wall = time.time() - t0

    counts = {}
    for r in results:
        counts[r['status']] = counts.get(r['status'], 0) + 1
    lat = sorted(r['sec'] for r in results)
    pct = lambda p: lat[min(len(lat) - 1, int(p / 100 * len(lat)))]
    retried = sum(1 for r in results if r['attempts'] > 1)

    print('\n===== RESULT =====')
    print('wall clock         : %.1f s' % wall)
    for k in sorted(counts):
        print('%-19s: %d' % (k, counts[k]))
    print('needed retries     : %d' % retried)
    print('latency p50/p95/max: %.1f / %.1f / %.1f s' % (pct(50), pct(95), lat[-1]))
    dropped = sum(v for k, v in counts.items() if k.startswith('DROPPED'))
    ok = counts.get('OK', 0)
    dup = counts.get('DUP', 0)
    print('\nPASS conditions: dropped==0 (got %d); OK+DUP==%d (got %d)' %
          (dropped, len(items), ok + dup))
    print('Run fire again now: second run must be 100%% DUP — idempotency proof.')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('seed'); s.add_argument('--n', type=int, default=400)
    l = sub.add_parser('login')
    l.add_argument('--endpoint', required=True); l.add_argument('--n', type=int, default=400)
    f = sub.add_parser('fire')
    f.add_argument('--endpoint', required=True)
    f.add_argument('--n', type=int, default=400)
    f.add_argument('--type', choices=['IN', 'OUT'], default='IN')
    f.add_argument('--retries', type=int, default=8)
    args = ap.parse_args()
    {'seed': cmd_seed, 'login': cmd_login, 'fire': cmd_fire}[args.cmd](args)


if __name__ == '__main__':
    main()
