# Report notes — Sisu Mahila Samridhi district report

Working notes for `rep/sms-report-claude-code-prompt.md`. Assumptions, decisions
and gaps are recorded here and again in Annexure G of the report itself.

## Regenerate

```bash
python -m http.server 8765            # serve the repo, for the capture step
node tools/report-stats.js --json > docs/report/stats.json
node scripts/gps_analysis.js          # --from 22 by default
node scripts/capture_evidence.js
python tools/build_docx.py
python tools/docx_to_pdf.py           # drives Word so the contents page fills in
```

Outputs land in `report/`, `evidence/` and `analysis/`. **All three are
gitignored**: this repository is public, and they carry per-worker location
data, the worker-reference key and the confidential report itself.

## ASSUMPTIONS

| # | Assumption | Basis |
|---|---|---|
| 1 | Workers anonymised throughout; no individual named | No permission recorded. The brief's stated default is to anonymise. |
| 2 | English only, no Telugu summary | No direction recorded. |
| 3 | Attendance figures drawn from 22 August onwards | Directed. 8–21 August was rollout. |
| 4 | No system presently in use is named in Annexure E | Directed. Annexure E records the administration's position instead, attributed as such. |
| 5 | Output is DOCX (primary) plus PDF | Per the brief. `python-docx` 1.2.0 and Word are both present. |
| 6 | Screens captured in the training configuration | No credentials were available for the live system. |

## Phase 0 answers found by inspection

- **Live data** — Google Sheets via Apps Script; monthly `ATT_2026-08` workbook for
  raw marks; district aggregates in `summary/*.json`; master data in
  `master-data/IMPORT_USERS.csv`.
- **Range** — 8–27 August 2026. 1,187 staff on the establishment, 696 centres,
  973 staff seen marking in the window.
- **District / addressee** — Jangaon, WD&CW, District Collector.

## Corrections made to earlier material

- **Geofence minimum radius is 300 m, not 200 m.** Changed by district relaxation
  on 2026‑08‑20 (`GEOFENCE_MIN_RADIUS_M`). An earlier draft of the HTML report
  stated 200 m. The DOCX uses 300 m throughout.
- **Beneficiary headline figures** come from the last day that carries returns,
  not from `today.json`. The nightly summary runs in the morning, before centres
  have reported, so `today.rpt` reads as all zeros.
- **Centre coordinate classification uses every mark of the month**, not only the
  reporting window. Whether a recorded point is usable is a property of the
  centre; restricting it to six days would discard the evidence that establishes
  which coordinates can be trusted.

## Decisions worth recording

- **The exclusion rule the brief demands is satisfied by construction.** A mark can
  only be classified outside if its reported accuracy was ≤ 250 m *and* the
  distance exceeded 300 m. 300 > 250, so every mark counted as outside is further
  away than its own margin of error. No record had to be removed. This is stated
  in the report because it is the first thing a reviewer should test.
- **Mock-location detection is not possible** from a browser application, which
  cannot read Android's mock-location flag. `SUSPECT_MOCK` is a pattern indicator
  only (a position reported as flawless together with coordinates repeated to the
  metre). No mark met that test in this window — which is not the same as none
  having occurred, and the report says so.
- **The helper's walkthrough is abbreviated.** It is the same journey as the
  teacher's; only the shared-telephone picker differs. Reproducing it in full
  added length without adding evidence.
- **Report length is 53 pages against the brief's 25–35 target.** The overshoot is
  the screenshot walkthrough (Section 5), five case studies (9.3) and seven
  annexures, all of which the same brief requires. Cutting further would mean
  dropping required content rather than trimming padding.

## EVIDENCE GAPS

| Gap | Effect |
|---|---|
| No count of beneficiary complaints | §7.1 reports the accountability problem as *reported*, not established. |
| No baseline for manual-register time | §12 claims no time saving, only a measured cost. |
| No pre-deployment attendance measure | First day of operation used as a proxy, labelled as one. |
| Stock entries not attributable to an individual worker on a day | The cross-reference required at §1.3.7 of the brief could not be completed; §9.4 says so. |
| Mark coordinates absent from the published summary | Case studies carry no map image. An admin can export them from the console (Users & Admin → Download case geography), then rebuild. |
| No live credentials | Screens are the real v5.20 application with training data; payloads are those the application constructs, captured client-side. |
| Timings measured on a desktop browser | §12 figures indicate task length, not field performance. |

## Open data-protection item

The published `summary/*.json` files are served from a public address and contain
the Drive identifiers of attendance photographs. An unauthenticated request
returned image data for one such identifier. **Action:** set the photograph folder
to restricted, then remove the identifiers from the published summary. Recorded in
Annexure G rather than omitted.

## Phase 3 self-review

| Check | Result |
|---|---|
| Every number traces to `evidence/` or `analysis/` or `summary/` | Pass — the builder reads only those; nothing is typed in. |
| Zero fabricated or placeholder content | Pass. |
| Screenshots real, current, redacted | Pass — v5.20, redaction runs in the capture script. |
| Figures numbered, captioned, referenced | Pass — 28 figures, 34 tables, auto-numbered. |
| §5 and §9 free of persuasive language | Pass — both open with a statement that they report only. |
| §9 states sample size, exclusions, alternatives | Pass — §9.1, §9.5. |
| No individual named | Pass — worker references only; key held separately. |
| §11 read as a hostile reader | Pass — two concerns conceded outright (punishment, wrong coordinates). |
| Executive summary readable in four minutes | Pass — one page, five findings, one recommendation. |
| Banned words absent | Pass — checked mechanically. |
| Opens in Word | Pass — built and re-saved by Word during PDF export. |
| Length 25–35 pages | **Fail — 53 pages.** See decisions above. |
