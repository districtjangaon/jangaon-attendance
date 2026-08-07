# Test plan

## 1. Functional matrix (manual, before pilot)

Run on one real low-end Android (2 GB RAM class) in Chrome.

| # | Scenario | Expected |
|---|---|---|
| F1 | First login, unique phone | PIN-set screen with privacy note → home shows name + AWC |
| F2 | First login, shared centre phone | Name picker (teacher/helper) → each sets own PIN independently |
| F3 | Wrong PIN ×5 | Locked 15 min message; correct PIN before 5th still works |
| F4 | Mark IN online | 2 taps; full-screen green confirmation; row in Marks sheet; INSIDE if at centre |
| F5 | Mark IN in airplane mode | "saved on phone" state; queue counter 1; **survives app kill and phone restart**; syncs exactly once when back online |
| F6 | Double-tap / repeat sync | one row only (key is deterministic) — verify in sheet |
| F7 | GPS off | mark accepted, geofence UNVERIFIED, appears in Exceptions |
| F8 | Camera denied | mark accepted, NO_PHOTO flag, appears in Exceptions |
| F9 | Both users mark on one phone, offline, then sync | both rows land under the correct user_ids |
| F10 | Logout user A with A's marks queued | warning; B unaffected; A's marks sync after A re-login |
| F11 | Login on second phone | DEVICE_MISMATCH; after supervisor unbind, new phone binds |
| F12 | Console supervisor login | sees only own sector in Today/Monthly/Users; another sector's user id in a photo URL → FORBIDDEN |
| F13 | Exception Accept/Reject | Corrections row appended (original Marks row untouched); shows after next summary run |
| F14 | Old month archive | previous month's sector JSON loads under Monthly after the 1st |
| F15 | Staleness banner | stop the `summaryTick` trigger → banner goes orange then red; restart → green |
| F16 | AWC with blanked coords | marks UNVERIFIED (never falsely OUTSIDE); after console GPS capture → INSIDE |

## 2. Load test (before pilot AND before Phase 3)

Tooling: `tools/load-sim/load_sim.py` (Python stdlib, no installs).

```
cd tools/load-sim
python load_sim.py seed  --n 400        # paste SEED_IMPORT_*.csv rows into the IMPORT_ tabs, run importFromSheets()
python load_sim.py login --endpoint https://script.google.com/.../exec --n 400
python load_sim.py fire  --endpoint https://script.google.com/.../exec
python load_sim.py fire  --endpoint https://script.google.com/.../exec   # second run = idempotency proof
```

**Pass:**
- Run 1: `OK == 400`, `dropped == 0`
- Run 2 (same keys): `DUP == 400`, `OK == 0` — zero duplicate rows created
- Sheet check: exactly 400 new Marks rows, all key-unique
- p95 end-to-end (with retries) ≤ 120 s; `BUSY` retries are expected and fine
- During the run, a manual mark from a real phone still goes through

Afterwards: deactivate the `U9xxx` users (console) — their sector `S99` keeps
test rows out of real reports either way.

## 3. Pre-go-live checklist

- [ ] `/app` and `/console` load with **zero console errors** on a cold cache
- [ ] Service worker registered; offline reload works
- [ ] F5 (airplane-mode exactly-once) re-verified on the production URL
- [ ] `ISSUES.md` reviewed by the district office; supervisors filled in
- [ ] Photo reaper ran at least once (check AttendancePhotos has ≤45 day-folders)
- [ ] GitHub token expiry reminder in someone's calendar
- [ ] Backup download of ATTENDANCE_MASTER taken
