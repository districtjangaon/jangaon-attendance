# Capacity & storage model — Jangaon district, real numbers

Source data (AWC DATA-31.07.2026.xlsx): **695 AWCs, 27 sectors, 3 projects,
1,161 field staff** (664 AWT + 497 AWH). Plus ~27 supervisors, 3 CDPOs,
1 admin ⇒ ~1,192 accounts. ~678 marking devices (695 AWCs − 17 fully-vacant;
AWT+AWH pairs share the centre phone at ~190 AWCs).

## Write path

| Quantity | Value | Arithmetic |
|---|---|---|
| Marks/day | ~2,380 rows | 1,161 × 2 (IN+OUT) + supervisors ~60 |
| Rows/month (hot sheet) | ~62,000 | 2,380 × 26 working days |
| Cells/month | ~1.24 M | 62k rows × 20 cols — 12% of the 10 M-cell/spreadsheet limit; monthly rollover keeps every hot file this size forever |
| Rows/24 months | ~1.5 M | across 24 separate month spreadsheets, archived as static JSON |
| IN-window arrivals | ~1,161 syncs / ~50 min ≈ 0.4/s average | 45-min window + 0–90 s client jitter |
| Opening-minute burst | ~2–5 syncs/s | absorbed by jitter; overflow gets `BUSY` and backs off 30 s–30 min |
| Server write capacity | ~2 batches/s sustained ≈ 5,400 marks / 45 min | lock hold ≈ 0.3–0.6 s per batched `setValues`; **4.6× headroom** over the 1,161-mark window |

Apps Script (consumer account) hard limits that matter: **30 simultaneous
executions** (excess → our `BUSY` path, client keeps records queued — nothing
lost), 6 min/execution (a 20-record batch runs in seconds), triggers total
90 min/day (see below).

## Read path (console)

Zero live reads: dashboards are static JSON on GitHub Pages. `summaryTick`
reads only rows received today (≤ ~2,500) — ~30–45 s per run. Daily trigger
budget: ~54 ticks (10-min peak / hourly off-peak) ≈ 36 min + nightly full
build ~5 min + photo reaper ~3 min + month-prep ~1 min ≈ **45 of the 90
trigger-minutes/day**. UrlFetch: ~300 GitHub API calls/day vs 20,000 quota.

## Storage (Drive 15 GB free)

| Quantity | Value | Arithmetic |
|---|---|---|
| Photo bytes/day | ~136 MB | 2,270 photos × ≤60 KB |
| Steady state at 45-day retention | **~6.1 GB** | 136 MB × 45; the reaper hard-deletes older day-folders nightly |
| Headroom | ~8.5 GB | Sheets are negligible (~10 MB/yr) |

If the account nears quota: cut `PHOTO_RETENTION_DAYS` to 30 (→ 4.1 GB) or
`photoMaxKB` to 45 (→ 4.6 GB). The system never dies from photo growth —
retention is enforced nightly.

## First-login day

PIN hashing is 4,000 × SHA-256 (~0.5–1 s server CPU per login). 1,161 first
logins in one morning would queue behind the 30-execution limit. **Onboard in
phases** (rollout plan) — a sector (~43 people) per day is effortless.

## What breaks first, and the symptom

1. **9:00 spike beyond design** (e.g., jitter disabled): users see "sending…"
   longer; records stay queued; nothing lost. Operator: raise
   `JITTER_MAX_SEC` to 180.
2. **Trigger minutes exhausted** (quota change / runaway job): today.json goes
   stale — the console staleness banner turns red. Operator: check trigger
   failure mail, reduce tick frequency to 15 min.
3. **Drive quota full** (retention misconfigured): photo uploads flag
   `UPLOAD_FAILED`, **marks still recorded**. Operator: run `reaperJob`
   manually, lower retention.
4. **GitHub token expired**: summaries stop publishing (red banner); marking
   unaffected. Operator: mint a new fine-grained token, update `GH_TOKEN`.

Every failure degrades the dashboard or the photo — never the attendance
record.
