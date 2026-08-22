'use strict';
/**
 * map.js — the live district map.
 *
 * This is a record used to act against people. A pin that overstates what is
 * known accuses someone of something they did not do, so the vocabulary below
 * is not decoration:
 *
 *   filled circle  = a mark was taken here today
 *   solid ring     = the app was OPENED here today; this is not attendance
 *   dashed ring    = a fix from an earlier date; this is not today
 *
 * Fresh evidence and stale evidence must not look alike at a glance, and a
 * hollow ring is never dressed up as attendance.
 *
 * Leaflet is vendored under console/vendor — never a CDN. The console has to
 * open on a filtered government network, where a blocked CDN is a silent
 * empty box. circleMarker only, so there are no marker images to 404 either.
 */
const DistrictMap = (() => {
  const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

  let map = null;
  let layer = null;
  let pins = [];          // [{ id, point, marker }] so other tabs can fly to one
  let data = null;        // last mapDay payload
  let filter = 'all';
  let tileWarned = false;

  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const COLOR = {
    ok: '#0f9d58',        // present, verified
    coarse: '#e8a020',    // present, no usable fix
    bad: '#d13438',       // present, not trustworthy
    leave: '#78829e',     // on sanctioned leave
    absent: '#d13438',    // not marked (ring only)
    filed: '#4f5ce5'
  };

  /** dd.mm.yyyy from an ISO date — the form the register uses. */
  function dmy(iso) {
    const s = String(iso || '');
    return s.length >= 10 ? s.slice(8, 10) + '.' + s.slice(5, 7) + '.' + s.slice(0, 4) : s;
  }

  function gmaps(lat, lng) {
    return 'https://maps.google.com/?q=' + lat + ',' + lng;
  }

  /**
   * Popup body. Nothing here may assert more than the record holds: the state
   * line is written from the same field that chose the marker's shape.
   */
  function popupHtml(p, nameOf, unitOf, stateLine, extra) {
    const acc = p.acc == null ? 'no accuracy reported' : '± ' + Math.round(p.acc) + ' m';
    return '<b>' + esc(nameOf(p.id)) + '</b><br>' +
      esc(p.role || '') + (p.unit ? ' · ' + esc(unitOf(p.unit)) : '') + '<br>' +
      stateLine + '<br>' + esc(acc) +
      (extra ? '<br>' + extra : '') +
      '<br><a href="' + esc(gmaps(p.lat, p.lng)) + '" target="_blank" rel="noopener">Open in Google Maps</a>';
  }

  function circle(p, opts) {
    return L.circleMarker([p.lat, p.lng], opts);
  }

  /** Which bucket a present-pin falls in, and why — used for colour and text. */
  function presentGrade(p) {
    if (p.doubts && p.doubts.length) return 'bad';
    if (!p.verified) return 'coarse';
    return 'ok';
  }

  function counts(d) {
    if (!d) return { all: 0, present: 0, doubt: 0, nofix: 0, unmarked: 0, filed: 0 };
    const present = d.present || [];
    return {
      present: present.length,
      doubt: present.filter(p => presentGrade(p) === 'bad').length,
      nofix: present.filter(p => presentGrade(p) === 'coarse').length,
      unmarked: (d.absent || []).length + (d.onLeave || []).length,
      filed: (d.filed || []).length,
      all: present.length + (d.absent || []).length + (d.onLeave || []).length +
        (d.filed || []).length
    };
  }

  function wanted(kind, p) {
    switch (filter) {
      case 'all': return true;
      case 'present': return kind === 'present';
      case 'doubt': return kind === 'present' && presentGrade(p) === 'bad';
      case 'nofix': return kind === 'present' && presentGrade(p) === 'coarse';
      case 'unmarked': return kind === 'absent' || kind === 'leave';
      case 'filed': return kind === 'filed';
      default: return true;
    }
  }

  /**
   * Build (or rebuild) the map inside `el`. Rebuilding matters: a tab switch
   * can leave a live map bound to a detached node, and every draw after that
   * silently goes nowhere.
   */
  function ensureMap(el, centre) {
    if (map && map._container !== el) { map.remove(); map = null; layer = null; }
    if (map) return map;

    map = L.map(el, {
      zoomControl: true,
      attributionControl: true,
      // The wheel scrolls the PAGE. A map that eats the scroll traps the
      // reader half way down the console with no way past it.
      scrollWheelZoom: false
    });
    map.setView([centre.lat, centre.lng], centre.zoom);

    const tiles = L.tileLayer(OSM, { maxZoom: 18, attribution: '© OpenStreetMap' });
    tiles.on('tileerror', () => {
      if (tileWarned) return;
      tileWarned = true;
      const note = document.getElementById('map-tilenote');
      if (note) {
        note.hidden = false;
        note.textContent = 'The map background is blocked on this network — the pins still stand.';
      }
    });
    tiles.addTo(map);

    // Ctrl (or ⌘) + wheel zooms, nothing else does.
    el.addEventListener('wheel', e => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        map.setZoom(map.getZoom() + (e.deltaY < 0 ? 1 : -1));
      }
    }, { passive: false });

    layer = L.layerGroup().addTo(map);
    return map;
  }

  /** Redraw every pin from `data` under the current filter. */
  function draw(nameOf, unitOf) {
    if (!map || !data) return;
    layer.clearLayers();
    pins = [];
    const points = [];

    const add = (p, marker, kind) => {
      marker.addTo(layer);
      pins.push({ id: p.id, kind: kind, point: [p.lat, p.lng], marker: marker });
      points.push([p.lat, p.lng]);
    };

    (data.present || []).forEach(p => {
      if (!wanted('present', p)) return;
      const grade = presentGrade(p);
      const m = circle(p, {
        radius: p.marks > 1 ? 9 : 7, color: COLOR[grade], fillColor: COLOR[grade],
        fillOpacity: 0.9, weight: 1
      });
      const state = grade === 'bad'
        ? '<b>Not trustworthy</b> — ' + esc(p.doubts.join('; '))
        : grade === 'coarse'
          ? '<b>No fix</b> — marked at ' + esc(p.at) + ', position is an area not a place'
          : 'Marked present at ' + esc(p.at);
      m.bindPopup(popupHtml(p, nameOf, unitOf, state,
        p.marks > 1 ? 'IN and OUT both marked' : null));
      add(p, m, 'present');
    });

    (data.onLeave || []).forEach(p => {
      if (!wanted('leave', p)) return;
      const m = circle(p, {
        radius: 7, color: COLOR.leave, fillColor: COLOR.leave, fillOpacity: 0.85, weight: 1
      });
      m.bindPopup(popupHtml(p, nameOf, unitOf,
        'On sanctioned leave (' + esc(p.lv || '') + ')<br>' + whereLine(p)));
      add(p, m, 'leave');
    });

    (data.absent || []).forEach(p => {
      if (!wanted('absent', p)) return;
      // Ring, never filled: this is not an attendance mark and must not read
      // like one. Solid = seen today, dashed = an older fix.
      const fresh = !!p.seenAt;
      const m = circle(p, {
        radius: 8, color: COLOR.absent, fillColor: COLOR.absent, fillOpacity: 0.1,
        weight: 2, dashArray: fresh ? null : '4 3'
      });
      m.bindPopup(popupHtml(p, nameOf, unitOf, '<b>Not marked today</b><br>' + whereLine(p)));
      add(p, m, 'absent');
    });

    (data.filed || []).forEach(p => {
      if (!wanted('filed', p)) return;
      const flagged = p.grade === 'FLAGGED';
      const m = circle(p, {
        radius: 6, color: flagged ? COLOR.coarse : COLOR.filed,
        fillColor: flagged ? COLOR.coarse : COLOR.filed, fillOpacity: 0.85, weight: 1
      });
      m.bindPopup('<b>' + esc(unitOf(p.unit)) + '</b><br>Daily report filed at ' +
        esc(p.at) + '<br>' + p.children + ' children · ' + p.meals + ' meals' +
        (p.flag ? '<br>Flagged: ' + esc(p.flag) : '') +
        '<br><a href="' + esc(gmaps(p.lat, p.lng)) + '" target="_blank" rel="noopener">Open in Google Maps</a>');
      add(p, m, 'filed');
    });

    if (points.length) {
      map.fitBounds(L.latLngBounds(points).pad(0.25));
    } else if (data.centre) {
      map.setView([data.centre.lat, data.centre.lng], data.centre.zoom);
    }
    // A map built inside a panel that was hidden measures itself as zero and
    // renders one grey tile in the corner. Re-measure after the layout lands.
    setTimeout(() => { if (map) map.invalidateSize(); }, 60);
  }

  /** The one line that says how a non-present pin got its position. */
  function whereLine(p) {
    if (p.seenAt) return 'App opened here at ' + esc(p.seenAt) + ' today';
    if (p.lastDate) return 'Last marked here on ' + esc(dmy(p.lastDate));
    return 'Position unknown';
  }

  return {
    /** Draw payload `d` into element `el`. nameOf/unitOf resolve ids to names. */
    render(el, d, nameOf, unitOf) {
      data = d;
      ensureMap(el, (d && d.centre) || { lat: 17.7566, lng: 79.1361, zoom: 10 });
      draw(nameOf, unitOf);
    },
    setFilter(f, nameOf, unitOf) { filter = f; draw(nameOf, unitOf); },
    getFilter() { return filter; },
    counts() { return counts(data); },
    fitAll() {
      if (!map || !pins.length) return;
      map.fitBounds(L.latLngBounds(pins.map(p => p.point)).pad(0.25));
    },
    /** Centre on one person's pin and open it — used from the other tabs. */
    flyTo(id) {
      const hit = pins.find(p => p.id === id);
      if (!hit || !map) return false;
      map.setView(hit.point, 15);
      hit.marker.openPopup();
      return true;
    },
    invalidate() { if (map) setTimeout(() => map.invalidateSize(), 60); }
  };
})();
