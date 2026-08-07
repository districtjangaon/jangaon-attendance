# MASTER PROMPT — Zero-Cost Field Attendance System (PWA + Google Sheets + GitHub Pages)

> Paste everything below the line into your model of choice. Edit the bracketed `[...]` fields first.

---

## 1. ROLE

You are a **senior software engineer and product architect with 15+ years building attendance and field-workforce systems deployed at government scale in India** — Anganwadi centres, government primary schools, ASHA/ANM cadres, sanitation and municipal field staff, panchayat-level officers.

You have personally shipped systems that survived all of the following, at once:

- ₹6,000 Android phones with 2 GB RAM, Android 9–12, and 8 GB of storage that is already 95% full
- 2G/EDGE dead zones where a single API call takes 40 seconds or silently fails
- Users who have never installed an app from the Play Store and cannot reliably read English
- A District Collector who wants a live dashboard on a projector at 11 AM Monday
- An auditor, 18 months later, who wants to know exactly where a specific person was on a specific morning and will not accept "the system says so"

Your design instinct is: **it must work on the worst phone in the district, on the worst network day, in the hands of the least tech-confident user.** Everything else is negotiable.

You are blunt about tradeoffs. You do not hand-wave scale. You do not invent APIs or quotas. When a requirement is infeasible as stated, you say so plainly, quantify why, and propose the closest workable alternative — you do not silently design something that will collapse in month three.

---

## 2. THE BRIEF

Design and build a **field attendance system** with two surfaces:

| Surface | Users | Purpose |
|---|---|---|
| **Marking app** | Field staff (teachers, Anganwadi workers, field officers) | Mark IN and OUT attendance with GPS + photo, works offline |
| **Monitoring web console** | Supervisors, cluster/mandal officers, district admin | Live and historical attendance, exceptions, exports |

**Hard constraint: total infrastructure cost must be ₹0 / $0 per month, indefinitely.**

---

## 3. NON-NEGOTIABLE CONSTRAINTS

### 3.1 Cost & hosting
- Frontend (both app and console) hosted on **GitHub Pages** — static only, no server-side rendering
- Backend logic: **Google Apps Script** web app (`doGet` / `doPost`), deployed as a web app
- Datastore: **Google Sheets**
- File storage: **Google Drive** (attendance photos)
- **No paid services. No Firebase paid tier. No VPS. No custom domain requirement. No third-party APIs that bill.**

### 3.2 Scale targets
- **~1,000 registered users**
- **300–500 users marking attendance in the same window** (typical: 9:00–9:45 AM and 4:00–5:00 PM)
- Retention: minimum **24 months** of attendance history, queryable

### 3.3 Connectivity
- Must work **fully offline** — mark attendance, capture GPS, capture photo, queue locally
- Must sync automatically and reliably when connectivity returns
- Must never lose a record, and must never create a duplicate on retry

---

## 4. FUNCTIONAL REQUIREMENTS

### 4.1 Authentication
- Login = **10-digit mobile number + numeric PIN** (4 or 6 digit — you recommend which and justify)
- No email, no OAuth, no Google account required for field users
- First-time flow: admin pre-registers the phone number → user sets their own PIN on first login
- Forgot-PIN flow that does **not** require SMS/OTP (no paid SMS gateway) — propose a supervisor-mediated reset
- PINs must never be stored in plaintext anywhere, including in the Sheet
- Session must persist across app restarts and work offline
- Device binding: one active device per user at a time, with an auditable re-bind trail

### 4.2 Attendance marking
- Two events per user per day: **IN** and **OUT**
- Each event captures:
  - Timestamp (device clock **and** server-received clock — flag skew)
  - GPS latitude, longitude, and **accuracy radius**
  - A **live-captured photo** of the user
  - Device ID, app version, network state at capture (online/offline)
- **Geofence validation**: each user is assigned one or more work locations (lat/long + allowed radius). Mark is classified as `INSIDE`, `OUTSIDE`, or `UNVERIFIED` (GPS unavailable or accuracy worse than threshold)
- **Never block the mark** because GPS failed — record it, flag it, let the supervisor adjudicate. A blocked mark means a field worker stands in the sun for 10 minutes and then stops using the app.
- Photo must be **camera-only** — the user must not be able to pick an existing image from the gallery. Explain your technical approach for enforcing this.
- Photo must be compressed client-side before it ever leaves the phone (target: ≤ 60 KB, still recognisable as a face)
- Anti-fraud heuristics you should implement and flag (not block): identical coordinates repeated to 6 decimal places, impossible travel velocity between consecutive marks, suspiciously perfect accuracy values, marks queued offline and synced days later

### 4.3 Offline mode
- Progressive Web App (PWA), installable to home screen, with a service worker
- Local queue in **IndexedDB** (not `localStorage` — justify)
- Each queued record carries a client-generated **idempotency key**
- Sync on: connectivity restored, app foreground, manual "Sync now" button, and Background Sync API where supported
- Retry with **exponential backoff + random jitter** — never a fixed-interval retry storm at 9:00 AM
- The user must always be able to see: how many records are pending, when the last successful sync was, and a clear "you are offline, your attendance is saved" state

### 4.4 Monitoring console (web)
- Roles: **Field user** (own record only) / **Supervisor** (own cluster) / **Admin** (everything + master data + exports)
- Views:
  - Today: marked / not marked / late / outside-geofence, filterable by cluster
  - Individual user history with photo + map pin per event
  - Exception queue: unverified GPS, outside geofence, flagged anomalies, late syncs
  - Monthly summary per user and per cluster, exportable to CSV/XLSX
- Master data management: add/deactivate users, assign clusters, set work locations and geofence radii, set office hours per cluster
- **The console must never query the raw attendance sheet live.** Design a pre-computed summary layer.

### 4.5 Interface & usability
- Field app must be usable by someone with **low literacy and no smartphone training**:
  - One primary action visible on the home screen — a large IN or OUT button, nothing else competing with it
  - Icon + colour driven, minimal text
  - **Bilingual: English + `[LOCAL LANGUAGE — e.g. Telugu / Hindi]`**, switchable, with the choice remembered
  - Confirmation must be unmistakable — a full-screen success state, not a toast
  - Total taps from app open to attendance marked: **≤ 3**
- Console can be denser and desktop-first, but must be readable on a 6-inch phone because supervisors check it in the field

---

## 5. THE SCALE PROBLEM — ADDRESS THIS EXPLICITLY

This is the part where naive designs fail, and it is the part I am judging your answer on.

Google Apps Script web apps have hard platform quotas. Under a consumer Google account, concurrent executions are sharply limited, script runtime is capped at ~6 minutes per execution, trigger runtime is capped daily, and all requests to a "execute as me" web app run as a single owner identity. **300–500 genuinely simultaneous writes into a single Google Sheet will queue, time out, and drop records.** Concurrent `appendRow` without locking will interleave and corrupt rows.

You must therefore design around it. Your response must specify, concretely:

1. **Write path** — how a client submits without waiting on the server; batching strategy; `LockService` usage and lock scope; idempotency and duplicate suppression on retry
2. **Sheet sharding & rollover** — how you keep the hot write target small (row counts, per-cluster vs per-month sharding, archive strategy). State your target maximum rows in any actively-written sheet.
3. **Read path** — a scheduled job that materialises a **static JSON summary** the console reads, so dashboard reads generate zero live Sheet queries. Where that JSON lives, how often it regenerates, how staleness is shown to the user.
4. **Load shaping** — how you spread the 9:00 AM spike (client-side jitter, staggered windows, optimistic local confirmation)
5. **Capacity model** — actual arithmetic: writes/second at peak, rows/day, rows/year, and where the first ceiling is hit
6. **Storage model** — photo bytes/day, bytes/month, and **when the 15 GB free Drive quota is exhausted**. Then give a retention and compression policy that keeps the system alive indefinitely.
7. **Degradation plan** — what breaks first, what the symptom looks like to a user, and what the operator does about it

If any part of the stated requirement genuinely cannot be met on the free tier, **say so directly**, quantify the gap, and give the minimum paid upgrade (e.g. a Workspace tier) with its cost and what it buys.

---

## 6. SECURITY, PRIVACY & COMPLIANCE

This system collects **facial photographs, precise geolocation, and phone numbers of identifiable individuals** — much of it about government employees. Treat it as sensitive personal data under India's **DPDP Act 2023**.

Requirements:

- **Data custody**: the Sheets, Drive folder, and Apps Script project must be owned by an **organisational account**, not an individual's personal Gmail. Explain the ownership-transfer and offboarding risk if this is ignored.
- **No public links.** Attendance photos must not be world-readable via a Drive share link. State exactly how the console displays photos without exposing them publicly.
- PIN storage: salted, iterated hashing. Specify the algorithm using only what Apps Script actually provides.
- Rate limiting and lockout on repeated failed PIN attempts.
- Session tokens: signed, expiring, revocable.
- Least-privilege access: a supervisor must not be able to fetch another cluster's data by editing a request parameter. Enforce authorisation server-side, never in the client.
- Audit trail: every master-data change and every attendance edit/override is logged with actor, timestamp, and previous value. Attendance records themselves are **append-only** — corrections are new rows, never overwrites.
- A stated **data retention and deletion policy**, including what happens to photos after N months.
- A short **privacy notice** in plain language, in both languages, shown at first login.

---

## 7. DELIVERABLES

Produce these, in this order:

1. **Clarifying questions** — ask me the 5–8 highest-leverage questions before designing anything. Do not proceed past this until I answer.
2. **Architecture overview** — components, data flow for the write path and read path, ASCII or Mermaid diagram, and the 3 most important design decisions with the alternatives you rejected and why
3. **Data model** — every Sheet, every column, types, indexes/keys, sharding scheme, and the JSON summary schema
4. **Capacity & storage model** — the arithmetic from Section 5
5. **Backend** — complete, runnable Apps Script code: routing, auth, write handler, sync handler, summary generator, admin functions. Not pseudocode.
6. **Frontend — field app** — complete PWA: service worker, IndexedDB queue, camera capture, geolocation, sync engine, bilingual UI
7. **Frontend — monitoring console** — complete static app reading the summary JSON
8. **Deployment runbook** — step by step, written so a district IT officer can follow it: creating the Sheets, deploying the Apps Script web app and setting its execution/access settings, configuring triggers, publishing to GitHub Pages, wiring the endpoint URL, and onboarding the first 10 users
9. **Test plan** — including a load-simulation script that fires 400 concurrent synthetic marks so we can see the real ceiling before go-live, not after
10. **Phased rollout plan** — Phase 1 pilot (~30 users, one cluster), Phase 2, Phase 3 full district — with the specific go/no-go metric for each gate

---

## 8. GROUND RULES FOR YOUR RESPONSE

- **Code must be complete and runnable.** No `// TODO: implement sync logic`. No placeholder functions.
- **No invented APIs.** If you are unsure whether an Apps Script or browser API exists or behaves as you describe, say so and give a fallback.
- **Minimal, explicit changes.** When I ask for a revision later, change only what I asked for, tell me exactly what changed and why, and do not silently refactor working code.
- **Cite the real limit, not a vibe.** When you claim something won't scale, give the number.
- **Plain language for the runbook and the privacy notice** — these are read by non-engineers.
- **Push back.** If part of this brief is a bad idea, argue with me. I would rather find out now than in month three with 800 users onboarded.
- Start by asking your clarifying questions. Nothing else in your first response.

---

## 9. CONTEXT TO FILL IN BEFORE SENDING

- Deploying organisation / department: `[...]`
- Geography and number of clusters/mandals: `[...]`
- User cadre: `[teachers / Anganwadi workers / field officers / mixed]`
- Second language required: `[...]`
- Do you have a Google Workspace account, or only consumer Gmail? `[...]`
- Expected office-hours window and grace period for "late": `[...]`
- Is there an existing HRMS/master employee list to import from? `[...]`
