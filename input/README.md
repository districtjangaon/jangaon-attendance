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

Before importing, add the two console accounts to `IMPORT_USERS.csv`
(ids from U2001, cadre `OTHER`, role `ADMIN`): the technical admin and the
Collector. Everyone from the register stays a plain field user;
`supervisor_phone` in `IMPORT_SECTORS.csv` stays empty.

When a new register version arrives, drop it in this folder, re-run the
importer, re-paste, and re-run `importFromSheets()` — the import is
idempotent and never touches existing users' PINs or phone bindings.

**This folder's xlsx files are gitignored. Keep them out of email and chat
too — they identify 1,100+ government employees.**
