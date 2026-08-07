# Backend — Google Apps Script web app

Complete, runnable server code for the field attendance system. Copy each `.gs`
file into an Apps Script project (or push with `clasp`), set the manifest from
`appsscript.json`, run `setupAll()`, and deploy as a web app. The full
step-by-step (including GitHub token creation) is in the deployment runbook
(Deliverable 8).

## Org model (Jangaon district AWC data)

District → Project (`JGN`/`KDK`/`SGN`) → Sector (27) → AWC (695). Field users
are `AWT`/`AWH` tied to one AWC; supervisors own a sector; CDPOs own a project.
**Phone numbers are NOT unique** — at ~190 of 695 AWCs the AWT and AWH share
the centre's phone, so identity is `user_id`, login resolves a phone to a
candidate list (`CHOOSE_USER`), and all admin actions target `user_id`, never
phone. Master data comes from `tools/import-awc.py` output pasted into
`IMPORT_*` tabs and loaded by `importFromSheets()` (idempotent; never touches
PINs/devices of existing users), then `publishOrg()`.

## Files

| File | Contents |
|---|---|
| `appsscript.json` | Manifest: IST timezone, V8, web app (execute as owner, anyone anonymous), Drive advanced service (hard-delete for the photo reaper) |
| `Main.gs` | `doPost`/`doGet` routing. All POSTs are JSON in a `text/plain` body — a CORS "simple request", so the browser never sends a preflight (Apps Script can't answer `OPTIONS`). Token travels in the body, never a header. |
| `Auth.gs` | Login, first-login PIN set, lockout (5 fails → 15 min), rate limiting, device binding, HMAC-signed 30-day session tokens with sheet-backed revocation |
| `Marks.gs` | The write path: batched sync, deterministic idempotency keys, `LockService`, single `setValues` append, geofence classification, anti-fraud flags, Drive photo storage, monthly spreadsheet rollover, token-checked photo proxy |
| `Summary.gs` | The read path: `summaryTick` (10-min today.json with district/project/sector rollups) and `nightlyJob` (per-sector month files, exception queue, anomaly scan, org.json, month-close archive), committed to the GitHub Pages repo via the git data API |
| `Admin.gs` | Master data, corrections (append-only), PIN reset, device unbind, AWC geofence re-capture, imports — all role-checked server-side (supervisor=sector, CDPO=project, admin=all), all audit-logged |
| `Maintenance.gs` | `setupAll()`, trigger installation, photo reaper (45-day retention), next-month pre-creation, owner-run bulk import (`importFromSheets`) |

## Script Properties

Set automatically by `setupAll()` unless noted:

| Property | Meaning |
|---|---|
| `MASTER_ID` | ATTENDANCE_MASTER spreadsheet id |
| `PHOTOS_ROOT_ID` | AttendancePhotos Drive folder id |
| `HMAC_SECRET` | Session-token signing secret (auto-generated; never share) |
| `ATT_yyyy-MM` | Monthly attendance spreadsheet ids (auto) |
| `GH_TOKEN` | **Manual**: GitHub fine-grained token, contents:write on the Pages repo |
| `GH_REPO` | **Manual**: e.g. `youruser/attendance` |
| `GH_BRANCH` | Optional, default `main` |
| `JITTER_MAX_SEC` | Optional, default 90 — raise to 180 if the 9 AM burst ever strains |

## Decisions encoded here (and why)

- **4-digit PIN**, not 6. The threat is a colleague guessing, not an offline
  cracker: 5 attempts → 15-min lockout plus device binding caps online guessing
  at ~480 tries/day against 10,000 combinations, while 6 digits measurably
  raises mistyping and forgot-PIN resets for low-literacy users. The hash
  (4,000 × salted SHA-256 via `Utilities.computeDigest`) is the strongest
  primitive Apps Script actually provides — bcrypt/scrypt do not exist there.
- **Deterministic idempotency key** `{user}_{yyyymmdd}_{IN|OUT}`: the
  one-IN-one-OUT-per-day rule and duplicate suppression are the same mechanism.
  Retries, double-taps and re-syncs are all collapsed by construction.
- **Photos before the lock, record without the photo if upload fails** — a
  Drive hiccup flags `UPLOAD_FAILED` but never costs an attendance record.
- **Marks are append-only.** Supervisors adjudicate via `Corrections` rows;
  the summariser overlays them. An auditor sees the original and the override.
- **Every failure degrades the dashboard or the photo, never the record.**

## Endpoint summary

`doPost` actions: `ping`, `login` (public; answers `CHOOSE_USER` with a
candidate list when the phone maps to several users) · `sync`, `config`,
`myHistory`, `logout` (field) · `nameMap`, `correction`, `pinReset`,
`deviceUnbind`, `setAwcCoords` (supervisor/CDPO/admin) · `userUpsert`,
`importUsers`, `setSchedules`, `revoke` (admin).
`doGet`: `?action=ping`, `?action=photo&id=…&token=…` (scope-checked photo proxy).

Error contract: every response is JSON `{ok:true,…}` or
`{ok:false, code:'…'}`; `code:'BUSY'` means "keep it queued, retry with
backoff" — the client treats it as a non-event, not an error.
