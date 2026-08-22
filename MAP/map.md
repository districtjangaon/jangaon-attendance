
Fill the four FILL-IN lines first; everything else is stack-agnostic.

- FILL-IN 1 — Stack: <e.g. React + Node/Postgres, Django, PHP/MySQL, Apps Script>
- FILL-IN 2 — Where attendance rows live: <table/collection/sheet + the columns it has today>
- FILL-IN 3 — Area bounding box: <minLat, maxLat, minLng, maxLng>
- FILL-IN 4 — Map centre + zoom when nothing is marked yet: <lat, lng, zoom>

## What to build

A live map on the console showing, for the day being viewed: every officer who
**marked present**, at the place the mark was taken; every officer **on
sanctioned leave**; every officer **not marked**, at their last known place —
labelled as last-known, never as attendance; and optionally the **items filed**,
coloured by grade or status. Above it: filter chips (Everything / Present / Not
trustworthy / No fix / Not marked / Filed), each carrying its own count, and a
"Fit all" button. A popup on every pin.

This is a **record used to act against people**. A pin that overstates what is
known accuses someone of something they did not do. Every rule below is here
because the opposite reached production somewhere.

## 1. Capture — the client side

- `getCurrentPosition` with `{enableHighAccuracy:true, timeout:18000, maximumAge:0}`.
  On failure retry once with `{enableHighAccuracy:false, timeout:15000,
  maximumAge:120000}` — a coarse network fix beats no fix, so long as it is
  labelled coarse.
- **The slow satellite.** A cold GPS needs a minute or two of open sky, longer
  than one attempt can politely wait, so the phone answers with a ±2000 m
  network guess and an honest officer is filed "unverified". While he does the
  rest of the flow (photo, form), keep a `watchPosition` running and **keep only
  the better fix** — a worse reading is never taken. Stop at `acc <= 50 m` or
  after 150 s, and clear the watch when the screen closes.
- File with every mark: `lat`, `lng`, `acc` (metres), the device timestamp, and
  `tz` from `Intl.DateTimeFormat().resolvedOptions().timeZone`.
- `verified = (acc != null && acc <= 250)`. 250 m is the line between a place
  and an area. Store the raw `acc` either way — never discard a coarse fix, just
  refuse to call it verified.
- Geolocation needs **HTTPS**. Over plain HTTP the browser refuses silently —
  say that on screen rather than showing a dead button.
- Refusal is a normal answer, not an error: if permission is denied the mark
  must still file, with `lat/lng` null, and the screen must say plainly that
  this mark will carry no location.
- Show the officer what is being filed — `17.72413, 79.15102 · ±18 m` — before
  he submits. Nobody's location is taken invisibly.

### The seen ping (optional, but it is what makes the map honest)

When someone **opens** the app on a working day and does not mark, send one ping
`{lat, lng, ts, acc}`. At most one row per person per day — update in place,
never append. That gives the console a *fresh today* position for the unmarked
instead of a stale one from last week. It is never presented as attendance; it
only ever says "app opened here at 09:14 today".

## 2. Store — the server side

Add to the attendance record: `lat`, `lng`, `accuracy`, `verified`, `timezone`,
and a server-stamped `receivedAt`. Add a `Seen` table with `date, personId,
name, role, unit, at, lat, lng, accuracy, receivedAt`, unique on (date, personId).

Two rules that cannot be traded away:

- **The device clock is not evidence.** Any time used for judging compliance is
  the *earlier* of the claimed device time and the server's `receivedAt` — a
  mark can never post-date its own arrival. Keep the raw claim and the skew too,
  so the console can say "this phone is 11 minutes fast".
- **The server decides.** Re-check identity and role on every write, and
  recompute `verified` from `acc` server-side. Never trust a client's figure.

## 3. Serve — the payload the map reads

One endpoint, for the chosen date:

```json
{
  "present": [{ "id":"", "name":"", "role":"", "unit":"", "at":"", "lat":0, "lng":0, "acc":0, "verified":true, "tz":"", "marks":1 }],
  "onLeave": [{ "id":"", "name":"", "role":"", "unit":"", "lat":0, "lng":0 }],
  "absent":  [{ "id":"", "name":"", "role":"", "unit":"", "lat":0, "lng":0, "seenAt":"", "lastDate":"" }],
  "filed":   [{ "id":"", "title":"", "unit":"", "lat":0, "lng":0, "score":0, "grade":"", "flag":"", "filedBy":"", "date":"" }]
}
```

For `absent`, resolve the position in this order and label it accordingly:

1. today's **seen ping** → `seenAt` set, `lastDate` = today → *"app opened here at HH:MM today"*;
2. else the person's **last located mark** → `lastDate` = that date → *"last marked here on dd.mm.yyyy"*;
3. else no coordinates → the person does not appear on the map at all.

Never fall back to an office address, a unit centroid, or any invented point.

**Sanctioned leave is not absence.** Someone whose leave was approved rightly
writes no attendance row. Read the leave register before calling anyone
unmarked, or the map paints every sanctioned officer red on a festival day.

## 4. Render — the console side

- **Inline Leaflet (JS and CSS) into the page. No CDN.** The console must open
  on a weak or filtered connection; a blocked CDN is a silent empty box. Use
  `L.circleMarker` only — then there are no marker images to 404 either.
- `L.map(id, {zoomControl:true, attributionControl:true, scrollWheelZoom:false})`.
  **The wheel scrolls the page, it does not zoom the map** — a map that eats the
  scroll traps the reader half way down the console. Enable wheel zoom only
  while Ctrl is held (`wheel` listener, `{passive:false}`).
- Tiles: `https://tile.openstreetmap.org/{z}/{x}/{y}.png`, `maxZoom:18`,
  attribution `© OpenStreetMap`. Bind `tileerror` and drop a small corner note
  **once**: *"The map background is blocked on this network — the pins still
  stand."* The pins draw locally either way.
- All markers in one `L.layerGroup`; on redraw `clearLayers()` and rebuild. Keep
  a `[{point, marker}]` array so a name elsewhere on the console can fly to its
  pin (`setView(...,15)` then `openPopup()`).
- `map.fitBounds(L.latLngBounds(points).pad(0.25))` when there is anything to
  show; otherwise `setView(FILL-IN 4)`.
- `setTimeout(() => map.invalidateSize(), 60)` after every draw. A map built
  inside a hidden or freshly laid-out panel measures itself as zero and renders
  one grey tile in the corner.
- Rebuild if the container changed: `if (map && map._container !== el) map.remove()`.
  Otherwise a tab switch leaves a live map bound to a detached node.

### The CSS bug that cost a fortnight

A global `svg { display:block; width:100% }` in the console stylesheet silently
breaks Leaflet — its overlay pane *is* an SVG, and forcing it to 100% misplaces
every vector pin. After any global SVG rule, add:

```css
.leaflet-container svg { width: auto; }
```

Check the stylesheet for global `svg`, `img` or `canvas` rules **before** blaming
the data. Instrument first — log the point count, log `map.getBounds()` — then
theorise.

### Marker vocabulary — the honesty rules

| State | Mark |
|---|---|
| Present, verified | filled green circle, r 7 (r 9 if marked more than once) |
| Present, coarse fix (`acc > 250`) | filled amber, popup says "no fix" |
| Present, not trustworthy | filled red, popup says which test failed |
| On leave | filled grey, "on sanctioned leave" |
| Not marked, seen today | red ring, **solid**, 10% fill — "app opened here at HH:MM today" |
| Not marked, historic fix | red ring, **dashed** (`dashArray:'4 3'`), 10% fill — "last marked here on dd.mm.yyyy" |
| Item filed | filled by grade or status |

Solid versus dashed is the whole point: fresh evidence and stale evidence must
not look alike at a glance. **A hollow ring is never dressed up as attendance.**

"Not trustworthy" means any one of: the fix falls outside FILL-IN 3's bounding
box; `acc > 250 m`; `tz` is not the expected timezone. Say in the popup which of
the three it was, in plain words.

### Popups

Name in bold, then role · unit, then the time and the state, then `± N m`, then
a `https://maps.google.com/?q=lat,lng` link. Escape every field — names come
from a form. Nothing in a popup may assert more than the record holds.
