# Sisu&MahilaSamridhi — Deployment, Operation & Troubleshooting Guide

**WD&CW Jangaon · Government of Telangana**
This guide explains how to install, use and troubleshoot the Sisu Mahila Samridhi app.
Installed phones receive every update automatically — nothing ever needs reinstalling.

Installation is by **QR code only** — every sector receives the official printed QR
poster (`INSTALL-POSTER.png` in this folder). No address is typed and no link is shared
on WhatsApp: the poster's QR is the single official entry point.

**How to check which version a phone is running:** scroll to the bottom of any screen —
the grey line reads `BUILD: v4.2` (or newer) with a date. When reporting a problem,
always note this build number.

---

## Part A — Installing the app on a field phone

Requirements: any Android phone with **Chrome** and a working internet connection
(only for the first install and for syncing — daily marking works offline).

1. Point the phone **camera** at the official QR poster and tap the link that pops up
   (choose **Chrome** if asked).
2. Wait for the login screen to appear (emblem on top, "Sisu Mahila Samridhi").
3. A green **"⬇ Install this app on the phone"** button appears at the top —
   tap it, then tap **Install** on the confirmation. Done: the **Samridhi** icon
   appears on the home screen.
4. If the green button does not appear on an older phone: tap Chrome's **⋮** menu
   (top-right) → **"Add to Home screen"** → Install.
5. From now on, always open the app **from the icon**, not from Chrome.

> ⚠️ **Install only by scanning the official QR poster.** Never from a forwarded
> link or message.

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

## Part D — How updates reach phones

The app updates itself. When a new build is published, each phone downloads it silently on
the next open **with network** and reloads to the new version (never in the middle of a
capture or sync). No reinstall, no visit to any store. Verify by checking the BUILD line.

Two things do **not** update automatically on already-installed phones:
- The **home-screen icon and name** — frozen at install time. To refresh them: remove the
  icon and Add to Home screen again (login and pending marks are kept).

---

## Part E — Troubleshooting

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
| 12 | Marked, but the district office says it has not received it | Check the phone's Pending count on the home screen (must be 0). Office records refresh about every 5 minutes — ask them to check again after that. |
| 13 | Every mark at a centre shows "outside geofence" | The centre's stored location is wrong or missing. Inform the district office — they can re-capture the centre's correct location; marks are never blocked meanwhile. |
| 14 | Phone storage almost full | The app itself needs almost nothing, but Android may refuse the camera. Free some space (photos/videos), then retry. |

**Escalation path:** worker → Anganwadi supervisor / sector → **connect with the EDM
(e-District Manager) at the district office**, sharing: worker name, AWC, phone model,
BUILD number, and a screenshot of the problem.

---
