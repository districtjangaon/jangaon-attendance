# Tools

| Tool | Purpose |
|---|---|
| `import-awc.py` | Converts the district AWC register xlsx into the five `IMPORT_*` CSVs for `importFromSheets()`, plus `ISSUES.md` (data problems for the department). Output lands in gitignored `master-data/`. Needs `pip install openpyxl`. |
| `load-sim/load_sim.py` | Pre-go-live load test: seeds 400 synthetic users, then fires 400 truly concurrent sync POSTs with client-faithful backoff. Second run proves idempotency (100% DUP). Stdlib only. See docs/TEST-PLAN.md §2. |
