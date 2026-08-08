# Deployment runbook

Written for a district IT officer. No programming needed — only copy-paste.
Time needed: about 2 hours the first time.

## 0. What you need before starting

- A Google account **owned by the department** (not anyone's personal Gmail —
  if that person leaves or loses the account, all attendance data and photos
  go with them). Recommended: create `wdcw.jangaon.attendance@gmail.com`,
  store the password with the technical admin and one more officer.
- A GitHub account (free) for hosting the app pages.
- The file `AWC DATA-31.07.2026.xlsx` (or newer) from the district office.
- A Windows/any PC with Python 3 installed (for the one-time data conversion).

## 1. Prepare the master data (on the PC)

1. Put the district xlsx in the `input/` folder of this project.
2. Run: `pip install openpyxl` then `python tools/import-awc.py`
3. It writes 5 files into `master-data/` plus **`ISSUES.md` — open it and
   read it.** It lists wrong phone numbers, missing GPS coordinates and vacant
   posts that the sectors should fix. Nothing in it blocks go-live.
4. Add the two console accounts as rows in `IMPORT_USERS.csv` (ids from
   U2001 so they never collide with the imported staff, which ends around
   U1161): the **technical admin** and the **Collector** — each with their
   phone, name, cadre `OTHER`, role `ADMIN`, other columns empty. Everyone
   from the register stays a plain field user; leave `supervisor_phone` in
   `IMPORT_SECTORS.csv` empty.

**These files contain real names and phone numbers. Never email them around,
never upload them anywhere, never commit them to GitHub.** The project's
`.gitignore` already blocks them.

## 2. Create the backend (Google account)

1. Sign in to the department Google account. Go to `script.google.com` →
   New project. Name it `attendance-backend`.
2. Two pastes, nothing else:
   - Open `backend/COMBINED.gs` (single-file bundle of the whole backend) →
     select all → paste into the editor's `Code.gs`, replacing its contents.
   - Project Settings → tick "Show appsscript.json manifest" → back in the
     editor open `appsscript.json` → replace its contents with
     `backend/appsscript.json`. This also auto-enables the Drive service
     (photo auto-delete) — no separate step.
   (After any later backend change, re-run `python tools/build-combined.py`
   and re-paste.)
3. Project Settings → Script properties → add `ADMIN_PHONE` (the technical
   admin's 10-digit mobile) and `ADMIN_NAME`. These stay in the project,
   never in the public code repository.
4. Save (Ctrl+S). In the toolbar function dropdown pick **`setupAll`** →
   Run; approve the permission prompts (Advanced → "Go to attendance-backend
   (unsafe)" is normal for your own unpublished script). It creates the
   ATTENDANCE_MASTER spreadsheet, the AttendancePhotos folder, the current
   month's attendance file, and the timed jobs.

## 3. Load the master data

1. Open ATTENDANCE_MASTER (link is in Drive). Create five new tabs named
   exactly: `IMPORT_PROJECTS`, `IMPORT_SECTORS`, `IMPORT_AWCS`,
   `IMPORT_USERS`, `IMPORT_SCHEDULES`.
2. Open each `master-data/IMPORT_*.csv` in Excel and copy-paste the whole
   sheet (including the header row) into the matching tab.
3. In the Apps Script editor run `importFromSheets()`. The log should say
   `projects: 3 / sectors: 27 / awcs: 695 / users: ~1190 added`.
4. Re-running it later with a corrected file is safe: it updates details but
   never touches anyone's PIN or phone binding.

## 4. Publish the web app

1. Deploy → New deployment → type **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone** (the app itself checks PINs and tokens;
     "Anyone" only means the URL is reachable — required for field phones
     that have no Google account)
2. Copy the web app URL ending in `/exec`. You will paste it in step 6.

## 5. Publish the app pages (GitHub)

1. Create a GitHub repository (e.g. `jangaon-attendance`), push this project
   to it, enable **Settings → Pages → Deploy from branch → main / root**.
2. Create a fine-grained personal access token: GitHub → Settings →
   Developer settings → Fine-grained tokens → only this repository →
   Repository permissions → **Contents: Read and write**. Set expiry 1 year
   (put a calendar reminder to renew).
3. In Apps Script → Project Settings → Script properties, add:
   - `GH_TOKEN` = the token
   - `GH_REPO` = `yourgithubname/jangaon-attendance`
4. Run `publishOrg()` once — this pushes `summary/org.json` so the console
   knows sector and AWC names.

## 6. Wire the endpoint

1. Copy `app/js/config.example.js` to `app/js/config.js`; set
   `DEMO: false` and paste the `/exec` URL.
2. Same for `console/js/config.example.js` → `console/js/config.js`.
3. Commit and push. The phone app is now at
   `https://<name>.github.io/<repo>/app/`, the console at `.../console/`.

## 7. Onboard the first 10 users (pilot sector)

1. The technical admin visits the pilot sector. On each worker's centre phone, open the app URL
   in Chrome → menu → **Add to Home screen**.
2. The worker types the centre phone number. If two names appear (teacher and
   helper share the phone) each taps their own name and sets **their own**
   4-digit PIN. The privacy notice is on that screen.
3. Mark IN together the first time: IN → photo → done. Check the mark appears
   in the console within 10 minutes.
4. Teach the two rules: *always the same phone* (it is bound to your account;
   changing phones needs the district office), and *airplane mode is fine* — the
   app says "saved on phone, will send later" and sends by itself.

## 8. Daily operations

- **Technical admin**: open console → Exceptions each afternoon; Accept/Reject
  with a reason. Fix AWCs marked "NO GPS SET" (Users & Admin → capture GPS
  standing at the centre, during field visits). Watch the staleness banner
  (green = healthy).
- **Collector**: same console login, full district view; Monthly CSV export
  for honorarium processing is on the Monthly tab.
- **Forgot PIN**: admin → Users & Admin → Reset PIN → worker sets a new
  one at next login. **New phone**: Unbind phone, then login binds the new one.
- **Holidays**: the state list lives in the `Holidays` tab (date, name);
  Sundays are automatic. Update it yearly: drop the new `holidays.xlsx` in
  `input/`, run `python tools/import-awc.py`, re-import the `IMPORT_HOLIDAYS`
  tab, run `importFromSheets`. On holidays nobody is marked LATE, the console
  says "attendance not expected", and the monthly grid greys the day.
- **Detailed register (Excel)**: in the Apps Script editor run
  **`buildRegister`** — it rebuilds a `Register` tab in the current month's
  attendance spreadsheet: one row per mark with person, sector, AWC, GPS,
  verification, photo link and timings. For an older month run it as
  `buildRegister('2026-07')` from a temporary function or keep the tab from
  month-end. File → Download → Excel for offline use.
- **Trigger failure emails** from Google land in the department inbox — read
  them; the capacity doc's "what breaks first" section says what to do.

## 9. Backups & leaving

- ATTENDANCE_MASTER + monthly files live in the department Drive. Once a
  quarter: File → Download → xlsx, store on the office PC.
- If the responsible officer changes: change the Google password, the GitHub
  password, and mint a fresh `GH_TOKEN`. Nothing else moves — ownership is
  the department account, which is the whole point.
