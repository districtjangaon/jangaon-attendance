# Field app — installable PWA

English-only UI (per decision 2026-08-02), Government of Telangana theme
(deep green `#006437` + gold `#f4b400`).

## Try it right now (demo mode, no server)

`app/js/config.js` ships with `DEMO: true` — a fully fake backend inside the
app, so the whole flow (login → PIN set → camera → GPS → offline queue → sync
→ history) can be exercised with zero setup.

1. Serve the folder over HTTP (camera + service worker need `localhost` or HTTPS):
   - `npx http-server app -p 8080`  (or VS Code "Live Server", or `python -m http.server`)
2. Open `http://localhost:8080` — best in a mobile viewport (DevTools device mode)
   or on a phone on the same network (camera then needs HTTPS or localhost
   port-forwarding via `chrome://inspect`).
3. Login with **any 10-digit number** → a two-user picker appears (a shared
   centre phone, like ~190 real AWCs): pick Demo Teacher or Demo Helper, set a
   PIN for each. "Switch user" on the home screen swaps between them.
4. Mark IN: two taps — IN → CAPTURE. Toggle DevTools "Offline" to watch the
   offline banner, queue counter and auto-sync on reconnect.

## Going live

In `js/config.js` set `DEMO: false` and paste the deployed Apps Script
`/exec` URL into `ENDPOINT`. Everything else is already wired.

## Design decisions in this code

- **Queue-first**: the mark is written to IndexedDB and confirmed full-screen
  *before* any network attempt. Offline and online are the same code path.
- **Camera-only enforcement** via `getUserMedia` — live frames only, no
  gallery path exists (a `<input type=file capture>` can be bypassed into the
  gallery on many Androids). No camera ⇒ mark still goes through, server
  flags `NO_PHOTO`. GPS timeout ⇒ mark goes through as `UNVERIFIED`.
  **Nothing ever blocks the mark.**
- **Stamp burnt into pixels**: canvas re-encode strips EXIF, so date/time,
  coordinates ±accuracy and user/type are drawn onto the photo itself —
  that's what the auditor sees for the photo's 45-day life.
- **Jitter + backoff**: auto-sync waits a random 0–90 s (server-configurable);
  failures back off 30 s → 30 min with jitter. 500 phones at 9:00 AM never
  stampede the endpoint. Manual "Sync now" skips the jitter.
- **Background Sync** registers `sync-marks`; the service worker pings open
  clients. Closed-app sync is not claimed — records simply wait in IndexedDB
  for the next open (stated honestly, see `sw.js` header).
- Deterministic key `{user}_{yyyymmdd}_{IN|OUT}` means retries and double-taps
  can never duplicate, and the app knows locally whether IN/OUT is done today.
- **Multi-user device**: phone numbers are not unique in the real data — the
  AWT and AWH of a centre usually share its phone. The app therefore keeps a
  map of logged-in accounts (`kv accounts`), the queue key's user-id prefix
  says who owns each record, and sync sends every record under its owner's own
  token. Logout or an expired session for one user never touches the other
  user's queue.
