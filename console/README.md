# Monitoring console — static web app

For the district admin team and the Collector (both role ADMIN, full
district view). The code also supports scoped SUPERVISOR (own sector) and
CDPO (own project) roles if the department adds them later. English-only,
Government of Telangana theme, desktop-first but readable on a 6-inch phone.

## Data path — why it scales

The console **never queries the raw attendance sheets**. It reads the static
JSON the backend summariser commits into this repo (`summary/today.json`,
`summary/org.json`, `summary/month/S##.json`, `summary/exceptions.json`,
`summary/meta.json`), so a Collector's projector refreshing all day costs zero
Apps Script executions. A staleness banner always shows when the data was
generated. The public JSON is pseudonymous (user ids and org codes only);
names and phones come from the authenticated `nameMap` call after login and
never appear in the published files. The only per-click server calls are
photo views (token-checked proxy) and admin actions.

## Try it right now (demo mode, no server)

`js/config.js` ships with `DEMO: true` (fixture data built in):

1. Serve the repo root over HTTP: `python -m http.server 8080`
2. Open `http://localhost:8080/console/`
3. Sign in with any 10-digit number → pick **Demo Admin** or **Demo
   Supervisor** → set a PIN. Admin sees the whole district; the supervisor
   only sector S01 — the same scoping the server enforces in production.

## Going live

Copy `js/config.example.js` to `js/config.js`, set `DEMO: false`, paste the
Apps Script `/exec` URL. `SUMMARY_BASE: '../'` is correct when the console is
served from `/console/` on the Pages site the summariser commits into.

## Views

- **Today** — district → project → sector drill-down with per-user rows
  (status, IN/OUT, geofence, flags, photo), search, status filter, CSV export,
  supervisor lands directly on their sector.
- **Exceptions** — outside-geofence / unverified / flagged marks plus nightly
  anomalies; Accept / Reject with a mandatory reason (append-only correction,
  original record untouched).
- **Monthly** — per-sector user × day grid from the nightly files, archive
  months included, CSV export.
- **Users & Admin** — search users; PIN reset and device unbind (scoped);
  activate/deactivate (admin only); capture a real GPS fix for AWCs whose
  register coordinates were blank or wrong (stand at the centre, one tap).
