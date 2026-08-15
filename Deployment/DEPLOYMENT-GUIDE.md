# Sisu&MahilaSamridhi — Deployment, Operation & Troubleshooting Guide

**WD&CW Jangaon · Government of Telangana**
This guide covers the web (PWA) channel, which is live today and runs in parallel with the
Google Play rollout. Phones installed this way get every update automatically — nothing
needs to be reinstalled when the Play Store version arrives later.

| What | Address |
|---|---|
| Field app (phones) | `https://districtjangaon.github.io/jangaon-attendance/app/` |
| Monitoring console (office) | `https://districtjangaon.github.io/jangaon-attendance/console/` |
| Privacy policy | `https://districtjangaon.github.io/jangaon-attendance/privacy.html` |

**How to check which version a phone is running:** scroll to the bottom of any screen —
the grey line reads `BUILD: v1.9-20260814-1900` (or newer). When reporting a problem,
always note this build number.

---

## Part A — Installing the app on a field phone

Requirements: any Android phone with **Chrome** and a working internet connection
(only for the first install and for syncing — daily marking works offline).

1. Open **Chrome** on the phone (the round red/yellow/green/blue icon).
2. Type the app address into the top bar:
   `districtjangaon.github.io/jangaon-attendance/app/` and press Go.
3. Wait for the login screen to appear fully (navy header with the Telangana emblem).
4. Tap the **⋮** (three dots) at the top-right of Chrome.
5. Tap **"Add to Home screen"** (on some phones: **"Install app"**).
6. Tap **Install / Add**. The **Samridhi** icon (green emblem on dark blue) appears on the
   home screen.
7. From now on, always open the app **from that icon**, not from Chrome.

> ⚠️ **Never install from any other link.** Only the address above is the official app.

### What NOT to do on an installed phone
- Do **not** clear Chrome's "browsing data / storage" — that deletes the saved login and
  any attendance marks waiting to be sent.
- Do not use phone "cleaner/booster" apps on Chrome for the same reason.
- Do not block Chrome in battery saver if the phone offers an exception list.

---

## Part B — First login (each worker, once)

1. Open the app from the **Samridhi** icon.
2. Enter your **10-digit mobile number** (the one in the department register).
3. If the phone is shared by the Teacher and the Helper, the app asks **"Tap your name"** —
   choose yourself.
4. First time only: the app asks you to **choose a 4-digit PIN** (enter it twice). This PIN
   is yours alone — the second worker on the same phone sets her own.
5. Read the privacy note shown on screen; setting the PIN records your consent.
6. When Chrome asks for **Camera** permission → tap **Allow**.
   When it asks for **Location** permission → tap **Allow** (choose "While using the app").

**Adding the second worker on a shared phone:** from the home screen tap
**Switch user → + Add another user** and repeat the steps above with her details.

---

## Part C — Daily operation (field workers)

**Marking IN (morning):**
1. Open the app from the icon.
2. Tap the big green **IN** button.
3. Hold the phone up so your face fills the white corner frame; wait for the GPS line
   below the camera to settle (green = location found).
4. Tap **TAP TO CAPTURE**. The green "Attendance saved" screen confirms it.

**Marking OUT (evening):** same steps — the big button says **OUT** after the morning mark.

**If there is no network:** mark exactly as normal. The yellow banner says the mark is
saved on the phone. It is sent automatically when network returns — nothing to do, and it
can never be sent twice. The middle box on the home screen shows how many marks are
**Pending**; it becomes 0 after sync. **Sync now** forces an immediate attempt when on
network.

**Leave:** Menu (☰) → **Apply for leave** → choose dates, type, reason → Submit. Leave is
auto-approved per district policy; the console shows it, and leave days are not counted as
absent.

**My record:** home screen → **My record** shows your own recent marks and whether each is
synced (✓) or pending.

**Rules built into the app (no exceptions needed):**
- A mark is **never blocked** — poor GPS, no GPS, or being outside the centre only flags
  the mark for the office to review; it always saves.
- Photos come only from the live camera (no gallery), are compressed, stamped with place
  and time, and are deleted from storage after 45 days.

---

## Part D — Console operation (district admin team)

Open the console address in Chrome on a PC (works on a phone too, in landscape).
Sign in with your admin mobile number and PIN.

- **Dashboard** — today's live picture: stat cards, in-time chart, sector top-10, geofence
  verification, searchable staff table. The banner above the tabs shows **how fresh the
  data is** (it regenerates every ~5 minutes on working days; the console never reads the
  raw sheet directly).
- **Analytics** — pick month + scope → Analyse (district-wide pulls all 27 sector files;
  allow a few seconds).
- **Flagged** — informational list: outside-geofence, GPS-unverified, fake-GPS suspects.
  Attendance is auto-approved; nothing here blocks anyone's record.
- **Monthly** — per-sector day-by-day grid; coloured cells, export CSV.
- **Reports** — month × scope registers; working days exclude Sundays and state holidays.
- **Leaves** — applications from the field app; rejecting one returns those days to
  "not marked".
- **Users & Admin** — search users; fix an AWC's geofence by standing at the centre and
  capturing GPS.
- **🌙 button** — dark mode for projector reviews.

**After any backend change** (done by the technical admin): re-paste `COMBINED.gs` in the
Apps Script editor and deploy a **New version** — the web app URL stays the same.

---

## Part E — How updates reach phones

The app updates itself. When a new build is published, each phone downloads it silently on
the next open **with network** and reloads to the new version (never in the middle of a
capture or sync). No reinstall, no visit to any store. Verify by checking the BUILD line.

Two things do **not** update automatically on already-installed phones:
- The **home-screen icon and name** — frozen at install time. To refresh them: remove the
  icon and Add to Home screen again (login and pending marks are kept).
- The **Play Store version**, once installed, updates its shell through Play — but the
  screens inside come from the web and stay current automatically.

---

## Part F — Troubleshooting

| # | Problem | Fix |
|---|---------|-----|
| 1 | "Number not found" at login | The number differs from the register. Verify against the register; the district office corrects the register entry, then retry after the next data refresh. |
| 2 | Forgot PIN | Call the district office → they reset it → login again and set a new PIN. |
| 3 | Camera is black / "camera error" | Phone Settings → Apps → Chrome → Permissions → Camera → Allow. Then close and reopen the app. If another app is using the camera, close it. |
| 4 | GPS line stays "Getting GPS…" or shows poor accuracy | Turn ON phone Location (high accuracy), step outside / near a window, wait 10–15 s. **If it never comes, capture anyway** — the mark saves and is simply flagged; never skip attendance because of GPS. |
| 5 | Mark shows "Pending" for a long time | The phone has no working internet. On network, open the app and tap **Sync now**. Marks wait safely for days if needed and never duplicate. |
| 6 | "You are offline" banner won't go away despite network | The phone may be on a captive/blocked Wi-Fi. Switch to mobile data, reopen the app. |
| 7 | App opens as a plain website with the address bar | It was opened in Chrome, not from the icon. Use the home-screen icon; if the icon is missing, re-do Part A. |
| 8 | Old look / old version stays | Tap the **↻** button in the app header (top-right) with network on; the app reloads to the newest build. Confirm via the BUILD line. |
| 9 | Icon or app name still the old one after an update | Normal (see Part E). Remove the icon → Add to Home screen again. Login and pending marks survive. |
| 10 | Phone was reset / Chrome data was cleared | The saved login and any **unsent** marks on that phone are gone (already-synced marks are safe on the server). Reinstall (Part A), log in again — the PIN is unchanged. |
| 11 | Second worker can't log in on the shared phone | Home → **Switch user** → **+ Add another user** → her number and PIN. Each worker marks under her own name. |
| 12 | Marked but console doesn't show it | Check the phone's Pending count (must be 0), then check the console banner's data age — the summary refreshes about every 5 minutes. Wait one refresh and press Refresh in the console. |
| 13 | Console shows "delayed/stale data" banner | If it says the system is live but nothing new — that is normal on quiet hours. If it says delayed: the technical admin checks the Apps Script triggers (RUNBOOK). |
| 14 | Wrong AWC location causing "outside geofence" flags for everyone at a centre | Admin: console → Users & Admin → "Fix an AWC's geofence" → stand at the centre → capture. |
| 15 | Phone storage almost full | The app itself needs almost nothing, but Android may refuse the camera. Free some space (photos/videos), then retry. |

**Escalation path:** worker → Anganwadi supervisor / sector → district office
(district.jana@gmail.com) with: worker name, AWC, phone model, BUILD number, and a
screenshot of the problem.

---

## Part G — Play Store track (running in parallel)

The Play Store version is the same app in an official wrapper. Until it is public,
phones use Part A. Once published, new phones install from Play instead — both kinds
of installation work side by side and show identical data. Testers for the Play closed
test are onboarded via the `request/` folder's tester sheet.
