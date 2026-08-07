# JPS RUNBOOK — exact commands, in order
Build: **JPS v0.2.0-M1m b001**

Four phases. Phase 1 is on your laptop (5 min), Phase 2 in a browser on the **district Gmail**
(10 min), Phase 3 gets a working pilot link (5 min), Phase 4 is the Play build (later, needs the
Play Console account).

Legend: `$` = your laptop terminal. Anything in `CAPS_LIKE_THIS` you replace.

---

## PHASE 1 — Verify locally before anything is deployed

```bash
# 1.1 unpack
cd ~/projects                       # or wherever you keep repos
unzip jps-v0.2.0-M1m-b001.zip -d jangaon-pashu-seva
cd jangaon-pashu-seva

# 1.2 run the backend regression harness (this is the gate — 34 assertions)
node test/harness.js
```

Expected last line: `ALL CHECKS PASSED` — and exit code 0:

```bash
echo "exit=$?"        # must print exit=0
```

```bash
# 1.3 client syntax check
node --check app/www/app.js && echo "app.js OK"
```

> `node --check backend-gas/Domain.gs` will error with `ERR_UNKNOWN_FILE_EXTENSION` — that is Node
> refusing the `.gs` extension, **not** a code error. The harness in 1.2 already parses and executes
> those two files; that is the real check.

If 1.2 fails, stop. Do not deploy.

---

## PHASE 2 — Backend on the district Gmail

Sign the browser into the **district account first** (or use a fresh Chrome profile — the single most
common mistake is creating the project under a personal Gmail and then having to redo it).

### Route A — paste (no tooling, recommended for the first deploy)

1. Go to **script.google.com** → **New project** → rename it `JPS Backend`.
2. Delete the default `Code.gs`. Create four files with the **+ → Script** button, named exactly:
   `Domain`, `Db`, `Api`, `Main`  (Apps Script adds the `.gs` itself).
3. Paste the contents of `backend-gas/Domain.gs`, `Db.gs`, `Api.gs`, `Main.gs` into the matching file.
4. **⚙ Project Settings** → tick **"Show 'appsscript.json' manifest file in editor"**.
   Back in the editor, open `appsscript.json` and replace it with `backend-gas/appsscript.json`.
5. **Save** (Ctrl+S).

### Route B — clasp (for the second deploy onward)

```bash
npm install -g @google/clasp
clasp login                                  # opens browser — sign in as the DISTRICT account
cd backend-gas
cp .clasp.json.example .clasp.json
# create the project once, then push:
clasp create --type webapp --title "JPS Backend" --rootDir .
clasp push -f
clasp open                                   # opens the editor in the browser
```

### 2.1 Run setup() — once

In the editor toolbar: function dropdown → **`setup`** → **Run**.
Grant permissions when prompted (*Advanced → Go to JPS Backend (unsafe)* — that warning is normal for
unpublished internal scripts).

Open **Execution log**. Copy these three lines somewhere safe:

```
Database sheet : https://docs.google.com/spreadsheets/d/....
Photos folder  : https://drive.google.com/drive/folders/....
ADMIN BOOTSTRAP CODE (use once in the app): XXXXXXXX
```

Lost the code later? Function dropdown → **`opsNewBootstrapCode`** → Run → read the log.
Want to see all current settings: run **`opsShowConfig`**.

### 2.2 Deploy the web app

**Deploy → New deployment → ⚙ → Web app**, then set exactly:

| Field | Value |
|---|---|
| Description | `b001` |
| Execute as | **Me (district account)** |
| Who has access | **Anyone** |

**Deploy** → copy the **Web app URL**. It ends in `/exec`. That is your `EXEC` URL.

> "Anyone" means anyone with the link can call the API — the app's own auth layer (tokens, roles,
> ownership guards) is what protects data. "Anyone with Google account" would break farmer sign-in.

### 2.3 Smoke-test the live backend from your terminal

```bash
EXEC="PASTE_THE_EXEC_URL_HERE"

# health (must show ok + the build tag)
curl -sL "$EXEC" ; echo

# meta: must list 12 mandals and needsBootstrap=true
curl -sL -X POST "$EXEC" \
  -H 'Content-Type: text/plain;charset=utf-8' \
  -d '{"action":"meta.info","payload":{}}' ; echo

# create a throwaway farmer session (proves writes + Sheets work)
curl -sL -X POST "$EXEC" \
  -H 'Content-Type: text/plain;charset=utf-8' \
  -d '{"action":"farmer.identify","payload":{"phone":"9111111111","name":"Test","source":"manual"}}' ; echo
```

`-L` is required — Apps Script redirects to `googleusercontent.com` to serve the response.

Then open the Sheet URL from 2.1: the `Users` and `Mandals` tabs should have rows. Delete the test
row from `Users` before go-live (right-click the row → Delete row).

---

## PHASE 3 — Web pilot (before any store build)

```bash
# 3.1 point the client at your backend
cd ~/projects/jangaon-pashu-seva/app/www
# macOS/Linux:
sed -i.bak "s|REPLACE_WITH_APPS_SCRIPT_EXEC_URL|$EXEC|" app.js
grep -n "^var API_URL" app.js          # verify it now shows your /exec URL
```

On Windows PowerShell instead:

```powershell
(Get-Content app.js) -replace 'REPLACE_WITH_APPS_SCRIPT_EXEC_URL', $env:EXEC | Set-Content app.js
```

```bash
# 3.2 serve it (either one works)
cd ~/projects/jangaon-pashu-seva/app
npx http-server www -p 5173 -c-1
#   ── or, zero-install ──
cd www && python3 -m http.server 5173
```

Open **http://localhost:5173**.

### 3.3 First-run sequence (do it in this order)

1. **Staff sign-in** (link at the bottom of the farmer screen) → the **First-time setup** card is
   visible only while no admin exists. Enter your district email + name + the **bootstrap code** →
   **Create admin**. You land on the district dashboard. The code is consumed and the card disappears.
2. **Add vet** — name, email, mobile → **Add vet**. A **one-time 10-character access code** appears.
   Copy it now; it is stored only as a hash and cannot be shown again (re-adding the same email
   issues a fresh one).
3. **Logout** → **Staff sign-in** → access-code box → vet email + that code → you are in the vet queue.
4. **Logout** → farmer screen → type a mobile number → file a request with a photo → note the
   `JPS-YYMMDD-NNN` token.
5. Back as the vet: the case appears in **Open**, emergencies pinned first. **Claim** → **Call
   farmer** → pick a disposition: GREEN closes, AMBER schedules a visit (set a date, then **Visit
   done → resolve** later), RED escalates to 1962.
6. As farmer, reopen the token — the progress rail shows every step.

### 3.4 Share the pilot link (optional, GitHub Pages — free)

```bash
cd ~/projects/jangaon-pashu-seva
git init && git add -A && git commit -m "JPS v0.2.0-M1m b001"
git branch -M main
git remote add origin https://github.com/YOUR_ORG/jangaon-pashu-seva.git
git push -u origin main
# Publish only the client: Settings → Pages → Source: "Deploy from a branch",
# branch main, folder /app/www  → link becomes https://YOUR_ORG.github.io/jangaon-pashu-seva/
```

Field officers can use that link on any phone while the Play listing is being acquired.

> Do **not** commit `app/www/app.js` with the real `$EXEC` URL to a *public* repo if you would rather
> the endpoint not be discoverable. Keep the repo private, or restore the placeholder before pushing
> and inject the URL at deploy time.

---

## PHASE 4 — Android build (needs the district Play Console)

```bash
cd ~/projects/jangaon-pashu-seva/app
npm install
npx cap add android
npx cap sync android          # re-run after EVERY edit to www/
npx cap open android          # opens Android Studio
```

Then follow `app/ANDROID.md` for the three wiring steps (PhoneHint plugin registration + gradle dep,
`google-services.json` for push, `serverClientId` for staff Google sign-in) and the **Play Console
acquisition path** (Government org account, D-U-N-S under the Collectorate/ZP entity, $25, DIO/NIC
route).

Build outputs in Android Studio: **Build → Build Bundle(s)/APK(s) → Build APK(s)** for side-loaded
pilot; **Build → Generate Signed Bundle** (AAB) for Play upload.

---

## DAY-2 OPS

**Ship a backend change without breaking the app's URL** — this is the one that catches people.
Editing the code does *nothing* to the live web app until you publish a version, and "New deployment"
mints a *different* `/exec` URL:

```
Deploy → Manage deployments → (your deployment) → ✏ Edit
       → Version: "New version" → Deploy
```

Same URL, new code. Only use **New deployment** if you deliberately want a second endpoint.

**Change an SLA or a cap** — editor → run `opsShowConfig` to see current values, then in the editor
console or a temporary function:

```javascript
Store.setConfig('SLA_EMERGENCY_MIN', '20');   // first-response target, emergencies
Store.setConfig('SLA_NORMAL_MIN', '90');
Store.setConfig('MAX_CREATES_DAY', '5');      // per farmer per day
Store.setConfig('ALLOW_CODE_LOGIN', '0');     // turn off access codes once Google sign-in is live
```

**Enable staff Google Sign-In** — edit the `CLIENT_ID` line inside `opsSetOauthClientId` in `Db.gs`,
Run it, and put the same client ID into `app/capacitor.config.json` → `serverClientId`.

**Backups** — the Sheet keeps full version history (File → Version history). Monthly:
`File → Download → Microsoft Excel (.xlsx)` and archive to the district drive.

**Quota check** — Apps Script dashboard (script.google.com → your project → Executions). Polling is
one `meta.rev` call per open console per 25 s. Migrate to AWS at the triggers in `FREEZE-v2.md`
(>1,000 requests/day, quota >60%, p95 >2.5 s, or a second district).

**Before every backend push**: `node test/harness.js` must print `ALL CHECKS PASSED`.
