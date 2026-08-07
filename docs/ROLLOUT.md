# Phased rollout plan

Numbers from the real register: 695 AWCs / 27 sectors / 1,161 field staff;
average sector ≈ 26 AWCs, ≈ 43 staff.

## Phase 1 — Pilot: one sector (~2 weeks)

Pick one sector with decent network coverage (suggestion: Bachannapeta,
JGN/S01). ~26 AWCs, ~43 staff.

- The technical admin onboards in person over 2–3 days (runbook §7) and
  works the Exceptions queue daily.
- Fix that sector's `ISSUES.md` items (bad phones, missing GPS) as a trial of
  the correction workflow.

**Gate to Phase 2 (all must hold over the final 5 working days):**
- ≥ 90% of active staff marking IN daily without helpdesk contact
- 0 lost marks, 0 duplicate rows (spot-check the month sheet)
- ≥ 80% of marks INSIDE geofence (rest adjudicated within 2 days)
- Resets/unbinds/exceptions all handled routinely from the console

## Phase 2 — One full project (~4 weeks)

Jangaon project: 257 AWCs, 10 sectors, ~430 staff. Onboard one sector per
working day (technical admin on site, phone support after). The Collector
starts reviewing the console weekly. Run the 400-user load test against
production config before starting (test plan §2).

**Gate to Phase 3:**
- ≥ 85% daily IN-marking across the project for 10 consecutive working days
- Exceptions queue drained to < 20 open at each week's end
- today.json staleness < 15 min through both peak windows every day
- Drive usage on trend (≤ ~3 GB at this scale — capacity doc)
- Honorarium/salary report for one month produced from Monthly CSV and
  accepted by the district office

## Phase 3 — Full district (~4 weeks)

Remaining 17 sectors (~730 staff): Kodakandla then Stn. Ghanpur, one sector
per day per project team. After 45 days at full scale, confirm steady-state
Drive usage ~6 GB and trigger minutes ~45/day, then declare steady operations.

**Steady-state definition of done:**
- ≥ 90% district-wide daily marking
- Zero data-loss incidents since Phase 1
- Console is the official attendance source for the monthly honorarium run
- Operations self-sufficient: PIN reset / rebind / exception adjudication all
  done in-district without developer involvement

## Standing risks & mitigations

- **Sector with dead network**: marks queue offline all day and sync in the
  evening — expected behaviour; flag `LATE_SYNC` only beyond 24 h.
- **Shared-phone confusion (two PINs on one phone)**: the picker shows names,
  not numbers; pilot showed this needs one demonstration, then sticks.
- **Vacant posts (17 AWCs both-vacant, 181 AWH-vacant)**: they depress the
  "expected" denominator — keep the register import current so reports stay
  honest.
- **Device churn** (phone breaks): admin unbind + rebind is the routine;
  audit trail records every rebind.
