# Input — district master data

The canonical input is the district AWC register xlsx (currently
`AWC DATA-31.07.2026.xlsx`), sheet `Sheet1`, two header rows, columns exactly:

```
Sl.No | Project | Sector | AWC Name | AWT Name | AWT Mobile Number |
AWH NAME | AWH Mobile Number | Latitude | Longitude
```

Convert it with:

```
pip install openpyxl
python tools/import-awc.py
```

Output goes to `master-data/` (gitignored — REAL personal data, never commit
or share): five `IMPORT_*.csv` files to paste into the ATTENDANCE_MASTER
import tabs, plus `ISSUES.md` listing everything the department must fix
(invalid mobiles, out-of-district GPS, duplicate AWC names, vacancies).

Before importing, fill in what the register does not contain:
- `IMPORT_SECTORS.csv` → each sector supervisor's mobile
- `IMPORT_USERS.csv` → one row per supervisor (role `SUPERVISOR`) and CDPO
  (role `CDPO`), ids continuing from U2001

When a new register version arrives, drop it in this folder, re-run the
importer, re-paste, and re-run `importFromSheets()` — the import is
idempotent and never touches existing users' PINs or phone bindings.

**This folder's xlsx files are gitignored. Keep them out of email and chat
too — they identify 1,100+ government employees.**
